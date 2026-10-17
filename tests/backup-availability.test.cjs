'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Saves } = require('../src/core/saves.cjs');
const { AutoBackup } = require('../src/core/auto-backup.cjs');
const { protectionStatus } = require('../src/core/protection-status.cjs');
const { listPending: pendingBackupCare } = require('../src/core/backup-care.cjs');
const vm = require('node:vm');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-backup-availability-'));
  t.after(() => {
    assert(
      path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'yijian-backup-availability-'),
    );
    fs.rmSync(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'synthetic-SaveGames'),
    root = path.join(base, 'backups');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), 'synthetic original progress');
  return { base, source, root };
}
test('an unavailable root permits source queries without redirecting, recreating or writing storage', (t) => {
  const { source, root } = fixture(t);
  fs.writeFileSync(root, 'synthetic occupied path');
  assert.throws(() => new Saves(root));
  const saves = new Saves(root, { allowUnavailable: true });
  assert.equal(saves.root, root);
  assert.equal(saves.scan(source).files[0].name, '1.sav');
  assert.throws(() => saves.list());
  assert.throws(() => saves.capture(source));
  assert.equal(saves.pendingRestore().pending, true);
  assert.equal(fs.readFileSync(root, 'utf8'), 'synthetic occupied path');
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'synthetic original progress');
  fs.unlinkSync(root);
  fs.mkdirSync(root);
  assert.equal(saves.pendingRestore(), null);
  const copy = saves.capture(source);
  assert.equal(saves.verify(copy.id).buffers.get('1.sav').toString(), 'synthetic original progress');
});
test('a root replaced by a junction cannot capture, verify or write check results through another directory', (t) => {
  const { source, root, base } = fixture(t),
    foreign = path.join(base, 'synthetic-other-backups');
  const other = new Saves(foreign),
    copy = other.capture(source);
  try {
    fs.symlinkSync(foreign, root, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Junction unavailable');
    throw error;
  }
  const saves = new Saves(root, { allowUnavailable: true });
  assert.throws(() => saves.capture(source));
  assert.throws(() => saves.verify(copy.id));
  assert.throws(() => saves.recordCheck(copy.id, 'must not write'));
  assert.equal(saves.pendingRestore().pending, true);
  assert.equal(fs.existsSync(path.join(foreign, copy.id, 'verification.json')), false);
  assert.equal(other.list().length, 1);
  assert.equal(other.verify(copy.id).buffers.get('1.sav').toString(), 'synthetic original progress');
});

test('a valid configured directory under a redirected parent retains its resolved identity', (t) => {
  const { base, source } = fixture(t),
    actual = path.join(base, 'actual-parent'),
    alias = path.join(base, 'configured-parent');
  fs.mkdirSync(actual);
  try {
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Junction unavailable');
    throw error;
  }
  const saves = new Saves(path.join(alias, 'backups'), { allowUnavailable: true });
  assert.equal(saves.root, fs.realpathSync(path.join(actual, 'backups')));
  assert.equal(
    saves.verify(saves.capture(source).id).buffers.get('1.sav').toString(),
    'synthetic original progress',
  );
});

test('an unavailable root under a redirected parent recovers without accepting a changed parent', (t) => {
  const { base, source } = fixture(t),
    actual = path.join(base, 'actual-parent'),
    alias = path.join(base, 'configured-parent'),
    other = path.join(base, 'other-parent');
  fs.mkdirSync(actual);
  fs.mkdirSync(other);
  try {
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Junction unavailable');
    throw error;
  }
  const root = path.join(actual, 'backups');
  fs.writeFileSync(root, 'occupied synthetic root');
  const saves = new Saves(path.join(alias, 'backups'), { allowUnavailable: true });
  assert.equal(saves.root, path.join(fs.realpathSync(actual), 'backups'));
  assert.throws(() => saves.list());
  assert.equal(saves.pendingRestore().pending, true);
  assert.equal(fs.readFileSync(root, 'utf8'), 'occupied synthetic root');
  fs.unlinkSync(root);
  fs.mkdirSync(root);
  fs.unlinkSync(alias);
  fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(saves.pendingRestore(), null);
  assert.deepEqual(saves.list(), []);
  const copy = saves.capture(source);
  assert.equal(saves.verify(copy.id).buffers.get('1.sav').toString(), 'synthetic original progress');
  assert.deepEqual(fs.readdirSync(other), [], 'the new parent target is never used');
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'synthetic original progress');
});

test('an outage observed by health invalidates cached protection before reconnecting and reverifies copies', (t) => {
  const { base, source, root } = fixture(t),
    saves = new Saves(root),
    settings = { autoBackup: true, savePath: source },
    store = { get: () => ({ settings }) },
    jobs = [],
    events = [],
    auto = new AutoBackup(store, saves, (event) => events.push(event), {
      isBlocked: () => pendingBackupCare({ saves }).some((record) => record.blocking !== false),
      schedule: (fn) => {
        const job = { fn, active: true };
        jobs.push(job);
        return job;
      },
      cancel: (job) => {
        job.active = false;
      },
    });
  t.after(() => auto.dispose());
  const settle = () => {
    for (const job of jobs.splice(0)) if (job.active) job.fn();
  };
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8'),
    start = main.indexOf('function autoBackupBlocked('),
    end = main.indexOf('\nfunction sendAction(', start),
    context = {
      fs,
      saves,
      store,
      autoBackup: auto,
      protectionStatus,
      pendingBackupCare,
      bridge: { summary: () => ({ enabled: false }), connected: () => false },
      timeline: { data: { enabled: false } },
      quitRequested: false,
      protectionJobPromise: null,
      tray: null,
      activity: null,
    };
  assert(start >= 0 && end > start);
  vm.createContext(context);
  vm.runInContext(main.slice(start, end) + '\nthis.readHealth = health;', context);
  auto.check();
  settle();
  const originalId = auto.lastBackup.id;
  assert.equal(context.readHealth().protection.ready, true);
  const parked = path.join(base, 'parked-backups');
  fs.renameSync(root, parked);
  fs.writeFileSync(root, 'offline synthetic root');
  assert.equal(context.readHealth().backupUnavailable, true);
  assert.equal(auto.lastBackup, null, 'inspection alone invalidates the cache without an auto timer tick');
  auto.check();
  context.readHealth();
  auto.check();
  context.readHealth();
  assert.equal(
    events.filter((event) => event.type === 'error').length,
    1,
    'repeated observations do not repeat the same failure notification',
  );
  fs.unlinkSync(root);
  fs.renameSync(parked, root);
  fs.writeFileSync(path.join(root, originalId, 'files', '1.sav'), 'damaged while disconnected');
  assert.equal(!!context.readHealth().protection.ready, false);
  let verifications = 0;
  const verify = saves.verify.bind(saves);
  saves.verify = (...args) => {
    verifications++;
    return verify(...args);
  };
  auto.check();
  assert.equal(verifications, 1, 'reconnection must verify the remembered copy');
  assert.equal(
    !!context.readHealth().protection.ready,
    false,
    'a damaged copy cannot restore the green status',
  );
  settle();
  assert.notEqual(auto.lastBackup.id, originalId);
  assert.equal(context.readHealth().protection.ready, true);
  assert.equal(
    saves.verify(auto.lastBackup.id).buffers.get('1.sav').toString(),
    'synthetic original progress',
  );
  assert.equal(
    fs.readFileSync(path.join(root, originalId, 'files', '1.sav'), 'utf8'),
    'damaged while disconnected',
  );
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'synthetic original progress');
});
