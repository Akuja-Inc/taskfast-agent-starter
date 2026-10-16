// Synthetic browser-only fixture. No agent folders, stores, models or services.
// Run after pnpm build. Only loopback binds; all data and the token are invented.
import { createServer } from 'node:http';
import { PAGE } from '../../dist/src/console-page.js';

const token = 'a'.repeat(64);
const entries = [
  { id: 'slow-worker', role: 'worker', state: 'starting', phase: 'opening', generation: 1 },
  { id: 'failed-worker', role: 'worker', state: 'stopped', reason: 'MCP reference server did not complete its handshake. Check this folder’s mcp.json and retry.', generation: 1 },
  { id: 'healthy-worker', role: 'worker', state: 'ready', generation: 1 },
];
const view = (id) => ({
  id, operator: { paused: false, frozen: false, messages: [], orders: [] }, queuedMessages: [],
  events: {}, attention: [], timeline: [], actions: {}, spend: {}, notes: [], prompt: 'Synthetic worker.',
  spec: { role: 'worker', model: 'faux:test', instructions: 'Synthetic worker.', dials: { temperament: 'patient', competence: .5, diligence: .5, priceSensitivity: .5 }, limits: { perJobUsd: 10, dailyUsd: 50 } },
  host: { wallet: { balance: { available_balance: '50000000' } }, unlockFile: true, stream: 'connected', tasks: {} },
});
const requests = [];
const server = createServer(async (req, res) => {
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (req.url === '/fixture/requests') { json(200, requests); return; }
  if (req.headers.authorization !== 'Bearer ' + token) { json(401, { error: 'synthetic token required' }); return; }
  if (req.url === '/api/agents') { json(200, { env: 'local', agents: entries }); return; }
  const match = /^\/api\/agents\/([^/]+)(.*)$/.exec(req.url);
  const entry = match && entries.find((item) => item.id === decodeURIComponent(match[1]));
  if (!entry) { json(404, { error: 'unknown synthetic agent' }); return; }
  const action = match[2];
  if (action.startsWith('/startup/')) {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ id: entry.id, action, body: JSON.parse(body) });
    if (JSON.parse(body).generation !== entry.generation) { json(409, { error: 'stale generation' }); return; }
    // A delayed acknowledgement makes synchronous local busy feedback observable.
    setTimeout(() => {
      entry.generation++;
      if (action.endsWith('/retry')) { entry.state = 'starting'; entry.phase = 'waiting-for-close'; delete entry.reason; }
      else { entry.state = 'stopped'; entry.reason = 'Startup cancelled. Retry when you are ready.'; delete entry.phase; }
      json(202, { accepted: true });
    }, 500);
    return;
  }
  if (entry.state !== 'ready') { json(409, { error: 'agent is not ready' }); return; }
  if (action === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: view\ndata: ' + JSON.stringify(view(entry.id)) + '\n\n');
    return;
  }
  if (!action) { json(200, view(entry.id)); return; }
  requests.push({ id: entry.id, action });
  json(204, null);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/#token=${token}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
