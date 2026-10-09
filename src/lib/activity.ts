import type { Attachment, Comment, TaskDetail, TaskLog } from './types';

export interface ActivityLog extends TaskLog { attachments?: Attachment[]; }

const legacyActions = new Map([
  ['Agent is working with local tools.', 'Работник использует локальные инструменты'],
  ['Agent is working on project files.', 'Работник изменяет файлы проекта'],
  ['Agent is checking an external source.', 'Работник проверяет внешний источник'],
  ['Mock: simulating an agent turn. No CLI or model is called.', 'Демонстрация работы агента'],
]);
const legacyStartup = /^Starting (Codex|Claude Code)( in the saved session)?\. Native CLI permission rules remain active\.$/;

/** Only known, previously generated status messages are reclassified. User prose stays intact. */
export function isActionComment(entry: Comment): boolean {
  return entry.kind === 'system' || entry.kind === 'agent' &&
    (legacyActions.has(entry.body) || legacyStartup.test(entry.body));
}

export function taskActivity(detail: TaskDetail | null): { comments: Comment[]; logs: ActivityLog[] } {
  if (!detail) return { comments: [], logs: [] };
  const comments: Comment[] = [];
  const logs: ActivityLog[] = [...(detail.logs ?? [])];
  for (const entry of detail.comments) {
    if (!isActionComment(entry)) { comments.push(entry); continue; }
    logs.push({
      id: `comment-${entry.id}`, taskId: entry.taskId, runId: entry.runId,
      stepIndex: entry.stepIndex, kind: entry.kind === 'system' ? 'system' : 'legacy',
      summary: legacyActions.get(entry.body) ?? (legacyStartup.test(entry.body) ? 'Запуск CLI работника' : entry.body),
      details: entry.kind === 'system' ? [entry.body] : [entry.body, 'Дополнительные детали этого действия не были сохранены.'],
      createdAt: entry.createdAt, attachments: entry.attachments,
    });
  }
  logs.sort((a, b) => a.createdAt - b.createdAt);
  return { comments, logs };
}
