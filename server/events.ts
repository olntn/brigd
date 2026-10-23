import type { ChangeEvent, ChangeScope, ReadyEvent } from '../src/lib/change-scopes';
import { AppError } from './errors';
import type { Store } from './store';

export interface EventStreamOptions {
  /** Open streams across all handlers of the service. */
  limit?: number;
  /** Changes within this window go out as one event. */
  batchMs?: number;
  /** Comment lines keep proxies and the browser from closing an idle stream. */
  heartbeatMs?: number;
}
export const EVENT_STREAM_LIMIT = 32;
export const EVENT_BATCH_MS = 100;
export const EVENT_HEARTBEAT_MS = 15_000;

/** Server-sent change notifications for the interface. One instance lives as long as the service process,
 * so the connection limit and `closeAll()` cover streams opened through any handler. */
export class EventStreams {
  private readonly streams = new Set<() => void>();
  private readonly limit: number;
  private readonly batchMs: number;
  private readonly heartbeatMs: number;
  constructor(options: EventStreamOptions = {}) {
    this.limit = options.limit ?? EVENT_STREAM_LIMIT;
    this.batchMs = options.batchMs ?? EVENT_BATCH_MS;
    this.heartbeatMs = options.heartbeatMs ?? EVENT_HEARTBEAT_MS;
  }

  get size(): number { return this.streams.size; }

  /** Ends every stream; clients reconnect and resynchronise with whatever database is current then. */
  closeAll(): void {
    for (const close of [...this.streams]) close();
  }

  open(store: Store, headers: Record<string, string>, signal?: AbortSignal): Response {
    if (this.streams.size >= this.limit) throw new AppError('Слишком много открытых потоков событий. Закройте лишние вкладки brigd.', 429);
    const encoder = new TextEncoder();
    const pending = new Set<ChangeScope>();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let batch: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    const close = () => {
      if (!this.streams.delete(close)) return;
      clearTimeout(batch);
      clearInterval(heartbeat);
      unsubscribe();
      signal?.removeEventListener('abort', close);
      try { controller?.close(); } catch { /* Already closed by the client. */ }
    };
    const send = (text: string) => {
      try { controller?.enqueue(encoder.encode(text)); } catch { close(); }
    };
    const flush = () => {
      batch = undefined;
      if (!pending.size) return;
      const event: ChangeEvent = { revision: store.revision, scopes: [...pending] };
      pending.clear();
      send(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Reserve the slot now: the limit must hold even before the body starts.
    this.streams.add(close);
    const body = new ReadableStream<Uint8Array>({
      start: stream => {
        controller = stream;
        if (!this.streams.has(close)) { stream.close(); return; }
        const ready: ReadyEvent = { instance: store.instance, revision: store.revision };
        send(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
        unsubscribe = store.onChange(scopes => {
          for (const scope of scopes) pending.add(scope);
          batch ??= setTimeout(flush, this.batchMs);
        });
        heartbeat = setInterval(() => send(': heartbeat\n\n'), this.heartbeatMs);
      },
      cancel: close,
    });
    if (signal?.aborted) close();
    else signal?.addEventListener('abort', close, { once: true });
    return new Response(body, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  }
}
