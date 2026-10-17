// Synthetic browser fixture only. No agent folders, wallets, stores, providers or network services.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { parseAgentSpec } from '../../dist/src/core/spec.js';

let pageModule = '../../dist/src/console-page.js';
if (process.env.BEFORE_REF) {
  const source = execFileSync('git', ['show', `${process.env.BEFORE_REF}:src/console-page.ts`], { encoding: 'utf8' });
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
  writeFileSync(new URL('../../dist/src/polling-before.js', import.meta.url), outputText);
  pageModule = '../../dist/src/polling-before.js';
}
const { PAGE } = await import(pageModule);
const token = 'a'.repeat(64); // Invented fixture token, not a running agent's token.
const specs = new Map(['editor', 'sibling'].map((id) => [id, {
  role: 'worker', model: 'faux:test',
  instructions: 'You are a synthetic copy editor used only to demonstrate the Briefing page. No marketplace work runs in this fixture.',
  dials: { temperament: 'patient', competence: .9, diligence: .95, priceSensitivity: .5 },
  limits: { perJobUsd: 20, dailyUsd: 50 },
  ...(id === 'sibling' ? { pollIntervalMinutes: 2 } : {}),
}]));
const requests = [];
const view = (id) => ({
  id, env: 'local', spec: specs.get(id),
  operator: { paused: false, frozen: false, messages: [], orders: [] }, queuedMessages: [],
  events: {}, attention: [], timeline: [], actions: {}, spend: {}, notes: [],
  prompt: 'Synthetic worker. No model or marketplace calls.',
  host: { unlockFile: false, stream: 'connected', tasks: {}, pollIntervalMs: (specs.get(id).pollIntervalMinutes ?? 15) * 60_000 },
});
const server = createServer(async (req, res) => {
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(data)); };
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.url === '/fixture/requests') { json(200, requests); return; }
  if (req.headers.authorization !== `Bearer ${token}`) { json(401, { error: 'synthetic token required' }); return; }
  if (req.url === '/api/agents') { json(200, { env: 'local', agents: [...specs.keys()].map((id) => ({ id, role: 'worker', state: 'ready', generation: 1 })) }); return; }
  const match = /^\/api\/agents\/([^/]+)(.*)$/.exec(req.url);
  if (!match || !specs.has(match[1])) { json(404, { error: 'unknown fixture agent' }); return; }
  const [, id, action] = match;
  if (action === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: view\ndata: ${JSON.stringify(view(id))}\n\n`);
    return;
  }
  if (!action) { json(200, view(id)); return; }
  if (req.method === 'PUT' && action === '/spec') {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ id, action, body: JSON.parse(text) });
    try { specs.set(id, parseAgentSpec(JSON.parse(text))); json(204); }
    catch (error) { json(400, { error: error.message }); }
    return;
  }
  json(404, { error: 'unsupported fixture request' });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/#token=${token}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
