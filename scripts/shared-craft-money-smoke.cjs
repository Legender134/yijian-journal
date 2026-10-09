'use strict';
// Electron UI regression; all saves and application state are synthetic.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
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
const data = path.join(base, '.test-data', 'shared-craft-money-ui-' + Date.now());
const userData = path.join(data, 'userdata'),
  saves = path.join(data, 'synthetic-SaveGames');
fs.mkdirSync(saves, { recursive: true });
const inventory = [
  { id: 10216, count: 3 },
  { id: 10246, count: 1 },
  { id: 10205, count: 1 },
];
const files = new Map();
function write(name, multiplier, seconds, recent = false) {
  const bytes = syntheticSave({
    full: true,
    seconds,
    quests: [],
    fusionRecipes: [1000],
    inventory: inventory.map((i) => ({ ...i, count: i.count * multiplier })),
    money: 1000,
  });
  const file = path.join(saves, name);
  fs.writeFileSync(file, bytes);
  const stamp = new Date(Date.now() - (recent ? 0 : name === '0.sav' ? 10000 : 5000));
  fs.utimesSync(file, stamp, stamp);
  files.set(name, bytes);
}
write('0.sav', 1, 9000);
write('1.sav', 2, 10000);
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '', mode: 'latest' });
const state = store.get(),
  profile = state.profiles[0],
  stamp = new Date().toISOString();
profile.craftList = [{ id: 'fusion-1000', quantity: 1 }];
profile.activeCraftPlanId = 'a';
profile.craftPlans = ['a', 'b'].map((id) => ({
  id,
  name: '合成费用计划 ' + id,
  list: structuredClone(profile.craftList),
  reserved: true,
  done: false,
  choices: {},
  createdAt: stamp,
  updatedAt: stamp,
}));
store.commit(state);
let app, page, companion;
const checks = [],
  errors = [];
async function api(name, ...args) {
  const response = await page.evaluate(({ name, args }) => window.journal[name](...args), { name, args });
  assert(response.ok, response.error);
  return response.data;
}
const current = async () => {
  const state = (await api('bootstrap')).state;
  return state.profiles.find((p) => p.id === state.activeProfileId);
};
const nav = (id) => page.locator(`.nav-btn[data-id="${id}"]`).click();
async function calculate(name) {
  if (name !== undefined) await page.locator('#craft-save').selectOption(name);
  await page.locator('[data-action="craft-calculate"]').click();
  await page.locator('.craft-result-card [data-shared-craft-money]').waitFor();
}
async function openPriority() {
  await page.locator('[data-action="resource-priority-open"]').click();
  await page.locator('[data-action="resource-priority-save"]').waitFor();
}
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
    await nav('materials');
    await calculate('1.sav');
    const notices = await page.locator('[data-shared-craft-money]').allTextContents();
    assert.equal(notices.length, 2);
    for (const text of notices) assert.match(text, /1,144.*1,000.*共同还差 144 文/);
    assert.equal(
      await page.locator('[data-action="resource-priority-open"]').count(),
      0,
      'copper shortage does not claim material ranking solves it',
    );
    assert.doesNotMatch(await page.locator('.craft-result-card').innerText(), /足够支付基础制作费/);
    await page.screenshot({ path: path.join(data, 'shared-copper-144.png'), animations: 'disabled' });
    await nav('journey');
    assert.match(await page.locator('main.content').innerText(), /共同还差 144 文/);
    const made = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await made;
    companion.on('pageerror', (e) => errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await companion.locator('.companion-materials [data-shared-craft-money]').waitFor();
    assert.match(
      await companion.locator('.companion-materials [data-shared-craft-money]').innerText(),
      /共同还差 144 文/,
    );
    await companion.screenshot({ path: path.join(data, 'companion-copper-144.png'), animations: 'disabled' });
    await companion.locator('[data-action="main"]').click();
    checks.push('铜钱1000与双572计划：备料/全部用途/行程/真实小窗共同提示144，材料顺序不冒充货币分配');

    await nav('materials');
    await calculate('0.sav');
    assert.match(await page.locator('main.content').innerText(), /直接材料还差 5 件.*原料还差 8 件/s);
    assert.match(
      await page.locator('.craft-result-card [data-shared-craft-money]').innerText(),
      /1,294.*共同还差 294 文/,
    );
    await openPriority();
    assert.match(await page.locator('.resource-priority-editor').innerText(), /对照 0\.sav/);
    await page.locator('[data-action="resource-priority-move"][data-id="b"][data-direction="up"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-order .spacer')?.textContent.includes('计划 b'),
    );
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    write('0.sav', 1, 11000);
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-editor')?.textContent.includes('存档或计划已变化'),
    );
    assert.equal((await current()).resourcePriority, undefined);
    await page.locator('[data-action="resource-priority-refresh"]').click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    assert.match(await page.locator('.resource-priority-editor').innerText(), /对照 0\.sav/);
    await page.screenshot({ path: path.join(data, 'local-save-priority.png'), animations: 'disabled' });
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    const saved = await current();
    assert.deepEqual(saved.resourcePriority, ['b', 'a']);
    assert.equal(saved.referenceMode, 'latest');
    assert.equal(saved.saveSlot || '', '');
    assert.equal(
      (await api('refresh')).allocations.directMissingTotal,
      0,
      'the profile default still reads abundant 1.sav',
    );
    assert.equal(await page.locator('#craft-save').inputValue(), '0.sav');
    assert.match(
      await page.locator('.craft-result-card [data-shared-craft-money]').innerText(),
      /1,294.*共同还差 294 文/,
    );
    checks.push(
      '局部0.sav的5件/8件缺口、费用与排序入口/预览/确认一致；0.sav hash变化拒绝旧确认；周目默认latest未改变',
    );

    const id = saved.id;
    const beforePlanChange = await api('resourcePriorityPreview', id, ['b', 'a'], '0.sav');
    await api('mutate', { type: 'craft-set', id: 'fusion-1000', quantity: 2 });
    const changedPlan = await page.evaluate(
      ({ id, fingerprint }) =>
        window.journal.mutate({
          type: 'resource-priority-set',
          profileId: id,
          order: ['b', 'a'],
          fingerprint,
          referenceName: '0.sav',
        }),
      { id, fingerprint: beforePlanChange.fingerprint },
    );
    assert.equal(changedPlan.ok, false);
    assert.match(changedPlan.error, /存档或计划已变化/);
    await api('mutate', { type: 'craft-set', id: 'fusion-1000', quantity: 1 });
    const settledPreview = await api('resourcePriorityPreview', id, ['b', 'a'], '0.sav');
    write('0.sav', 1, 12000, true);
    const updating = await page.evaluate(
      (id) => window.journal.resourcePriorityPreview(id, ['b', 'a'], '0.sav'),
      id,
    );
    assert.equal(updating.ok, false);
    assert.match(updating.error, /正在更新/);
    const updatingSave = await page.evaluate(
      ({ id, fingerprint }) =>
        window.journal.mutate({
          type: 'resource-priority-set',
          profileId: id,
          order: ['b', 'a'],
          fingerprint,
          referenceName: '0.sav',
        }),
      { id, fingerprint: settledPreview.fingerprint },
    );
    assert.equal(updatingSave.ok, false);
    assert.match(updatingSave.error, /正在更新/);
    write('0.sav', 1, 12000);
    for (const args of [
      [id, ['b', 'a'], '../0.sav'],
      ['foreign', ['b', 'a'], '0.sav'],
    ]) {
      const result = await page.evaluate((args) => window.journal.resourcePriorityPreview(...args), args);
      assert.equal(result.ok, false);
    }
    await calculate('');
    assert.match(
      await page.locator('.craft-result-card [data-shared-craft-money]').innerText(),
      /存档铜钱待核对/,
    );
    await openPriority();
    assert.match(await page.locator('.resource-priority-editor').innerText(), /没有可读存档参照/);
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.equal((await current()).referenceMode, 'latest');
    checks.push(
      '主进程拒绝计划变化、更新中存档的预览与确认、外国周目和非法参照；局部none保持未知且不改默认参照',
    );

    await calculate('1.sav');
    await page.locator('[data-craft-plan-id="a"] [data-action="craft-plan-complete"]').click();
    await page.locator('[data-action="craft-plan-complete-confirm"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    await calculate('1.sav');
    assert.match(await page.locator('.craft-result-card').innerText(), /若重新制作的费用尚未纳入共同预算/);
    assert.match(
      await page.locator('.craft-result-card [data-shared-craft-money]').innerText(),
      /预计需 572 文/,
    );
    assert.equal((await api('companionSnapshot')).materialsCompleted, true);
    checks.push('完成所选计划后真实共同费用仅剩572；单份若重做预览保留且未复活为共同需求');
    for (const [name, bytes] of files) assert.deepEqual(fs.readFileSync(path.join(saves, name)), bytes);
    assert.deepEqual(errors, []);
    await Promise.all([page.waitForEvent('close'), page.evaluate(() => window.journal.window('quit'))]);
    await app.close().catch(() => {});
    app = null;
    console.log(checks.map((check) => 'PASS ' + check).join('\n'));
  } catch (e) {
    errors.push(e.stack || e.message);
    if (page) await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {});
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(
      path.join(data, 'report.json'),
      JSON.stringify(
        {
          status: errors.length ? 'FAIL' : 'PASS',
          checks,
          errors,
          data,
          mode: override ? 'packaged' : 'source-electron',
          executable: override ? expectedExecutable : null,
        },
        null,
        2,
      ),
    );
  }
})();
