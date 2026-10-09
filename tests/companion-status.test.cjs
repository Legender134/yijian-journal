'use strict';
// Use the real bridge methods with inert installation/account/heartbeat services.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { createRequire } = require('node:module');
const bridgeFile = path.join(__dirname, '../src/core/game-bridge.cjs');
const source = fs.readFileSync(bridgeFile, 'utf8');

function fixture() {
  let clock = 0,
    checks = 0,
    accounts = 0,
    installed = true,
    blocked = false;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    require: createRequire(bridgeFile),
    __dirname: path.dirname(bridgeFile),
    Buffer,
    performance: { now: () => clock },
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
  });
  const bridge = Object.create(module.exports.GameBridge.prototype);
  Object.assign(bridge, {
    now: () => clock,
    revision: 'synthetic-revision',
    token: 'a'.repeat(64),
    timeline: {
      data: { source: path.join('synthetic-only', '76561190000000000', 'SaveGames'), pending: null, nativeProtocol: 2 },
      summary: () => ({ enabled: true, pending: bridge.timeline.data.pending }),
    },
    grantBinding: 'inert synthetic fixture; no command is dispatched',
    installation: () => {
      checks++;
      return { installed, reason: installed ? '' : 'Synthetic component unavailable' };
    },
    account: () => {
      accounts++;
      return '76561190000000000';
    },
    blocked: () => blocked,
  });
  let pulse = {
    token: bridge.token,
    revision: bridge.revision,
    source: bridge.timeline.data.source,
    ready: true,
  };
  bridge.heartbeat = () => pulse;
  return {
    bridge,
    pulse: (value) => {
      pulse = value;
    },
    state: () => pulse,
    clock: (value) => {
      clock = value;
    },
    installed: (value) => {
      installed = value;
    },
    blocked: (value) => {
      blocked = value;
    },
    counts: () => ({ checks, accounts }),
  };
}

test('passive, battle and busy hints avoid compatibility scans and respond immediately', () => {
  const s = fixture();
  const pulse = s.state();
  s.pulse(null);
  for (let i = 0; i < 100; i++) assert.equal(s.bridge.hintQuiet(), false);
  assert.deepEqual(s.counts(), { checks: 0, accounts: 0 });
  s.pulse({ ...pulse, ready: false });
  assert.equal(s.bridge.hintQuiet(), true);
  assert.equal(s.counts().checks, 0);
  s.pulse(pulse);
  assert.equal(s.bridge.hintQuiet(), false);
  assert.equal(s.counts().checks, 1);
  for (const property of ['busy', 'loadQueued', 'quiescing']) {
    s.bridge[property] = true;
    assert.equal(s.bridge.hintQuiet(), true, property);
    s.bridge[property] = false;
    assert.equal(s.bridge.hintQuiet(), false, property);
  }
  s.bridge.timeline.data.pending = { id: 'synthetic-only' };
  assert.equal(s.bridge.hintQuiet(), true);
  s.bridge.timeline.data.pending = null;
  s.blocked(true);
  assert.equal(s.bridge.hintQuiet(), true, 'full restore blocks connected hints immediately');
  s.blocked(false);
  assert.equal(s.bridge.hintQuiet(), false);
  assert.deepEqual(s.counts(), { checks: 1, accounts: 1 });
  for (const stale of [{ revision: 'old' }, { source: 'other-save-directory' }, { source: 123 }]) {
    s.pulse({ ...pulse, ...stale });
    assert.equal(s.bridge.hintQuiet(), false, 'no valid connection means passive hints');
  }
  assert.equal(s.counts().checks, 1);
});

test('healthy hint polls share a five-second availability snapshot and fresh summaries invalidate it', () => {
  const s = fixture();
  for (let i = 0; i < 20; i++) {
    s.clock(i * 250);
    assert.equal(s.bridge.hintQuiet(), false);
  }
  assert.deepEqual(s.counts(), { checks: 1, accounts: 1 });
  s.clock(5000);
  assert.equal(s.bridge.hintQuiet(), false);
  assert.deepEqual(s.counts(), { checks: 2, accounts: 2 });
  s.installed(false);
  assert.equal(s.bridge.hintQuiet(), false, 'only the presentation snapshot has a short delay');
  s.bridge.summary();
  assert.equal(s.bridge.hintQuiet(), true, 'a current health refresh hides incompatible hints immediately');
  s.installed(true);
  s.clock(10000);
  assert.equal(s.bridge.hintQuiet(), false);
  s.pulse({ ...s.state(), ready: false });
  assert.equal(s.bridge.hintQuiet(), true, 'battle never waits for the metadata refresh');
  s.pulse({ ...s.state(), ready: true });
  assert.equal(s.bridge.hintQuiet(), false, 'leaving battle never waits for the metadata refresh');
});

test('cached hint availability never authorizes a native command against unavailable components', async () => {
  const s = fixture();
  assert.equal(s.bridge.hintQuiet(), false);
  s.installed(false);
  let error;
  try {
    await s.bridge.request('synthetic-not-dispatched', 'save');
  } catch (failure) {
    error = failure;
  }
  assert.match(error?.message || '', /Synthetic component unavailable/);
  assert.equal(error.notDispatched, true);
  assert.equal(s.counts().checks, 2, 'native dispatch checks the current installation directly');
});
