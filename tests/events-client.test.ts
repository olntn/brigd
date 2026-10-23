import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { FALLBACK_INTERVAL_MS, RELOAD_DELAY_MS, RELOAD_INTERVAL_MS, subscribe } from '../src/lib/events';

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) { FakeEventSource.all.push(this); }
  static get last() { return FakeEventSource.all.at(-1)!; }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  close() { this.closed = true; }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function target() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)); },
    removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); },
    dispatch: (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

let page: ReturnType<typeof target> & { visibilityState: 'visible' | 'hidden' };
let browser: ReturnType<typeof target>;
let stops: (() => void)[];
let instance = 0;
const nextInstance = () => `instance-${++instance}`;
const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
/** Lets finished reloads schedule their follow-ups, then advances fake time. */
async function advance(ms: number) {
  await settle();
  jest.advanceTimersByTime(ms);
  await settle();
}
function watch(scopes: Parameters<typeof subscribe>[0], reload: () => unknown = () => {}) {
  const calls = { count: 0 };
  stops.push(subscribe(scopes, () => { calls.count++; return reload(); }));
  return calls;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeEventSource.all = [];
  stops = [];
  page = Object.assign(target(), { visibilityState: 'visible' as const });
  browser = target();
  Object.assign(globalThis, { document: page, window: browser, EventSource: FakeEventSource });
});
afterEach(() => {
  for (const stop of stops) stop();
  jest.useRealTimers();
  for (const key of ['document', 'window', 'EventSource']) Reflect.deleteProperty(globalThis, key);
});

describe('interface change events', () => {
  test('notification subscribers opt into hidden-tab refreshes only while enabled', async () => {
    let enabled = true;
    let notificationReads = 0;
    const ordinary = watch(['tasks']);
    stops.push(subscribe(['tasks'], () => { notificationReads++; }, () => enabled));
    page.visibilityState = 'hidden';
    FakeEventSource.last.emit('change', { revision: 1, scopes: ['tasks'] });
    await advance(RELOAD_DELAY_MS);
    expect(notificationReads).toBe(1);
    expect(ordinary.count).toBe(0);
    enabled = false;
    FakeEventSource.last.emit('change', { revision: 2, scopes: ['tasks'] });
    await advance(RELOAD_INTERVAL_MS);
    expect(notificationReads).toBe(1);
    page.visibilityState = 'visible';
    page.dispatch('visibilitychange');
    await advance(RELOAD_DELAY_MS);
    expect(ordinary.count).toBe(1);
    expect(notificationReads).toBe(2);
  });
  test('a change reloads only the matching views, once per burst and at most once per reload interval', async () => {
    const tasks = watch(['tasks', 'workers']);
    const docs = watch(['docs']);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.last.url).toBe('/api/events');
    // The first stream resynchronises everything once.
    FakeEventSource.last.emit('ready', { instance: nextInstance(), revision: 3 });
    await advance(RELOAD_DELAY_MS);
    expect([tasks.count, docs.count]).toEqual([1, 1]);
    await advance(RELOAD_INTERVAL_MS);
    FakeEventSource.last.emit('change', { revision: 4, scopes: ['workers'] });
    FakeEventSource.last.emit('change', { revision: 5, scopes: ['tasks', 'unknown'] });
    await advance(RELOAD_DELAY_MS);
    expect([tasks.count, docs.count]).toEqual([2, 1]);
    FakeEventSource.last.emit('change', { revision: 6, scopes: ['tasks'] });
    await advance(RELOAD_DELAY_MS);
    expect(tasks.count).toBe(2);
    await advance(RELOAD_INTERVAL_MS);
    expect(tasks.count).toBe(3);
    FakeEventSource.last.emit('change', { revision: 7, scopes: ['settings'] });
    await advance(RELOAD_INTERVAL_MS * 3);
    expect([tasks.count, docs.count]).toEqual([3, 1]);
  });

  test('a busy view is retried, a change during a reload repeats it, and a hidden tab reloads when it returns', async () => {
    let busy = true;
    let finish!: () => void;
    const instructions = watch(['instructions'], () => busy ? false : new Promise<void>(resolve => { finish = resolve; }));
    FakeEventSource.last.emit('ready', { instance: nextInstance(), revision: 0 });
    await advance(RELOAD_DELAY_MS);
    expect(instructions.count).toBe(1);
    busy = false;
    await advance(RELOAD_INTERVAL_MS);
    expect(instructions.count).toBe(2);
    FakeEventSource.last.emit('change', { revision: 1, scopes: ['instructions'] });
    await advance(RELOAD_INTERVAL_MS * 2);
    expect(instructions.count).toBe(2);
    finish();
    await advance(RELOAD_INTERVAL_MS);
    expect(instructions.count).toBe(3);
    finish();
    page.visibilityState = 'hidden';
    FakeEventSource.last.emit('change', { revision: 2, scopes: ['instructions'] });
    await advance(FALLBACK_INTERVAL_MS);
    expect(instructions.count).toBe(3);
    page.visibilityState = 'visible';
    page.dispatch('visibilitychange');
    await advance(RELOAD_DELAY_MS);
    expect(instructions.count).toBe(4);
  });

  test('reconnects with growing delays and resynchronises only when the service or its data changed', async () => {
    const tasks = watch(['tasks']);
    const first = FakeEventSource.last;
    const id = nextInstance();
    first.emit('ready', { instance: id, revision: 8 });
    await advance(RELOAD_DELAY_MS);
    expect(tasks.count).toBe(1);
    // A stream that worked comes back after about a second, without reloading in between.
    first.emit('error');
    expect(first.closed).toBe(true);
    await advance(1_200);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(tasks.count).toBe(1);
    // The service is down: the first failed reconnect reloads once so the views show the outage,
    // and later attempts wait longer each time.
    FakeEventSource.last.emit('error');
    await advance(1_200);
    expect(tasks.count).toBe(2);
    expect(FakeEventSource.all).toHaveLength(2);
    await advance(1_200);
    expect(FakeEventSource.all).toHaveLength(3);
    FakeEventSource.last.emit('error');
    await advance(3_000);
    expect(FakeEventSource.all).toHaveLength(3);
    await advance(2_000);
    expect(FakeEventSource.all).toHaveLength(4);
    expect(tasks.count).toBe(2);
    // Same service, nothing missed: no reload.
    FakeEventSource.last.emit('ready', { instance: id, revision: 8 });
    await advance(RELOAD_INTERVAL_MS);
    expect(tasks.count).toBe(2);
    FakeEventSource.last.emit('change', { revision: 9, scopes: ['tasks'] });
    await advance(RELOAD_INTERVAL_MS);
    expect(tasks.count).toBe(3);
    // A restored backup or a restart is another instance: reload.
    FakeEventSource.last.emit('error');
    await advance(1_200);
    FakeEventSource.last.emit('ready', { instance: nextInstance(), revision: 9 });
    await advance(RELOAD_INTERVAL_MS);
    expect(tasks.count).toBe(4);
    // Returning to the tab reconnects at once instead of waiting for the backoff.
    FakeEventSource.last.emit('error');
    await advance(1_200);
    FakeEventSource.last.emit('error');
    const sources = FakeEventSource.all.length;
    page.dispatch('visibilitychange');
    expect(FakeEventSource.all).toHaveLength(sources + 1);
  });

  test('reloads every fallback interval even without a stream and closes everything after the last view leaves', async () => {
    const autopilot = watch(['autopilot']);
    FakeEventSource.last.emit('error');
    await advance(FALLBACK_INTERVAL_MS + RELOAD_DELAY_MS);
    expect(autopilot.count).toBe(1);
    await advance(FALLBACK_INTERVAL_MS);
    expect(autopilot.count).toBe(2);
    expect(page.count('visibilitychange')).toBe(1);
    expect(browser.count('online')).toBe(1);
    for (const stop of stops.splice(0)) stop();
    expect(FakeEventSource.last.closed).toBe(true);
    expect(page.count('visibilitychange')).toBe(0);
    expect(browser.count('online')).toBe(0);
    const sources = FakeEventSource.all.length;
    await advance(FALLBACK_INTERVAL_MS * 2);
    expect(autopilot.count).toBe(2);
    expect(FakeEventSource.all).toHaveLength(sources);
  });
});
