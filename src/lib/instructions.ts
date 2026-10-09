export const INSTRUCTION_TITLE_LIMIT = 140;
export const INSTRUCTION_BODY_LIMIT = 16_000;
export const INSTRUCTION_COUNT_LIMIT = 100;
export const INSTRUCTION_ENABLED_TEXT_LIMIT = 64_000;
// Bound the complete JSON-encoded snapshot, including IDs and escaping, to leave
// room for the task, worker style, and clarification in a safe CLI argument.
export const INSTRUCTION_ENABLED_BYTES_LIMIT = 24_000;
