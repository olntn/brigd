import { capabilitiesFromHelp, runBoundedProcess } from '../server/adapter';
import type { Provider } from '../src/lib/types';

console.log(`Trackt • Bun ${Bun.version} • ${process.platform}/${process.arch}`);
console.log(`Рабочая папка: ${process.cwd()}\n`);
let available = 0;
for (const provider of ['codex', 'claude'] as Provider[]) {
  const binary = Bun.which(provider);
  if (!binary) { console.log(`○ ${provider}: не найден в PATH`); continue; }
  try {
    const help = async (args: string[]) => {
      let text = '';
      const code = await runBoundedProcess([binary, ...args], { cwd: process.cwd(), signal: new AbortController().signal,
        timeoutMs: 8000, maxOutputBytes: 262144, onStdout: chunk => { text += chunk; }, onStderr: chunk => { text += chunk; } });
      if (code !== 0) throw new Error(`--help завершился с кодом ${code}`);
      return text;
    };
    const capabilities = provider === 'codex'
      ? capabilitiesFromHelp(provider, await help(['exec', '--help']), await help(['exec', 'resume', '--help']))
      : capabilitiesFromHelp(provider, await help(['--help']));
    console.log(`✓ ${provider}: CLI найден, нужные флаги поддерживаются${capabilities.schema ? ', JSON Schema доступна' : ''}`);
    available++;
  } catch (error) { console.log(`! ${provider}: ${error instanceof Error ? error.message : error}`); }
}
console.log(`\n${available ? 'CLI готов к проверке входа.' : 'Для реальных задач установите хотя бы один CLI.'} Вход, подписка и запросы к модели здесь не проверяются.`);
console.log('Войдите в CLI самостоятельно в терминале. Не вводите ключи и пароли в карточку задачи.');
console.log('Для бесплатной локальной проверки интерфейса: bun run build && bun run demo');
