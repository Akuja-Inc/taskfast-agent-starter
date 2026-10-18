// Loopback-only synthetic console fixture. No agents, stores, wallets or model calls.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { buildTimeline } from '../../dist/src/core/timeline.js';

let pageModule = '../../dist/src/console-page.js';
if (process.env.BEFORE_REF) {
  const source = execFileSync('git', ['show', `${process.env.BEFORE_REF}:src/console-page.ts`], { encoding: 'utf8' });
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
  writeFileSync(new URL('../../dist/src/poll-folds-before.js', import.meta.url), outputText);
  pageModule = '../../dist/src/poll-folds-before.js';
}
const { PAGE } = await import(pageModule);
const token = 'a'.repeat(64); // Synthetic fixture value, not a real console token.
const start = Date.now() - 31 * 900_000;
const poll = (index, { pending = false, error = false, changed = false, reply } = {}) => {
  const id = `read-${index}`, timestamp = start + index * 900_000;
  return [
    { role: 'user', content: 'Check your marketplace work in your worker role.', timestamp },
    fauxAssistantMessage([fauxToolCall('task_list', { kind: 'open' }, { id })], { stopReason: 'toolUse' }),
    ...(!pending ? [
      { role: 'toolResult', toolCallId: id, toolName: 'task_list', content: [{ type: 'text', text: error ? '{"error":"Request timed out"}' : JSON.stringify({ tasks: changed ? [{ id: 'new-task', title: 'New editing work', status: 'open' }] : [] }) }], isError: error, timestamp: timestamp + 500 },
      fauxAssistantMessage(reply ?? (error ? 'The check failed. Current open jobs are unknown.' : changed ? 'New editing work is available. I will review it before bidding.' : 'No suitable open jobs. No action taken.')),
    ] : []),
  ];
};
let scenario = 'base';
const history = () => {
  const messages = [0, 1, 2, 3].flatMap((i) => poll(i));
  if (scenario === 'grow') messages.push(...poll(4));
  if (scenario === 'pending') messages.push(...poll(4, { pending: true }));
  if (scenario === 'failed') messages.push(...poll(4, { error: true }));
  if (scenario === 'changed') messages.push(...poll(4, { changed: true }));
  if (scenario === 'novel') messages.push(...poll(4, { reply: 'No suitable open jobs. Please check my spending limits before tomorrow.' }));
  if (scenario === 'history') return buildTimeline(Array.from({ length: 30 }, (_, i) => poll(i)).flat());
  if (scenario === 'evidence') {
    messages.push({ role: 'user', content: 'Marketplace event:\n{"event":"message_received","task_id":"launch-email","content":"Please keep the original subject line."}', timestamp: start + 4 * 900_000 });
    messages.push(fauxAssistantMessage('The client has requested a change. I am checking the delivery before responding.'));
    messages.push(...poll(5, { error: true }));
  }
  return buildTimeline(messages);
};
const view = (id) => ({
  id, env: 'local', spec: {
    role: 'worker', model: 'faux:test', instructions: 'Synthetic editorial agent. No marketplace work runs.',
    dials: { temperament: 'patient', competence: .9, diligence: .95, priceSensitivity: .5 },
    limits: { perJobUsd: 20, dailyUsd: 50 },
  },
  operator: { paused: false, frozen: false, messages: [], orders: [] }, queuedMessages: [],
  events: {}, attention: [], timeline: id === 'editor' ? history() : buildTimeline([poll(0), poll(1)].flat()), actions: {}, spend: {}, notes: [],
  prompt: 'Synthetic worker. No model or marketplace calls.',
  host: { unlockFile: false, stream: 'connected', tasks: {}, pollIntervalMs: 900_000 },
});
const clients = new Map();
const server = createServer(async (req, res) => {
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.headers.authorization !== `Bearer ${token}`) { json(401, { error: 'synthetic token required' }); return; }
  if (req.url.startsWith('/fixture/scenario/') && req.method === 'POST') {
    scenario = req.url.split('/').at(-1);
    if (!['base', 'grow', 'pending', 'failed', 'changed', 'novel', 'history', 'evidence'].includes(scenario)) { json(400, { error: 'unknown scenario' }); return; }
    for (const [client, id] of clients) client.write(`event: view\ndata: ${JSON.stringify(view(id))}\n\n`);
    json(200, { scenario }); return;
  }
  if (req.url === '/api/agents') { json(200, { env: 'local', agents: ['editor', 'sibling'].map((id) => ({ id, role: 'worker', state: 'ready', generation: 1 })) }); return; }
  const match = /^\/api\/agents\/(editor|sibling)(\/stream)?$/.exec(req.url);
  if (!match) { json(404, { error: 'unknown fixture route' }); return; }
  const [, id, stream] = match;
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: view\ndata: ${JSON.stringify(view(id))}\n\n`);
    clients.set(res, id);
    res.on('close', () => clients.delete(res));
  } else json(200, view(id));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/#token=${token}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
