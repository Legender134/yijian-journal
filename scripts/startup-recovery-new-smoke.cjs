'use strict';
// All bytes are synthetic. No usable journal export exists in this fixture.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const base = path.join(__dirname, '..'),
  repository = path.resolve(base, '..', '..', '..');
process.env.ELECTRON_OVERRIDE_DIST_PATH ||= path.join(repository, 'node_modules', 'electron', 'dist');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const packagedExecutable = process.env.YIJIAN_EXECUTABLE || '',
  executablePath = packagedExecutable || require('electron'),
  launchArgs = packagedExecutable ? [] : [base];
const { Saves } = require('../src/core/saves.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { isolation } = require('../src/core/startup-recovery.cjs');
const out = path.join(
  repository,
  '.test-data',
  'maturity',
  'implementation-startup-recovery',
  'ui-new-noexport-' + Date.now(),
);
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'userdata'),
  fakeSaves = path.join(out, 'synthetic-game-files');
fs.mkdirSync(data);
fs.mkdirSync(fakeSaves);
fs.writeFileSync(
  path.join(fakeSaves, '29.sav'),
  'invented foreign save slot that new-journal recovery must never write',
);
const journal = path.join(data, 'journal.json'),
  previous = journal + '.previous';
fs.writeFileSync(journal, 'synthetic no-export broken primary');
fs.writeFileSync(previous, 'synthetic no-export broken previous');
const originals = [journal, previous].map((file) => [file, fs.readFileSync(file)]);
const backups = new Saves(path.join(data, 'save-backups'));
backups.capture(fakeSaves, '新建流程必须保留的合成完整备份');
const timeline = new Timeline(path.join(data, 'game-timeline'));
timeline.commit({
  ...timeline.data,
  enabled: true,
  nativeProtocol: 2,
  source: fakeSaves,
  ownerHash: 'b'.repeat(64),
});
function tree(root) {
  const result = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else
        result.push([
          path.relative(root, file),
          crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        ]);
    }
  }
  visit(root);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
const protectedTrees = [fakeSaves, backups.root, timeline.root].map((root) => [root, tree(root)]);
function verifyUnrelated() {
  for (const [root, snapshot] of protectedTrees) assert.deepEqual(tree(root), snapshot);
}
function verifyOriginals() {
  for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
}
let app;
const errors = [],
  facts = {
    fixture: out,
    noUsableJournalExport: true,
    executionMode: packagedExecutable ? 'packaged' : 'source',
    executablePath: path.resolve(executablePath),
    scenarios: [],
  };
async function launch(recovery = true) {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, args: launchArgs, cwd: base, env, timeout: 30000 });
  const win = await app.firstWindow();
  win.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ dialog }, watched) => {
    const fs = process.getBuiltinModule('fs'),
      path = process.getBuiltinModule('path');
    global.__newJournalGameWrites = [];
    dialog.showOpenDialog = async () => {
      throw Error('New-journal flow must not require an export picker');
    };
    const inside = (file) =>
      typeof file === 'string' &&
      path
        .resolve(file)
        .toLowerCase()
        .startsWith(watched.toLowerCase() + path.sep);
    for (const name of [
      'writeFileSync',
      'appendFileSync',
      'truncateSync',
      'unlinkSync',
      'rmSync',
      'renameSync',
      'copyFileSync',
    ]) {
      const original = fs[name];
      fs[name] = function (...args) {
        const targets =
          name === 'copyFileSync' ? [args[1]] : name === 'renameSync' ? args.slice(0, 2) : [args[0]];
        if (targets.some(inside)) global.__newJournalGameWrites.push({ operation: name, targets });
        return original.apply(this, args);
      };
    }
    const open = fs.openSync;
    fs.openSync = function (file, flags, ...args) {
      const writing =
        typeof flags === 'number'
          ? !!(
              flags &
              (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)
            )
          : /[wa+]/.test(flags);
      if (writing && inside(file))
        global.__newJournalGameWrites.push({ operation: 'openSync', targets: [file] });
      return open.call(this, file, flags, ...args);
    };
  }, fakeSaves);
  await win.waitForSelector(recovery ? '#new-journal' : '.layout');
  return win;
}
async function newPreview(win) {
  await win.locator('#new-journal').click();
  await win.waitForSelector('#preview:not([hidden])');
  assert.equal(await win.locator('#ack').isChecked(), false);
  assert.equal(await win.locator('#confirm').isEnabled(), false);
  assert.match(await win.locator('#preview-title').innerText(), /空手札/);
  assert.match(await win.locator('#scope').innerText(), /尚未恢复/);
  assert.match(await win.locator('#scope').innerText(), /原样保留/);
  assert.match(await win.locator('#profiles').innerText(), /0 项目标.*0 条江湖记录.*0 份草稿/);
  verifyOriginals();
  verifyUnrelated();
}
async function closeNormal(win) {
  assert.deepEqual(await app.evaluate(() => global.__newJournalGameWrites), []);
  const closed = app.waitForEvent('close');
  await win.evaluate(() => window.journal.window('quit')).catch(() => {});
  await closed;
  app = null;
}
(async () => {
  try {
    let win = await launch();
    assert.equal(await win.evaluate(() => typeof window.journal), 'undefined');
    await newPreview(win);
    await win.screenshot({ path: path.join(out, '01-new-journal-preview.png'), fullPage: true });
    const closed = app.waitForEvent('close');
    await win.locator('#cancel').click();
    await closed;
    app = null;
    verifyOriginals();
    verifyUnrelated();
    assert.equal(fs.existsSync(path.join(data, 'journal-recovery-isolation.json')), false);
    facts.scenarios.push(
      'no export: new-journal preview is empty with default unchecked second confirmation; cancel keeps both broken originals and all backups/timeline',
    );
    win = await launch();
    await newPreview(win);
    await app.evaluate((_electron, file) => {
      const fs = process.getBuiltinModule('fs'),
        original = fs.renameSync;
      fs.renameSync = function (...args) {
        if (args[1] === file) {
          fs.renameSync = original;
          throw Object.assign(Error('synthetic atomic replacement failure'), { code: 'ENOSPC' });
        }
        return original.apply(this, args);
      };
    }, journal);
    await win.locator('#ack').check();
    await win.locator('#confirm').click();
    await win.waitForSelector('#error:not([hidden])');
    assert.match(await win.locator('#error').innerText(), /磁盘空间/);
    verifyOriginals();
    verifyUnrelated();
    await win.screenshot({
      path: path.join(out, '02-new-journal-write-failed-retryable.png'),
      fullPage: true,
    });
    facts.scenarios.push(
      'actual atomic rename failure shown in UI; both broken originals and unrelated files retained; same explicit confirmation can retry',
    );
    const nextWindow = app.waitForEvent('window');
    await win.locator('#confirm').click();
    win = await nextWindow;
    win.on('pageerror', (error) => errors.push(error.message));
    await win.waitForSelector('.layout');
    let bootstrap = await win.evaluate(async () => (await window.journal.bootstrap()).data);
    assert.equal(bootstrap.state.profiles[0].notes, '');
    assert.deepEqual(bootstrap.state.profiles[0].goals, []);
    assert.equal(bootstrap.state.settings.savePath, '');
    assert.equal(bootstrap.state.settings.autoBackup, false);
    assert.equal(bootstrap.environment.timeline.enabled, false);
    assert.equal(bootstrap.environment.journalRecovery.isolated, true);
    assert.equal(bootstrap.environment.journalRecovery.needsSaveConfirmation, true);
    assert.ok(bootstrap.gameIndex.entries.length > 0);
    assert.match(await win.locator('body').innerText(), /重新确认本机存档|选择本机存档/);
    const gate = isolation(data),
      retained = path.join(data, gate.retainedDirectory);
    for (const [file, bytes] of originals)
      assert.deepEqual(fs.readFileSync(path.join(retained, path.basename(file))), bytes);
    assert.equal(JSON.parse(fs.readFileSync(path.join(retained, 'receipt.json'))).mode, 'new');
    verifyUnrelated();
    const write = await win.evaluate(() =>
      window.journal.mutate({ type: 'note', value: '没有导出备份也能继续保存的离线新手札' }),
    );
    assert.equal(write.ok, true);
    await win.screenshot({ path: path.join(out, '03-new-journal-normal-offline.png') });
    facts.scenarios.push(
      'explicit confirmation and retry open normal offline assistant; new journal accepts local notes; verified broken-original copies remain, old backups/native timeline unchanged',
    );
    await closeNormal(win);
    win = await launch(false);
    bootstrap = await win.evaluate(async () => (await window.journal.bootstrap()).data);
    assert.equal(bootstrap.state.profiles[0].notes, '没有导出备份也能继续保存的离线新手札');
    assert.equal(bootstrap.environment.journalRecovery.isolated, true);
    assert.equal(bootstrap.environment.journalRecovery.needsSaveConfirmation, true);
    assert.equal(bootstrap.environment.timeline.enabled, false);
    assert.equal(bootstrap.state.settings.savePath, '');
    assert.deepEqual(isolation(data), gate);
    verifyUnrelated();
    await win.screenshot({ path: path.join(out, '04-new-journal-restart-isolated.png') });
    facts.scenarios.push(
      'normal restart retains new note and visible recovery isolation; no path selected and no native permissions enabled',
    );
    facts.gameWriteCount = (await app.evaluate(() => global.__newJournalGameWrites)).length;
    facts.protectedTreesUnchanged = true;
    facts.pageErrors = errors;
    assert.deepEqual(errors, []);
    await closeNormal(win);
    facts.passed = true;
    fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(facts, null, 2));
    console.log(
      JSON.stringify({
        passed: true,
        evidence: out,
        scenarios: facts.scenarios,
        gameWriteCount: facts.gameWriteCount,
        pageErrors: errors,
      }),
    );
  } catch (error) {
    facts.error = error.stack;
    fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(facts, null, 2));
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
