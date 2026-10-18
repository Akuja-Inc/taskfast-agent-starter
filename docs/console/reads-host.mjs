// Synthetic browser fixture for the Settings captures. No agent folders, wallets, stores, providers or network services.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { marketplacePrompt } from '../../dist/src/core/prompt.js';

let pageModule = '../../dist/src/console-page.js';
if (process.env.BEFORE_REF) {
  const source = execFileSync('git', ['show', `${process.env.BEFORE_REF}:src/console-page.ts`], { encoding: 'utf8' });
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
  writeFileSync(new URL('../../dist/src/settings-before.js', import.meta.url), outputText);
  pageModule = '../../dist/src/settings-before.js';
}
const { PAGE } = await import(pageModule);
const token = 'a'.repeat(64); // Invented fixture token, not a running agent's token.
// The capture script replaces this through /fixture/state before each scenario.
let state = { orders: [], notes: [], limits: {} };
const spec = () => ({
  role: 'worker', model: 'faux:test',
  instructions: 'You are **Fernhill Editing**, a synthetic copy editor used only for these captures.\n\nWhat you want right now:\n- Win short copy-editing jobs\n- Keep every reply under 120 words',
  dials: { temperament: 'patient', competence: .9, diligence: .95, priceSensitivity: .5 },
  ...(Object.keys(state.limits).length ? { limits: state.limits } : {}),
});
const streams = new Set();
const view = () => ({
  id: 'editor', env: 'local', spec: spec(),
  operator: { paused: false, frozen: false, messages: [], orders: state.orders }, queuedMessages: [],
  events: {}, attention: [], timeline: [], actions: {}, spend: {}, notes: state.notes,
  prompt: marketplacePrompt(spec(), state.notes, state.orders),
  host: { unlockFile: false, stream: 'connected', tasks: {}, pollIntervalMs: 900_000 },
});
const publish = () => {
  const block = `event: view\ndata: ${JSON.stringify(view())}\n\n`;
  for (const res of streams) res.write(block);
};
const server = createServer(async (req, res) => {
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(data)); };
  if (req.url === '/' || req.url.startsWith('/agents/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.headers.authorization !== `Bearer ${token}`) { json(401, { error: 'synthetic token required' }); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  // A quiet change stands for another tab's edit the page has not seen yet.
  if (req.url.startsWith('/fixture/state') && req.method === 'POST') { state = { orders: [], notes: [], limits: {}, ...body }; if (!req.url.endsWith('?quiet')) publish(); json(204); return; }
  if (req.url === '/api/agents') { json(200, { env: 'local', agents: [{ id: 'editor', role: 'worker', state: 'ready', generation: 1 }] }); return; }
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
  if (action === '/orders' && req.method === 'POST') { state.orders = [...state.orders, body.text]; publish(); json(204); return; }
  // Note writes wait as the real host does while a turn runs, long enough to capture the wait.
  if (action.startsWith('/notes') && req.headers['x-fixture-hold']) await new Promise((resolve) => setTimeout(resolve, 3000));
  if (action === '/notes' && req.method === 'POST') { state.notes = [...state.notes, body.text]; publish(); json(204); return; }
  const note = /^\/notes\/(\d+)$/.exec(action);
  if (note && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (state.notes[note[1]] !== body.expect) { publish(); json(409, { error: 'notes changed; refresh' }); return; }
    state.notes = req.method === 'PUT' ? state.notes.map((text, at) => at === Number(note[1]) ? body.text : text) : state.notes.filter((_, at) => at !== Number(note[1]));
    publish(); json(204); return;
  }
  const order = /^\/orders\/(\d+)$/.exec(action);
  if (order && req.method === 'PUT') {
    if (state.orders[order[1]] !== body.expect) { publish(); json(409, { error: 'orders changed; refresh' }); return; }
    state.orders = state.orders.map((text, at) => at === Number(order[1]) ? body.text : text); publish(); json(204); return;
  }
  if (order && req.method === 'DELETE') {
    // The real stream delivers the other change too, so a refusal publishes the current list.
    if (state.orders[order[1]] !== body.expect) { publish(); json(409, { error: 'orders changed; refresh' }); return; }
    state.orders = state.orders.filter((_, at) => at !== Number(order[1])); publish(); json(204); return;
  }
  json(404, { error: 'unsupported fixture request' });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/agents/editor?tab=settings#token=${token}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
