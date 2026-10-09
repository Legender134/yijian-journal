'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const complete = require('../src/core/complete-migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const base = path.resolve(__dirname, '..'),
  data = path.join(base, '.test-data', 'gift-identity-ui-' + Date.now());
const userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
const saveFile = path.join(source, '0.sav');
fs.writeFileSync(
  saveFile,
  syntheticSave({ full: true, seconds: 9000, quests: [], inventory: [{ id: 1002, count: 1 }] }),
);
const old = new Date(Date.now() - 5000);
fs.utimesSync(saveFile, old, old);
const originalSave = fs.readFileSync(saveFile);
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'save-slot', value: '0.sav', mode: 'slot' });
let app, page;
const checks = [],
  errors = [];
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.layout').waitFor();
}
async function planGift() {
  const result = await page.evaluate(() => window.journal.journeyPlan());
  assert(result.ok, result.error);
  return result.data.actions.find((row) => row.kind === 'gift');
}
async function waitGift(id, missing) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const gift = await planGift();
    if (gift?.gift.itemId === id && gift.gift.missing === missing) return gift;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw Error('gift plan did not reflect exact item: ' + id);
}
async function editGift() {
  await page.locator('.nav-btn[data-id="journey"]').click();
  if (!(await page.locator('[data-action="journey-gift-edit"]').count()))
    await page.locator('[data-action="journey-show-completed"]').click();
  await page.locator('[data-action="journey-gift-edit"]').first().click();
}
(async () => {
  try {
    await launch();
    await page.locator('[data-action="search"]').click();
    await page.locator('#global-search').fill('道通');
    await page.locator('#global-results [data-action="database-detail"][data-id="npc-5011"]').click();
    await page.locator('.drawer-actions [data-action="journey-gift-dialog"]').click();
    await page.locator('#journey-person-search').fill('道通');
    const people = await page.locator('#journey-person option').allTextContents();
    assert(people.some((label) => label.includes('5011')) && people.some((label) => label.includes('5030')));
    await page.locator('#journey-item-search').fill('纯钢剑');
    const labels = await page.locator('#journey-item option').allTextContents();
    for (const q of ['白', '绿', '蓝']) assert(labels.includes('纯钢剑 · ' + q + '色品质 · 剑'));
    assert.equal(await page.locator('#journey-item').inputValue(), '');
    await page.locator('#journey-item-stock').waitFor({ state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('#journey-item-stock').disabled);
    await page.locator('#journey-item-stock').check();
    assert.equal(await page.locator('#journey-item option[value="item-1000"]').count(), 0);
    assert.equal(await page.locator('#journey-item option[value="item-1002"]').count(), 1);
    await page.locator('#journey-item-stock').uncheck();
    await page.locator('#journey-item-quality').selectOption('蓝');
    await page.locator('#journey-item').selectOption({ label: '纯钢剑 · 蓝色品质 · 剑' });
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.match(await page.locator('#journey-item-options').innerText(), /蓝色品质/);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        .setSize(1000, 700),
    );
    const framing = await page.evaluate(() => {
      const save = document.querySelector('[data-action="journey-intent-save"]').getBoundingClientRect();
      const title = document.querySelector('.journey-intent-modal h2').getBoundingClientRect();
      const body = document.querySelector('.journey-intent-body');
      return {
        saveTop: save.top,
        saveBottom: save.bottom,
        titleTop: title.top,
        height: innerHeight,
        scrollable: body.scrollHeight > body.clientHeight,
      };
    });
    assert(
      framing.saveTop > 0 &&
        framing.saveBottom <= framing.height &&
        framing.titleTop >= 0 &&
        framing.scrollable,
    );
    checks.push('最小窗口里标题、关闭与保存始终可见，长表单在内部滚动');
    await page.screenshot({ path: path.join(data, 'gift-blue-selection.png') });
    await page.locator('[data-action="journey-intent-save"]').click();
    const blue = await waitGift('item-1002', 0);
    assert.equal(blue.gift.allocated, 1);
    assert.match(blue.title, /蓝色品质/);
    checks.push('用可见标签选择蓝色同名剑，保存后只分配真实蓝色库存，标题带文字品质');
    await editGift();
    await page.waitForFunction(() => !document.querySelector('#journey-item-stock').disabled);
    await page.locator('#journey-item-stock').check();
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.match(await page.locator('#journey-item-options').innerText(), /可用于这份赠礼 1 件/);
    await page.locator('#journey-item-preferred').check();
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.match(await page.locator('#journey-item-options').innerText(), /当前选择另外保留/);
    await page.locator('#journey-item-preferred').uncheck();
    await page.locator('#journey-item-stock').uncheck();
    checks.push('库存筛选扣除其他预算但保留当前赠礼分配；偏好筛选是明确选择且不抹掉原有礼物');
    await page.locator('#journey-note').fill('搜索不能抹掉件数、备注或当前选择');
    await page.locator('#journey-item-search').fill('完全没有这个物品');
    await page.locator('#journey-item-quality').selectOption('白');
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.match(await page.locator('#journey-item-options').innerText(), /当前选择另外保留/);
    assert.equal(await page.locator('#journey-note').inputValue(), '搜索不能抹掉件数、备注或当前选择');
    await page.locator('#journey-item-search').fill('');
    await page.locator('#journey-item-quality').selectOption('all');
    const firstPage = await page.locator('#journey-item-options').innerText();
    assert.match(firstPage, /1341 项匹配/);
    assert((await page.locator('#journey-item option').count()) <= 14);
    await page.locator('[data-action="journey-gift-page"][data-id="item:2"]').click();
    assert.match(await page.locator('#journey-item-options').innerText(), /第 2 /);
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    await page.locator('#journey-item-search').fill('纯钢剑');
    await page.locator('#journey-item-quality').selectOption('白');
    await page.locator('#journey-item').selectOption({ label: '纯钢剑 · 白色品质 · 剑' });
    await page.locator('[data-action="journey-intent-save"]').click();
    const white = await waitGift('item-1000', 1);
    assert.equal(white.gift.allocated, 0);
    assert.match(white.title, /白色品质/);
    checks.push('搜索、品质筛选和分页保留当前选择与备注；明确改选白色时缺口只对应白色');
    await app.close();
    app = null;
    await launch();
    const restored = await waitGift('item-1000', 1);
    assert.match(restored.title, /白色品质/);
    await editGift();
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1000');
    assert.match(await page.locator('#journey-item-options').innerText(), /白色品质/);
    await page.locator('#journey-done').check();
    await page.locator('[data-action="journey-intent-save"]').click();
    const boot = await page.evaluate(() => window.journal.bootstrap());
    assert.match(
      boot.data.state.profiles[0].journalEntries.find((entry) => entry.kind === 'gift-completed').title,
      /白色品质/,
    );
    checks.push('重启、编辑预览和完成操作的历史记录都保留精确的物品品质');
    await page.locator('.nav-btn[data-id="journey"]').click();
    await page.locator('[data-action="journey-todo-dialog"]').first().click();
    await page.locator('#journey-title').fill('地点搜索的合成待办');
    await page.locator('#journey-note').fill('先核对剧情场景，搜索不能清掉说明');
    assert((await page.locator('#journey-place option').count()) <= 14);
    await page.locator('#journey-place-search').fill('武当山');
    assert(
      (await page.locator('#journey-place option').allTextContents()).some((label) =>
        label.includes('武当派'),
      ),
    );
    await page.locator('#journey-place-search').fill('梧桐村 10');
    await page.locator('#journey-place').selectOption({ label: '梧桐村 · 资料场景 #10' });
    assert.equal(await page.locator('#journey-place').inputValue(), 'place-10');
    await page.locator('#journey-place-search').fill('没有这个地点');
    assert.equal(await page.locator('#journey-place').inputValue(), 'place-10');
    assert.match(await page.locator('#journey-place-options').innerText(), /0 项匹配/);
    assert.equal(await page.locator('#journey-note').inputValue(), '先核对剧情场景，搜索不能清掉说明');
    await page.screenshot({ path: path.join(data, 'place-search-preserves-scene.png') });
    await page.locator('[data-action="journey-intent-save"]').click();
    const todoCard = page.locator('.journey-action').filter({ hasText: '地点搜索的合成待办' });
    await todoCard.waitFor();
    await todoCard.locator('[data-action="journey-todo-dialog"]').click();
    assert.equal(await page.locator('#journey-place').inputValue(), 'place-10');
    await page.locator('#journey-place').selectOption('');
    await page.locator('[data-action="journey-intent-save"]').click();
    const afterPlace = await page.evaluate(() => window.journal.bootstrap());
    assert.equal(
      afterPlace.data.state.profiles[0].journey.todos.find((row) => row.title === '地点搜索的合成待办')
        .placeId,
      undefined,
    );
    checks.push('地点搜索支持武当山别名和同名场景编号；空结果不改变已选地点，明确改为地点未定才清除关联');
    await page.locator('.nav-btn[data-id="journal"]').click();
    await page.locator('[data-action="journal-entry-new"]').click();
    await page.locator('#journal-body').fill('还没有标题的换机草稿');
    await page.locator('[data-action="close-overlay"]').click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await page.evaluate(() => window.journal.bootstrap());
      if (value.data.state.profiles[0].journalDrafts?.some((draft) => draft.body === '还没有标题的换机草稿'))
        break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const good = path.join(data, 'good.yijian-protection'),
      bad = path.join(data, 'damaged.yijian-protection');
    await complete.exportComplete({
      archives: new ProtectionArchives(userData, () => source),
      dataRoot: userData,
      file: good,
    });
    const bytes = fs.readFileSync(good);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(bad, bytes);
    const beforeImport = fs.readFileSync(path.join(userData, 'journal.json'));
    await app.evaluate(
      ({ dialog }, { bad }) => {
        globalThis.giftImportPath = bad;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.giftImportPath] });
        dialog.showMessageBox = async () => ({ response: 1 });
      },
      { bad },
    );
    await page.locator('.nav-btn[data-id="settings"]').click();
    await page.locator('[data-action="protection-open"]').first().click();
    await page.locator('[data-action="protection-import"]').first().click();
    const error = page.locator('[aria-label="保护资料导入未完成"]');
    await error.waitFor();
    assert.match(await error.innerText(), /保护包校验失败/);
    assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), beforeImport);
    await page.screenshot({ path: path.join(data, 'recoverable-import-error.png') });
    await app.evaluate(
      (_electron, { good }) => {
        globalThis.giftImportPath = good;
      },
      { good },
    );
    await error.getByRole('button', { name: '重新选择并导入' }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[aria-label="保护资料导入未完成"]') &&
        document.body.textContent.includes('全部字节已校验'),
    );
    assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), beforeImport);
    await page
      .locator('details.detail-block')
      .filter({ has: page.locator('[data-action="protection-journal-profile"]') })
      .first()
      .locator(':scope > summary')
      .click();
    await page.locator('[data-action="protection-journal-profile"]').first().click();
    await page.locator('[aria-label="未完成的记录草稿"]').waitFor();
    assert.match(await page.locator('[aria-label="未完成的记录草稿"]').innerText(), /还没有标题的换机草稿/);
    assert.equal(await page.locator('[data-action="journal-draft-resume"]').count(), 0);
    checks.push('坏包留下中文持续提示与重试入口，换回好包导入成功；历史未完成草稿只读可见，本机手札不变');
    assert.deepEqual(fs.readFileSync(saveFile), originalSave);
    assert.deepEqual(errors, []);
  } catch (error) {
    errors.push(error.stack);
    process.exitCode = 1;
    console.error(error);
  } finally {
    if (app) await app.close().catch(() => {});
    const result = { status: errors.length ? 'FAIL' : 'PASS', checks, errors, data };
    fs.writeFileSync(path.join(data, 'report.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results/gift-identity-ui-result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  }
})();
