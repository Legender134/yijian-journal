'use strict';
// Exact-item usage and allocation continuity, real windows and synthetic save files.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto');
const { _electron } = require('playwright'),
  { Store } = require('../src/core/store.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs'),
  catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..'),
  override = process.env.YIJIAN_EXECUTABLE,
  executable = path.join(
    base,
    'dist',
    'v' + require('../package.json').version,
    '逸剑手札-win32-x64',
    '逸剑手札.exe',
  );
if (override && path.resolve(override).toLowerCase() !== executable.toLowerCase())
  throw Error('只接受本候选实际EXE');
const data = path.join(base, '.test-data', 'item-usage-' + Date.now()),
  userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames'),
  results = path.join(base, 'test-results');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const file = path.join(source, '1.sav');
fs.writeFileSync(
  file,
  syntheticSave({
    full: true,
    inventory: [
      { id: 10216, count: 4 },
      { id: 10216, count: 6 },
      { id: 10205, count: 10 },
      { id: 10246, count: 10 },
    ],
  }),
);
const settled = new Date(Date.now() - 5000);
fs.utimesSync(file, settled, settled);
const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  initialSaveHash = hash();
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'reserve-set', id: '10216', count: 1 });
store.mutate({
  type: 'craft-plan-save',
  name: '已有铁锭计划甲',
  list: [{ id: 'fusion-1000', quantity: 1 }],
  choices: {},
  reserved: true,
});
store.mutate({
  type: 'craft-plan-save',
  name: '已有铁锭计划乙',
  list: [{ id: 'fusion-1001', quantity: 1 }],
  choices: {},
  reserved: true,
});
let app, page, companion;
const checks = [],
  errors = [];
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.layout').waitFor();
}
async function current() {
  const r = await page.evaluate(() => window.journal.bootstrap());
  assert(r.ok, r.error);
  return r.data.state.profiles.find((p) => p.id === r.data.state.activeProfileId);
}
async function item(target = page, id = 'item-10216', name = '铁锭') {
  await target.keyboard.press('Control+k');
  await target.locator('#global-search').fill('名称:' + name + ' 种类:物品');
  await target.locator('.search-result[data-action="database-detail"][data-id="' + id + '"]').click();
  await target.locator('.item-usage').waitFor();
}
async function stock(target = page) {
  return target.locator('.item-usage .detail-stat-grid strong').allTextContents();
}
(async () => {
  try {
    await launch();
    await item();
    assert.deepEqual(await stock(), ['10', '7', '3']);
    assert.match(await page.locator('.item-usage').innerText(), /已有铁锭计划甲/);
    assert.match(await page.locator('.item-usage').innerText(), /已有铁锭计划乙/);
    assert.match(await page.locator('.item-usage').innerText(), /绿.*品质/);
    assert.equal(await page.locator('.item-usage-row').count(), 3);
    checks.push('精确绿品质铁锭汇总手动留用和两份已有计划，真实持有10、占用7、余量3，重复背包条目正确合并');
    const firstPlan = (await current()).craftPlans.find((p) => p.name === '已有铁锭计划甲');
    await page.locator('.item-usage [data-action="craft-plan-open"][data-id="' + firstPlan.id + '"]').click();
    await page.locator('.nav-btn[data-id="materials"].active').waitFor();
    assert.equal((await current()).activeCraftPlanId, firstPlan.id);
    await item();
    assert.deepEqual(await stock(), ['10', '7', '3']);
    await page.locator('#reserve-count').fill('2');
    await page.locator('[data-action="reserve-save"]').click();
    assert.deepEqual(await stock(), ['10', '8', '2']);
    checks.push('点用途回到相应制作计划，返回物品不重复占用编辑计划；修改留用后预算立即更新');
    await page.locator('#item-save').selectOption('');
    assert.deepEqual(await stock(), ['待核对', '待核对', '待核对']);
    assert.match(await page.locator('.item-usage').innerText(), /尚未选择|待核对/);
    await page.locator('#item-save').selectOption('@latest');
    assert.deepEqual(await stock(), ['10', '8', '2']);
    checks.push('仅查资料保留未知数值，重新选择最新保存后恢复真实预算');
    await page.keyboard.press('Escape');
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await created;
    companion.on('pageerror', (e) => errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await item(companion);
    assert.deepEqual(await stock(companion), ['10', '8', '2']);
    await item();
    const completed = await companion.evaluate(
      (plan) =>
        window.journal.mutate({ type: 'craft-plan-complete', id: plan.id, value: true, expectedPlan: plan }),
      (await current()).craftPlans.find((p) => p.id === firstPlan.id),
    );
    assert(completed.ok, completed.error);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.item-usage .detail-stat-grid strong')]
          .map((e) => e.textContent)
          .join(',') === '10,5,5',
    );
    assert.equal(await page.locator('.item-usage-row[data-item-usage^="craft:"]').count(), 1);
    await companion.waitForFunction(
      () =>
        [...document.querySelectorAll('.item-usage .detail-stat-grid strong')]
          .map((e) => e.textContent)
          .join(',') === '10,5,5',
    );
    await page.locator('.item-usage').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(results, 'item-usage-current.png'),
      animations: 'disabled',
      timeout: 15000,
    });
    checks.push('主窗口与小窗同时反查，另一窗口完成计划后释放3个真实库存，两窗口详情自动重新核对');
    await page.keyboard.press('Escape');
    await app.close();
    app = null;
    await launch();
    await item();
    assert.deepEqual(await stock(), ['10', '5', '5']);
    assert.equal(hash(), initialSaveHash);
    assert.deepEqual(errors, []);
    checks.push('冷重启保留用途和完成状态，全部合成存档字节保持');
    fs.writeFileSync(
      path.join(results, 'item-usage-result.json'),
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
      path.join(results, 'item-usage-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(results, 'item-usage-failure.png'), timeout: 15000 })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
