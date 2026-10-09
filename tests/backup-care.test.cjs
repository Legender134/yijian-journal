'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Saves } = require('../src/core/saves.cjs');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const migration = require('../src/core/migration.cjs');
const { bindHistoricalBackup } = require('../src/core/migration-recovery.cjs');
const care = require('../src/core/backup-care.cjs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function tree(dir) {
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name),
      stat = fs.lstatSync(file);
    result[name] = stat.isDirectory()
      ? tree(file)
      : stat.isSymbolicLink()
        ? fs.readlinkSync(file)
        : fs.readFileSync(file);
  }
  return result;
}
function size(dir) {
  return fs.readdirSync(dir).reduce((total, name) => {
    const file = path.join(dir, name),
      stat = fs.lstatSync(file);
    return total + (stat.isDirectory() ? size(file) : stat.size);
  }, 0);
}
function fixture(t, kinds = ['manual', 'manual', 'manual']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-backup-care-test-'));
  const game = path.join(root, 'synthetic-game'),
    dataRoot = path.join(root, 'synthetic-data');
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, '1.sav'), crypto.randomBytes(150003));
  fs.writeFileSync(path.join(game, '28.sav'), Buffer.from('synthetic-unrelated-foreign-slot'));
  fs.writeFileSync(path.join(game, 'JHSaveConfig.sav'), Buffer.from('synthetic-save-index'));
  const gameBefore = tree(game);
  t.after(() => {
    assert.deepEqual(
      tree(game),
      gameBefore,
      'every game-source byte and unrelated slot must remain unchanged',
    );
    assert.ok(path.basename(root).startsWith('yijian-backup-care-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  new Store(dataRoot, catalog);
  const saves = new Saves(path.join(dataRoot, 'save-backups'));
  const backups = kinds.map((kind, i) => saves.capture(game, '合成完整副本 ' + (i + 1), kind));
  return {
    root,
    game,
    dataRoot,
    saves,
    backups,
    file: path.join(root, 'synthetic-export.yijian-protection'),
  };
}
async function exported(f, ids = f.backups.map((backup) => backup.id)) {
  const result = await migration.exportProtection({
    dataRoot: f.dataRoot,
    file: f.file,
    backupIds: ids,
    includeTimeline: false,
  });
  return { saves: f.saves, ids, packageFile: f.file, expectedPackageHash: result.packageHash };
}
function backupDir(f, i = 0) {
  return path.join(f.saves.root, f.backups[i].id);
}
function interrupted(f, options, phase) {
  const script = `
    const { Saves } = require(process.env.CARE_TEST_SAVES_MODULE);
    const care = require(process.env.CARE_TEST_CARE_MODULE);
    const options = JSON.parse(process.env.CARE_TEST_OPTIONS);
    options.saves = new Saves(process.env.CARE_TEST_BACKUP_ROOT);
    options.onCheckpoint = ({ phase }) => { if (phase === process.env.CARE_TEST_STOP) process.exit(73); };
    care.cleanupExportedBackups(options).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CARE_TEST_SAVES_MODULE: require.resolve('../src/core/saves.cjs'),
      CARE_TEST_CARE_MODULE: require.resolve('../src/core/backup-care.cjs'),
      CARE_TEST_BACKUP_ROOT: f.saves.root,
      CARE_TEST_OPTIONS: JSON.stringify({ ...options, saves: undefined }),
      CARE_TEST_STOP: phase,
    },
  });
  assert.equal(result.status, 73, result.stderr || result.error?.message);
  const pending = care.listPending({ saves: f.saves });
  assert.equal(pending.length, 1);
  return pending[0];
}
function atomicInterrupted(f, options, phase, rollbackId) {
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const { Saves } = require(process.env.CARE_TEST_SAVES_MODULE);
    const care = require(process.env.CARE_TEST_CARE_MODULE), originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(to) === 'receipt.json' && String(from).startsWith(String(to) + '.') &&
        JSON.parse(fs.readFileSync(from, 'utf8')).phase === process.env.CARE_TEST_STOP) process.exit(73);
      return originalRename(from, to);
    };
    const options = JSON.parse(process.env.CARE_TEST_OPTIONS);
    options.saves = new Saves(process.env.CARE_TEST_BACKUP_ROOT);
    if (process.env.CARE_TEST_ROLLBACK) care.rollbackPending({ saves: options.saves, id: process.env.CARE_TEST_ROLLBACK });
    else care.cleanupExportedBackups(options).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CARE_TEST_SAVES_MODULE: require.resolve('../src/core/saves.cjs'),
      CARE_TEST_CARE_MODULE: require.resolve('../src/core/backup-care.cjs'),
      CARE_TEST_BACKUP_ROOT: f.saves.root,
      CARE_TEST_OPTIONS: JSON.stringify({ ...options, saves: undefined }),
      CARE_TEST_STOP: phase,
      CARE_TEST_ROLLBACK: rollbackId || '',
    },
  });
  assert.equal(result.status, 73, result.stderr || result.error?.message);
  const pending = care.listPending({ saves: f.saves });
  assert.equal(pending.length, 1);
  const dir = path.join(f.saves.root, '.backup-care', pending[0].id);
  const temporary = fs.readdirSync(dir).filter((name) => /^receipt\.json\.[a-f0-9-]+\.tmp$/.test(name));
  assert.equal(temporary.length, 1);
  const tempFile = path.join(dir, temporary[0]),
    tempBytes = fs.readFileSync(tempFile);
  assert.equal(JSON.parse(tempBytes).phase, phase);
  return { pending: pending[0], dir, tempFile, tempBytes };
}
function mutateBackup(f, change) {
  const file = path.join(backupDir(f), 'manifest.json'),
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

test('lock and explicit unlock change only locked, retain opaque metadata and recoverable previous bytes', (t) => {
  const f = fixture(t, ['safety']);
  mutateBackup(f, (manifest) => {
    manifest.custom = { opaque: 'synthetic-extra-property' };
  });
  const before = tree(backupDir(f)),
    originalManifest = JSON.parse(before['manifest.json']);
  assert.equal(care.isBackupLocked(originalManifest), true);
  assert.deepEqual(care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: false }), {
    id: f.backups[0].id,
    locked: false,
    bytes: f.backups[0].files.reduce((n, file) => n + file.bytes, 0),
  });
  const after = tree(backupDir(f));
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after['manifest.json.previous'], before['manifest.json']);
  assert.deepEqual(JSON.parse(after['manifest.json']), { ...originalManifest, locked: false });
  assert.equal(care.isBackupLocked(JSON.parse(after['manifest.json'])), false);
  care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: true });
  assert.equal(care.isBackupLocked(f.saves.verify(f.backups[0].id).manifest), true);
});

test('rebound historical backups can lock and unlock while all unrelated root objects remain unread and unchanged', async (t) => {
  const f = fixture(t, ['manual']),
    originalExport = await exported(f);
  const history = path.join(f.root, 'synthetic-history');
  await migration.importProtection({
    file: f.file,
    targetDirectory: history,
    expectedPackageHash: originalExport.expectedPackageHash,
  });
  const staged = await migration.materializeBackup({
    directory: history,
    id: f.backups[0].id,
    targetDirectory: path.join(f.root, 'synthetic-materialized'),
  });
  const bound = bindHistoricalBackup({
    saves: f.saves,
    payloadDirectory: staged.payloadDirectory,
    source: f.game,
    stopped: () => true,
  });
  const dir = path.join(f.saves.root, bound.id);
  fs.writeFileSync(path.join(dir, 'private-note.txt'), 'unselected-synthetic-note');
  fs.writeFileSync(path.join(dir, 'verification.json'), 'unselected-invalid-synthetic-record');
  fs.mkdirSync(path.join(dir, 'unknown-directory'));
  fs.writeFileSync(path.join(dir, 'unknown-directory', 'nested.txt'), 'unselected-synthetic-child');
  const previousFile = path.join(dir, 'manifest.json.previous'),
    previousBytes = fs.readFileSync(previousFile);
  const damagedPrevious = JSON.parse(previousBytes);
  damagedPrevious.files[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(previousFile, JSON.stringify(damagedPrevious));
  const damagedBefore = tree(dir);
  assert.throws(() => care.setBackupLock({ saves: f.saves, id: bound.id, locked: true }), /previous/);
  assert.deepEqual(tree(dir), damagedBefore);
  fs.writeFileSync(previousFile, previousBytes);
  const before = tree(dir),
    originalRead = fs.readFileSync;
  const forbidden = ['provenance-manifest.json', 'private-note.txt', 'verification.json', 'nested.txt'];
  fs.readFileSync = (file, ...args) => {
    if (typeof file === 'string' && forbidden.includes(path.basename(file)))
      throw Error('unselected object must never be read');
    return originalRead(file, ...args);
  };
  try {
    assert.equal(care.setBackupLock({ saves: f.saves, id: bound.id, locked: true }).locked, true);
    assert.equal(care.setBackupLock({ saves: f.saves, id: bound.id, locked: false }).locked, false);
  } finally {
    fs.readFileSync = originalRead;
  }
  const after = tree(dir);
  for (const name of Object.keys(before).filter(
    (name) => !['manifest.json', 'manifest.json.previous'].includes(name),
  ))
    assert.deepEqual(after[name], before[name]);
  const packageFile = path.join(f.root, 'synthetic-bound-export.yijian-protection');
  const result = await migration.exportProtection({
    dataRoot: f.dataRoot,
    file: packageFile,
    backupIds: [bound.id],
    includeTimeline: false,
  });
  await assert.rejects(
    care.cleanupExportedBackups({
      saves: f.saves,
      ids: [bound.id],
      packageFile,
      expectedPackageHash: result.packageHash,
    }),
    /未知文件或目录/,
  );
  assert.deepEqual(tree(dir), after);
});

for (const kind of ['manual', 'safety'])
  test(kind + ' locked backup refuses cleanup without moving any selected backup', async (t) => {
    const f = fixture(t, [kind, 'manual']);
    if (kind === 'manual') care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: true });
    const options = await exported(f),
      before = tree(f.saves.root);
    await assert.rejects(care.cleanupExportedBackups(options), /已锁定/);
    assert.deepEqual(tree(f.saves.root), before);
    assert.equal(f.saves.busy, false);
  });

test('default safety protection can be explicitly unlocked, re-exported and cleaned', async (t) => {
  const f = fixture(t, ['safety']),
    old = await exported(f);
  care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: false });
  await assert.rejects(care.cleanupExportedBackups(old), /不完全一致/);
  const secondFile = path.join(f.root, 'synthetic-unlocked.yijian-protection');
  const result = await migration.exportProtection({
    dataRoot: f.dataRoot,
    file: secondFile,
    backupIds: old.ids,
    includeTimeline: false,
  });
  const cleaned = await care.cleanupExportedBackups({
    ...old,
    packageFile: secondFile,
    expectedPackageHash: result.packageHash,
  });
  assert.equal(cleaned.count, 1);
  assert.equal(fs.existsSync(backupDir(f)), false);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal(fs.existsSync(secondFile), true);
});

test('success frees selected payload bytes, preserves exported package and every unselected backup', async (t) => {
  const f = fixture(t),
    ids = f.backups.slice(0, 2).map((backup) => backup.id);
  f.saves.rename(ids[0], '改名后的关键节点');
  f.saves.recordCheck(ids[0]);
  f.saves.recordCheck(ids[0]);
  const options = await exported(f, ids),
    packageBefore = fs.readFileSync(f.file),
    unselected = tree(backupDir(f, 2));
  const before = size(f.saves.root),
    result = await care.cleanupExportedBackups(options);
  assert.equal(result.phase, 'complete');
  assert.deepEqual(result.ids, ids);
  assert.equal(result.count, 2);
  assert.ok(size(f.saves.root) < before - 200000);
  for (const id of ids) assert.equal(fs.existsSync(path.join(f.saves.root, id)), false);
  assert.deepEqual(tree(backupDir(f, 2)), unselected);
  assert.deepEqual(fs.readFileSync(f.file), packageBefore);
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(f.saves.root, '.backup-care', result.id, 'receipt.json')),
  );
  assert.deepEqual(receipt.ids, ids);
  assert.equal(receipt.packageHash, options.expectedPackageHash);
  assert.equal(JSON.stringify(receipt).includes(f.game), false);
});

test('package must contain every exact selected local manifest and payload', async (t) => {
  const f = fixture(t),
    options = await exported(f, [f.backups[0].id]),
    before = tree(f.saves.root);
  await assert.rejects(
    care.cleanupExportedBackups({ ...options, ids: f.backups.map((backup) => backup.id) }),
    /不完全一致/,
  );
  assert.deepEqual(tree(f.saves.root), before);
});

test('ids are strictly unique, valid, present and limited to 1..1000', async (t) => {
  const f = fixture(t, ['manual']),
    options = await exported(f),
    before = tree(f.saves.root);
  for (const ids of [
    [],
    [options.ids[0], options.ids[0]],
    ['../outside'],
    ['2026-10-08T10-00-00-000-_11111111-1111-4111-8111-111111111111'],
    Array(1001).fill(options.ids[0]),
  ])
    await assert.rejects(care.cleanupExportedBackups({ ...options, ids }));
  assert.deepEqual(tree(f.saves.root), before);
});

for (const change of ['manifest', 'valid-payload', 'broken-payload'])
  test('post-export ' + change + ' changes reject before any move', async (t) => {
    const f = fixture(t, ['manual']),
      options = await exported(f);
    if (change === 'manifest')
      mutateBackup(f, (manifest) => {
        manifest.label = '确认后的新名称';
      });
    else {
      const file = path.join(backupDir(f), 'files', '1.sav'),
        bytes = fs.readFileSync(file);
      bytes[0] ^= 1;
      fs.writeFileSync(file, bytes);
      if (change === 'valid-payload')
        mutateBackup(f, (manifest) => {
          manifest.files.find((file) => file.name === '1.sav').sha256 = sha(bytes);
        });
    }
    const before = tree(f.saves.root);
    await assert.rejects(care.cleanupExportedBackups(options), /不完全一致|校验失败/);
    assert.deepEqual(tree(f.saves.root), before);
  });

test('a different valid package at the same path cannot reuse the confirmed export hash', async (t) => {
  const f = fixture(t, ['manual']),
    options = await exported(f),
    backupBefore = tree(f.saves.root);
  const replacement = path.join(f.root, 'replacement.yijian-protection');
  const journalFile = path.join(f.dataRoot, 'journal.json'),
    journal = JSON.parse(fs.readFileSync(journalFile));
  journal.profiles[0].notes = 'changed-synthetic-journal';
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  await migration.exportProtection({
    dataRoot: f.dataRoot,
    file: replacement,
    backupIds: options.ids,
    includeTimeline: false,
  });
  fs.copyFileSync(replacement, f.file);
  await assert.rejects(care.cleanupExportedBackups(options), /保护包在确认后发生变化/);
  assert.deepEqual(tree(f.saves.root), backupBefore);
});

test('a corrupted package and a package located inside backup storage cannot authorize cleanup', async (t) => {
  const f = fixture(t, ['manual']),
    options = await exported(f),
    bytes = fs.readFileSync(f.file);
  const inside = path.join(f.saves.root, 'keep-export.yijian-protection');
  fs.copyFileSync(f.file, inside);
  await assert.rejects(care.cleanupExportedBackups({ ...options, packageFile: inside }), /目录之外/);
  fs.writeFileSync(f.file, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(care.cleanupExportedBackups(options));
  assert.equal(fs.existsSync(backupDir(f)), true);
  assert.deepEqual(fs.readFileSync(inside), bytes);
});

for (const foreign of [
  'top-file',
  'top-directory',
  'payload-file',
  'payload-directory',
  'bad-previous',
  'bad-verification',
])
  test('unknown or invalid ' + foreign + ' is preserved and blocks cleanup', async (t) => {
    const f = fixture(t, ['manual']),
      options = await exported(f),
      dir = backupDir(f);
    if (foreign === 'top-file')
      fs.writeFileSync(path.join(dir, 'private-note.txt'), 'keep-this-synthetic-note');
    if (foreign === 'top-directory') fs.mkdirSync(path.join(dir, 'foreign'));
    if (foreign === 'payload-file')
      fs.writeFileSync(path.join(dir, 'files', 'foreign.sav'), 'foreign-synthetic-save');
    if (foreign === 'payload-directory') fs.mkdirSync(path.join(dir, 'files', 'foreign'));
    if (foreign === 'bad-previous')
      fs.writeFileSync(path.join(dir, 'manifest.json.previous'), '{"schema":999}');
    if (foreign === 'bad-verification')
      fs.writeFileSync(
        path.join(dir, 'verification.json'),
        '{"schema":1,"at":1,"error":"","private":"foreign"}',
      );
    const before = tree(f.saves.root);
    await assert.rejects(care.cleanupExportedBackups(options));
    assert.deepEqual(tree(f.saves.root), before);
  });

for (const link of ['file', 'directory', 'hard-link', 'previous'])
  test(link + ' links never become cleanup or lock-write targets', async (t) => {
    const f = fixture(t, ['manual']),
      options = await exported(f),
      dir = backupDir(f),
      original = path.join(f.root, 'foreign-synthetic-file');
    fs.writeFileSync(original, 'outside-synthetic-bytes');
    try {
      if (link === 'file') fs.symlinkSync(original, path.join(dir, 'foreign.txt'));
      if (link === 'directory')
        fs.symlinkSync(f.game, path.join(dir, 'foreign'), process.platform === 'win32' ? 'junction' : 'dir');
      if (link === 'previous') fs.symlinkSync(original, path.join(dir, 'manifest.json.previous'));
      if (link === 'hard-link') {
        const payload = path.join(dir, 'files', '1.sav');
        fs.linkSync(payload, path.join(f.root, 'synthetic-alias'));
      }
    } catch (error) {
      if (error.code === 'EPERM' && process.platform === 'win32') {
        t.skip('Windows symlink permission unavailable');
        return;
      }
      throw error;
    }
    const before = tree(f.saves.root);
    await assert.rejects(care.cleanupExportedBackups(options));
    if (['file', 'directory'].includes(link)) {
      care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: true });
      const name = link === 'file' ? 'foreign.txt' : 'foreign';
      assert.equal(fs.readlinkSync(path.join(dir, name)), before[f.backups[0].id][name]);
    } else {
      assert.throws(() => care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: true }));
      assert.deepEqual(tree(f.saves.root), before);
    }
    assert.equal(fs.readFileSync(original, 'utf8'), 'outside-synthetic-bytes');
  });

test('source change after first group validation is rejected before receipt or rename', async (t) => {
  const f = fixture(t),
    options = await exported(f);
  await assert.rejects(
    care.cleanupExportedBackups({
      ...options,
      onCheckpoint: ({ phase }) => {
        if (phase === 'validated')
          mutateBackup(f, (manifest) => {
            manifest.label = 'changed-after-group-validation';
          });
      },
    }),
    /发生变化/,
  );
  assert.equal(fs.existsSync(path.join(f.saves.root, '.backup-care')), false);
  assert.equal(f.saves.list().length, 3);
});

test('pre-deletion error rolls back every staged backup, retaining newly discovered unknown bytes', async (t) => {
  const f = fixture(t),
    options = await exported(f);
  await assert.rejects(
    care.cleanupExportedBackups({
      ...options,
      onCheckpoint: ({ phase, transactionId }) => {
        if (phase === 'before-delete')
          fs.writeFileSync(
            path.join(f.saves.root, '.backup-care', transactionId, f.backups[0].id, 'foreign.txt'),
            'preserve-this-new-object',
          );
      },
    }),
    /未知/,
  );
  assert.equal(f.saves.list().length, 3);
  assert.equal(fs.readFileSync(path.join(backupDir(f), 'foreign.txt'), 'utf8'), 'preserve-this-new-object');
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
});

test('package change immediately before deletion rolls all staged backups back', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    before = f.backups.map((_, i) => tree(backupDir(f, i)));
  await assert.rejects(
    care.cleanupExportedBackups({
      ...options,
      onCheckpoint: ({ phase }) => {
        if (phase === 'before-delete') fs.appendFileSync(f.file, Buffer.from([0]));
      },
    }),
  );
  f.backups.forEach((_, i) => assert.deepEqual(tree(backupDir(f, i)), before[i]));
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
});

test('process interruption after one rename is visible and can roll every exact backup back', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    before = f.backups.map((_, i) => tree(backupDir(f, i)));
  const pending = interrupted(f, options, 'backup-staged');
  assert.equal(pending.phase, 'staging');
  assert.equal(pending.canRollback, true);
  assert.deepEqual(pending.ids, options.ids);
  assert.equal(JSON.stringify(pending).includes(f.game), false);
  assert.throws(() => care.setBackupLock({ saves: f.saves, id: f.backups[1].id, locked: true }), /尚未完成/);
  await assert.rejects(care.cleanupExportedBackups(options), /尚未完成/);
  const result = care.rollbackPending({ saves: f.saves, id: pending.id });
  assert.equal(result.phase, 'rolled-back');
  f.backups.forEach((_, i) => assert.deepEqual(tree(backupDir(f, i)), before[i]));
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
});

test('process interruption after one rename can finish only after rechecking the bound package', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    pending = interrupted(f, options, 'backup-staged');
  await assert.rejects(
    care.finishPending({ ...options, id: pending.id, expectedPackageHash: '0'.repeat(64) }),
    /原先确认/,
  );
  assert.equal(care.listPending({ saves: f.saves }).length, 1);
  const result = await care.finishPending({ ...options, id: pending.id });
  assert.equal(result.count, 3);
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
});

test('process interruption after one unlink retains recoverable state and refuses unverified resume or rollback', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    packageBefore = fs.readFileSync(f.file),
    pending = interrupted(f, options, 'file-deleted');
  assert.equal(pending.phase, 'deleting');
  assert.equal(pending.canRollback, false);
  assert.throws(() => care.rollbackPending({ saves: f.saves, id: pending.id }), /已开始删除/);
  const stageBefore = tree(path.join(f.saves.root, '.backup-care', pending.id));
  fs.appendFileSync(f.file, Buffer.from([0]));
  await assert.rejects(care.finishPending({ ...options, id: pending.id }));
  assert.deepEqual(tree(path.join(f.saves.root, '.backup-care', pending.id)), stageBefore);
  fs.writeFileSync(f.file, packageBefore);
  const result = await care.finishPending({ ...options, id: pending.id });
  assert.equal(result.phase, 'complete');
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
  assert.deepEqual(fs.readFileSync(f.file), packageBefore);
});

test('an unknown object after interrupted unlink is preserved and blocks all further deletion', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    pending = interrupted(f, options, 'file-deleted');
  const stage = path.join(f.saves.root, '.backup-care', pending.id);
  fs.writeFileSync(path.join(stage, f.backups[1].id, 'foreign.txt'), 'foreign-synthetic-object');
  const before = tree(stage);
  await assert.rejects(care.finishPending({ ...options, id: pending.id }), /未知对象/);
  assert.deepEqual(tree(stage), before);
  assert.equal(care.listPending({ saves: f.saves }).length, 1);
});

test('foreign contents claiming a staged original id block rollback and finish without overwrite', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    pending = interrupted(f, options, 'backup-staged');
  fs.mkdirSync(backupDir(f));
  fs.writeFileSync(path.join(backupDir(f), 'foreign.sav'), 'foreign-synthetic-data');
  const before = tree(f.saves.root);
  assert.throws(() => care.rollbackPending({ saves: f.saves, id: pending.id }), /其他内容占用/);
  await assert.rejects(care.finishPending({ ...options, id: pending.id }), /其他内容占用/);
  assert.deepEqual(tree(f.saves.root), before);
});

test('malformed or unknown transaction leftovers are visible and prevent new cleanup', async (t) => {
  const f = fixture(t, ['manual']),
    options = await exported(f);
  const careRoot = path.join(f.saves.root, '.backup-care');
  fs.mkdirSync(careRoot);
  fs.mkdirSync(path.join(careRoot, crypto.randomUUID()));
  fs.writeFileSync(path.join(careRoot, 'foreign-note.txt'), 'keep-synthetic-note');
  const pending = care.listPending({ saves: f.saves });
  assert.equal(pending.length, 2);
  assert.equal(pending.filter((item) => item.phase === 'blocked' && item.blocking && item.error).length, 1);
  assert.equal(pending.filter((item) => item.phase === 'unstarted' && item.blocking === false).length, 1);
  const before = tree(f.saves.root);
  await assert.rejects(care.cleanupExportedBackups(options), /尚未完成/);
  assert.deepEqual(tree(f.saves.root), before);
});

test('atomic staging publish interruption retains all original bytes and permits a fresh explicitly selected cleanup', async (t) => {
  const f = fixture(t, ['manual']),
    options = await exported(f),
    before = tree(backupDir(f));
  const { pending, tempFile, tempBytes } = atomicInterrupted(f, options, 'staging');
  assert.equal(pending.phase, 'unstarted');
  assert.equal(pending.blocking, false);
  assert.equal(pending.canRollback, false);
  assert.equal(pending.canFinish, false);
  assert.deepEqual(pending.ids, []);
  assert.deepEqual(tree(backupDir(f)), before);
  assert.throws(() => care.rollbackPending({ saves: f.saves, id: pending.id }), /尚未提交/);
  await assert.rejects(care.finishPending({ ...options, id: pending.id }), /尚未提交/);
  const done = await care.cleanupExportedBackups(options);
  assert.equal(done.count, 1);
  assert.deepEqual(fs.readFileSync(tempFile), tempBytes);
  assert.deepEqual(care.listPending({ saves: f.saves }), [pending]);
});

for (const phase of ['ready', 'deleting'])
  for (const mode of ['finish', 'rollback'])
    test(
      'atomic ' +
        phase +
        ' publish interruption permits canonical-based ' +
        mode +
        ' without changing tmp bytes',
      async (t) => {
        const f = fixture(t),
          options = await exported(f),
          before = f.backups.map((_, i) => tree(backupDir(f, i)));
        const { pending, tempFile, tempBytes } = atomicInterrupted(f, options, phase);
        assert.equal(pending.phase, phase === 'ready' ? 'staging' : 'ready');
        assert.equal(pending.blocking, true);
        assert.equal(pending.canRollback, true);
        assert.equal(pending.canFinish, true);
        if (mode === 'finish') {
          const done = await care.finishPending({ ...options, id: pending.id });
          assert.equal(done.count, 3);
          f.backups.forEach((_, i) => assert.equal(fs.existsSync(backupDir(f, i)), false));
        } else {
          const done = care.rollbackPending({ saves: f.saves, id: pending.id });
          assert.equal(done.phase, 'rolled-back');
          f.backups.forEach((_, i) => assert.deepEqual(tree(backupDir(f, i)), before[i]));
        }
        assert.deepEqual(fs.readFileSync(tempFile), tempBytes);
        assert.deepEqual(care.listPending({ saves: f.saves }), []);
      },
    );

test('atomic complete publish interruption resumes from canonical deleting with no payload and keeps its unsaved tmp', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    { pending, tempFile, tempBytes } = atomicInterrupted(f, options, 'complete');
  assert.equal(pending.phase, 'deleting');
  assert.equal(pending.canRollback, false);
  assert.equal(f.saves.list().length, 0);
  assert.throws(() => care.rollbackPending({ saves: f.saves, id: pending.id }), /已开始删除/);
  const done = await care.finishPending({ ...options, id: pending.id });
  assert.equal(done.phase, 'complete');
  assert.deepEqual(fs.readFileSync(tempFile), tempBytes);
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
});

test('atomic rolled-back publish interruption verifies restored originals before committing rollback again', async (t) => {
  const f = fixture(t),
    options = await exported(f),
    before = f.backups.map((_, i) => tree(backupDir(f, i)));
  const staged = interrupted(f, options, 'backup-staged');
  const { pending, tempFile, tempBytes } = atomicInterrupted(f, options, 'rolled-back', staged.id);
  assert.equal(pending.phase, 'staging');
  f.backups.forEach((_, i) => assert.deepEqual(tree(backupDir(f, i)), before[i]));
  care.rollbackPending({ saves: f.saves, id: pending.id });
  f.backups.forEach((_, i) => assert.deepEqual(tree(backupDir(f, i)), before[i]));
  assert.deepEqual(fs.readFileSync(tempFile), tempBytes);
  assert.deepEqual(care.listPending({ saves: f.saves }), []);
});

for (const content of ['malformed', 'mismatched'])
  test(
    'safe ' +
      content +
      ' tmp is neither read nor trusted when canonical receipt authorizes exact remaining cleanup',
    async (t) => {
      const f = fixture(t),
        options = await exported(f, [f.backups[0].id]),
        unchanged = tree(backupDir(f, 1));
      const pending = interrupted(f, options, 'file-deleted'),
        dir = path.join(f.saves.root, '.backup-care', pending.id);
      const tempFile = path.join(dir, 'receipt.json.' + crypto.randomUUID() + '.tmp');
      const fake = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json')));
      fake.phase = 'complete';
      fake.ids = [f.backups[1].id];
      fake.backups = [];
      const tempBytes = Buffer.from(
        content === 'malformed' ? '{unfinished-and-untrusted' : JSON.stringify(fake),
      );
      fs.writeFileSync(tempFile, tempBytes);
      const originalOpen = fs.openSync,
        originalRead = fs.readFileSync,
        originalClose = fs.closeSync,
        tempHandles = new Set();
      fs.openSync = (file, ...args) => {
        const handle = originalOpen(file, ...args);
        if (file === tempFile) tempHandles.add(handle);
        return handle;
      };
      fs.readFileSync = (file, ...args) => {
        if (file === tempFile || tempHandles.has(file)) throw Error('tmp payload must not be read');
        return originalRead(file, ...args);
      };
      fs.closeSync = (handle) => {
        tempHandles.delete(handle);
        return originalClose(handle);
      };
      try {
        assert.equal(care.listPending({ saves: f.saves })[0].phase, 'deleting');
        const done = await care.finishPending({ ...options, id: pending.id });
        assert.deepEqual(done.ids, options.ids);
        assert.deepEqual(care.listPending({ saves: f.saves }), []);
      } finally {
        fs.openSync = originalOpen;
        fs.readFileSync = originalRead;
        fs.closeSync = originalClose;
      }
      assert.deepEqual(fs.readFileSync(tempFile), tempBytes);
      assert.deepEqual(tree(backupDir(f, 1)), unchanged);
    },
  );

for (const content of ['empty-directory', 'partial-tmp', 'mismatched-tmp'])
  test(
    'uncommitted ' +
      content +
      ' has no recovery authorization and does not permanently block backup management',
    async (t) => {
      const f = fixture(t, ['manual']),
        dir = path.join(f.saves.root, '.backup-care', crypto.randomUUID());
      fs.mkdirSync(dir, { recursive: true });
      if (content !== 'empty-directory')
        fs.writeFileSync(
          path.join(dir, 'receipt.json.' + crypto.randomUUID() + '.tmp'),
          content === 'partial-tmp'
            ? '{unfinished'
            : JSON.stringify({
                schema: 1,
                phase: 'deleting',
                ids: ['untrusted-foreign-id'],
                packageHash: '0'.repeat(64),
              }),
        );
      const before = tree(dir),
        pending = care.listPending({ saves: f.saves })[0];
      assert.equal(pending.phase, 'unstarted');
      assert.equal(pending.blocking, false);
      assert.deepEqual(pending.ids, []);
      assert.throws(() => care.rollbackPending({ saves: f.saves, id: pending.id }), /尚未提交/);
      await assert.rejects(
        care.finishPending({
          saves: f.saves,
          id: pending.id,
          packageFile: f.file,
          expectedPackageHash: '0'.repeat(64),
        }),
        /尚未提交/,
      );
      care.setBackupLock({ saves: f.saves, id: f.backups[0].id, locked: true });
      assert.deepEqual(tree(dir), before);
    },
  );

for (const canonical of [false, true])
  for (const unsafe of [
    'wrong-name',
    'oversized',
    'directory',
    'symlink',
    'hard-link',
    'payload',
    'previous',
  ])
    test(
      (canonical ? 'canonical' : 'uncommitted') +
        ' receipt rejects unsafe ' +
        unsafe +
        ' tmp or leftover without following or deleting it',
      async (t) => {
        const f = fixture(t),
          options = await exported(f);
        let dir;
        if (canonical) {
          const pending = interrupted(f, options, 'backup-staged');
          dir = path.join(f.saves.root, '.backup-care', pending.id);
        } else {
          dir = path.join(f.saves.root, '.backup-care', crypto.randomUUID());
          fs.mkdirSync(dir, { recursive: true });
        }
        const tempFile = path.join(dir, 'receipt.json.' + crypto.randomUUID() + '.tmp'),
          outside = path.join(f.root, 'outside-synthetic-meta');
        fs.writeFileSync(outside, 'must-not-follow-or-change');
        try {
          if (unsafe === 'wrong-name') fs.writeFileSync(tempFile + '.foreign', 'unrecognized');
          if (unsafe === 'oversized') {
            fs.writeFileSync(tempFile, '');
            fs.truncateSync(tempFile, 16 * 1024 * 1024 + 1);
          }
          if (unsafe === 'directory') fs.mkdirSync(tempFile);
          if (unsafe === 'symlink') fs.symlinkSync(outside, tempFile);
          if (unsafe === 'hard-link') fs.linkSync(outside, tempFile);
          if (unsafe === 'payload') fs.mkdirSync(path.join(dir, 'unselected-foreign-payload'));
          if (unsafe === 'previous') {
            if (canonical)
              fs.writeFileSync(path.join(dir, 'receipt.json.previous'), 'invalid-canonical-previous');
            else fs.writeFileSync(path.join(dir, 'receipt.json.previous'), 'no-current-authorization');
          }
        } catch (error) {
          if (error.code === 'EPERM' && process.platform === 'win32') {
            t.skip('Windows symlink permission unavailable');
            return;
          }
          throw error;
        }
        const before = tree(f.saves.root),
          pending = care.listPending({ saves: f.saves })[0];
        assert.equal(pending.phase, 'blocked');
        assert.equal(pending.blocking, true);
        assert.throws(() => care.rollbackPending({ saves: f.saves, id: pending.id }));
        await assert.rejects(care.finishPending({ ...options, id: pending.id }));
        await assert.rejects(care.cleanupExportedBackups(options), /尚未完成/);
        assert.deepEqual(tree(f.saves.root), before);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'must-not-follow-or-change');
      },
    );
