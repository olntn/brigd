/** Reads `text/event-stream` responses block by block in tests. */
export interface StreamBlock { event?: string; data?: any; comment?: string; }

export function readEvents(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // One read stays pending across timeouts, so no chunk is lost between calls.
  let pending: ReturnType<typeof reader.read> | null = null;
  const parse = (block: string): StreamBlock => {
    const result: StreamBlock = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) result.comment = line.slice(1).trim();
      else if (line.startsWith('event: ')) result.event = line.slice(7);
      else if (line.startsWith('data: ')) result.data = JSON.parse(line.slice(6));
    }
    return result;
  };
  return {
    /** The next event or comment; null once the server ended the stream; throws if nothing arrives in time. */
    async next(timeoutMs = 3_000): Promise<StreamBlock | null> {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return parse(block);
        }
        pending ??= reader.read();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - performance.now())); });
        const chunk = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
        if (chunk === 'timeout') throw new Error('No server-sent event arrived in time');
        pending = null;
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    /** Resolves true when nothing but heartbeats arrives for `ms`. */
    async quiet(ms: number): Promise<boolean> {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        let block: StreamBlock | null;
        try { block = await this.next(deadline - performance.now()); }
        catch { return true; }
        if (!block || !block.comment) return false;
      }
      return true;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}
