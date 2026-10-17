'use strict';
const { openMainPage } = require('./ui-smoke-actions.cjs');
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
  syntheticSave({
    full: true,
    seconds: 9000,
    quests: [],
    inventory: [{ id: 1002, count: 1 }],
    npcs: [{ id: 0 }, { id: 5011, friendliness: [[0, 90]], inventory: [{ id: 1002, count: 1 }] }],
  }),
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
  await openMainPage(page, 'journey');
  if (!(await page.locator('[data-action="journey-gift-edit"]').count()))
    await page.locator('[data-action="journey-show-completed"]').click();
  await page.locator('[data-action="journey-gift-edit"]').first().click();
}
async function expand(selector) {
  const details = page.locator(selector);
  if (!(await details.evaluate((node) => node.open))) await details.locator(':scope > summary').click();
}
(async () => {
  try {
    await launch();
    await page.locator('[data-action="search"]').click();
    await page.locator('#global-search').fill('道通');
    await page.locator('#global-results [data-action="database-detail"][data-id="npc-5011"]').click();
    await page.locator('.drawer-actions [data-action="journey-gift-dialog"]').click();
    await expand('#journey-person-picker');
    await page.locator('#journey-person-search').fill('道通');
    const people = await page.locator('#journey-person option').allTextContents();
    assert(
      people.some((label) => label.includes('初始等级 70')) &&
        people.some((label) => label.includes('同名 2/2')),
    );
    assert.equal(await page.locator('#journey-person option[value="npc-5011"]').count(), 1);
    assert.equal(await page.locator('#journey-person option[value="npc-5030"]').count(), 1);
    await page.locator('#journey-item-search').fill('纯钢剑');
    const labels = await page.locator('#journey-item option').allTextContents();
    for (const q of ['白', '绿', '蓝']) assert(labels.includes('纯钢剑 · ' + q + '色品质 · 剑'));
    assert.equal(await page.locator('#journey-item').inputValue(), '');
    await page.locator('#journey-item-stock').waitFor({ state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('#journey-item-stock').disabled);
    await expand('.gift-choice-filters');
    await page.locator('#journey-item-stock').check();
    assert.equal(await page.locator('#journey-item option[value="item-1000"]').count(), 0);
    assert.equal(await page.locator('#journey-item option[value="item-1002"]').count(), 1);
    await page.locator('#journey-item-stock').uncheck();
    await page.locator('#journey-item-quality').selectOption('蓝');
    await page.locator('[data-action="journey-gift-select"][data-id="item:item-1002"]').click();
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.match(await page.locator('#journey-item-selection').innerText(), /蓝色品质/);
    assert.equal(await page.locator('#journey-item-picker').evaluate((node) => node.open), false);
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
    await expand('.gift-more-details');
    await page.locator('#journey-place-search').fill('野猪林');
    await page.locator('#journey-place').selectOption('place-22');
    await page.screenshot({ path: path.join(data, 'gift-blue-selection.png') });
    await page.locator('[data-action="journey-intent-save"]').click();
    const blue = await waitGift('item-1002', 0);
    assert.equal(blue.gift.allocated, 1);
    assert.match(blue.title, /蓝色品质/);
    checks.push('用可见标签选择蓝色同名剑，保存后只分配真实蓝色库存，标题带文字品质');
    const opened = app.waitForEvent('window');
    await page.locator('[data-action="compact"]').first().click();
    const companion = await opened;
    companion.on('pageerror', (error) => errors.push(error.message));
    await companion.locator('.compact-shell').waitFor();
    await companion.locator('[data-compact-detail="flow-personal"] > summary').click();
    const giftSummary = companion.locator('.compact-goal').filter({ hasText: '赠送：' }).first();
    for (const id of ['npc-5011', 'item-1002', 'place-22']) {
      const link = giftSummary.locator(`[data-entity-id="${id}"]`).first();
      await link.waitFor();
      assert.equal(await link.locator('.game-picture').count(), 1);
      assert.equal(await link.locator('.entity-link-label').count(), 1);
    }
    const swordLink = giftSummary.locator('[data-entity-id="item-1002"]');
    await swordLink.hover();
    await companion.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.match(await companion.locator('#entity-preview').innerText(), /纯钢剑/);
    await swordLink.click();
    await companion.locator('.drawer h1').filter({ hasText: '纯钢剑' }).waitFor();
    await companion.locator('[data-action="close-overlay"]').first().click();
    await giftSummary.locator('[data-entity-id="place-22"]').hover();
    await companion.locator('#entity-preview .place-map').waitFor({ state: 'visible' });
    await giftSummary.locator('[data-entity-id="place-22"]').click();
    await companion.locator('.world-drawer .place-map').waitFor();
    await companion.screenshot({ path: path.join(data, 'gift-summary-location-map.png') });
    await companion.locator('[data-action="close-overlay"]').first().click();
    await giftSummary.locator('[data-action="journey-open"]').click();
    await companion.locator('[data-gift-completion] [data-action="journey-gift-complete"]').click();
    assert.equal(await companion.locator('#journey-done').isChecked(), true);
    const native = await app.browserWindow(companion);
    await native.evaluate((win) => {
      win.webContents.setZoomFactor(1.5);
      win.setSize(360, 360);
      win.show();
      win.focus();
    });
    const narrow = await companion.locator('.journey-intent-modal').evaluate((node) => {
      const save = node.querySelector('[data-action="journey-intent-save"]').getBoundingClientRect();
      const body = node.querySelector('.journey-intent-body');
      return {
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        saveBottom: save.bottom,
        height: innerHeight,
        bodyHeight: body.clientHeight,
      };
    });
    assert(
      narrow.scrollWidth <= narrow.width + 2 && narrow.saveBottom <= narrow.height && narrow.bodyHeight >= 48,
    );
    fs.writeFileSync(
      path.join(data, 'gift-minimum-150.png'),
      Buffer.from(
        await native.evaluate(async (win) =>
          (await win.webContents.capturePage()).toPNG().toString('base64'),
        ),
        'base64',
      ),
    );
    await native.evaluate((win) => {
      win.webContents.setZoomFactor(1);
      win.setSize(460, 660);
    });
    await native.dispose();
    await companion.locator('.modal-footer [data-action="close-overlay"]').click();
    await companion.waitForFunction(async () => {
      const boot = await window.journal.bootstrap();
      const profile = boot.data.state.profiles.find((row) => row.id === boot.data.state.activeProfileId);
      return profile.intentDrafts.some(
        (row) => row.kind === 'journey-gift' && row.targetId && row.values.done,
      );
    });
    const pending = await companion.evaluate(() => window.journal.bootstrap());
    const pendingProfile = pending.data.state.profiles.find(
      (row) => row.id === pending.data.state.activeProfileId,
    );
    const completionDraft = pendingProfile.intentDrafts.find(
      (row) => row.kind === 'journey-gift' && row.values.done,
    );
    assert.equal(pendingProfile.journey.gifts[0].done, false);
    assert.equal((await planGift()).gift.allocated, 1, 'Closing completion keeps the allocation');
    if (
      !(await companion
        .locator(`[data-action="intent-draft-resume"][data-id="${completionDraft.id}"]`)
        .count())
    )
      await companion.locator('[data-action="intent-drafts"]').first().click();
    await companion.locator(`[data-action="intent-draft-resume"][data-id="${completionDraft.id}"]`).click();
    assert.equal(await companion.locator('#journey-done').isChecked(), true);
    await companion.locator('#journey-done').uncheck();
    await companion.locator('#intent-draft-status').filter({ hasText: '已暂存，可稍后继续' }).waitFor();
    const unchecked = await companion.evaluate(() => window.journal.bootstrap());
    assert.equal(
      unchecked.data.state.profiles[0].intentDrafts.find((row) => row.id === completionDraft.id).values.done,
      false,
    );
    await companion.locator('#journey-quantity').fill('2');
    await companion.locator('#journey-item-selection [data-action="database-detail"]').click();
    await companion.locator('.drawer h1').filter({ hasText: '纯钢剑' }).waitFor();
    await companion.locator('[data-action="drawer-back"]').click();
    assert.equal(await companion.locator('#journey-item').inputValue(), 'item-1002');
    assert.equal(await companion.locator('#journey-quantity').inputValue(), '2');
    await companion.locator('#journey-quantity').fill('1');
    await companion.locator('.modal-footer [data-action="journey-intent-save"]').click();
    await companion.waitForFunction(() => document.activeElement?.hasAttribute('data-journey-id'));
    assert.match(await companion.locator('[data-journey-id]:focus').innerText(), /蓝色品质/);
    assert.equal((await planGift()).gift.allocated, 1);
    checks.push('随行取消赠送完成不释放库存，草稿可继续；往返图鉴保留数量与精确物品，保存后定位原安排');
    await companion.locator('.companion-tabs [data-id="duels"]').click();
    await companion.locator('#npc-progress-search').fill('道通');
    const npc = companion.locator('[data-npc-progress-card="5011"]');
    await npc.locator(':scope > summary').click();
    await npc.locator('[data-action="journey-gift-dialog"]').click();
    assert.equal(await companion.locator('#journey-person').inputValue(), 'npc-5011');
    assert.equal(await companion.locator('#journey-item-picker').evaluate((node) => node.open), true);
    await companion.locator('.modal-footer [data-action="close-overlay"]').click();
    checks.push('随行比武人物卡直接准备该人物的赠礼，默认只展开尚未选择的物品');
    await companion.locator('[data-action="companion-tuck"]').click();
    await page.bringToFront();
    checks.push('随行赠礼摘要使用精确人物、品质物品与地点入口，悬停及详情地图可直接查看');

    await app.evaluate(({ ipcMain }) => {
      const channel = 'journal:save-details',
        original = ipcMain._invokeHandlers.get(channel);
      globalThis.deferGiftRead = true;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const defer = globalThis.deferGiftRead;
        globalThis.deferGiftRead = false;
        const result = await original(...args);
        if (defer)
          await new Promise((resolve) => {
            globalThis.releaseGiftRead = resolve;
          });
        return result;
      });
    });
    await editGift();
    await app.evaluate(async () => {
      const deadline = Date.now() + 10000;
      while (!globalThis.releaseGiftRead && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!globalThis.releaseGiftRead) throw Error('Delayed synthetic read was not reached');
    });
    await page.locator('#journey-item-selection [data-action="database-detail"]').click();
    await page.locator('.drawer h1').filter({ hasText: '纯钢剑' }).waitFor();
    await app.evaluate(() => globalThis.releaseGiftRead());
    await page.evaluate(() => window.journal.bootstrap());
    await page.locator('[data-action="drawer-back"]').click();
    await page.waitForFunction(() => !document.querySelector('#journey-item-stock').disabled);
    assert.match(await page.locator('#journey-item-selection').innerText(), /这份可用 1/);
    checks.push('读取尚未完成时进入图鉴，返回后续读库存与限制，不会永久卡在未知状态');
    await expand('#journey-item-picker');
    await expand('.gift-choice-filters');
    await page.waitForFunction(() => !document.querySelector('#journey-item-stock').disabled);
    await page.locator('#journey-item-stock').check();
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.match(await page.locator('#journey-item-selection').innerText(), /这份可用 1/);
    await page.locator('#journey-item-preferred').check();
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.equal(await page.locator('#journey-item-selection [data-entity-id="item-1002"]').count(), 1);
    await page.locator('#journey-item-preferred').uncheck();
    await page.locator('#journey-item-stock').uncheck();
    checks.push('库存筛选扣除其他预算但保留当前赠礼分配；偏好筛选是明确选择且不抹掉原有礼物');
    await page.locator('#journey-note').fill('搜索不能抹掉件数、备注或当前选择');
    await page.locator('#journey-item-search').fill('完全没有这个物品');
    await page.locator('#journey-item-quality').selectOption('白');
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    assert.equal(await page.locator('#journey-item-selection [data-entity-id="item-1002"]').count(), 1);
    assert.equal(await page.locator('#journey-note').inputValue(), '搜索不能抹掉件数、备注或当前选择');
    await page.locator('#journey-item-search').fill('');
    await page.locator('#journey-item-quality').selectOption('all');
    const firstPage = await page.locator('#journey-item-options').innerText();
    assert.match(firstPage, /1341 项 · 1\//);
    assert((await page.locator('#journey-item option').count()) <= 14);
    await page.locator('[data-action="journey-gift-page"][data-id="item:2"]').click();
    assert.match(await page.locator('#journey-item-options').innerText(), /1341 项 · 2\//);
    assert.equal(await page.locator('#journey-item').inputValue(), 'item-1002');
    await page.locator('#journey-item-search').fill('纯钢剑');
    await page.locator('#journey-item-quality').selectOption('白');
    await page.locator('[data-action="journey-gift-select"][data-id="item:item-1000"]').click();
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
    assert.match(await page.locator('#journey-item-selection').innerText(), /白色品质/);
    await page.locator('#journey-done').check();
    await page.locator('[data-action="journey-intent-save"]').click();
    const boot = await page.evaluate(() => window.journal.bootstrap());
    assert.match(
      boot.data.state.profiles[0].journalEntries.find((entry) => entry.kind === 'gift-completed').title,
      /白色品质/,
    );
    checks.push('重启、编辑预览和完成操作的历史记录都保留精确的物品品质');
    await editGift();
    await page.locator('#journey-done').uncheck();
    await expand('#journey-item-picker');
    await page.locator('#journey-item-search').fill('纯钢剑');
    await page.locator('[data-action="journey-gift-select"][data-id="item:item-1002"]').click();
    await page.locator('[data-action="journey-intent-save"]').click();
    assert.equal((await waitGift('item-1002', 0)).gift.allocated, 1);
    await page.locator('[data-gift-completion] [data-action="journey-gift-complete"]').first().click();
    assert.equal(await page.locator('#journey-done').isChecked(), true);
    await page.locator('[data-action="journey-intent-save"]').click();
    await page.waitForFunction(async () => {
      const boot = await window.journal.bootstrap();
      return boot.data.state.profiles[0].journey.gifts[0].done;
    });
    const released = await page.evaluate(() => window.journal.saveDetails('0.sav'));
    assert.equal(released.data.planning.physicalUsed['1002'] || 0, 0);
    checks.push('明确保存赠送完成后才释放该礼物的库存分配');
    await openMainPage(page, 'journey');
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
    await page.locator('#journey-place').selectOption({ label: '梧桐村 · 场景 2' });
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
    await openMainPage(page, 'journal');
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
    await openMainPage(page, 'settings');
    if (await page.locator('[data-protection-controls]:not([open])').count())
      await page.locator('[data-protection-controls] > summary').click();
    await page.locator('[data-action="protection-open"]').first().click();
    if (await page.locator('[data-protection-controls]:not([open])').count())
      await page.locator('[data-protection-controls] > summary').click();
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
    if (app) {
      const windows = [];
      for (const window of app.windows())
        windows.push(
          await window
            .evaluate(() => ({
              url: location.href,
              overlay: document.querySelector('#overlay')?.innerText,
              focus: { tag: document.activeElement?.tagName, ...document.activeElement?.dataset },
              fields: [...document.querySelectorAll('#overlay input,#overlay select,#overlay textarea')].map(
                (n) => ({ id: n.id, value: n.value, checked: n.checked, valid: n.validity.valid }),
              ),
            }))
            .catch(() => ({ closed: true })),
        );
      fs.writeFileSync(path.join(data, 'failure-ui.json'), JSON.stringify(windows, null, 2));
    }
  } finally {
    if (app && errors.length) await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
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
