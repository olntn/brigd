import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, runFence } from '../server/store';
import { prepareAttachment } from '../server/attachments';
import { createTaskBridge } from '../server/task-mcp';
import { TASK_MCP_TOOLS } from '../server/task-mcp-protocol';

// Exact production dependencies and bundled stdio helper; no provider or model calls.
// Unlike unit tests this smoke MUST fail when Unix sockets are unavailable.
const folder = mkdtempSync(join(tmpdir(), 'brigd-attachment-runtime-'));
const database = join(folder, 'test.sqlite');
let store = new Store(database);
let bridge: ReturnType<typeof createTaskBridge> | undefined;
let client: Client | undefined;
const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); };
const text = (result: any) => {
  assert(!result.isError, `MCP tool failed: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
};
try {
  const original = await sharp({ create: { width: 1200, height: 800, channels: 4, background: '#6f54dc' } }).png().toBuffer();
  const image = store.stageAttachment(await prepareAttachment(original, 'image/png', 'runtime-screen.png'));
  const task = store.createTask({ title: 'Packaged attachment smoke', instruction: 'Synthetic MCP checks only.', provider: 'codex', cwd: folder,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, attachmentIds: [image.id] });
  const run = store.startManual(task.id, false);
  bridge = createTaskBridge(store, run, runFence(run));
  assert(bridge.agentConfig.args[0]?.endsWith('/dist/task-mcp-stdio.js') && existsSync(bridge.agentConfig.args[0]), 'Build and use the packaged MCP helper');
  client = new Client({ name: 'brigd-packaged-check', version: '1' });
  const transport = new StdioClientTransport({ command: bridge.agentConfig.command, args: bridge.agentConfig.args,
    env: { PATH: process.env.PATH ?? '', ...bridge.agentConfig.env }, stderr: 'pipe' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert(JSON.stringify(tools.tools.map(tool => tool.name).sort()) === JSON.stringify([...TASK_MCP_TOOLS].sort()), 'Expected exactly the bounded task tools');
  const listed = text(await client.callTool({ name: 'list_attachments', arguments: {} }));
  assert(listed.attachments.length === 1 && listed.attachments[0].id === image.id, 'Frozen input not visible over stdio');
  const viewed = await client.callTool({ name: 'view_attachment', arguments: { attachment_id: image.id } });
  assert(!viewed.isError, 'Image tool failed');
  const imageBlock = (viewed.content as any[]).find(item => item.type === 'image');
  assert(imageBlock?.mimeType === 'image/png' && Buffer.from(imageBlock.data, 'base64').length <= 256 * 1024, 'Expected bounded native MCP image');
  assert((await sharp(Buffer.from(imageBlock.data, 'base64')).metadata()).format === 'png', 'Preview must be decodable');
  const bytes = Buffer.from('Packaged runtime verified without model calls.\n');
  writeFileSync(join(bridge.agentConfig.context.outputDirectory, 'report.txt'), bytes);
  const publish = { name: 'add_attachment', arguments: { path: 'report.txt', mime: 'text/plain', caption: 'Runtime evidence', idempotency_key: 'publish_report' } };
  const published = text(await client.callTool(publish));
  assert(text(await client.callTool(publish)).attachment.id === published.attachment.id, 'Publication retry must be idempotent');
  const comment = text(await client.callTool({ name: 'add_comment', arguments: { body: 'Verified files attached.', attachment_ids: [published.attachment.id], idempotency_key: 'publish_comment' } }));
  assert(comment.comment_id, 'Agent comment missing');
  const detail = store.detail(task.id);
  assert(detail.attachments?.some(file => file.id === published.attachment.id && file.source === 'agent' && file.runId === run.id), 'Agent file attribution missing');
  assert(Buffer.from(store.readAttachment(task.id, published.attachment.id).data).equals(bytes), 'Published bytes changed');
  await client.close(); client = undefined;
  bridge.close();
  const stale = await bridge.dispatch({ capability: bridge.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: 'old', tool: 'list_attachments', arguments: {} });
  assert(stale.isError, 'Closed bridge accepted a stale call');
  store.close(); store = new Store(database);
  assert(Buffer.from(store.readAttachment(task.id, image.id).data).equals(original), 'Original image did not persist across reopening the DB');
  assert(Buffer.from(store.readAttachment(task.id, published.attachment.id).data).equals(bytes), 'Agent output did not persist across reopening the DB');
  console.log('PASS: packaged sharp, initialized SDK client ↔ bundled stdio ↔ private task broker, native image, agent file/comment, idempotency, revocation and original-byte persistence. No model calls.');
} finally {
  await client?.close();
  bridge?.close();
  store.close();
  rmSync(folder, { recursive: true, force: true });
}
