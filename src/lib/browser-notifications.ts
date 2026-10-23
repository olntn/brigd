import { t } from './i18n';
import type { NotificationCategory, NotificationEvent } from './notification-events';

export interface NotificationPreferences {
  browser: boolean;
  sound: boolean;
  events: Record<NotificationCategory, boolean>;
}
export const notificationStorageKey = 'brigd.notifications';
const seenKey = 'brigd.notification-events';
export const defaultNotificationPreferences: NotificationPreferences = {
  browser: false, sound: false,
  events: { questions: true, failures: true, merges: true, autopilot: true, completed: false },
};
export function readNotificationPreferences(): NotificationPreferences {
  let input: Partial<NotificationPreferences> = {};
  try { input = JSON.parse(localStorage.getItem(notificationStorageKey) ?? '{}') ?? {}; } catch { /* Storage may be disabled. */ }
  return {
    browser: input.browser === true, sound: input.sound === true,
    events: Object.fromEntries(Object.entries(defaultNotificationPreferences.events).map(([key, value]) =>
      [key, typeof input.events?.[key as NotificationCategory] === 'boolean' ? input.events[key as NotificationCategory] : value])) as NotificationPreferences['events'],
  };
}
export function saveNotificationPreferences(value: NotificationPreferences): boolean {
  try { localStorage.setItem(notificationStorageKey, JSON.stringify(value)); window.dispatchEvent(new Event('brigd-notification-preferences')); return true; } catch { return false; }
}
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
export function notificationLabel(event: NotificationEvent): string {
  if (event.category === 'questions') return t('Агент ждёт вашего ответа');
  if (event.category === 'failures') return t('Запуск требует внимания');
  if (event.category === 'merges') return t('Слияние требует внимания');
  if (event.category === 'completed') return t('Задача завершена и слита');
  if (event.payload.status === 'empty') return t('Очередь автопилота закончилась');
  if (event.payload.status === 'until') return t('Автопилот остановлен по времени');
  if (event.payload.status === 'restart') return t('Автопилот остановлен перезапуском');
  return t('Автопилот выключен предохранителем');
}

/** One controller per tab. The event key and Web Lock are shared by all tabs of this origin. */
export class BrowserNotifications {
  private audio: AudioContext | null = null;
  private disposed = false;
  private unlock = () => {
    if (!readNotificationPreferences().sound || typeof AudioContext === 'undefined') return;
    try { this.audio ??= new AudioContext(); void this.audio.resume().catch(() => {}); } catch { /* User activation is required. */ }
  };
  constructor(private openTask: (id: string) => void) {
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.unlock);
    window.addEventListener('brigd-notification-preferences', this.unlock);
  }
  dispose() {
    this.disposed = true;
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    window.removeEventListener('brigd-notification-preferences', this.unlock);
    void this.audio?.close().catch(() => {});
  }
  async show(event: NotificationEvent): Promise<void> {
    const preferences = readNotificationPreferences();
    if (this.disposed || !preferences.events[event.category] || (!preferences.sound && (!preferences.browser || notificationPermission() !== 'granted'))) return;
    const deliver = () => {
      if (this.disposed) return;
      let seen: string[];
      try {
        seen = JSON.parse(localStorage.getItem(seenKey) ?? '[]');
        if (!Array.isArray(seen)) seen = [];
        if (seen.includes(event.key)) return;
        localStorage.setItem(seenKey, JSON.stringify([...seen.slice(-199), event.key]));
      } catch { return; } // Without shared storage, cross-tab deduplication cannot be guaranteed.
      if (preferences.browser && notificationPermission() === 'granted') {
        try {
          const notification = new Notification(notificationLabel(event), { body: event.payload.title, tag: event.key, icon: '/brig.svg', silent: true });
          notification.onclick = () => { window.focus(); if (event.payload.taskId) this.openTask(event.payload.taskId); notification.close(); };
        } catch { /* Unsupported in some browsers even after permission is granted. */ }
      }
      if (preferences.sound) this.chime();
    };
    try {
      if (navigator.locks) await navigator.locks.request('brigd-notifications', deliver);
      else {
        // Older browsers: elect the last claimant, then verify it after other tabs have had a turn.
        const claimKey = `brigd.notification-claim:${event.key}`;
        const claim = `${event.key}:${Math.random()}`;
        localStorage.setItem(claimKey, claim);
        await new Promise(resolve => setTimeout(resolve, 80));
        if (localStorage.getItem(claimKey) === claim) { deliver(); localStorage.removeItem(claimKey); }
      }
    } catch { /* Notification failures never affect refreshing task data. */ }
  }
  private chime() {
    if (!this.audio || this.audio.state !== 'running') return;
    try {
      const at = this.audio.currentTime;
      const tone = this.audio.createOscillator();
      const gain = this.audio.createGain();
      tone.type = 'sine'; tone.frequency.setValueAtTime(880, at); tone.frequency.setValueAtTime(1174.66, at + 0.10);
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(0.12, at + 0.01); gain.gain.exponentialRampToValueAtTime(0.001, at + 0.28);
      tone.connect(gain); gain.connect(this.audio.destination);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(at); tone.stop(at + 0.3);
    } catch { /* Audio can be suspended by the browser. */ }
  }
}
