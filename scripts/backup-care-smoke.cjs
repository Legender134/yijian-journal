'use strict';
// Native Electron UI recovery checks. All sources, copies and crash injections are private synthetic fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const care = require('../src/core/backup-care.cjs');
const migration = require('../src/core/migration.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..');
const data = path.join(base, '.test-data', 'backup-care-ui-' + Date.now() + '-' + crypto.randomUUID());
const resultFile = path.join(base, 'test-results', 'backup-care-ui-result.json');
const startedAt = new Date().toISOString();
const checks = [],
  errors = [],
  expectedErrors = [],
  processes = [],
  evidence = {},
  machines = [];
let active;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => digest(fs.readFileSync(file));
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const record = (name, details) => {
  checks.push(name);
  evidence[name] = details;
  console.log('PASS ' + name);
};
function tree(directory) {
  assert(fs.lstatSync(directory).isDirectory());
  const value = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'synthetic fixtures must not contain links');
    value[name] = stat.isDirectory() ? tree(file) : { bytes: stat.size, sha256: fileHash(file) };
  }
  return value;
}
function activePending(machine) {
  return care.listPending({ saves: machine.saves }).filter((p) => p.blocking !== false);
}
async function fixture(name, seconds) {
  const directory = path.join(data, name),
    dataRoot = path.join(directory, 'userdata');
  const source = path.join(directory, 'synthetic-SaveGames'),
    otherSource = path.join(directory, 'synthetic-unselected-SaveGames');
  for (const [dir, stamp] of [
    [source, seconds],
    [otherSource, seconds + 123],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.sav'), syntheticSave({ full: true, seconds: stamp }));
    fs.writeFileSync(
      path.join(dir, 'JHSaveConfig.sav'),
      Buffer.from('synthetic-index-' + name + '-' + stamp),
    );
    fs.writeFileSync(path.join(dir, '28.sav'), Buffer.from('synthetic-foreign-28-' + stamp));
    fs.writeFileSync(path.join(dir, '29.sav'), Buffer.from('synthetic-foreign-29-' + stamp));
    const old = new Date(Date.now() - 10000);
    for (const filename of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, filename), old, old);
  }
  const store = new Store(dataRoot, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: true } });
  store.mutate({ type: 'profile-rename', name: name + '合成周目' });
  store.mutate({ type: 'note', value: name + '合成记录：中断清理不改变游戏源、未选副本和导出留底。' });
  const saves = new Saves(path.join(dataRoot, 'save-backups'));
  // A different source keeps the unselected copy safe without allowing it to seed protection for this machine.
  const keep = saves.capture(otherSource, name + '未选完整副本');
  const selected = saves.capture(source, name + '所选完整副本');
  const packageFile = path.join(directory, name + '已校验所选保护包.yijian-protection');
  const exported = await migration.exportProtection({
    dataRoot,
    file: packageFile,
    backupIds: [selected.id],
    includeTimeline: false,
  });
  const checked = await migration.readProtectionIndex({ file: packageFile });
  assert.equal(checked.packageHash, exported.packageHash);
  const wrongFile = path.join(directory, name + '其他有效保护包.yijian-protection');
  await migration.exportProtection({
    dataRoot,
    file: wrongFile,
    backupIds: [keep.id],
    includeTimeline: false,
  });
  const value = {
    name,
    directory,
    dataRoot,
    source,
    otherSource,
    store,
    saves,
    selected,
    keep,
    packageFile,
    wrongFile,
    expectedPackageHash: exported.packageHash,
  };
  value.sourceBefore = tree(source);
  value.otherSourceBefore = tree(otherSource);
  value.selectedBefore = tree(path.join(saves.root, selected.id));
  value.keepBefore = tree(path.join(saves.root, keep.id));
  value.packageBefore = { bytes: fs.statSync(packageFile).size, sha256: fileHash(packageFile) };
  value.wrongBefore = { bytes: fs.statSync(wrongFile).size, sha256: fileHash(wrongFile) };
  value.healthObservations = [];
  machines.push(value);
  return value;
}
function invariant(machine) {
  assert.deepEqual(tree(machine.source), machine.sourceBefore, 'current synthetic game bytes changed');
  assert.deepEqual(
    tree(machine.otherSource),
    machine.otherSourceBefore,
    'unselected synthetic source changed',
  );
  assert.deepEqual(
    tree(path.join(machine.saves.root, machine.keep.id)),
    machine.keepBefore,
    'unselected backup bytes changed',
  );
  assert.deepEqual(
    { bytes: fs.statSync(machine.packageFile).size, sha256: fileHash(machine.packageFile) },
    machine.packageBefore,
    'original export package bytes changed',
  );
  assert.deepEqual(
    { bytes: fs.statSync(machine.wrongFile).size, sha256: fileHash(machine.wrongFile) },
    machine.wrongBefore,
    'other valid export package changed',
  );
}
function interrupt(machine, mode) {
  const child = String.raw`
    'use strict';
    const fs = require('node:fs'), path = require('node:path');
    const { Saves } = require(process.env.CARE_SMOKE_SAVES_MODULE);
    const care = require(process.env.CARE_SMOKE_CARE_MODULE);
    const options = JSON.parse(process.env.CARE_SMOKE_OPTIONS);
    options.saves = new Saves(process.env.CARE_SMOKE_BACKUP_ROOT);
    const stop = process.env.CARE_SMOKE_STOP;
    const exitAt = info => {
      fs.writeFileSync(process.env.CARE_SMOKE_CHECKPOINT_FILE, JSON.stringify(info, null, 2));
      console.log(JSON.stringify(info)); process.exit(73);
    };
    if (stop === 'receipt-temp-deleting') {
      const opened = new Map(), synced = new Set();
      const originalOpen = fs.openSync, originalSync = fs.fsyncSync, originalClose = fs.closeSync;
      fs.openSync = (file, ...args) => { const fd = originalOpen(file, ...args); if (typeof file === 'string') opened.set(fd, file); return fd; };
      fs.fsyncSync = fd => { const result = originalSync(fd); synced.add(fd); return result; };
      fs.closeSync = fd => {
        const file = opened.get(fd), didSync = synced.has(fd); const result = originalClose(fd);
        opened.delete(fd); synced.delete(fd);
        if (file && didSync && /^receipt\.json\.[a-f0-9-]{36}\.tmp$/.test(path.basename(file))) {
          const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (receipt.phase === 'deleting') exitAt({ phase: stop, file, tempPhase: receipt.phase, canonicalPhase: JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'receipt.json'), 'utf8')).phase, fsyncedAndClosed: true });
        }
        return result;
      };
    } else options.onCheckpoint = info => { if (info.phase === stop) exitAt(info); };
    care.cleanupExportedBackups(options).then(() => process.exit(0)).catch(error => { console.error(error.stack); process.exit(1); });
  `;
  const checkpointFile = path.join(machine.directory, mode + '-checkpoint.json');
  const result = spawnSync(process.execPath, ['-e', child], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CARE_SMOKE_SAVES_MODULE: require.resolve('../src/core/saves.cjs'),
      CARE_SMOKE_CARE_MODULE: require.resolve('../src/core/backup-care.cjs'),
      CARE_SMOKE_BACKUP_ROOT: machine.saves.root,
      CARE_SMOKE_STOP: mode,
      CARE_SMOKE_CHECKPOINT_FILE: checkpointFile,
      CARE_SMOKE_OPTIONS: JSON.stringify({
        ids: [machine.selected.id],
        packageFile: machine.packageFile,
        expectedPackageHash: machine.expectedPackageHash,
      }),
    },
  });
  assert.equal(
    result.status,
    73,
    result.stderr || result.error?.message || 'child missed the requested interruption',
  );
  assert.equal(result.signal, null);
  const checkpoint = readJSON(checkpointFile),
    pending = activePending(machine);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].error, '');
  assert.deepEqual(pending[0].ids, [machine.selected.id]);
  assert.equal(pending[0].packageHash, machine.expectedPackageHash);
  assert(!fs.existsSync(path.join(machine.saves.root, machine.selected.id)));
  const dir = path.join(machine.saves.root, '.backup-care', pending[0].id);
  machine.pending = pending[0];
  machine.transactionDirectory = dir;
  machine.pendingBefore = tree(dir);
  if (mode === 'file-deleted') {
    assert.equal(pending[0].phase, 'deleting');
    assert.equal(pending[0].canRollback, false);
    assert.equal(fs.existsSync(path.join(dir, machine.selected.id, ...checkpoint.name.split('/'))), false);
  } else {
    assert.equal(pending[0].canRollback, true);
    assert.deepEqual(tree(path.join(dir, machine.selected.id)), machine.selectedBefore);
  }
  if (mode === 'receipt-temp-deleting') {
    assert.equal(checkpoint.canonicalPhase, 'ready');
    assert.equal(checkpoint.fsyncedAndClosed, true);
    machine.tempFile = checkpoint.file;
    machine.tempBefore = { bytes: fs.statSync(checkpoint.file).size, sha256: fileHash(checkpoint.file) };
  }
  invariant(machine);
  evidence[machine.name + ' interruption'] = {
    mode,
    childPid: result.pid,
    exitCode: result.status,
    checkpointFile,
    checkpoint,
    pending: pending[0],
    transactionDirectory: dir,
    pendingBefore: machine.pendingBefore,
  };
  return pending[0];
}
function nativeElectron() {
  if (process.env.YIJIAN_EXECUTABLE) {
    assert(fs.existsSync(process.env.YIJIAN_EXECUTABLE));
    return process.env.YIJIAN_EXECUTABLE;
  }
  if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    for (let directory = base; ; directory = path.dirname(directory)) {
      const dist = path.join(directory, 'node_modules', 'electron', 'dist');
      if (fs.existsSync(path.join(dist, 'electron.exe'))) {
        process.env.ELECTRON_OVERRIDE_DIST_PATH = dist;
        break;
      }
      if (path.dirname(directory) === directory) throw Error('No native Windows Electron runtime found');
    }
  }
  assert(fs.existsSync(path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron.exe')));
  return require('electron');
}
async function launch(machine) {
  assert.equal(active, undefined);
  const executablePath = nativeElectron();
  const env = {
    ...process.env,
    YIJIAN_TEST_DATA: machine.dataRoot,
    YIJIAN_TEST_HIDDEN: '1',
    YIJIAN_TEST_AUTO_FAST: '1',
    pnpm_config_verify_deps_before_run: 'warn',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath,
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    cwd: base,
    env,
    timeout: 30000,
  });
  const processHandle = app.process(),
    info = {
      machine: machine.name,
      pid: processHandle.pid,
      executablePath,
      launchedAt: new Date().toISOString(),
    };
  processes.push(info);
  active = { machine, app, processHandle, info };
  const page = await app.firstWindow();
  active.page = page;
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(machine.name + ': ' + error.message));
  await page.waitForSelector('.layout');
  await setDialogs(machine.packageFile, 0);
  return active;
}
async function close() {
  if (!active) return;
  const { app, processHandle, info } = active;
  await app.close();
  Object.assign(info, {
    exitCode: processHandle.exitCode,
    signalCode: processHandle.signalCode,
    closedAt: new Date().toISOString(),
  });
  assert.equal(processHandle.exitCode, 0, 'test Electron did not close normally');
  active = undefined;
}
async function nav(id) {
  await active.page.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function setDialogs(file, response) {
  await active.app.evaluate(
    ({ dialog }, options) => {
      globalThis.__careSmokeDialogs ||= [];
      dialog.showOpenDialog = async (_owner, question) => {
        globalThis.__careSmokeDialogs.push({ type: 'open', title: question.title, file: options.file });
        return { canceled: false, filePaths: [options.file] };
      };
      dialog.showMessageBox = async (_owner, question) => {
        globalThis.__careSmokeDialogs.push({
          type: 'confirm',
          title: question.title,
          message: question.message,
          response: options.response,
        });
        return { response: options.response };
      };
    },
    { file, response },
  );
}
async function dialogs() {
  return active.app.evaluate(() => globalThis.__careSmokeDialogs || []);
}
async function bootstrap() {
  const reply = await active.page.evaluate(() => window.journal.bootstrap());
  assert(reply.ok, reply.error);
  return reply.data.environment;
}
async function health() {
  const reply = await active.page.evaluate(() => window.journal.health());
  assert(reply.ok, reply.error);
  return reply.data;
}
async function until(label, work, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await work();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error('condition did not become true: ' + label);
}
async function toast(text, error = false) {
  const item = active.page.locator(error ? '.toast.error' : '.toast').filter({ hasText: text });
  await item.last().waitFor({ timeout: 20000 });
  return item.last().innerText();
}
async function screenshot(name) {
  const file = path.join(data, name + '.png');
  await active.page.screenshot({ path: file });
  return file;
}
function observe(machine, h) {
  const value = {
    at: new Date().toISOString(),
    backupStatus: h.backupStatus,
    lastBackup: h.lastBackup || null,
    protection: h.protection,
    care: (h.backupCare || []).map((p) => ({ id: p.id, phase: p.phase, blocking: p.blocking })),
  };
  const key = JSON.stringify({ ...value, at: undefined });
  if (machine.lastObservation !== key) {
    machine.healthObservations.push(value);
    machine.lastObservation = key;
  }
  if (machine.selectedMustBeGone)
    assert.notEqual(h.lastBackup?.id, machine.selected.id, 'AutoBackup still remembers the deleted ID');
  if (h.protection?.ready) {
    assert(h.lastBackup?.id, 'ready health has no real backup identity');
    const verified = machine.saves.verify(h.lastBackup.id);
    assert.equal(
      path.resolve(verified.manifest.source).toLowerCase(),
      path.resolve(machine.source).toLowerCase(),
    );
    for (const [name, bytes] of verified.buffers)
      assert.deepEqual(bytes, fs.readFileSync(path.join(machine.source, name)));
  }
  return h;
}
async function pendingStatus(machine) {
  const h = observe(machine, await health());
  assert.equal(h.backupCare.length, 1);
  assert.equal(h.backupStatus, 'paused');
  assert.equal(h.protection.ready, false);
  assert.equal(h.protection.label, '副本清理待处理');
  assert.equal(await active.page.locator('.save-health.ready').count(), 0);
  assert((await active.page.locator('header .save-health').innerText()).includes('副本清理待处理'));
  await nav('home');
  assert((await active.page.locator('.home-protection .save-health').innerText()).includes('副本清理待处理'));
  assert.equal(await active.page.locator('.home-protection .save-health.ready').count(), 0);
  await nav('saves');
  await active.page.locator('[aria-label="副本清理待处理"]').waitFor();
  assert.deepEqual(
    tree(machine.transactionDirectory),
    machine.pendingBefore,
    'viewing recovery mutated staged bytes',
  );
  invariant(machine);
  return h;
}
async function realReady(machine) {
  const h = await until('AutoBackup remembers a physically verified complete copy', async () => {
    const value = observe(machine, await health());
    return !value.backupCare.length &&
      value.backupStatus === 'watching' &&
      value.protection?.ready &&
      value.lastBackup?.id
      ? value
      : false;
  });
  if (machine.selectedMustBeGone) {
    assert.notEqual(h.lastBackup.id, machine.selected.id);
    assert(!fs.existsSync(path.join(machine.saves.root, machine.selected.id)));
    assert.equal(machine.saves.verify(h.lastBackup.id).manifest.kind, 'auto');
  }
  const environment = await bootstrap();
  assert(environment.backups.some((b) => b.id === h.lastBackup.id));
  await active.page.locator('[data-action="refresh"]').click();
  await until('header ready matches verified physical backup', async () => {
    observe(machine, await health());
    return (await active.page.locator('header .save-health.ready').count()) === 1;
  });
  await nav('home');
  await until('overview ready matches verified physical backup', async () => {
    observe(machine, await health());
    return (await active.page.locator('.home-protection .save-health.ready').count()) === 1;
  });
  invariant(machine);
  await nav('saves');
  return h;
}
async function recover(machine, mode) {
  await active.page
    .locator('[data-action="backup-cleanup-' + mode + '"][data-id="' + machine.pending.id + '"]')
    .click();
}
async function rollbackFlow(machine) {
  interrupt(machine, 'backup-staged');
  await launch(machine);
  const initial = await pendingStatus(machine),
    pendingScreenshot = await screenshot('A-staged-pending');
  await recover(machine, 'rollback');
  await toast('全部暂存副本已放回列表');
  await until('staged transaction rolled back', () => activePending(machine).length === 0);
  assert.deepEqual(tree(path.join(machine.saves.root, machine.selected.id)), machine.selectedBefore);
  assert.deepEqual(machine.saves.verify(machine.selected.id).manifest, machine.selected);
  const ready = await realReady(machine);
  assert.equal(ready.lastBackup.id, machine.selected.id);
  record('A首个副本暂存后exit73：首屏及总览不ready，真实UI放回全部原ID/原字节，守护重新校验原副本', {
    initial,
    ready,
    selectedId: machine.selected.id,
    keepId: machine.keep.id,
    pendingScreenshot,
    recoveredScreenshot: await screenshot('A-rollback-recovered'),
    healthObservations: machine.healthObservations,
  });
  await close();
}
async function deletedFlow(machine) {
  interrupt(machine, 'file-deleted');
  machine.selectedMustBeGone = true;
  await launch(machine);
  const initial = await pendingStatus(machine);
  assert.equal(await active.page.locator('[data-action="backup-cleanup-rollback"]').count(), 0);
  await setDialogs(machine.wrongFile, 1);
  const beforeWrongDialogs = (await dialogs()).length;
  await recover(machine, 'finish');
  const rejected = await toast('这不是原先确认的保护包', true);
  expectedErrors.push(rejected);
  const wrongDialogs = (await dialogs()).slice(beforeWrongDialogs);
  assert.deepEqual(
    wrongDialogs.map((d) => d.type),
    ['open'],
  );
  assert.deepEqual(tree(machine.transactionDirectory), machine.pendingBefore);
  await pendingStatus(machine);
  const errorScreenshot = await screenshot('B-wrong-package-rejected');
  await setDialogs(machine.packageFile, 0);
  const beforeCancelDialogs = (await dialogs()).length;
  await recover(machine, 'finish');
  await until('correct original package offered confirmation and user canceled', async () => {
    const current = (await dialogs()).slice(beforeCancelDialogs);
    return (
      current.some((d) => d.type === 'confirm' && d.response === 0) &&
      !(await active.page.locator('[data-action="backup-cleanup-finish"]').isDisabled())
    );
  });
  assert.deepEqual(tree(machine.transactionDirectory), machine.pendingBefore);
  await pendingStatus(machine);
  await setDialogs(machine.packageFile, 1);
  await recover(machine, 'finish');
  await toast('这批副本清理已完成，导出留底继续保留');
  await until('partially deleted transaction finished', () => activePending(machine).length === 0);
  assert.equal(readJSON(path.join(machine.transactionDirectory, 'receipt.json')).phase, 'complete');
  assert(!fs.existsSync(path.join(machine.transactionDirectory, machine.selected.id)));
  const ready = await realReady(machine);
  record('B首个文件删除后exit73：错误原包拒绝、正确原包取消都保留暂存；UI确认finish后真实新auto副本才ready', {
    initial,
    rejected,
    wrongDialogs,
    ready,
    deletedId: machine.selected.id,
    newId: ready.lastBackup.id,
    errorScreenshot,
    recoveredScreenshot: await screenshot('B-finished-new-auto-backup'),
    dialogs: await dialogs(),
    healthObservations: machine.healthObservations,
  });
  await close();
}
async function tempRememberedFlow(machine) {
  await launch(machine);
  await nav('saves');
  const remembered = await realReady(machine);
  assert.equal(
    remembered.lastBackup.id,
    machine.selected.id,
    'same-session AutoBackup must actually remember the original selected ID before interruption',
  );
  assert.equal(
    machine.saves
      .list()
      .filter((b) => path.resolve(b.source).toLowerCase() === path.resolve(machine.source).toLowerCase())
      .length,
    1,
  );
  interrupt(machine, 'receipt-temp-deleting');
  await active.page.locator('[data-action="refresh"]').click();
  const pendingHealth = await pendingStatus(machine);
  assert.equal(
    pendingHealth.lastBackup,
    null,
    'active pending must hide its formerly remembered selected ID',
  );
  assert.equal(machine.pending.phase, 'ready');
  assert.equal(await active.page.locator('[data-action="backup-cleanup-rollback"]').count(), 1);
  assert.equal(await active.page.locator('[data-action="backup-cleanup-finish"]').count(), 1);
  const pendingScreenshot = await screenshot('C-temp-receipt-pending');
  await setDialogs(machine.packageFile, 1);
  await recover(machine, 'finish');
  machine.selectedMustBeGone = true;
  await toast('这批副本清理已完成，导出留底继续保留');
  await until('canonical valid temp receipt recovered', () => activePending(machine).length === 0);
  assert(!fs.existsSync(path.join(machine.saves.root, machine.selected.id)));
  assert(!fs.existsSync(path.join(machine.transactionDirectory, machine.selected.id)));
  assert.deepEqual(
    { bytes: fs.statSync(machine.tempFile).size, sha256: fileHash(machine.tempFile) },
    machine.tempBefore,
    'fsynced temporary receipt bytes were not preserved',
  );
  const ready = await realReady(machine);
  assert.notEqual(ready.lastBackup.id, remembered.lastBackup.id);
  record(
    'C同会话真实记忆原ID；deleting凭据fsync-close后rename前exit73，UI仍可恢复且temp字节保留，finish忘记旧ID并验证新auto副本',
    {
      remembered,
      pendingHealth,
      ready,
      deletedId: machine.selected.id,
      newId: ready.lastBackup.id,
      tempFile: machine.tempFile,
      tempBefore: machine.tempBefore,
      pendingScreenshot,
      recoveredScreenshot: await screenshot('C-temp-recovered-new-auto-backup'),
      healthObservations: machine.healthObservations,
    },
  );
  await close();
}
function sourceHashes() {
  return Object.fromEntries(
    [
      'scripts/backup-care-smoke.cjs',
      'src/core/backup-care.cjs',
      'src/core/auto-backup.cjs',
      'src/core/protection-status.cjs',
      'src/core/store.cjs',
      'src/main.cjs',
      'src/preload.cjs',
      'src/renderer/app.js',
    ].map((name) => [name, fileHash(path.join(base, name))]),
  );
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
    elapsedMs: Date.now() - Date.parse(startedAt),
    error: error?.stack,
    mode: process.env.YIJIAN_EXECUTABLE ? 'packaged' : 'source',
    executableOverride: process.env.YIJIAN_EXECUTABLE || null,
    electronDist: process.env.ELECTRON_OVERRIDE_DIST_PATH || null,
    sourceHashes: sourceHashes(),
    fixtureSummary: machines.map((m) => ({
      name: m.name,
      source: m.source,
      sourceBefore: m.sourceBefore,
      otherSource: m.otherSource,
      otherSourceBefore: m.otherSourceBefore,
      selectedId: m.selected.id,
      keepId: m.keep.id,
      keepBefore: m.keepBefore,
      packageFile: m.packageFile,
      packageBefore: m.packageBefore,
      tempFile: m.tempFile,
      tempBefore: m.tempBefore,
    })),
    localOnly: [
      {
        path: data,
        classification: 'keep',
        reason:
          'Private synthetic recovery fixtures, deliberately interrupted receipts, packages and screenshots; exclude from commits/releases.',
      },
      {
        path: resultFile,
        classification: 'keep',
        reason: 'Private UI implementation/runtime evidence, not an independent review vote.',
      },
    ],
  };
  fs.writeFileSync(path.join(data, 'report.json'), JSON.stringify(value, null, 2));
  fs.writeFileSync(resultFile, JSON.stringify(value, null, 2));
  return value;
}
(async () => {
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  let failure;
  try {
    assert.equal(process.platform, 'win32', 'This regression requires native Windows Electron');
    const a = await fixture('机器A暂存回滚', 1100),
      b = await fixture('机器B部分删除', 2200),
      c = await fixture('机器C临时凭据同会话', 3300);
    await rollbackFlow(a);
    await deletedFlow(b);
    await tempRememberedFlow(c);
    for (const machine of machines) invariant(machine);
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = error;
    process.exitCode = 1;
    if (active?.page) {
      try {
        evidence.failureScreenshot = await screenshot('failure');
      } catch (shotError) {
        errors.push('failure screenshot: ' + shotError.message);
      }
    }
    console.error(error);
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
        resultFile,
        elapsedMs: result.elapsedMs,
      }),
    );
  }
})();
