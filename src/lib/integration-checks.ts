const invalidCommands = 'BRIGD_INTEGRATION_CHECKS: укажите 1–10 непустых команд массивами аргументов';

/** Validate argv arrays without shell parsing, with the same limits for UI and environment settings. */
export function validateIntegrationChecks(value: unknown): string[][] {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error(invalidCommands);
  for (const argv of value) {
    if (!Array.isArray(argv) || !argv.length || argv.length > 30) throw new Error(invalidCommands);
    for (const arg of argv) {
      if (typeof arg !== 'string' || !arg.length || arg.length > 4096 || arg.includes('\0')) throw new Error(invalidCommands);
    }
  }
  if (JSON.stringify(value).length > 32_000) throw new Error(invalidCommands);
  return value.map(argv => [...argv]);
}

export function parseIntegrationChecks(text: string): string[][] {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('BRIGD_INTEGRATION_CHECKS должен быть JSON-массивом массивов аргументов'); }
  return validateIntegrationChecks(value);
}
