'use strict';

/**
 * poller.test.js — URL construction.
 *
 * IRIS_BASE_PATH exists because the monitor API is not always at the web server root.
 * On the instance this was verified against, the working URL is
 *   http://localhost/iris4health_2024_1/api/monitor/metrics
 * and requesting /api/monitor/metrics on port 80 returns the web server's 404 page,
 * which parses as zero metric lines — indistinguishable from an idle production.
 *
 * The path is built in a child process per case, because poller.js reads process.env
 * once at require time.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Start a throwaway HTTP server, point the poller at it with the given IRIS_BASE_PATH,
 * and return the request path the poller actually asked for.
 */
function requestedPath(basePath) {
  const script = `
    const http = require('http');
    const server = http.createServer((req, res) => {
      process.stdout.write(req.url);
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('iris_system_alerts_new 0\\n');
      server.close();
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.IRIS_HOST = '127.0.0.1';
      process.env.IRIS_PORT = String(server.address().port);
      const { irisGet } = require(${JSON.stringify(path.join(__dirname, 'poller.js'))});
      try { await irisGet('/api/monitor/metrics'); } catch (e) {}
    });
  `;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, IRIS_BASE_PATH: basePath },
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
}

/**
 * Start a throwaway server, let the poller run one metrics cycle against it, and return
 * every path it requested. The host-status endpoint is a SEPARATE web application, not
 * something under IRIS_BASE_PATH, so which prefix applies to which URL is the thing
 * most likely to be got wrong and the least visible when it is.
 */
function requestedPathsForCycle(env) {
  // The result is fenced in a sentinel because the poller logs to stdout itself, and
  // reported exactly once after pollMetrics resolves — awaiting it is what guarantees
  // both requests have been made, so no request-counting race is needed.
  const script = `
    const http = require('http');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url.includes('hoststatus')) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({hosts: [], _meta: {productionState: 'Running'}}));
      } else {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('iris_system_alerts_new 0\\n');
      }
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.IRIS_HOST = '127.0.0.1';
      process.env.IRIS_PORT = String(server.address().port);
      const { pollMetrics } = require(${JSON.stringify(path.join(__dirname, 'poller.js'))});
      await pollMetrics();
      process.stdout.write('<<<' + JSON.stringify(seen) + '>>>');
      server.close();
    });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return JSON.parse(out.slice(out.indexOf('<<<') + 3, out.lastIndexOf('>>>')));
}

describe('IRIS_HOSTSTATUS_PATH', () => {
  it('polls host status alongside metrics on the same cycle', () => {
    const paths = requestedPathsForCycle({ IRIS_BASE_PATH: '', IRIS_HOSTSTATUS_PATH: undefined });
    assert.ok(paths.includes('/api/monitor/metrics'));
    assert.ok(paths.includes('/labdemo/monitor/hoststatus'),
      `expected the default host-status path, got ${JSON.stringify(paths)}`);
  });

  it('does NOT prefix the host-status path with IRIS_BASE_PATH', () => {
    // The two live in different places: IRIS_BASE_PATH locates the instance's built-in
    // /api/monitor/ web app, while host status is its own CSP application. Prefixing it
    // would 404, and the failure is quiet — queued/errored simply stay null.
    const paths = requestedPathsForCycle({ IRIS_BASE_PATH: '/iris4health_2024_1' });
    assert.ok(paths.includes('/iris4health_2024_1/api/monitor/metrics'));
    assert.ok(paths.includes('/labdemo/monitor/hoststatus'));
    assert.ok(!paths.some(p => p.includes('/iris4health_2024_1/labdemo')),
      'the base path must not be applied to the host-status URL');
  });

  it('skips the host-status poll entirely when set empty', () => {
    // The honest configuration for an instance where the endpoint is not deployed.
    const paths = requestedPathsForCycle({ IRIS_BASE_PATH: '', IRIS_HOSTSTATUS_PATH: '' });
    assert.deepEqual(paths, ['/api/monitor/metrics']);
  });

  it('honours an overridden host-status path', () => {
    const paths = requestedPathsForCycle({
      IRIS_BASE_PATH: '', IRIS_HOSTSTATUS_PATH: '/custom/hoststatus',
    });
    assert.ok(paths.includes('/custom/hoststatus'));
  });
});

describe('IRIS_BASE_PATH', () => {
  it('requests the bare path when unset (private web server on 52773)', () => {
    assert.equal(requestedPath(''), '/api/monitor/metrics');
  });

  it('prefixes the instance path when set', () => {
    assert.equal(requestedPath('/iris4health_2024_1'), '/iris4health_2024_1/api/monitor/metrics');
  });

  it('tolerates a missing leading slash', () => {
    // Copying the segment out of a browser URL easily loses it.
    assert.equal(requestedPath('iris4health_2024_1'), '/iris4health_2024_1/api/monitor/metrics');
  });

  it('tolerates a trailing slash without doubling it', () => {
    // '//api/monitor/metrics' is a different path to most web servers and 404s.
    assert.equal(requestedPath('/iris4health_2024_1/'), '/iris4health_2024_1/api/monitor/metrics');
  });

  it('ignores surrounding whitespace from a hand-edited .env', () => {
    assert.equal(requestedPath('  /iris4health_2024_1  '), '/iris4health_2024_1/api/monitor/metrics');
  });
});
