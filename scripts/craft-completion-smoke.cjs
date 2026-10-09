'use strict';
// Complete/reopen a real assistant plan; all save files and state are synthetic.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const game = require('../src/data/game-index.json');
const base = path.resolve(__dirname, '..');
const expectedExecutable = path.join(
  base,
  'dist',
  'v' + require('../package.json').version,
  '逸剑手札-win32-x64',
  '逸剑手札.exe',
);
const override = process.env.YIJIAN_EXECUTABLE;
if (override && path.resolve(override).toLowerCase() !== expectedExecutable.toLowerCase())
  throw Error('只接受本候选打包的逸剑手札.exe作为UI测试目标');
const data = path.join(base, '.test-data', 'craft-completion-ui-' + Date.now());
const userData = path.join(data, 'userdata'),
  saves = path.join(data, 'synthetic-SaveGames');
const results = path.join(base, 'test-results');
fs.mkdirSync(saves, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const file = path.join(saves, '0.sav');
const bytes = syntheticSave({
  full: true,
  seconds: 9000,
  quests: [],
  inventory: [
    { id: 10201, count: 8 },
    { id: 10205, count: 20 },
  ],
  fusionRecipes: [9500],
  money: 1000000,
});
fs.writeFileSync(file, bytes);
const settled = new Date(Date.now() - 5000);
fs.utimesSync(file, settled, settled);
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '0.sav', mode: 'slot' });
store.mutate({ type: 'task-reserve', questId: 'quest-11010', itemId: '10201' });
store.mutate({ type: 'task-reserve-edit', questId: 'quest-11010', itemId: '10201', count: 4 });
store.mutate({
  type: 'craft-plan-save',
  name: '计划 A · 保留三份铁锭',
  list: [{ id: 'fusion-9500', quantity: 3 }],
  reserved: true,
});
const a = store.get().profiles[0].craftPlans[0].id;
store.mutate({
  type: 'craft-plan-save',
  name: '计划 B · <img>两份铁锭',
  list: [{ id: 'fusion-9500', quantity: 2 }],
  reserved: true,
  addGoal: true,
});
const b = store.get().profiles[0].craftPlans[0].id;
store.mutate({ type: 'craft-plan-open', id: b });
store.mutate({
  type: 'journey-gift-put',
  id: 'synthetic-gift',
  npcId: 'npc-5014',
  itemId: 'item-10201',
  quantity: 3,
  note: '合成共享用料',
  done: false,
});
let app, page, companion;
const checks = [],
  errors = [],
  visibility = [];
async function api(name, ...args) {
  const response = await page.evaluate(({ name, args }) => window.journal[name](...args), { name, args });
  assert.equal(response.ok, true, response.error);
  return response.data;
}
const current = async () => {
  const response = await api('bootstrap');
  return response.state.profiles.find((p) => p.id === response.state.activeProfileId);
};
const readPlan = async () => (await current()).craftPlans.find((p) => p.id === b);
const nav = (id) => page.locator(`.nav-btn[data-id="${id}"]`).click();
async function until(fn, predicate, message) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error(message);
}
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'YIJIAN_EXECUTABLE', 'YIJIAN_TEST_HIDDEN', 'YIJIAN_TEST_TRAY'])
    delete env[key];
  for (const key of Object.keys(env)) if (/^YIJIAN_GAME.*(?:PATH|EXECUTABLE|EXE)$/.test(key)) delete env[key];
  app = await _electron.launch({
    executablePath: override ? expectedExecutable : require('electron'),
    args: override ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.layout').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
}
async function compact() {
  const made = app.waitForEvent('window');
  await page.locator('.topbar [data-action="compact"]').click();
  companion = await made;
  companion.on('pageerror', (e) => errors.push(e.message));
  await companion.locator('[data-companion-itinerary]').waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('compact'))
      .setContentSize(460, 660),
  );
}
async function controlsVisible(target) {
  const viewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const bounds = [];
  for (const selector of [
    '.modal-footer [data-action="close-overlay"]',
    '[data-action="craft-plan-complete-confirm"]',
  ]) {
    const box = await target.locator(selector).boundingBox();
    assert(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
      'completion and cancel must remain visible',
    );
    bounds.push(box);
  }
  visibility.push({ viewport, bounds });
}
async function completedTracking(label) {
  await companion.locator('[data-action="navigate"][data-id="home"]').first().click();
  const card = companion.locator('.companion-materials');
  await card.waitFor();
  await companion.waitForFunction(() =>
    document.querySelector('.companion-materials')?.textContent.includes('个人已制作完成'),
  );
  const text = await card.innerText();
  assert.match(text, /计划 B · <img>两份铁锭/);
  assert.match(text, /用料已释放/);
  assert.match(text, /下方仅供若重新制作时核对/);
  assert.match(text, /若重新制作：原料端点/);
  for (const row of await card.locator('.companion-material > span:last-child').allTextContents())
    assert.match(row, /^若重做：/);
  assert.equal(await card.locator('h3 img').count(), 0, 'plan title must remain escaped');
  await card.screenshot({ path: path.join(results, 'craft-completion-redo-' + label + '.png') });
}
async function completeMain() {
  await nav('materials');
  await page.locator(`[data-craft-plan-id="${b}"] [data-action="craft-plan-complete"]`).click();
  await controlsVisible(page);
  await page.locator('[data-action="craft-plan-complete-confirm"]').click();
  await until(readPlan, (p) => p.done === true, 'main completion was not saved');
}
(async () => {
  try {
    await launch();
    await nav('journey');
    const journey = await api('journeyPlan');
    const action = journey.actions.find((x) => x.kind === 'craft' && x.ownerId === b);
    assert(action);
    await page.locator(`[data-journey-id="${action.id}"] [data-action="journey-itinerary-add"]`).click();
    await page.locator('[data-itinerary] [data-action="journey-itinerary-status"][data-id="active"]').click();
    const original = await current(),
      before = await api('refresh');
    const selected = original.journey.itinerary;
    assert(before.allocations.crafts.some((p) => p.id === a));
    assert(before.allocations.crafts.some((p) => p.id === b));
    await compact();
    const button = companion.locator('[data-itinerary-next] [data-action="craft-plan-complete"]');
    const nextBounds = await button.boundingBox();
    assert(
      nextBounds && nextBounds.y >= 0 && nextBounds.y + nextBounds.height <= 660,
      'whole-plan completion must be usable in the first compact viewport',
    );
    await button.click();
    await controlsVisible(companion);
    assert.equal(await companion.locator('.modal img').count(), 0, 'user plan name must be escaped');
    await companion.locator('.modal-footer [data-action="close-overlay"]').click();
    assert.deepEqual(
      await readPlan(),
      original.craftPlans.find((p) => p.id === b),
    );
    checks.push('小窗明确整份计划范围，确认和取消在首屏可用；取消不修改计划，名称安全显示');

    await companion.locator('[data-itinerary-next] [data-action="craft-plan-complete"]').click();
    await companion.locator('[data-action="craft-plan-complete-confirm"]').click();
    const after = await until(
      current,
      (p) => p.craftPlans.find((x) => x.id === b).done,
      'compact completion was not saved',
    );
    const overview = await api('refresh');
    assert(!overview.allocations.crafts.some((p) => p.id === b));
    assert(overview.allocations.crafts.some((p) => p.id === a));
    assert.equal(overview.allocations.totals[10201], before.allocations.totals[10201]);
    assert.equal(before.allocations.gifts.find((g) => g.id === 'synthetic-gift').allocated, 0);
    assert.equal(overview.allocations.gifts.find((g) => g.id === 'synthetic-gift').allocated, 1);
    assert.equal(overview.allocations.totals[10205], before.allocations.totals[10205] - 2);
    assert.deepEqual(after.allocations, original.allocations);
    assert.deepEqual(after.journey.gifts, original.journey.gifts);
    assert.deepEqual(after.goals, original.goals);
    assert.equal(after.journalEntries.at(-1).kind, 'craft-plan-completed');
    const closed = await api('journeyPlan');
    assert.equal(closed.itinerary.steps[0].status, 'user-done');
    assert.equal(closed.itinerary.next, null);
    await page.waitForFunction(() =>
      document.querySelector('[data-itinerary-step]')?.textContent.includes('个人已完成'),
    );
    await companion.waitForFunction(() =>
      document.querySelector('[data-companion-itinerary]')?.textContent.includes('本次已无待处理项'),
    );
    await companion.screenshot({ path: path.join(results, 'craft-completion-compact.png') });
    await completedTracking('completed');
    checks.push('随行追踪显示具体已完成计划，用料与制作次数明确限定为若重新制作');
    checks.push('小窗完成会推进原选行程，只释放 B 的铁矿与煤，保留 A、任务和赠礼用量，记录个人完成');

    await nav('materials');
    assert.match(await page.locator(`[data-craft-plan-id="${b}"]`).innerText(), /个人已制作完成.*用料已释放/);
    await page.locator('[data-action="recipe-discovery-open"]').first().click();
    await page.locator('[data-action="recipe-discovery-view"][data-id="all"]').click();
    await page.locator('#recipe-discovery-target-plan').selectOption(b);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-action="recipe-discovery-add"]')].some(
        (x) => x.disabled && x.textContent.includes('已完成'),
      ),
    );
    assert.equal(await page.locator('[data-action="recipe-discovery-add"]:enabled').count(), 0);
    checks.push('已完成计划保留可读配方；反查不能静默向已完成计划追加配方');

    await app.close();
    app = null;
    await launch();
    await nav('journey');
    await compact();
    assert.deepEqual((await current()).journey.itinerary, selected);
    assert.equal((await readPlan()).done, true);
    await completedTracking('restart');
    const undo = companion.locator('summary').filter({ hasText: '撤回个人处理、完成计划或本次跳过' });
    await undo.click();
    await companion.locator(`[data-action="craft-plan-complete"][data-id="${b}"]`).click();
    await until(readPlan, (p) => p.done === false, 'cold-restart reopening was not saved');
    const reopened = await api('refresh');
    assert.deepEqual(reopened.allocations.totals, before.allocations.totals);
    assert.deepEqual((await current()).journey.itinerary, selected);
    await companion.locator(`[data-itinerary-next="${action.id}"]`).waitFor();
    checks.push('冷重启保留完成、原选顺序和配方；从小窗重新打开会恢复原需求并接续同一行动');

    await nav('materials');
    await page.locator(`[data-craft-plan-id="${b}"] [data-action="craft-plan-complete"]`).click();
    const oldPlan = await readPlan();
    await companion.evaluate(
      async ({ id, plan }) => {
        const r = await window.journal.mutate({
          type: 'craft-plan-save',
          id,
          name: plan.name,
          list: [{ id: 'fusion-9500', quantity: 4 }],
          choices: plan.choices || {},
          reserved: true,
        });
        if (!r.ok) throw Error(r.error);
      },
      { id: b, plan: oldPlan },
    );
    await page.locator('[data-action="craft-plan-complete-confirm"]').click();
    await page.waitForFunction(() => document.body.textContent.includes('计划内容或完成状态已变化'));
    assert.equal((await readPlan()).done, false);
    assert.equal((await readPlan()).list[0].quantity, 4);
    await page.locator('.modal-footer [data-action="close-overlay"]').click();
    checks.push('另一窗口更新配方数量后，旧完成预览被拒绝，四份新计划保持未完成');

    await api('mutate', { type: 'craft-plan-open', id: b });
    await api('mutate', { type: 'craft-set', id: 'fusion-9500', quantity: 5 });
    await nav('materials');
    await page.locator(`[data-craft-plan-id="${b}"] [data-action="craft-plan-complete"]`).click();
    await page.locator('[data-action="craft-plan-complete-confirm"]').click();
    await page.waitForFunction(() => document.body.textContent.includes('未保存的编辑'));
    assert.equal((await readPlan()).done, false);
    assert.equal((await current()).craftList[0].quantity, 5);
    await page.locator('.modal-footer [data-action="close-overlay"]').click();
    await api('mutate', { type: 'craft-plan-open', id: b });
    await completeMain();
    await page.screenshot({ path: path.join(results, 'craft-completion-main.png') });
    checks.push('未保存的当前编辑阻止误完成；恢复已保存内容后可从主窗口完成');

    const list = game.entries
      .filter((x) => x.kind === '配方')
      .slice(0, 40)
      .map((x) => ({ id: x.id, quantity: 999 }));
    await api('mutate', { type: 'craft-plan-save', name: '长计划'.repeat(25), list, reserved: false });
    const long = (await current()).craftPlans[0];
    await nav('materials');
    await page.locator(`[data-craft-plan-id="${long.id}"] [data-action="craft-plan-complete"]`).click();
    await controlsVisible(page);
    assert.equal(await page.locator('.journey-intent-body p').count(), 41);
    const scroll = await page
      .locator('.journey-intent-body')
      .evaluate((x) => ({ scroll: x.scrollHeight, client: x.clientHeight }));
    assert(scroll.scroll > scroll.client);
    await page.locator('.modal-footer [data-action="close-overlay"]').click();
    checks.push('最大四十配方、长名称预览在最小主窗口中独立滚动，确认与取消保持可见');

    await api('mutate', { type: 'profile-add', name: '误移除恢复验证' });
    await app.close();
    app = null;
    await launch();
    await nav('materials');
    const recipe = game.entries.find((x) => x.id === 'fusion-1000');
    await page.locator('#craft-search').fill(recipe.name);
    await page.locator('[data-action="craft-add"][data-id="fusion-1000"]').click();
    const quantity = page.locator('#craft-qty-fusion-1000');
    await quantity.focus();
    await quantity.press('Control+A');
    await quantity.pressSequentially('7');
    await page.locator('#craft-search').focus();
    await until(current, (p) => p.craftList?.[0]?.quantity === 7, 'seven craft quantities not persisted');
    await page.locator('[data-action="craft-remove"][data-id="fusion-1000"]').click();
    await until(current, (p) => p.craftList?.length === 0, 'craft removal not persisted');
    await page.locator('[data-action="craft-draft-restore"]').waitFor();
    await page.screenshot({ path: path.join(results, 'craft-removal-recovery-offered.png') });
    await app.close();
    app = null;
    await launch();
    const removed = await current();
    assert.deepEqual(removed.craftList, []);
    assert.deepEqual(removed.previousCraftList, [{ id: 'fusion-1000', quantity: 7 }]);
    await nav('materials');
    await page.locator('#craft-search').fill(recipe.name);
    await page.locator('[data-action="craft-add"][data-id="fusion-1000"]').click();
    await until(current, (p) => p.craftList?.[0]?.quantity === 1, 'later re-add not persisted');
    await page.locator('[data-action="craft-draft-restore"]').click();
    await until(current, (p) => p.craftList?.[0]?.quantity === 7, 'removed original quantity not restored');
    assert.equal(await page.locator('#craft-qty-fusion-1000').inputValue(), '7');
    await page.screenshot({ path: path.join(results, 'craft-removal-original-seven-restored.png') });
    checks.push('误移除配方后可从明确入口找回原七次制作；原次数在冷重启后仍保留');
    await page.locator('[data-action="craft-draft-restore"]').click();
    await until(current, (p) => p.craftList?.[0]?.quantity === 1, 'later craft edits not recoverable');
    assert.equal(await page.locator('#craft-qty-fusion-1000').inputValue(), '1');
    checks.push('找回旧清单保留后来重新添加的一次制作，可再次切回，两个安排均未丢失');
    assert.equal(hash(fs.readFileSync(file)), hash(bytes));
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'craft-completion-ui-result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          executionMode: override ? 'packaged-assistant' : 'source-electron',
          checks,
          errors,
          visibility,
          data,
          saveHash: hash(bytes),
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, data }));
  } catch (error) {
    fs.writeFileSync(
      path.join(results, 'craft-completion-ui-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, visibility, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(results, 'craft-completion-failure.png'), fullPage: true })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
