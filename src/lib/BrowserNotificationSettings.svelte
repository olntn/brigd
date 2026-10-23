<script lang="ts">
  import { onMount } from 'svelte';
  import { t, tk } from './i18n';
  import { notificationPermission, notificationStorageKey, readNotificationPreferences, saveNotificationPreferences } from './browser-notifications';
  import type { NotificationCategory } from './notification-events';

  let preferences = $state(readNotificationPreferences());
  let permission = $state(notificationPermission());
  let saveError = $state(false);
  const events: { id: NotificationCategory; label: string }[] = [
    { id: 'questions', label: tk('Вопросы агента') },
    { id: 'failures', label: tk('Ошибки, блокировки и прерывания запусков') },
    { id: 'merges', label: tk('Слияние требует внимания') },
    { id: 'autopilot', label: tk('Остановка автопилота и конец очереди') },
    { id: 'completed', label: tk('Задача завершена и слита') },
  ];
  function save() { saveError = !saveNotificationPreferences(preferences); }
  async function toggleBrowser(event: Event) {
    preferences.browser = (event.currentTarget as HTMLInputElement).checked;
    if (preferences.browser && notificationPermission() !== 'unsupported') {
      try { permission = await Notification.requestPermission(); } catch { permission = notificationPermission(); }
    }
    save();
  }
  onMount(() => {
    const changed = (event: StorageEvent) => { if (event.key === notificationStorageKey || event.key === null) preferences = readNotificationPreferences(); };
    const focused = () => { permission = notificationPermission(); };
    window.addEventListener('storage', changed);
    window.addEventListener('focus', focused);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', focused); };
  });
</script>

<fieldset class="fallback-settings notification-settings">
  <legend>{t('Уведомления')}</legend>
  <p class="fallback-help">{t('Выбор сохраняется в этом браузере. Уведомления работают, пока открыта хотя бы одна вкладка brigd.')}</p>
  <label class="checkbox-field"><input type="checkbox" checked={preferences.browser} onchange={toggleBrowser} disabled={permission === 'unsupported'} />{t('Уведомления в браузере')}</label>
  <p class="fallback-help">{permission === 'granted' ? t('Разрешение: получено') : permission === 'denied' ? t('Разрешение: запрещено в настройках браузера') : permission === 'unsupported' ? t('Браузер не поддерживает уведомления в этом контексте') : t('Разрешение: ещё не запрошено')}</p>
  <label class="checkbox-field"><input type="checkbox" checked={preferences.sound} onchange={event => { preferences.sound = event.currentTarget.checked; save(); }} />{t('Звук')}</label>
  <p class="fallback-help">{t('Звук доступен после первого взаимодействия с этой вкладкой.')}</p>
  {#each events as event (event.id)}
    <label class="checkbox-field"><input type="checkbox" checked={preferences.events[event.id]} onchange={change => { preferences.events[event.id] = change.currentTarget.checked; save(); }} />{t(event.label)}</label>
  {/each}
  {#if saveError}<p class="form-error" role="alert">{t('Браузер не смог сохранить настройки уведомлений.')}</p>{/if}
</fieldset>
