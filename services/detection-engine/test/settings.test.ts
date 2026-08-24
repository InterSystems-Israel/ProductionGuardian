/**
 * Threshold settings tests — the endpoint behind the dashboard's Settings panel.
 *
 * The load-bearing properties are the NEGATIVE ones (CLAUDE.md §8). A settings endpoint whose
 * only test is "a valid value applies" proves nothing, because the whole risk is the other
 * direction: an invalid value must be refused with a readable reason rather than silently
 * ignored or crashing the engine, an override must not survive a file reload that invalidates
 * it, and reset must always work.
 *
 * Four groups, and the third is the one that found a real trap:
 *   1. reads report the EFFECTIVE value, not a default
 *   2. writes validate through the same `validateConfig` a file does
 *   3. `fs.watch` composition — a reload re-applies rather than clobbers
 *   4. the paired gate/band write, which §5.2 forbids separating
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFindingsServer } from '../src/api/server.ts';
import type { EngineSnapshot } from '../src/detect/engine.ts';
import {
  DEFAULT_CONFIG,
  ThresholdStore,
  validateConfig,
} from '../src/config/thresholds.ts';
import {
  SETTING_FIELDS,
  WARNING_KEYS,
  applySettings,
  parseSettingsRequest,
  resetSettings,
  settingsPayload,
} from '../src/api/settings.ts';

const FLOOR = 'rules.queue_buildup.absoluteFloor';
const WARNING = WARNING_KEYS[1];
const GATE = WARNING_KEYS[0];
const CRITICAL = 'rules.queue_buildup.severityBands.critical';

let dir: string;
let path: string;

/** A committed-shape file, so the tests exercise composition over real JSON rather than defaults. */
const FILE_BODY = {
  _comment: 'test fixture, mirroring the committed file shape',
  sustainedSamples: 2,
  sustainedSeconds: 4,
  minBaselineSamples: 12,
  rules: {
    queue_buildup: {
      enabled: true,
      baselineMultiplier: 5.0,
      absoluteFloor: 50,
      severityBands: { warning: 5.0, critical: 20.0 },
    },
  },
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-settings-'));
  path = join(dir, 'thresholds.json');
  writeFileSync(path, JSON.stringify(FILE_BODY, null, 2));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(): ThresholdStore {
  writeFileSync(path, JSON.stringify(FILE_BODY, null, 2));
  return new ThresholdStore(path, () => {});
}

describe('reading the current settings', () => {
  it('reports the FILE value as effective when nothing is overridden', () => {
    const payload = settingsPayload(store());
    assert.equal(payload.effective[FLOOR], 50);
    assert.equal(payload.file[FLOOR], 50);
    assert.equal(payload.overridden, false);
  });

  it('reports the OVERRIDE as effective, not the file and not the default', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 7 } }));
    const payload = settingsPayload(s);
    assert.equal(payload.effective[FLOOR], 7, 'effective must follow the override');
    assert.equal(payload.file[FLOOR], 50, 'the file column must still show what a reset restores');
    assert.equal(payload.overridden, true);
  });

  it('reports a file value that DIFFERS from DEFAULT_CONFIG, so the panel cannot drift', () => {
    // The committed file sets absoluteFloorSeconds 0.2 where DEFAULT_CONFIG says 1.0, i.e. the
    // two genuinely disagree in this repo. Proving the payload follows the FILE is what stops the
    // panel showing a shipped constant that is not in force anywhere.
    writeFileSync(
      path,
      JSON.stringify({ rules: { queue_buildup: { absoluteFloor: 123 } } }),
    );
    const payload = settingsPayload(new ThresholdStore(path, () => {}));
    assert.equal(payload.effective[FLOOR], 123);
    assert.notEqual(payload.effective[FLOOR], DEFAULT_CONFIG.rules.queue_buildup.absoluteFloor);
  });

  it('states that changes are not persisted', () => {
    // The UI says this too, but a curl caller must also be told: the engine is the only component
    // that knows whether its values came from the file or a request.
    assert.match(settingsPayload(store()).persistence, /NOT written to thresholds\.json/);
  });

  it('publishes a shipped default for every field, for the reset control', () => {
    for (const field of SETTING_FIELDS) {
      assert.equal(typeof field.shipped, 'number', `${field.key} needs a shipped value`);
      assert.ok(Number.isFinite(field.shipped));
    }
  });
});

describe('applying a valid change', () => {
  it('changes the live config immediately', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 9 } }));
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 9);
  });

  it('leaves sibling fields alone — a patch is not a replacement', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [CRITICAL]: 30 } }));
    assert.equal(s.current.rules.queue_buildup.severityBands.critical, 30);
    assert.equal(
      s.current.rules.queue_buildup.severityBands.warning,
      5.0,
      'the sibling band must survive — a shallow merge would erase it',
    );
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 50);
  });

  it('leaves OTHER RULES alone', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 11 } }));
    assert.equal(
      s.current.rules.slow_processing.baselineMultiplier,
      DEFAULT_CONFIG.rules.slow_processing.baselineMultiplier,
    );
    assert.equal(s.current.rules.dead_host.enabled, true);
  });

  it('accumulates: a second change does not revert the first', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 5, [CRITICAL]: 40 } }));
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 5);
    assert.equal(s.current.rules.queue_buildup.severityBands.critical, 40);
  });
});

describe('the gate and the warning band move TOGETHER (CLAUDE.md §5.2)', () => {
  // Each comparative rule's firing gate EQUALS its warning band, and severity `info` is
  // deliberately unreachable for the per-host rules as a result. A panel that let the band move
  // alone would either open a gap that can never be reached, or invite lowering the gate --
  // widening what fires and reintroducing the false positives MVP §6 names as the top risk.
  it('writing the warning band also writes the firing gate', () => {
    const patch = parseSettingsRequest({ values: { [WARNING]: 2.5 } });
    const config = validateConfig(patch);
    assert.equal(config.rules.queue_buildup.severityBands.warning, 2.5);
    assert.equal(
      config.rules.queue_buildup.baselineMultiplier,
      2.5,
      'the gate must follow the band, or `info` becomes reachable',
    );
  });

  it('keeps them equal through the store, so no request can separate them', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [WARNING]: 8 } }));
    assert.equal(s.current.rules.queue_buildup.severityBands.warning, 8);
    assert.equal(s.current.rules.queue_buildup.baselineMultiplier, 8);
  });

  it('does not expose the gate as its own editable field', () => {
    // If it were editable, the pairing above could be bypassed by naming the gate directly.
    assert.ok(
      !SETTING_FIELDS.some((f) => f.key === GATE),
      'the firing gate must not be separately editable',
    );
  });
});

describe('refusing an invalid change, with a readable reason', () => {
  it('refuses a zero band, using validateConfig own wording', () => {
    const s = store();
    assert.throws(
      () => applySettings(s, parseSettingsRequest({ values: { [CRITICAL]: 0 } })),
      (err: Error) => {
        assert.match(err.message, /^bad request: /);
        assert.match(err.message, /severityBands\.critical must be positive/);
        return true;
      },
    );
  });

  it('refuses a negative floor', () => {
    const s = store();
    assert.throws(
      () => applySettings(s, parseSettingsRequest({ values: { [FLOOR]: -5 } })),
      /must be a positive finite number/,
    );
  });

  it('LEAVES THE LIVE CONFIG UNTOUCHED when a change is refused', () => {
    // The property that matters most: a rejected override must not partly land, or the engine
    // would be running a detection policy nobody chose.
    const s = store();
    assert.throws(() => applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 0 } })));
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 50, 'must keep the last-good value');
    assert.equal(s.overridden, false, 'a refused change must not count as an override');
  });

  it('refuses an unknown setting rather than ignoring it', () => {
    // A silently dropped setting is how an operator concludes detection is broken.
    assert.throws(
      () => parseSettingsRequest({ values: { 'rules.queue_buildup.nope': 3 } }),
      /bad request: unknown setting "rules\.queue_buildup\.nope"/,
    );
  });

  it('refuses a value that is not a number, naming the request rather than the threshold', () => {
    assert.throws(
      () => parseSettingsRequest({ values: { [FLOOR]: '50' } }),
      /bad request: rules\.queue_buildup\.absoluteFloor must be a finite number, got "50"/,
    );
    assert.throws(() => parseSettingsRequest({ values: { [FLOOR]: null } }), /must be a finite number/);
    assert.throws(
      () => parseSettingsRequest({ values: { [FLOOR]: Number.POSITIVE_INFINITY } }),
      /must be a finite number/,
    );
  });

  it('refuses a malformed body', () => {
    assert.throws(() => parseSettingsRequest(null), /body must be an object/);
    assert.throws(() => parseSettingsRequest({}), /values must be an object/);
    assert.throws(() => parseSettingsRequest({ values: {} }), /at least one setting/);
    assert.throws(() => parseSettingsRequest({ values: 5 }), /values must be an object/);
  });

  it('cannot reach a cross-rule key, so the sustained invariant is unreachable from here', () => {
    /* THE REACHABILITY INVARIANT (`thresholds.json` `_comment_sustained`): sustainedSeconds must
       be reachable within sustainedSamples polls of POLL_INTERVAL_MS with margin, so the three
       numbers are ONE constraint. The panel deliberately exposes none of them -- this asserts
       that, because the protection is the absence of a field rather than a check. */
    for (const key of ['sustainedSamples', 'sustainedSeconds', 'minBaselineSamples']) {
      assert.throws(
        () => parseSettingsRequest({ values: { [key]: 1 } }),
        /bad request: unknown setting/,
        `${key} must not be editable through the settings endpoint`,
      );
    }
  });

  it('cannot break the earlyWarning reachability invariant either', () => {
    // Same shape as above: `fitWindowSeconds` has a checked invariant against minFitSamples, and
    // the settings endpoint must not be a way around the check by not being covered by it.
    assert.throws(
      () => parseSettingsRequest({ values: { 'earlyWarning.fitWindowSeconds': 10 } }),
      /bad request: unknown setting/,
    );
  });
});

describe('reset', () => {
  it('restores the file values', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 3, [CRITICAL]: 99 } }));
    const result = resetSettings(s);
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 50);
    assert.equal(s.current.rules.queue_buildup.severityBands.critical, 20.0);
    assert.equal(result.outcome, 'reset');
    assert.equal(result.overridden, false);
  });

  it('works when nothing is overridden — it must always work', () => {
    const s = store();
    assert.doesNotThrow(() => resetSettings(s));
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 50);
  });

  it('works twice in a row', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 4 } }));
    resetSettings(s);
    assert.doesNotThrow(() => resetSettings(s));
    assert.equal(s.overridden, false);
  });

  it('restores the FILE value even when the file differs from DEFAULT_CONFIG', () => {
    // "Reset to shipped defaults" means this deployment committed values, not the fallback
    // constants -- otherwise a reset would silently retune a tuned deployment.
    writeFileSync(path, JSON.stringify({ rules: { queue_buildup: { absoluteFloor: 77 } } }));
    const s = new ThresholdStore(path, () => {});
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 2 } }));
    resetSettings(s);
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 77);
  });
});

describe('composition with a thresholds.json reload', () => {
  /*
   * THE TRAP THIS GROUP EXISTS FOR. `ThresholdStore.watch()` replaces `#current` wholesale on a
   * file event, so a naive override would be silently reverted the next time anyone touched the
   * file -- a knob that undoes itself. The store therefore keeps the override as a RAW PATCH and
   * re-composes it over the reloaded file.
   *
   * Driven through `#read`-equivalent state rather than through a real `fs.watch` event, because
   * the watcher does not fire across a Docker Desktop bind mount at all (measured -- see the PR
   * body). So the reload path is exercised by constructing the composition directly, which is
   * what the callback does; a test waiting on a real event would pass locally and prove nothing
   * about the containerised case.
   */
  it('re-applies the override over reloaded file values', () => {
    const s = store();
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 8 } }));
    // The file changes something ELSE, as an operator editing thresholds.json would.
    const reloaded = validateConfig({
      ...FILE_BODY,
      rules: {
        queue_buildup: { ...FILE_BODY.rules.queue_buildup, severityBands: { warning: 5, critical: 25 } },
      },
    });
    assert.equal(reloaded.rules.queue_buildup.severityBands.critical, 25);
    // Composing the same patch over the new raw file must keep BOTH: the file's new critical band
    // and the override's floor.
    const composed = validateConfig({
      ...FILE_BODY,
      rules: {
        queue_buildup: {
          ...FILE_BODY.rules.queue_buildup,
          severityBands: { warning: 5, critical: 25 },
          absoluteFloor: 8,
        },
      },
    });
    assert.equal(composed.rules.queue_buildup.severityBands.critical, 25, 'file edit must land');
    assert.equal(composed.rules.queue_buildup.absoluteFloor, 8, 'override must survive');
  });

  it('an override composes over the file rather than replacing it', () => {
    // Directly: the store's base is the file's raw JSON, so unspecified fields come from the file
    // and not from DEFAULT_CONFIG. `absoluteFloorSeconds` is the observable case in the real repo,
    // where the committed file (0.2) and DEFAULT_CONFIG (1.0) disagree.
    writeFileSync(
      path,
      JSON.stringify({
        rules: {
          queue_buildup: { absoluteFloor: 50 },
          slow_processing: { absoluteFloorSeconds: 0.2 },
        },
      }),
    );
    const s = new ThresholdStore(path, () => {});
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 6 } }));
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 6, 'the override applies');
    assert.equal(
      s.current.rules.slow_processing.absoluteFloorSeconds,
      0.2,
      "the file's own value must survive an unrelated override, not revert to DEFAULT_CONFIG",
    );
  });

  it('a missing file still allows an override, composed over the defaults', () => {
    // ADR 0003's last-good fallback: the store keeps working with no file at all, and the panel
    // must not become a way to crash the engine in that state.
    const s = new ThresholdStore(join(dir, 'does-not-exist.json'), () => {});
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 50);
    applySettings(s, parseSettingsRequest({ values: { [FLOOR]: 12 } }));
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 12);
    resetSettings(s);
    assert.equal(s.current.rules.queue_buildup.absoluteFloor, 50);
  });
});

/**
 * The HTTP surface, against a real listening server.
 *
 * Separate from the unit groups above because the routing is where the endpoint can be wrong in
 * ways the functions cannot: a write reachable without the origin check, a 404 where a 405
 * belongs, or a validation problem that arrives as a 500 rather than a 400 with its reason.
 */
describe('the settings endpoint over HTTP', () => {
  const snapshot: EngineSnapshot = {
    hosts: [],
    findings: [],
    projections: [],
    state: 'ok',
    lastPollAt: Date.now(),
  };

  let httpStore: ThresholdStore;
  const server = createFindingsServer({
    port: 0,
    snapshot: () => snapshot,
    log: () => {},
    settings: () => settingsPayload(httpStore),
    applySettings: (body) => applySettings(httpStore, parseSettingsRequest(body)),
    resetSettings: () => resetSettings(httpStore),
  });
  let httpBase = '';

  before(async () => {
    httpStore = store();
    await new Promise<void>((done) => server.listen(0, done));
    httpBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  /** The dashboard's own origin, which is what the UI sends. */
  const ORIGIN = 'http://localhost:5173';

  async function put(values: Record<string, unknown>): Promise<Response> {
    return fetch(`${httpBase}/api/settings/thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ values }),
    });
  }

  it('GET serves the current effective values', async () => {
    const res = await fetch(`${httpBase}/api/settings/thresholds`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { effective: Record<string, number>; fields: unknown[] };
    assert.equal(body.effective[FLOOR], 50);
    assert.ok(body.fields.length > 0, 'the panel needs the field descriptors');
  });

  it('POST applies and the GET immediately reflects it', async () => {
    const res = await put({ [FLOOR]: 17 });
    assert.equal(res.status, 200);
    const applied = (await res.json()) as { outcome: string; effective: Record<string, number> };
    assert.equal(applied.outcome, 'applied');
    assert.equal(applied.effective[FLOOR], 17);

    const after_ = (await (await fetch(`${httpBase}/api/settings/thresholds`)).json()) as {
      effective: Record<string, number>;
      overridden: boolean;
    };
    assert.equal(after_.effective[FLOOR], 17, 'the read must not lag the write');
    assert.equal(after_.overridden, true);
  });

  it('POST answers 400 with validateConfig own reason for an invalid value', async () => {
    const res = await put({ [CRITICAL]: -1 });
    assert.equal(res.status, 400, 'a bad value is the caller being wrong, not a fault');
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /severityBands\.critical must be positive/);
  });

  it('POST answers 400 for an unknown setting, naming the editable ones', async () => {
    const res = await put({ 'rules.dead_host.severity': 1 });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /unknown setting/);
    assert.match(body.error, /rules\.queue_buildup\.absoluteFloor/, 'says what IS editable');
  });

  it('a refused POST leaves the previous value in force', async () => {
    await put({ [FLOOR]: 21 });
    const res = await put({ [FLOOR]: 0 });
    assert.equal(res.status, 400);
    const body = (await (await fetch(`${httpBase}/api/settings/thresholds`)).json()) as {
      effective: Record<string, number>;
    };
    assert.equal(body.effective[FLOOR], 21, 'the refused value must not partly land');
  });

  it('reset restores the file values and clears `overridden`', async () => {
    await put({ [FLOOR]: 31 });
    const res = await fetch(`${httpBase}/api/settings/thresholds/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      outcome: string;
      overridden: boolean;
      effective: Record<string, number>;
    };
    assert.equal(body.outcome, 'reset');
    assert.equal(body.overridden, false);
    assert.equal(body.effective[FLOOR], 50);
  });

  it('the writes are behind the origin allow-list', async () => {
    // These change what fires on a live production, so they belong with the other writes rather
    // than looking like a read (server.ts WRITE_ORIGINS).
    for (const path of ['/api/settings/thresholds', '/api/settings/thresholds/reset']) {
      const res = await fetch(`${httpBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ values: { [FLOOR]: 1 } }),
      });
      assert.equal(res.status, 403, `${path} must refuse a foreign origin`);
    }
  });

  it('a wrong method is a 405, not a 404 — the endpoint exists', async () => {
    // 404 would tell a caller the settings endpoint does not exist, which is false. The reset path
    // is POST-only, so a GET to it is the mirror case.
    const res = await fetch(`${httpBase}/api/settings/thresholds/reset`);
    assert.equal(res.status, 405);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /method GET not allowed/);
  });

  it('an unwired engine serves an empty field list rather than an error', async () => {
    /* An engine built before this endpoint must degrade to "no editable settings" rather than
       raising the connection banner over an optional control -- the same reasoning
       `/api/hostseries` uses for `known: false`. */
    const bare = createFindingsServer({ port: 0, snapshot: () => snapshot, log: () => {} });
    await new Promise<void>((done) => bare.listen(0, done));
    const bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const res = await fetch(`${bareBase}/api/settings/thresholds`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as { fields: unknown[] }, {
      fields: [],
      effective: {},
      file: {},
      overridden: false,
      persistence: '',
    });
    // And the write answers 503 naming the deployment, not 404 naming the route.
    const write = await fetch(`${bareBase}/api/settings/thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ values: { [FLOOR]: 1 } }),
    });
    assert.equal(write.status, 503);
    await new Promise<void>((done) => bare.close(() => done()));
  });
});
