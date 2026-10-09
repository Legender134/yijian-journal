'use strict';
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
    await page.locator('.nav-btn[data-id="materials"]').click();
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
    await page.locator('.nav-btn[data-id="materials"]').click();
    await openDialog();
    await page.locator('[data-action="resource-priority-reset"]').click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.deepEqual((await current()).resourcePriority, []);
    checks.push('恢复默认顺序先预览再确认');
    const response = await page.evaluate(() =>
      window.journal.mutate({ type: 'save-slot', value: '', mode: 'none' }),
    );
    assert(response.ok, response.error);
    // A fresh main-process projection must retain unknowns in every preview.
    const p = await current();
    const unknown = await page.evaluate((id) => window.journal.resourcePriorityPreview(id, ['a', 'b']), p.id);
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
