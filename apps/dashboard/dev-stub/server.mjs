/**
 * THROWAWAY — delete this directory once Dev B's findings API is up.
 *
 * Serves the two contract endpoints on :3002 from the same fixtures the
 * dashboard's demo mode uses, so `?mode=live` exercises the real fetch path
 * (HTTP, JSON parsing, error handling, backoff) rather than a simulated one.
 * Sanctioned by `apps/dashboard/CLAUDE.md` §8, task 2.
 *
 *   node dev-stub/server.mjs                 # healthy fixture, cycles scenarios
 *   node dev-stub/server.mjs --fail          # always 503, to test degradation
 *   node dev-stub/server.mjs --scenario=dead-host
 *
 * Node's built-in http only — no dependency, since this file is temporary.
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = 3002;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const args = process.argv.slice(2);
const alwaysFail = args.includes('--fail');
const pinned = args.find((a) => a.startsWith('--scenario='))?.split('=')[1];

/** Same progression as the mock client, so live and demo tell one story. */
const PROGRESSION = [
  'healthy',
  'queue-buildup',
  'slow-processing',
  'error-storm',
  'dead-host',
  'healthy',
];

let step = 0;

async function loadScenario(id) {
  const raw = await readFile(join(FIXTURES, `scenario-${id}.json`), 'utf8');
  return JSON.parse(raw);
}

/** Fixture offsets → absolute ISO, exactly as the real engine would emit. */
function resolve(scenario) {
  const now = Date.now();
  return {
    hosts: scenario.hosts.map(({ lastActivitySecondsAgo, ...host }) => ({
      ...host,
      lastActivity: new Date(now - lastActivitySecondsAgo * 1000).toISOString(),
    })),
    findings: scenario.findings.map(({ detectedSecondsAgo, ...finding }) => ({
      ...finding,
      detectedAt: new Date(now - detectedSecondsAgo * 1000).toISOString(),
    })),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS, so the stub also works when hit directly rather than through the
  // Vite proxy. CONTRACT-Q9 — Dev B may or may not do this.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (alwaysFail) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'stub is in --fail mode' }));
    console.log(`503  ${url.pathname}  (--fail)`);
    return;
  }

  const isHosts = url.pathname === '/api/healthscan/hosts';
  const isFindings = url.pathname === '/api/healthscan/findings';

  if (!isHosts && !isFindings) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  try {
    const id = pinned ?? PROGRESSION[step % PROGRESSION.length];
    const resolved = resolve(await loadScenario(id));
    // Advance after findings so a hosts/findings pair stays consistent.
    if (!pinned && isFindings) step += 1;

    const body = isHosts ? resolved.hosts : resolved.findings;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    console.log(`200  ${url.pathname}  ${id}  (${body.length} items)`);
  } catch (cause) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(cause) }));
    console.error(`500  ${url.pathname}`, cause);
  }
});

server.listen(PORT, async () => {
  const available = (await readdir(FIXTURES))
    .filter((f) => f.startsWith('scenario-'))
    .map((f) => f.replace('scenario-', '').replace('.json', ''));

  console.log(`Health Scan API stub on http://localhost:${PORT}`);
  console.log(`  mode:      ${alwaysFail ? '--fail (503s)' : pinned ? `pinned to ${pinned}` : 'cycling progression'}`);
  console.log(`  scenarios: ${available.join(', ')}`);
  console.log(`  open:      http://localhost:5173/?mode=live`);
});
