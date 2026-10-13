import { resolve } from 'node:path';
import { startBrigd } from './update';

try {
  process.exitCode = await startBrigd(resolve(import.meta.dir, '..'));
} catch (error) {
  console.error(`[brigd] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
