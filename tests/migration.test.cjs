'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const migration = require('../src/core/migration.cjs');
const MAGIC = Buffer.from('YIJIANPKG00000001');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const backupId = '2026-10-08T10-00-00-000-_11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-08T10:00:00.000Z';
async function write(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);
}
async function fixture(t) {
  // Every byte is invented, including game-save-like payloads; no real game parser or installation is touched.
  const root = await fsp.mkdtemp(
    path.join(process.env.YIJIAN_MIGRATION_TEST_TMPDIR || os.tmpdir(), 'yijian-migration-test-'),
  );
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('yijian-migration-test-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'source'),
    file = path.join(root, 'portable.yijian-protection');
  const save = Buffer.from([0, 255, 47, 92, 13, 10, 0, 240, 159, 144, 137]);
  const sidecar = Buffer.from('opaque companion data\r\n\0\xff', 'latin1');
  const timelineBytes = crypto.randomBytes(170003),
    timelineHash = sha(timelineBytes);
  const journal = {
    schema: 1,
    activeProfileId: 'profile-1',
    profiles: [
      {
        id: 'profile-1',
        name: '江湖记录',
        stage: 3,
        stageConfirmed: true,
        checks: { 'guide-example': 'done' },
        favorites: ['guide-example'],
        notes: '私人笔记\r\n原始换行',
        goals: [
          {
            id: 'goal-1',
            title: '寻找线索',
            detail: '回顾',
            done: false,
            pinned: true,
            createdAt: at,
            source: { type: 'guide', id: 'guide-example' },
          },
        ],
        saveSlot: '29.sav',
        referenceMode: 'slot',
        craftList: [{ id: 'fusion-123', quantity: 2 }],
        reservations: { 123: 4 },
        createdAt: at,
        updatedAt: at,
        ownerHash: 'must-not-activate',
        token: 'profile-secret',
      },
    ],
    settings: {
      spoiler: 'hints',
      autoBackup: true,
      savePath: 'C:\\old\\Steam\\12345678\\SaveGames',
      steamPath: 'C:\\Steam',
      enabled: true,
      token: 'secret',
      steamAccount: '12345678',
      shortcuts: { enabled: true },
    },
    token: 'root-secret',
    updatedAt: at,
  };
  const journalBytes = Buffer.from('\ufeff' + JSON.stringify(journal, null, '\t') + '\r\n');
  const manifest = {
    schema: 1,
    id: backupId,
    label: '全量保护',
    kind: 'manual',
    createdAt: at,
    source: 'C:\\old\\12345678\\SaveGames',
    steamAccount: '12345678',
    token: 'backup-secret',
    files: [
      { name: '29.sav', bytes: save.length, sha256: sha(save), modifiedAt: at },
      { name: 'metadata.bin', bytes: sidecar.length, sha256: sha(sidecar), modifiedAt: at },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 4) + '\r\n');
  const timeline = {
    schema: 1,
    enabled: true,
    interval: 30,
    source: 'C:\\old\\12345678\\SaveGames',
    ownerHash: timelineHash,
    pending: {
      type: 'stage',
      id: nodeId,
      beforeHash: timelineHash,
      targetHash: timelineHash,
      at: 1000,
      token: 'native-token',
    },
    token: 'native-secret',
    retired: [],
    records: [
      {
        id: nodeId,
        hash: timelineHash,
        at: 1000,
        source: 'C:\\old\\12345678\\SaveGames',
        kind: 'manual',
        map: 'LV_World',
        playSeconds: 10,
        bookmarked: true,
        label: '手动书签',
        note: '节点说明',
        ownerHash: 'bad-owner',
        account: '12345678',
      },
    ],
  };
  const timelineJSON = Buffer.from(JSON.stringify(timeline, null, 2) + '\r\n');
  await write(path.join(dataRoot, 'journal.json'), journalBytes);
  await write(path.join(dataRoot, 'save-backups', backupId, 'manifest.json'), manifestBytes);
  await write(path.join(dataRoot, 'save-backups', backupId, 'files', '29.sav'), save);
  await write(path.join(dataRoot, 'save-backups', backupId, 'files', 'metadata.bin'), sidecar);
  await write(path.join(dataRoot, 'game-timeline', 'timeline.json'), timelineJSON);
  await write(path.join(dataRoot, 'game-timeline', 'blobs', timelineHash + '.sav'), timelineBytes);
  return {
    root,
    dataRoot,
    file,
    save,
    sidecar,
    timelineBytes,
    timelineHash,
    journalBytes,
    manifestBytes,
    timelineJSON,
  };
}
async function unpack(file) {
  const bytes = await fsp.readFile(file),
    length = bytes.readUInt32BE(MAGIC.length);
  const manifest = JSON.parse(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + length));
  let offset = MAGIC.length + 4 + length;
  const entries = manifest.entries.map((entry) => {
    const result = { ...entry, data: bytes.subarray(offset, offset + entry.bytes) };
    offset += entry.bytes;
    return result;
  });
  return { manifest, entries };
}
async function repack(file, value) {
  const manifest = { ...value.manifest, entries: value.entries.map(({ data, ...entry }) => entry) };
  const json = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(header);
  header.writeUInt32BE(json.length, MAGIC.length);
  const payload = Buffer.concat([header, json, ...value.entries.map((e) => e.data)]);
  await fsp.writeFile(file, Buffer.concat([payload, crypto.createHash('sha256').update(payload).digest()]));
}
async function exportFixture(t) {
  const f = await fixture(t);
  f.exported = await migration.exportProtection(f);
  return f;
}

test('protection input failures expose stable categories without replacing precise diagnostics', async (t) => {
  const f = await exportFixture(t),
    original = await fsp.readFile(f.file);
  const invalid = path.join(f.root, 'not-a-package.bin');
  await fsp.writeFile(invalid, Buffer.alloc(40, 7));
  await assert.rejects(migration.previewProtection({ file: invalid }), {
    code: 'PROTECTION_FORMAT_UNSUPPORTED',
  });
  await fsp.writeFile(invalid, Buffer.from('partial'));
  await assert.rejects(migration.previewProtection({ file: invalid }), {
    code: 'PROTECTION_PACKAGE_TRUNCATED',
  });
  const damaged = Buffer.from(original);
  damaged[damaged.length - 1] ^= 1;
  await fsp.writeFile(invalid, damaged);
  await assert.rejects(
    migration.previewProtection({ file: invalid }),
    (error) => error.code === 'PROTECTION_CHECKSUM_MISMATCH' && /checksum mismatch/.test(error.message),
  );
  assert.deepEqual(await fsp.readFile(f.file), original);
});

test('round trip preserves every source byte and creates only an unbound historical view', async (t) => {
  const f = await exportFixture(t),
    targetDirectory = path.join(f.root, 'new-history');
  const preview = await migration.previewProtection({ file: f.file, targetDirectory });
  assert.equal(preview.destination.conflict, false);
  assert.equal(preview.backups.length, 1);
  assert.equal(preview.nodes, 1);
  assert.equal(preview.bookmarks, 1);
  const imported = await migration.importProtection({
    file: f.file,
    targetDirectory,
    expectedPackageHash: preview.packageHash,
  });
  const view = await migration.readHistory({ directory: targetDirectory });
  assert.equal(view.readOnly, true);
  assert.equal(view.bound, false);
  assert.equal(view.catalogValidated, false);
  assert.equal(view.journal.profiles[0].notes, '私人笔记\r\n原始换行');
  assert.equal(view.journal.profiles[0].saveSlot, '');
  assert.equal(view.journal.profiles[0].referenceMode, 'none');
  assert.equal(view.journal.profiles[0].goals[0].pinned, true);
  assert.equal(view.journal.settings.autoBackup, false);
  assert.equal(view.journal.settings.savePath, '');
  assert.equal(view.journal.settings.steamPath, '');
  assert.equal(view.timeline.enabled, false);
  assert.equal(view.timeline.source, '');
  assert.equal(view.timeline.ownerHash, '');
  assert.equal(view.timeline.pending, null);
  assert.equal(view.timeline.records[0].source, '');
  assert.equal(view.timeline.records[0].note, '节点说明');
  assert.equal(view.timeline.records[0].bookmarked, true);
  const node = await migration.readTimelineNode({ directory: targetDirectory, id: nodeId });
  assert.deepEqual(node.bytes, f.timelineBytes);
  assert.equal(node.record.source, '');
  assert.equal(node.bound, false);
  const portableData = JSON.stringify({ ...view, payloadDirectory: undefined });
  for (const secret of [
    'C:\\\\old',
    '12345678',
    'native-token',
    'root-secret',
    'backup-secret',
    'profile-secret',
  ])
    assert.ok(!portableData.includes(secret));
  assert.equal(view.token, undefined);
  assert.equal(view.timeline.token, undefined);
  assert.equal(view.backups[0].source, '');
  for (const [logical, bytes] of [
    ['originals/journal.json', f.journalBytes],
    [`originals/save-backups/${backupId}/manifest.json`, f.manifestBytes],
    ['originals/game-timeline/timeline.json', f.timelineJSON],
    [`game-timeline/blobs/${f.timelineHash}.sav`, f.timelineBytes],
  ]) {
    assert.deepEqual(await fsp.readFile(path.join(imported.payloadDirectory, ...logical.split('/'))), bytes);
  }
  assert.deepEqual(await fsp.readFile(path.join(f.dataRoot, 'journal.json')), f.journalBytes);
  assert.equal((await fsp.readdir(f.root)).filter((n) => n.startsWith('.migration-')).length, 0);
});

test('full backup files can be read and materialized byte-for-byte into a fresh isolated directory', async (t) => {
  const f = await exportFixture(t),
    targetDirectory = path.join(f.root, 'history');
  await migration.importProtection({ file: f.file, targetDirectory });
  const read = await migration.readBackupFile({ directory: targetDirectory, id: backupId, name: '29.sav' });
  assert.deepEqual(read.bytes, f.save);
  assert.equal(read.backup.bound, false);
  const copyTarget = path.join(f.root, 'recovery-staging');
  const result = await migration.materializeBackup({
    directory: targetDirectory,
    id: backupId,
    targetDirectory: copyTarget,
  });
  assert.deepEqual(await fsp.readFile(path.join(result.payloadDirectory, 'files', '29.sav')), f.save);
  assert.deepEqual(
    await fsp.readFile(path.join(result.payloadDirectory, 'files', 'metadata.bin')),
    f.sidecar,
  );
  assert.deepEqual(
    await fsp.readFile(path.join(result.payloadDirectory, 'provenance-manifest.json')),
    f.manifestBytes,
  );
  const manifest = JSON.parse(await fsp.readFile(path.join(result.payloadDirectory, 'manifest.json')));
  assert.equal(manifest.source, '');
  assert.equal(manifest.readOnly, true);
  assert.equal(manifest.bound, false);
  await assert.rejects(
    migration.materializeBackup({ directory: targetDirectory, id: backupId, targetDirectory: copyTarget }),
    /already exists/,
  );
  await assert.rejects(
    migration.readBackupFile({ directory: targetDirectory, id: backupId, name: '../29.sav' }),
    /Invalid/,
  );
});

test('existing exported protection files and existing personal data cannot be overwritten', async (t) => {
  const f = await exportFixture(t),
    original = await fsp.readFile(f.file),
    targetDirectory = path.join(f.root, 'personal');
  await write(path.join(targetDirectory, 'journal.json'), Buffer.from('current-personal-records'));
  const preview = await migration.previewProtection({ file: f.file, targetDirectory });
  assert.equal(preview.destination.conflict, true);
  await assert.rejects(migration.exportProtection(f), /already exists/);
  await assert.rejects(migration.importProtection({ file: f.file, targetDirectory }), /already exists/);
  assert.deepEqual(await fsp.readFile(f.file), original);
  assert.equal(
    await fsp.readFile(path.join(targetDirectory, 'journal.json'), 'utf8'),
    'current-personal-records',
  );
});

for (const mutation of [
  'truncate-header',
  'truncate-body',
  'truncate-footer',
  'trailing',
  'footer',
  'entry',
]) {
  test(`rejects damaged package: ${mutation}; leaves destination absent and source unchanged`, async (t) => {
    const f = await exportFixture(t),
      good = await fsp.readFile(f.file),
      targetDirectory = path.join(f.root, 'invalid-import');
    let bad = Buffer.from(good);
    if (mutation === 'truncate-header') bad = bad.subarray(0, 18);
    if (mutation === 'truncate-body') bad = bad.subarray(0, Math.floor(bad.length / 2));
    if (mutation === 'truncate-footer') bad = bad.subarray(0, bad.length - 1);
    if (mutation === 'trailing') bad = Buffer.concat([bad, Buffer.from([0])]);
    if (mutation === 'footer') bad[bad.length - 1] ^= 1;
    if (mutation === 'entry') bad[bad.length - 33] ^= 1;
    await fsp.writeFile(f.file, bad);
    await assert.rejects(migration.previewProtection({ file: f.file }));
    await assert.rejects(migration.importProtection({ file: f.file, targetDirectory }));
    await assert.rejects(fsp.stat(targetDirectory), { code: 'ENOENT' });
    assert.deepEqual(await fsp.readFile(path.join(f.dataRoot, 'journal.json')), f.journalBytes);
    assert.equal((await fsp.readdir(f.root)).filter((name) => name.startsWith('.migration-')).length, 0);
  });
}

for (const mutation of [
  'traversal',
  'absolute',
  'windows-drive',
  'backslash',
  'device-name',
  'duplicate',
  'case-duplicate',
  'unreferenced',
  'missing-blob',
  'backup-manifest-hash',
]) {
  test(`rejects crafted checksum-valid manifest: ${mutation}`, async (t) => {
    const f = await exportFixture(t),
      value = await unpack(f.file);
    const chosen = value.entries.find((e) => e.path.endsWith('/29.sav'));
    if (mutation === 'traversal') chosen.path = '../outside.sav';
    if (mutation === 'absolute') chosen.path = '/outside.sav';
    if (mutation === 'windows-drive') chosen.path = 'C:/outside.sav';
    if (mutation === 'backslash') chosen.path = 'save-backups\\other\\29.sav';
    if (mutation === 'device-name') chosen.path = `save-backups/${backupId}/files/CON.sav`;
    if (mutation === 'duplicate') value.entries.push({ ...chosen });
    if (mutation === 'case-duplicate')
      value.entries.push({ ...chosen, path: chosen.path.replace('29.sav', '29.SAV') });
    if (mutation === 'unreferenced')
      value.entries.push({ ...chosen, path: chosen.path.replace('29.sav', '30.sav') });
    if (mutation === 'missing-blob')
      value.entries = value.entries.filter((e) => !e.path.endsWith(f.timelineHash + '.sav'));
    if (mutation === 'backup-manifest-hash') {
      const entry = value.entries.find((e) => e.path.endsWith('/manifest.json'));
      const raw = JSON.parse(entry.data);
      raw.files[0].sha256 = '0'.repeat(64);
      entry.data = Buffer.from(JSON.stringify(raw));
      entry.bytes = entry.data.length;
      entry.sha256 = sha(entry.data);
    }
    await repack(f.file, value);
    await assert.rejects(migration.previewProtection({ file: f.file }));
    const targetDirectory = path.join(f.root, 'invalid');
    await assert.rejects(migration.importProtection({ file: f.file, targetDirectory }));
    await assert.rejects(fsp.stat(targetDirectory), { code: 'ENOENT' });
    await assert.rejects(fsp.stat(path.join(f.root, 'outside.sav')), { code: 'ENOENT' });
  });
}

test('rejects count, byte, metadata and node limits and cannot raise built-in ceilings', async (t) => {
  const f = await exportFixture(t);
  for (const limits of [
    { entries: 1 },
    { totalBytes: 1000 },
    { fileBytes: 10 },
    { journalBytes: 100 },
    { manifestBytes: 10 },
  ]) {
    await assert.rejects(migration.previewProtection({ file: f.file, limits }));
    await assert.rejects(
      migration.importProtection({
        file: f.file,
        targetDirectory: path.join(f.root, crypto.randomUUID()),
        limits,
      }),
    );
  }
  await assert.rejects(migration.previewProtection({ file: f.file, limits: { entries: 999999 } }), /lowered/);
  const value = await unpack(f.file),
    entry = value.entries.find((e) => e.path === 'originals/game-timeline/timeline.json');
  const raw = JSON.parse(entry.data);
  raw.records.push({ ...raw.records[0], id: '33333333-3333-4333-8333-333333333333' });
  entry.data = Buffer.from(JSON.stringify(raw));
  entry.bytes = entry.data.length;
  entry.sha256 = sha(entry.data);
  await repack(f.file, value);
  await assert.rejects(migration.previewProtection({ file: f.file, limits: { nodes: 1 } }), /timeline/);
});

test('imported history reexports byte-identical packages without changing machine bindings', async (t) => {
  const f = await exportFixture(t),
    directory = path.join(f.root, 'history');
  const imported = await migration.importProtection({ file: f.file, targetDirectory: directory });
  const file = path.join(f.root, 'reexported.yijian-protection');
  const exported = await migration.exportHistoricalProtection({ directory, file });
  assert.equal(exported.packageHash, imported.packageHash);
  assert.deepEqual(await fsp.readFile(file), await fsp.readFile(f.file));
  const history = await migration.readHistory({ directory });
  assert.equal(history.journal.profiles[0].referenceMode, 'none');
  assert.equal(history.timeline.enabled, false);
  assert.equal(history.timeline.ownerHash, '');
  await assert.rejects(migration.exportHistoricalProtection({ directory, file }), /already exists/);
  const bytes = await fsp.readFile(file);
  const savePath = path.join(imported.payloadDirectory, 'save-backups', backupId, 'files', '29.sav');
  await fsp.writeFile(savePath, Buffer.alloc(f.save.length));
  const refused = path.join(f.root, 'refused.yijian-protection');
  await assert.rejects(migration.exportHistoricalProtection({ directory, file: refused }), /hash mismatch/);
  await assert.rejects(fsp.stat(refused), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readFile(file), bytes);
});
test('source corrupted backups, missing timeline blobs and invalid metadata fail before publication', async (t) => {
  const f = await fixture(t),
    savePath = path.join(f.dataRoot, 'save-backups', backupId, 'files', '29.sav');
  await fsp.writeFile(savePath, Buffer.alloc(f.save.length));
  await assert.rejects(migration.exportProtection(f), (error) => {
    assert.match(error.message, /完整备份「全量保护」.*29\.sav.*校验/);
    assert.equal(error.code, 'BACKUP_PAYLOAD_INVALID');
    assert.equal(error.backupId, backupId);
    assert.equal(error.directory, path.dirname(path.dirname(savePath)));
    assert.match(error.reason, /文件与原始校验值不一致/);
    return true;
  });
  await assert.rejects(fsp.stat(f.file), { code: 'ENOENT' });
  await fsp.writeFile(savePath, f.save);
  await fsp.unlink(path.join(f.dataRoot, 'game-timeline', 'blobs', f.timelineHash + '.sav'));
  await assert.rejects(migration.exportProtection(f));
  await write(path.join(f.dataRoot, 'game-timeline', 'blobs', f.timelineHash + '.sav'), f.timelineBytes);
  await fsp.writeFile(path.join(f.dataRoot, 'journal.json'), Buffer.from([0xff, 0xff]));
  await assert.rejects(migration.exportProtection(f), /UTF-8/);
});

test('preview package identity must remain unchanged before import', async (t) => {
  const f = await exportFixture(t),
    targetDirectory = path.join(f.root, 'rejected');
  await assert.rejects(
    migration.importProtection({ file: f.file, targetDirectory, expectedPackageHash: '0'.repeat(64) }),
    /changed since preview/,
  );
  await assert.rejects(fsp.stat(targetDirectory), { code: 'ENOENT' });
  assert.equal((await fsp.readdir(f.root)).filter((n) => n.startsWith('.migration-')).length, 0);
});

test('history verification detects post-import bytes/index tampering and ignores edited derived view', async (t) => {
  const f = await exportFixture(t),
    targetDirectory = path.join(f.root, 'history');
  const result = await migration.importProtection({ file: f.file, targetDirectory });
  await fsp.writeFile(
    path.join(result.payloadDirectory, 'history.json'),
    JSON.stringify({ enabled: true, token: 'malicious' }),
  );
  assert.equal((await migration.readHistory({ directory: targetDirectory })).timeline.enabled, false);
  const savePath = path.join(result.payloadDirectory, 'save-backups', backupId, 'files', '29.sav');
  await fsp.writeFile(savePath, Buffer.alloc(f.save.length));
  await assert.rejects(migration.readHistory({ directory: targetDirectory }), /hash mismatch/);
  await assert.rejects(
    migration.materializeBackup({
      directory: targetDirectory,
      id: backupId,
      targetDirectory: path.join(f.root, 'materialized'),
    }),
  );
  await fsp.writeFile(savePath, f.save);
  const indexPath = path.join(result.payloadDirectory, 'package-index.json'),
    index = JSON.parse(await fsp.readFile(indexPath));
  index.createdAt = '2026-10-09T10:00:00.000Z';
  await fsp.writeFile(indexPath, JSON.stringify(index));
  await assert.rejects(migration.readHistory({ directory: targetDirectory }), /checksum mismatch/);
});

test('SaveGames names and symlink ancestry are rejected; source game files remain untouched', async (t) => {
  const f = await exportFixture(t),
    gameRoot = path.join(f.root, 'SaveGames');
  await write(path.join(gameRoot, '29.sav'), Buffer.from('foreign-slot-29'));
  await assert.rejects(
    migration.importProtection({ file: f.file, targetDirectory: path.join(gameRoot, 'history') }),
    /SaveGames/,
  );
  const history = path.join(f.root, 'history');
  await migration.importProtection({ file: f.file, targetDirectory: history });
  await assert.rejects(
    migration.materializeBackup({
      directory: history,
      id: backupId,
      targetDirectory: path.join(gameRoot, 'staging'),
    }),
    /SaveGames/,
  );
  assert.equal(await fsp.readFile(path.join(gameRoot, '29.sav'), 'utf8'), 'foreign-slot-29');
  const link = path.join(f.root, 'linked-source');
  await fsp.symlink(f.dataRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    migration.exportProtection({ dataRoot: link, file: path.join(f.root, 'linked.protection') }),
    /links/,
  );
  await assert.rejects(
    migration.importProtection({ file: f.file, targetDirectory: path.join(link, 'history') }),
    /links/,
  );
});

test('atomic export publication preserves a concurrently created destination', async (t) => {
  const f = await fixture(t),
    originalLink = fsp.link;
  fsp.link = async (temporary, destination) => {
    await fsp.writeFile(destination, 'racing-existing-protection', { flag: 'wx' });
    return originalLink(temporary, destination);
  };
  try {
    await assert.rejects(migration.exportProtection(f), { code: 'EEXIST' });
  } finally {
    fsp.link = originalLink;
  }
  assert.equal(await fsp.readFile(f.file, 'utf8'), 'racing-existing-protection');
});

test('empty existing target is also a conflict; atomic import never renames over it', async (t) => {
  const f = await exportFixture(t),
    targetDirectory = path.join(f.root, 'empty');
  await fsp.mkdir(targetDirectory);
  await assert.rejects(migration.importProtection({ file: f.file, targetDirectory }), /already exists/);
  assert.deepEqual(await fsp.readdir(targetDirectory), []);
});

test('journal-only source imports as read-only history without inventing saves or timeline ownership', async (t) => {
  const f = await fixture(t),
    journalOnly = path.join(f.root, 'journal-only');
  await write(path.join(journalOnly, 'journal.json'), f.journalBytes);
  const file = path.join(f.root, 'journal-only.package');
  const result = await migration.exportProtection({ dataRoot: journalOnly, file });
  assert.equal(result.entries, 1);
  assert.equal(result.nodes, 0);
  assert.deepEqual(result.backups, []);
  const targetDirectory = path.join(f.root, 'journal-only-history');
  await migration.importProtection({ file, targetDirectory });
  const view = await migration.readHistory({ directory: targetDirectory });
  assert.deepEqual(view.timeline.records, []);
  assert.equal(view.timeline.ownerHash, '');
  assert.equal(view.timeline.enabled, false);
});

test('multiple old origins remain distinguishable by opaque groups without retaining machine paths in view', async (t) => {
  const f = await fixture(t),
    indexPath = path.join(f.dataRoot, 'game-timeline', 'timeline.json');
  const raw = JSON.parse(f.timelineJSON);
  raw.records.push({
    ...raw.records[0],
    id: '33333333-3333-4333-8333-333333333333',
    source: 'D:\\another-account\\SaveGames',
    bookmarked: false,
  });
  await fsp.writeFile(indexPath, JSON.stringify(raw));
  await migration.exportProtection(f);
  const targetDirectory = path.join(f.root, 'grouped-history');
  await migration.importProtection({ file: f.file, targetDirectory });
  const view = await migration.readHistory({ directory: targetDirectory });
  assert.equal(view.timeline.records[0].originGroup, 'origin-1');
  assert.equal(view.timeline.records[1].originGroup, 'origin-2');
  assert.equal(view.timeline.records[1].source, '');
  assert.equal(view.timeline.records[1].bookmarked, false);
});
