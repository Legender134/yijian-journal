'use strict';
// Real assistant windows; isolated synthetic saves and journal only.
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
  throw Error('只接受本候选的实际 EXE');
const data = path.join(base, '.test-data', 'usability-continuity-' + Date.now());
const userData = path.join(data, 'userdata'),
  saves = path.join(data, 'synthetic-SaveGames'),
  results = path.join(base, 'test-results');
fs.mkdirSync(saves, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const saveFile = path.join(saves, '1.sav');
let expectedHash, app, page, companion;
const checks = [],
  errors = [];
function save(seconds) {
  const bytes = syntheticSave({
    full: true,
    seconds,
    quests: [{ id: 11077, step: 1 }],
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ],
    fusionRecipes: [1000],
  });
  fs.writeFileSync(saveFile, bytes);
  const settled = new Date(Date.now() - 5000);
  fs.utimesSync(saveFile, settled, settled);
  expectedHash = createHash('sha256').update(bytes).digest('hex');
}
save(10000);
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '1.sav', mode: 'slot' });
store.mutate({
  type: 'goal-add',
  title: '武当行程',
  source: { type: 'quest', id: 'quest-11077' },
  progressMode: 'automatic',
});
store.mutate({
  type: 'journal-entry-put',
  title: '这是一条旧记录',
  body: '确认时的正文',
  occurredAt: '2026-10-09T00:00:00.000Z',
  tags: [],
  links: [],
  snapshotMode: 'none',
});
const initial = store.get(),
  p = initial.profiles[0],
  stamp = new Date().toISOString();
const recordId = p.journalEntries[0].id;
p.craftPlans = ['a', 'b'].map((id) => ({
  id,
  name: id === 'a' ? '先做的剑' : '稍后做的剑',
  list: [{ id: 'fusion-1000', quantity: 1 }],
  reserved: true,
  createdAt: stamp,
  updatedAt: stamp,
}));
store.commit(initial);
async function current() {
  const result = await page.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.state.profiles.find((row) => row.id === result.data.state.activeProfileId);
}
async function nav(id) {
  await page.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function waitState(predicate) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const value = await current();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('状态没有按实际操作保存');
}
async function searchHelp(target, size) {
  await target.keyboard.press('Control+k');
  await target.locator('#global-search').fill('品质:');
  assert.deepEqual(await target.locator('[role="option"] strong').allTextContents(), [
    '品质:白',
    '品质:绿',
    '品质:蓝',
    '品质:金',
    '品质:暗金',
    '品质:红',
  ]);
  await target.keyboard.press('ArrowDown');
  await target.keyboard.press('Tab');
  assert.equal(await target.locator('#global-search').inputValue(), '品质:绿 ');
  assert((await target.locator('.search-result').count()) > 0);
  await target.locator('.search-tools summary').click();
  assert.equal(await target.locator('.search-filter-row').count(), 7);
  const modal = await target.locator('.search-modal').boundingBox();
  assert(modal && modal.y >= 0 && modal.y + modal.height <= size.height + 1);
  const close = await target.locator('.search-input [data-action="close-overlay"]').boundingBox();
  assert(close && close.y >= 0 && close.y + close.height <= size.height);
  await target.screenshot({
    path: path.join(results, 'usability-search-help-' + size.width + '.png'),
    timeout: 15000,
  });
  await target.keyboard.press('Escape');
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
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => !win.webContents.getURL().includes('compact'))
        .setContentSize(1000, 700),
    );
    await searchHelp(page, { width: 1000, height: 700 });
    checks.push('主窗显示六种品质补全与全部七种筛选，键盘选择可搜索，帮助与关闭按钮可达');
    await nav('world');
    for (const kind of ['quests', 'places']) {
      await page.locator('[data-action="world-kind"][data-id="' + kind + '"]').click();
      await page.locator('#world-search').fill('(武当');
      await page.locator('#world-search-error').waitFor();
      assert.match(await page.locator('#world-search-error').innerText(), /括号尚未配对/);
      assert.equal(await page.locator('#world-search').getAttribute('aria-invalid'), 'true');
      assert.ok(!(await page.locator('#app').innerText()).includes('没有匹配的线索'));
      await page.locator('#world-search').fill('武当');
      await page.locator('.database-card').first().waitFor();
      assert.equal(await page.locator('#world-search-error').count(), 0);
    }
    await page.locator('#world-search').focus();
    await page.keyboard.press('Control+k');
    await page.locator('#global-search').fill('名称:煤炭');
    await page.locator('.search-tools summary').click();
    await page.locator('[data-action="search-save"]').click();
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('搜索已保存'));
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'world-search');
    assert.equal(await page.locator('#world-search').inputValue(), '武当');
    checks.push('任务与地点分别提示未完成语法并可原位纠正；保存搜索后关闭弹窗恢复原输入焦点');
    await nav('journey');
    const plan = await page.evaluate(() => window.journal.journeyPlan());
    assert(plan.ok, plan.error);
    const action = plan.data.actions.find((row) => row.questId === 'quest-11077');
    assert(action);
    const card = page.locator('[data-journey-id="' + action.id + '"]');
    const choice = card.locator('[data-itinerary-place]');
    await choice.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    const picked = await choice.inputValue();
    assert(picked);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'journey-itinerary-add');
    await page.waitForTimeout(6500); // Cross one ordinary 5-second foreground refresh.
    assert.equal(await choice.inputValue(), picked);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'journey-itinerary-add');
    await page.keyboard.press('Enter');
    await waitState((row) =>
      row.journey?.itinerary?.steps.some((step) => step.actionId === action.id && step.placeId === picked),
    );
    await page.locator('[data-persist-detail="itinerary-name"] summary').click();
    await page.locator('#journey-itinerary-name').fill('键盘输入的新行程名');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(6500);
    assert.equal(await page.locator('#journey-itinerary-name').inputValue(), '键盘输入的新行程名');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'journey-itinerary-name');
    await page.keyboard.press('Enter');
    await waitState((row) => row.journey.itinerary.name === '键盘输入的新行程名');
    checks.push('自然刷新后场景、行程名称与提交按钮焦点保留，Enter 保存原选择');
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await created;
    companion.on('pageerror', (e) => errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes('compact'))
        .setContentSize(460, 660),
    );
    await searchHelp(companion, { width: 460, height: 660 });
    checks.push('460×660 小窗也能查看筛选帮助、补全搜索并关闭');
    await nav('journal');
    await page.locator('[data-action="journal-entry-new"]').click();
    await page.locator('#journal-title').fill('梧桐村指定场景的约定');
    await page.locator('#journal-body').fill('约定发生于场景 63，其他同名场景不共用关联。');
    await page.locator('#journal-reference-query').fill('梧桐村');
    const sceneIds = ['10', '63', '64', '9'];
    assert.equal(
      await page
        .locator('#journal-reference-results [data-action="journal-reference-add"][data-id^="place:"]')
        .count(),
      4,
    );
    for (const id of sceneIds) {
      const choiceRow = page
        .locator('#journal-reference-results .row')
        .filter({ has: page.locator('[data-id="place:place-' + id + '"]') });
      assert.match(await choiceRow.innerText(), new RegExp('梧桐村 · 场景 #' + id));
    }
    await page.locator('[data-action="journal-reference-add"][data-id="place:place-63"]').click();
    assert.match(await page.locator('#journal-selected-references').innerText(), /梧桐村 · 场景 #63/);
    await page.screenshot({ path: path.join(results, 'usability-distinct-scenes.png'), timeout: 15000 });
    await page.locator('[data-action="journal-entry-save"]').click();
    const afterScene = await waitState((row) =>
      row.journalEntries.some((entry) => entry.title === '梧桐村指定场景的约定'),
    );
    const sceneEntry = afterScene.journalEntries.find((entry) => entry.title === '梧桐村指定场景的约定');
    assert.deepEqual(sceneEntry.links, [{ type: 'place', id: 'place-63', label: '梧桐村 · 场景 #63' }]);
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill('梧桐村指定场景的约定');
    await companion.locator('.search-result[data-action="journal-entry-open"]').click();
    assert.match(await companion.locator('#overlay').innerText(), /梧桐村 · 场景 #63/);
    await companion.keyboard.press('Escape');
    checks.push('四个同名地点显示不同场景编号，选择场景 63 后保存及另一窗口重开仍对应原 ID');
    await page.locator('[data-action="journal-entry-new"]').click();
    await page.locator('#journal-title').fill('区分长虹剑品质和图纸类型');
    await page.locator('#journal-reference-query').fill('长虹剑');
    const identities = [
      ['item-1006', '物品 · 长虹剑（绿色品质）'],
      ['item-1007', '物品 · 长虹剑（蓝色品质）'],
      ['item-1008', '物品 · 长虹剑（金色品质）'],
      ['fusion-1002', '配方 · 长虹剑精良图纸'],
      ['item-100002', '物品 · 长虹剑精良图纸（金色品质） · 学习图纸'],
    ];
    for (const [id, label] of identities) {
      const button = page.locator(
        '#journal-reference-results [data-action="journal-reference-add"][data-id="database:' + id + '"]',
      );
      assert(
        (await button.locator('xpath=ancestor::div[contains(@class,"row")][1]').innerText()).includes(label),
      );
      await button.click();
      assert((await page.locator('#journal-selected-references').innerText()).includes(label));
    }
    await page.locator('[data-action="journal-entry-save"]').click();
    const identityProfile = await waitState((row) =>
      row.journalEntries.some((entry) => entry.title === '区分长虹剑品质和图纸类型'),
    );
    const identityEntry = identityProfile.journalEntries.find(
      (entry) => entry.title === '区分长虹剑品质和图纸类型',
    );
    assert.deepEqual(
      identityEntry.links,
      identities.map(([id, label]) => ({ type: 'database', id, label })),
    );
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill('区分长虹剑品质和图纸类型');
    await companion.locator('.search-result[data-action="journal-entry-open"]').click();
    for (const [, label] of identities)
      assert((await companion.locator('#overlay').innerText()).includes(label));
    await companion.keyboard.press('Escape');
    checks.push('三种长虹剑品质及同名配方/学习图纸分别显示，保存与小窗重开仍保留精确身份');
    await page
      .locator('[data-action="journal-entry-open"][data-id="' + recordId + '"]')
      .first()
      .click();
    await page.locator('#overlay [data-action="journal-entry-remove"]').click();
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill('这是一条旧记录');
    await companion.locator('.search-result[data-action="journal-entry-open"]').click();
    await companion.locator('[data-action="journal-entry-edit"]').click();
    await companion.locator('#journal-title').fill('小窗刚修改后的记录');
    await companion.locator('#journal-body').fill('另一窗口新增的重要正文');
    await companion.locator('[data-action="journal-entry-save"]').click();
    await waitState((row) =>
      row.journalEntries.some((entry) => entry.id === recordId && entry.body === '另一窗口新增的重要正文'),
    );
    await page.locator('[data-action="journal-entry-remove-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('已变化'));
    assert(
      (await current()).journalEntries.some(
        (entry) => entry.id === recordId && entry.title === '小窗刚修改后的记录',
      ),
    );
    await page.keyboard.press('Escape');
    await page.locator('#overlay [data-action="journal-entry-edit"]').waitFor();
    assert.match(await page.locator('#overlay').innerText(), /小窗刚修改后的记录/);
    assert.match(await page.locator('#overlay').innerText(), /另一窗口新增的重要正文/);
    await page.locator('#overlay [data-action="close-overlay"]').click();
    await page.waitForFunction(() => !document.querySelector('#overlay').children.length);
    checks.push('主窗旧删除确认被后台阻断；取消返回小窗更新后的完整记录，再明确关闭详情');
    await nav('materials');
    await page.locator('[data-action="resource-priority-open"]').click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await page.locator('[data-action="resource-priority-move"][data-id="b"][data-direction="up"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-order .spacer')?.textContent.includes('稍后做的剑'),
    );
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    save(12000);
    await page.locator('[data-action="resource-priority-save"]').click();
    await page.waitForFunction(() =>
      document.querySelector('.resource-priority-editor')?.textContent.includes('存档或计划已变化'),
    );
    assert.deepEqual(await page.locator('.resource-priority-order .spacer').allTextContents(), [
      '1. 稍后做的剑',
      '2. 先做的剑',
    ]);
    assert.equal(await page.locator('[aria-label="上移 稍后做的剑"]').count(), 1);
    assert.match(await page.locator('.resource-priority-editor').innerText(), /分配待重新核对/);
    await page.locator('[data-action="resource-priority-refresh"]').click();
    await page.locator('[data-action="resource-priority-save"]').waitFor();
    await page.locator('[data-action="resource-priority-save"]').click();
    await waitState((row) => row.resourcePriority?.[0] === 'b');
    checks.push('旧分配预览失效仍保留用途名、顺序和可访问标签，重新核对可确认');
    assert.equal(createHash('sha256').update(fs.readFileSync(saveFile)).digest('hex'), expectedHash);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'usability-continuity-result.json'),
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
      path.join(results, 'usability-continuity-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(results, 'usability-continuity-failure.png'), timeout: 15000 })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
