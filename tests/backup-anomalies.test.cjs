'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Saves } = require('../src/core/saves.cjs');
const { Store } = require('../src/core/store.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const migration = require('../src/core/migration.cjs');
const complete = require('../src/core/complete-migration.cjs');
const care = require('../src/core/backup-care.cjs');
const { validBackupId, recordProtectionExportResult } = require('../src/core/backup-anomalies.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('./fixtures.cjs');
function machine() {
  const parent = process.env.YIJIAN_ANOMALY_TEST_ROOT || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'yijian-backup-anomaly-'));
  const dataRoot = path.join(root, 'data'),
    source = path.join(root, 'synthetic-SaveGames');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, seconds: 42 }));
  const store = new Store(dataRoot, catalog);
  const saves = new Saves(path.join(dataRoot, 'save-backups'));
  const backup = saves.capture(source, '绝不相信坏清单中的名称');
  const archives = new ProtectionArchives(dataRoot, () => source);
  return { root, dataRoot, source, store, saves, backup, archives, dir: path.join(saves.root, backup.id) };
}
const resultFile = (m) => path.join(m.dataRoot, 'protection-export-result.json');
const unchanged = (m) => {
  assert.equal(fs.readFileSync(path.join(m.dir, 'manifest.json'), 'utf8'), '{');
  assert.deepEqual(
    fs.readFileSync(path.join(m.dir, 'files', '1.sav')),
    fs.readFileSync(path.join(m.source, '1.sav')),
  );
};
test('truncated metadata stays visible without trusted fields; unsafe actions fail and originals remain', async () => {
  const m = machine();
  const good = path.join(m.root, 'good.yijian-protection');
  await complete.exportComplete({ ...m, file: good, recordResult: true });
  assert.equal(complete.readProtectionExportResult(m.dataRoot).status, 'success');
  const healthy = await migration.previewProtection({ file: good });
  fs.writeFileSync(path.join(m.dir, 'manifest.json'), '{');
  assert.deepEqual(m.saves.list(), []);
  const [abnormal] = m.saves.anomalies();
  assert.equal(abnormal.id, m.backup.id);
  assert.equal(abnormal.directory, m.dir);
  assert.equal(abnormal.reasonCode, 'BACKUP_MANIFEST_INVALID_JSON');
  assert.equal(abnormal.recoverable, false);
  for (const field of ['label', 'createdAt', 'count', 'bytes', 'files', 'source', 'locked'])
    assert.equal(field in abnormal, false);
  assert.throws(() => m.saves.restore(m.backup.id, m.source, () => true), /备份清单/);
  assert.throws(() => m.saves.rename(m.backup.id, '伪修复'), /备份清单/);
  await assert.rejects(
    migration.exportProtection({
      ...m,
      file: path.join(m.root, 'selected.yijian-protection'),
      backupIds: [m.backup.id],
      includeTimeline: false,
    }),
    (error) => error.code === 'BACKUP_METADATA_INVALID',
  );
  await assert.rejects(
    care.cleanupExportedBackups({
      saves: m.saves,
      ids: [m.backup.id],
      packageFile: good,
      expectedPackageHash: healthy.packageHash,
    }),
    /备份|清单/,
  );
  const badExport = path.join(m.root, 'failed.yijian-protection');
  await assert.rejects(complete.exportComplete({ ...m, file: badExport, recordResult: true }), (error) => {
    assert.equal(error.code, 'BACKUP_METADATA_INVALID');
    assert.equal(error.backupId, m.backup.id);
    assert.equal(error.reasonCode, 'BACKUP_MANIFEST_INVALID_JSON');
    assert.ok(error.message.includes(m.backup.id));
    return true;
  });
  assert.equal(fs.existsSync(badExport), false);
  assert.equal(fs.existsSync(badExport + '.parts'), false);
  unchanged(m);
  const reopened = new Saves(m.saves.root);
  assert.equal(reopened.anomalies()[0].id, m.backup.id);
  const previousAttempt = complete.readProtectionExportResult(m.dataRoot);
  assert.equal(previousAttempt.status, 'failed');
  assert.equal(previousAttempt.backupId, m.backup.id);
  assert.ok(previousAttempt.message.includes(m.backup.id));
  const imported = await m.archives.import(good, healthy.packageHash);
  const bound = await m.archives.prepareRecovery(imported.id, m.backup.id, reopened, m.source, () => true);
  assert.notEqual(bound.id, m.backup.id);
  assert.deepEqual(
    reopened.verify(bound.id).buffers.get('1.sav'),
    fs.readFileSync(path.join(m.source, '1.sav')),
  );
  unchanged(m);
});
test('missing and illegal manifests remain anomalies; quarantine, staging, unrelated folders and links are excluded', async () => {
  const m = machine();
  fs.unlinkSync(path.join(m.dir, 'manifest.json'));
  assert.equal(m.saves.anomalies()[0].reasonCode, 'BACKUP_MANIFEST_MISSING');
  fs.writeFileSync(
    path.join(m.dir, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      id: m.backup.id,
      label: '不可信名称',
      createdAt: '2060-01-01',
      files: [null],
    }),
  );
  assert.equal(m.saves.anomalies()[0].reasonCode, 'BACKUP_MANIFEST_INVALID_STRUCTURE');
  for (const name of [
    '.backup-care',
    '.migration-stage-test',
    '.migration-binding-test',
    'unrelated',
    '1_' + 'a'.repeat(36),
    '2026-02-31T10-00-00-000-_11111111-1111-4111-8111-111111111111',
  ])
    fs.mkdirSync(path.join(m.saves.root, name));
  const linkedId = '2026-10-08T10-00-00-000-_11111111-1111-4111-8111-111111111111';
  fs.symlinkSync(
    m.source,
    path.join(m.saves.root, linkedId),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(m.saves.anomalies().length, 1);
  assert.throws(() => m.saves.directory(linkedId), /链接|跳转/);
  assert.throws(() => m.saves.directory('../outside'), /编号无效/);
  assert.equal(validBackupId(m.backup.id), true);
  assert.equal(validBackupId('1_' + 'a'.repeat(36)), false);
  const bad = path.join(m.root, 'illegal.yijian-protection');
  await assert.rejects(
    complete.exportComplete({ ...m, file: bad, recordResult: true }),
    (error) =>
      error.code === 'BACKUP_METADATA_INVALID' && error.reasonCode === 'BACKUP_MANIFEST_INVALID_STRUCTURE',
  );
  assert.equal(fs.existsSync(bad), false);
});
test('record IO failures block publication; a second IO failure reports the original backup error too', async () => {
  const blocked = machine();
  fs.mkdirSync(resultFile(blocked));
  const output = path.join(blocked.root, 'must-not-publish.yijian-protection');
  await assert.rejects(
    complete.exportComplete({ ...blocked, file: output, recordResult: true }),
    (error) => error.code === 'EXPORT_RESULT_WRITE_FAILED' && error.published === false,
  );
  assert.equal(fs.existsSync(output), false);
  const m = machine(),
    target = path.join(m.root, 'failed-and-unrecorded.yijian-protection');
  fs.writeFileSync(path.join(m.dir, 'manifest.json'), '{');
  const original = fsp.open;
  let injected = false;
  fsp.open = async function (file, ...args) {
    if (
      !injected &&
      path.basename(String(file)) === 'manifest.json' &&
      fs.realpathSync.native(String(file)) === fs.realpathSync.native(path.join(m.dir, 'manifest.json'))
    ) {
      injected = true;
      // After the durable running record, make only the new failure record unwritable.
      fs.mkdirSync(resultFile(m) + '.previous');
    }
    return original.call(this, file, ...args);
  };
  try {
    await assert.rejects(complete.exportComplete({ ...m, file: target, recordResult: true }), (error) => {
      assert.equal(error.code, 'BACKUP_METADATA_INVALID');
      assert.ok(error.message.includes(m.backup.id));
      assert.ok(error.message.includes('失败原因未能写入'));
      assert.equal(error.recordCode, 'EXPORT_RESULT_WRITE_FAILED');
      return true;
    });
  } finally {
    fsp.open = original;
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(complete.readProtectionExportResult(m.dataRoot).status, 'running');
  assert.ok(complete.readProtectionExportResult(m.dataRoot).message.includes('未能确认完成'));
  unchanged(m);
});
test('result reader never falls back to an old success; directory-only opening does not bless bad metadata', () => {
  const m = machine();
  recordProtectionExportResult(m.dataRoot, {
    status: 'success',
    file: path.join(m.root, 'old'),
    message: '旧成功',
  });
  recordProtectionExportResult(m.dataRoot, {
    status: 'running',
    file: path.join(m.root, 'new'),
    message: '未完成',
  });
  fs.writeFileSync(resultFile(m), '{');
  assert.equal(complete.readProtectionExportResult(m.dataRoot).status, 'failed');
  assert.equal(complete.readProtectionExportResult(m.dataRoot).code, 'EXPORT_RESULT_UNREADABLE');
  fs.writeFileSync(path.join(m.dir, 'manifest.json'), '{');
  assert.equal(m.saves.directory(m.backup.id), m.dir);
  assert.throws(() => m.saves.verify(m.backup.id), /清单/);
});
test('explicitly confirmed historical omission remains a successful export result', async () => {
  const m = machine(),
    original = path.join(m.root, 'history-original.yijian-protection');
  const exported = await complete.exportComplete({ ...m, file: original, recordResult: true });
  const imported = await m.archives.import(original, exported.packageHash);
  fs.appendFileSync(
    path.join(m.archives.directory(imported.id), 'payload', 'save-backups', m.backup.id, 'files', '1.sav'),
    'synthetic damage',
  );
  const output = path.join(m.root, 'confirmed-omission.yijian-protection');
  let question;
  await assert.rejects(complete.exportComplete({ ...m, file: output, recordResult: true }), (error) => {
    assert.equal(error.code, 'HISTORY_EXPORT_CONFIRMATION_REQUIRED');
    question = error;
    return true;
  });
  assert.equal(fs.existsSync(output), false);
  const confirmed = await complete.exportComplete({
    ...m,
    file: output,
    recordResult: true,
    excludedArchiveIds: [imported.id],
    confirmationToken: question.confirmationToken,
  });
  assert.equal(confirmed.omittedArchives.length, 1);
  const recent = complete.readProtectionExportResult(m.dataRoot);
  assert.equal(recent.status, 'success');
  assert.equal(recent.omittedArchives[0].id, imported.id);
  assert.ok(recent.message.includes('经确认未包含 1 份异常历史档案'));
  assert.ok(fs.existsSync(output));
});
test('post-publication record failure truthfully reports the existing verified package', async () => {
  const m = machine(),
    output = path.join(m.root, 'published-result-io-failed.yijian-protection');
  const originalRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (
      to === resultFile(m) &&
      String(from).startsWith(to + '.') &&
      JSON.parse(fs.readFileSync(from, 'utf8')).status === 'success'
    )
      throw Object.assign(Error('synthetic result persistence EIO'), { code: 'EIO' });
    return originalRename.call(this, from, to);
  };
  try {
    await assert.rejects(complete.exportComplete({ ...m, file: output, recordResult: true }), (error) => {
      assert.equal(error.code, 'EXPORT_RESULT_WRITE_FAILED');
      assert.equal(error.published, true);
      assert.equal(error.file, output);
      return true;
    });
  } finally {
    fs.renameSync = originalRename;
  }
  const preview = await migration.previewProtection({ file: output });
  assert.equal(preview.backups[0].id, m.backup.id);
  assert.equal(complete.readProtectionExportResult(m.dataRoot).status, 'running');
});
test('diagnostic persistence cannot write inside the configured game-save source', async () => {
  const m = machine(),
    output = path.join(m.root, 'source-overlap.yijian-protection');
  const before = fs.readdirSync(m.source);
  await assert.rejects(
    complete.exportComplete({ dataRoot: m.source, archives: m.archives, file: output, recordResult: true }),
    /导出已中止/,
  );
  assert.deepEqual(fs.readdirSync(m.source), before);
  assert.equal(fs.existsSync(output), false);
});
