// Synthetic browser fixture only. No agent folders, wallets, stores, providers or network services.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';

let pageModule = '../../dist/src/console-page.js';
if (process.env.BEFORE_REF) {
  const source = execFileSync('git', ['show', `${process.env.BEFORE_REF}:src/console-page.ts`], { encoding: 'utf8' });
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
  writeFileSync(new URL('../../dist/src/follow-scroll-before.js', import.meta.url), outputText);
  pageModule = '../../dist/src/follow-scroll-before.js';
}
const { PAGE } = await import(pageModule);
const token = 'a'.repeat(64); // Invented fixture token, not a running agent's token.
const spec = {
  role: 'worker', model: 'faux:test',
  instructions: 'You are a synthetic copy editor used only to demonstrate timeline scrolling. No marketplace work runs in this fixture.',
  dials: { temperament: 'patient', competence: .9, diligence: .95, priceSensitivity: .5 },
  limits: { perJobUsd: 20, dailyUsd: 50 },
};
// Every reply fills most of a 1000px viewport, so a handful of turns overflow the page.
const paragraphs = (label) => Array.from({ length: 8 }, (_, i) => `${label} line ${i + 1}: the quick brown fox jumps over the lazy dog.`).join('\n');
let turnCount = 0;
const eventTurn = (id) => ({
  id, kind: 'event', at: 1_760_000_000_000 + turnCount++ * 60_000, text: 'Event ' + id,
  event: { event: 'task.ready' },
  replies: [{ text: paragraphs('Reply to ' + id), calls: [], tasks: [] }],
});
const timeline = Array.from({ length: 6 }, (_, i) => eventTurn('seed-' + i));
const streams = new Set();
const view = () => ({
  id: 'editor', env: 'local', spec,
  operator: { paused: false, frozen: false, messages: [], orders: [] }, queuedMessages: [],
  events: {}, attention: [], timeline, actions: {}, spend: {}, notes: [],
  prompt: 'Synthetic worker. No model or marketplace calls.',
  host: { unlockFile: false, stream: 'connected', tasks: {}, pollIntervalMs: 900_000 },
});
const publish = () => {
  const block = `event: view\ndata: ${JSON.stringify(view())}\n\n`;
  for (const res of streams) res.write(block);
};
const server = createServer(async (req, res) => {
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(data)); };
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.headers.authorization !== `Bearer ${token}`) { json(401, { error: 'synthetic token required' }); return; }
  if (req.url === '/api/agents') { json(200, { env: 'local', agents: [{ id: 'editor', role: 'worker', state: 'ready', generation: 1 }] }); return; }
  if (req.url === '/fixture/push' && req.method === 'POST') {
    timeline.push(eventTurn('push-' + timeline.length));
    publish();
    json(204);
    return;
  }
  const match = /^\/api\/agents\/editor(\/.*)?$/.exec(req.url);
  if (!match) { json(404, { error: 'unknown fixture agent' }); return; }
  const action = match[1] || '';
  if (action === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    streams.add(res);
    res.write(`event: view\ndata: ${JSON.stringify(view())}\n\n`);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (!action) { json(200, view()); return; }
  if (action === '/messages' && req.method === 'POST') {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    // An admitted follow-up becomes the operator's own turn, as the real host records it.
    timeline.push({ id: 'sent-' + body.requestId, kind: 'operator', at: 1_760_000_000_000 + turnCount++ * 60_000, text: body.text, replies: [] });
    publish();
    json(204);
    return;
  }
  json(404, { error: 'unsupported fixture request' });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/#token=${token}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
