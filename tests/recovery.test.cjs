'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawnSync } = require('node:child_process');
const { Saves, sha } = require('../src/core/saves.cjs');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-recovery-'));
  t.after(() => {
    if (
      path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) ||
      !path.basename(base).startsWith('yijian-recovery-')
    )
      throw Error('Unsafe test cleanup path');
    fs.rmSync(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'SaveGames'),
    root = path.join(base, 'backups');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), 'old one');
  fs.writeFileSync(path.join(source, '2.sav'), 'old two');
  const saves = new Saves(root),
    snapshot = saves.capture(source, 'original');
  fs.writeFileSync(path.join(source, '1.sav'), 'current one');
  fs.writeFileSync(path.join(source, '2.sav'), 'current two');
  return { base, source, root, saves, snapshot };
}
function values(source) {
  return fs
    .readdirSync(source)
    .filter((n) => !n.startsWith('.yijian-'))
    .map((n) => [n, sha(fs.readFileSync(path.join(source, n)))]);
}
test('explicit backup check results persist across restarts without modifying save or backup bytes', (t) => {
  const { source, root, saves, snapshot } = fixture(t);
  const originalManifest = fs.readFileSync(path.join(root, snapshot.id, 'manifest.json'));
  const originalCopy = fs.readFileSync(path.join(root, snapshot.id, 'files', '1.sav'));
  const current = fs.readFileSync(path.join(source, '1.sav'));
  saves.recordCheck(snapshot.id, '备份文件异常：1.sav');
  assert.match(new Saves(root).list().find((b) => b.id === snapshot.id).verificationError, /1.sav/);
  saves.recordCheck(snapshot.id);
  assert.equal(new Saves(root).list().find((b) => b.id === snapshot.id).verificationError, '');
  assert.deepEqual(fs.readFileSync(path.join(root, snapshot.id, 'manifest.json')), originalManifest);
  assert.deepEqual(fs.readFileSync(path.join(root, snapshot.id, 'files', '1.sav')), originalCopy);
  assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), current);
  assert.throws(() => saves.recordCheck('../foreign', 'invalid'), /编号/);
});
test('backup check metadata cannot follow a linked record or previous copy', (t) => {
  const { base, root, saves, snapshot } = fixture(t);
  const target = path.join(base, 'unrelated-check.json');
  fs.writeFileSync(target, 'keep unrelated bytes');
  for (const name of ['verification.json', 'verification.json.previous']) {
    const linked = path.join(root, snapshot.id, name);
    try {
      fs.symlinkSync(target, linked);
    } catch (e) {
      if (process.platform === 'win32' && e.code === 'EPERM') {
        t.skip('Windows account cannot create file symlinks');
        return;
      }
      throw e;
    }
    assert.throws(() => saves.recordCheck(snapshot.id, 'bad'), /链接文件/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep unrelated bytes');
    fs.unlinkSync(linked);
  }
});
function crash(root, source, snapshot, stopAt = '1.sav') {
  const child = spawnSync(
    process.execPath,
    [path.join(__dirname, 'crash-restore-child.cjs'), root, source, snapshot.id, stopAt],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(child.status, 71, child.stderr);
}
test('write failure after rename rolls all touched files back to verified safety copy', (t) => {
  const { source, saves, snapshot } = fixture(t),
    before = values(source),
    replace = saves._replaceFile.bind(saves);
  let fail = true;
  saves._replaceFile = (...args) => {
    replace(...args);
    if (fail) {
      fail = false;
      throw Error('Injected post-rename IO failure');
    }
  };
  assert.throws(() => saves.restore(snapshot.id, source), /已回退/);
  assert.deepEqual(values(source), before);
  assert.equal(saves.pendingRestore(), null);
  assert.ok(saves.list().some((x) => x.kind === 'safety'));
});
test('process exit after rename is detected on restart and safely recoverable', (t) => {
  const { source, root, snapshot } = fixture(t),
    before = values(source);
  crash(root, source, snapshot);
  const reopened = new Saves(root);
  assert.equal(reopened.pendingRestore().count, 1);
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'old one');
  assert.throws(() => reopened.restore(snapshot.id, source), /上次恢复/);
  reopened.recoverRestore();
  assert.deepEqual(values(source), before);
  assert.equal(new Saves(root).pendingRestore(), null);
});
test('recovery removes only a file introduced by interrupted restore', (t) => {
  const { source, root, snapshot } = fixture(t);
  fs.unlinkSync(path.join(source, '2.sav'));
  fs.writeFileSync(path.join(source, '9.sav'), 'unrelated later slot');
  const before = values(source);
  crash(root, source, snapshot, '2.sav');
  assert.equal(fs.readFileSync(path.join(source, '2.sav'), 'utf8'), 'old two');
  new Saves(root).recoverRestore();
  assert.deepEqual(values(source), before);
});
test('new progress written after interruption blocks recovery before any file changes', (t) => {
  const { source, root, snapshot } = fixture(t);
  crash(root, source, snapshot, '2.sav');
  fs.writeFileSync(path.join(source, '2.sav'), 'new progress after restart');
  const before = values(source),
    reopened = new Saves(root);
  assert.throws(() => reopened.recoverRestore(), /其他修改/);
  assert.deepEqual(values(source), before);
  assert.ok(reopened.pendingRestore());
});
test('persistent IO failure retains recovery intent for the next application run', (t) => {
  const { source, root, saves, snapshot } = fixture(t),
    before = values(source),
    replace = saves._replaceFile.bind(saves);
  let calls = 0;
  saves._replaceFile = (...args) => {
    if (calls++ === 0) replace(...args);
    throw Error('simulated disk failure');
  };
  assert.throws(() => saves.restore(snapshot.id, source), /自动回退尚未完成/);
  assert.ok(saves.pendingRestore());
  new Saves(root).recoverRestore();
  assert.deepEqual(values(source), before);
});
test('external change after the safety snapshot is preserved before any replacement', (t) => {
  const { source, saves, snapshot } = fixture(t);
  let checks = 0;
  const stopped = () => {
    if (++checks === 2) fs.writeFileSync(path.join(source, '1.sav'), 'external cloud update');
    return true;
  };
  assert.throws(() => saves.restore(snapshot.id, source, stopped), /其他修改/);
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'external cloud update');
  assert.equal(fs.readFileSync(path.join(source, '2.sav'), 'utf8'), 'current two');
  assert.equal(saves.pendingRestore(), null);
});
test('external change to a later file stops restore and safely rolls back only earlier replacements', (t) => {
  const { source, saves, snapshot } = fixture(t),
    replace = saves._replaceFile.bind(saves);
  let changed = false;
  saves._replaceFile = (...args) => {
    replace(...args);
    if (!changed) {
      changed = true;
      fs.writeFileSync(path.join(source, '2.sav'), 'external later progress');
    }
  };
  assert.throws(() => saves.restore(snapshot.id, source), /其他修改/);
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'current one');
  assert.equal(fs.readFileSync(path.join(source, '2.sav'), 'utf8'), 'external later progress');
  assert.equal(saves.pendingRestore(), null);
});
test('a concurrent writer after replacement is never overwritten by automatic rollback', (t) => {
  const { source, saves, snapshot } = fixture(t),
    replace = saves._replaceFile.bind(saves);
  saves._replaceFile = (...args) => {
    replace(...args);
    if (args[1] === '2.sav') fs.writeFileSync(path.join(source, '1.sav'), 'new external progress');
  };
  assert.throws(() => saves.restore(snapshot.id, source), /自动回退尚未完成/);
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'new external progress');
  assert.ok(saves.pendingRestore());
  const before = values(source);
  assert.throws(() => saves.recoverRestore(), /其他修改/);
  assert.deepEqual(values(source), before);
});
test('recovery refuses while game runs, with corrupt safety data, or with links', (t) => {
  const { source, root, snapshot } = fixture(t);
  crash(root, source, snapshot);
  const reopened = new Saves(root),
    before = values(source),
    op = reopened.pendingRestore();
  assert.throws(() => reopened.recoverRestore(() => false), /退出/);
  assert.deepEqual(values(source), before);
  fs.writeFileSync(path.join(root, op.safetyId, 'files', '1.sav'), 'tampered');
  assert.throws(() => reopened.recoverRestore(), /异常|校验/);
  assert.deepEqual(values(source), before);
});
test('malformed manifests do not break listing; corrupt operation remains explicit', (t) => {
  const { root, saves, snapshot } = fixture(t),
    p = path.join(root, snapshot.id, 'manifest.json'),
    m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.createdAt = { bad: true };
  fs.writeFileSync(p, JSON.stringify(m));
  assert.deepEqual(saves.list(), []);
  fs.writeFileSync(saves.operationFile, '{bad');
  assert.equal(saves.pendingRestore().pending, true);
  assert.ok(saves.pendingRestore().error);
});
test('unreadable restore records give Chinese guidance without changing saves or protection copies', (t) => {
  const { source, saves, snapshot } = fixture(t),
    before = values(source),
    hashes = saves.verify(snapshot.id).manifest.files.map((f) => f.sha256);
  for (const damaged of ['{broken', '{}']) {
    fs.writeFileSync(saves.operationFile, damaged);
    const pending = saves.pendingRestore();
    assert.equal(pending.pending, true);
    assert.match(pending.error, /恢复记录无法读取.*暂停存档写入/);
    assert.ok(pending.diagnostic);
    assert.equal(pending.recordPath, saves.operationFile);
    assert.throws(() => saves.restore(snapshot.id, source));
    assert.deepEqual(values(source), before);
    assert.equal(fs.readFileSync(saves.operationFile, 'utf8'), damaged);
    assert.deepEqual(saves.verify(snapshot.id).manifest.files.map((f) => f.sha256), hashes);
  }
  const readFile = fs.readFileSync;
  const blockedRead = t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === saves.operationFile) throw Object.assign(Error('synthetic EACCES'), { code: 'EACCES' });
    return readFile.call(this, file, ...args);
  });
  try {
    const pending = saves.pendingRestore();
    assert.equal(pending.pending, true);
    assert.match(pending.error, /恢复记录无法读取/);
    assert.match(pending.diagnostic, /EACCES/);
    assert.deepEqual(values(source), before);
  } finally {
    blockedRead.mock.restore();
  }
});
test('backup preview compares content, reports missing and extra files, and rename preserves bytes', (t) => {
  const { source, saves, snapshot } = fixture(t);
  fs.unlinkSync(path.join(source, '2.sav'));
  fs.writeFileSync(path.join(source, '9.sav'), 'extra');
  const before = values(source),
    view = saves.inspect(snapshot.id, source);
  assert.equal(view.comparison.changed, 1);
  assert.equal(view.comparison.missing, 1);
  assert.equal(view.comparison.extra, 1);
  assert.equal(view.comparison.unchanged, 0);
  assert.deepEqual(values(source), before);
  const hashes = saves.verify(snapshot.id).manifest.files.map((f) => f.sha256);
  saves.rename(snapshot.id, '品剑大会之前');
  assert.equal(saves.list()[0].label, '品剑大会之前');
  assert.deepEqual(
    saves.verify(snapshot.id).manifest.files.map((f) => f.sha256),
    hashes,
  );
  assert.throws(() => saves.rename(snapshot.id, ''));
});
test('restoration retains original save modified times instead of changing the newest slot order', (t) => {
  const { source, saves } = fixture(t),
    old = new Date('2025-01-02T03:04:05.123Z'),
    newer = new Date('2025-02-03T04:05:06.789Z');
  fs.utimesSync(path.join(source, '1.sav'), old, old);
  fs.utimesSync(path.join(source, '2.sav'), newer, newer);
  const snapshot = saves.capture(source);
  fs.writeFileSync(path.join(source, '1.sav'), 'changed');
  fs.writeFileSync(path.join(source, '2.sav'), 'changed two');
  saves.restore(snapshot.id, source);
  assert.ok(Math.abs(fs.statSync(path.join(source, '1.sav')).mtimeMs - old.getTime()) < 1);
  assert.ok(Math.abs(fs.statSync(path.join(source, '2.sav')).mtimeMs - newer.getTime()) < 1);
  assert.equal(saves.scan(source).files[0].name, '2.sav');
});
