'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { Saves, sha } = require('../src/core/saves.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { QuickStart, selectSaveFolder } = require('../src/core/quick-start.cjs');
const { GameBridge } = require('../src/core/game-bridge.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');

function setup(t, occupied = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-quick-start-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-quick-start-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const account = '76561190000000000';
  const source = path.join(root, account, 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const original = syntheticSave({ full: true, seconds: 100 });
  fs.writeFileSync(path.join(source, '1.sav'), original);
  const slot = path.join(source, '29.sav');
  if (occupied) fs.writeFileSync(slot, original);
  const store = new Store(path.join(root, 'journal'), catalog);
  store.setPath('savePath', source);
  const saves = new Saves(path.join(root, 'backups'));
  const timeline = new Timeline(path.join(root, 'timeline'));
  timeline.configure(source, false, 10);
  const calls = [];
  const bridge = {
    account: () => account,
    location: () => source,
    canStop: () => true,
    install: () => {
      calls.push('install');
      return { installed: true };
    },
    connect: (value) => {
      assert.equal(value, source);
      calls.push('connect');
    },
  };
  const start = new QuickStart({
    store,
    saves,
    timeline,
    bridge,
    confirm: async () => {
      calls.push('confirm');
      return true;
    },
  });
  return { root, account, source, original, slot, store, saves, timeline, bridge, calls, start };
}

test('Chinese runtime and original source complete confirmed protected setup without moving game saves', async (t) => {
  for (const kind of ['runtime', 'source']) {
    const s = setup(t);
    let source = s.source;
    if (kind === 'source') {
      source = path.join(s.root, '中文存档', s.account, 'SaveGames');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, '1.sav'), s.original);
      fs.writeFileSync(path.join(source, '29.sav'), s.original);
      s.store.setPath('savePath', source);
      s.timeline.configure(source, false, 10);
    }
    const bridge = new GameBridge(path.join(s.root, '中文手札 用户 空格'), s.timeline,
      { getGame: () => ({ installed: false }), account: () => s.account, stopped: () => true });
    t.after(() => bridge.dispose());
    bridge.install = () => { s.calls.push('install'); return { installed: true }; };
    bridge.location = () => source;
    const connect = bridge.connect.bind(bridge);
    bridge.connect = (value) => {
      assert.equal(s.timeline.data.nativeProtocol, 2, 'consent and protection must precede native grant');
      s.calls.push('connect'); return connect(value);
    };
    s.start.bridge = bridge;
    assert.equal(bridge.nativePathIssue(source), '');
    const result = await s.start.start();
    assert.equal(s.timeline.data.enabled, true);
    assert.equal(s.timeline.data.nativeProtocol, 2);
    assert.deepEqual(s.calls, ['confirm', 'install', 'connect']);
    const protectedBackup = s.saves.verify(result.backupId);
    assert.deepEqual(protectedBackup.buffers.get('29.sav'), s.original);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), s.original);
    assert.deepEqual(fs.readFileSync(path.join(source, '29.sav')), s.original);
    assert.equal(fs.existsSync(path.join(bridge.root, 'command.txt')), false);
    assert.equal(fs.readFileSync(path.join(bridge.root, 'config.txt'), 'utf8').split('\n')[0], '2');
    assert(bridge.grantBinding.includes(source.replaceAll('\\', '/')));
  }
});

test('fresh defaults work immediately and reopening preserves an existing opt-out', (t) => {
  const { store, timeline } = setup(t);
  const fresh = store.get();
  assert.equal(fresh.settings.autoBackup, true);
  assert.equal(fresh.settings.companionEnabled, true);
  assert.equal(fresh.settings.saveFeedback, false);
  assert.equal(fresh.settings.offerAutoSaveOnStart, true);
  assert.equal(fresh.profiles[0].referenceMode, 'latest');
  assert.equal(timeline.data.enabled, false);
  store.mutate({ type: 'settings', value: { autoBackup: false, companionEnabled: false } });
  const reopened = new Store(store.dir, catalog).get();
  assert.equal(reopened.settings.autoBackup, false);
  assert.equal(reopened.settings.companionEnabled, false);
  assert.equal(reopened.settings.savePath, fresh.settings.savePath);
});

test('automatic detection uses the active account and leaves ambiguous accounts unselected', () => {
  const one = path.join('Saved', '76561190000000001', 'SaveGames');
  const two = path.join('Saved', '76561190000000002', 'SaveGames');
  const offline = () => {
    throw Error('Steam is offline');
  };
  assert.equal(selectSaveFolder([one], offline), one);
  assert.equal(
    selectSaveFolder([one, two], () => '76561190000000002'),
    two,
  );
  assert.equal(selectSaveFolder([one, two], offline), '');
  assert.equal(
    selectSaveFolder([one, two], () => '76561190000000003'),
    '',
  );
  assert.equal(
    selectSaveFolder([one, one], () => '76561190000000001'),
    '',
  );
  assert.equal(selectSaveFolder([], offline), '');
});

test('one confirmation protects all files and retains an occupied slot across restart and rotation', async (t) => {
  const { start, calls, saves, timeline, source, slot, original } = setup(t);
  const result = await start.start();
  assert.deepEqual(calls, ['confirm', 'install', 'connect']);
  const backup = saves.verify(result.backupId);
  assert.deepEqual(backup.buffers.get('1.sav'), original);
  assert.deepEqual(backup.buffers.get('29.sav'), original);
  assert.deepEqual(fs.readFileSync(slot), original);
  assert.equal(timeline.data.enabled, true);
  assert.equal(timeline.data.interval, 10);
  assert.equal(timeline.inspect(result.retainedId).record.bookmarked, true);
  assert.deepEqual(timeline.inspect(result.retainedId).bytes, original);
  const reopened = new Timeline(timeline.root);
  assert.equal(reopened.data.enabled, true);
  reopened.assertOwned();
  for (let i = 0; i < 65; i++) {
    const bytes = syntheticSave({ full: true, seconds: 200 + i });
    fs.writeFileSync(slot, bytes);
    reopened.record(bytes, 'auto', Date.now() + i * 600000);
  }
  assert.deepEqual(reopened.inspect(result.retainedId).bytes, original);
  assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), original);
});

test('enabling native saving preserves an existing full-backup opt-out', async (t) => {
  const { start, store, timeline } = setup(t);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  const before = store.get();
  await start.start();
  assert.equal(timeline.data.enabled, true);
  assert.deepEqual(store.get(), before);
});

test('an empty slot is enabled without creating or changing a game save', async (t) => {
  const { start, slot, timeline } = setup(t, false);
  const result = await start.start();
  assert.equal(result.retainedId, undefined);
  assert.equal(timeline.data.enabled, true);
  assert.equal(timeline.data.ownerHash, '');
  assert.equal(fs.existsSync(slot), false);
});

test('declining the first confirmation leaves native setup and slot ownership untouched', async (t) => {
  const { start, calls, saves, timeline, slot, original, store } = setup(t);
  const before = store.get();
  start.confirm = async () => false;
  assert.deepEqual(await start.start(), { cancelled: true });
  assert.deepEqual(calls, []);
  assert.equal(saves.list().length, 0);
  assert.equal(timeline.data.enabled, false);
  assert.equal(timeline.data.ownerHash, '');
  assert.deepEqual(fs.readFileSync(slot), original);
  assert.deepEqual(store.get(), before);
  assert.equal(start.running, false);
});

test('launch-only remembers the choice without native checks, setup or save changes', async (t) => {
  const { start, bridge, calls, saves, timeline, source, slot, original, store } = setup(t);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  const before = store.get();
  for (const method of ['account', 'location', 'canStop'])
    bridge[method] = () => {
      throw Error('native checks must not run');
    };
  start.confirm = async () => 'launch-only';
  assert.deepEqual(await start.start(), { launchOnly: true });
  assert.deepEqual(calls, []);
  assert.equal(saves.list().length, 0);
  assert.equal(timeline.data.enabled, false);
  assert.equal(timeline.data.ownerHash, '');
  assert.deepEqual(fs.readFileSync(slot), original);
  assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), original);
  const reopened = new Store(store.dir, catalog).get();
  assert.equal(reopened.settings.offerAutoSaveOnStart, false);
  assert.equal(reopened.settings.autoBackup, false);
  assert.deepEqual(
    reopened.profiles.map(({ updatedAt, ...profile }) => profile),
    before.profiles.map(({ updatedAt, ...profile }) => profile),
  );
  assert.equal(start.running, false);
});

test('invalid start preference is rejected without changing the stored journal', (t) => {
  const { store } = setup(t);
  const before = store.get();
  assert.throws(
    () => store.mutate({ type: 'settings', value: { offerAutoSaveOnStart: 'false' } }),
    /开始游戏偏好无效/,
  );
  assert.deepEqual(store.get(), before);
  assert.deepEqual(new Store(store.dir, catalog).get(), before);
});

test('a changed directory during confirmation prevents all setup', async (t) => {
  const { start, calls, store, saves, timeline } = setup(t);
  start.confirm = async () => {
    store.setPath('savePath', 'other-account');
    return true;
  };
  await assert.rejects(start.start(), /目录已改变/);
  assert.deepEqual(calls, []);
  assert.equal(saves.list().length, 0);
  assert.equal(timeline.data.enabled, false);
});

test('native checks follow consent while interrupted operations and exit block all preparation', async (t) => {
  for (const block of ['account', 'running', 'pending', 'restore', 'version', 'quitting']) {
    const { start, bridge, timeline, saves, calls } = setup(t);
    if (block === 'account') bridge.account = () => '76561190000000009';
    if (block === 'running') bridge.canStop = () => false;
    if (block === 'pending') timeline.data.pending = { type: 'save' };
    if (block === 'restore') saves.pendingRestore = () => ({ pending: true });
    if (block === 'version')
      bridge.location = () => {
        throw Error('unsupported game');
      };
    if (block === 'quitting') start.quitting = () => true;
    await assert.rejects(start.start());
    assert.deepEqual(calls, ['account', 'running', 'version'].includes(block) ? ['confirm'] : [], block);
    assert.equal(timeline.data.enabled, false, block);
    assert.equal(saves.list().length, 0, block);
  }
});

test('backup verification fails before installing any component or reserving the slot', async (t) => {
  const { start, saves, calls, timeline, slot, original } = setup(t);
  saves.verify = () => {
    throw Error('backup damaged');
  };
  await assert.rejects(start.start(), /backup damaged/);
  assert.deepEqual(calls, ['confirm']);
  assert.equal(timeline.data.enabled, false);
  assert.equal(timeline.data.ownerHash, '');
  assert.deepEqual(fs.readFileSync(slot), original);
});

test('a slot changed after backup is neither adopted nor overwritten', async (t) => {
  const { start, bridge, timeline, slot, saves } = setup(t);
  const foreign = syntheticSave({ full: true, seconds: 900 });
  bridge.install = () => {
    fs.writeFileSync(slot, foreign);
    return { installed: true };
  };
  await assert.rejects(start.start(), /与保护副本不一致/);
  assert.equal(timeline.data.enabled, false);
  assert.equal(timeline.data.ownerHash, '');
  assert.deepEqual(fs.readFileSync(slot), foreign);
  assert.equal(saves.list().length, 1);
});

test('failed component setup keeps its verified backup and does not enable native saves', async (t) => {
  const { start, bridge, saves, timeline, slot, original } = setup(t);
  bridge.install = () => {
    throw Error('component conflict');
  };
  await assert.rejects(start.start(), /component conflict/);
  assert.equal(timeline.data.enabled, false);
  assert.equal(timeline.data.ownerHash, '');
  assert.deepEqual(saves.verify(saves.list()[0].id).buffers.get('29.sav'), original);
  assert.deepEqual(fs.readFileSync(slot), original);
});

test('a simultaneous request cannot create a second confirmation or setup', async (t) => {
  const { start, calls, timeline } = setup(t);
  let finish;
  start.confirm = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = start.start();
  await assert.rejects(start.start(), /正在准备/);
  finish(false);
  assert.deepEqual(await first, { cancelled: true });
  assert.deepEqual(calls, []);
  assert.equal(timeline.data.enabled, false);
  assert.equal(start.running, false);
});

test('ordinary timeline configuration still rejects a foreign slot without protected enablement', (t) => {
  const { timeline, source, slot, original } = setup(t);
  assert.throws(() => timeline.configure(source, true, 10), /其他进度/);
  assert.equal(timeline.data.enabled, false);
  assert.equal(timeline.data.ownerHash, '');
  assert.equal(sha(fs.readFileSync(slot)), sha(original));
});
