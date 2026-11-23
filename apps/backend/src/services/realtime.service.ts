import crypto from 'node:crypto';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { PlatformEventType } from '@prisma/client';
import {
  createPubSubPublisherConnection,
  createPubSubSubscriberConnection,
} from '../config/redis.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { TooManyRequestsError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const ORG_CHANNEL_PREFIX = 'pq:org:';
export const ORG_CHANNEL_SUFFIX = ':events';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_RETRY_HINT_MS = 3_000;
export const DEFAULT_MAX_CONNECTIONS_PER_USER = 5;
export const DEFAULT_MAX_CONNECTIONS_PER_ORG = 50;
export const DEFAULT_MAX_TOTAL_CONNECTIONS = 500;
export const DEFAULT_MAX_REPLAY_EVENTS = 200;
export const DEFAULT_MAX_LIVE_BUFFER = 200;
export const DEFAULT_MAX_DELIVERED_IDS = 500;
export const DEFAULT_MAX_BACKPRESSURE_DROPPED = 50;

export interface RealtimePlatformEvent {
  id: string;
  type: PlatformEventType;
  organisationId: string;
  queueId: string | null;
  jobId: string | null;
  workerId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RealtimeBusOptions {
  redisUrl?: string;
  createPublisher?: () => Redis;
  createSubscriber?: () => Redis;
  heartbeatIntervalMs?: number;
  retryHintMs?: number;
  maxConnectionsPerUser?: number;
  maxConnectionsPerOrg?: number;
  maxTotalConnections?: number;
  maxLiveBuffer?: number;
  maxBackpressureDropped?: number;
}

export interface SseClientRegistration {
  id: string;
  organisationId: string;
  userId: string;
  res: Response;
  replaying: boolean;
  pendingLiveBuffer: RealtimePlatformEvent[];
  bufferOverflow: boolean;
  deliveredIds: Set<string>;
  deliveredOrder: string[];
  backpressured: boolean;
  droppedWhileBackpressured: number;
  heartbeatTimer: NodeJS.Timeout | null;
  tokenExpiryTimer: NodeJS.Timeout | null;
  closed: boolean;
  onDrain: () => void;
}

export interface RealtimeBusStats {
  totalConnections: number;
  subscribedOrganisations: number;
  publisherStatus: string;
  subscriberStatus: string;
}

const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'secret',
  'jwt',
  'authorization',
  'payload',
  'rawtoken',
  'apikey',
  'cookie',
  'stack',
  'stacktrace',
]);

export function buildOrgEventChannel(organisationId: string): string {
  return `${ORG_CHANNEL_PREFIX}${organisationId}${ORG_CHANNEL_SUFFIX}`;
}

export function parseOrgIdFromChannel(channel: string): string | null {
  if (!channel.startsWith(ORG_CHANNEL_PREFIX) || !channel.endsWith(ORG_CHANNEL_SUFFIX)) {
    return null;
  }
  const orgId = channel.slice(
    ORG_CHANNEL_PREFIX.length,
    channel.length - ORG_CHANNEL_SUFFIX.length,
  );
  return uuidSchema.safeParse(orgId).success ? orgId : null;
}

export function sanitizeRealtimeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      safe[key] = '[REDACTED]';
    } else if (value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

export function formatSseFrame(params: {
  id?: string;
  event?: string;
  data: unknown;
  retry?: number;
}): string {
  const lines: string[] = [];
  if (params.retry !== undefined) {
    lines.push(`retry: ${params.retry}`);
  }
  if (params.id) {
    lines.push(`id: ${params.id}`);
  }
  if (params.event) {
    lines.push(`event: ${params.event}`);
  }
  const serialized = typeof params.data === 'string' ? params.data : JSON.stringify(params.data);
  for (const dataLine of serialized.split('\n')) {
    lines.push(`data: ${dataLine}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * Multi-instance Redis Pub/Sub event bus and Server-Sent Events (SSE) hub.
 *
 * - Uses dedicated Redis publisher and subscriber connections (isolated from BullMQ).
 * - Maintains ref-counted per-organisation Redis channel subscriptions (`pq:org:<orgId>:events`).
 * - Validates tenant ownership on both publish and receive paths.
 * - Supports gapless, deduplicated replay-to-live handoff, heartbeats, JWT expiry enforcement,
 *   connection limits, socket backpressure handling, and graceful shutdown.
 */
export class RealtimeEventBus {
  private readonly createPublisherFn: () => Redis;
  private readonly createSubscriberFn: () => Redis;
  private readonly heartbeatIntervalMs: number;
  private readonly retryHintMs: number;
  private readonly maxConnectionsPerUser: number;
  private readonly maxConnectionsPerOrg: number;
  private readonly maxTotalConnections: number;
  private readonly maxLiveBuffer: number;
  private readonly maxBackpressureDropped: number;

  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private subscriberHadDisconnect = false;
  private isClosing = false;

  private readonly orgClients = new Map<string, Set<SseClientRegistration>>();
  private readonly userClients = new Map<string, Set<SseClientRegistration>>();
  private readonly allClients = new Map<string, SseClientRegistration>();

  constructor(options: RealtimeBusOptions = {}) {
    this.createPublisherFn =
      options.createPublisher ?? (() => createPubSubPublisherConnection(options.redisUrl));
    this.createSubscriberFn =
      options.createSubscriber ?? (() => createPubSubSubscriberConnection(options.redisUrl));
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.retryHintMs = options.retryHintMs ?? DEFAULT_RETRY_HINT_MS;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;
    this.maxConnectionsPerOrg = options.maxConnectionsPerOrg ?? DEFAULT_MAX_CONNECTIONS_PER_ORG;
    this.maxTotalConnections = options.maxTotalConnections ?? DEFAULT_MAX_TOTAL_CONNECTIONS;
    this.maxLiveBuffer = options.maxLiveBuffer ?? DEFAULT_MAX_LIVE_BUFFER;
    this.maxBackpressureDropped =
      options.maxBackpressureDropped ?? DEFAULT_MAX_BACKPRESSURE_DROPPED;
  }

  getStats(): RealtimeBusStats {
    return {
      totalConnections: this.allClients.size,
      subscribedOrganisations: this.orgClients.size,
      publisherStatus: this.publisher?.status ?? 'idle',
      subscriberStatus: this.subscriber?.status ?? 'idle',
    };
  }

  getHeartbeatIntervalMs(): number {
    return this.heartbeatIntervalMs;
  }

  getRetryHintMs(): number {
    return this.retryHintMs;
  }

  private getOrCreatePublisher(): Redis {
    if (!this.publisher || this.publisher.status === 'end') {
      this.publisher = this.createPublisherFn();
      this.publisher.on('error', (err) => {
        logger.warn('Redis Pub/Sub publisher error', { error: err.message });
      });
    }
    return this.publisher;
  }

  private getOrCreateSubscriber(): Redis {
    if (!this.subscriber || this.subscriber.status === 'end') {
      const sub = this.createSubscriberFn();
      this.subscriber = sub;

      sub.on('error', (err) => {
        logger.warn('Redis Pub/Sub subscriber error', { error: err.message });
      });

      sub.on('close', () => {
        if (!this.isClosing) {
          this.subscriberHadDisconnect = true;
          logger.warn('Redis Pub/Sub subscriber disconnected; awaiting automatic reconnect');
        }
      });

      sub.on('ready', () => {
        if (this.subscriberHadDisconnect && !this.isClosing) {
          this.subscriberHadDisconnect = false;
          logger.info(
            'Redis Pub/Sub subscriber reconnected; notifying active SSE clients to resync',
          );
          // Notify all active clients that a Redis gap may have occurred
          for (const client of this.allClients.values()) {
            this.sendControlEvent(client, 'resync', {
              reason: 'redis_reconnected',
              timestamp: new Date().toISOString(),
            });
          }
        }
      });

      sub.on('message', (channel: string, rawMessage: string) => {
        this.handleRedisMessage(channel, rawMessage);
      });
    }
    return this.subscriber;
  }

  private async ensureConnected(client: Redis, timeoutMs: number = 2000): Promise<boolean> {
    if ((client.status as string) === 'ready') {
      return true;
    }
    try {
      if (client.status === 'wait') {
        await Promise.race([
          client.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Redis Pub/Sub connect timeout')), timeoutMs),
          ),
        ]);
      }
      if ((client.status as string) === 'ready') {
        return true;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Redis Pub/Sub ready timeout'));
        }, timeoutMs);
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          clearTimeout(timer);
          client.off('ready', onReady);
          client.off('error', onError);
        };
        client.once('ready', onReady);
        client.once('error', onError);
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Publishes an organisation-scoped event to Redis Pub/Sub.
   * Best-effort: never throws so durable PostgreSQL event persistence is never impacted.
   */
  async publish(event: RealtimePlatformEvent): Promise<boolean> {
    if (this.isClosing) return false;

    if (!uuidSchema.safeParse(event.organisationId).success) {
      logger.warn('Refused to publish realtime event without valid organisationId', {
        eventId: event.id,
        type: event.type,
      });
      return false;
    }

    const envelope: RealtimePlatformEvent = {
      id: event.id,
      type: event.type,
      organisationId: event.organisationId,
      queueId: event.queueId ?? null,
      jobId: event.jobId ?? null,
      workerId: event.workerId ?? null,
      message: event.message.slice(0, 500),
      metadata: sanitizeRealtimeMetadata(event.metadata),
      createdAt: event.createdAt,
    };

    try {
      const pub = this.getOrCreatePublisher();
      const ready = await this.ensureConnected(pub, 1500);
      if (!ready) {
        return false;
      }
      const channel = buildOrgEventChannel(envelope.organisationId);
      await pub.publish(channel, JSON.stringify(envelope));
      return true;
    } catch (err) {
      logger.warn('Failed to publish platform event to Redis Pub/Sub (DB record preserved)', {
        eventId: envelope.id,
        organisationId: envelope.organisationId,
        type: envelope.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private handleRedisMessage(channel: string, rawMessage: string): void {
    const channelOrgId = parseOrgIdFromChannel(channel);
    if (!channelOrgId) {
      return;
    }

    let parsed: RealtimePlatformEvent;
    try {
      parsed = JSON.parse(rawMessage) as RealtimePlatformEvent;
    } catch {
      logger.warn('Ignoring malformed JSON on Redis Pub/Sub channel', { channel });
      return;
    }

    // Strict defense-in-depth tenant ownership validation
    if (!parsed || typeof parsed.id !== 'string' || parsed.organisationId !== channelOrgId) {
      logger.warn('Blocked cross-tenant or invalid event payload on Redis Pub/Sub channel', {
        channel,
        channelOrgId,
        payloadOrgId: parsed?.organisationId ?? null,
      });
      return;
    }

    const clients = this.orgClients.get(channelOrgId);
    if (!clients || clients.size === 0) {
      return;
    }

    for (const client of clients) {
      if (client.closed || client.organisationId !== channelOrgId) {
        continue;
      }

      if (client.replaying) {
        if (client.pendingLiveBuffer.length < this.maxLiveBuffer) {
          client.pendingLiveBuffer.push(parsed);
        } else {
          client.bufferOverflow = true;
        }
      } else {
        this.deliverEvent(client, parsed);
      }
    }
  }

  /**
   * Enforces per-user, per-organisation, and global connection limits before opening a stream.
   */
  assertConnectionLimits(organisationId: string, userId: string): void {
    if (this.allClients.size >= this.maxTotalConnections) {
      throw new TooManyRequestsError('Server SSE connection capacity reached');
    }
    const orgSet = this.orgClients.get(organisationId);
    if (orgSet && orgSet.size >= this.maxConnectionsPerOrg) {
      throw new TooManyRequestsError(
        `Organisation SSE connection limit reached (${this.maxConnectionsPerOrg})`,
      );
    }
    const userSet = this.userClients.get(userId);
    if (userSet && userSet.size >= this.maxConnectionsPerUser) {
      throw new TooManyRequestsError(
        `User SSE connection limit reached (${this.maxConnectionsPerUser})`,
      );
    }
  }

  /**
   * Registers an SSE client in `replaying = true` mode and ensures the organisation's
   * Redis Pub/Sub channel is subscribed BEFORE replay starts (guaranteeing zero gaps).
   */
  async registerClient(params: {
    organisationId: string;
    userId: string;
    res: Response;
    tokenExp?: number;
  }): Promise<SseClientRegistration> {
    this.assertConnectionLimits(params.organisationId, params.userId);

    const clientId = crypto.randomUUID();
    const client: SseClientRegistration = {
      id: clientId,
      organisationId: params.organisationId,
      userId: params.userId,
      res: params.res,
      replaying: true,
      pendingLiveBuffer: [],
      bufferOverflow: false,
      deliveredIds: new Set<string>(),
      deliveredOrder: [],
      backpressured: false,
      droppedWhileBackpressured: 0,
      heartbeatTimer: null,
      tokenExpiryTimer: null,
      closed: false,
      onDrain: () => {
        if (client.closed) return;
        const dropped = client.droppedWhileBackpressured;
        client.backpressured = false;
        client.droppedWhileBackpressured = 0;
        if (dropped > 0) {
          this.sendControlEvent(client, 'resync', {
            reason: 'backpressure_dropped',
            droppedCount: dropped,
            timestamp: new Date().toISOString(),
          });
        }
      },
    };

    params.res.on('drain', client.onDrain);

    this.allClients.set(clientId, client);

    let orgSet = this.orgClients.get(params.organisationId);
    const isFirstForOrg = !orgSet || orgSet.size === 0;
    if (!orgSet) {
      orgSet = new Set();
      this.orgClients.set(params.organisationId, orgSet);
    }
    orgSet.add(client);

    let userSet = this.userClients.get(params.userId);
    if (!userSet) {
      userSet = new Set();
      this.userClients.set(params.userId, userSet);
    }
    userSet.add(client);

    // Subscribe to Redis channel BEFORE replay query so live events are buffered with zero gap
    if (isFirstForOrg) {
      try {
        const sub = this.getOrCreateSubscriber();
        const ready = await this.ensureConnected(sub, 2000);
        if (ready) {
          await sub.subscribe(buildOrgEventChannel(params.organisationId));
        }
      } catch (err) {
        logger.warn('Failed to subscribe Redis channel for SSE client; stream remains open', {
          organisationId: params.organisationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Start periodic heartbeat comments
    client.heartbeatTimer = setInterval(() => {
      if (client.closed) return;
      this.writeRaw(client, `: heartbeat ${new Date().toISOString()}\n\n`);
    }, this.heartbeatIntervalMs);
    client.heartbeatTimer.unref();

    // Enforce JWT access token expiry on long-lived streams
    if (typeof params.tokenExp === 'number') {
      const remainingMs = Math.max(1000, params.tokenExp * 1000 - Date.now());
      client.tokenExpiryTimer = setTimeout(() => {
        if (client.closed) return;
        this.sendControlEvent(client, 'token_expired', {
          reason: 'access_token_expired',
          timestamp: new Date().toISOString(),
        });
        this.unregisterClient(client.id, true);
      }, remainingMs);
      client.tokenExpiryTimer.unref();
    }

    return client;
  }

  /**
   * Transitions a client from replay mode to live mode: drains any live events buffered
   * during PostgreSQL replay while deduplicating against already-delivered event IDs.
   */
  finishReplayAndGoLive(client: SseClientRegistration): void {
    if (client.closed) return;

    const buffered = client.pendingLiveBuffer.splice(0, client.pendingLiveBuffer.length);
    for (const evt of buffered) {
      this.deliverEvent(client, evt);
    }

    if (client.bufferOverflow) {
      client.bufferOverflow = false;
      this.sendControlEvent(client, 'resync', {
        reason: 'live_buffer_overflow',
        timestamp: new Date().toISOString(),
      });
    }

    client.replaying = false;
  }

  /**
   * Delivers a platform event to a single SSE client with deduplication and tenant check.
   */
  deliverEvent(client: SseClientRegistration, event: RealtimePlatformEvent): boolean {
    if (client.closed) return false;
    if (event.organisationId !== client.organisationId) {
      return false;
    }

    // Deduplicate against recently delivered IDs (prevents replay/live overlap duplicates)
    if (client.deliveredIds.has(event.id)) {
      return false;
    }

    const frame = formatSseFrame({
      id: event.id,
      event: event.type,
      data: event,
    });

    const written = this.writeRaw(client, frame);
    if (written) {
      client.deliveredIds.add(event.id);
      client.deliveredOrder.push(event.id);
      if (client.deliveredOrder.length > DEFAULT_MAX_DELIVERED_IDS) {
        const oldest = client.deliveredOrder.shift();
        if (oldest) client.deliveredIds.delete(oldest);
      }
    }
    return written;
  }

  sendControlEvent(client: SseClientRegistration, event: string, data: unknown): boolean {
    if (client.closed) return false;
    const frame = formatSseFrame({
      event,
      data,
      retry: event === 'connected' ? this.retryHintMs : undefined,
    });
    return this.writeRaw(client, frame);
  }

  private writeRaw(client: SseClientRegistration, chunk: string): boolean {
    if (client.closed || client.res.writableEnded || client.res.destroyed) {
      this.unregisterClient(client.id, false);
      return false;
    }

    if (client.backpressured) {
      client.droppedWhileBackpressured += 1;
      if (client.droppedWhileBackpressured >= this.maxBackpressureDropped) {
        logger.warn('Closing slow SSE client due to sustained backpressure', {
          clientId: client.id,
          organisationId: client.organisationId,
          dropped: client.droppedWhileBackpressured,
        });
        this.unregisterClient(client.id, true);
      }
      return false;
    }

    try {
      const ok = client.res.write(chunk);
      if (!ok) {
        client.backpressured = true;
      }
      return true;
    } catch {
      this.unregisterClient(client.id, false);
      return false;
    }
  }

  unregisterClient(clientId: string, endResponse: boolean = false): void {
    const client = this.allClients.get(clientId);
    if (!client) return;

    client.closed = true;
    this.allClients.delete(clientId);

    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }
    if (client.tokenExpiryTimer) {
      clearTimeout(client.tokenExpiryTimer);
      client.tokenExpiryTimer = null;
    }
    client.res.off('drain', client.onDrain);

    const orgSet = this.orgClients.get(client.organisationId);
    if (orgSet) {
      orgSet.delete(client);
      if (orgSet.size === 0) {
        this.orgClients.delete(client.organisationId);
        // Unsubscribe Redis channel when last local client for this organisation disconnects
        if (this.subscriber && (this.subscriber.status as string) === 'ready') {
          void this.subscriber
            .unsubscribe(buildOrgEventChannel(client.organisationId))
            .catch(() => {
              // ignore unsubscribe errors during disconnect
            });
        }
      }
    }

    const userSet = this.userClients.get(client.userId);
    if (userSet) {
      userSet.delete(client);
      if (userSet.size === 0) {
        this.userClients.delete(client.userId);
      }
    }

    if (endResponse && !client.res.writableEnded && !client.res.destroyed) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Gracefully notifies and closes all SSE streams and disconnects Pub/Sub Redis connections.
   */
  async closeAll(): Promise<void> {
    this.isClosing = true;

    for (const client of Array.from(this.allClients.values())) {
      try {
        this.sendControlEvent(client, 'shutdown', {
          reason: 'server_shutdown',
          timestamp: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
      this.unregisterClient(client.id, true);
    }

    const closeConn = async (conn: Redis | null) => {
      if (!conn) return;
      try {
        if (conn.status !== 'end' && conn.status !== 'wait') {
          await conn.quit();
        } else {
          conn.disconnect();
        }
      } catch {
        conn.disconnect();
      }
    };

    const pub = this.publisher;
    const sub = this.subscriber;
    this.publisher = null;
    this.subscriber = null;

    await Promise.allSettled([closeConn(pub), closeConn(sub)]);
    this.isClosing = false;
  }
}

export const realtimeEventBus = new RealtimeEventBus();
