import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translateServer } from '../src/lib/i18n';
import { ATTACHMENT_MAX_COUNT } from '../src/lib/attachments';
import { DOC_PAGE_LIMIT } from '../src/lib/docs';
import { INSTRUCTION_TITLE_LIMIT } from '../src/lib/instructions';
import { TAG_NAME_LIMIT } from '../src/lib/tags';
import { MODEL_LABEL_LIMIT } from '../src/lib/workers';
import { WORKFLOW_MAX_STEPS, WORKFLOW_MIN_STEPS } from '../src/lib/workflows';
import { attachmentIds } from '../server/attachments';
import { claudeStatus, codexStatus, configureClaude, configureCodex } from '../server/cli-config';
import { validateDocBlocks, validateDocPageContent, validateDocPageMove } from '../server/docs';
import { validateFollowup } from '../server/followups';
import { validateInstruction } from '../server/instructions';
import { validateModel } from '../server/models';
import { validateTag } from '../server/tags';
import { textField, validateAutopilotMove, validateIntegratorProfile, validateWorker } from '../server/validation';
import { validateWorkflowSteps } from '../server/workflows';

const cyrillic = /[А-Яа-яЁё]/;
const english = (text: string) => translateServer('en', text);

/** The Russian message a validator really throws. */
function thrown(action: () => unknown): string {
  try { action(); } catch (error) { return (error as Error).message; }
  throw new Error('Expected the validator to fail');
}

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'brigd-i18n-'));
  homes.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('server API errors in English', () => {
  test('name the validated field', () => {
    expect(english(thrown(() => textField(undefined, 'Название', 140)))).toBe('Title: enter 1 to 140 characters');
    expect(english(thrown(() => textField('', 'Рабочая папка', 4_096)))).toBe('Working folder: enter 1 to 4096 characters');
    expect(english(thrown(() => textField(' ', 'Комментарий', 8_000)))).toBe('Comment: enter 1 to 8000 characters');
    expect(english(thrown(() => validateWorker({ name: '', provider: 'codex' })))).toBe('Worker name: enter 1 to 80 characters');
    expect(english(thrown(() => validateWorker({ name: 'Ада', provider: 'codex', communicationStyle: 'x'.repeat(4_001) }))))
      .toBe('Personal instructions: at most 4000 characters');
    expect(english(thrown(() => validateIntegratorProfile({ mode: 'custom', provider: 'claude', communicationStyle: 'x'.repeat(4_001) }))))
      .toBe('Instructions for the Integrator: at most 4000 characters');
    expect(english(thrown(() => validateInstruction({ title: '', body: 'Текст', enabled: true }))))
      .toBe(`Instruction title: enter 1 to ${INSTRUCTION_TITLE_LIMIT} characters without null bytes`);
    expect(english(thrown(() => validateTag({ name: '' })))).toBe(`Tag name: enter 1 to ${TAG_NAME_LIMIT} characters`);
    expect(english(thrown(() => validateModel({ provider: 'codex', modelId: 'gpt', label: 'x'.repeat(MODEL_LABEL_LIMIT + 1) }))))
      .toBe(`Model name: 1 to ${MODEL_LABEL_LIMIT} characters`);
  });

  test('keep stage, block and limit numbers', () => {
    expect(english(thrown(() => validateWorkflowSteps([{ workerId: 'w', title: 'a', instruction: 'b' }]))))
      .toBe(`Complex task: ${WORKFLOW_MIN_STEPS} to ${WORKFLOW_MAX_STEPS} stages`);
    expect(english(thrown(() => validateWorkflowSteps([{ workerId: 'w', title: 'a', instruction: 'b' }, { workerId: 'w', title: ' ', instruction: 'b' }]))))
      .toMatch(/^Stage 2, title: 1 to \d+ characters without null bytes$/);
    expect(english(thrown(() => validateWorkflowSteps([{ workerId: 'w', title: 'a', instruction: 'b' }, { workerId: '', title: 'a', instruction: 'b' }]))))
      .toBe('Stage 2: choose a worker');
    const paragraph = { id: 'a', type: 'paragraph', text: 'x', indent: 0 };
    expect(english(thrown(() => validateDocBlocks([paragraph, paragraph])))).toBe('Block 2: duplicate id');
    expect(english(thrown(() => validateDocBlocks([{ ...paragraph, color: 'red' }])))).toBe('Block 1: field color is not allowed in a “paragraph” block');
    expect(english(thrown(() => validateDocBlocks([{ id: 't', type: 'table', text: '', indent: 0, rows: [['a', 'b'], ['c']] }]))))
      .toBe('Block 1: row 2 must have 2 cells');
    expect(english(thrown(() => validateDocPageMove({ position: -1 })))).toBe(`position: an integer from 0 to ${DOC_PAGE_LIMIT}`);
    expect(english(thrown(() => validateDocPageContent({ title: 'x' })))).toBe('Specify the page title, blocks and version');
    expect(english(thrown(() => attachmentIds(Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => `a${index}`)))))
      .toBe(`Attachments: choose at most ${ATTACHMENT_MAX_COUNT} files`);
  });

  test('translate fixed messages', () => {
    expect(english(thrown(() => validateAutopilotMove({ beforeTaskId: 'task' }, 'task')))).toBe('A task cannot be placed before itself');
    expect(english(thrown(() => validateFollowup({ body: 'x' })))).toBe('Specify the source run, stage, text, attachments and request ID');
    expect(english('Внутренняя ошибка. Подробности в терминале сервиса.')).toBe('Internal error. See the service terminal for details.');
    expect(english('Сервис останавливается')).toBe('The service is shutting down');
    expect(english('Бэкап не найден')).toBe('Backup not found');
  });

  test('explain unreadable CLI permission files with the path intact', () => {
    const claude = home({ '.claude/settings.json': '[]' });
    const status = claudeStatus(claude);
    expect(english(status.error!)).toBe('File not read: expected a JSON object. Fix the file manually; brigd does not overwrite a file it cannot parse.');
    expect(status.notes.map(english).join(' ')).not.toMatch(cyrillic);
    const path = join(claude, '.claude/settings.json');
    expect(english(thrown(() => configureClaude(claude))))
      .toBe(`${path}: expected a JSON object. Fix the file manually; brigd does not overwrite a file it cannot parse.`);
    const codex = home({ '.codex/config.toml': 'sandbox_mode = = 1' });
    expect(english(codexStatus(codex).error!)).toMatch(/^File not read: .+\. Fix the file manually; brigd does not overwrite a file it cannot parse\.$/);
    expect(codexStatus(codex).notes.map(english).join(' ')).not.toMatch(cyrillic);
    const failure = english(thrown(() => configureCodex(codex)));
    expect(failure.startsWith(`${join(codex, '.codex/config.toml')}: `)).toBe(true);
    expect(failure).not.toMatch(cyrillic);
  });

  test('leave unknown Russian text and the Russian interface unchanged', () => {
    expect(english('Мой текст: не больше 5 символов')).toBe('Мой текст: не больше 5 символов');
    expect(english('Глава 2: ожидается объект')).toBe('Глава 2: ожидается объект');
    expect(translateServer('ru', 'Название: введите от 1 до 140 символов')).toBe('Название: введите от 1 до 140 символов');
  });
});
