/** Ephemeral stdio MCP transport only. No database path, Store, HTTP, or user config. */
import { createConnection } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MAX_TASK_REQUEST_BYTES, MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_TOTAL_BYTES, MAX_TASK_TOOL_CALLS, TASK_MCP_DEFINITIONS, type TaskToolResult } from './task-mcp-protocol';

const socketPath = process.env.BRIGD_TASK_SOCKET;
const capability = process.env.BRIGD_TASK_CAPABILITY;
if (!socketPath || !capability || !/^[a-f0-9]{64}$/.test(capability)) process.exit(1);
// Do not accidentally pass the credential into any future helper descendants.
delete process.env.BRIGD_TASK_SOCKET;
delete process.env.BRIGD_TASK_CAPABILITY;
let calls = 0, totalBytes = 0;
const failure = (): TaskToolResult => ({ isError: true, content: [{ type: 'text', text: 'Task attachment capability is unavailable or expired. Stop using this task bridge.' }] });

async function forward(tool: string, args: unknown): Promise<TaskToolResult> {
  const wire = JSON.stringify({ capability, requestId: crypto.randomUUID(), tool, arguments: args }) + '\n';
  if (Buffer.byteLength(wire) > MAX_TASK_REQUEST_BYTES) return { isError: true, content: [{ type: 'text', text: 'Task tool request exceeds the size limit.' }] };
  return new Promise(resolve => {
    let pending = Buffer.alloc(0), settled = false;
    const done = (result: TaskToolResult) => { if (settled) return; settled = true; socket.destroy(); resolve(result); };
    const socket = createConnection({ path: socketPath! });
    socket.setTimeout(15_000);
    socket.on('connect', () => socket.write(wire));
    socket.on('timeout', () => done(failure()));
    socket.on('error', () => done(failure()));
    socket.on('close', () => done(failure()));
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (pending.byteLength > MAX_TASK_RESULT_BYTES) return done(failure());
      const newline = pending.indexOf(10);
      if (newline === -1) return;
      try {
        const result = JSON.parse(pending.subarray(0, newline).toString('utf8'));
        if (!result || !Array.isArray(result.content)) return done(failure());
        done(result);
      } catch { done(failure()); }
    });
  });
}
const server = new Server({ name: 'brigd-task', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TASK_MCP_DEFINITIONS }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (++calls > MAX_TASK_TOOL_CALLS || totalBytes >= MAX_TASK_RESULT_TOTAL_BYTES) {
    // The terminal response is bounded; closing prevents an endless stream of errors.
    setTimeout(() => { void server.close(); process.exit(0); }, 20);
    return failure();
  }
  const result = await forward(request.params.name, request.params.arguments ?? {});
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (totalBytes + bytes > MAX_TASK_RESULT_TOTAL_BYTES) {
    totalBytes = MAX_TASK_RESULT_TOTAL_BYTES;
    return failure();
  }
  totalBytes += bytes;
  return result;
});
const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_TASK_REQUEST_BYTES });
transport.onerror = () => { void server.close(); process.exitCode = 1; };
await server.connect(transport);
