'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const base = path.resolve(__dirname, '..'),
  evidence = process.env.YIJIAN_KEYBOARD_EVIDENCE || path.join(base, '.test-data');
fs.mkdirSync(evidence, { recursive: true });
const data = fs.mkdtempSync(path.join(evidence, 'keyboard-')),
  userdata = path.join(data, 'userdata'),
  saves = path.join(data, 'synthetic-SaveGames'),
  temp = path.join(data, 'temp');
for (const directory of [saves, temp]) fs.mkdirSync(directory, { recursive: true });
process.env.TEMP = process.env.TMP = temp;
const store = new Store(userdata, require('../src/data/catalog.cjs'));
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '', mode: 'none' });
for (let i = 1; i <= 10; i++)
  store.mutate({ type: 'goal-add', title: '补给检查' + String(i).padStart(2, '0') });
store.mutate({
  type: 'goal-toggle',
  id: store.get().profiles[0].goals.find((g) => g.title === '补给检查01').id,
});
store.mutate({
  type: 'craft-plan-save',
  name: '补给检查制作计划',
  list: [{ id: 'fusion-1000', quantity: 1 }],
});
store.mutate({
  type: 'journey-todo-put',
  id: 'supply',
  title: '补给检查这一程行动',
  detail: '',
  done: false,
});
store.mutate({ type: 'note', value: '补给检查随手记内容' });
store.mutate({
  type: 'craft-plan-save',
  name: '合成已完成计划目标',
  list: [{ id: 'fusion-1000', quantity: 1 }],
  addGoal: true,
});
const completedPlan = store.get().profiles[0].craftPlans.find((p) => p.name === '合成已完成计划目标');
store.mutate({ type: 'craft-plan-complete', id: completedPlan.id, value: true, expectedPlan: completedPlan });
const firstProfile = store.get().profiles[0],
  supplyGoals = firstProfile.goals,
  planId = firstProfile.craftPlans.find((p) => p.name === '补给检查制作计划').id,
  completedGoalId = firstProfile.goals.find((g) => g.source?.id === completedPlan.id).id;
const report = { startedAt: new Date().toISOString(), checks: [], externalRequests: [], errors: [] };
let app;
async function goalReadability(win, id, mode) {
  const colors = await win.locator('#goal-' + id).evaluate((row) => {
    const style = (element) => getComputedStyle(element);
    let opacity = 1;
    for (let element = row; element; element = element.parentElement)
      opacity *= Number(style(element).opacity);
    return {
      opacity,
      background: style(row.closest('.card')).backgroundColor,
      title: style(row.querySelector('h3')).color,
      description: style(row.querySelector('p')).color,
      edit: style(row.querySelector('[data-action="goal-edit"]')).color,
      focus: style(row).outlineColor,
    };
  });
  const rgb = (color) =>
    color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  const luminance = (values) =>
    values
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = rgb(colors.background),
    contrast = {};
  for (const key of ['title', 'description', 'edit', 'focus']) {
    const foreground = rgb(colors[key]).map(
      (value, index) => value * colors.opacity + background[index] * (1 - colors.opacity),
    );
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    contrast[key] = (values[0] + 0.05) / (values[1] + 0.05);
  }
  (report.goalReadability ||= []).push({ mode, ...colors, contrast });
  await win.screenshot({ path: path.join(data, mode + '-completed-goal.png') });
  assert(
    contrast.title >= 4.5 && contrast.description >= 4.5 && contrast.edit >= 3 && contrast.focus >= 3,
    JSON.stringify(contrast),
  );
}
async function search(win, value) {
  if (!(await win.locator('#global-search').count())) await win.keyboard.press('Control+k');
  await win.locator('#global-search').fill(value);
}
async function allPersonal(win) {
  const entry = win.locator('[data-action="search-personal-all"]');
  const count = Number((await entry.innerText()).match(/个人内容 (\d+) 项/)[1]);
  await entry.focus();
  await win.keyboard.press('Enter');
  await win.locator('[data-action="search-personal-short"]').waitFor();
  assert.equal(await win.locator('.search-result').count(), count);
  assert.equal(
    await win
      .locator('.search-result')
      .first()
      .evaluate((e) => e === document.activeElement),
    true,
  );
  return count;
}
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: userdata, YIJIAN_TEST_HIDDEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      cwd: base,
      env,
    });
    const win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    win.on('request', (r) => {
      if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
    });
    await win.context().setOffline(true);
    await win.reload();
    await win.locator('.layout').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.showInactive()));
    for (const page of ['checklist', 'library', 'database', 'goals', 'saves', 'settings', 'home'])
      await win.locator(`.nav-btn[data-id="${page}"]`).click();
    await win.locator('.nav-btn[data-id="materials"]').click();
    await win.locator(`[data-action="craft-plan-open"][data-id="${planId}"]`).click();
    await win.locator('#craft-search').fill('');
    const recipes = await win.locator('.craft-suggestions [data-action="craft-add"]').evaluateAll((buttons) =>
      buttons.map((button) => ({
        id: button.dataset.id,
        name: button.parentElement.querySelector('strong').textContent.trim(),
      })),
    );
    assert(recipes.length > 2);
    report.craftAccessibility = { suggestions: await win.locator('.craft-suggestions').ariaSnapshot() };
    for (const recipe of recipes) {
      const button = win.getByRole('button', { name: '加入备料清单：' + recipe.name, exact: true });
      assert.equal(await button.count(), 1, 'recipe-specific accessible add name: ' + recipe.name);
      assert.equal(await button.getAttribute('data-id'), recipe.id);
      assert.equal(await button.getAttribute('title'), '加入备料清单：' + recipe.name);
    }
    const selectedRecipes = recipes.filter((recipe) => recipe.id !== 'fusion-1000').slice(0, 2);
    const addedQuantities = {};
    for (const recipe of [selectedRecipes[0], ...selectedRecipes]) {
      const quantity = (addedQuantities[recipe.id] || 0) + 1;
      addedQuantities[recipe.id] = quantity;
      await win.getByRole('button', { name: '加入备料清单：' + recipe.name, exact: true }).focus();
      await win.keyboard.press('Enter');
      await win.waitForFunction(
        ({ id, quantity }) => document.querySelector('#craft-qty-' + id)?.value === String(quantity),
        { id: recipe.id, quantity },
      );
    }
    const craftList = async () =>
      (await win.evaluate(() => window.journal.bootstrap())).data.state.profiles[0].craftList;
    assert.deepEqual(await craftList(), [
      { id: 'fusion-1000', quantity: 1 },
      { id: selectedRecipes[0].id, quantity: 2 },
      { id: selectedRecipes[1].id, quantity: 1 },
    ]);
    report.craftAccessibility.selected = await win.locator('.craft-layout').ariaSnapshot();
    for (const recipe of selectedRecipes) {
      const button = win.getByRole('button', { name: '移出备料清单：' + recipe.name, exact: true });
      assert.equal(await button.count(), 1);
      assert.equal(await button.getAttribute('data-id'), recipe.id);
      assert.equal(await button.getAttribute('title'), '移出备料清单：' + recipe.name);
      await button.focus();
      await win.keyboard.press('Enter');
      await win.waitForFunction(
        (id) => !document.querySelector(`[data-action="craft-remove"][data-id="${id}"]`),
        recipe.id,
      );
      assert.equal(
        (await craftList()).some((line) => line.id === recipe.id),
        false,
      );
      assert.deepEqual(
        (await craftList()).find((line) => line.id === 'fusion-1000'),
        { id: 'fusion-1000', quantity: 1 },
      );
      if (recipe === selectedRecipes[0])
        assert.deepEqual(
          (await craftList()).find((line) => line.id === selectedRecipes[1].id),
          { id: selectedRecipes[1].id, quantity: 1 },
        );
    }
    await win.locator(`[data-action="craft-plan-open"][data-id="${completedPlan.id}"]`).click();
    await win.locator('.nav-btn[data-id="home"]').click();
    report.checks.push(
      'recipe-specific accessible add/remove names select the intended recipe by keyboard and preserve other quantities',
    );
    await win.locator('.search-trigger').focus();
    await win.keyboard.press('Enter');
    await win.locator('#global-search').fill('清灵丹');
    const count = await win.locator('.search-result').count();
    assert.ok(count > 0);
    for (let i = 0; i < count + 4; i++) {
      await win.keyboard.press('Tab');
      assert.equal(await win.evaluate(() => !!document.activeElement.closest('#overlay')), true);
    }
    for (let i = 0; i < count + 4; i++) {
      await win.keyboard.press('Shift+Tab');
      assert.equal(await win.evaluate(() => !!document.activeElement.closest('#overlay')), true);
    }
    await win.keyboard.press('Escape');
    assert.equal(await win.locator('.search-trigger').evaluate((e) => e === document.activeElement), true);
    assert.equal(await win.locator('#app').evaluate((e) => e.inert), false);
    report.checks.push('search focus stays inside modal in both directions and returns to opener');
    await win.keyboard.press('Control+k');
    await win.locator('#global-search').fill('水煮鱼');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await win.locator('.drawer').waitFor();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('水煮鱼'));
    await win.keyboard.press('Escape');
    await win.locator('[data-action="goal-add"]').first().click();
    await win.locator('#goal-title').fill('键盘创建的备忘');
    await win.keyboard.press('Enter');
    await win.locator('.goal-row').filter({ hasText: '键盘创建的备忘' }).waitFor();
    report.checks.push('offline catalog, keyboard result activation and Enter-to-save goal');

    await search(win, '种类:目标 补给检查');
    assert.equal(await win.locator('.search-result').count(), 8);
    assert.match(await win.locator('[data-action="search-personal-all"]').innerText(), /个人内容 10 项/);
    await win.screenshot({ path: path.join(data, 'main-search-quick.png') });
    assert.equal(await win.locator('.search-result').filter({ hasText: '补给检查01' }).count(), 0);
    await allPersonal(win);
    await win.screenshot({ path: path.join(data, 'main-search-all.png') });
    for (let i = 0; i < 9; i++) await win.keyboard.press('ArrowDown');
    assert.match(await win.evaluate(() => document.activeElement.textContent), /补给检查01/);
    await win.keyboard.press('Enter');
    const goal01 = supplyGoals.find((goal) => goal.title === '补给检查01');
    await win.waitForFunction((id) => document.activeElement.dataset.id === id, goal01.id);
    assert.equal(await win.locator('#global-search').count(), 0);
    await search(win, '种类:目标 补给检查');
    await allPersonal(win);
    await win.locator('.search-result').filter({ hasText: '补给检查02' }).focus();
    await win.keyboard.press('Enter');
    const goal02 = supplyGoals.find((goal) => goal.title === '补给检查02');
    await win.waitForFunction((id) => document.activeElement.dataset.id === id, goal02.id);
    await search(win, '种类:目标 合成已完成计划目标');
    assert.equal(await allPersonal(win), 1);
    await win.keyboard.press('Enter');
    assert.equal(
      await win.locator(`[data-action="goal-toggle"][data-id="${completedGoalId}"]`).isDisabled(),
      true,
    );
    await win.waitForFunction((id) => document.activeElement.id === 'goal-' + id, completedGoalId, {
      timeout: 2000,
    });
    await goalReadability(win, completedGoalId, 'main');
    assert.equal(
      await win
        .locator('#goal-' + completedGoalId)
        .evaluate((e) => e.matches(':focus-visible') && getComputedStyle(e).outlineStyle !== 'none'),
      true,
    );
    report.checks.push(
      '10 matching goals retain 8 quick results and the total; keyboard continuation finds and opens goals 01/02',
    );

    await search(win, '补给检查');
    const mixedCount = await allPersonal(win);
    assert(mixedCount > 10);
    assert.deepEqual(
      [
        ...new Set(
          await win.locator('.search-result').evaluateAll((rows) => rows.map((row) => row.dataset.action)),
        ),
      ].sort(),
      ['craft-plan-open', 'journey-focus', 'search-goal', 'search-note'],
    );
    for (const [kind, action] of [
      ['目标', 'search-goal'],
      ['计划', 'craft-plan-open'],
      ['行动', 'journey-focus'],
      ['笔记', 'search-note'],
    ]) {
      await search(win, `种类:${kind} 补给检查`);
      assert.equal(await win.locator('[data-action="search-personal-short"]').count(), 0);
      await allPersonal(win);
      assert.deepEqual(
        [
          ...new Set(
            await win.locator('.search-result').evaluateAll((rows) => rows.map((row) => row.dataset.action)),
          ),
        ],
        [action],
      );
    }
    await search(win, '种类:目标 状态:已完成 补给检查');
    assert.equal(await allPersonal(win), 1);
    assert.match(await win.locator('.search-result').innerText(), /补给检查01/);
    await search(win, '种类:笔记 补给检查');
    await allPersonal(win);
    await win.locator('.search-result[data-action="search-note"]').click();
    await win.waitForFunction(() => document.activeElement.id === 'note');
    await search(win, '种类:计划 补给检查');
    await allPersonal(win);
    await win.locator('.search-result').click();
    await win.waitForFunction(() => !document.querySelector('#global-search'));
    const openedPlan = await win.evaluate(() => window.journal.bootstrap());
    assert.equal(openedPlan.data.state.profiles[0].activeCraftPlanId, planId);
    await search(win, '种类:行动 补给检查');
    await allPersonal(win);
    const todo = win.locator('.search-result').filter({ hasText: '补给检查这一程行动' });
    const todoId = await todo.getAttribute('data-id');
    await todo.click();
    await win.locator(`[data-journey-id="${todoId}"]`).waitFor();
    report.checks.push(
      'all four personal kinds remain discoverable, exact kind filters retain their meaning, and plans/actions/notes open their own content',
    );

    await search(win, '补给检查 (种类:计划 或 种类:笔记)');
    assert.equal(await allPersonal(win), 2);
    await search(win, '种类:目标 -名称:补给检查01 补给检查');
    assert.equal(await allPersonal(win), 9);
    assert.equal(await win.locator('.search-result').filter({ hasText: '补给检查01' }).count(), 0);
    await search(win, '种类:物品 清灵丹');
    assert.equal(await win.locator('[data-action="search-personal-short"]').count(), 0);
    assert.equal(await win.locator('.search-result[data-action="search-goal"]').count(), 0);
    const item = win.locator('.search-result[data-action="database-detail"]').first();
    const itemId = await item.getAttribute('data-id');
    await item.click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#global-search').inputValue(), '种类:物品 清灵丹');
    assert.equal(await win.evaluate(() => document.activeElement.dataset.id), itemId);
    assert.equal(await win.locator('[data-action="search-personal-short"]').count(), 0);
    await search(win, '种类:目标 补给检查');
    await allPersonal(win);
    await search(win, '');
    assert.equal(await win.locator('[data-action="search-personal-short"]').count(), 0);
    assert.equal(await win.locator('.search-result[data-action="search-goal"]').count(), 8);
    const emptyCount = await allPersonal(win);
    assert(emptyCount > 10);
    assert.equal(await win.locator('.search-result[data-action="search-note"]').count(), 1);
    assert.equal(await win.locator('.search-result[data-action="craft-plan-open"]').count(), 2);
    await win.locator('.search-result[data-action="search-note"]').focus();
    await win.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            observer.disconnect();
            resolve();
          });
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(Error('foreground search results did not naturally refresh'));
          }, 12000);
          observer.observe(document.querySelector('#global-results'), { childList: true });
        }),
    );
    assert.equal(await win.locator('[data-action="search-personal-short"]').count(), 1);
    assert.equal(await win.evaluate(() => document.activeElement.dataset.action), 'search-note');
    assert((await win.locator('#global-results').evaluate((e) => e.scrollTop)) > 0);
    await win.locator('[data-action="search-personal-short"]').click();
    assert.equal(await win.locator('.search-result[data-action="search-goal"]').count(), 8);
    report.checks.push(
      'OR/negation filters, query changes, database detail return and empty-query continuation show no stale personal results',
    );

    await win.keyboard.press('Escape');
    const created = app.waitForEvent('window');
    await win.locator('.topbar [data-action="compact"]').click();
    const companion = await created;
    companion.on('pageerror', (e) => report.errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      const compact = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact'));
      compact.setContentSize(460, 660);
      compact.showInactive();
    });
    await search(companion, '种类:目标 补给检查');
    assert.equal(await companion.locator('.search-result').count(), 8);
    assert.equal(await allPersonal(companion), 10);
    await companion.locator('.search-result').filter({ hasText: '补给检查01' }).focus();
    await companion.keyboard.press('Enter');
    await companion.waitForFunction((id) => document.activeElement.dataset.id === id, goal01.id);
    assert.equal(await companion.locator('.goal-row.done').filter({ hasText: '补给检查01' }).count(), 1);
    await search(companion, '种类:目标 合成已完成计划目标');
    assert.equal(await allPersonal(companion), 1);
    await companion.keyboard.press('Enter');
    assert.equal(
      await companion.locator(`[data-action="goal-toggle"][data-id="${completedGoalId}"]`).isDisabled(),
      true,
    );
    await companion.waitForFunction((id) => document.activeElement.id === 'goal-' + id, completedGoalId);
    await goalReadability(companion, completedGoalId, 'compact');
    assert(
      (await companion.locator('#goal-' + completedGoalId + ' h3').evaluate((e) => e.clientWidth)) >= 140,
    );
    assert.equal(
      await companion
        .locator('#goal-' + completedGoalId)
        .evaluate((e) => e.matches(':focus-visible') && getComputedStyle(e).outlineStyle !== 'none'),
      true,
    );
    await search(companion, '种类:笔记 补给检查');
    assert.equal(await allPersonal(companion), 1);
    await companion.locator('.search-result').click();
    await companion.waitForFunction(() => document.activeElement.id === 'note');
    await companion.locator('#note').fill('补给检查小窗编辑随手记');
    await companion.waitForFunction(async () => {
      const current = await window.journal.bootstrap();
      return current.data.state.profiles[0].notes === '补给检查小窗编辑随手记';
    });
    assert.equal(await companion.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await companion.screenshot({ path: path.join(data, 'compact-note-editor.png') });
    await search(companion, '');
    await allPersonal(companion);
    await companion.locator('.search-result[data-action="search-note"]').focus();
    const beforeScroll = await companion.locator('#global-results').evaluate((e) => e.scrollTop);
    assert(beforeScroll > 0);
    const added = await win.evaluate(() => window.journal.mutate({ type: 'goal-add', title: '补给检查11' }));
    assert(added.ok, added.error);
    await companion.waitForFunction(
      (previous) => document.querySelectorAll('.search-result').length > previous,
      emptyCount,
    );
    assert.equal(await companion.locator('[data-action="search-personal-short"]').count(), 1);
    assert.equal(await companion.evaluate(() => document.activeElement.dataset.action), 'search-note');
    assert((await companion.locator('#global-results').evaluate((e) => e.scrollTop)) > 0);
    const otherProfile = await win.evaluate(() =>
      window.journal.mutate({ type: 'profile-add', name: '隔离搜索周目' }),
    );
    assert(otherProfile.ok, otherProfile.error);
    await companion.waitForFunction(() => !document.querySelector('#global-search'));
    await search(companion, '种类:目标 补给检查');
    assert.equal(await companion.locator('.search-result').count(), 0);
    assert.equal(await companion.locator('[data-action="search-personal-all"]').count(), 0);
    const restored = await win.evaluate(
      (id) => window.journal.mutate({ type: 'profile-switch', id }),
      firstProfile.id,
    );
    assert(restored.ok, restored.error);
    await companion.waitForFunction(() => !document.querySelector('#global-search'));
    await search(companion, '种类:目标 补给检查');
    assert.equal(await allPersonal(companion), 11);
    await search(companion, '品质:');
    await companion.keyboard.press('ArrowDown');
    const selectedSuggestion = await companion.locator('[role="option"][aria-selected="true"]').textContent();
    await companion.evaluate(() => {
      window.keyboardSearchState = new Promise((resolve) => {
        const stop = window.journal.onState(() => {
          stop();
          requestAnimationFrame(() =>
            resolve(document.querySelector('[role="option"][aria-selected="true"]')?.textContent),
          );
        });
      });
    });
    const changedSetting = await win.evaluate(() =>
      window.journal.mutate({ type: 'settings', value: { spoiler: 'details' } }),
    );
    assert(changedSetting.ok, changedSetting.error);
    assert.equal(await companion.evaluate(() => window.keyboardSearchState), selectedSuggestion);
    await companion.locator('#global-search').dispatchEvent('compositionstart');
    await companion.locator('#global-search').fill('品质:蓝');
    await companion.evaluate(() => {
      window.keyboardSearchState = new Promise((resolve) => {
        const stop = window.journal.onState(() => {
          stop();
          requestAnimationFrame(() =>
            resolve(document.querySelector('[role="option"][aria-selected="true"]')?.textContent),
          );
        });
      });
    });
    const restoredSetting = await win.evaluate(() =>
      window.journal.mutate({ type: 'settings', value: { spoiler: 'hints' } }),
    );
    assert(restoredSetting.ok, restoredSetting.error);
    assert.equal(await companion.evaluate(() => window.keyboardSearchState), selectedSuggestion);
    assert.equal(await companion.locator('#global-search').inputValue(), '品质:蓝');
    await companion.locator('#global-search').dispatchEvent('compositionend');
    assert.equal(await companion.locator('[role="option"][aria-selected="true"]').count(), 0);
    assert((await companion.locator('.search-result').count()) > 0);
    await companion.keyboard.press('Escape');
    report.checks.push(
      'compact window supports keyboard continuation; cross-window refresh preserves scope/focus/scroll, and profile switches close stale results',
    );
    report.checks.push(
      'background state refresh preserves the active filter suggestion and does not redraw during IME composition',
    );

    await win.locator('[data-action="profiles"]').first().click();
    await win.locator('#profile-name').fill('输入中测试');
    await win.locator('#profile-name').dispatchEvent('compositionstart');
    await win.keyboard.press('Control+k');
    assert.equal(await win.locator('#global-search').count(), 0);
    await win.locator('#profile-name').dispatchEvent('compositionend');
    await win.keyboard.press('Escape');
    report.checks.push('IME composition does not trigger search shortcut');
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-action="help"]').click();
    assert.ok((await win.locator('.help-copy').innerText()).includes('32 MB'));
    await win.keyboard.press('Escape');
    assert.deepEqual(report.externalRequests, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    report.finishedAt = new Date().toISOString();
    console.log('Keyboard/offline acceptance PASS:', report.checks.length, 'flows; no external requests');
  } catch (e) {
    report.passed = false;
    report.failure = e.message;
    report.windows = [];
    for (const [index, win] of (app?.windows() || []).entries()) {
      report.windows.push(
        await win
          .evaluate(() => ({
            url: location.href,
            active: document.activeElement.outerHTML.slice(0, 1000),
            overlay: document.querySelector('#overlay').innerText.slice(0, 1000),
            goalButtons: [...document.querySelectorAll('[data-action="goal-toggle"]')].map(
              (e) => e.dataset.id,
            ),
          }))
          .catch(() => null),
      );
      await win.screenshot({ path: path.join(data, 'failure-' + index + '.png') }).catch(() => {});
    }
    throw e;
  } finally {
    const reportFile = process.env.YIJIAN_KEYBOARD_EVIDENCE
      ? path.join(data, 'keyboard-offline-report.json')
      : path.join(base, 'test-results', 'keyboard-offline-report.json');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
