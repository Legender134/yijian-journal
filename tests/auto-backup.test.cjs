'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { AutoBackup } = require('../src/core/auto-backup.cjs'),
  { Saves } = require('../src/core/saves.cjs');
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-auto-'));
  t.after(() => {
    if (!path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'yijian-auto-'))
      throw Error('Unsafe test cleanup path');
    fs.rmSync(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), 'initial');
  const settings = { autoBackup: true, savePath: source },
    store = { get: () => ({ settings: { ...settings } }) },
    saves = new Saves(path.join(base, 'backups')),
    events = [],
    jobs = [];
  const options = {
    schedule: (fn) => {
      const job = { fn, active: true };
      jobs.push(job);
      return job;
    },
    cancel: (job) => {
      job.active = false;
    },
  };
  const auto = new AutoBackup(store, saves, (e) => events.push(e), options);
  t.after(() => auto.dispose());
  const settle = () => {
    for (const job of jobs.splice(0)) if (job.active) job.fn();
  };
  return { base, source, settings, store, saves, events, jobs, options, auto, settle };
}
test('automatic backup waits for a stable file set and captures only the settled version', (t) => {
  const { auto, source, saves, settle, jobs } = setup(t);
  auto.check();
  assert.equal(saves.list().length, 0);
  assert.equal(jobs.length, 1);
  auto.check();
  assert.equal(jobs.length, 1);
  fs.writeFileSync(path.join(source, '1.sav'), 'game still saving');
  settle();
  assert.equal(saves.list().length, 0);
  auto.check();
  settle();
  const list = saves.list();
  assert.equal(list.length, 1);
  assert.equal(saves.verify(list[0].id).buffers.get('1.sav').toString(), 'game still saving');
  auto.check();
  settle();
  assert.equal(saves.list().length, 1);
});
test('restarting with a verified identical backup does not create duplicates', (t) => {
  const { auto, store, saves, events, options, settle } = setup(t);
  auto.check();
  settle();
  const restarted = new AutoBackup(store, saves, (e) => events.push(e), options);
  t.after(() => restarted.dispose());
  restarted.check();
  settle();
  assert.equal(saves.list().length, 1);
  assert.equal(events.filter((e) => e.type === 'backup').length, 1);
});

test('same-size content changes with preserved timestamps are backed up, including after restart', (t) => {
  const { auto, source, store, saves, events, options, settle } = setup(t);
  const file = path.join(source, '1.sav'),
    fixed = new Date('2026-01-01T00:00:00Z');
  fs.writeFileSync(file, 'versionA');
  fs.utimesSync(file, fixed, fixed);
  auto.check();
  settle();
  const first = saves.fingerprint(source);
  fs.writeFileSync(file, 'versionB');
  fs.utimesSync(file, fixed, fixed);
  assert.notEqual(saves.fingerprint(source), first);
  auto.check();
  settle();
  assert.equal(saves.list().length, 2);
  assert.equal(saves.verify(saves.list()[0].id).buffers.get('1.sav').toString(), 'versionB');
  auto.dispose();
  fs.writeFileSync(file, 'versionC');
  fs.utimesSync(file, fixed, fixed);
  const restarted = new AutoBackup(store, saves, (e) => events.push(e), options);
  t.after(() => restarted.dispose());
  restarted.check();
  settle();
  assert.equal(saves.list().length, 3);
  assert.equal(saves.verify(saves.list()[0].id).buffers.get('1.sav').toString(), 'versionC');
  restarted.check();
  settle();
  assert.equal(saves.list().length, 3);
});
test('turning off or changing directories cancels the pending capture', (t) => {
  const { auto, base, settings, saves, settle } = setup(t);
  auto.check();
  settings.autoBackup = false;
  settle();
  assert.equal(saves.list().length, 0);
  settings.autoBackup = true;
  auto.check();
  const other = path.join(base, 'OtherSaveGames');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, '2.sav'), 'other progress');
  settings.savePath = other;
  settle();
  assert.equal(saves.list().length, 0);
  auto.check();
  settle();
  assert.equal(saves.list()[0].source, other);
});
test('a native timeline blocks whole-folder backups, including a capture already waiting to settle', (t) => {
  const { auto, source, saves, settle } = setup(t);
  let nativeEnabled = false;
  auto.isBlocked = () => nativeEnabled;
  auto.check();
  nativeEnabled = true;
  settle();
  assert.equal(saves.list().length, 0);
  fs.writeFileSync(path.join(source, '29.sav'), 'native checkpoint');
  auto.check();
  settle();
  assert.equal(saves.list().length, 0);
  nativeEnabled = false;
  auto.check();
  settle();
  assert.equal(saves.list().length, 1);
});
test('an invalid previous snapshot is replaced by a fresh verified automatic copy', (t) => {
  const { auto, source, saves, settle } = setup(t),
    old = saves.capture(source);
  fs.writeFileSync(path.join(saves.root, old.id, 'files', '1.sav'), 'damaged');
  auto.check();
  settle();
  assert.equal(saves.list().length, 2);
  assert.equal(saves.verify(saves.list()[0].id).buffers.get('1.sav').toString(), 'initial');
});
test('repeated failures are reported once and retried after the problem is fixed', (t) => {
  const { auto, saves, events, settle } = setup(t),
    capture = saves.capture.bind(saves);
  saves.capture = () => {
    throw Error('Disk is unavailable');
  };
  auto.check();
  settle();
  auto.check();
  settle();
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.match(auto.error, /Disk/);
  saves.capture = capture;
  auto.check();
  settle();
  assert.equal(auto.error, '');
  assert.equal(saves.list().length, 1);
});
test('unresolved restore and disposal prevent pending automatic writes', (t) => {
  const { auto, saves, settle } = setup(t);
  auto.check();
  saves.pendingRestore = () => ({ pending: true });
  settle();
  assert.equal(saves.list().length, 0);
  saves.pendingRestore = () => null;
  auto.check();
  auto.dispose();
  settle();
  assert.equal(saves.list().length, 0);
});
