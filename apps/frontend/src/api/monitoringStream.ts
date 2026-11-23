import { frontendEnv } from '../config/env';
import type { PlatformEventView } from '../types/api';
import { performSilentRefresh } from './apiClient';
import { getAccessToken } from './tokenStore';

export type MonitoringStreamState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface SseConnectedPayload {
  organisationId: string;
  connectedAt: string;
  heartbeatIntervalMs: number;
}

export interface SseResyncPayload {
  reason: string;
  replayedCount?: number;
  maxReplayEvents?: number;
  droppedCount?: number;
  timestamp?: string;
}

export interface ParsedSseFrame {
  id?: string;
  event: string;
  data: string;
  retry?: number;
}

export interface MonitoringStreamOptions {
  organisationId: string;
  baseUrl?: string;
  getToken?: () => string | null;
  refreshToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  randomFn?: () => number;
  onEvent?: (event: PlatformEventView) => void;
  onConnected?: (payload: SseConnectedPayload) => void;
  onResync?: (payload: SseResyncPayload) => void;
  onHeartbeat?: (comment: string) => void;
  onStateChange?: (state: MonitoringStreamState) => void;
  onError?: (error: Error) => void;
}

/**
 * Incremental W3C Server-Sent Events parser.
 * Handles chunk boundaries, CRLF/LF line endings, multi-line `data:`, `id:`, `event:`, `retry:`, and `: comments`.
 */
export class SseLineParser {
  private buffer = '';
  private eventName = 'message';
  private eventId: string | undefined = undefined;
  private dataLines: string[] = [];
  private retryMs: number | undefined = undefined;

  feed(
    chunk: string,
    handlers: {
      onFrame: (frame: ParsedSseFrame) => void;
      onComment?: (comment: string) => void;
    },
  ): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      if (line === '') {
        this.dispatch(handlers.onFrame);
        continue;
      }

      if (line.startsWith(':')) {
        handlers.onComment?.(line.slice(1).trim());
        continue;
      }

      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }

      if (field === 'event') {
        this.eventName = value || 'message';
      } else if (field === 'id') {
        if (!value.includes('\0')) {
          this.eventId = value;
        }
      } else if (field === 'data') {
        this.dataLines.push(value);
      } else if (field === 'retry') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          this.retryMs = parsed;
        }
      }
    }
  }

  private dispatch(onFrame: (frame: ParsedSseFrame) => void): void {
    if (this.dataLines.length === 0 && this.retryMs === undefined) {
      this.resetEventFields();
      return;
    }

    const frame: ParsedSseFrame = {
      id: this.eventId,
      event: this.eventName,
      data: this.dataLines.join('\n'),
      ...(this.retryMs !== undefined ? { retry: this.retryMs } : {}),
    };

    this.resetEventFields();
    onFrame(frame);
  }

  private resetEventFields(): void {
    this.eventName = 'message';
    this.eventId = undefined;
    this.dataLines = [];
    this.retryMs = undefined;
  }
}

/**
 * Computes exponential backoff with full/equal jitter for SSE reconnection.
 */
export function computeReconnectDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  randomFn: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt)));
  const half = exp / 2;
  return Math.round(half + randomFn() * half);
}

/**
 * Reusable fetch-based SSE client for PulseQueue organisation monitoring streams.
 *
 * - Authenticates with `Authorization: Bearer <accessToken>`.
 * - Sends `Last-Event-ID` on reconnect to replay missed organisation events.
 * - Handles token refresh on HTTP 401 and server `token_expired` events.
 * - Uses exponential backoff with jitter and cleanly aborts on `close()` or `switchOrganisation()`.
 */
export class MonitoringStreamClient {
  private organisationId: string;
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly refreshToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly randomFn: () => number;

  private readonly onEvent?: (event: PlatformEventView) => void;
  private readonly onConnected?: (payload: SseConnectedPayload) => void;
  private readonly onResync?: (payload: SseResyncPayload) => void;
  private readonly onHeartbeat?: (comment: string) => void;
  private readonly onStateChange?: (state: MonitoringStreamState) => void;
  private readonly onError?: (error: Error) => void;

  private state: MonitoringStreamState = 'idle';
  private lastEventId: string | null = null;
  private reconnectAttempt = 0;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private generation = 0;

  constructor(options: MonitoringStreamOptions) {
    this.organisationId = options.organisationId;
    this.baseUrl = (options.baseUrl ?? frontendEnv.apiBaseUrl).replace(/\/$/, '');
    this.getToken = options.getToken ?? getAccessToken;
    this.refreshToken = options.refreshToken ?? performSilentRefresh;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.randomFn = options.randomFn ?? Math.random;

    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onResync = options.onResync;
    this.onHeartbeat = options.onHeartbeat;
    this.onStateChange = options.onStateChange;
    this.onError = options.onError;
  }

  getState(): MonitoringStreamState {
    return this.state;
  }

  getOrganisationId(): string {
    return this.organisationId;
  }

  getLastEventId(): string | null {
    return this.lastEventId;
  }

  private setState(next: MonitoringStreamState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  connect(): void {
    this.disposed = false;
    this.cancelTimersAndAbort();
    this.generation += 1;
    const gen = this.generation;
    void this.openStream(gen, false);
  }

  /**
   * Immediately aborts the previous organisation's connection, resets the event cursor,
   * and opens a fresh stream for the new organisation.
   */
  switchOrganisation(newOrganisationId: string): void {
    if (newOrganisationId === this.organisationId && !this.disposed && this.state !== 'idle') {
      return;
    }
    this.cancelTimersAndAbort();
    this.organisationId = newOrganisationId;
    this.lastEventId = null;
    this.reconnectAttempt = 0;
    this.disposed = false;
    this.generation += 1;
    const gen = this.generation;
    void this.openStream(gen, false);
  }

  close(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancelTimersAndAbort();
    this.setState('closed');
  }

  private cancelTimersAndAbort(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async openStream(gen: number, forceRefresh: boolean): Promise<void> {
    if (this.disposed || gen !== this.generation) return;

    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    let token = forceRefresh ? await this.refreshToken() : this.getToken();
    if (!token && !forceRefresh) {
      token = await this.refreshToken();
    }

    if (this.disposed || gen !== this.generation) return;

    if (!token) {
      const err = new Error('Missing access token for monitoring event stream');
      this.onError?.(err);
      this.setState('error');
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    const url = `${this.baseUrl}/api/v1/organisations/${this.organisationId}/monitoring/stream`;

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        credentials: 'include',
        signal: controller.signal,
      });

      if (this.disposed || gen !== this.generation) return;

      if (response.status === 401) {
        if (!forceRefresh) {
          const refreshed = await this.refreshToken();
          if (refreshed && !this.disposed && gen === this.generation) {
            void this.openStream(gen, false);
            return;
          }
        }
        const err = new Error('Monitoring stream authentication expired (401)');
        this.onError?.(err);
        this.setState('error');
        return;
      }

      // Non-retryable authorization/not-found errors
      if (response.status === 403 || response.status === 404) {
        const err = new Error(`Monitoring stream access denied (${response.status})`);
        this.onError?.(err);
        this.setState('error');
        return;
      }

      if (!response.ok || !response.body) {
        throw new Error(`Monitoring stream failed with HTTP ${response.status}`);
      }

      this.reconnectAttempt = 0;
      this.setState('connected');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseLineParser();
      let shouldRefreshOnReconnect = false;

      while (!this.disposed && gen === this.generation) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        parser.feed(text, {
          onComment: (comment) => {
            this.onHeartbeat?.(comment);
          },
          onFrame: (frame) => {
            if (frame.retry !== undefined && frame.retry >= 500) {
              this.baseReconnectDelayMs = frame.retry;
            }
            if (frame.id) {
              this.lastEventId = frame.id;
            }
            const refreshRequested = this.handleFrame(frame);
            if (refreshRequested) {
              shouldRefreshOnReconnect = true;
            }
          },
        });
      }

      if (this.disposed || gen !== this.generation) return;

      // Stream ended cleanly (e.g. token_expired or server shutdown) -> reconnect
      this.scheduleReconnect(gen, shouldRefreshOnReconnect);
    } catch (err) {
      if (this.disposed || gen !== this.generation) return;
      if (err instanceof Error && err.name === 'AbortError') return;

      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect(gen, false);
    }
  }

  private handleFrame(frame: ParsedSseFrame): boolean {
    if (!frame.data) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return false;
    }

    if (frame.event === 'connected') {
      this.onConnected?.(parsed as SseConnectedPayload);
      return false;
    }

    if (frame.event === 'resync') {
      this.onResync?.(parsed as SseResyncPayload);
      return false;
    }

    if (frame.event === 'token_expired') {
      return true;
    }

    if (frame.event === 'shutdown') {
      return false;
    }

    // Platform event: verify organisationId matches current subscription
    const evt = parsed as PlatformEventView;
    if (evt && evt.organisationId === this.organisationId) {
      this.onEvent?.(evt);
    }
    return false;
  }

  private scheduleReconnect(gen: number, forceRefresh: boolean): void {
    if (this.disposed || gen !== this.generation) return;

    this.setState('reconnecting');
    const delayMs = computeReconnectDelayMs(
      this.reconnectAttempt,
      this.baseReconnectDelayMs,
      this.maxReconnectDelayMs,
      this.randomFn,
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openStream(gen, forceRefresh);
    }, delayMs);
  }
}

export function createMonitoringStreamClient(
  options: MonitoringStreamOptions,
): MonitoringStreamClient {
  return new MonitoringStreamClient(options);
}
