import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MonitoringStreamClient,
  SseLineParser,
  computeReconnectDelayMs,
  type MonitoringStreamState,
  type ParsedSseFrame,
} from '../api/monitoringStream';
import type { PlatformEventView } from '../types/api';

function createReadableStreamFromChunks(
  chunks: string[],
  keepOpen = false,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else if (!keepOpen) {
        controller.close();
      }
    },
  });
}

describe('Step 7.3 — Frontend Monitoring SSE Client (monitoringStream)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('parses chunked SSE frames, multi-line data, retry hints, and heartbeat comments', () => {
    const parser = new SseLineParser();
    const frames: ParsedSseFrame[] = [];
    const comments: string[] = [];

    parser.feed('retry: 2500\nid: evt-1\nevent: JOB_COMPLETED\ndata: {"a":1}\n', {
      onFrame: (f) => frames.push(f),
      onComment: (c) => comments.push(c),
    });
    expect(frames).toHaveLength(0);

    // Split frame completion + heartbeat comment + multi-line data across chunks
    parser.feed(
      '\n: heartbeat 2026-11-23T00:00:00Z\r\n\r\nevent: resync\r\ndata: line1\r\ndata: line2\r\n\r\n',
      {
        onFrame: (f) => frames.push(f),
        onComment: (c) => comments.push(c),
      },
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      id: 'evt-1',
      event: 'JOB_COMPLETED',
      data: '{"a":1}',
      retry: 2500,
    });
    expect(frames[1]).toEqual({
      id: undefined,
      event: 'resync',
      data: 'line1\nline2',
    });
    expect(comments).toEqual(['heartbeat 2026-11-23T00:00:00Z']);
  });

  it('computes bounded exponential backoff with jitter', () => {
    // randomFn = 0 -> half of exp; randomFn = 1 -> full exp
    expect(computeReconnectDelayMs(0, 1000, 30_000, () => 0)).toBe(500);
    expect(computeReconnectDelayMs(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(computeReconnectDelayMs(2, 1000, 30_000, () => 0.5)).toBe(3000);
    expect(computeReconnectDelayMs(10, 1000, 30_000, () => 1)).toBe(30_000);
  });

  it('authenticates with Bearer token, parses events, tracks Last-Event-ID, and reconnects with cursor', async () => {
    vi.useFakeTimers();

    const evt1: PlatformEventView = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'JOB_COMPLETED',
      organisationId: 'org-a',
      queueId: 'q-1',
      jobId: 'job-1',
      workerId: 'w-1',
      message: 'Job completed',
      metadata: {},
      createdAt: '2026-11-23T10:00:00.000Z',
    };

    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let callCount = 0;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });

      if (callCount === 1) {
        return new Response(
          createReadableStreamFromChunks([
            `event: connected\ndata: {"organisationId":"org-a","connectedAt":"2026-11-23T10:00:00.000Z","heartbeatIntervalMs":20000}\n\n`,
            `id: ${evt1.id}\nevent: JOB_COMPLETED\ndata: ${JSON.stringify(evt1)}\n\n`,
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }

      // Second connection stays open until closed
      return new Response(createReadableStreamFromChunks([], true), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const receivedEvents: PlatformEventView[] = [];
    const states: MonitoringStreamState[] = [];
    const onConnected = vi.fn();

    const client = new MonitoringStreamClient({
      organisationId: 'org-a',
      baseUrl: 'http://localhost:3000',
      getToken: () => 'access-token-1',
      refreshToken: async () => 'access-token-2',
      fetchImpl: mockFetch as unknown as typeof fetch,
      baseReconnectDelayMs: 500,
      randomFn: () => 1,
      onEvent: (e) => receivedEvents.push(e),
      onConnected,
      onStateChange: (s) => states.push(s),
    });

    client.connect();

    // Flush microtasks for stream 1 to complete
    await vi.advanceTimersByTimeAsync(10);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(receivedEvents).toEqual([evt1]);
    expect(client.getLastEventId()).toBe(evt1.id);
    expect(requests[0].headers.Authorization).toBe('Bearer access-token-1');
    expect(requests[0].headers['Last-Event-ID']).toBeUndefined();

    // Advance past reconnect timer (500ms) -> 2nd request sends Last-Event-ID!
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toHaveLength(2);
    expect(requests[1].headers['Last-Event-ID']).toBe(evt1.id);

    client.close();
    expect(client.getState()).toBe('closed');
  });

  it('refreshes expired token on 401 and aborts old connection cleanly on switchOrganisation', async () => {
    let token = 'expired-token';
    const refreshToken = vi.fn(async () => {
      token = 'fresh-token';
      return token;
    });

    const abortedSignals: boolean[] = [];
    const urls: string[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization === 'Bearer expired-token') {
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }

      init?.signal?.addEventListener('abort', () => {
        abortedSignals.push(true);
      });

      return new Response(createReadableStreamFromChunks([], true), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const client = new MonitoringStreamClient({
      organisationId: 'org-1',
      baseUrl: 'http://localhost:3000',
      getToken: () => token,
      refreshToken,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(urls.filter((u) => u.includes('/organisations/org-1/'))).toHaveLength(2);

    // Switch organisation -> aborts org-1 stream, resets cursor, opens org-2 stream
    client.switchOrganisation('org-2');
    await new Promise((r) => setTimeout(r, 20));
    expect(abortedSignals.length).toBeGreaterThanOrEqual(1);
    expect(client.getOrganisationId()).toBe('org-2');
    expect(client.getLastEventId()).toBeNull();
    expect(urls.some((u) => u.includes('/organisations/org-2/monitoring/stream'))).toBe(true);

    client.close();
  });
});
