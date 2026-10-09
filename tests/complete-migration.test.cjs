'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const complete = require('../src/core/complete-migration.cjs'),
  codec = require('../src/core/protection-collection.cjs');
const migration = require('../src/core/migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const { Store } = require('../src/core/store.cjs'),
  { Saves } = require('../src/core/saves.cjs'),
  { Timeline } = require('../src/core/timeline.cjs');
const catalog = require('../src/data/catalog.cjs'),
  { syntheticSave } = require('./fixtures.cjs');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'yijian-complete-migration-test-'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// Keep this synthetic merge on ordinary file IO. Windows Node's native
// cpSync directory fast path can terminate instead of throwing (#63970).
function copyFixtureTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isDirectory()) copyFixtureTree(from, to);
    else {
      assert.ok(entry.isFile(), 'synthetic fixture must contain only ordinary files');
      fs.copyFileSync(from, to);
    }
  }
}
function treeHashes(directory, excluded = []) {
  const files = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (!relative && excluded.includes(entry.name)) continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else {
        assert.ok(entry.isFile(), 'synthetic fixture must contain only ordinary files');
        files[name] = hash(fs.readFileSync(path.join(directory, name)));
      }
    }
  }
  visit('');
  return files;
}
const currentHashes = (machine) =>
  treeHashes(machine.dataRoot, ['protection-history', 'protection-transfer']);
function damageBackup(archives, id) {
  const payload = path.join(archives.directory(id), 'payload'),
    manifest = JSON.parse(fs.readFileSync(path.join(payload, 'package-index.json'))),
    entry = manifest.entries.find((e) => e.path.startsWith('save-backups/') && e.path.endsWith('/1.sav'));
  assert.ok(entry, 'synthetic archive must contain a full backup');
  const file = path.join(payload, ...entry.path.split('/'));
  fs.appendFileSync(file, 'local synthetic corruption');
  return { file, backupId: entry.path.split('/')[1] };
}
function assertUnpublished(file) {
  assert.equal(fs.existsSync(file), false, 'no final single package may be published');
  assert.equal(fs.existsSync(path.resolve(file) + '.parts'), false, 'no final volumes may be published');
}
async function exportQuestion(sender, file, options = {}) {
  let question;
  await assert.rejects(complete.exportComplete({ ...sender, file, ...options }), (error) => {
    assert.equal(error.code, 'HISTORY_EXPORT_CONFIRMATION_REQUIRED');
    assert.equal(error.recoverable, true);
    assert.ok(error.failedArchives.length > 0);
    assert.equal(typeof error.confirmationToken, 'string');
    question = error;
    return true;
  });
  assertUnpublished(file);
  assert.deepEqual(fs.readdirSync(sender.archives.root('protection-transfer')), []);
  return question;
}
function machine(name, seconds) {
  const dataRoot = path.join(root, name),
    source = path.join(dataRoot, '中文 合成SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const bytes = syntheticSave({ full: true, seconds });
  fs.writeFileSync(path.join(source, '1.sav'), bytes);
  fs.writeFileSync(path.join(source, '28.sav'), 'foreign fixture');
  const store = new Store(dataRoot, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  store.mutate({ type: 'note', value: name + '自己的笔记' });
  new Saves(path.join(dataRoot, 'save-backups')).capture(source, name + '保护');
  const timeline = new Timeline(path.join(dataRoot, 'game-timeline'));
  timeline.configure(source, false, 30);
  const node = timeline.record(bytes, 'manual');
  timeline.updateNode(node.id, { bookmarked: true, label: name + '书签', note: '原说明' });
  return { dataRoot, source, bytes, store, archives: new ProtectionArchives(dataRoot, () => source) };
}
let a, b, c, fileA, fileB;
test.before(async () => {
  a = machine('第一台', 1000);
  b = machine('第二台', 2000);
  c = machine('第三台', 3000);
  fileA = path.join(root, '第一台.yijian-protection');
  await complete.exportComplete({ ...a, file: fileA });
  assert.equal(await codec.isCollection(fileA), false);
  await b.archives.import(fileA);
  fileB = path.join(root, '第二台全部资料.yijian-protection');
  await complete.exportComplete({ ...b, file: fileB });
});
test.after(() => console.log('Retained synthetic complete-migration fixtures: ' + root));
test('one main export includes current data and all prior histories, without replacing the receiving journal or saves', async () => {
  const journal = fs.readFileSync(path.join(c.dataRoot, 'journal.json')),
    foreign = fs.readFileSync(path.join(c.source, '28.sav'));
  const preview = await complete.previewComplete({ archives: c.archives, file: fileB });
  assert.equal(preview.collection, true);
  assert.equal(preview.historicalArchives, 1);
  assert.equal(preview.historicalNodes, 1);
  const imported = await complete.importComplete({
    archives: c.archives,
    file: fileB,
    expectedPackageHash: preview.packageHash,
  });
  assert.equal(imported.archiveIds.length, 2);
  assert.deepEqual(imported.retainedUnverifiedArchives, []);
  assert.equal(c.archives.list().length, 2);
  const views = await Promise.all(imported.archiveIds.map((id) => c.archives.history(id, c.store)));
  assert.deepEqual(views.map((v) => v.timeline.records[0].label).sort(), ['第一台书签', '第二台书签']);
  assert.ok(
    views.every(
      (v) =>
        v.readOnly && !v.bound && v.timeline.records[0].bookmarked && v.timeline.records[0].note === '原说明',
    ),
  );
  assert.deepEqual(fs.readFileSync(path.join(c.dataRoot, 'journal.json')), journal);
  assert.deepEqual(fs.readFileSync(path.join(c.source, '1.sav')), c.bytes);
  assert.deepEqual(fs.readFileSync(path.join(c.source, '28.sav')), foreign);
});
test('repeated import is idempotent and a second migration remains a flat collection of all generations', async () => {
  const repeated = await complete.importComplete({ archives: c.archives, file: fileB });
  assert.equal(repeated.reusedArchives, 2);
  assert.equal(c.archives.list().length, 2);
  const fileC = path.join(root, '第三台全部资料.yijian-protection');
  await complete.exportComplete({ ...c, file: fileC });
  const d = machine('第四台', 4000),
    imported = await complete.importComplete({ archives: d.archives, file: fileC });
  assert.equal(imported.archiveIds.length, 3);
  assert.equal(d.archives.list().length, 3);
  const views = await Promise.all(imported.archiveIds.map((id) => d.archives.history(id, d.store)));
  assert.deepEqual(views.map((v) => v.timeline.records[0].label).sort(), [
    '第一台书签',
    '第三台书签',
    '第二台书签',
  ]);
  const extracted = await codec.scanCollection({
    file: fileC,
    extractionDirectory: path.join(root, '第三次提取'),
  });
  for (const component of extracted.components) assert.equal(await codec.isCollection(component.file), false);
});
test('retry after interruption reuses fully verified registered components and completes the remaining histories', async () => {
  const e = machine('中断机器', 5000),
    realImport = e.archives.import.bind(e.archives);
  let once = true;
  e.archives.import = async (...args) => {
    const result = await realImport(...args);
    if (once) {
      once = false;
      throw Error('synthetic interruption');
    }
    return result;
  };
  await assert.rejects(
    complete.importComplete({ archives: e.archives, file: fileB }),
    /synthetic interruption/,
  );
  assert.equal(e.archives.list().length, 1);
  e.archives.import = realImport;
  const result = await complete.importComplete({ archives: e.archives, file: fileB });
  assert.equal(result.reusedArchives, 1);
  assert.equal(e.archives.list().length, 2);
});
test('a valid original collection restores a damaged imported history as a new readable archive and reuses it on retry', async () => {
  const receiver = machine('损坏历史接收', 5100),
    initial = await complete.importComplete({ archives: receiver.archives, file: fileB }),
    damagedId = initial.archiveIds[1],
    damaged = damageBackup(receiver.archives, damagedId),
    evidence = treeHashes(receiver.archives.directory(damagedId)),
    current = currentHashes(receiver),
    originalPackage = hash(fs.readFileSync(fileB)),
    preview = await complete.previewComplete({ archives: receiver.archives, file: fileB });
  await assert.rejects(receiver.archives.history(damagedId, receiver.store), /size mismatch/);
  const recovered = await complete.importComplete({
    archives: receiver.archives,
    file: fileB,
    expectedPackageHash: preview.packageHash,
  });
  assert.deepEqual(recovered.retainedUnverifiedArchives, [damagedId]);
  assert.equal(recovered.reusedArchives, 1);
  assert.equal(recovered.archiveIds[0], initial.archiveIds[0]);
  assert.notEqual(recovered.archiveIds[1], damagedId);
  assert.equal(receiver.archives.list().length, 3);
  const healthyId = recovered.archiveIds[1],
    history = await receiver.archives.history(healthyId, receiver.store),
    backup = await migration.readBackupFile({
      directory: receiver.archives.directory(healthyId),
      id: damaged.backupId,
      name: '1.sav',
    });
  assert.ok(history.readOnly && !history.bound && history.timeline.records[0].bookmarked);
  assert.equal(history.timeline.records[0].label, '第一台书签');
  assert.deepEqual(backup.bytes, a.bytes);
  assert.deepEqual(treeHashes(receiver.archives.directory(damagedId)), evidence);
  assert.deepEqual(currentHashes(receiver), current);
  assert.equal(hash(fs.readFileSync(fileB)), originalPackage);
  const retried = await complete.importComplete({
    archives: receiver.archives,
    file: fileB,
    expectedPackageHash: preview.packageHash,
  });
  assert.deepEqual(retried.archiveIds, recovered.archiveIds);
  assert.equal(retried.reusedArchives, 2);
  assert.equal(receiver.archives.list().length, 3);
  assert.deepEqual(treeHashes(receiver.archives.directory(damagedId)), evidence);
  assert.deepEqual(currentHashes(receiver), current);
});
test('a bad same-hash receipt candidate cannot block a healthy candidate in either list order', async () => {
  for (const badFirst of [true, false]) {
    const receiver = machine('同哈希候选 ' + badFirst, badFirst ? 5200 : 5300),
      damaged = await receiver.archives.import(fileA),
      healthy = await receiver.archives.import(fileA);
    damageBackup(receiver.archives, damaged.id);
    const evidence = treeHashes(receiver.archives.directory(damaged.id)),
      current = currentHashes(receiver),
      realList = receiver.archives.list.bind(receiver.archives),
      known = realList();
    receiver.archives.list = () =>
      (badFirst ? [damaged.id, healthy.id] : [healthy.id, damaged.id]).map((id) =>
        known.find((archive) => archive.id === id),
      );
    const preview = await complete.previewComplete({ archives: receiver.archives, file: fileA }),
      imported = await complete.importComplete({
        archives: receiver.archives,
        file: fileA,
        expectedPackageHash: preview.packageHash,
      });
    assert.deepEqual(imported.archiveIds, [healthy.id]);
    assert.equal(imported.reusedArchives, 1);
    assert.deepEqual(imported.retainedUnverifiedArchives, badFirst ? [damaged.id] : []);
    assert.equal(realList().length, 2);
    const history = await receiver.archives.history(imported.id, receiver.store);
    assert.ok(history.readOnly && !history.bound);
    assert.deepEqual(treeHashes(receiver.archives.directory(damaged.id)), evidence);
    assert.deepEqual(currentHashes(receiver), current);
  }
});
test('multi-volume retry reports each preserved failed archive once and reuses the healthy replacement across volumes', async () => {
  const receiver = machine('重复分卷接收', 5400),
    damaged = await receiver.archives.import(fileA);
  damageBackup(receiver.archives, damaged.id);
  const evidence = treeHashes(receiver.archives.directory(damaged.id)),
    current = currentHashes(receiver),
    duplicate = path.join(root, '重复分卷.yijian-protection'),
    realList = receiver.archives.list.bind(receiver.archives);
  fs.copyFileSync(fileA, duplicate);
  receiver.archives.list = () => {
    const known = realList();
    return [
      known.find((archive) => archive.id === damaged.id),
      ...known.filter((archive) => archive.id !== damaged.id),
    ];
  };
  const files = [fileA, duplicate],
    preview = await complete.previewCompleteSet({ archives: receiver.archives, files }),
    imported = await complete.importCompleteSet({ archives: receiver.archives, files, preview });
  assert.deepEqual(imported.retainedUnverifiedArchives, [damaged.id]);
  assert.equal(imported.archiveIds[0], imported.archiveIds[1]);
  assert.notEqual(imported.id, damaged.id);
  assert.equal(imported.reusedArchives, 1);
  assert.equal(realList().length, 2);
  const again = await complete.importCompleteSet({ archives: receiver.archives, files, preview });
  assert.deepEqual(again.retainedUnverifiedArchives, [damaged.id]);
  assert.deepEqual(again.archiveIds, imported.archiveIds);
  assert.equal(again.reusedArchives, 2);
  assert.equal(realList().length, 2);
  assert.deepEqual(treeHashes(receiver.archives.directory(damaged.id)), evidence);
  assert.deepEqual(currentHashes(receiver), current);
});
test('invalid input and a changed preview are rejected before any candidate reuse, summary repair or local registration', async () => {
  const receiver = machine('损坏输入接收', 5500),
    initial = await complete.importComplete({ archives: receiver.archives, file: fileB });
  fs.unlinkSync(path.join(receiver.archives.directory(initial.archiveIds[0]), 'archive-summary.json'));
  damageBackup(receiver.archives, initial.archiveIds[1]);
  const before = treeHashes(receiver.dataRoot, ['protection-transfer']),
    realExport = receiver.archives.export.bind(receiver.archives);
  let candidateExports = 0;
  receiver.archives.export = async (...args) => {
    candidateExports++;
    return realExport(...args);
  };
  const corruptSingle = Buffer.from(fs.readFileSync(fileA));
  corruptSingle[corruptSingle.length - 40] ^= 1;
  const corruptCollection = Buffer.from(fs.readFileSync(fileB));
  corruptCollection[corruptCollection.length - 40] ^= 1;
  const original = fs.readFileSync(fileB),
    offset = codec.MAGIC.length + 4,
    headerLength = original.readUInt32BE(codec.MAGIC.length),
    header = JSON.parse(original.subarray(offset, offset + headerLength)),
    firstOffset = offset + headerLength,
    corruptedInner = Buffer.from(original.subarray(firstOffset, firstOffset + header.components[0].bytes));
  corruptedInner[corruptedInner.length - 40] ^= 1;
  header.components[0].sha256 = hash(corruptedInner);
  const metadata = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.from(original.subarray(0, offset));
  prefix.writeUInt32BE(metadata.length, codec.MAGIC.length);
  const content = Buffer.concat([
      prefix,
      metadata,
      corruptedInner,
      original.subarray(firstOffset + header.components[0].bytes, original.length - 32),
    ]),
    validOuterCorruptInner = Buffer.concat([content, crypto.createHash('sha256').update(content).digest()]);
  for (const [name, bytes] of [
    ['损坏单包', corruptSingle],
    ['损坏集合', corruptCollection],
    ['外层完好内包损坏', validOuterCorruptInner],
  ]) {
    const file = path.join(root, name + '.yijian-protection');
    fs.writeFileSync(file, bytes);
    if (name === '外层完好内包损坏') await codec.scanCollection({ file });
    await assert.rejects(complete.importComplete({ archives: receiver.archives, file }));
    assert.deepEqual(treeHashes(receiver.dataRoot, ['protection-transfer']), before);
  }
  await assert.rejects(
    complete.importComplete({
      archives: receiver.archives,
      file: fileB,
      expectedPackageHash: '0'.repeat(64),
    }),
    /预览后/,
  );
  const goodPreview = await complete.previewCompleteSet({
      archives: receiver.archives,
      files: [fileA, fileB],
    }),
    corruptVolume = path.join(root, '损坏集合.yijian-protection');
  await assert.rejects(
    complete.importCompleteSet({
      archives: receiver.archives,
      files: [fileA, corruptVolume],
      preview: goodPreview,
    }),
  );
  assert.equal(candidateExports, 0);
  assert.deepEqual(treeHashes(receiver.dataRoot, ['protection-transfer']), before);
});
test('missing summaries wait until all candidate planning finishes, and interrupted summary repair retries without duplicating payloads', async () => {
  const receiver = machine('缺失摘要接收', 5600),
    initial = await complete.importComplete({ archives: receiver.archives, file: fileB }),
    firstId = initial.archiveIds[0],
    summary = path.join(receiver.archives.directory(firstId), 'archive-summary.json');
  fs.unlinkSync(summary);
  const before = treeHashes(receiver.dataRoot, ['protection-transfer']),
    realExport = receiver.archives.export.bind(receiver.archives),
    realOpen = fs.openSync;
  let laterCandidateSawMissingSummary = false;
  receiver.archives.export = async (id, file) => {
    if (id === initial.archiveIds[1]) laterCandidateSawMissingSummary = !fs.existsSync(summary);
    return realExport(id, file);
  };
  fs.openSync = (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(summary + '.') && file.endsWith('.tmp'))
      throw Error('synthetic summary write interruption');
    return realOpen(file, ...args);
  };
  try {
    await assert.rejects(
      complete.importComplete({ archives: receiver.archives, file: fileB }),
      /synthetic summary write interruption/,
    );
    assert.equal(laterCandidateSawMissingSummary, true);
    assert.deepEqual(treeHashes(receiver.dataRoot, ['protection-transfer']), before);
  } finally {
    fs.openSync = realOpen;
    receiver.archives.export = realExport;
  }
  const retried = await complete.importComplete({ archives: receiver.archives, file: fileB });
  assert.deepEqual(retried.archiveIds, initial.archiveIds);
  assert.equal(retried.reusedArchives, 2);
  assert.deepEqual(retried.retainedUnverifiedArchives, []);
  assert.equal(receiver.archives.list().length, 2);
  assert.equal(JSON.parse(fs.readFileSync(summary)).backups, 1);
  const after = treeHashes(receiver.dataRoot, ['protection-transfer']);
  delete after[path.relative(receiver.dataRoot, summary)];
  assert.deepEqual(after, before);
  assert.ok((await receiver.archives.history(firstId, receiver.store)).readOnly);
});
test('a changed package or corrupt history is refused, existing output and all local game files are preserved', async () => {
  const f = machine('拒绝机器', 6000),
    before = fs.readFileSync(path.join(f.dataRoot, 'journal.json'));
  await assert.rejects(
    complete.importComplete({ archives: f.archives, file: fileB, expectedPackageHash: '0'.repeat(64) }),
    /预览后/,
  );
  assert.equal(f.archives.list().length, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.dataRoot, 'journal.json')), before);
  const archive = b.archives.list()[0],
    payload = path.join(b.archives.directory(archive.id), 'payload');
  const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'package-index.json'))),
    item = manifest.entries.find((e) => e.path.startsWith('save-backups/'));
  fs.appendFileSync(path.join(payload, ...item.path.split('/')), 'corrupt synthetic bytes');
  const target = path.join(root, '不得覆盖');
  fs.writeFileSync(target, 'existing bytes');
  await assert.rejects(complete.exportComplete({ ...b, file: target }), /无法校验历史档案/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing bytes');
  assert.deepEqual(fs.readFileSync(path.join(b.source, '1.sav')), b.bytes);
});

test('after recovery, an explicit omission confirmation migrates current data and every verified history while preserving both damaged originals', async () => {
  const sender = machine('恢复后再迁移', 6100),
    initial = await complete.importComplete({ archives: sender.archives, file: fileB });
  for (const id of initial.archiveIds) damageBackup(sender.archives, id);
  const repaired = await complete.importComplete({ archives: sender.archives, file: fileB });
  assert.deepEqual([...repaired.retainedUnverifiedArchives].sort(), [...initial.archiveIds].sort());
  assert.equal(sender.archives.list().length, 4);
  const before = treeHashes(sender.dataRoot, ['protection-transfer']),
    file = path.join(root, '明确遗漏坏历史.yijian-protection'),
    realExport = sender.archives.export.bind(sender.archives),
    attempted = [];
  sender.archives.export = async (id, target) => {
    attempted.push(id);
    return realExport(id, target);
  };
  const question = await exportQuestion(sender, file);
  assert.deepEqual(
    [...attempted].sort(),
    sender.archives
      .list()
      .map((v) => v.id)
      .sort(),
  );
  assert.deepEqual(question.failedArchives.map((v) => v.id).sort(), [...initial.archiveIds].sort());
  assert.ok(question.failedArchives.every((v) => v.label && /size mismatch/.test(v.reason)));
  assert.deepEqual(treeHashes(sender.dataRoot, ['protection-transfer']), before);
  attempted.length = 0;
  const exported = await complete.exportComplete({
    ...sender,
    file,
    excludedArchiveIds: question.failedArchives.map((v) => v.id).reverse(),
    confirmationToken: question.confirmationToken,
  });
  assert.equal(exported.historicalArchives, 2);
  assert.deepEqual(exported.omittedArchives, question.failedArchives);
  assert.deepEqual(
    [...attempted].sort(),
    sender.archives
      .list()
      .map((v) => v.id)
      .sort(),
  );
  assert.deepEqual(treeHashes(sender.dataRoot, ['protection-transfer']), before);
  const receiver = machine('恢复后迁移接收', 6200),
    receiverBefore = currentHashes(receiver),
    preview = await complete.previewComplete({ archives: receiver.archives, file }),
    imported = await complete.importComplete({
      archives: receiver.archives,
      file,
      expectedPackageHash: preview.packageHash,
    });
  assert.equal(preview.historicalArchives, 2);
  assert.equal(imported.archiveIds.length, 3);
  assert.deepEqual(imported.retainedUnverifiedArchives, []);
  const histories = await Promise.all(
    imported.archiveIds.map((id) => receiver.archives.history(id, receiver.store)),
  );
  assert.deepEqual(histories.map((h) => h.timeline.records[0].label).sort(), [
    '恢复后再迁移书签',
    '第一台书签',
    '第二台书签',
  ]);
  for (const history of histories) {
    const label = history.timeline.records[0].label,
      expected = label === '第一台书签' ? a.bytes : label === '第二台书签' ? b.bytes : sender.bytes,
      backup = await migration.readBackupFile({
        directory: receiver.archives.directory(history.id),
        id: history.backups[0].id,
        name: '1.sav',
      });
    assert.ok(history.readOnly && !history.bound && history.timeline.records[0].bookmarked);
    assert.equal(history.timeline.records[0].note, '原说明');
    assert.deepEqual(backup.bytes, expected);
  }
  assert.deepEqual(currentHashes(receiver), receiverBefore);
  const repeated = await complete.importComplete({ archives: receiver.archives, file });
  assert.deepEqual(repeated.archiveIds, imported.archiveIds);
  assert.equal(repeated.reusedArchives, 3);
  assert.equal(receiver.archives.list().length, 3);
  const next = await exportQuestion(sender, path.join(root, '下一次仍需确认.yijian-protection'));
  assert.deepEqual(
    next.failedArchives,
    question.failedArchives,
    'omissions never persist or suppress future validation',
  );
  assert.deepEqual(treeHashes(sender.dataRoot, ['protection-transfer']), before);
});

test('if every history is damaged, confirmed export honestly reports zero histories and imports only the current protected data', async () => {
  const sender = machine('只有坏历史', 6300),
    damaged = await sender.archives.import(fileA);
  damageBackup(sender.archives, damaged.id);
  const before = treeHashes(sender.dataRoot, ['protection-transfer']),
    file = path.join(root, '只有当前可用.yijian-protection'),
    question = await exportQuestion(sender, file),
    exported = await complete.exportComplete({
      ...sender,
      file,
      excludedArchiveIds: [damaged.id],
      confirmationToken: question.confirmationToken,
    });
  assert.equal(exported.historicalArchives, 0);
  assert.equal(exported.omittedArchives.length, 1);
  assert.equal(exported.omittedArchives[0].id, damaged.id);
  const receiver = machine('只有当前接收', 6400),
    preview = await complete.previewComplete({ archives: receiver.archives, file }),
    imported = await complete.importComplete({ archives: receiver.archives, file });
  assert.equal(preview.historicalArchives, 0);
  assert.equal(imported.archiveIds.length, 1);
  const history = await receiver.archives.history(imported.id, receiver.store),
    backup = await migration.readBackupFile({
      directory: receiver.archives.directory(imported.id),
      id: history.backups[0].id,
      name: '1.sav',
    });
  assert.equal(history.timeline.records[0].label, '只有坏历史书签');
  assert.deepEqual(backup.bytes, sender.bytes);
  assert.deepEqual(treeHashes(sender.dataRoot, ['protection-transfer']), before);
  const published = hash(fs.readFileSync(file));
  await assert.rejects(
    complete.exportComplete({
      ...sender,
      file,
      excludedArchiveIds: [damaged.id],
      confirmationToken: question.confirmationToken,
    }),
    { code: 'HISTORY_EXPORT_CONFIRMATION_EXPIRED' },
  );
  assert.equal(
    hash(fs.readFileSync(file)),
    published,
    'a consumed confirmation cannot be reused or overwrite its output',
  );
});

test('confirmation becomes stale after expiry, archive additions, a new failure, valid healthy changes or any current protected-data change', async () => {
  for (const change of [
    'expiry',
    'new-bad',
    'new-good',
    'new-failure',
    'repaired-bad',
    'healthy-bytes',
    'bad-bytes',
    'journal',
    'backup',
    'timeline',
    'target',
    'scope',
    'wrong-id',
    'duplicate-id',
  ]) {
    const sender = machine('过期确认 ' + change, 6500),
      damaged = await sender.archives.import(fileA),
      healthy = await sender.archives.import(fileA);
    damageBackup(sender.archives, damaged.id);
    const file = path.join(root, '拒绝陈旧 ' + change + '.yijian-protection'),
      question = await exportQuestion(sender, file),
      options = { excludedArchiveIds: [damaged.id], confirmationToken: question.confirmationToken },
      realNow = Date.now;
    let target = file;
    try {
      if (change === 'expiry') Date.now = () => realNow() + 5 * 60 * 1000 + 1;
      else if (change === 'new-bad') damageBackup(sender.archives, (await sender.archives.import(fileA)).id);
      else if (change === 'new-good') await sender.archives.import(fileA);
      else if (change === 'new-failure') damageBackup(sender.archives, healthy.id);
      else if (change === 'repaired-bad') {
        const payload = path.join(sender.archives.directory(damaged.id), 'payload'),
          manifest = JSON.parse(fs.readFileSync(path.join(payload, 'package-index.json'))),
          entry = manifest.entries.find(
            (e) => e.path.startsWith('save-backups/') && e.path.endsWith('/1.sav'),
          );
        fs.writeFileSync(path.join(payload, ...entry.path.split('/')), a.bytes);
        assert.ok((await sender.archives.history(damaged.id, sender.store)).readOnly);
      } else if (change === 'healthy-bytes') {
        const replacement = machine('健康改变替换源', 6550),
          replacementFile = path.join(root, '健康字节改变.yijian-protection');
        await complete.exportComplete({ ...replacement, file: replacementFile });
        const unpacked = await migration.importProtection({
          file: replacementFile,
          targetDirectory: path.join(root, '健康字节改变提取'),
        });
        copyFixtureTree(
          unpacked.payloadDirectory,
          path.join(sender.archives.directory(healthy.id), 'payload'),
        );
        assert.equal(
          (await sender.archives.history(healthy.id, sender.store)).timeline.records[0].label,
          '健康改变替换源书签',
        );
      } else if (change === 'bad-bytes') damageBackup(sender.archives, damaged.id);
      else if (change === 'journal') sender.store.mutate({ type: 'note', value: '确认后当前笔记发生变化' });
      else if (change === 'backup')
        new Saves(path.join(sender.dataRoot, 'save-backups')).capture(sender.source, '确认后增加保护');
      else if (change === 'timeline') {
        const timeline = new Timeline(path.join(sender.dataRoot, 'game-timeline'));
        timeline.updateNode(timeline.data.records[0].id, { note: '确认后书签发生变化' });
      } else if (change === 'target') target = path.join(root, '另一目标.yijian-protection');
      else if (change === 'scope') options.volumeComponents = 1;
      else if (change === 'wrong-id') options.excludedArchiveIds = [healthy.id];
      else if (change === 'duplicate-id') options.excludedArchiveIds = [damaged.id, damaged.id];
      const before = treeHashes(sender.dataRoot, ['protection-transfer']);
      await assert.rejects(
        complete.exportComplete({ ...sender, file: target, ...options }),
        { code: 'HISTORY_EXPORT_CONFIRMATION_EXPIRED' },
        change,
      );
      assertUnpublished(file);
      assertUnpublished(target);
      assert.deepEqual(treeHashes(sender.dataRoot, ['protection-transfer']), before, change);
      assert.deepEqual(fs.readdirSync(sender.archives.root('protection-transfer')), []);
    } finally {
      Date.now = realNow;
    }
  }
});

test('verified duplicate histories are all checked and deduplicated before volume publication, including after an omission confirmation', async () => {
  const sender = machine('健康重复档案', 6600),
    damaged = await sender.archives.import(fileA),
    first = await sender.archives.import(fileA),
    second = await sender.archives.import(fileA);
  damageBackup(sender.archives, damaged.id);
  const file = path.join(root, '健康去重分卷.yijian-protection'),
    question = await exportQuestion(sender, file, { volumeComponents: 1 }),
    realExport = sender.archives.export.bind(sender.archives),
    attempted = [];
  sender.archives.export = async (id, target) => {
    attempted.push(id);
    return realExport(id, target);
  };
  const exported = await complete.exportComplete({
    ...sender,
    file,
    volumeComponents: 1,
    excludedArchiveIds: [damaged.id],
    confirmationToken: question.confirmationToken,
  });
  assert.deepEqual([...attempted].sort(), [damaged.id, first.id, second.id].sort());
  assert.equal(exported.historicalArchives, 1);
  assert.equal(exported.volumes, 2);
  assert.equal(exported.omittedArchives.length, 1);
  const receiver = machine('去重分卷接收', 6700),
    files = await complete.volumeFiles({ archives: receiver.archives, directory: exported.file }),
    preview = await complete.previewCompleteSet({ archives: receiver.archives, files }),
    imported = await complete.importCompleteSet({ archives: receiver.archives, files, preview });
  assert.equal(imported.archiveIds.length, 2);
  assert.equal(receiver.archives.list().length, 2);
  const again = await complete.importCompleteSet({ archives: receiver.archives, files, preview });
  assert.equal(again.reusedArchives, 2);
  assert.deepEqual(again.archiveIds, imported.archiveIds);
});

test('storage failure and insufficient capacity cannot authorize omission or publish any output', async () => {
  const sender = machine('存储失败不允许遗漏', 6800),
    archive = await sender.archives.import(fileA),
    before = treeHashes(sender.dataRoot, ['protection-transfer']),
    realExport = sender.archives.export.bind(sender.archives),
    storageTarget = path.join(root, '磁盘失败.yijian-protection');
  sender.archives.export = async () => {
    throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' });
  };
  await assert.rejects(complete.exportComplete({ ...sender, file: storageTarget }), { code: 'ENOSPC' });
  assertUnpublished(storageTarget);
  sender.archives.export = realExport;
  damageBackup(sender.archives, archive.id);
  const damagedBefore = treeHashes(sender.dataRoot, ['protection-transfer']),
    capacityTarget = path.join(root, '容量不足.yijian-protection');
  await assert.rejects(
    complete.exportComplete({ ...sender, file: capacityTarget, volumeBytes: 1 }),
    (error) => {
      assert.match(error.message, /超过单卷容量/);
      assert.equal(error.confirmationToken, undefined);
      return true;
    },
  );
  assertUnpublished(capacityTarget);
  assert.deepEqual(treeHashes(sender.dataRoot, ['protection-transfer']), damagedBefore);
  assert.deepEqual(
    currentHashes(sender),
    Object.fromEntries(
      Object.entries(before).filter(([name]) => !name.startsWith('protection-history' + path.sep)),
    ),
  );
});

test('1001 valid complete backups export together and every protected byte remains reachable after import', async () => {
  const long = machine('长期备份', 7000),
    saves = new Saves(path.join(long.dataRoot, 'save-backups'));
  for (let i = 1; i <= 1000; i++) saves.capture(long.source, '长期保护 ' + i);
  assert.equal(saves.list().length, 1001);
  const file = path.join(root, '长期全部资料.yijian-protection');
  const exported = await complete.exportComplete({ ...long, file });
  assert.equal(exported.backups.length, 1001);
  assert.equal(exported.supplementalArchives, 1);
  const target = machine('长期接收', 8000),
    imported = await complete.importComplete({ archives: target.archives, file });
  const histories = await Promise.all(
    imported.archiveIds.map((id) => target.archives.history(id, target.store)),
  );
  assert.equal(
    histories.reduce((n, h) => n + h.backups.length, 0),
    1001,
  );
  assert.equal(
    histories.reduce((n, h) => n + h.timeline.records.length, 0),
    1,
  );
  const first = histories.find((h) => h.backups.length === 1000),
    last = histories.find((h) => h.backups.length === 1);
  for (const history of [first, last]) {
    const value = await migration.readBackupFile({
      directory: target.archives.directory(history.id),
      id: history.backups[0].id,
      name: '1.sav',
    });
    assert.deepEqual(value.bytes, long.bytes);
  }
  assert.equal(saves.list().length, 1001);
});

test('multi-volume export verifies all parts before publication and directory import rejects a missing or changed part before registration', async () => {
  const sender = machine('分卷发出', 9000),
    old = machine('分卷旧机器', 9100);
  const oldFile = path.join(root, '分卷旧资料.yijian-protection');
  await complete.exportComplete({ ...old, file: oldFile });
  await sender.archives.import(oldFile);
  const file = path.join(root, '容量较小分卷.yijian-protection');
  const exported = await complete.exportComplete({ ...sender, file, volumeComponents: 1 });
  assert.equal(exported.volumes, 2);
  assert.equal(fs.existsSync(file), false);
  const receiver = machine('分卷接收', 10000),
    files = await complete.volumeFiles({ archives: receiver.archives, directory: exported.file });
  assert.equal(files.length, 2);
  const preview = await complete.previewCompleteSet({ archives: receiver.archives, files });
  assert.equal(preview.backups.length, 2);
  assert.equal(preview.bookmarks, 2);
  const imported = await complete.importCompleteSet({ archives: receiver.archives, files, preview });
  assert.equal(imported.archiveIds.length, 2);
  const again = await complete.importCompleteSet({ archives: receiver.archives, files, preview });
  assert.equal(again.reusedArchives, 2);
  assert.equal(receiver.archives.list().length, 2);
  const fresh = machine('分卷拒绝', 11000),
    last = fs.readFileSync(files[1]);
  fs.appendFileSync(files[1], 'changed fixture');
  await assert.rejects(
    complete.volumeFiles({ archives: fresh.archives, directory: exported.file }),
    /缺失或校验/,
  );
  await assert.rejects(complete.importCompleteSet({ archives: fresh.archives, files, preview }));
  assert.equal(fresh.archives.list().length, 0);
  fs.writeFileSync(files[1], last);
  const receiptFile = path.join(exported.file, 'transfer.json'),
    receipt = JSON.parse(fs.readFileSync(receiptFile));
  receipt.parts[0].name = '../foreign.yijian-protection';
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  await assert.rejects(
    complete.volumeFiles({ archives: fresh.archives, directory: exported.file }),
    /名称或校验/,
  );
  assert.equal(fresh.archives.list().length, 0);
});

test('selected-backup export is exact, omits unrelated backup and timeline records, and refuses a missing selection', async () => {
  const selected = machine('分批筛选', 12000),
    saves = new Saves(path.join(selected.dataRoot, 'save-backups'));
  const extra = saves.capture(selected.source, '额外未选备份');
  const file = path.join(root, '仅所选.yijian-protection');
  await migration.exportProtection({ ...selected, file, backupIds: [extra.id], includeTimeline: false });
  const preview = await migration.previewProtection({ file });
  assert.deepEqual(
    preview.backups.map((b) => b.id),
    [extra.id],
  );
  assert.equal(preview.nodes, 0);
  await assert.rejects(
    migration.exportProtection({
      ...selected,
      file: path.join(root, 'missing.yijian-protection'),
      backupIds: ['invalid'],
    }),
    /选择的完整备份/,
  );
  assert.equal(saves.list().length, 2);
});
