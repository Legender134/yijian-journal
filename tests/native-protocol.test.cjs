'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { GameBridge } = require('../src/core/game-bridge.cjs');
const { Timeline, writeBytes } = require('../src/core/timeline.cjs');
const { sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const os = require('node:os');
function setup(t, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-核心合成 用户 空格-'));
  const source = path.join(root, '原位置 中文游戏', '76561190000000000', 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const timeline = new Timeline(path.join(root, 'history'));
  timeline.configure(source, true, 10);
  if (legacy) {
    const { nativeProtocol, ...old } = timeline.data;
    timeline.commit(old);
  }
  const bridge = new GameBridge(path.join(root, '个人数据 中文', 'game-bridge'), timeline, {
    getGame: () => ({ installed: false }),
    stopped: () => true,
    account: () => '76561190000000000',
  });
  bridge.installation = () => ({ installed: true });
  function pulse() {
    writeBytes(
      path.join(bridge.root, 'state.json'),
      Buffer.from(
        JSON.stringify({
          protocol: 2,
          revision: bridge.revision,
          token: bridge.token,
          source,
          session: '1790000000-123456',
          at: Math.floor(Date.now() / 1000),
          ready: true,
        }),
      ),
    );
  }
  pulse();
  t.after(() => {
    bridge.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, timeline, bridge, pulse };
}
function transport(t, s, callback) {
  const command = path.join(s.bridge.root, 'command.txt');
  const timer = setInterval(() => {
    if (!fs.existsSync(command)) return;
    const rows = fs.readFileSync(command, 'utf8').trimEnd().split('\t');
    if (transport.seen === rows[2]) return;
    transport.seen = rows[2];
    assert.equal(rows.length, 7);
    const base = rows.slice(0, 6).join('\t') + '\n';
    const expected = crypto
      .createHmac('sha256', Buffer.from(s.bridge.token, 'hex'))
      .update(base + s.bridge.grantBinding)
      .digest('hex');
    assert.equal(rows[6], expected);
    callback?.(rows[3]);
    if (rows[3] === 'load') {
      writeBytes(
        path.join(s.bridge.root, 'response.json'),
        Buffer.from(
          JSON.stringify({
            id: rows[2],
            token: s.bridge.token,
            session: rows[1],
            status: 'loaded',
            at: Math.floor(Date.now() / 1000),
          }),
        ),
      );
      return;
    }
    const bytes = syntheticSave({ seconds: 456 });
    writeBytes(path.join(s.source, '29.sav'), bytes);
    writeBytes(path.join(s.bridge.root, 'receipts', rows[2] + '.sav'), bytes);
    writeBytes(
      path.join(s.bridge.root, 'response.json'),
      Buffer.from(
        JSON.stringify({
          id: rows[2],
          token: s.bridge.token,
          session: rows[1],
          status: 'saved',
          at: Math.floor(Date.now() / 1000),
        }),
      ),
    );
  }, 10);
  t.after(() => clearInterval(timer));
}
test('Chinese original source and userData generate signed protocol2 and synthetic save succeeds', async (t) => {
  const s = setup(t);
  assert.equal(s.bridge.nativePathIssue(), '');
  assert.equal(fs.readFileSync(path.join(s.bridge.root, 'config.txt'), 'utf8').split('\n')[0], '2');
  transport(t, s);
  const r = await s.bridge.save();
  assert.equal(r.playSeconds, 456);
  assert.equal(s.timeline.data.pending, null);
  assert.equal(sha(fs.readFileSync(path.join(s.source, '29.sav'))), r.hash);
});
test('protocol1 source enabled state does not become protocol2 authority', async (t) => {
  const s = setup(t, { legacy: true });
  assert.equal(s.timeline.data.enabled, false);
  assert.equal(s.bridge.grantBinding, '');
  assert.equal(fs.readFileSync(path.join(s.bridge.root, 'config.txt'), 'utf8'), 'disabled\n');
  await assert.rejects(s.bridge.save(), /重新明确开启/);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  assert.equal(fs.existsSync(path.join(s.source, '29.sav')), false);
});
test('source selection while disabled drops source-specific native permission', (t) => {
  const s = setup(t),
    next = path.join(s.root, '另一中文来源', '76561190000000000', 'SaveGames');
  fs.mkdirSync(next, { recursive: true });
  s.timeline.configure(next, false, 10);
  s.bridge.connect(next);
  assert.equal(s.timeline.data.nativeProtocol, 0);
  assert.equal(s.bridge.grantBinding, '');
  assert.throws(() => s.bridge.assertReady(), /重新明确开启/);
});
test('foreign slot and wrong account prevent synthetic dispatch without overwriting', (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.source, '29.sav'), 'foreign');
  assert.throws(() => s.timeline.assertOwned(), /其他进度/);
  s.bridge.account = () => '76561190000000001';
  assert.throws(() => s.bridge.assertReady(), /Steam 账户/);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  assert.equal(fs.readFileSync(path.join(s.source, '29.sav'), 'utf8'), 'foreign');
});
test('stopped-game/test and Build checks remain before native install/dispatch', (t) => {
  const s = setup(t);
  s.bridge.installation = GameBridge.prototype.installation.bind(s.bridge);
  s.bridge.test = true;
  assert.throws(() => s.bridge.location(), /测试环境/);
  s.bridge.test = false;
  s.bridge.getGame = () => ({ installed: true, build: '0', path: s.root });
  assert.throws(() => s.bridge.location(), /Build/);
  assert.equal(fs.existsSync(path.join(s.bridge.root, 'command.txt')), false);
  s.bridge.stopped = () => false;
  assert.throws(() => s.bridge.install(), /退出游戏/);
  s.bridge.stopped = () => true;
  s.bridge.heartbeat = () => null;
  assert.throws(() => s.bridge.install(), /Build/);
  assert.equal(fs.existsSync(path.join(s.root, 'Wandering_Sword')), false);
});
test('native load protects current progress and full backup before staging original-source slot', async (t) => {
  const s = setup(t),
    old = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), old);
  const selected = s.timeline.record(old),
    calls = [];
  transport(t, s, (verb) => calls.push(verb));
  const loaded = await s.bridge.load(selected.id, () => {
    calls.push('verified-full-protection');
    assert.equal(s.timeline.data.records.at(-1).playSeconds, 456);
    return { id: 'verified-synthetic-complete-backup' };
  });
  assert.deepEqual(calls, ['save', 'verified-full-protection', 'load']);
  assert.equal(loaded.backupId, 'verified-synthetic-complete-backup');
  assert.deepEqual(fs.readFileSync(path.join(s.source, '29.sav')), old);
  assert.equal(s.timeline.data.pending, null);
});
test('failed current-progress full protection never stages selected history or requests load', async (t) => {
  const s = setup(t),
    old = syntheticSave({ seconds: 10 });
  writeBytes(path.join(s.source, '29.sav'), old);
  const selected = s.timeline.record(old),
    calls = [];
  transport(t, s, (verb) => calls.push(verb));
  await assert.rejects(
    s.bridge.load(selected.id, () => {
      throw Error('synthetic complete protection failure');
    }),
    /complete protection failure/,
  );
  assert.deepEqual(calls, ['save']);
  const latest = s.timeline.data.records.at(-1);
  assert.equal(latest.playSeconds, 456);
  assert.equal(sha(fs.readFileSync(path.join(s.source, '29.sav'))), latest.hash);
});
