import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, runFence } from '../server/store';
import { prepareAttachment } from '../server/attachments';
import { createTaskBridge } from '../server/task-mcp';
import { TASK_MCP_TOOLS, type TaskAttachmentContext } from '../server/task-mcp-protocol';

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
  store.setSession(run.id, 'runtime-original-session');
  store.finish(run.id, 'completed', 'Original result remains immutable.', null);
  const originalRun = JSON.stringify(store.getRun(run.id));
  const extra = store.stageAttachment(await prepareAttachment(Buffer.from('Follow-up input'), 'text/plain', 'followup.txt'));
  const unrelated = store.stageAttachment(await prepareAttachment(Buffer.from('Unrelated later note'), 'text/plain', 'unrelated.txt'));
  store.comment(task.id, null, 'user', 'An ordinary note must not become execution input.', Date.now(), undefined, [unrelated.id]);
  const intent = { sourceRunId: run.id, sourceStepIndex: null, body: 'Review the attached follow-up.', attachmentIds: [extra.id], requestId: crypto.randomUUID() };
  const followup = store.startFollowup(task.id, intent).run;
  assert(followup.sessionId === 'runtime-original-session' && followup.trigger === 'followup', 'Follow-up lost the exact session');
  assert(store.startFollowup(task.id, intent).run.id === followup.id, 'Follow-up submission retry duplicated a run');
  bridge = createTaskBridge(store, followup, runFence(followup));
  client = new Client({ name: 'brigd-followup-packaged-check', version: '1' });
  await client.connect(new StdioClientTransport({ command: bridge.agentConfig.command, args: bridge.agentConfig.args,
    env: { PATH: process.env.PATH ?? '', ...bridge.agentConfig.env }, stderr: 'pipe' }));
  const followupInputs = text(await client.callTool({ name: 'list_attachments', arguments: {} })).attachments;
  assert(JSON.stringify(followupInputs.map((file: any) => file.id).sort()) === JSON.stringify([image.id, published.attachment.id, extra.id].sort()), 'Follow-up stdio input scope must preserve source files and exclude unrelated notes');
  assert(text(await client.callTool({ name: 'read_attachment', arguments: { attachment_id: extra.id } })), 'Follow-up attachment read failed');
  assert((await client.callTool({ name: 'read_attachment', arguments: { attachment_id: unrelated.id } })).isError, 'Follow-up read unrelated note attachment');
  const followupBytes = Buffer.from('Additional request verified');
  writeFileSync(join(bridge.agentConfig.context.outputDirectory, 'followup-result.txt'), followupBytes);
  const followupOutput: TaskAttachmentContext = text(await client.callTool({ name: 'add_attachment', arguments: { path: 'followup-result.txt', mime: 'text/plain', caption: 'Follow-up result', idempotency_key: 'followup_output' } })).attachment;
  // The MCP receipt deliberately contains only bounded file context. Attribution
  // belongs to persisted metadata, so verify the exact ID returned over stdio.
  const followupRecord = store.getAttachment(task.id, followupOutput.id);
  assert(followupRecord.runId === followup.id && followupRecord.runId !== run.id && followupRecord.source === 'agent', 'Follow-up output attributed to wrong run');
  const followupComment = store.detail(task.id).comments.find(comment => comment.id === followupRecord.commentId);
  assert(followupComment?.runId === followup.id && followupComment.body === 'Follow-up result' && followupComment.attachments?.some(file => file.id === followupOutput.id), 'Follow-up output comment attribution missing');
  assert(Buffer.from(store.readAttachment(task.id, followupOutput.id).data).equals(followupBytes), 'Follow-up output bytes changed');
  await client.close(); client = undefined;
  bridge.close();
  store.finish(followup.id, 'completed', 'Follow-up completed.', null);
  assert(JSON.stringify(store.getRun(run.id)) === originalRun, 'Follow-up overwrote original completed history');
  store.close(); store = new Store(database);
  assert(Buffer.from(store.readAttachment(task.id, image.id).data).equals(original), 'Original image did not persist across reopening the DB');
  assert(Buffer.from(store.readAttachment(task.id, published.attachment.id).data).equals(bytes), 'Agent output did not persist across reopening the DB');
  assert(store.getAttachment(task.id, followupOutput.id).runId === followup.id && Buffer.from(store.readAttachment(task.id, followupOutput.id).data).equals(followupBytes), 'Follow-up output attribution or bytes did not persist across reopening the DB');
  assert(store.getRun(followup.id).sessionId === 'runtime-original-session' && store.getRun(followup.id).followup?.sourceRunId === run.id, 'Follow-up lineage did not persist');
  assert(store.startFollowup(task.id, intent).run.id === followup.id, 'Follow-up retry after database reopen duplicated a run');
  assert(JSON.stringify(store.getRun(run.id)) === originalRun, 'Database reopen changed original result history');
  console.log('PASS: packaged sharp, initialized SDK client ↔ bundled stdio ↔ private task broker, native image, agent file/comment, idempotency, revocation, exact-session follow-up scoped inputs/output attribution and immutable history persistence. No model calls.');
} finally {
  await client?.close();
  bridge?.close();
  store.close();
  rmSync(folder, { recursive: true, force: true });
}
