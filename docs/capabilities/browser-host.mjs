// Synthetic local proof only. No real agent files, accounts, keys or marketplace.
// KIT_BUILD_ROOT selects a built baseline for before captures. All stores are temporary.
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
const root = resolve(process.env.KIT_BUILD_ROOT || '.');
const { runAgents } = await import(pathToFileURL(join(root, 'dist/src/run.js')));
const { openMarketplaceAgent } = await import(pathToFileURL(join(root, 'dist/src/core/agent.js')));
const dir = mkdtempSync(join(tmpdir(), 'capabilities-browser-'));
for (const [id, name] of [['editor', 'Editorial worker'], ['researcher', 'Research worker']]) {
  const folder = join(dir, id);
  mkdirSync(join(folder, '.taskfast'), { recursive: true });
  mkdirSync(join(folder, '.agents/skills/brief-writing'), { recursive: true });
  writeFileSync(join(folder, 'agent.json'), JSON.stringify({ role: 'worker', model: 'anthropic:claude-sonnet-4-6', dials: { temperament: 'patient', competence: .8, diligence: .9, priceSensitivity: .5 }, limits: { perJobUsd: 10, dailyUsd: 50 } }));
  writeFileSync(join(folder, 'INSTRUCTIONS.md'), `You are the ${name}. This is a synthetic local browser fixture. Do not contact any marketplace.\n`);
  writeFileSync(join(folder, '.taskfast/config.json'), '{}');
  writeFileSync(join(folder, '.agents/skills/brief-writing/SKILL.md'), '---\nname: brief-writing\ndescription: Write clear editorial briefs from the supplied task.\n---\nUse the existing marketplace tools. Never invent permissions.\n');
}
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());
try {
  await runAgents({
    agentsDir: dir, env: 'local', console: { port: 0 }, signal: stop.signal, pingEveryMs: 900_000,
    listen: () => ({ close: async () => {} }),
    command: async () => ({ outcome: 'ok', data: {} }),
    openAgent: async (options) => {
      const faux = fauxProvider({ models: [{ id: 'test' }] });
      const config = join(dir, options.id, 'mcp.json');
      const sourceRead = existsSync(config) && JSON.parse(readFileSync(config, 'utf8')).servers?.sources?.tools?.search;
      faux.setResponses(sourceRead ? [fauxAssistantMessage([fauxToolCall('mcp_sources_search', { query: 'editorial fixture reference' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Checked the local source fixture. No marketplace call was made.')] : [fauxAssistantMessage('Ready for the next editorial job. Synthetic local fixture only.')]);
      const models = createModels(); models.setProvider(faux.provider);
      return openMarketplaceAgent({ ...options, spec: { ...options.spec, model: 'faux:test' }, models, command: async (_runtime, args) => args[0] === 'me' ? { outcome: 'ok', data: { profile: { id: '33333333-3333-4333-8333-333333333333' } } } : { outcome: 'ok', data: {} } });
    },
    log: (line) => { if (line.startsWith('console: ')) process.stdout.write(line.slice(9) + '\n'); },
  });
} finally { rmSync(dir, { recursive: true, force: true }); }
