'use strict';
// Normal foreground refresh, isolated synthetic saves, no injected refresh events.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
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
const data = path.join(base, '.test-data', 'natural-planning-refresh-' + Date.now());
const userData = path.join(data, 'userdata'),
  saves = path.join(data, 'synthetic-SaveGames');
const results = path.join(base, 'test-results');
fs.mkdirSync(saves, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const file = path.join(saves, '0.sav');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function save(step, hasStock = true) {
  const bytes = syntheticSave({
    full: true,
    seconds: 9000,
    quests: [{ id: 14082, step }],
    inventory: hasStock
      ? [
          { id: 10216, count: 3 },
          { id: 10246, count: 1 },
          { id: 10205, count: 1 },
        ]
      : [],
    fusionRecipes: [1000],
    alchemyRecipes: [],
    cookingRecipes: [],
    money: 100000000,
  });
  fs.writeFileSync(file, bytes);
  const settled = new Date(Date.now() - 5000);
  fs.utimesSync(file, settled, settled);
  return hash(bytes);
}
let expectedHash = save(1),
  app,
  page;
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '0.sav', mode: 'slot' });
store.mutate({
  type: 'goal-add',
  title: '合成桃花林事项',
  source: { type: 'quest', id: 'quest-14082' },
  progressMode: 'automatic',
});
const errors = [],
  checks = [];
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: userData };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'YIJIAN_EXECUTABLE', 'YIJIAN_TEST_HIDDEN', 'YIJIAN_TEST_TRAY'])
      delete env[key];
    for (const key of Object.keys(env))
      if (/^YIJIAN_GAME.*(?:PATH|EXECUTABLE|EXE)$/.test(key)) delete env[key];
    app = await _electron.launch({
      executablePath: override ? expectedExecutable : require('electron'),
      args: override ? [] : [base],
      cwd: base,
      env,
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.layout').waitFor();
    await page.locator('.nav-btn[data-id="journey"]').click();
    const result = await page.evaluate(() => window.journal.journeyPlan());
    assert.equal(result.ok, true, result.error);
    const action = result.data.actions.find((a) => a.questId === 'quest-14082');
    assert.ok(action);
    const card = page.locator(`[data-journey-id="${action.id}"]`);
    await card.waitFor();
    const before = await card.innerText();
    assert(!before.includes('游戏已完成'));
    assert.equal(await page.evaluate(() => document.hidden), false);
    expectedHash = save(4);
    // No IPC reads or UI clicks while waiting: only inspect the rendered UI.
    await page.waitForFunction(
      (id) => {
        const card = document.querySelector(`[data-journey-id="${id}"]`);
        return !card || card.textContent.includes('游戏已完成');
      },
      action.id,
      { timeout: 13000 },
    );
    checks.push('关闭自动备份时，当前行程仍会自然读取新存档并投射任务完成');
    await page.screenshot({ path: path.join(results, 'natural-planning-journey.png') });
    await page.locator('.nav-btn[data-id="home"]').click();
    await page.locator('[data-action="recipe-discovery-open"]').first().click();
    await page.locator('.recipe-discovery-source').waitFor();
    assert.match(await page.locator('.recipe-discovery-source').innerText(), new RegExp(expectedHash));
    assert.equal(await page.locator('[data-recipe-discovery-id="fusion-1000"]').count(), 1);
    assert.equal(await page.evaluate(() => document.hidden), false);
    expectedHash = save(4, false);
    await page.waitForFunction(
      (expected) =>
        document.querySelector('.recipe-discovery-source')?.textContent.includes(expected) &&
        !document.querySelector('[data-recipe-discovery-id="fusion-1000"]'),
      expectedHash,
      { timeout: 13000 },
    );
    checks.push('余料配方页自然跟随库存变化，更新真实参照摘要和可支持的配方');
    await page.screenshot({ path: path.join(results, 'natural-planning-recipe-discovery.png') });
    expectedHash = save(4, true);
    const setup = await page.evaluate(async () => {
      const commands = [
        {
          type: 'craft-plan-save',
          name: '材料备齐后实际去制作',
          list: [{ id: 'fusion-1000', quantity: 1 }],
          reserved: true,
        },
        {
          type: 'journey-todo-put',
          id: 'home-next-todo',
          title: '真正待处理的个人事项',
          detail: '不应被已备齐材料挡住',
          done: false,
        },
      ];
      for (const command of commands) {
        const r = await window.journal.mutate(command);
        if (!r.ok) throw Error(r.error);
      }
      return true;
    });
    assert(setup);
    await page.locator('.nav-btn[data-id="home"]').click();
    await page.waitForFunction(
      () => document.querySelector('.home-journey')?.textContent.includes('真正待处理的个人事项'),
      null,
      { timeout: 13000 },
    );
    const planResponse = await page.evaluate(() => window.journal.journeyPlan());
    assert(planResponse.ok, planResponse.error);
    const plan = planResponse.data,
      shown = await page
        .locator('.home-journey [data-action="journey-focus"]')
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
    assert(plan.summary.prepared >= 3, 'fixture must contain at least three already prepared materials');
    assert(plan.actions.some((a) => a.prepared));
    assert(shown.length > 0 && shown.length <= 3);
    for (const id of shown) {
      const action = plan.actions.find((a) => a.id === id);
      assert(action && !action.prepared && !action.gameComplete && !action.userDone && !action.handled);
    }
    assert(!/备料已齐：/.test(await page.locator('.home-journey').innerText()));
    assert.match(await page.locator('.home-journey').innerText(), /纯钢剑（蓝色品质） × 1 次配方/);
    const craft = plan.actions.find((a) => a.kind === 'craft' && a.recipeId === 'fusion-1000');
    await page.locator('.home-journey [data-action="journey-focus"][data-id="' + craft.id + '"]').click();
    const craftCard = page.locator('[data-journey-id="' + craft.id + '"]');
    await craftCard.locator('.journey-evidence > summary').click();
    assert.match(
      await craftCard.locator('.journey-craft-results').innerText(),
      /执行配方：纯钢剑精良图纸 · 1 次[\s\S]*预计产物：[\s\S]*纯钢剑[\s\S]*蓝色品质 × 1[\s\S]*尚未进入背包/,
    );
    await craftCard.locator('[data-journey-craft-output] [data-action="database-detail"]').click();
    await page.locator('.game-detail-title').waitFor();
    assert.match(await page.locator('.game-detail-title').innerText(), /纯钢剑/);
    await page.keyboard.press('Escape');
    checks.push('首页制作行动使用真实产物与品质，完整行程保留原配方、次数和产出提示，并能打开精确产物详情');
    await page.locator('.nav-btn[data-id="home"]').click();
    checks.push('首页下一步优先显示尚需行动的制作与个人事项，已备齐材料留在完整行程统计，不占摘要三个位置');
    await page.screenshot({
      path: path.join(results, 'natural-planning-home-next.png'),
      animations: 'disabled',
    });
    assert.equal(hash(fs.readFileSync(file)), expectedHash);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'natural-planning-refresh-result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          executionMode: override ? 'packaged-assistant' : 'source-electron',
          checks,
          errors,
          data,
          expectedHash,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, data }));
  } catch (error) {
    fs.writeFileSync(
      path.join(results, 'natural-planning-refresh-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page.screenshot({ path: path.join(results, 'natural-planning-failure.png') }).catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
