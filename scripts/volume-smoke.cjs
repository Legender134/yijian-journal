'use strict';
// Real Electron UI regression. Every save and machine below is synthetic and isolated.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = path.resolve(__dirname, '..');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const complete = require('../src/core/complete-migration.cjs');
const codec = require('../src/core/protection-collection.cjs');
const migration = require('../src/core/migration.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const data = path.join(base, '.test-data', 'volume-ui-' + Date.now() + '-' + crypto.randomUUID());
const reportFile = path.join(data, 'report.json');
const resultFile = path.join(base, 'test-results', 'volume-flows-ui-result.json');
const startedAt = new Date().toISOString();
const checks = [],
  errors = [],
  expectedErrors = [],
  processes = [],
  evidence = {};
let active;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => digest(fs.readFileSync(file));
const record = (name, details) => {
  checks.push(name);
  if (details) evidence[name] = details;
  console.log('PASS ' + name);
};
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function sourceSnapshot(machine) {
  return Object.fromEntries(
    fs
      .readdirSync(machine.source)
      .sort()
      .map((name) => [name, fileHash(path.join(machine.source, name))]),
  );
}
function machine(name, seconds) {
  const dataRoot = path.join(data, name, 'userdata'),
    source = path.join(data, name, 'synthetic-SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const bytes = syntheticSave({ full: true, seconds, quests: [{ id: 5200, step: 1 }], inventory: [] });
  fs.writeFileSync(path.join(source, '1.sav'), bytes);
  fs.writeFileSync(path.join(source, 'JHSaveConfig.sav'), Buffer.from('synthetic-index-' + name));
  fs.writeFileSync(path.join(source, '28.sav'), Buffer.from('synthetic-unrelated-28-' + name));
  fs.writeFileSync(path.join(source, '29.sav'), Buffer.from('synthetic-unrelated-29-' + name));
  const old = new Date(Date.now() - 10000);
  for (const filename of fs.readdirSync(source)) fs.utimesSync(path.join(source, filename), old, old);
  const store = new Store(dataRoot, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  store.mutate({ type: 'profile-rename', name: name + '本机周目' });
  store.mutate({ type: 'note', value: name + '本机笔记：中文、标点和历代资料必须保留。' });
  const archives = new ProtectionArchives(dataRoot, () => source);
  const saves = new Saves(path.join(dataRoot, 'save-backups'));
  const timeline = new Timeline(path.join(dataRoot, 'game-timeline'));
  timeline.configure(source, false, 30);
  const node = timeline.record(bytes, 'manual');
  timeline.updateNode(node.id, { bookmarked: true, label: name + '书签', note: name + '原始节点说明' });
  const value = { name, dataRoot, source, store, archives, saves, bytes, node };
  value.beforeSource = sourceSnapshot(value);
  return value;
}
function nativeElectron() {
  if (process.env.YIJIAN_EXECUTABLE) {
    assert(fs.existsSync(process.env.YIJIAN_EXECUTABLE), 'YIJIAN_EXECUTABLE does not exist');
    return process.env.YIJIAN_EXECUTABLE;
  }
  if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    // Prototype dependency folders can contain Linux dist files. Use the owning Windows runtime.
    for (let directory = base; ; directory = path.dirname(directory)) {
      const dist = path.join(directory, 'node_modules', 'electron', 'dist');
      if (fs.existsSync(path.join(dist, 'electron.exe'))) {
        process.env.ELECTRON_OVERRIDE_DIST_PATH = dist;
        break;
      }
      if (path.dirname(directory) === directory) throw Error('No Windows Electron runtime found');
    }
  }
  assert(
    fs.existsSync(path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron.exe')),
    'Windows Electron override is unavailable',
  );
  return require('electron');
}
async function launch(machine, volumeComponents) {
  assert.equal(active, undefined, 'close the preceding test process first');
  const executablePath = nativeElectron();
  let args = process.env.YIJIAN_EXECUTABLE ? [] : [base];
  if (volumeComponents) {
    assert(!process.env.YIJIAN_EXECUTABLE, 'capacity harness is source-only');
    const helper = path.join(data, 'capacity-harness.cjs');
    fs.writeFileSync(
      helper,
      "'use strict';\nconst complete = require(" +
        JSON.stringify(path.join(base, 'src/core/complete-migration.cjs')) +
        ');\nconst original = complete.exportComplete;\ncomplete.exportComplete = options => original({ ...options, volumeComponents: ' +
        volumeComponents +
        ' });\nrequire(' +
        JSON.stringify(path.join(base, 'src/main.cjs')) +
        ');\n',
      { flag: 'wx' },
    );
    args = [helper];
    evidence.capacityHarness = {
      helper,
      volumeComponents,
      reason:
        'Force a small component boundary without allocating multi-GiB synthetic data; the actual main UI export handler remains in use.',
    };
  }
  const env = {
    ...process.env,
    YIJIAN_TEST_DATA: machine.dataRoot,
    YIJIAN_TEST_HIDDEN: '1',
    pnpm_config_verify_deps_before_run: 'warn',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, args, cwd: base, env, timeout: 30000 });
  const processHandle = app.process();
  const processRecord = {
    machine: machine.name,
    pid: processHandle.pid,
    executablePath,
    mode: process.env.YIJIAN_EXECUTABLE ? 'packaged' : 'source',
    volumeComponents: volumeComponents || null,
    launchedAt: new Date().toISOString(),
  };
  processes.push(processRecord);
  // Assign immediately so an initial-window failure is still closed in finally.
  active = { app, processHandle, processRecord, machine };
  const page = await app.firstWindow();
  active.page = page;
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(machine.name + ': ' + error.message));
  await page.waitForSelector('.layout');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  return active;
}
async function close() {
  if (!active) return;
  const { app, processHandle, processRecord } = active;
  await app.close();
  processRecord.exitCode = processHandle.exitCode;
  processRecord.signalCode = processHandle.signalCode;
  processRecord.closedAt = new Date().toISOString();
  assert.notEqual(processHandle.exitCode, null, 'Electron test process did not exit');
  active = undefined;
}
async function nav(id) {
  await active.page.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function saveDialog(file) {
  await active.app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, file);
}
async function openDialog(file) {
  await active.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, file);
}
async function toast(text, error = false) {
  const found = await active.page.waitForFunction(
    ({ selector, pattern, flags, literal }) => {
      const matches = [...document.querySelectorAll(selector)]
        .map((node) => node.innerText)
        .filter((value) => (pattern ? new RegExp(pattern, flags).test(value) : value.includes(literal)));
      return matches.at(-1) || false;
    },
    {
      selector: error ? '.toast.error' : '.toast',
      pattern: text instanceof RegExp ? text.source : null,
      flags: text instanceof RegExp ? text.flags : '',
      literal: text instanceof RegExp ? '' : text,
    },
    { timeout: 90000 },
  );
  try {
    return await found.jsonValue();
  } finally {
    await found.dispose();
  }
}
async function beginProtectionCycle(label) {
  await active.page.evaluate((expected) => {
    window.volumeProtectionEvents = [];
    window.volumeProtectionStop = window.journal.onEvent((event) => {
      if (event.type === 'protection' && event.label === expected) window.volumeProtectionEvents.push(event);
    });
  }, label);
}
async function finishProtectionCycle() {
  await active.page.waitForFunction(
    () =>
      window.volumeProtectionEvents.some((event) => event.busy) &&
      window.volumeProtectionEvents.at(-1)?.busy === false,
    null,
    { timeout: 90000 },
  );
  await active.page.evaluate(() => window.volumeProtectionStop());
}
async function screenshot(name) {
  const file = path.join(data, name + '.png');
  await active.page.screenshot({ path: file });
  return file;
}
async function currentProfile() {
  const reply = await active.page.evaluate(() => window.journal.bootstrap());
  assert(reply.ok, reply.error);
  return reply.data.state.profiles.find((p) => p.id === reply.data.state.activeProfileId);
}
async function createEntry(title, body) {
  await nav('journal');
  await active.page.locator('[data-action="journal-entry-new"]').click();
  await active.page.locator('#journal-title').fill(title);
  await active.page.locator('#journal-body').fill(body);
  await active.page.locator('#journal-tags').fill('迁移验收，私有合成');
  await active.page.locator('[data-action="journal-entry-save"]').click();
  await toast('江湖记录已保存');
  const profile = await currentProfile();
  const entry = profile.journalEntries.find((e) => e.title === title);
  assert(entry);
  assert.equal(entry.body, body);
  return entry;
}
async function mainExport(file, count) {
  await saveDialog(file);
  await active.page.locator('[data-action="protection-export"]').click();
  const text = await toast(new RegExp('保护包已校验[\\s\\S]* · 本机 ' + count + ' 份完整备份'));
  assert(fs.existsSync(file) || fs.existsSync(file + '.parts'), 'main UI export did not publish its target');
  return text;
}
async function uiImport(file, volumes = false, expected = '离线档案已保存') {
  await openDialog(file);
  await active.page
    .locator('[data-action="' + (volumes ? 'protection-import-volumes' : 'protection-import') + '"]')
    .click();
  return toast(expected);
}
async function readAllArchives(machine) {
  const views = [];
  for (const archive of machine.archives.list())
    views.push(await machine.archives.history(archive.id, new Store(machine.dataRoot, catalog)));
  return views;
}
async function verifyGenerations(machine, expected) {
  const views = await readAllArchives(machine);
  assert.equal(views.length, expected.length);
  const entries = [];
  for (const generation of expected) {
    const view = views.find((v) => v.journal.profiles.some((p) => p.name === generation.name + '本机周目'));
    assert(view, 'missing generation ' + generation.name);
    assert(view.readOnly && !view.bound);
    const journalFile = path.join(generation.dataRoot, 'journal.json');
    const originalState = readJSON(journalFile);
    // The visible projection deliberately removes paths and native permissions.
    // The archived original must separately remain byte-for-byte intact.
    const retainedJournal = path.join(
      machine.archives.directory(view.id),
      'payload',
      'originals',
      'journal.json',
    );
    assert.deepEqual(
      fs.readFileSync(retainedJournal),
      fs.readFileSync(journalFile),
      generation.name + ' original journal bytes changed',
    );
    assert.deepEqual(
      view.journal.profiles.map((p) => p.journalEntries),
      originalState.profiles.map((p) => p.journalEntries),
    );
    assert.deepEqual(
      view.journal.profiles.map((p) => p.notes),
      originalState.profiles.map((p) => p.notes),
    );
    assert.equal(view.backups.length, 1);
    assert.deepEqual(
      view.timeline.records.map((n) => [n.id, n.label, n.note, n.bookmarked]),
      [[generation.node.id, generation.name + '书签', generation.name + '原始节点说明', true]],
    );
    const backup = view.backups[0],
      sourceManifest = generation.saves.verify(backup.id).manifest;
    for (const file of sourceManifest.files) {
      const original = generation.saves.verify(backup.id).buffers.get(file.name);
      const historical = await migration.readBackupFile({
        directory: machine.archives.directory(view.id),
        id: backup.id,
        name: file.name,
      });
      assert.deepEqual(
        historical.bytes,
        original,
        generation.name + '/' + file.name + ' historical bytes changed',
      );
    }
    const nodeBytes = await migration.readTimelineNode({
      directory: machine.archives.directory(view.id),
      id: generation.node.id,
    });
    assert.deepEqual(nodeBytes.bytes, generation.bytes);
    entries.push({
      generation: generation.name,
      archiveId: view.id,
      backupId: backup.id,
      saveSha256: digest(generation.bytes),
      entryTitles: view.journal.profiles.flatMap((p) => (p.journalEntries || []).map((e) => e.title)),
    });
  }
  return entries;
}
async function volumeAndCorruptFlow() {
  const long = machine('1001份备份', 7000),
    manifests = [];
  for (let i = 1; i <= 1001; i++)
    manifests.push(long.saves.capture(long.source, '长期保护 ' + String(i).padStart(4, '0')));
  assert.equal(long.saves.list().length, 1001);
  await launch(long);
  await nav('saves');
  const page = active.page;
  assert.match(await page.locator('.content').innerText(), /筛选到 1001 \/ 1001 份完整备份/);
  assert.equal(await page.locator('[data-action="backup-preview"]').count(), 20);
  assert.match(await page.locator('.pagination').last().innerText(), /第 1 \/ 51 页/);
  const firstPageIds = await page
    .locator('[data-action="backup-preview"]')
    .evaluateAll((rows) => rows.map((row) => row.dataset.id));
  await page.locator('[data-action="backup-page"]').last().click();
  assert.match(await page.locator('.pagination').last().innerText(), /第 2 \/ 51 页/);
  const secondPageIds = await page
    .locator('[data-action="backup-preview"]')
    .evaluateAll((rows) => rows.map((row) => row.dataset.id));
  assert.equal(secondPageIds.length, 20);
  assert(!secondPageIds.some((id) => firstPageIds.includes(id)));
  await page.locator('#backup-search').fill('长期保护 0001');
  assert.equal(await page.locator('[data-action="backup-preview"]').count(), 1);
  assert.equal(await page.locator('[data-action="backup-preview"]').getAttribute('data-id'), manifests[0].id);
  await page.locator('#backup-search').fill('长期保护 1001');
  assert.equal(await page.locator('[data-action="backup-preview"]').count(), 1);
  assert.equal(
    await page.locator('[data-action="backup-preview"]').getAttribute('data-id'),
    manifests[1000].id,
  );
  const listScreenshot = await screenshot('1001-list-search');
  await page.locator('#backup-search').fill('');
  record('1001份有效完整备份在真实列表显示总数、51页分页和精确名称查找', {
    listScreenshot,
    firstPageIds,
    secondPageIds,
  });
  const file = path.join(data, '1001份全部保护.yijian-protection');
  const exportToast = await mainExport(file, 1001);
  const preview = await complete.previewComplete({ archives: long.archives, file });
  assert.equal(preview.collection, true);
  assert.equal(preview.backups.length + preview.historicalBackups, 1001);
  assert.equal(preview.historicalArchives, 1);
  const scanned = await codec.scanCollection({
    file,
    extractionDirectory: path.join(data, '1001-inner-package-evidence'),
  });
  assert.deepEqual(
    scanned.components.map((c) => c.preview.backups.length),
    [1000, 1],
  );
  const exported = scanned.components.flatMap((c) => c.preview.backups);
  assert.deepEqual(exported.map((b) => b.id).sort(), manifests.map((b) => b.id).sort());
  const originals = new Map(manifests.map((backup) => [backup.id, backup]));
  for (const component of scanned.components) {
    const { manifest: index } = await migration.readProtectionIndex({ file: component.file });
    const entries = new Map(index.entries.map((entry) => [entry.path, entry]));
    for (const backup of component.preview.backups) {
      const original = originals.get(backup.id);
      assert.equal(backup.label, original.label);
      const originalEntry = entries.get('originals/save-backups/' + backup.id + '/manifest.json');
      assert.equal(originalEntry.sha256, fileHash(path.join(long.saves.root, backup.id, 'manifest.json')));
      for (const file of original.files) {
        const entry = entries.get('save-backups/' + backup.id + '/files/' + file.name);
        assert(entry);
        assert.deepEqual([entry.bytes, entry.sha256], [file.bytes, file.sha256]);
      }
    }
  }
  assert.deepEqual(sourceSnapshot(long), long.beforeSource);
  const exportScreenshot = await screenshot('1001-main-export');
  record('主UI导出全部自动分为1000加1内层包，previewComplete及逐份哈希确认1001份保留', {
    file,
    fileSha256: fileHash(file),
    exportToast,
    componentCounts: [1000, 1],
    previewTotal: preview.backups.length + preview.historicalBackups,
    exportScreenshot,
  });
  // Corrupt a single OLD synthetic backup. Never touch the synthetic current save directory.
  const bad = manifests[0],
    badFile = path.join(long.saves.root, bad.id, 'files', '1.sav');
  fs.appendFileSync(badFile, Buffer.from('synthetic-corruption-volume-smoke'));
  const corruptHash = fileHash(badFile),
    manifestHash = fileHash(path.join(long.saves.root, bad.id, 'manifest.json'));
  const rejected = path.join(data, '损坏备份主导出必须拒绝.yijian-protection');
  await saveDialog(rejected);
  await page.locator('[data-action="protection-export"]').click();
  await toast('完整导出未完成', true);
  const failureResult = page.locator('[aria-label="最近一次完整导出"]');
  await failureResult.locator('p[role="alert"]').filter({ hasText: '长期保护 0001' }).waitFor();
  const errorToast = await failureResult.innerText();
  assert(errorToast.includes(bad.id));
  assert(errorToast.includes('1.sav'));
  assert.match(errorToast, /原件保留.*可靠副本.*分批导出/);
  assert(!errorToast.includes('本次结果未能写入磁盘'), 'the actual failed-export receipt was saved');
  const failureReceipt = JSON.parse(
    fs.readFileSync(path.join(long.dataRoot, 'protection-export-result.json'), 'utf8'),
  );
  assert.equal(failureReceipt.status, 'failed');
  assert(failureReceipt.message.includes(bad.id));
  assert(!fs.existsSync(rejected));
  assert(!fs.existsSync(rejected + '.parts'));
  expectedErrors.push(errorToast);
  const errorScreenshot = await screenshot('corrupt-backup-main-export-error');
  const healthy = manifests[1000];
  await page.locator('#backup-search').fill('长期保护 1001');
  await page.locator('[data-action="backup-selection"][data-id="' + healthy.id + '"]').check();
  assert.match(await page.locator('.content').innerText(), /已选 1 份/);
  const selectedFile = path.join(data, '一份健康备份选集.yijian-protection');
  await saveDialog(selectedFile);
  await page.locator('[data-action="backup-export-selected"]').click();
  await toast('所选 1 份完整备份及手札已校验并导出');
  const selected = await complete.previewComplete({ archives: long.archives, file: selectedFile });
  assert.deepEqual(
    selected.backups.map((b) => b.id),
    [healthy.id],
  );
  assert.equal(selected.nodes, 0);
  assert.equal(fileHash(badFile), corruptHash);
  assert.equal(fileHash(path.join(long.saves.root, bad.id, 'manifest.json')), manifestHash);
  assert.equal(long.saves.list().length, 1001);
  assert.deepEqual(sourceSnapshot(long), long.beforeSource);
  record('坏旧备份主导出明确名称和1.sav槽位；真实UI只选健康一份导出成功，坏源及全部原件保留', {
    errorToast,
    errorScreenshot,
    badId: bad.id,
    corruptHash,
    manifestHash,
    healthyId: healthy.id,
    selectedFile,
    selectedSha256: fileHash(selectedFile),
    screenshot: await screenshot('healthy-selected-export'),
  });
  await close();
}
async function generationFlow() {
  const a = machine('机器A', 1000),
    b = machine('机器B', 2000),
    c = machine('机器C', 3000);
  a.saves.capture(a.source, '机器A完整保护');
  const fileA = path.join(data, '机器A全部保护.yijian-protection');
  await launch(a);
  a.entry = await createEntry('机器A原始江湖记录', 'A代中文原文：三代换机后仍可读，保留事件时间和标签。');
  await nav('saves');
  await mainExport(fileA, 1);
  await close();
  await launch(b);
  await nav('saves');
  const beforeBJournal = fileHash(path.join(b.dataRoot, 'journal.json'));
  await uiImport(fileA);
  assert.equal(fileHash(path.join(b.dataRoot, 'journal.json')), beforeBJournal);
  assert.equal(b.archives.list().length, 1);
  assert.deepEqual(sourceSnapshot(b), b.beforeSource);
  b.entry = await createEntry('机器B新建江湖记录', 'B在导入A以后新建的独立原文：必须与A各代历史一起保留。');
  await nav('saves');
  await active.page.locator('[data-action="backup"]').first().click();
  await active.page.locator('#backup-label').fill('机器B导入A以后新建完整保护');
  await active.page.locator('[data-action="backup-confirm"]').click();
  await toast('已备份并校验 4 个文件');
  assert.equal(b.saves.list().length, 1);
  const fileB = path.join(data, '机器B全部历代保护.yijian-protection');
  await mainExport(fileB, 1);
  const previewB = await complete.previewComplete({ archives: b.archives, file: fileB });
  assert.equal(previewB.backups.length, 1);
  assert.equal(previewB.historicalArchives, 1);
  assert.equal(previewB.historicalBackups, 1);
  const sourceBHistory = b.archives.list()[0],
    aReexport = path.join(data, 'B保存的A原包证据.yijian-protection');
  await b.archives.export(sourceBHistory.id, aReexport);
  assert.equal(fileHash(aReexport), fileHash(fileA));
  await close();
  record('机器A主UI导出，机器B真实UI导入后新建独立江湖记录与完整备份，再主导出包含A/B两代', {
    fileA,
    fileASha256: fileHash(fileA),
    fileB,
    fileBSha256: fileHash(fileB),
    aReexport,
    aEntryId: a.entry.id,
    bEntryId: b.entry.id,
  });
  await launch(c);
  await nav('saves');
  const beforeCJournal = fileHash(path.join(c.dataRoot, 'journal.json'));
  await uiImport(fileB);
  assert.equal(fileHash(path.join(c.dataRoot, 'journal.json')), beforeCJournal);
  assert.deepEqual(sourceSnapshot(c), c.beforeSource);
  const verified = await verifyGenerations(c, [a, b]);
  const ids = c.archives
    .list()
    .map((v) => v.id)
    .sort();
  const historicalA = verified.find((v) => v.generation === a.name),
    exportedA = path.join(data, 'C保存的A原包证据.yijian-protection');
  await c.archives.export(historicalA.archiveId, exportedA);
  assert.equal(fileHash(exportedA), fileHash(fileA));
  const historicalB = verified.find((v) => v.generation === b.name);
  await active.page.getByRole('button', { name: '返回档案列表', exact: true }).click();
  await active.page
    .locator('[data-action="protection-history"][data-id="' + historicalB.archiveId + '"]')
    .click();
  await active.page.locator('[data-action="protection-backup-select"]').first().waitFor();
  const bHistoryText = await active.page.locator('.content').innerText();
  assert(bHistoryText.includes('机器B导入A以后新建完整保护'));
  // Newer products expose the read-only event journal. Also verify its visible original record.
  if (await active.page.locator('[data-action="protection-journal-profile"]').count()) {
    const profileButton = active.page.locator('[data-action="protection-journal-profile"]').first();
    const details = active.page.locator('details.detail-block').filter({ has: profileButton });
    await details.locator('summary').first().click();
    await profileButton.click();
    await active.page
      .locator('[data-action="historical-journal-entry-open"][data-id="' + b.entry.id + '"]')
      .first()
      .click();
    const overlay = active.page.locator('#overlay');
    assert((await overlay.innerText()).includes(b.entry.body));
    assert.equal(
      await overlay
        .locator('[data-action="journal-entry-edit"],[data-action="journal-entry-remove"]')
        .count(),
      0,
    );
    await active.page.locator('#overlay [data-action="close-overlay"]').click();
    record('第三机器历史江湖记录可打开原文且没有编辑或删除入口');
  }
  const generationsScreenshot = await screenshot('machine-C-generations');
  const repeatText = await uiImport(fileB, false, '2 份已存档案校验后沿用');
  assert.match(repeatText, /2 份已存档案校验后沿用/);
  assert.deepEqual(
    c.archives
      .list()
      .map((v) => v.id)
      .sort(),
    ids,
  );
  assert.deepEqual(await verifyGenerations(c, [a, b]), verified);
  assert.equal(fileHash(path.join(c.dataRoot, 'journal.json')), beforeCJournal);
  assert.deepEqual(sourceSnapshot(c), c.beforeSource);
  for (const m of [a, b]) assert.deepEqual(sourceSnapshot(m), m.beforeSource);
  record('机器C真实UI导入保留A/B原始手札、事件、备份全部文件和时间线字节；重复导入沿用2份且无重复', {
    verified,
    repeatText,
    generationsScreenshot,
    beforeCJournal,
    cSourceHashes: c.beforeSource,
  });
  await close();
  const e = machine('恢复接收E', 5000);
  e.saves.capture(e.source, '恢复接收E独立完整备份');
  await launch(e);
  await nav('saves');
  const beforeEJournal = fileHash(path.join(e.dataRoot, 'journal.json'));
  await uiImport(fileB);
  const damaged = e.archives.list().find((archive) => archive.label === b.name + '本机周目');
  assert(damaged, 'the original B archive must exist before injecting local corruption');
  const directory = e.archives.directory(damaged.id),
    payload = path.join(directory, 'payload');
  const indexFile = path.join(payload, 'package-index.json'),
    originalIndex = readJSON(indexFile);
  const saveEntry = originalIndex.entries.find(
    (entry) => entry.path.startsWith('save-backups/') && entry.path.endsWith('/1.sav'),
  );
  assert(saveEntry, 'synthetic protected 1.sav must be present');
  const damagedFile = path.join(payload, ...saveEntry.path.split('/'));
  fs.appendFileSync(damagedFile, 'synthetic-local-archive-corruption');
  const retainedFiles = [
    damagedFile,
    indexFile,
    path.join(payload, 'receipt.json'),
    path.join(directory, 'archive-summary.json'),
  ];
  const retainedHashes = retainedFiles.map(fileHash);
  const recoveredText = await uiImport(fileB, false, '1 份未通过校验的旧档案原样保留，已另存可用档案');
  assert.equal(e.archives.list().length, 3);
  assert(
    (await active.page.locator('.content').innerText()).includes(
      '本次保留了 1 份未通过校验的旧档案及原始字节',
    ),
  );
  const healthyIds = e.archives
    .list()
    .map((archive) => archive.id)
    .filter((id) => id !== damaged.id);
  const healthyHistories = await Promise.all(
    healthyIds.map((id) => e.archives.history(id, new Store(e.dataRoot, catalog))),
  );
  const recoveredB = healthyHistories.find((history) =>
    history.journal.profiles.some((profile) => profile.name === b.name + '本机周目'),
  );
  assert(recoveredB && recoveredB.id !== damaged.id && recoveredB.readOnly);
  assert.deepEqual(
    fs.readFileSync(path.join(e.archives.directory(recoveredB.id), 'payload/originals/journal.json')),
    fs.readFileSync(path.join(b.dataRoot, 'journal.json')),
  );
  const recoveredBytes = await migration.readBackupFile({
    directory: e.archives.directory(recoveredB.id),
    id: recoveredB.backups[0].id,
    name: '1.sav',
  });
  assert.deepEqual(recoveredBytes.bytes, fs.readFileSync(path.join(b.source, '1.sav')));
  const recoveryScreenshot = await screenshot('reimport-preserves-damaged-archive');
  const recoveredIds = e.archives
    .list()
    .map((archive) => archive.id)
    .sort();
  const recoveryRepeated = await uiImport(fileB, false, '2 份已存档案校验后沿用');
  assert.deepEqual(
    e.archives
      .list()
      .map((archive) => archive.id)
      .sort(),
    recoveredIds,
  );
  assert.deepEqual(retainedFiles.map(fileHash), retainedHashes);
  assert.equal(fileHash(path.join(e.dataRoot, 'journal.json')), beforeEJournal);
  assert.deepEqual(sourceSnapshot(e), e.beforeSource);
  record('本机旧档案损坏后真实UI重导入完好原包：旧证据保留、另存可读副本，再导入沿用健康副本而不增生', {
    damagedId: damaged.id,
    recoveredId: recoveredB.id,
    retainedFiles,
    retainedHashes,
    recoveredText,
    recoveryRepeated,
    recoveryScreenshot,
  });
  const cancelledRecoveryExport = path.join(data, '恢复后取消换机.yijian-protection');
  await saveDialog(cancelledRecoveryExport);
  await active.app.evaluate(({ dialog }) => {
    globalThis.volumeExportConfirmations = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.volumeExportConfirmations.push(args.at(-1));
      return { response: 0 };
    };
  });
  await beginProtectionCycle('正在导出本机保护资料');
  await active.page.locator('[data-action="protection-export"]').click();
  await finishProtectionCycle();
  const cancellationDialogs = await active.app.evaluate(() => globalThis.volumeExportConfirmations);
  assert.equal(cancellationDialogs.length, 1);
  assert.match(cancellationDialogs[0].detail, new RegExp(damaged.id));
  assert.match(cancellationDialogs[0].detail, /本次导出不会包含它们/);
  assert(!fs.existsSync(cancelledRecoveryExport) && !fs.existsSync(cancelledRecoveryExport + '.parts'));
  assert.deepEqual(retainedFiles.map(fileHash), retainedHashes);
  assert.equal(fileHash(path.join(e.dataRoot, 'journal.json')), beforeEJournal);
  assert.deepEqual(sourceSnapshot(e), e.beforeSource);
  const recoveredTransfer = path.join(data, '恢复后已校验资料换机.yijian-protection');
  await active.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  const scopedExport = await mainExport(recoveredTransfer, e.saves.list().length);
  assert.match(scopedExport, /未包含 1 份异常历史档案/);
  assert.match(await active.page.locator('.content').innerText(), /上次导出未包含 1 份异常历史档案/);
  assert.deepEqual(retainedFiles.map(fileHash), retainedHashes);
  assert.deepEqual(sourceSnapshot(e), e.beforeSource);
  const scopedPreview = await complete.previewComplete({ archives: e.archives, file: recoveredTransfer });
  assert.equal(scopedPreview.historicalArchives, 2);
  await close();
  const f = machine('恢复再换机F', 6000);
  await launch(f);
  await nav('saves');
  await uiImport(recoveredTransfer);
  const transferredHealthy = await verifyGenerations(f, [a, b, e]);
  assert.deepEqual(sourceSnapshot(f), f.beforeSource);
  record('恢复后再次换机：取消零发布，确认明确遗漏坏原件；新机保留全部可校验A/B/E代记录', {
    cancelledRecoveryExport,
    cancellationDialogs,
    scopedExport,
    recoveredTransfer,
    scopedPreview,
    omittedLocalArchive: damaged.id,
    transferredHealthy,
    retainedHashes,
    screenshot: await screenshot('recovered-history-next-migration'),
  });
  await close();
  if (!process.env.YIJIAN_EXECUTABLE) {
    // Small, disclosed capacity seam. Export still originates from the product's main UI button.
    await launch(b, 1);
    await nav('saves');
    const volumeTarget = path.join(data, '组件边界主UI分卷.yijian-protection');
    await mainExport(volumeTarget, 1);
    const directory = volumeTarget + '.parts';
    assert(fs.existsSync(path.join(directory, 'transfer.json')));
    const files = await complete.volumeFiles({ archives: b.archives, directory });
    assert.equal(files.length, 2);
    await close();
    const d = machine('分卷接收D', 4000);
    await launch(d);
    await nav('saves');
    const beforeDJournal = fileHash(path.join(d.dataRoot, 'journal.json'));
    await uiImport(directory, true);
    const retained = await verifyGenerations(d, [a, b]);
    const firstIds = d.archives
      .list()
      .map((v) => v.id)
      .sort();
    const repeated = await uiImport(directory, true, '2 份已存档案校验后沿用');
    assert.match(repeated, /2 份已存档案校验后沿用/);
    assert.deepEqual(
      d.archives
        .list()
        .map((v) => v.id)
        .sort(),
      firstIds,
    );
    assert.equal(fileHash(path.join(d.dataRoot, 'journal.json')), beforeDJournal);
    assert.deepEqual(sourceSnapshot(d), d.beforeSource);
    record('测试组件上限1触发主UI外层2卷；真实导入分卷目录保留A/B全部字节并重复沿用', {
      directory,
      files: files.map((file) => ({ file, sha256: fileHash(file) })),
      retained,
      repeated,
      screenshot: await screenshot('volume-directory-import'),
    });
    await close();
  } else
    evidence.capacityHarness = {
      skipped: true,
      reason:
        'Packaged override validates production defaults; the optional source capacity seam is unavailable.',
    };
}
function report(status, error) {
  const value = {
    status,
    checks,
    errors,
    expectedErrors,
    evidence,
    processes,
    data,
    startedAt,
    finishedAt: new Date().toISOString(),
    error: error?.stack,
    mode: process.env.YIJIAN_EXECUTABLE ? 'packaged' : 'source',
    electronOverride: process.env.ELECTRON_OVERRIDE_DIST_PATH || null,
    localOnly: [
      {
        path: path.relative(base, data),
        classification: 'keep',
        reason: 'Private synthetic fixtures, packages, screenshots and evidence; never commit or publish.',
      },
      { path: path.relative(base, resultFile), classification: 'keep', reason: 'Private regression report.' },
    ],
  };
  fs.writeFileSync(reportFile, JSON.stringify(value, null, 2));
  fs.writeFileSync(resultFile, JSON.stringify(value, null, 2));
  return value;
}
(async () => {
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  let failure;
  try {
    assert.equal(process.platform, 'win32', 'This regression requires the native Windows Electron runtime');
    const scope = process.env.YIJIAN_VOLUME_ONLY || 'all';
    assert(['all', 'capacity', 'generation'].includes(scope), 'Unknown volume verification scope');
    evidence.scope = scope;
    if (scope !== 'generation') await volumeAndCorruptFlow();
    if (scope !== 'capacity') await generationFlow();
    assert.deepEqual(errors, [], 'unexpected renderer errors');
  } catch (error) {
    failure = error;
    if (active?.page) {
      try {
        evidence.failureScreenshot = await screenshot('failure');
      } catch (shotError) {
        errors.push('failure screenshot: ' + shotError.message);
      }
    }
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await close();
    } catch (error) {
      errors.push('close: ' + error.message);
      failure ||= error;
      process.exitCode = 1;
    }
    const result = report(failure ? 'FAIL' : 'PASS', failure);
    console.log(
      JSON.stringify({
        status: result.status,
        checks,
        errors,
        data,
        reportFile,
        resultFile,
        elapsedMs: Date.now() - Date.parse(startedAt),
      }),
    );
  }
})();
