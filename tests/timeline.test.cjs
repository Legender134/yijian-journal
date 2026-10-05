'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { Timeline, AGES, writeBytes } = require('../src/core/timeline.cjs');
const { sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { MAX_AUTOMATIC } = require('../src/core/timeline-retention.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-timeline-'));
  const source = path.join(root, '76561190000000000', 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const clock = { at: Date.now() };
  const timeline = new Timeline(path.join(root, 'history'), { now: () => clock.at });
  timeline.configure(source, false, 10);
  const file = path.join(source, '29.sav');
  const save = (seconds) => {
    const b = syntheticSave({ full: true, seconds });
    writeBytes(file, b);
    return timeline.record(b, 'auto', clock.at);
  };
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-timeline-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, clock, timeline, file, save };
}
test('sparse timeline builds all 11 ages, stays bounded, and reports actual gaps and pauses', (t) => {
  const { clock, timeline, save } = setup(t),
    end = clock.at;
  for (let age = 10800; age >= 0; age -= 10) {
    clock.at = end - age * 1000;
    save(20000 - age);
    assert.ok(timeline.data.records.length <= MAX_AUTOMATIC);
  }
  clock.at = end;
  assert.deepEqual(
    timeline.nodes().map((n) => n.seconds),
    AGES,
  );
  for (const n of timeline.nodes()) {
    assert.ok(n.record.ageSeconds >= n.seconds);
    assert.equal(n.record.gapSeconds, n.record.ageSeconds - n.seconds);
    assert.ok(n.record.gapSeconds <= n.toleranceSeconds);
    assert.equal(n.record.playSeconds, 20000 - n.record.ageSeconds);
    assert.equal(timeline.inspect(n.record.id).record.hash, n.record.hash);
  }
  clock.at = end + 75000;
  const short = timeline.nodes().at(-1);
  assert.equal(short.record, null);
  assert.equal(short.nearestAt, end);
  assert.match(short.reason, /附近没有/);
  assert.ok(
    fs.readdirSync(timeline.blobs).length <= MAX_AUTOMATIC + 2,
    'only current bands and prior atomic manifest remain',
  );
});
test('all bookmarks remain accessible after restart and metadata edits preserve save bytes', (t) => {
  const { timeline, clock, save } = setup(t);
  const first = save(5);
  timeline.updateNode(first.id, { bookmarked: true, label: '重要选择', note: '保留原始进度' });
  for (let i = 0; i < 25; i++) {
    clock.at += 10000;
    timeline.record(syntheticSave({ seconds: 20 + i }), 'manual');
  }
  clock.at += 8000000;
  save(100);
  const again = new Timeline(timeline.root, { now: () => clock.at });
  assert.equal(again.summary().bookmarkCount, 26);
  assert.equal(again.summary().protected.length, 26);
  assert.equal(again.summary().history.length, 27);
  const result = again.inspect(first.id);
  assert.equal(result.record.label, '重要选择');
  assert.equal(result.record.note, '保留原始进度');
  assert.equal(sha(result.bytes), first.hash);
  assert.throws(() => again.updateNode(first.id, { at: clock.at }), /无效/);
  assert.throws(() => again.updateNode(first.id, { label: 'x'.repeat(81) }), /无效/);
  again.updateNode(first.id, { bookmarked: false });
  clock.at += 10000;
  writeBytes(path.join(again.data.source, '29.sav'), syntheticSave({ seconds: 120 }));
  again.record(syntheticSave({ seconds: 120 }), 'auto');
  assert.ok(!again.summary().history.some((r) => r.id === first.id));
});
test('checkpoint comparison is recent saved progress to selected checkpoint, including unavailable fields', (t) => {
  const { timeline, clock } = setup(t);
  const old = timeline.record(
    syntheticSave({
      full: true,
      seconds: 10,
      money: 10,
      team: [0],
      inventory: [{ id: 1002, count: 1 }],
      quests: [{ id: 5200, step: 1 }],
    }),
    'manual',
  );
  clock.at += 10000;
  const latest = timeline.record(
    syntheticSave({
      full: true,
      seconds: 20,
      money: 30,
      team: [0, 10047],
      inventory: [{ id: 1002, count: 3 }],
      quests: [{ id: 5200, step: 4 }],
    }),
    'auto',
  );
  const c = timeline.comparison(old.id);
  assert.equal(c.basis.id, latest.id);
  assert.equal(c.comparison.moneyDelta, -20);
  assert.equal(c.comparison.inventory.changes[0].delta, -2);
  assert.equal(c.comparison.quests.changes[0].rightStep, 1);
  assert.equal(c.comparison.team.leftOnly.length, 1);
  clock.at += 10000;
  timeline.record(syntheticSave({ seconds: 30 }), 'auto');
  assert.equal(timeline.comparison(old.id).comparison.moneyDelta, null);
});
test('missing history remains unavailable instead of pretending to cover an hour', (t) => {
  const { timeline, save, clock } = setup(t);
  save(20);
  clock.at += 5000;
  assert.ok(timeline.nodes().every((n) => n.record === null));
  clock.at += 5000;
  assert.ok(
    timeline
      .nodes()
      .slice(0, -1)
      .every((n) => !n.record),
  );
  assert.equal(timeline.nodes().at(-1).record.playSeconds, 20);
});
test('a day without new saves makes every target unavailable and backward clock blocks native dispatch', (t) => {
  const { timeline, save, clock } = setup(t);
  save(10);
  const at = clock.at;
  clock.at += 86400000;
  assert.ok(timeline.nodes().every((n) => n.record === null && n.nearestAt === at));
  clock.at = at - 1000;
  assert.throws(() => timeline.beginSave(crypto.randomUUID(), 'auto'), /系统时间/);
  assert.equal(timeline.data.pending, null);
});
test('an occupied helper slot cannot be claimed and failed configuration preserves state', (t) => {
  const { timeline, file } = setup(t),
    other = syntheticSave({ seconds: 123 });
  fs.writeFileSync(file, other);
  const before = JSON.stringify(timeline.data);
  assert.throws(() => timeline.configure(timeline.data.source, true, 20), /其他进度/);
  assert.equal(JSON.stringify(timeline.data), before);
  assert.equal(sha(fs.readFileSync(file)), sha(other));
});
test('native save receipt requires new stable bytes and durable pending intent', (t) => {
  const { timeline, source, file, clock, save } = setup(t);
  save(30);
  const id = crypto.randomUUID(),
    old = timeline.beginSave(id, 'manual');
  assert.throws(() => timeline.finishSave(id, old), /尚未完成写入/);
  const reopened = new Timeline(timeline.root, { now: () => clock.at });
  assert.equal(reopened.data.pending.id, id);
  assert.equal(reopened.data.enabled, false);
  const next = syntheticSave({ seconds: 60 });
  writeBytes(file, next);
  fs.utimesSync(file, new Date(clock.at + 1000), new Date(clock.at + 1000));
  const r = reopened.finishSave(id, next);
  assert.equal(r.playSeconds, 60);
  assert.equal(reopened.data.pending, null);
  assert.equal(reopened.assertOwned(), path.join(source, '29.sav'));
});
test('an external write after native receipt stops completion and preserves new progress', (t) => {
  const { timeline, file, save, clock } = setup(t);
  save(10);
  const id = crypto.randomUUID();
  timeline.beginSave(id, 'auto');
  const receipt = syntheticSave({ seconds: 20 }),
    external = syntheticSave({ seconds: 999 });
  writeBytes(file, external);
  fs.utimesSync(file, new Date(clock.at + 1000), new Date(clock.at + 1000));
  assert.throws(() => timeline.finishSave(id, receipt), /又发生了变化/);
  assert.throws(() => timeline.cancelUnwritten(id), /已发生变化/);
  assert.equal(sha(fs.readFileSync(file)), sha(external));
  assert.equal(timeline.data.pending.id, id);
});
test('native rejection cancels only an unwritten request', (t) => {
  const { timeline, save } = setup(t);
  save(10);
  const id = crypto.randomUUID();
  timeline.beginSave(id, 'auto');
  timeline.cancelUnwritten(id);
  assert.equal(timeline.data.pending, null);
});
test('staging changes only the dedicated slot and retains a verified pre-load checkpoint', (t) => {
  const { timeline, source, file, save, clock } = setup(t);
  const old = save(10);
  clock.at += 10000;
  const current = save(20);
  fs.writeFileSync(path.join(source, '0.sav'), 'unrelated');
  fs.writeFileSync(path.join(source, 'JHSaveConfig.sav'), 'index');
  const staged = timeline.stage(old.id);
  assert.equal(sha(fs.readFileSync(file)), old.hash);
  assert.equal(timeline.inspect(staged.safetyId).record.hash, current.hash);
  assert.equal(fs.readFileSync(path.join(source, '0.sav'), 'utf8'), 'unrelated');
  assert.equal(fs.readFileSync(path.join(source, 'JHSaveConfig.sav'), 'utf8'), 'index');
});
test('interruption after slot replacement reconciles ownership without overwriting files', (t) => {
  const { timeline, file, save, clock } = setup(t);
  const old = save(10);
  clock.at += 10000;
  save(20);
  const original = fs.renameSync;
  let commits = 0;
  fs.renameSync = function (a, b) {
    if (b === timeline.file && ++commits === 3) throw Error('simulated manifest failure');
    return original(a, b);
  };
  try {
    assert.throws(() => timeline.stage(old.id), /simulated/);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(sha(fs.readFileSync(file)), old.hash);
  const reopened = new Timeline(timeline.root);
  assert.equal(reopened.data.pending.type, 'stage');
  reopened.reconcileStage();
  assert.equal(reopened.data.ownerHash, old.hash);
  assert.equal(reopened.data.enabled, false);
  assert.equal(reopened.data.pending, null);
});
test('interruption recovery preserves a later external modification', (t) => {
  const { timeline, file, save } = setup(t);
  const old = save(10),
    current = save(20);
  timeline.commit({
    ...timeline.data,
    pending: {
      type: 'stage',
      id: crypto.randomUUID(),
      beforeHash: current.hash,
      targetHash: old.hash,
      at: Date.now(),
    },
  });
  const other = syntheticSave({ seconds: 999 });
  writeBytes(file, other);
  assert.throws(() => timeline.reconcileStage(), /外部修改/);
  assert.equal(sha(fs.readFileSync(file)), sha(other));
  assert.ok(timeline.data.pending);
});
test('damaged checkpoints and traversal ids cannot stage a load', (t) => {
  const { timeline, file, save } = setup(t);
  const r = save(10),
    before = sha(fs.readFileSync(file));
  fs.writeFileSync(path.join(timeline.blobs, r.hash + '.sav'), 'corrupt');
  assert.throws(() => timeline.stage(r.id), /校验失败/);
  assert.throws(() => timeline.inspect('../29.sav'), /编号无效/);
  assert.equal(sha(fs.readFileSync(file)), before);
});
test('rolling retention removes only retired automatic blobs and keeps protections and unknown files', (t) => {
  const { timeline, file, clock, save } = setup(t);
  const first = save(10);
  clock.at += 1000;
  const manual = timeline.record(syntheticSave({ seconds: 15 }), 'manual');
  const unknown = syntheticSave({ seconds: 777 }),
    unknownFile = path.join(timeline.blobs, sha(unknown) + '.sav');
  fs.writeFileSync(unknownFile, unknown);
  clock.at += 8000000;
  save(20);
  clock.at += 10000;
  save(30);
  clock.at += 8000000;
  save(40);
  clock.at += 10000;
  save(50);
  assert.ok(!timeline.data.records.some((r) => r.id === first.id));
  assert.equal(timeline.inspect(manual.id).record.playSeconds, 15);
  assert.ok(fs.existsSync(unknownFile));
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(timeline.blobs, first.hash + '.sav')));
});
test('a selected node survives rotation while saving current progress, including a prior protection', (t) => {
  const { timeline, save, clock } = setup(t);
  const old = timeline.record(syntheticSave({ seconds: 5 }), 'before-load');
  const unpin = timeline.pin(old.id);
  const secondPin = timeline.pin(old.id);
  clock.at += 10000;
  save(20);
  const safety = timeline.record(syntheticSave({ seconds: 25 }), 'before-load');
  timeline.collect();
  assert.equal(timeline.inspect(old.id).record.playSeconds, 5);
  assert.equal(timeline.inspect(safety.id).record.playSeconds, 25);
  unpin();
  unpin(); // Releasing one holder twice cannot remove another holder's pin.
  clock.at += 10000;
  save(30);
  assert.equal(timeline.inspect(old.id).record.playSeconds, 5);
  secondPin();
  clock.at += 10000;
  save(40);
  assert.ok(!timeline.data.records.some((r) => r.id === old.id));
  assert.equal(timeline.inspect(safety.id).record.playSeconds, 25);
});
test('corrupt timeline state is preserved and disables all mutation', (t) => {
  const { timeline } = setup(t);
  fs.writeFileSync(timeline.file, '{broken');
  const bad = new Timeline(timeline.root);
  assert.match(bad.error, /记录损坏/);
  assert.throws(() => bad.configure(timeline.data.source, true, 10), /记录损坏/);
  assert.equal(fs.readFileSync(timeline.file, 'utf8'), '{broken');
});
