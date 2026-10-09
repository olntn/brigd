import type { Run, TaskStepInput } from '../src/lib/types';
import { WORKFLOW_MIN_STEPS, WORKFLOW_MAX_STEPS, WORKFLOW_STEP_TITLE_LIMIT, WORKFLOW_STEP_INSTRUCTION_LIMIT, WORKFLOW_TEXT_LIMIT, WORKFLOW_BYTES_LIMIT } from '../src/lib/workflows';
import { AppError } from './errors';

// The body may use six-byte escapes per UTF-16 code unit. This larger limit is
// restricted to task editing; comments, resume, and other routes keep their cap.
export const TASK_JSON_LIMIT = (WORKFLOW_TEXT_LIMIT + 16_000 + 4_096 + 140) * 6 + 16_384;
export function validateWorkflowSteps(value: unknown): TaskStepInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError('Этапы должны быть массивом');
  if (value.length === 0) return [];
  if (value.length < WORKFLOW_MIN_STEPS || value.length > WORKFLOW_MAX_STEPS) throw new AppError(`Сложная задача: от ${WORKFLOW_MIN_STEPS} до ${WORKFLOW_MAX_STEPS} этапов`);
  const steps = value.map((raw, index): TaskStepInput => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(`Этап ${index + 1}: ожидается объект`);
    const step = raw as Record<string, unknown>;
    if (Object.keys(step).some(key => !['workerId', 'title', 'instruction'].includes(key))) throw new AppError(`Этап ${index + 1}: неизвестное поле`);
    if (typeof step.workerId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(step.workerId)) throw new AppError(`Этап ${index + 1}: выберите работника`);
    const bounded = (field: 'title' | 'instruction', max: number): string => {
      const text = step[field];
      if (typeof text !== 'string' || !text.trim() || text.length > max || text.includes('\0')) throw new AppError(`Этап ${index + 1}, ${field === 'title' ? 'название' : 'инструкция'}: от 1 до ${max} символов без нулевых байтов`);
      return text.trim();
    };
    return { workerId: step.workerId, title: bounded('title', WORKFLOW_STEP_TITLE_LIMIT), instruction: bounded('instruction', WORKFLOW_STEP_INSTRUCTION_LIMIT) };
  });
  if (steps.reduce((sum, step) => sum + step.title.length + step.instruction.length, 0) > WORKFLOW_TEXT_LIMIT) throw new AppError(`Все этапы вместе: не больше ${WORKFLOW_TEXT_LIMIT} символов`);
  if (Buffer.byteLength(JSON.stringify(steps), 'utf8') > WORKFLOW_BYTES_LIMIT) throw new AppError(`Все этапы вместе: не больше ${WORKFLOW_BYTES_LIMIT} байтов UTF-8`);
  return steps;
}
export interface WorkflowContext {
  stepIndex: number;
  stepCount: number;
  title: string;
  instruction: string;
  predecessors: { stepIndex: number; title: string; workerName: string; summary: string }[];
}
/** Carry the immediate predecessor's full validated result; never silently drop it. */
export function workflowContext(run: Pick<Run, 'steps' | 'currentStepIndex'>): WorkflowContext | undefined {
  if (!run.steps.length || run.currentStepIndex === null) return undefined;
  const index = run.currentStepIndex;
  const current = run.steps[index]!;
  const previous = index > 0 ? run.steps[index - 1]! : null;
  return { stepIndex: index, stepCount: run.steps.length, title: current.title, instruction: current.instruction,
    predecessors: previous ? [{ stepIndex: index - 1, title: previous.title, workerName: previous.worker.name, summary: previous.summary ?? '' }] : [] };
}
