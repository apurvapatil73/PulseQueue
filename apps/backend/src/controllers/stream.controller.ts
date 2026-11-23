import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { eventService, toRealtimePlatformEvent } from '../services/event.service.js';
import {
  DEFAULT_MAX_REPLAY_EVENTS,
  realtimeEventBus,
  type RealtimeEventBus,
} from '../services/realtime.service.js';

/**
 * Factory for the authenticated organisation-scoped Server-Sent Events (SSE) handler.
 * Accepts an injectable `RealtimeEventBus` to support multi-instance and limit testing.
 */
export function createMonitoringStreamHandler(
  bus: RealtimeEventBus = realtimeEventBus,
  options?: { maxReplayEvents?: number },
) {
  const maxReplayEvents = options?.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;

  return async function streamOrganisationEvents(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let registeredClientId: string | null = null;

    try {
      if (!req.user || !req.membership) {
        throw new UnauthorizedError('Authentication required');
      }

      const organisationId = req.membership.organisationId;
      const userId = req.user.id;

      // Enforce per-user, per-organisation, and global limits BEFORE flushing SSE headers
      // so over-limit requests receive a standard JSON 429 Too Many Requests response.
      bus.assertConnectionLimits(organisationId, userId);

      const rawLastEventId = req.header('last-event-id');
      const lastEventId = rawLastEventId ? rawLastEventId.trim() : undefined;

      // Set standard SSE headers compatible with fetch() streaming and reverse proxies
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Register client & subscribe to Redis BEFORE replaying from PostgreSQL (zero-gap handoff)
      const client = await bus.registerClient({
        organisationId,
        userId,
        res,
        tokenExp: req.user.tokenExp,
      });
      registeredClientId = client.id;

      const cleanup = () => {
        bus.unregisterClient(client.id, false);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);

      // Send initial connection confirmation
      bus.sendControlEvent(client, 'connected', {
        organisationId,
        connectedAt: new Date().toISOString(),
        heartbeatIntervalMs: bus.getHeartbeatIntervalMs(),
      });

      // Replay missed events if Last-Event-ID cursor was supplied
      if (lastEventId && !client.closed) {
        const replay = await eventService.replayAfterCursor(organisationId, lastEventId, {
          limit: maxReplayEvents,
        });

        if (client.closed) {
          return;
        }

        if (
          replay.status === 'invalid_cursor' ||
          replay.status === 'cursor_not_found' ||
          replay.status === 'cursor_expired'
        ) {
          bus.sendControlEvent(client, 'resync', {
            reason: replay.status,
            timestamp: new Date().toISOString(),
          });
        } else {
          for (const evt of replay.events) {
            if (client.closed) return;
            const realtimeEvt = toRealtimePlatformEvent(evt);
            if (realtimeEvt) {
              bus.deliverEvent(client, realtimeEvt);
            }
          }

          if (replay.status === 'truncated') {
            bus.sendControlEvent(client, 'resync', {
              reason: 'replay_limit_exceeded',
              replayedCount: replay.events.length,
              maxReplayEvents,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // Drain buffered live Redis events (deduplicated) and enter direct live delivery mode
      bus.finishReplayAndGoLive(client);
    } catch (err) {
      if (registeredClientId) {
        bus.unregisterClient(registeredClientId, true);
      }
      if (res.headersSent) {
        logger.warn('SSE stream terminated due to server error after headers were sent', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      next(err);
    }
  };
}

export const streamOrganisationEvents = createMonitoringStreamHandler(realtimeEventBus);
