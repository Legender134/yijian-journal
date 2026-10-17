'use strict';
const { openMainPage } = require('./ui-smoke-actions.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const data = path.join(base, '.test-data', 'resource-priority-ui-' + Date.now());
const userData = path.join(data, 'userdata'),
  saves = path.join(data, 'synthetic-SaveGames');
fs.mkdirSync(saves, { recursive: true });
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
const save = path.join(saves, '0.sav');
let controlledSave;
function writeSynthetic(seconds) {
  controlledSave = syntheticSave({
    full: true,
    seconds,
    quests: [],
    fusionRecipes: [1000],
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
      { id: 1002, count: 1 },
    ],
  });
  fs.writeFileSync(save, controlledSave);
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(save, old, old);
}
writeSynthetic(10000);
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
store.mutate({ type: 'save-slot', value: '0.sav', mode: 'slot' });
const state = store.get(),
  profile = state.profiles[0],
  stamp = new Date().toISOString();
profile.craftList = [{ id: 'fusion-1000', quantity: 1 }];
profile.activeCraftPlanId = 'a';
profile.craftPlans = ['a', 'b'].map((id) => ({
  id,
  name: id === 'a' ? '先做的剑' : '稍后做的剑',
  list: [{ id: 'fusion-1000', quantity: 1 }],
  reserved: true,
  createdAt: stamp,
  updatedAt: stamp,
}));
store.commit(state);
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.layout').waitFor();
}
async function current() {
  const response = await page.evaluate(() => window.journal.bootstrap());
  assert(response.ok, response.error);
  return response.data.state.profiles.find((p) => p.id === response.data.state.activeProfileId);
}
async function overview() {
  const response = await page.evaluate(() => window.journal.refresh());
  assert(response.ok, response.error);
  return response.data;
}
async function openDialog() {
  await page.locator('[data-action="resource-priority-open"]').click();
  await page.locator('[data-action="resource-priority-save"]').waitFor();
}
async function inspectPreviewMaterial(savedOrder) {
  const material = page
    .locator('.resource-priority-editor [data-action="database-detail"][data-id="item-10205"]')
    .first();
  assert.equal(await material.locator('.game-picture').count(), 1);
  assert(
    await material.evaluate((element) =>
      getComputedStyle(element.querySelector('.entity-link-label')).textDecorationLine.includes('underline'),
    ),
  );
  await material.focus();
  await material.hover();
  await page.locator('#entity-preview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#entity-preview').innerText(), /煤炭/);
  assert.match(await page.locator('#entity-preview').innerText(), /保存持有 1/);
  await material.click();
  await page.locator('.game-detail-title h1').filter({ hasText: '煤炭' }).waitFor();
  await page.locator('[data-action="drawer-back"]').click();
  await page.locator('[data-action="resource-priority-save"]').waitFor();
  assert.deepEqual(
    await page
      .locator('.resource-priority-order [data-direction="up"]')
      .evaluateAll((buttons) => buttons.map((button) => button.dataset.id)),
    ['b', 'a'],
  );
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), 'item-10205');
  assert.deepEqual((await current()).resourcePriority, savedOrder);
}
async function quit() {
  await Promise.all([page.waitForEvent('close'), page.evaluate(() => window.journal.window('quit'))]);
  await app.close().catch(() => {});
  app = null;
}
const grant = (data, id) =>
  data.allocations.crafts
    .find((c) => c.id === id)
    .materials.reduce((sum, m) => sum + m.allocation.reduce((n, i) => n + i.count, 0), 0);
(async () => {
  try {
    await launch();
    await openMainPage(page, 'materials');
    await openDialog();
    await page.locator('[data-action="resource-priority-move"][data-id="b"][data-direction="up"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-order .spacer')?.textContent.includes('稍后做的剑'),
    );
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    const impact = await page.locator('[aria-label="确认前的材料分配变化"]').innerText();
    assert.match(impact, /铁锭/);
    assert.match(impact, /3 → 0/);
    assert.match(impact, /0 → 3/);
    await inspectPreviewMaterial(undefined);
    checks.push('材料图标、下划线与悬浮持有量共用实体链接，查看详情后返回仍保留未确认的b、a顺序');
    await page
      .locator('.resource-priority-modal')
      .evaluate(async (el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: path.join(data, 'preview-transfer.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await current()).resourcePriority, undefined);
    checks.push('真实冲突预览逐项显示转移数量，取消不改变顺序');
    await openDialog();
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.deepEqual((await current()).resourcePriority, ['a', 'b']);
    await page.locator('[data-action="craft-plan-open"][data-id="b"]').click();
    assert.equal(grant(await overview(), 'a'), 5);
    assert.equal(grant(await overview(), 'b'), 0);
    checks.push('确认顺序后打开另一份编辑计划仍保持原优先分配');
    await openDialog();
    await page.locator('[data-action="resource-priority-move"][data-id="b"][data-direction="up"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-order .spacer')?.textContent.includes('稍后做的剑'),
    );
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await inspectPreviewMaterial(['a', 'b']);
    writeSynthetic(12000);
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-editor')?.textContent.includes('存档或计划已变化'),
    );
    assert.deepEqual((await current()).resourcePriority, ['a', 'b']);
    await page.locator('[data-action="resource-priority-refresh"]').click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.deepEqual((await current()).resourcePriority, ['b', 'a']);
    assert.equal(grant(await overview(), 'b'), 5);
    checks.push('合成存档hash变化拒绝旧确认，重新核对后可提交本次顺序');
    await quit();
    await launch();
    assert.deepEqual((await current()).resourcePriority, ['b', 'a']);
    assert.equal(grant(await overview(), 'b'), 5);
    checks.push('真实退出重启保留所属周目的明确资源顺序');
    await openMainPage(page, 'materials');
    await openDialog();
    await page.locator('[data-action="resource-priority-reset"]').click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.deepEqual((await current()).resourcePriority, []);
    checks.push('恢复默认顺序先预览再确认');
    const secondGiftNote = '下次探望时赠送 · 乙意图 ' + 'x'.repeat(160);
    for (const [id, note] of [
      ['gift-a', '今天告别时赠送 · 甲意图 <原样>'],
      ['gift-b', secondGiftNote],
    ]) {
      const gift = await page.evaluate((command) => window.journal.mutate(command), {
        type: 'journey-gift-put',
        id,
        npcId: 'npc-5011',
        itemId: 'item-1002',
        quantity: 1,
        note,
        done: false,
      });
      assert(gift.ok, gift.error);
    }
    await openMainPage(page, 'home');
    await openMainPage(page, 'materials');
    await openDialog();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        .setSize(1000, 700),
    );
    const firstMove = page.locator(
        '[data-action="resource-priority-move"][data-id="@gift:gift-a"][data-direction="up"]',
      ),
      secondMove = page.locator(
        '[data-action="resource-priority-move"][data-id="@gift:gift-b"][data-direction="up"]',
      );
    assert.match(
      await firstMove.getAttribute('aria-label'),
      /第1份赠礼 · 1件 · 今天告别时赠送 · 甲意图 <原样>/,
    );
    assert.match(await secondMove.getAttribute('aria-label'), /第2份赠礼 · 1件 · 下次探望时赠送 · 乙意图/);
    assert((await secondMove.getAttribute('aria-label')).endsWith(secondGiftNote));
    await secondMove.scrollIntoViewIfNeeded();
    const buttonsInWindow = await page
      .locator('.resource-priority-order [data-id="@gift:gift-b"]')
      .evaluateAll((buttons) =>
        buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        }),
      );
    assert(
      buttonsInWindow,
      'Long original notes must wrap without pushing the move controls outside the window',
    );
    await secondMove.click();
    await page.waitForFunction(() =>
      document
        .querySelector('.resource-priority-order [data-id="@gift:gift-b"]')
        ?.closest('.backup-row')
        .nextElementSibling?.textContent.includes('今天告别时赠送 · 甲意图'),
    );
    const previewGift = page
      .locator('.resource-priority-changes .detail-block')
      .filter({ hasText: '下次探望时赠送 · 乙意图' });
    assert.match(await previewGift.innerText(), /直接分配 0 → 1/);
    assert.match(await page.locator('.resource-priority-order').innerText(), /甲意图 <原样>/);
    await page
      .locator('.resource-priority-modal')
      .evaluate(async (element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
    await page.locator('.resource-priority-order').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await previewGift.scrollIntoViewIfNeeded();
    assert(
      await page
        .locator('.resource-priority-changes')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      'Complete long gift context must wrap within the allocation preview',
    );
    await page.screenshot({ path: path.join(data, 'distinct-gift-priority.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual((await current()).resourcePriority, []);
    checks.push('同人物同物品的两份赠礼显示数量和原始备注，移动按钮名称明确，取消仍保留原顺序');
    await openDialog();
    await page
      .locator('[data-action="resource-priority-move"][data-id="@gift:gift-b"][data-direction="up"]')
      .click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    const expectedOrder = ['b', 'a', '@gift:gift-b', '@gift:gift-a'];
    assert.deepEqual((await current()).resourcePriority, expectedOrder);
    assert.equal((await overview()).allocations.gifts.find((g) => g.id === 'gift-b').allocated, 1);
    assert.equal((await overview()).allocations.gifts.find((g) => g.id === 'gift-a').allocated, 0);
    checks.push('确认选中的赠礼意图后唯一现有物品分配给该意图，不重复占用');
    await quit();
    await launch();
    assert.deepEqual((await current()).resourcePriority, expectedOrder);
    assert.equal(
      (await current()).journey.gifts.find((g) => g.id === 'gift-a').note,
      '今天告别时赠送 · 甲意图 <原样>',
    );
    assert.equal((await overview()).allocations.gifts.find((g) => g.id === 'gift-b').allocated, 1);
    checks.push('冷启动保留两份赠礼原始备注、明确顺序和对应有限库存分配');
    const response = await page.evaluate(() =>
      window.journal.mutate({ type: 'save-slot', value: '', mode: 'none' }),
    );
    assert(response.ok, response.error);
    // A fresh main-process projection must retain unknowns in every preview.
    const p = await current();
    const unknown = await page.evaluate(
      (profile) => window.journal.resourcePriorityPreview(profile.id, profile.resourcePriority),
      p,
    );
    assert(unknown.ok, unknown.error);
    assert.equal(unknown.data.inventoryAvailable, false);
    assert.equal(unknown.data.afterMissingTotal, null);
    checks.push('无参照时返回明确未知而非零库存');
    assert.deepEqual(fs.readFileSync(save), controlledSave);
    assert.deepEqual(errors, []);
    await quit();
    console.log('PASS ' + checks.join('\nPASS '));
  } catch (e) {
    errors.push(e.stack || e.message);
    if (page) await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {});
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    const report = {
      status: errors.length ? 'FAIL' : 'PASS',
      checks,
      errors,
      data,
      executionMode: process.env.YIJIAN_EXECUTABLE ? 'packaged' : 'source',
      executable: process.env.YIJIAN_EXECUTABLE || null,
    };
    fs.writeFileSync(path.join(data, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results', 'resource-priority-ui-result.json'),
      JSON.stringify(report, null, 2),
    );
  }
})();
