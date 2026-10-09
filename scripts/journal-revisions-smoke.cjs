'use strict';
// Short real Electron UI acceptance; only isolated synthetic saves are used.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { MAX_REVISIONS } = require('../src/core/journal-revisions.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..'),
  version = require('../package.json').version;
const executable = path.join(base, 'dist', 'v' + version, '逸剑手札-win32-x64', '逸剑手札.exe');
if (
  process.env.YIJIAN_EXECUTABLE &&
  path.resolve(process.env.YIJIAN_EXECUTABLE).toLowerCase() !== executable.toLowerCase()
)
  throw Error('只接受本候选的实际 EXE');
const data = path.join(base, '.test-data', 'record-versions-ui-' + Date.now()),
  userData = path.join(data, 'userdata');
const source = path.join(data, 'synthetic-SaveGames'),
  resultDir = path.join(base, 'test-results', 'journal-revisions-' + Date.now());
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(resultDir, { recursive: true });
const saveFile = path.join(source, '1.sav');
fs.writeFileSync(saveFile, syntheticSave({ full: true, seconds: 7200 }));
const sha = () => createHash('sha256').update(fs.readFileSync(saveFile)).digest('hex'),
  initialHash = sha();
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'goal-add', title: '已经完成的原目标' });
const goalId = store.get().profiles[0].goals[0].id;
store.mutate({ type: 'goal-toggle', id: goalId });
const completeBody = '<b>旧正文只显示文本</b>\n' + '完整旧正文'.repeat(760) + '\n完整旧正文末尾';
store.mutate(
  {
    type: 'journal-entry-put',
    title: '误编辑前的标题',
    body: completeBody,
    occurredAt: '2026-10-09T01:00:00.000Z',
    tags: ['旧标签'],
    links: [{ type: 'goal', id: goalId }],
    snapshotMode: 'selected',
  },
  {
    selectedReference: {
      name: '1.sav',
      hash: initialHash,
      modifiedAt: '2026-10-09T01:00:00.000Z',
      metadata: { mapName: '梧桐村', playSeconds: 7200 },
    },
  },
);
const original = store.get().profiles[0].journalEntries.find((entry) => entry.kind === 'manual');
let app, page;
const errors = [],
  checks = [];
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData, YIJIAN_TEST_TRAY: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE ? executable : require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.layout').waitFor();
}
async function profile() {
  const result = await page.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.state.profiles.find((p) => p.id === result.data.state.activeProfileId);
}
async function until(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const p = await profile();
    if (predicate(p)) return p;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('操作未保存');
}
async function journal() {
  await page.locator('.nav-btn[data-id="journal"]').click();
}
async function openEntry(id) {
  await page
    .locator('[data-action="journal-entry-open"][data-id="' + id + '"]')
    .first()
    .click();
}
async function mutate(command) {
  const result = await page.evaluate((intent) => window.journal.mutate(intent), command);
  assert(result.ok, result.error);
  return result;
}
(async () => {
  try {
    await launch();
    await journal();
    await openEntry(original.id);
    await page.locator('[data-action="journal-entry-edit"]').click();
    await page.locator('#journal-title').fill('误编辑后的标题');
    await page.locator('#journal-body').fill('误覆盖后当前正文');
    await page.locator('#journal-tags').fill('新标签');
    await page.locator('#journal-snapshot').selectOption('none');
    await page.locator('[data-action="journal-entry-save"]').click();
    await page.waitForFunction(() => !document.querySelector('#journal-entry-form'));
    let p = await until((p) => p.journalRevisions?.length === 1);
    assert.deepEqual(p.journalRevisions[0].entry, original);
    const revisionId = p.journalRevisions[0].id;
    await page.locator('[data-action="journal-entry-new"]').click();
    await page.locator('#journal-title').fill('后来写下的记录');
    await page.locator('#journal-body').fill('后来的内容必须保留');
    await page.locator('[data-action="journal-entry-save"]').click();
    await until((p) => p.journalEntries.some((entry) => entry.title === '后来写下的记录'));
    await openEntry(original.id);
    await page.locator('[data-action="journal-revisions-entry"]').click();
    assert.equal(await page.locator('[data-journal-revision-row]').count(), 1);
    await page.locator('[data-action="journal-revision-detail"]').click();
    assert.match(await page.locator('#overlay').innerText(), /完整旧正文末尾/);
    assert.match(await page.locator('#overlay').innerText(), /误编辑前的标题|旧标签|已经完成的原目标/);
    assert.equal(await page.locator('#overlay b').count(), 0);
    await page.locator('#overlay summary').click();
    assert.match(await page.locator('#overlay').innerText(), new RegExp(initialHash));
    await page.screenshot({ path: path.join(resultDir, 'version-full-preview.png') });
    await page.keyboard.press('Escape');
    await page.locator('[data-action="journal-revision-restore-preview"]').click();
    await page.keyboard.press('Escape');
    assert.equal((await profile()).journalEntries.length, 3);
    checks.push(
      '真实编辑表单通过 draft commit 保留完整前版本；逐条入口完整预览正文、标签、关联、存档摘要和时间，取消恢复不写入',
    );
    await page.locator('[data-action="journal-revision-restore-preview"]').click();
    p = await profile();
    const sourceEntry = p.journalEntries.find((entry) => entry.id === original.id);
    await mutate({
      type: 'journal-entry-update',
      id: original.id,
      expectedEntry: sourceEntry,
      title: '另一窗口刚保存',
      body: '并发修改后的正文',
      occurredAt: sourceEntry.occurredAt,
      tags: sourceEntry.tags,
      links: sourceEntry.links.map(({ type, id }) => ({ type, id })),
      snapshotMode: 'keep',
    });
    await page.locator('[data-action="journal-revision-confirm"]').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('原记录已变化')),
    );
    assert.equal((await profile()).journalEntries.length, 3);
    await page.keyboard.press('Escape');
    await page
      .locator('[data-action="journal-revision-restore-preview"][data-id="' + revisionId + '"]')
      .click();
    await page.locator('[data-action="journal-revision-confirm"]').click();
    p = await until((p) => p.journalEntries.length === 4);
    const restored = p.journalEntries.find(
      (entry) => entry.id !== original.id && entry.body === original.body,
    );
    assert(restored);
    assert.deepEqual(restored.snapshot, original.snapshot);
    assert.deepEqual(restored.links, original.links);
    assert.equal(p.journalEntries.find((entry) => entry.id === original.id).body, '并发修改后的正文');
    assert(p.journalEntries.some((entry) => entry.title === '后来写下的记录'));
    assert.equal(p.goals[0].done, true);
    checks.push('stale 恢复确认拒绝写入；重新核对后另存为新记录，原正文、后来内容、完整快照和已完成目标保留');
    await page
      .locator('[data-action="journal-revision-purge-preview"][data-id="' + revisionId + '"]')
      .click();
    await page.keyboard.press('Escape');
    assert.equal((await profile()).journalRevisions.length, 2);
    await page
      .locator('[data-action="journal-revision-purge-preview"][data-id="' + revisionId + '"]')
      .click();
    await page.locator('[data-action="journal-revision-confirm"]').click();
    await until((p) => p.journalRevisions.length === 1);
    assert.equal((await profile()).journalEntries.length, 4);
    await page.locator('[data-action="journal-revisions-close"]').click();
    const exported = path.join(data, 'with-versions.json');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, exported);
    await page.locator('[data-action="journal-export"]').click();
    const end = Date.now() + 10000;
    while (!fs.existsSync(exported) && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(JSON.parse(fs.readFileSync(exported)).profiles[0].journalRevisions.length, 1);
    await app.close();
    app = null;
    const loaded = new Store(userData, catalog),
      state = loaded.get(),
      selected = state.profiles[0];
    const sample = selected.journalRevisions[0];
    selected.journalRevisions = Array.from({ length: MAX_REVISIONS }, (_, i) => ({
      ...structuredClone(sample),
      id: 'capacity-' + i,
    }));
    loaded.commit(state);
    await launch();
    await journal();
    await openEntry(original.id);
    await page.locator('[data-action="journal-entry-edit"]').press('Enter');
    await page.locator('#journal-body').fill('容量满时这份编辑草稿必须保留');
    await until((p) => p.journalDrafts.some((draft) => draft.body === '容量满时这份编辑草稿必须保留'));
    await page.locator('[data-action="journal-entry-save"]').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('5000')),
    );
    assert.equal(await page.locator('#journal-body').inputValue(), '容量满时这份编辑草稿必须保留');
    p = await profile();
    assert.equal(p.journalEntries.find((entry) => entry.id === original.id).body, '并发修改后的正文');
    assert.equal(p.journalRevisions.length, MAX_REVISIONS);
    assert(p.journalDrafts.some((draft) => draft.body === '容量满时这份编辑草稿必须保留'));
    await page.screenshot({ path: path.join(resultDir, 'version-capacity-draft-preserved.png') });
    checks.push(
      '永久清除单版本可取消且逐条确认；JSON 包含旧版本；重启后 5000 份上限拒绝保存且保留正式正文、全部旧版本和窗口/本机草稿',
    );
    assert.equal(sha(), initialHash);
    assert.deepEqual(errors, []);
  } catch (error) {
    errors.push(error.stack);
    process.exitCode = 1;
    console.error(error);
    if (page) {
      await page.screenshot({ path: path.join(resultDir, 'ui-failure.png') }).catch(() => {});
      fs.writeFileSync(
        path.join(resultDir, 'ui-failure-dom.txt'),
        await page
          .locator('body')
          .innerText()
          .catch(() => 'unavailable'),
      );
    }
  } finally {
    if (app) await app.close().catch(() => {});
    const report = {
      status: errors.length ? 'FAIL' : 'PASS',
      version,
      packaged: !!process.env.YIJIAN_EXECUTABLE,
      checks,
      errors,
      data,
      syntheticSaveUnchanged: sha() === initialHash,
    };
    fs.writeFileSync(path.join(resultDir, 'ui-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
