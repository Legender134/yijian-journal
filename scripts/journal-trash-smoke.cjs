'use strict';
// Recoverable records in real main/compact windows. All data and saves are synthetic.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..'),
  override = process.env.YIJIAN_EXECUTABLE;
const executable = path.join(
  base,
  'dist',
  'v' + require('../package.json').version,
  '逸剑手札-win32-x64',
  '逸剑手札.exe',
);
if (override && path.resolve(override).toLowerCase() !== executable.toLowerCase())
  throw Error('只接受本候选的实际 EXE');
const data = path.join(base, '.test-data', 'journal-trash-' + Date.now()),
  userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames'),
  results = path.join(base, 'test-results');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const saveFile = path.join(source, '1.sav');
fs.writeFileSync(
  saveFile,
  syntheticSave({ full: true, seconds: 9000, quests: [{ id: 5200, step: 1 }], inventory: [] }),
);
const settled = new Date(Date.now() - 5000);
fs.utimesSync(saveFile, settled, settled);
const hash = () => createHash('sha256').update(fs.readFileSync(saveFile)).digest('hex'),
  initialSaveHash = hash();
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'note', value: '旧整段笔记保留' });
store.mutate({ type: 'goal-add', title: '仅个人完成的目标' });
const goalId = store.get().profiles[0].goals[0].id;
store.mutate({ type: 'goal-toggle', id: goalId });
store.mutate({
  type: 'journal-entry-put',
  title: '误删前的手写内容',
  body: '这是要逐条恢复的重要正文',
  occurredAt: '2026-10-08T10:00:00.000Z',
  tags: ['人物'],
  links: [{ type: 'goal', id: goalId }],
  snapshotMode: 'none',
});
const original = store.get().profiles[0].journalEntries.find((entry) => entry.kind === 'manual'),
  recordId = original.id;
new Saves(path.join(userData, 'save-backups')).capture(source, '合成存档保护点');
const protection = path.join(data, '含已删除记录.yijian-protection'),
  journal = path.join(data, '含已删除记录.json');
const checks = [],
  errors = [];
let app, page, companion;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'YIJIAN_EXECUTABLE', 'YIJIAN_TEST_HIDDEN', 'YIJIAN_TEST_TRAY'])
    delete env[key];
  for (const key of Object.keys(env)) if (/^YIJIAN_GAME.*(?:PATH|EXECUTABLE|EXE)$/.test(key)) delete env[key];
  app = await _electron.launch({
    executablePath: override ? executable : require('electron'),
    args: override ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.layout').waitFor();
}
async function current() {
  const result = await page.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.state.profiles.find((p) => p.id === result.data.state.activeProfileId);
}
async function until(predicate) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const p = await current();
    if (predicate(p)) return p;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('记录操作未保存');
}
async function nav(id) {
  await page.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function remove(target, id, confirm = true) {
  await target
    .locator('[data-action="journal-entry-open"][data-id="' + id + '"]')
    .first()
    .click();
  await target.locator('#overlay [data-action="journal-entry-remove"]').click();
  if (confirm) await target.locator('[data-action="journal-entry-remove-confirm"]').click();
  else await target.keyboard.press('Escape');
}
async function record(target, title, body) {
  await target.locator('[data-action="journal-entry-new"]').click();
  await target.locator('#journal-title').fill(title);
  await target.locator('#journal-body').fill(body);
  await target.locator('[data-action="journal-entry-save"]').click();
  return (await until((p) => p.journalEntries.some((entry) => entry.title === title))).journalEntries.find(
    (entry) => entry.title === title,
  );
}
async function written(file, parse = false) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length) return parse ? JSON.parse(bytes) : bytes;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('导出未完成');
}
(async () => {
  try {
    await launch();
    await nav('journal');
    await remove(page, recordId, false);
    assert((await current()).journalEntries.some((entry) => entry.id === recordId));
    await remove(page, recordId);
    await until((p) => p.journalTrash?.some((row) => row.entry.id === recordId));
    const newer = await record(page, '删除后新写的内容', '后来的内容必须保留');
    await page.locator('[data-action="journal-trash-open"]').click();
    await page.locator('#journal-trash-query').fill('重要正文');
    assert.equal(await page.locator('[data-journal-trash-id]').count(), 1);
    await page.locator('[data-action="journal-trash-detail"]').first().click();
    assert.match(await page.locator('#overlay').innerText(), /重要正文/);
    assert.equal(await page.locator('#overlay [data-action="journal-entry-edit"]').count(), 0);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="journal-trash-restore-preview"]').click();
    await page.keyboard.press('Escape');
    assert((await current()).journalTrash.some((row) => row.entry.id === recordId));
    await page.locator('[data-action="journal-trash-restore-preview"]').click();
    await page.locator('[data-action="journal-trash-confirm"]').click();
    let p = await until((p) => p.journalEntries.some((entry) => entry.id === recordId));
    const restored = p.journalEntries.find((entry) => entry.id === recordId);
    assert.equal(restored.body, original.body);
    assert.equal(restored.occurredAt, original.occurredAt);
    assert.equal(restored.createdAt, original.createdAt);
    assert(Date.parse(restored.updatedAt) > Date.parse(original.updatedAt));
    assert(p.journalEntries.some((entry) => entry.id === newer.id));
    assert.equal(p.goals[0].done, true);
    assert.equal(p.notes, '旧整段笔记保留');
    checks.push('删除与恢复都可取消；正文、标签和关联可搜索查看，逐条恢复保留后续内容与原事件时间');
    await page.locator('[data-action="journal-trash-close"]').click();
    await remove(page, recordId);
    await until((p) => p.journalTrash.some((row) => row.entry.id === recordId));
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, journal);
    await page.locator('[data-action="journal-export"]').click();
    const exported = await written(journal, true);
    assert.equal(exported.profiles[0].journalTrash[0].entry.body, original.body);
    await nav('saves');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, protection);
    await page.locator('[data-action="protection-export"]').click();
    await written(protection);
    await page.waitForFunction(() => !document.querySelector('[data-action="protection-export"]')?.disabled);
    checks.push('手札 JSON 与全部保护资料实际导出均携带已删除记录');
    await nav('journal');
    await page.locator('[data-action="journal-trash-open"]').click();
    await page.locator('[data-action="journal-trash-purge-preview"]').click();
    await page.keyboard.press('Escape');
    assert((await current()).journalTrash.some((row) => row.entry.id === recordId));
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await created;
    companion.on('pageerror', (error) => errors.push(error.message));
    await companion.locator('.compact-shell').waitFor();
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill(newer.title);
    await companion.locator('.search-result[data-action="journal-entry-open"]').click();
    await companion.keyboard.press('Escape');
    // Open the journal route through a normal result; editing and saving retains the existing text.
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill(newer.title);
    await companion.locator('.search-result[data-action="journal-entry-open"]').click();
    await companion.locator('[data-action="journal-entry-edit"]').click();
    await companion.locator('[data-action="journal-entry-save"]').click();
    await companion.locator('[data-action="journal-trash-open"]').waitFor();
    await page.locator('[data-action="journal-trash-purge-preview"]').click();
    await companion.locator('[data-action="journal-trash-open"]').click();
    await companion.locator('[data-action="journal-trash-restore-preview"]').click();
    await companion.locator('[data-action="journal-trash-confirm"]').click();
    await until((p) => p.journalEntries.some((entry) => entry.id === recordId));
    await companion.locator('[data-action="journal-trash-close"]').click();
    await remove(companion, recordId);
    await until((p) => p.journalTrash.some((row) => row.entry.id === recordId));
    await page.locator('[data-action="journal-trash-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('已变化'));
    assert((await current()).journalTrash.some((row) => row.entry.id === recordId));
    await page.keyboard.press('Escape');
    checks.push('另一窗口恢复并再次移除后，旧永久清除确认被阻断且新移除记录保留');
    await page.locator('[data-action="journal-trash-purge-preview"]').click();
    await page.locator('[data-action="journal-trash-confirm"]').click();
    p = await until((p) => !p.journalTrash.some((row) => row.entry.id === recordId));
    assert(p.journalEntries.some((entry) => entry.id === newer.id));
    assert.equal(p.goals[0].done, true);
    checks.push('重新核对后只永久清除所选记录，后续内容和个人目标保留');
    await nav('saves');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, protection);
    await page.locator('[data-action="protection-import"]').click();
    const browse = page.locator('[data-action="protection-journal-profile"]');
    await browse.waitFor({ state: 'attached' });
    await browse.locator('xpath=ancestor::details[1]').locator('summary').first().click();
    await browse.click();
    await page.locator('[data-action="historical-journal-trash-open"]').click();
    assert.equal(await page.locator('[data-journal-trash-id="' + recordId + '"]').count(), 1);
    assert.equal(await page.locator('[data-action="journal-trash-restore-preview"]').count(), 0);
    assert.equal(await page.locator('[data-action="journal-trash-purge-preview"]').count(), 0);
    await page.locator('[data-action="historical-journal-trash-detail"]').first().click();
    assert.match(await page.locator('#overlay').innerText(), /重要正文/);
    await page.keyboard.press('Escape');
    assert.equal((await current()).journalTrash.length, 0);
    assert((await current()).journalEntries.some((entry) => entry.id === newer.id));
    await page.screenshot({ path: path.join(results, 'journal-trash-history-readonly.png'), timeout: 15000 });
    checks.push('保护包中的已删除记录可只读检索全文，导入浏览不替换当前手札');
    await app.close();
    app = null;
    await launch();
    p = await current();
    assert(p.journalEntries.some((entry) => entry.id === newer.id));
    assert.equal(p.journalTrash.length, 0);
    assert.equal(p.goals[0].done, true);
    checks.push('冷重启保留恢复及永久清除结果、后续内容与个人状态');
    assert.equal(hash(), initialSaveHash);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'journal-trash-result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          executionMode: override ? 'packaged-assistant' : 'source-electron',
          checks,
          errors,
          data,
          initialSaveHash,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, data }));
  } catch (error) {
    fs.writeFileSync(
      path.join(results, 'journal-trash-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(results, 'journal-trash-failure.png'), timeout: 15000 })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
