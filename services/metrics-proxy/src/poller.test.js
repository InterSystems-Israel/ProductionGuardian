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
