'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { GameBridge } = require('../src/core/game-bridge.cjs');
const { Timeline, writeBytes } = require('../src/core/timeline.cjs');
const { sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('./fixtures.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-bridge-'));
  const source = path.join(root, '76561190000000000', 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const timeline = new Timeline(path.join(root, 'history'));
  timeline.configure(source, false, 10);
  const events = [];
  const bridge = new GameBridge(path.join(root, 'ipc'), timeline, {
    getGame: () => ({ installed: false }),
    stopped: () => true,
    account: () => '76561190000000000',
    notify: (e) => events.push(e),
  });
  bridge.installation = () => ({ installed: true });
  const state = {
    protocol: 1,
    revision: bridge.revision,
    session: '1790000000-123456',
    token: bridge.token,
    source,
    at: Math.floor(Date.now() / 1000),
    ready: true,
    reason: '',
  };
  const pulse = () =>
    writeBytes(
      path.join(bridge.root, 'state.json'),
      Buffer.from(JSON.stringify({ ...state, at: Math.floor(Date.now() / 1000) })),
    );
  pulse();
  const timer = setInterval(pulse, 250);
  t.after(() => {
    clearInterval(timer);
    bridge.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-bridge-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, timeline, bridge, state, pulse, events };
}
function transport(t, s, handler) {
  let last = '';
  const timer = setInterval(() => {
    let text;
    try {
      text = fs.readFileSync(path.join(s.bridge.root, 'command.txt'), 'utf8');
    } catch {
      return;
    }
    const [token, session, id, verb, expiry, mode] = text.trim().split('\t');
    if (id === last) return;
    last = id;
    assert.equal(token, s.bridge.token);
    assert.equal(session, s.state.session);
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.ok(Number(expiry) >= Date.now() / 1000 - 1);
    handler({
      id,
      verb,
      mode,
      ack: (status, reason = '') =>
        writeBytes(
          path.join(s.bridge.root, 'response.json'),
          Buffer.from(
            JSON.stringify({ id, token, session, status, reason, at: Math.floor(Date.now() / 1000) }),
          ),
        ),
    });
  }, 20);
  t.after(() => clearInterval(timer));
}
function completeSave(s, cmd, seconds) {
  const bytes = syntheticSave({ full: true, seconds });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  writeBytes(path.join(s.bridge.root, 'receipts', cmd.id + '.sav'), bytes);
  cmd.ack('saved');
}
test('bridge accepts a verified native save and retains immutable bytes', async (t) => {
  const s = setup(t);
  transport(t, s, (cmd) => {
    assert.equal(cmd.verb, 'save');
    assert.equal(cmd.mode, 'empty');
    completeSave(s, cmd, 123);
  });
  const r = await s.bridge.save();
  assert.equal(r.playSeconds, 123);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.inspect(r.id).record.hash, sha(fs.readFileSync(path.join(s.source, '29.sav'))));
});
test('display readiness rejects missing components, blocked recovery and account mismatch', (t) => {
  const s = setup(t);
  assert.equal(s.bridge.summary().ready, true);
  s.bridge.installation = () => ({ installed: false, reason: '组件异常' });
  assert.equal(s.bridge.summary().ready, false);
  assert.equal(s.bridge.summary().reason, '组件异常');
  s.bridge.installation = () => ({ installed: true });
  s.bridge.blocked = () => true;
  assert.equal(s.bridge.summary().ready, false);
  assert.throws(() => s.bridge.assertReady(), /完整存档恢复/);
  s.bridge.blocked = () => false;
  s.bridge.account = () => '76561190000000001';
  s.bridge.statusAccount = null;
  assert.equal(s.bridge.summary().ready, false);
  assert.match(s.bridge.summary().reason, /Steam 账户不一致/);
  assert.throws(() => s.bridge.assertReady(), /Steam 账户不一致/);
  s.bridge.account = () => {
    throw Error('账户不可用');
  };
  s.bridge.statusAccount = null;
  assert.equal(s.bridge.summary().ready, false);
  assert.equal(s.bridge.summary().reason, '账户不可用');
});
test('normal exit drains an in-flight save, prevents new commands, and preserves enabled state', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  let release,
    calls = 0;
  const received = new Promise((resolve) => {
    release = resolve;
  });
  transport(t, s, (cmd) => {
    calls++;
    release(cmd);
  });
  const saving = s.bridge.save('auto');
  const cmd = await received;
  const drained = s.bridge.quiesce();
  await assert.rejects(s.bridge.save(), /退出/);
  await s.bridge.check();
  assert.equal(calls, 1);
  assert.equal(s.bridge.busy, true);
  assert.equal(s.bridge.disposed, false);
  completeSave(s, cmd, 200);
  await saving;
  await drained;
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.bridge.busy, false);
});
test('a heartbeat refresh in the initial save guard retries without stopping or issuing a command', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  const original = s.bridge.heartbeat.bind(s.bridge);
  let reads = 0,
    commands = 0;
  s.bridge.heartbeat = () => (++reads === 3 ? null : original());
  transport(t, s, (cmd) => {
    commands++;
    completeSave(s, cmd, 345);
  });
  await s.bridge.check();
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(commands, 0);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  assert.deepEqual(s.events, []);
  await s.bridge.check();
  assert.equal(commands, 1);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.timeline.summary().latest.playSeconds, 345);
});
test('exit timeout leaves a running operation intact for recovery', async (t) => {
  const s = setup(t);
  s.bridge.busy = true;
  await assert.rejects(s.bridge.quiesce(5), /取消退出/);
  assert.equal(s.bridge.disposed, false);
  assert.equal(s.bridge.busy, true);
  s.bridge.busy = false;
});
test('menu rejection produces no checkpoint and keeps automatic saving enabled', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  transport(t, s, (cmd) => cmd.ack('skipped', '菜单中暂停保存'));
  await assert.rejects(s.bridge.save('auto'), /菜单中暂停/);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.records.length, 0);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.events.length, 0);
});
test('a transient unreadable heartbeat after save intent cancels only the unissued command and retries', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  const assertReady = s.bridge.assertReady.bind(s.bridge);
  let guards = 0;
  s.bridge.assertReady = () => {
    if (++guards === 2) {
      const e = Error('等待游戏连接');
      e.waiting = true;
      throw e;
    }
    return assertReady();
  };
  await assert.rejects(s.bridge.save('auto'), /等待游戏连接/);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  assert.equal(fs.existsSync(path.join(s.source, '29.sav')), false);
  assert.equal(s.events.length, 0);
  transport(t, s, (cmd) => completeSave(s, cmd, 123));
  const saved = await s.bridge.save('auto');
  assert.equal(saved.playSeconds, 123);
  assert.equal(s.timeline.data.pending, null);
});
test('old receipt before asynchronous disk write is not reported as a successful checkpoint', async (t) => {
  const s = setup(t),
    bytes = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  s.timeline.record(bytes);
  transport(t, s, (cmd) => {
    writeBytes(path.join(s.bridge.root, 'receipts', cmd.id + '.sav'), bytes);
    cmd.ack('saved');
  });
  await assert.rejects(s.bridge.save(), /尚未完成写入/);
  assert.ok(s.timeline.data.pending);
  assert.equal(s.timeline.data.records.length, 1);
  assert.equal(s.timeline.data.enabled, false);
});
test('native ownership rejection never writes another slot or forgets foreign changes', async (t) => {
  const s = setup(t),
    bytes = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  s.timeline.record(bytes);
  const other = syntheticSave({ seconds: 999 });
  transport(t, s, (cmd) => {
    writeBytes(path.join(s.source, '29.sav'), other);
    cmd.ack('rejected', '29 号槽被修改');
  });
  await assert.rejects(s.bridge.save());
  assert.equal(sha(fs.readFileSync(path.join(s.source, '29.sav'))), sha(other));
  assert.ok(s.timeline.data.pending);
  assert.equal(s.timeline.data.enabled, false);
});
test('wrong Steam account, script revision, and stale heartbeat prevent commands', async (t) => {
  const s = setup(t);
  s.bridge.account = () => '76561190000000001';
  assert.throws(() => s.bridge.assertReady(), /Steam 账户/);
  s.bridge.account = () => '76561190000000000';
  s.state.revision = 'wrong';
  s.pulse();
  assert.throws(() => s.bridge.assertReady(), /等待游戏连接/);
  s.state.revision = s.bridge.revision;
  s.pulse();
  s.bridge.now = () => Date.now() + 10000;
  assert.throws(() => s.bridge.assertReady(), /等待游戏连接/);
  assert.ok(!fs.existsSync(path.join(s.bridge.root, 'command.txt')));
});
test('active native heartbeat blocks full restore even when process enumeration misses the game', (t) => {
  const s = setup(t);
  assert.equal(s.bridge.stopped(), true);
  assert.equal(s.bridge.canStop(), false);
});
test('load saves current progress and requires the complete protection before staging', async (t) => {
  const s = setup(t),
    old = syntheticSave({ full: true, seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), old);
  const selected = s.timeline.record(old);
  const calls = [];
  transport(t, s, (cmd) => {
    calls.push(cmd.verb);
    if (cmd.verb === 'save') completeSave(s, cmd, 20);
    else {
      assert.equal(sha(fs.readFileSync(path.join(s.source, '29.sav'))), selected.hash);
      cmd.ack('loaded');
    }
  });
  const result = await s.bridge.load(selected.id, () => {
    calls.push('protection');
    assert.equal(s.timeline.data.records.at(-1).playSeconds, 20);
    return { id: 'verified-backup' };
  });
  assert.deepEqual(calls, ['save', 'protection', 'load']);
  assert.equal(result.backupId, 'verified-backup');
  assert.equal(s.timeline.inspect(result.currentId).record.playSeconds, 20);
  assert.equal(s.timeline.data.pending, null);
});
test('failed complete protection leaves current progress intact and never requests load', async (t) => {
  const s = setup(t),
    old = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), old);
  const selected = s.timeline.record(old),
    calls = [];
  transport(t, s, (cmd) => {
    calls.push(cmd.verb);
    completeSave(s, cmd, 20);
  });
  await assert.rejects(
    s.bridge.load(selected.id, () => {
      throw Error('protection failed');
    }),
    /protection failed/,
  );
  assert.deepEqual(calls, ['save']);
  assert.equal(s.timeline.data.records.at(-1).playSeconds, 20);
  assert.equal(s.timeline.assertOwned(), path.join(s.source, '29.sav'));
});

test('confirmed load waits for an automatic save and prevents another scheduled operation', async (t) => {
  const s = setup(t),
    old = syntheticSave({ full: true, seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), old);
  const selected = s.timeline.record(old);
  s.timeline.configure(s.source, true, 10);
  const calls = [];
  let firstCommand, resolveFirst;
  const received = new Promise((r) => {
    resolveFirst = r;
  });
  transport(t, s, (cmd) => {
    calls.push(cmd.verb);
    if (calls.length === 1) {
      firstCommand = cmd;
      resolveFirst();
    } else if (cmd.verb === 'save') completeSave(s, cmd, 30);
    else {
      assert.equal(sha(fs.readFileSync(path.join(s.source, '29.sav'))), selected.hash);
      cmd.ack('loaded');
    }
  });
  const saving = s.bridge.save('auto');
  await received;
  let protections = 0;
  const loading = s.bridge.loadConfirmed(selected.id, () => {
    protections++;
    return { id: 'verified' };
  });
  assert.equal(s.bridge.loadQueued, true);
  assert.equal(s.bridge.summary().busy, true);
  await s.bridge.check();
  await assert.rejects(s.bridge.save(), /上一次/);
  await assert.rejects(
    s.bridge.loadConfirmed(selected.id, () => {}),
    /上一次/,
  );
  assert.deepEqual(calls, ['save']);
  assert.equal(protections, 0);
  await assert.rejects(
    s.bridge.load(selected.id, () => {}),
    /上一次/,
  );
  completeSave(s, firstCommand, 20);
  await saving;
  const result = await loading;
  assert.deepEqual(calls, ['save', 'save', 'load']);
  assert.equal(protections, 1);
  assert.equal(result.currentId, s.timeline.data.records.find((r) => r.kind === 'before-load').id);
  assert.equal(s.bridge.loadQueued, false);
  assert.equal(s.timeline.data.enabled, true);
});

test('confirmed load timeout releases scheduling without issuing a native request', async (t) => {
  const s = setup(t),
    bytes = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  const selected = s.timeline.record(bytes);
  s.timeline.configure(s.source, true, 10);
  s.bridge.busy = true;
  await assert.rejects(
    s.bridge.loadConfirmed(
      selected.id,
      () => {
        throw Error('must not protect');
      },
      5,
    ),
    /仍未结束/,
  );
  assert.equal(s.bridge.loadQueued, false);
  assert.equal(s.bridge.busy, true);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  s.bridge.busy = false;
});

test('confirmed load rechecks readiness and cancels safely if the game opens a menu while waiting', async (t) => {
  const s = setup(t),
    bytes = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  const selected = s.timeline.record(bytes);
  s.timeline.configure(s.source, true, 10);
  s.bridge.busy = true;
  const loading = s.bridge.loadConfirmed(selected.id, () => {
    throw Error('must not protect');
  });
  s.state.ready = false;
  s.state.reason = '菜单中暂停保存';
  s.pulse();
  s.bridge.busy = false;
  await assert.rejects(loading, /菜单中暂停/);
  assert.equal(s.bridge.loadQueued, false);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.timeline.data.records.length, 1);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
});

test('exit cancels a queued confirmed load and drains the existing operation', async (t) => {
  const s = setup(t),
    selected = s.timeline.record(syntheticSave({ seconds: 10 }));
  s.bridge.busy = true;
  const loading = s.bridge.loadConfirmed(selected.id, () => {
    throw Error('must not protect');
  });
  const rejected = assert.rejects(loading, /取消等候读档/);
  const drained = s.bridge.quiesce();
  await rejected;
  assert.equal(s.bridge.loadQueued, false);
  assert.equal(s.bridge.busy, true);
  s.bridge.busy = false;
  await drained;
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
});

test('temporary heartbeat loss before dispatch cancels a confirmed load without stopping protection', async (t) => {
  const s = setup(t),
    bytes = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  const selected = s.timeline.record(bytes);
  s.timeline.configure(s.source, true, 10);
  s.bridge.busy = true;
  const loading = s.bridge.loadConfirmed(selected.id, () => {
    throw Error('must not protect');
  });
  const heartbeat = s.bridge.heartbeat.bind(s.bridge);
  s.bridge.heartbeat = () => null;
  s.bridge.busy = false;
  await assert.rejects(loading, /等待游戏连接/);
  assert.equal(s.bridge.loadQueued, false);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.records.length, 1);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  s.bridge.heartbeat = heartbeat;
  transport(t, s, (cmd) => completeSave(s, cmd, 20));
  await s.bridge.check();
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(s.timeline.data.records.at(-1).playSeconds, 20);
});

test('heartbeat loss after staging a load retains pending protection and stops scheduling', async (t) => {
  const s = setup(t),
    bytes = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), bytes);
  const selected = s.timeline.record(bytes);
  s.timeline.configure(s.source, true, 10);
  const ready = s.bridge.assertReady.bind(s.bridge);
  let guards = 0,
    loads = 0;
  s.bridge.assertReady = () => {
    if (++guards === 5) {
      const e = Error('等待游戏连接');
      e.waiting = true;
      throw e;
    }
    return ready();
  };
  transport(t, s, (cmd) => {
    if (cmd.verb === 'save') completeSave(s, cmd, 20);
    else loads++;
  });
  await assert.rejects(
    s.bridge.loadConfirmed(selected.id, () => ({ id: 'verified' })),
    /等待游戏连接/,
  );
  assert.equal(loads, 0);
  assert.equal(s.bridge.loadQueued, false);
  assert.equal(s.timeline.data.enabled, false);
  assert.equal(s.timeline.data.pending.type, 'load');
  assert.equal(s.timeline.data.pending.targetHash, selected.hash);
  assert.equal(
    s.timeline.inspect(s.timeline.data.records.find((r) => r.kind === 'before-load').id).record.playSeconds,
    20,
  );
  assert.equal(sha(fs.readFileSync(path.join(s.source, '29.sav'))), selected.hash);
});
test('test environment cannot install, launch native autosave, or load actual components', (t) => {
  const s = setup(t);
  s.bridge.test = true;
  assert.throws(() => s.bridge.location(), /测试环境/);
  s.bridge.start();
  assert.equal(s.bridge.timer, undefined);
});
