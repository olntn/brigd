import { createHmac } from 'node:crypto';
import type { BrigdNotification } from '../src/lib/notification-events';
import { AppError } from './errors';

export interface WebhookSettings { webhookUrl: string; webhookSecret: string; }

export function validateWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new AppError('URL webhook: укажите http:// или https:// без учётных данных');
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid webhook URL');
    return url.href;
  } catch { throw new AppError('URL webhook: укажите http:// или https:// без учётных данных'); }
}

export function validateWebhookSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new AppError('Секрет webhook: не больше 4096 символов');
  return value;
}

/** Best effort, in-memory delivery. Never await network requests from the engine or a database transaction. */
export class NotificationQueue {
  private pending: { settings: WebhookSettings; body: string }[] = [];
  private draining: Promise<void> | null = null;
  constructor(private send: typeof fetch = fetch, private report: (message: string) => void = message => console.error(message)) {}

  enqueue(settings: WebhookSettings, payload: BrigdNotification): void {
    if (!settings.webhookUrl) return;
    // Bound memory if the receiver is down during a large burst of events.
    if (this.pending.length >= 1000) { this.report('[brigd] Webhook queue full; notification dropped'); return; }
    this.pending.push({ settings: { ...settings }, body: JSON.stringify(payload) });
    this.start();
  }

  private start(): void {
    this.draining ??= Promise.resolve().then(() => this.drain()).finally(() => {
      this.draining = null;
      if (this.pending.length) this.start();
    });
  }

  async idle(): Promise<void> {
    // Store emissions are deferred until the synchronous transaction has ended.
    await Promise.resolve();
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    for (let item; (item = this.pending.shift());) {
      const { settings, body } = item;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.webhookSecret) headers['X-Brigd-Signature'] = createHmac('sha256', settings.webhookSecret).update(body).digest('hex');
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await this.send(settings.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
          await response.body?.cancel();
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          break;
        } catch {
          // URLs, secrets and receiver responses may contain credentials: keep them out of logs.
          this.report(`[brigd] Webhook delivery failed (attempt ${attempt + 1}/2)`);
        }
      }
    }
  }
}
