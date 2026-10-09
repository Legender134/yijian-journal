'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { GameBridge, bridgeStateRoot } = require('../src/core/game-bridge.cjs');
const { Timeline, writeBytes } = require('../src/core/timeline.cjs');
const { Saves, sha } = require('../src/core/saves.cjs');
const { Store } = require('../src/core/store.cjs');
const { AutoBackup } = require('../src/core/auto-backup.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { PROTOCOL, mac } = require('../src/core/native-io.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-bridge-'));
  const source = path.join(root, '76561190000000000', 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const timeline = new Timeline(path.join(root, 'history'));
  timeline.configure(source, true, 10); // Explicit synthetic native consent, before connecting.
  const events = [];
  const bridge = new GameBridge(path.join(root, 'ipc'), timeline, {
    getGame: () => ({ installed: false }),
    stopped: () => true,
    account: () => '76561190000000000',
    notify: (e) => events.push(e),
  });
  bridge.installation = () => ({ installed: true });
  const state = {
    protocol: PROTOCOL,
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
function stateRootFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-bridge-state-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-bridge-state-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const userData = path.join(root, 'journal-data');
  const game = { installed: true, path: path.join(root, 'synthetic-game') };
  const bin = path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64');
  const legacy = path.join(bin, 'ue4ss', 'YijianJournal');
  const marker = path.join(bin, '.yijian-component.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(game.path, 'JH.exe'), 'synthetic, never executable');
  return { root, userData, game, bin, legacy, marker };
}

test('fresh runtime state starts without write access to the game installation', (t) => {
  const { userData, game, legacy } = stateRootFixture(t);
  const timeline = new Timeline(path.join(userData, 'history'));
  const options = { getGame: () => game, stopped: () => true, test: true };
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = (target, ...args) => {
    if (path.resolve(target).startsWith(path.resolve(game.path) + path.sep)) {
      const error = Error('EPERM: synthetic read-only game directory');
      error.code = 'EPERM';
      throw error;
    }
    return originalMkdir(target, ...args);
  };
  let bridge;
  try {
    assert.throws(() => new GameBridge(legacy, timeline, options), /synthetic read-only/);
    const selected = bridgeStateRoot(game, userData);
    assert.equal(selected, path.join(userData, 'game-bridge'));
    bridge = new GameBridge(selected, timeline, options);
    assert.equal(bridge.root, fs.realpathSync(selected));
    assert.match(fs.readFileSync(path.join(selected, 'token.txt'), 'utf8'), /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(path.join(game.path, 'JH.exe'), 'utf8'), 'synthetic, never executable');
    assert.equal(timeline.data.enabled, false);
  } finally {
    fs.mkdirSync = originalMkdir;
    bridge?.dispose();
  }
});

test('recognized existing components keep their legacy runtime token and files', (t) => {
  for (const mod of ['YijianJournalBridge', 'YijianSaveProbe']) {
    const { userData, game, legacy, marker } = stateRootFixture(t);
    fs.mkdirSync(path.join(legacy, 'receipts'), { recursive: true });
    const retained = new Map([
      ['token.txt', Buffer.from('a'.repeat(64))],
      ['config.txt', Buffer.from('synthetic existing configuration')],
      ['command.txt', Buffer.from('synthetic existing request')],
    ]);
    for (const [name, bytes] of retained) fs.writeFileSync(path.join(legacy, name), bytes);
    const markerBytes = Buffer.from(
      JSON.stringify({ schema: 1, mod, root: legacy.replaceAll('\\', '/').toUpperCase() }),
    );
    fs.writeFileSync(marker, markerBytes);
    const selected = bridgeStateRoot(game, userData);
    assert.equal(selected, legacy);
    const bridge = new GameBridge(selected, new Timeline(path.join(userData, 'history')), {
      getGame: () => game,
      stopped: () => true,
      test: true,
    });
    bridge.dispose();
    assert.equal(bridge.token, retained.get('token.txt').toString());
    for (const [name, bytes] of retained) assert.deepEqual(fs.readFileSync(path.join(legacy, name)), bytes);
    assert.deepEqual(fs.readFileSync(marker), markerBytes);
    assert.equal(fs.existsSync(path.join(userData, 'game-bridge')), false);
  }
});

test('runtime selection preserves unrecognized markers and isolation never inspects game files', (t) => {
  const { root, userData, game, legacy, marker } = stateRootFixture(t);
  const foreign = path.join(root, 'foreign-runtime');
  const fallback = path.join(userData, 'game-bridge');
  for (const value of [
    { schema: 2, mod: 'YijianJournalBridge', root: legacy },
    { schema: 1, mod: 'another-component', root: legacy },
    { schema: 1, mod: 'YijianJournalBridge', root: foreign },
    { schema: 1, mod: 'YijianJournalBridge' },
    null,
    'malformed',
  ]) {
    const bytes = Buffer.from(value === 'malformed' ? '{broken' : JSON.stringify(value));
    fs.writeFileSync(marker, bytes);
    assert.equal(bridgeStateRoot(game, userData), fallback);
    assert.deepEqual(fs.readFileSync(marker), bytes);
    assert.equal(fs.existsSync(fallback), false);
    assert.equal(fs.existsSync(foreign), false);
  }
  fs.writeFileSync(marker, JSON.stringify({ schema: 1, mod: 'YijianJournalBridge', root: legacy }));
  const originalStat = fs.lstatSync;
  let gameReads = 0;
  fs.lstatSync = (file, ...args) => {
    if (path.resolve(file).startsWith(path.resolve(game.path) + path.sep)) gameReads++;
    return originalStat(file, ...args);
  };
  try {
    assert.equal(bridgeStateRoot(game, userData, true), fallback);
  } finally {
    fs.lstatSync = originalStat;
  }
  assert.equal(gameReads, 0);
  assert.equal(bridgeStateRoot({ installed: false }, userData), fallback);
});

test('legacy directories remain usable in passive mode, while enabled native saving fails closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-passive-bridge-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-passive-bridge-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'SaveGames');
  fs.mkdirSync(source);
  const options = { getGame: () => ({ installed: false }), stopped: () => true };
  const passiveTimeline = new Timeline(path.join(root, 'passive-history'));
  passiveTimeline.configure(source, false, 10);
  const passive = new GameBridge(path.join(root, 'passive-ipc'), passiveTimeline, options);
  assert.equal(passive.error, '');
  assert.equal(passiveTimeline.data.enabled, false);
  assert.deepEqual(fs.readdirSync(source), []);
  passive.dispose();
  const activeTimeline = new Timeline(path.join(root, 'active-history'));
  activeTimeline.configure(source, true, 10);
  const active = new GameBridge(path.join(root, 'active-ipc'), activeTimeline, options);
  assert.match(active.error, /Steam 账户/);
  assert.equal(activeTimeline.data.enabled, false);
  assert.deepEqual(fs.readdirSync(source), []);
  active.dispose();
});

test('backup connection status requires the current revision and save directory, not only the token', (t) => {
  const s = setup(t);
  assert.equal(s.bridge.connected(), true);
  assert.equal(s.bridge.summary().connected, true);
  for (const change of [
    { revision: 'obsolete-synthetic-revision' },
    { source: path.join(s.root, 'another-account', 'SaveGames') },
    { source: 123 },
    { source: null },
    { source: {} },
    { token: 'b'.repeat(64) },
  ]) {
    writeBytes(
      path.join(s.bridge.root, 'state.json'),
      Buffer.from(JSON.stringify({ ...s.state, ...change, at: Math.floor(Date.now() / 1000) })),
    );
    assert.equal(s.bridge.connected(), false);
    assert.equal(s.bridge.summary().connected, false);
  }
  s.pulse();
  assert.equal(s.bridge.connected(), true);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
});

function transport(t, s, handler) {
  let last = '';
  const timer = setInterval(() => {
    let text;
    try {
      text = fs.readFileSync(path.join(s.bridge.root, 'command.txt'), 'utf8');
    } catch {
      return;
    }
    const rows = text.trim().split('\t');
    const [token, session, id, verb, expiry, mode, signature] = rows;
    if (id === last) return;
    last = id;
    assert.equal(token, s.bridge.token);
    assert.equal(session, s.state.session);
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.ok(Number(expiry) >= Date.now() / 1000 - 1);
    assert.equal(rows.length, 7);
    assert.equal(signature, mac(token, rows.slice(0, 6).join('\t') + '\n' + s.bridge.grantBinding));
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

test('an unavailable idle component stops native mode and permits verified file backups without game writes', (t) => {
  for (const autoBackup of [true, false]) {
    const s = setup(t);
    const bytes = syntheticSave({ full: true, seconds: 1234 });
    fs.writeFileSync(path.join(s.source, '1.sav'), bytes);
    s.timeline.configure(s.source, true, 10);
    fs.writeFileSync(path.join(s.source, '29.sav'), bytes);
    s.timeline.record(bytes, 'auto', Date.now());
    const ownerHash = s.timeline.data.ownerHash,
      records = JSON.stringify(s.timeline.data.records);
    const store = new Store(path.join(s.root, 'journal'), require('../src/data/catalog.cjs'));
    store.setPath('savePath', s.source);
    store.mutate({ type: 'settings', value: { autoBackup } });
    const saves = new Saves(path.join(s.root, 'full-backups'));
    let finish;
    const backup = new AutoBackup(store, saves, () => {}, {
      isBlocked: () => s.timeline.data.enabled,
      schedule: (callback) => {
        finish = callback;
        return 1;
      },
      cancel: () => {},
    });
    t.after(() => backup.dispose());
    backup.check();
    assert.equal(finish, undefined);
    s.bridge.heartbeat = () => null;
    s.bridge.installation = () => ({ installed: false, reason: '合成游戏版本已更新，组件尚未适配' });
    assert.equal(s.bridge.reconcileEnvironment(), true);
    assert.equal(s.timeline.data.enabled, false);
    assert.equal(s.timeline.data.ownerHash, ownerHash);
    assert.equal(JSON.stringify(s.timeline.data.records), records);
    assert.match(s.bridge.error, /版本已更新/);
    assert.equal(s.bridge.reconcileEnvironment(), false);
    assert.equal(s.events.length, 1);
    assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
    backup.check();
    if (autoBackup) {
      assert.equal(typeof finish, 'function');
      finish();
      const copies = saves.list();
      assert.equal(copies.length, 1);
      assert.deepEqual(saves.verify(copies[0].id).buffers.get('29.sav'), bytes);
    } else {
      assert.equal(finish, undefined);
      assert.deepEqual(saves.list(), []);
    }
    assert.equal(store.get().settings.autoBackup, autoBackup);
    assert.deepEqual(fs.readFileSync(path.join(s.source, '1.sav')), bytes);
    assert.deepEqual(fs.readFileSync(path.join(s.source, '29.sav')), bytes);
  }
});

test('idle component reconciliation preserves normal waiting and defers every in-flight or recovery state', (t) => {
  for (const blocked of [
    'healthy',
    'busy',
    'loadQueued',
    'quiescing',
    'disposed',
    'test',
    'pending',
    'restore',
  ]) {
    const s = setup(t);
    s.timeline.configure(s.source, true, 10);
    s.bridge.heartbeat = () => null;
    if (['busy', 'loadQueued', 'quiescing', 'disposed', 'test'].includes(blocked)) s.bridge[blocked] = true;
    if (blocked === 'pending') s.timeline.data.pending = { type: 'save' };
    if (blocked === 'restore') s.bridge.blocked = () => true;
    let inspections = 0;
    s.bridge.installation = () => {
      inspections++;
      return { installed: blocked === 'healthy', reason: '合成组件失效' };
    };
    assert.equal(s.bridge.reconcileEnvironment(), false);
    assert.equal(inspections, blocked === 'healthy' ? 1 : 0);
    assert.equal(s.timeline.data.enabled, true);
    assert.equal(s.bridge.error, '');
    assert.deepEqual(s.events, []);
    assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  }
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
    // This case injects its own unreadable guard. Keep the otherwise healthy
    // synthetic game fresh even when synchronous CI disk work delays its timer.
    s.pulse();
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
test('a short command read lock retries before dispatch and saves exactly once', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  const command = path.join(s.bridge.root, 'command.txt');
  const rename = fs.renameSync;
  let attempts = 0,
    commands = 0;
  fs.renameSync = (from, to) => {
    if (to === command && ++attempts === 1) {
      const e = Error('synthetic Windows read lock');
      Object.assign(e, { code: 'EPERM', syscall: 'rename' });
      throw e;
    }
    return rename(from, to);
  };
  t.after(() => {
    fs.renameSync = rename;
  });
  transport(t, s, (cmd) => {
    commands++;
    completeSave(s, cmd, 678);
  });
  const saved = await s.bridge.save('auto');
  assert.equal(attempts, 2);
  assert.equal(commands, 1);
  assert.equal(saved.playSeconds, 678);
  assert.equal(s.timeline.data.records.length, 1);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.enabled, true);
});

test('persistent command read locks stop after bounded retries without uncertain intent', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  const command = path.join(s.bridge.root, 'command.txt');
  const previous = Buffer.from('previous synthetic command');
  fs.writeFileSync(command, previous);
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === command) {
      attempts++;
      const e = Error('synthetic persistent read lock');
      Object.assign(e, { code: 'EPERM', syscall: 'rename' });
      throw e;
    }
    return rename(from, to);
  };
  t.after(() => {
    fs.renameSync = rename;
  });
  await assert.rejects(s.bridge.save('auto'), (e) => {
    assert.equal(e.notDispatched, true);
    assert.equal(e.cause.code, 'EPERM');
    assert.match(e.message, /无法发送游戏接入指令/);
    return true;
  });
  assert.equal(attempts, 4);
  assert.deepEqual(fs.readFileSync(command), previous);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.enabled, false);
  assert.deepEqual(fs.readdirSync(s.source), []);
});

test('command creation failures do not retry or leave uncertain intent', async (t) => {
  const s = setup(t);
  const command = path.join(s.bridge.root, 'command.txt');
  const open = fs.openSync;
  let attempts = 0;
  fs.openSync = (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(command + '.') && file.endsWith('.tmp')) {
      attempts++;
      const e = Error('synthetic permission denied');
      Object.assign(e, { code: 'EACCES', syscall: 'open' });
      throw e;
    }
    return open(file, ...args);
  };
  t.after(() => {
    fs.openSync = open;
  });
  await assert.rejects(s.bridge.save(), (e) => e.notDispatched && e.cause.code === 'EACCES');
  assert.equal(attempts, 1);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(fs.existsSync(command), false);
  assert.deepEqual(fs.readdirSync(s.source), []);
});

test('command retries recheck readiness and refuse a changed game session', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  const command = path.join(s.bridge.root, 'command.txt');
  const rename = fs.renameSync,
    ready = s.bridge.assertReady.bind(s.bridge);
  let attempts = 0,
    guards = 0;
  fs.renameSync = (from, to) => {
    if (to === command) {
      attempts++;
      const e = Error('synthetic Windows read lock');
      Object.assign(e, { code: 'EPERM', syscall: 'rename' });
      throw e;
    }
    return rename(from, to);
  };
  t.after(() => {
    fs.renameSync = rename;
  });
  s.bridge.assertReady = () => {
    const current = ready();
    return ++guards >= 3 ? { ...current, session: 'new-synthetic-session' } : current;
  };
  await assert.rejects(s.bridge.save('auto'), (e) => e.waiting && e.notDispatched);
  assert.equal(guards, 3);
  assert.equal(attempts, 1);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(s.timeline.data.enabled, true);
  assert.equal(fs.existsSync(command), false);
  assert.deepEqual(s.events, []);
});

test('read-back failures after command publication retain intent and never retry dispatch', async (t) => {
  const s = setup(t);
  s.timeline.configure(s.source, true, 10);
  const command = path.join(s.bridge.root, 'command.txt');
  const read = fs.readFileSync;
  let checks = 0;
  fs.readFileSync = (file, ...args) => {
    if (file === command) {
      checks++;
      throw Error('synthetic post-publication verification failure');
    }
    return read(file, ...args);
  };
  t.after(() => {
    fs.readFileSync = read;
  });
  await assert.rejects(s.bridge.save('auto'), (e) => {
    assert.equal(e.notReplaced, false);
    assert.equal(e.notDispatched, undefined);
    return /post-publication/.test(e.message);
  });
  assert.equal(checks, 1);
  assert.equal(s.timeline.data.pending.type, 'save');
  assert.ok(read(command, 'utf8').includes(s.timeline.data.pending.id));
  assert.equal(s.timeline.data.enabled, false);
  assert.deepEqual(fs.readdirSync(s.source), []);
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

test('background native checks remain quiet during a protection command barrier', async (t) => {
  const s = setup(t);
  s.bridge.blocked = () => true;
  s.bridge.heartbeat = () => {
    throw Error('blocked check must not read transport');
  };
  s.bridge.save = () => {
    throw Error('blocked check must not save');
  };
  await s.bridge.check();
  assert.equal(s.bridge.error, '');
});
