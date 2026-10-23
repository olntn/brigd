import { CHANGE_SCOPES, type ChangeEvent, type ChangeScope, type ReadyEvent } from './change-scopes';

/** Reload interval that covers a stream which is down or silently stalled. */
export const FALLBACK_INTERVAL_MS = 20_000;
/** Lets one reload absorb a burst of changes. */
export const RELOAD_DELAY_MS = 100;
/** Least time between two reloads of one subscriber while an agent keeps writing. */
export const RELOAD_INTERVAL_MS = 1_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/** Returning `false` (or a promise of it) means the subscriber was busy and wants another try shortly. */
export type Reload = () => unknown;
interface Subscriber {
  background?: () => boolean;
  scopes: ReadonlySet<ChangeScope>;
  reload: Reload;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  dirty: boolean;
  last: number;
}

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let fallback: ReturnType<typeof setInterval> | undefined;
let failures = 0;
let seen: ReadyEvent | null = null;

/** Calls `reload` shortly after the server reports a change in one of `scopes`, after a reconnect that may have missed
 * changes, once the service turns out to be unreachable, when the tab becomes visible again, and every FALLBACK_INTERVAL_MS.
 * Returns the unsubscribe function. */
export function subscribe(scopes: readonly ChangeScope[], reload: Reload, background?: () => boolean): () => void {
  const subscriber: Subscriber = { scopes: new Set(scopes), reload, background, running: false, dirty: false, last: -Infinity };
  subscribers.add(subscriber);
  if (subscribers.size === 1) start();
  return () => {
    if (!subscribers.delete(subscriber)) return;
    clearTimeout(subscriber.timer);
    if (!subscribers.size) stop();
  };
}

function schedule(subscriber: Subscriber, delay = RELOAD_DELAY_MS) {
  if (!subscribers.has(subscriber)) return;
  if (subscriber.running) { subscriber.dirty = true; return; }
  if (subscriber.timer !== undefined) return;
  const wait = Math.max(delay, subscriber.last + RELOAD_INTERVAL_MS - performance.now());
  subscriber.timer = setTimeout(() => void run(subscriber), wait);
}

async function run(subscriber: Subscriber) {
  subscriber.timer = undefined;
  if (!subscribers.has(subscriber)) return;
  subscriber.running = true;
  subscriber.dirty = false;
  subscriber.last = performance.now();
  let busy = false;
  try { busy = await subscriber.reload() === false; }
  catch { /* Each view reports its own loading errors. */ }
  finally { subscriber.running = false; }
  if (busy) schedule(subscriber, RELOAD_INTERVAL_MS);
  else if (subscriber.dirty) schedule(subscriber);
}

/** `null` reloads every subscriber. Hidden tabs refresh only subscribers with notifications enabled. */
function notify(scopes: readonly ChangeScope[] | null) {
  for (const subscriber of subscribers) {
    if (document.visibilityState === 'hidden' && !subscriber.background?.()) continue;
    if (!scopes || scopes.some(scope => subscriber.scopes.has(scope))) schedule(subscriber);
  }
}

function parse<T>(event: Event): T | null {
  try { return JSON.parse((event as MessageEvent<string>).data) as T; }
  catch { return null; }
}

function connect() {
  clearTimeout(retry);
  retry = undefined;
  if (source || !subscribers.size || typeof EventSource === 'undefined') return;
  const stream = new EventSource('/api/events');
  source = stream;
  stream.addEventListener('ready', event => {
    const ready = parse<ReadyEvent>(event);
    if (source !== stream || typeof ready?.instance !== 'string' || typeof ready.revision !== 'number') return;
    failures = 0;
    // The first stream, a restarted service, a restored backup or changes made while disconnected: reload everything once.
    if (!seen || seen.instance !== ready.instance || seen.revision !== ready.revision) notify(null);
    seen = ready;
  });
  stream.addEventListener('change', event => {
    const change = parse<ChangeEvent>(event);
    if (source !== stream || !change || !Array.isArray(change.scopes)) return;
    if (seen && typeof change.revision === 'number') seen = { ...seen, revision: change.revision };
    notify(change.scopes.filter(scope => (CHANGE_SCOPES as readonly string[]).includes(scope)));
  });
  stream.addEventListener('error', () => {
    if (source !== stream) return;
    // The browser's own retry ignores error statuses such as 503 during a restore; reconnect here instead.
    stream.close();
    source = null;
    // The first failed reconnect after a working stream means the service is unreachable: let every view show that now.
    if (failures === 1) notify(null);
    // A stream that worked (ended by a restart or restore) returns after about a second; each failed attempt doubles the wait.
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** failures++);
    retry = setTimeout(connect, delay * (0.8 + Math.random() * 0.4));
  });
}

function reconnectNow() {
  if (!source && subscribers.size) { failures = 0; connect(); }
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  notify(null);
  reconnectNow();
}

function start() {
  connect();
  fallback = setInterval(() => notify(null), FALLBACK_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', reconnectNow);
}

function stop() {
  clearTimeout(retry);
  clearInterval(fallback);
  retry = fallback = undefined;
  source?.close();
  source = null;
  failures = 0;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', reconnectNow);
}
