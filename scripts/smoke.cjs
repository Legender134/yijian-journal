'use strict';
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.join(__dirname, '..'),
  data = path.join(base, '.test-data', `smoke-${Date.now()}`),
  results = path.join(base, 'test-results');
fs.mkdirSync(results, { recursive: true });
fs.mkdirSync(data, { recursive: true });
const fakeSaves = path.join(data, 'fixture-SaveGames');
fs.mkdirSync(fakeSaves);
fs.writeFileSync(
  path.join(fakeSaves, '1.sav'),
  syntheticSave({
    full: true,
    inventory: [
      { id: 10226, count: 3 },
      { id: 10525, count: 2 },
      { id: 10529, count: 3 },
    ],
    quests: [
      { id: 5200, step: 1 },
      { id: 5201, step: 1 },
      { id: 11077, step: 1 },
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
      { id: 999999, step: 1 },
      { id: 11942, step: 4 },
      { id: 5535, step: 4 },
      { id: 5176, step: 4, finished: 1781822869 },
    ],
  }),
);
fs.writeFileSync(path.join(fakeSaves, 'JHSaveConfig.sav'), 'fake config');
fs.writeFileSync(
  path.join(fakeSaves, '2.sav'),
  syntheticSave({
    full: true,
    seconds: 7200,
    trackingMainQuest: 5780,
    trackingQuest: 11005,
    quests: [
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
      { id: 5780, step: 1 },
      { id: 5700, step: 4 },
    ],
  }),
);
fs.utimesSync(path.join(fakeSaves, '2.sav'), new Date('2025-01-01'), new Date('2025-01-01'));
new Store(data, catalog).setPath('savePath', fakeSaves);
const originalSave = fs.readFileSync(path.join(fakeSaves, '1.sav'));
const errors = [];
let app;
let savedWindowLayouts;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
    timeout: 30000,
  });
}
async function attach() {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.layout');
  return win;
}
async function revealAncestors(trigger) {
  await trigger.evaluate((node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
  });
}
async function navigatePage(page, route) {
  const compact = (await page.locator('.compact-shell').count()) > 0;
  await page
    .locator(
      compact
        ? `.companion-tabs [data-action="navigate"][data-id="${route}"]`
        : `.nav-btn[data-id="${route}"]`,
    )
    .click();
}
async function openProgressSettings(page) {
  const close = page.locator('#overlay [data-action="close-overlay"]');
  if (await close.count()) await close.first().click();
  if (await page.locator('.compact-shell').count()) {
    await page.locator('[data-action="companion-layout"]').first().click();
    await page.locator('[data-companion-layout] [data-action="navigate"][data-id="settings"]').click();
    await page.locator('[data-companion-layout]').waitFor({ state: 'detached' });
  } else await navigatePage(page, 'settings');
  await page.locator('[data-action="save-slot"]').waitFor();
}
async function assertProgressReference(page, value) {
  const selected = await page.evaluate(async () => {
    const { state, environment } = (await window.journal.bootstrap()).data;
    const profile = state.profiles.find((row) => row.id === state.activeProfileId);
    return { mode: profile.referenceMode, slot: profile.saveSlot, recent: environment.recent?.name || null };
  });
  assert.equal(selected.mode, value === '@none' ? 'none' : value === '@latest' ? 'latest' : 'slot');
  assert.equal(selected.slot, value.startsWith('@') ? '' : value);
  if (value === '@none') assert.equal(selected.recent, null);
  else if (value !== '@latest') assert.equal(selected.recent, value);
}
async function selectProgressReference(page, value, returnRoute = 'home') {
  await openProgressSettings(page);
  await page.locator('[data-action="save-slot"]').click();
  await page.locator('#save-slot-select').selectOption(value);
  await page.locator('[data-action="save-slot-save"]').click();
  await page.locator('#save-slot-select').waitFor({ state: 'detached' });
  await assertProgressReference(page, value);
  await navigatePage(page, returnRoute);
}
async function assertSharedProgressUi(page) {
  assert.equal(
    await page.locator('#person-save, #item-save, #recipe-save, #world-save, #craft-save').count(),
    0,
    'progress selection is centralized in Settings',
  );
}
async function refreshProgress(page, returnRoute = 'home') {
  await navigatePage(page, 'saves');
  await page.locator('[data-action="refresh"]').click();
  await navigatePage(page, returnRoute);
}
async function entityPreview(page, trigger, expected, name, throughRefresh = false) {
  await revealAncestors(trigger);
  const native = await app.browserWindow(page);
  await native.evaluate((win) => {
    win.show();
    win.focus();
  });
  await native.dispose();
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  // Start outside the entry so a native focus change cannot leave the pointer
  // stationary over an already dismissed tooltip trigger.
  await page.mouse.move(2, 2);
  // Keyboard focus keeps the preview intentional if the user's desktop pointer
  // moves during the polling check. Hover and transfer are checked below too.
  if (throughRefresh) await trigger.focus();
  const preview = page.locator('#entity-preview');
  const hoverEntry = async () => {
    // Native pointer events may arrive between automation commands. Retry only
    // the pointer gesture; persistent missing previews still fail the check.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.move(2, 2);
      await trigger.hover();
      try {
        await page.waitForFunction(
          (node) => node.isConnected && node.getAttribute('aria-describedby') === 'entity-preview',
          await trigger.elementHandle(),
          { timeout: 1500 },
        );
        await preview.waitFor({ state: 'visible', timeout: 1500 });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  };
  await hoverEntry();
  const previewText = await preview.innerText();
  assert.match(previewText, expected);
  assert.doesNotMatch(previewText, /\.sav\b|SHA-256|\bBuild \d+|(?:物品|任务|人物|场景)编号/);
  if (throughRefresh) {
    const entry = await trigger.elementHandle();
    const scrollContainer = page.locator('.content, .compact-body');
    const scroll = await scrollContainer.evaluate((el) => el.scrollTop);
    const windowEvents = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const events = [];
          const record = (event) => events.push(event.type);
          for (const type of ['focus', 'blur', 'resize']) window.addEventListener(type, record);
          setTimeout(() => {
            for (const type of ['focus', 'blur', 'resize']) window.removeEventListener(type, record);
            resolve(events);
          }, 5300);
        }),
    );
    assert.equal(
      await entry.evaluate((el) => el.isConnected),
      true,
      'unchanged polling retains the focused entry',
    );
    assert.equal(
      await preview.isVisible(),
      true,
      'preview survives the background refresh: ' +
        JSON.stringify({
          windowEvents,
          state: await entry.evaluate((el) => ({
            focused: document.hasFocus(),
            focusedEntry: document.activeElement === el,
            describedBy: el.getAttribute('aria-describedby'),
          })),
        }),
    );
    assert.equal(await scrollContainer.evaluate((el) => el.scrollTop), scroll);
    await entry.dispose();
  }
  const rect = await preview.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  assert(
    rect.x >= 0 && rect.y >= 0 && rect.right <= rect.width && rect.bottom <= rect.height,
    JSON.stringify(rect),
  );
  try {
    // Recheck stability and hit targeting instead of using an earlier rectangle.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await hoverEntry();
      await preview.hover({ position: { x: 15, y: 15 } });
      await page.waitForTimeout(220);
      if (await preview.isVisible()) break;
      assert(attempt < 2, 'preview stays open while moving into it');
    }
  } catch (error) {
    console.error(
      'Preview transfer diagnostics:',
      JSON.stringify({
        name,
        before: rect,
        after: await preview.evaluate((el) => ({
          hidden: el.hidden,
          bounds: el.getBoundingClientRect().toJSON(),
          focused: document.hasFocus(),
          activeEntity: document.activeElement?.dataset.entityId,
          hovered: [...document.querySelectorAll(':hover')].map((node) => ({
            tag: node.tagName,
            id: node.id,
            entity: node.dataset.entityId,
          })),
        })),
      }),
    );
    await page.screenshot({
      animations: 'disabled',
      path: path.join(results, name + '-transfer-failure.png'),
    });
    throw error;
  }
  await page.screenshot({ animations: 'disabled', path: path.join(results, name + '.png') });
  // Capture can yield to native window events; send Esc only to a visible preview.
  await hoverEntry();
  await preview.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await preview.isVisible(), false);
  await page.mouse.move(2, 2);
  await page.keyboard.press('Tab');
  await trigger.focus();
  await page.waitForFunction(
    (node) => document.activeElement === node && node.getAttribute('aria-describedby') === 'entity-preview',
    await trigger.elementHandle(),
  );
  await preview.waitFor({ state: 'visible' });
  assert.match(await preview.innerText(), expected);
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await preview.isVisible(), false);
}
async function taskMaterialReturn(page, title, screenshot) {
  await title.click();
  await page.locator('[data-task-relations]').waitFor();
  await page.mouse.move(440, 10);
  await page.locator('[data-action="close-overlay"]').focus();
  await page.locator('.drawer-body').evaluate((el) => (el.scrollTop = 0));
  const peopleSummary = page
    .locator('[data-task-relations] > details > summary')
    .filter({ hasText: /^涉及人物/ });
  assert.equal(await peopleSummary.locator('..').evaluate((element) => element.open), false);
  await peopleSummary.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const person = page.locator('[data-task-relations] [data-id="npc-10038"]').first();
  assert.equal(await person.evaluate((el) => document.activeElement === el), true);
  const focusedBounds = await person.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const viewport = el.closest('.drawer-body').getBoundingClientRect();
    return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
  });
  assert(focusedBounds, 'keyboard focus leaves the linked person visible');
  await page.locator('#entity-preview').waitFor({ state: 'visible' });
  assert.equal(await person.getAttribute('aria-describedby'), 'entity-preview');
  assert.match(await page.locator('#entity-preview').innerText(), /张樵夫/);
  await page.screenshot({ animations: 'disabled', path: path.join(results, screenshot + '-keyboard.png') });
  await page.keyboard.press('Escape');
  await page.locator('.drawer-body').evaluate((el) => (el.scrollTop += 10));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#entity-preview').isVisible(), false);
  await page
    .locator('[data-task-relations] > details > summary')
    .filter({ hasText: /^步骤需要的物品/ })
    .click();
  const material = page.locator('[data-task-relations] [data-id="item-10201"]').first();
  await page.mouse.move(440, 10);
  await material.scrollIntoViewIfNeeded();
  await material.focus();
  await page.waitForFunction(
    (node) => node.getAttribute('aria-describedby') === 'entity-preview',
    await material.elementHandle(),
  );
  await page.locator('#entity-preview').waitFor({ state: 'visible' });
  assert.equal(await material.getAttribute('aria-describedby'), 'entity-preview');
  const before = await page.locator('.drawer-body').evaluate((el) => ({
    scroll: el.scrollTop,
    details: [...el.querySelectorAll('details')].map((detail) => detail.open),
  }));
  await material.click();
  await page.locator('[data-item-statistics]').waitFor();
  assert.match(await page.locator('.drawer h1').innerText(), /铁矿石/);
  await page.locator('[data-action="drawer-back"]').click();
  await page.locator('[data-task-relations]').waitFor();
  const after = await page.locator('.drawer-body').evaluate((el) => ({
    scroll: el.scrollTop,
    details: [...el.querySelectorAll('details')].map((detail) => detail.open),
  }));
  assert.deepEqual(after.details, before.details);
  assert(Math.abs(after.scroll - before.scroll) <= 1, JSON.stringify({ before, after }));
  assert.equal(await material.evaluate((el) => document.activeElement === el), true);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#entity-preview').isVisible(), false);
  await page.screenshot({ animations: 'disabled', path: path.join(results, screenshot + '.png') });
  await page.locator('[data-action="close-overlay"]').click();
}
async function referenceFocusContinuity(page, trigger, surface) {
  await revealAncestors(trigger);
  const identity = await trigger.evaluate((el) => ({ action: el.dataset.action, id: el.dataset.entityId }));
  // Chromium may blur a disabled async opener before its IPC finishes.
  await trigger.evaluate((el) => {
    el.focus();
    el.click();
    el.blur();
  });
  await page.locator('#overlay .drawer').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#overlay .drawer').waitFor({ state: 'detached' });
  await page.waitForFunction(
    ({ action, id }) =>
      document.activeElement?.dataset.action === action && document.activeElement?.dataset.entityId === id,
    identity,
  );
  assert.equal(await page.locator('#entity-preview').isVisible(), false);
  const body = page.locator(surface === 'main' ? '.content' : '.compact-body');
  const scroll = await body.evaluate((el) => el.scrollTop);
  const old = await trigger.elementHandle();
  // An isolated state broadcast exercises the same redraw as a background update.
  await page.evaluate(() => window.journal.mutate({ type: 'settings', value: {} }));
  await page.waitForFunction((el) => !el.isConnected, old);
  await page.waitForFunction(
    ({ action, id }) =>
      document.activeElement?.dataset.action === action && document.activeElement?.dataset.entityId === id,
    identity,
  );
  await page.waitForTimeout(100);
  assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
  assert.equal(await body.evaluate((el) => el.scrollTop), scroll);
  assert.equal(await page.locator('#entity-preview').isVisible(), false);
  await page.screenshot({
    animations: 'disabled',
    path: path.join(results, '01-' + surface + '-reference-focus-update.png'),
  });
  await old.dispose();
}
async function privateItemConnections(page, surface) {
  await page.locator('[data-action="search"]').first().click();
  await page.locator('#global-search').fill('莫弃');
  for (const id of [5012, 5029]) {
    const result = page.locator('.search-result[data-id="npc-' + id + '"]');
    assert.match(await result.innerText(), /莫弃/);
    assert.doesNotMatch(await result.innerText(), new RegExp('#' + id));
  }
  await page.screenshot({
    animations: 'disabled',
    path: path.join(results, '01-' + surface + '-same-name-search.png'),
  });
  await page.locator('#global-search').fill('秦烈');
  const person = page.locator('.search-result[data-id="npc-10023"]');
  await entityPreview(page, person, /秦烈.*初始等级 35/s, '01-' + surface + '-private-person-preview', true);
  await person.click();
  const fixed = page.locator('[data-npc-private-items]');
  assert.equal(await fixed.evaluate((el) => el.open), false);
  await fixed.locator(':scope > summary').click();
  const formula = fixed.locator('[data-id="item-100312"]');
  await entityPreview(page, formula, /下品烈阳丹丹方/, '01-' + surface + '-private-formula-preview');
  const before = await page.locator('.drawer-body').evaluate((el) => el.scrollTop);
  await formula.click();
  assert.match(await page.locator('.drawer h1').innerText(), /下品烈阳丹丹方/);
  const holders = page.locator('[data-item-private-holders]');
  assert.equal(await holders.evaluate((el) => el.open), false);
  await holders.locator(':scope > summary').click();
  const qin = holders.locator('[data-id="npc-10023"]');
  await qin.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: 'disabled',
    path: path.join(results, '01-' + surface + '-private-holders.png'),
  });
  await qin.click();
  assert.match(await page.locator('[data-npc-template] > h3').innerText(), /35/);
  await page.locator('[data-action="drawer-back"]').click();
  assert.equal(await holders.evaluate((el) => el.open), true);
  await page.locator('[data-action="drawer-back"]').click();
  assert.equal(await fixed.evaluate((el) => el.open), true);
  assert(Math.abs((await page.locator('.drawer-body').evaluate((el) => el.scrollTop)) - before) <= 1);
  assert.equal(await formula.evaluate((el) => document.activeElement === el), true);
  await page.screenshot({
    animations: 'disabled',
    path: path.join(results, '01-' + surface + '-private-back.png'),
  });
  await page.locator('[data-action="close-overlay"]').click();
}
async function companionReferenceSync(page) {
  const file = path.join(fakeSaves, '2.sav'),
    original = fs.readFileSync(file),
    times = fs.statSync(file);
  const write = (count, step) =>
    fs.writeFileSync(
      file,
      syntheticSave({
        full: true,
        seconds: 7200,
        trackingMainQuest: 5780,
        trackingQuest: 11005,
        inventory: [{ id: 10201, count }],
        quests: [
          { id: 11002, step: 1 },
          { id: 11005, step: 1 },
          { id: 5780, step: 1 },
          { id: 5700, step: 4 },
          { id: 11010, step },
        ],
      }),
    );
  const open = async () => {
    await page.locator('[data-action="search"]').first().click();
    await page.locator('#global-search').fill('樵夫的斧子');
    await page.locator('.search-result[data-id="quest-11002"]').click();
    await page.locator('[data-task-relations]').waitFor();
  };
  const preview = async (count) => {
    const materialSummary = page
      .locator('[data-task-relations] > details:not([open]) > summary')
      .filter({ hasText: /^步骤需要的物品/ });
    if (await materialSummary.count()) await materialSummary.click();
    const item = page.locator('[data-task-relations] [data-id="item-10201"]').first();
    await item.scrollIntoViewIfNeeded();
    // Returning keeps focus and dismisses the preview; request a fresh focus event.
    await page.keyboard.press('Tab');
    await item.focus();
    await page.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.match(await page.locator('#entity-preview').innerText(), new RegExp('保存持有 ' + count));
    await page.keyboard.press('Escape');
    return item;
  };
  try {
    write(3, 1);
    await page.waitForTimeout(6300);
    await open();
    await preview(3);
    await page.locator('[data-action="close-overlay"]').click();
    write(9, 4);
    await page.waitForTimeout(6300);
    await open();
    const item = await preview(9);
    assert.match(await page.locator('[data-task-relations]').innerText(), /采矿.*需 4 件 已完成/s);
    await item.click();
    await page.locator('.item-usage').waitFor();
    write(12, 1);
    await page.waitForTimeout(6300);
    assert.match(await page.locator('.item-usage').innerText(), /持有\s*12/);
    await page.locator('[data-action="drawer-back"]').click();
    await preview(12);
    assert.match(await page.locator('[data-task-relations]').innerText(), /采矿.*需 4 件 进行中/s);
    await page.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-companion-reference-synchronized.png'),
    });
  } finally {
    const close = page.locator('[data-action="close-overlay"]');
    if (await close.count()) await close.first().click();
    fs.writeFileSync(file, original);
    fs.utimesSync(file, times.atime, times.mtime);
    await page.waitForTimeout(6300);
  }
}
async function guideAndSearchHandoff(main, compact) {
  const originalBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('compact=1'));
    const bounds = window.getBounds();
    window.setBounds({ ...bounds, width: 900, height: 600 });
    return bounds;
  });
  await compact.locator('.compact-title [data-action="search"]').click();
  await compact.locator('#global-search').fill('卫霍');
  await compact.locator('.search-result[data-action="detail"][data-id="wei-training"]').click();
  if (await compact.locator('[data-action="reveal"]').count())
    await compact.locator('[data-action="reveal"]').click();
  // Source and stage details are now collapsed; open them as a reader would
  // before checking that expanded content and scroll survive a window handoff.
  await compact.locator('.drawer details > summary').getByText('资料来源与参考阶段', { exact: true }).click();
  await compact.locator('.drawer-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  assert((await compact.locator('.drawer-body').evaluate((el) => el.scrollTop)) > 0);
  await compact.locator('.drawer [data-action="detail"][data-id="wei-huo"]').click();
  await compact.locator('.drawer [data-action="main"]').click();
  await main.locator('.drawer h1').getByText('卫霍', { exact: true }).waitFor();
  await main.locator('[data-action="drawer-back"]').click();
  await main.locator('.drawer h1').getByText('卫霍 · 砥砺精进', { exact: true }).waitFor();
  assert(
    await main
      .locator('.drawer details')
      .filter({ has: main.getByText('资料来源与参考阶段', { exact: true }) })
      .evaluate((el) => el.open),
  );
  assert((await main.locator('.drawer-body').evaluate((el) => el.scrollTop)) > 0);
  await main.screenshot({ animations: 'disabled', path: path.join(results, '01-guide-history-handoff.png') });
  await main.locator('[data-action="close-overlay"]').click();
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('compact=1'))
      .setBounds(bounds);
  }, originalBounds);
  await main.locator('[data-action="compact"]').first().click();
  await compact.locator('[data-action="close-overlay"]').click();
  const created = await compact.evaluate(async () => {
    for (let i = 1; i <= 9; i++) {
      const result = await window.journal.mutate({
        type: 'goal-add',
        title: '接续合成目标' + i,
        detail: '独立合成验收',
      });
      if (!result.ok) throw Error(result.error);
    }
    const state = (await window.journal.bootstrap()).data.state;
    return state.profiles
      .find((row) => row.id === state.activeProfileId)
      .goals.filter((row) => row.title.startsWith('接续合成目标'));
  });
  assert.equal(created.length, 9);
  await compact.locator('.compact-title [data-action="search"]').click();
  await compact.locator('#global-search').fill('接续合成目标');
  assert.equal(await compact.locator('.search-result[data-action="search-goal"]').count(), 8);
  await compact.locator('[data-action="search-personal-all"]').click();
  assert.equal(await compact.locator('.search-result[data-action="search-goal"]').count(), 9);
  await compact.locator('.search-modal [data-action="main"]').click();
  await main.locator('[data-action="search-personal-short"]').waitFor();
  assert.equal(await main.locator('.search-result[data-action="search-goal"]').count(), 9);
  await main.screenshot({
    animations: 'disabled',
    path: path.join(results, '01-all-personal-search-handoff.png'),
  });
  await main.locator('[data-action="close-overlay"]').click();
  await main.locator('[data-action="compact"]').first().click();
  await compact.locator('[data-action="close-overlay"]').click();
  for (const goal of created) {
    assert(
      (
        await compact.evaluate(
          (row) => window.journal.mutate({ type: 'goal-remove', id: row.id, expectedRecord: row }),
          goal,
        )
      ).ok,
    );
  }
}
async function companionHomeInventorySync(page) {
  const file = path.join(fakeSaves, '2.sav');
  const original = fs.readFileSync(file);
  const times = fs.statSync(file);
  const item = page
    .locator('[data-flow-decision="early-woodcutter-axe-choice"] .flow-material-brief [data-id="item-10201"]')
    .first();
  const preview = page.locator('#entity-preview');
  await page.bringToFront();
  try {
    for (const count of [0, 3, 9]) {
      if (count) {
        fs.writeFileSync(
          file,
          syntheticSave({
            full: true,
            seconds: 7200,
            trackingMainQuest: 5780,
            trackingQuest: 11005,
            inventory: [{ id: 10201, count }],
            quests: [
              { id: 11002, step: 1 },
              { id: 11005, step: 1 },
              { id: 5780, step: 1 },
              { id: 5700, step: 4 },
            ],
          }),
        );
        await page.waitForTimeout(6300);
      }
      const material = page
        .locator('[data-flow-decision="early-woodcutter-axe-choice"] .flow-material')
        .first();
      assert.match(
        await material.innerText(),
        new RegExp(`需 4 · 持有 ${count}${count < 4 ? ' · 缺 ' + (4 - count) : ''}`),
      );
      assert.match(await material.innerText(), /后山山洞.*铁匠/);
      assert.match(await page.locator('.flow-choice-location').first().textContent(), /梧桐村.*樵夫.*铁匠/);
      await item.focus();
      await preview.waitFor({ state: 'visible' });
      assert.match(await preview.innerText(), new RegExp('保存持有 ' + count));
      assert.equal(await page.locator('.drawer').count(), 0, 'home preview sync needs no detail navigation');
      await page.screenshot({
        animations: 'disabled',
        path: path.join(results, '01-companion-home-inventory-' + count + '.png'),
      });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
    }
  } finally {
    fs.writeFileSync(file, original);
    fs.utimesSync(file, times.atime, times.mtime);
    await page.waitForTimeout(6300);
  }
}
(async () => {
  try {
    app = await launch();
    let win = await attach();
    assert.equal(await win.locator('.start-actions').count(), 1);
    assert.equal(await win.locator('.start-panel').count(), 0);
    assert.equal(await win.locator('.start-actions button').count(), 1);
    assert.equal(await win.locator('[data-flow]').count(), 1);
    assert.match(await win.locator('[data-flow-unindexed]').innerText(), /1 条进行中记录待识别/);
    await win.locator('[data-flow-unindexed] summary').click();
    assert.doesNotMatch(await win.locator('[data-flow-unindexed]').innerText(), /#999999/);
    await win.locator('[data-flow-quest="quest-5200"]').waitFor();
    assert.match(
      await win.locator('[data-flow-quest="quest-5200"] .flow-next-action').first().innerText(),
      /武当|清虚/,
    );
    const flowProgress = win.locator('[data-flow-quest="quest-5200"] .flow-task-progress');
    await revealAncestors(flowProgress);
    assert.match(await flowProgress.locator('summary').innerText(), /进行中 1/);
    await flowProgress.locator('summary').click();
    assert.match(await flowProgress.innerText(), /求见清虚道长/);
    assert.match(await win.locator('[data-flow-quest="quest-5200"] h3').first().innerText(), /武当求助/);
    assert.equal(await win.locator('[data-flow-quest="quest-11077"] .flow-step h4').count(), 0);
    assert.match(
      await win.locator('[data-flow-quest="quest-11077"] .flow-next-action').innerText(),
      /下一步未识别.*查看游戏任务栏/,
    );
    const flowFirst = await win.evaluate(() => {
      const flow = document.querySelector('[data-flow]');
      const personal = document.querySelector('.home-journey, [data-home-itinerary]');
      return !personal || !!(flow.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(flowFirst, true, 'saved quest guidance must precede personal journey planning');
    const flowMaterials = win.locator('[data-flow-quest="quest-14073"] .flow-material-brief');
    await revealAncestors(flowMaterials);
    assert.match(await flowMaterials.innerText(), /茯苓.*川芎/s);
    await flowMaterials.locator('summary').first().click();
    assert.equal(await win.locator('.hero, .home-protection').count(), 0);
    await assertSharedProgressUi(win);
    const firstUse = await win.evaluate(async () => (await window.journal.bootstrap()).data);
    assert.equal(firstUse.state.settings.autoBackup, true);
    assert.equal(firstUse.state.profiles[0].referenceMode, 'latest');
    assert.equal(firstUse.environment.timeline.enabled, false);
    const deniedStart = await win.evaluate(() => window.journal.startAssistance());
    assert.equal(deniedStart.ok, false);
    assert.match(deniedStart.error, /测试环境/);
    let automatic;
    const automaticDeadline = Date.now() + 30000;
    do {
      automatic = (await win.evaluate(async () => (await window.journal.refresh()).data.backups)).find(
        (backup) => backup.kind === 'auto',
      );
      if (!automatic) await win.waitForTimeout(250);
    } while (!automatic && Date.now() < automaticDeadline);
    assert.ok(automatic);
    const healthy = (await win.evaluate(async () => (await window.journal.refresh()).data)).health;
    assert.equal(healthy.protection.ready, true);
    assert.equal(await win.locator('[data-save-health]').count(), 1);
    assert.equal(await win.locator('.save-health').count(), 0, 'healthy protection stays quiet');
    assert.deepEqual(fs.readFileSync(path.join(fakeSaves, '1.sav')), originalSave);
    assert.deepEqual(
      fs.readFileSync(path.join(data, 'save-backups', automatic.id, 'files', '1.sav')),
      originalSave,
    );
    // A background save refresh preserves reading state without navigating away.
    await revealAncestors(flowProgress);
    if (!(await flowProgress.evaluate((el) => el.open))) await flowProgress.locator('summary').click();
    const materialDetails = flowMaterials.locator('details').first();
    if (!(await materialDetails.evaluate((el) => el.open)))
      await materialDetails.locator(':scope > summary').click();
    assert.equal(await flowProgress.evaluate((el) => el.open), true);
    assert.equal(await materialDetails.evaluate((el) => el.open), true);
    const beforeFlowRefresh = await win.locator('[data-flow]').elementHandle();
    const beforeFlowDetails = await win
      .locator('details[data-persist-detail]')
      .evaluateAll((rows) =>
        rows.map((row) => [row.dataset.persistDetail, row.open, row.querySelector('summary')?.textContent]),
      );
    fs.utimesSync(path.join(fakeSaves, '1.sav'), new Date(), new Date());
    await win.waitForFunction((node) => !node.isConnected, beforeFlowRefresh);
    assert.equal(
      await flowProgress.evaluate((el) => el.open),
      true,
      JSON.stringify({
        before: beforeFlowDetails,
        after: await win
          .locator('details[data-persist-detail]')
          .evaluateAll((rows) =>
            rows.map((row) => [
              row.dataset.persistDetail,
              row.open,
              row.querySelector('summary')?.textContent,
            ]),
          ),
      }),
    );
    assert.equal(
      await flowMaterials
        .locator('details')
        .first()
        .evaluate((el) => el.open),
      true,
    );
    await win.screenshot({ animations: 'disabled', path: path.join(results, '01-home.png') });
    await entityPreview(
      win,
      win.locator('[data-flow] [data-id="npc-5003"]').first(),
      /人物.*清虚道长.*初始等级 80.*固定私物/s,
      '01-main-person-preview',
    );
    await entityPreview(
      win,
      win.locator('[data-flow-quest="quest-5200"] h3 [data-id="quest-5200"]'),
      /任务.*进行中/s,
      '01-main-task-preview',
    );
    await entityPreview(
      win,
      flowMaterials.locator('[data-action="database-detail"]').first(),
      /物品.*(?:保存持有|持有量未核对)/s,
      '01-main-item-preview',
      true,
    );
    await win.locator('[data-flow] [data-id="npc-5003"]').first().click();
    assert.equal(await win.locator('[data-person-relations]').isVisible(), true);
    await win
      .locator('[data-person-relations] > details > summary')
      .filter({ hasText: /^相关任务/ })
      .click();
    await win.locator('[data-person-relations] [data-id="quest-5200"]').first().click();
    assert.equal(await win.locator('[data-task-relations]').isVisible(), true);
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('[data-person-relations]').isVisible(), true);
    await win.locator('[data-action="close-overlay"]').click();
    await selectProgressReference(win, '2.sav');
    assert.equal(await win.evaluate(async () => (await window.journal.refresh()).data.recent.name), '2.sav');
    assert.equal(await win.locator('[data-action="save-slot"]').count(), 0);
    const currentChoice = win.locator('[data-flow-decision="early-woodcutter-axe-choice"]');
    assert.equal(await currentChoice.isVisible(), true);
    const mainChoiceDetails = currentChoice.locator('.flow-choice-details');
    assert.equal(await mainChoiceDetails.evaluate((el) => el.open), false);
    assert.match(await currentChoice.innerText(), /樵夫.*重锻/);
    assert.doesNotMatch(await currentChoice.innerText(), /700.*2000|为什么：|取舍：/s);
    await mainChoiceDetails.locator(':scope > summary').click();
    assert.match(await currentChoice.innerText(), /700.*2000/s);
    assert.match(
      await currentChoice.locator('.flow-recommendation').innerText(),
      /推荐做法.*重新锻造.*为什么.*亮银甲.*取舍.*武学笔记/s,
    );
    assert.equal(
      await currentChoice.locator('.flow-recommendation').evaluate((el) => !!el.closest('details')),
      true,
    );
    assert.equal(
      await currentChoice.locator('.flow-choices').evaluate((el) => !!el.closest('details')),
      true,
    );
    const armorChoice = currentChoice.locator('.flow-recommendation [data-id="name:亮银甲"]').first();
    await entityPreview(win, armorChoice, /同名资料.*条同名资料/s, '01-same-name-preview');
    await armorChoice.hover();
    await win.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.equal(await win.locator('.entity-preview-heading small').innerText(), '同名资料');
    await armorChoice.click();
    await win.locator('[aria-label="选择同名资料"]').waitFor();
    await win.locator('[aria-label="选择同名资料"] [data-id="item-9004"]').click();
    await win.locator('[data-item-statistics]').waitFor();
    await assertProgressReference(win, '2.sav');
    await assertSharedProgressUi(win);
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[aria-label="选择同名资料"]').waitFor();
    await win.locator('[data-action="close-overlay"]').click();
    await taskMaterialReturn(
      win,
      win.locator('[data-flow-quest="quest-11002"] h3 [data-id="quest-11002"]'),
      '01-main-task-return',
    );
    await referenceFocusContinuity(
      win,
      win.locator('[data-flow-quest="quest-11002"] h3 [data-id="quest-11002"]'),
      'main',
    );
    await privateItemConnections(win, 'main');
    const choiceWindowReady = app.waitForEvent('window');
    await win.locator('[data-action="compact"]').first().click();
    const choiceCompact = await choiceWindowReady;
    await choiceCompact.waitForSelector('.compact-shell');
    await choiceCompact.locator('[data-action="companion-layout"]').click();
    await choiceCompact.locator('[data-companion-layout] [data-id="materials"]').click();
    const taskMaterialText = (
      await choiceCompact.locator('[data-flow-task-materials] .flow-material').first().textContent()
    ).replace(/\s+/g, '');
    await choiceCompact.locator('[data-action="main"]').first().click();
    await win.locator('[data-flow-task-materials]').waitFor();
    assert.equal(
      (await win.locator('[data-flow-task-materials] .flow-material').first().textContent()).replace(
        /\s+/g,
        '',
      ),
      taskMaterialText,
    );
    await win.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-task-materials-handoff.png'),
    });
    await win.locator('[data-action="compact"]').first().click();
    await choiceCompact.locator('.companion-tabs [data-id="home"]').click();
    await choiceCompact.locator('[data-action="main"]').first().click();
    await win.locator('.flow-panel:not(.flow-summary)').waitFor();
    assert.equal(await win.locator('.nav-btn.active').getAttribute('data-id'), 'checklist');
    await win.locator('[data-action="compact"]').first().click();
    await choiceCompact.locator('.companion-tabs [data-id="duels"]').click();
    const sourceDuel = choiceCompact.locator('[data-duel-current] > [data-duel]').last();
    await sourceDuel.waitFor();
    const duelId = await sourceDuel.getAttribute('data-duel');
    await sourceDuel.evaluate((el) => {
      el.open = true;
      el.querySelector('[data-persist-detail^="duel-readiness-"]').open = true;
      el.scrollIntoView({ block: 'start' });
    });
    await choiceCompact.locator('[data-action="main"]').first().click();
    const targetDuel = win.locator(`[data-duel="${duelId}"]`);
    await targetDuel.waitFor();
    assert.equal(
      await targetDuel.locator('[data-persist-detail^="duel-readiness-"]').evaluate((el) => el.open),
      true,
    );
    const targetDuelPosition = await targetDuel.evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      viewport: innerHeight,
    }));
    assert(
      targetDuelPosition.top < targetDuelPosition.viewport && targetDuelPosition.bottom > 0,
      JSON.stringify(targetDuelPosition),
    );
    await win.screenshot({ animations: 'disabled', path: path.join(results, '01-duel-reading-handoff.png') });
    await win.locator('[data-action="compact"]').first().click();
    assert.equal(await sourceDuel.evaluate((el) => el.open), true);
    await choiceCompact.locator('.companion-tabs [data-id="home"]').click();
    await revealAncestors(
      choiceCompact
        .locator('[data-flow-decision="early-woodcutter-axe-choice"] [data-id="name:亮银甲"]')
        .first(),
    );
    await choiceCompact
      .locator('[data-flow-decision="early-woodcutter-axe-choice"] [data-id="name:亮银甲"]')
      .first()
      .click();
    await choiceCompact.locator('[aria-label="选择同名资料"]').waitFor();
    await choiceCompact.locator('.drawer [data-action="main"]').click();
    await win.locator('[aria-label="选择同名资料"]').waitFor();
    assert.equal(await win.locator('.entity-relation-row').count(), 3);
    await win.locator('[data-action="close-overlay"]').first().click();
    await win.locator('[data-action="compact"]').first().click();
    await choiceCompact.locator('[aria-label="选择同名资料"]').waitFor();
    await choiceCompact.locator('.entity-relation-row [data-action="database-detail"]').first().click();
    await choiceCompact.locator('.drawer [data-action="main"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[aria-label="选择同名资料"]').waitFor();
    assert.equal(await win.locator('.entity-relation-row').count(), 3);
    await win.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-same-name-history-handoff.png'),
    });
    await win.locator('.entity-relation-row [data-action="database-detail"]').nth(1).click();
    await win.locator('.drawer h1').waitFor();
    await win.locator('[data-action="close-overlay"]').first().click();
    await win.locator('[data-action="compact"]').first().click();
    await choiceCompact.locator('[data-action="close-overlay"]').first().click();
    await selectProgressReference(choiceCompact, '@none');
    await choiceCompact.locator('.compact-title [data-action="search"]').click();
    await choiceCompact.locator('#global-search').fill('清虚道长');
    await choiceCompact.locator('.search-result[data-id="npc-5003"]').click();
    await assertSharedProgressUi(choiceCompact);
    if (await choiceCompact.locator('.person-gifts:not([open])').count())
      await choiceCompact.locator('.person-gifts > summary').click();
    await choiceCompact.locator('[data-action="gift-page"][data-id="1"]').click();
    await choiceCompact.locator('[data-action="gift-page"][data-id="2"]').click();
    await choiceCompact
      .locator('.person-gifts .history-pagination')
      .getByText('共 69 种 · 第 3 / 3 页')
      .waitFor();
    await choiceCompact.locator('.drawer [data-action="main"]').click();
    await win.locator('.person-gifts .history-pagination').getByText('共 69 种 · 第 3 / 3 页').waitFor();
    await win.screenshot({ animations: 'disabled', path: path.join(results, '01-gift-page-handoff.png') });
    await win.locator('[data-action="close-overlay"]').first().click();
    await win.locator('[data-action="compact"]').first().click();
    await choiceCompact.locator('[data-action="close-overlay"]').first().click();
    await guideAndSearchHandoff(win, choiceCompact);
    await choiceCompact.locator('.compact-title [data-action="search"]').click();
    await choiceCompact.locator('#global-search').fill('金疮药');
    await choiceCompact.locator('.search-modal [data-action="main"]').click();
    await win.locator('#global-search').waitFor();
    assert.equal(await win.locator('#global-search').inputValue(), '金疮药');
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="compact"]').first().click();
    assert.equal(await choiceCompact.locator('#global-search').inputValue(), '金疮药');
    await choiceCompact.locator('[data-action="database-detail"][data-id="item-133"]').first().click();
    await choiceCompact.locator('.drawer h1').getByText('金疮药').waitFor();
    const readingFold = choiceCompact.locator('.drawer-body details').first();
    await readingFold.evaluate((el) => {
      el.open = true;
    });
    const readingSummary = await readingFold.locator('summary').first().textContent();
    await choiceCompact.locator('.drawer-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await choiceCompact.locator('.drawer [data-action="main"]').click();
    await win.locator('.drawer h1').getByText('金疮药').waitFor();
    assert.equal(
      await win
        .locator('.drawer-body details')
        .first()
        .evaluate((el) => el.open),
      true,
    );
    assert.equal(
      await win.locator('.drawer-body details').first().locator('summary').first().textContent(),
      readingSummary,
    );
    assert.equal(await win.locator('[data-action="drawer-back"]').count(), 1);
    assert.equal(await choiceCompact.locator('#handbook-hint .hint-shell').count(), 1);
    assert.equal(
      await choiceCompact.locator('#app').isVisible(),
      false,
      'explicit handoff collapses the companion while preserving its reading DOM',
    );
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#global-search').inputValue(), '金疮药');
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="compact"]').first().click();
    await choiceCompact.locator('.drawer h1').getByText('金疮药').waitFor();
    assert.equal(await choiceCompact.locator('#handbook-hint').count(), 0);
    await choiceCompact.locator('[data-action="close-overlay"]').click();
    for (const sourceReference of ['1.sav', '@none']) {
      await selectProgressReference(choiceCompact, sourceReference);
      await choiceCompact.locator('.compact-title [data-action="search"]').click();
      await choiceCompact.locator('#global-search').fill('水煮鱼');
      await choiceCompact.locator('[data-action="database-detail"][data-id="cooking-102"]').first().click();
      await assertSharedProgressUi(choiceCompact);
      await assertProgressReference(choiceCompact, sourceReference);
      await choiceCompact.locator('#recipe-quantity').fill('3');
      await choiceCompact.locator('#recipe-materials [data-action="database-detail"]').first().click();
      await choiceCompact.locator('.item-usage').waitFor();
      const stock = choiceCompact.locator('.item-usage .detail-stat-grid > div').first().locator('strong');
      if (sourceReference === '@none') assert.equal(await stock.innerText(), '—');
      else assert.match(await stock.innerText(), /^\d[\d,]*$/);
      await choiceCompact.locator('.drawer [data-action="main"]').click();
      await win.locator('.item-usage').waitFor();
      assert.equal(
        await win.locator('.item-usage .detail-stat-grid > div').first().locator('strong').innerText(),
        await stock.innerText(),
      );
      await assertProgressReference(win, sourceReference);
      await win.locator('[data-action="drawer-back"]').click();
      await win.locator('#recipe-quantity').waitFor();
      await assertSharedProgressUi(win);
      assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
      await win.locator('[data-action="close-overlay"]').first().click();
      await win.locator('[data-action="compact"]').first().click();
      await choiceCompact.locator('.item-usage').waitFor();
      await choiceCompact.locator('[data-action="close-overlay"]').first().click();
    }
    await selectProgressReference(choiceCompact, '2.sav');
    await choiceCompact.locator('[data-flow-decision="early-woodcutter-axe-choice"]').waitFor();
    await companionHomeInventorySync(choiceCompact);
    await entityPreview(
      choiceCompact,
      choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]'),
      /任务.*下一步：替樵夫决定是否要买新斧子/s,
      '01-companion-task-preview',
    );
    await entityPreview(
      choiceCompact,
      choiceCompact
        .locator(
          '[data-flow-decision="early-woodcutter-axe-choice"] .flow-material-brief [data-id="item-10201"]',
        )
        .first(),
      /物品.*铁矿石.*保存持有/s,
      '01-companion-item-preview',
    );
    await revealAncestors(choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]'));
    await choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]').click();
    await choiceCompact.locator('[data-task-relations]').waitFor();
    await entityPreview(
      choiceCompact,
      choiceCompact
        .locator('[data-task-relations] [data-action="database-detail"][data-id="npc-10005"]')
        .first(),
      /人物.*铁匠/s,
      '01-companion-person-preview',
    );
    await choiceCompact.locator('[data-action="close-overlay"]').click();
    await choiceCompact.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 0;
    });
    await taskMaterialReturn(
      choiceCompact,
      choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]'),
      '01-companion-task-return',
    );
    await referenceFocusContinuity(
      choiceCompact,
      choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]'),
      'companion',
    );
    await privateItemConnections(choiceCompact, 'companion');
    await companionReferenceSync(choiceCompact);
    assert(
      (
        await choiceCompact.evaluate(() =>
          window.journal.mutate({ type: 'craft-set', id: 'cooking-102', quantity: 1 }),
        )
      ).ok,
    );
    await choiceCompact.locator('details.flow-personal > summary').click();
    const alternatives = choiceCompact.locator('.companion-material details[data-compact-detail]').first();
    await alternatives.locator(':scope > summary').click();
    const alternativeKey = await alternatives.getAttribute('data-compact-detail');
    const materialsBeforeUpdate = await alternatives.elementHandle();
    assert(
      (
        await choiceCompact.evaluate(() =>
          window.journal.mutate({ type: 'craft-set', id: 'cooking-102', quantity: 2 }),
        )
      ).ok,
    );
    await choiceCompact.waitForFunction((el) => !el.isConnected, materialsBeforeUpdate);
    const sameAlternatives = choiceCompact.locator(
      `.companion-material details[data-compact-detail="${alternativeKey}"]`,
    );
    await sameAlternatives.waitFor();
    assert.equal(await sameAlternatives.evaluate((el) => el.open), true);
    assert.equal(await sameAlternatives.locator('[data-action="database-detail"]').count(), 5);
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-companion-material-alternatives.png'),
    });
    await materialsBeforeUpdate.dispose();
    assert(
      (await choiceCompact.evaluate(() => window.journal.mutate({ type: 'craft-remove', id: 'cooking-102' })))
        .ok,
    );
    await choiceCompact
      .locator('.companion-material details[data-compact-detail]')
      .waitFor({ state: 'detached' });
    await choiceCompact.locator('details.flow-personal > summary').click();
    await choiceCompact.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 0;
    });
    await choiceCompact.locator('.flow-choice-details').evaluate((el) => {
      el.open = false;
    });
    const compactRisk = choiceCompact.locator('.flow-compact-risks');
    assert.equal(await compactRisk.evaluate((el) => el.open), true);
    const currentPosition = await choiceCompact
      .locator('[data-flow-decision="early-woodcutter-axe-choice"] > .flow-recommended-action')
      .evaluate((el) => ({
        top: el.getBoundingClientRect().top,
        bottom: el.getBoundingClientRect().bottom,
        viewport: innerHeight,
      }));
    assert(
      currentPosition.top >= 0 && currentPosition.bottom <= currentPosition.viewport,
      JSON.stringify(currentPosition),
    );
    assert.equal(
      await choiceCompact.locator('.flow-current-decisions').evaluate((el) => !!el.closest('details')),
      false,
    );
    assert.equal(
      await choiceCompact
        .locator('.flow-current-decisions')
        .evaluate(
          (el) =>
            el.compareDocumentPosition(document.querySelector('.flow-risks')) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      4,
    );
    assert.match(await compactRisk.locator('summary').first().innerText(), /推进前确认.*7 项/);
    assert.equal(await choiceCompact.locator('.companion-reference').count(), 0);
    assert.equal(await choiceCompact.locator('.flow-compact-reference').count(), 0);
    assert.equal(await choiceCompact.locator('.flow-current-brief').count(), 0);
    await choiceCompact.locator('.flow-task-peek').evaluate((el) => {
      el.open = false;
    });
    // Earlier reading checks deliberately open disclosures. Measure the default
    // first screen with the individual risk explanations folded again.
    await compactRisk.locator('.flow-risk-window').evaluateAll((windows) => {
      for (const window of windows) window.open = false;
    });
    assert.equal(
      await choiceCompact.locator('[data-flow-now] > .flow-next-action').isVisible(),
      false,
      'the game task description is folded when a decision already gives the next action',
    );
    const compactNative = await app.browserWindow(choiceCompact);
    const compactBounds = await compactNative.evaluate((win) => win.getBounds());
    for (const width of [360, 460]) {
      await compactNative.evaluate((win, width) => win.setSize(width, 640), width);
      await choiceCompact.locator('.compact-body').evaluate((el) => {
        el.scrollTop = 0;
      });
      await choiceCompact.waitForTimeout(150);
      const density = await choiceCompact.evaluate(() => {
        const card = document.querySelector('.flow-current-decisions').getBoundingClientRect();
        const risk = document.querySelector('.flow-risks').getBoundingClientRect();
        return {
          cardHeight: card.height,
          riskBottom: risk.bottom,
          bodyBottom: document.querySelector('.compact-body').getBoundingClientRect().bottom,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert(density.cardHeight < 220, JSON.stringify({ width, ...density }));
      assert(density.riskBottom < density.bodyBottom, JSON.stringify({ width, ...density }));
      assert.equal(density.overflow, false);
      await choiceCompact.screenshot({
        animations: 'disabled',
        path: path.join(results, `01-compact-width-${width}.png`),
      });
    }
    await compactNative.evaluate((win, bounds) => win.setBounds(bounds), compactBounds);
    await compactNative.dispose();
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-first-screen.png'),
    });
    const compactChoiceDetails = choiceCompact.locator('.flow-choice-details');
    await compactChoiceDetails.locator(':scope > summary').click();
    assert.match(await compactChoiceDetails.innerText(), /700.*2000/s);
    await compactChoiceDetails.locator(':scope > summary').click();
    await compactRisk.locator('.flow-risk-window > summary').first().click();
    assert.equal(await compactRisk.locator('.flow-risk').first().isVisible(), true);
    await compactRisk.locator('summary').first().click();
    await choiceCompact.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 0;
    });
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-current-choice.png'),
    });
    await choiceCompact.locator('[data-action="companion-layout"]').click();
    await choiceCompact.locator('[data-action="companion-display"]').click();
    for (const key of ['advice', 'opportunities', 'milestones'])
      await choiceCompact.locator('#companion-section-' + key).uncheck();
    await choiceCompact.locator('[data-action="companion-display-save"]').click();
    assert.deepEqual(
      await choiceCompact.evaluate(
        async () => (await window.journal.bootstrap()).data.state.settings.companionSections,
      ),
      [],
    );
    assert.equal(await choiceCompact.locator('.flow-opportunities, .flow-stage-details').count(), 0);
    assert.equal(await choiceCompact.locator('[data-flow-now]').count(), 1);
    assert.equal(await choiceCompact.locator('.flow-current-decisions').count(), 1);
    await choiceCompact.locator('[data-action="companion-layout"]').click();
    await choiceCompact.locator('[data-action="companion-display"]').click();
    for (const key of ['advice', 'opportunities', 'milestones']) {
      assert.equal(await choiceCompact.locator('#companion-section-' + key).isChecked(), false);
      await choiceCompact.locator('#companion-section-' + key).check();
    }
    await choiceCompact.locator('[data-action="companion-display-save"]').click();
    const beforeNpcProbe = fs.readFileSync(path.join(fakeSaves, '2.sav'));
    const newSlot = path.join(fakeSaves, '3.sav');
    fs.writeFileSync(
      newSlot,
      syntheticSave({ full: true, trackingMainQuest: 5062, quests: [{ id: 5062, step: 1 }] }),
    );
    await openProgressSettings(choiceCompact);
    await choiceCompact.locator('[data-action="save-slot"]').click();
    assert.equal(await choiceCompact.locator('#save-slot-select option[value="3.sav"]').count(), 1);
    assert.equal(await choiceCompact.locator('#save-slot-select').inputValue(), '2.sav');
    await choiceCompact.locator('[data-action="close-overlay"]').first().click();
    fs.unlinkSync(newSlot);
    await choiceCompact.locator('[data-action="save-slot"]').click();
    assert.equal(await choiceCompact.locator('#save-slot-select option[value="3.sav"]').count(), 0);
    await choiceCompact.locator('[data-action="close-overlay"]').first().click();
    fs.writeFileSync(newSlot, 'synthetic unreadable slot');
    await choiceCompact.locator('[data-action="save-slot"]').click();
    assert.equal(await choiceCompact.locator('#save-slot-select option[value="3.sav"]').count(), 0);
    await choiceCompact.locator('[data-action="close-overlay"]').first().click();
    fs.unlinkSync(newSlot);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="duels"]').click();
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 5062,
        quests: [
          { id: 5062, step: 1 },
          { id: 5063, step: 4 },
          { id: 5072, step: 1 },
        ],
      }),
    );
    const innChallenge = choiceCompact.locator('[data-duel-current] [data-duel="npc051-inn-lei"]');
    await innChallenge.waitFor({ timeout: 18000 });
    assert.match(await innChallenge.innerText(), /初始等级 30.*梧桐村.*客栈.*七品拳套图纸/s);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="home"]').click();
    await choiceCompact.locator('.flow-risks').waitFor();
    await choiceCompact.locator('.flow-compact-risks').evaluate((el) => {
      el.open = true;
    });
    assert.match(await choiceCompact.locator('.flow-risks').textContent(), /吕轻祈.*雷万钧.*岳九/);
    await choiceCompact.locator('.compact-body').evaluate((body) => {
      body.scrollTop = 1800;
    });
    const canScroll = await choiceCompact
      .locator('.compact-body')
      .evaluate((body) => body.scrollHeight > body.clientHeight);
    if (canScroll)
      assert((await choiceCompact.locator('.compact-body').evaluate((body) => body.scrollTop)) > 0);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="duels"]').click();
    assert.equal(await choiceCompact.locator('.compact-body').evaluate((body) => body.scrollTop), 0);
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-duels.png'),
    });
    await innChallenge.locator(':scope > summary').click();
    assert.match(await innChallenge.innerText(), /到场核对.*已穿装备/s);
    await innChallenge.locator('[data-persist-detail^="duel-info-"] > summary').click();
    assert.match(await innChallenge.innerText(), /攻略参考.*2932/s);
    await innChallenge.locator('[data-persist-detail^="duel-readiness-"] > summary').click();
    assert.match(await innChallenge.innerText(), /气血 · 待核对.*防具 · 待核对/s);
    await innChallenge.locator('[data-persist-detail^="duel-skills-"] > summary').click();
    assert.match(await innChallenge.innerText(), /初始招式.*连山掌法/s);
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 5062,
        quests: [
          { id: 5062, step: 1 },
          { id: 5072, step: 1 },
        ],
      }),
    );
    await choiceCompact.waitForFunction(
      () =>
        document
          .querySelector('[data-duel-current] [data-duel="npc051-inn-lei"]')
          ?.textContent.includes('前置待核对'),
      null,
      { timeout: 18000 },
    );
    assert.equal(await innChallenge.evaluate((el) => el.open), true);
    for (const kind of ['duel-info-', 'duel-readiness-', 'duel-skills-'])
      assert.equal(
        await innChallenge.locator(`[data-persist-detail^="${kind}"]`).evaluate((el) => el.open),
        true,
      );
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 5062,
        quests: [
          { id: 5062, step: 1 },
          { id: 5063, step: 4 },
          { id: 5072, step: 4 },
        ],
      }),
    );
    await innChallenge.waitFor({ state: 'detached', timeout: 18000 });
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({ full: true, trackingMainQuest: 5200, quests: [{ id: 5200, step: 1 }] }),
    );
    const baiChallenge = choiceCompact.locator('[data-duel-current] [data-duel="npc051-baijin"]');
    await baiChallenge.waitFor({ timeout: 18000 });
    assert.equal(await baiChallenge.evaluate((el) => el.open), false);
    const rewardPreview = baiChallenge.locator(':scope > summary .duel-reward-preview');
    const baiReward = rewardPreview.locator('[data-entity-id="item-13552"]');
    assert.equal(await baiReward.count(), 1);
    assert.equal(await baiReward.locator('.game-picture').count(), 1);
    assert.match(await rewardPreview.innerText(), /无影飞箭秘籍.*切磋私物.*八品暗器图纸/s);
    assert.equal(await rewardPreview.locator('[data-entity-id]').count(), 1);
    await baiReward.hover();
    await choiceCompact.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.match(await choiceCompact.locator('#entity-preview').innerText(), /无影飞箭/);
    await choiceCompact.keyboard.press('Escape');
    await choiceCompact.mouse.move(0, 0);
    await baiChallenge.locator(':scope > summary').focus();
    await baiReward.focus();
    await choiceCompact.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.equal(await baiReward.getAttribute('aria-describedby'), 'entity-preview');
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-duel-reward-preview.png'),
    });
    await baiReward.click();
    await choiceCompact.locator('.drawer h1').filter({ hasText: '无影飞箭' }).waitFor();
    assert.equal(await baiChallenge.evaluate((el) => el.open), false);
    await choiceCompact.keyboard.press('Escape');
    await choiceCompact.waitForFunction(() => document.activeElement?.dataset.entityId === 'item-13552');
    assert.equal(await baiChallenge.evaluate((el) => el.open), false);
    assert.equal(await choiceCompact.locator('#entity-preview').isVisible(), false);
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 5780,
        quests: [
          { id: 5780, step: 1 },
          { id: 5789, step: 4 },
          { id: 5790, step: 1 },
          { id: 5803, step: 0 },
        ],
      }),
    );
    const tianshuiChallenge = choiceCompact.locator('[data-duel-current] [data-duel="npc052-zhidu"]');
    await tianshuiChallenge.waitFor({ timeout: 18000 });
    assert.match(await tianshuiChallenge.innerText(), /智度上人.*三转洗髓丹.*没药/s);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="home"]').click();
    await choiceCompact.waitForFunction(
      () => document.querySelector('.flow-risks')?.textContent.includes('智度上人'),
      null,
      { timeout: 18000 },
    );
    assert.doesNotMatch(await choiceCompact.locator('.flow-risks').textContent(), /吕轻祈/);
    for (const scenario of [
      {
        id: 'early-jingyin-weapon-choice',
        root: 5074,
        anchor: 5076,
        anchorStep: 1,
        exit: 5087,
        exitStep: 1,
        expected: /普通新档.*剑系武器.*为什么.*惊雷剑法/s,
      },
      {
        id: 'chengyu-stay-choice',
        root: 5820,
        anchor: 5821,
        anchorStep: 4,
        exit: 5827,
        exitStep: 4,
        expected: /赞成留下程钰.*为什么.*一气纯阳指/s,
      },
      {
        id: 'mowen-thankyou-gift-choice',
        root: 12400,
        anchor: 12404,
        anchorStep: 1,
        exit: 12407,
        exitStep: 1,
        expected: /棋盘.*陆博枭.*为什么.*20.*10/s,
      },
      {
        id: 'yanfu-investigation-choice',
        root: 21050,
        main: 20000,
        anchor: 21123,
        anchorStep: 4,
        exit: 21148,
        exitStep: 1,
        expected: /继续调查.*为什么.*查明真相.*放弃.*结束/s,
      },
      {
        id: 'bai-jin-rescue-route',
        root: 12030,
        main: 5700,
        anchor: 12035,
        anchorStep: 1,
        exit: 12037,
        exitStep: 1,
        expected: /临昌.*白锦.*救人.*为什么.*危机解除.*天罗地网钉/s,
        detailsExpected: /霹雳雷火弹.*绝笔.*不能.*兼得.*白锦身亡/s,
      },
      {
        id: 'cold-wuqing-night-choice',
        root: 22100,
        anchor: 22125,
        anchorStep: 4,
        exit: 22133,
        exitStep: 4,
        expected: /矢志于此.*阎浮镇凶案.*为什么.*隐藏结局/s,
        detailsExpected: /好感100.*不保证.*江湖器量.*完整结局后果尚未核定/s,
      },
    ]) {
      const records = [
        { id: scenario.root, step: 1 },
        { id: scenario.anchor, step: scenario.anchorStep },
        ...(scenario.main ? [{ id: scenario.main, step: 1 }] : []),
      ];
      const writeChoice = (quests) =>
        fs.writeFileSync(
          path.join(fakeSaves, '2.sav'),
          syntheticSave({
            full: true,
            trackingMainQuest: scenario.main || scenario.root,
            trackingQuest: scenario.anchor,
            quests,
          }),
        );
      writeChoice(records);
      const card = choiceCompact.locator(`[data-flow-decision="${scenario.id}"]`);
      await card.waitFor({ timeout: 18000 });
      await card.locator('.flow-choice-details > summary').click();
      assert.match(
        (await card.locator('.flow-recommendation').innerText()).replace(/\s+/g, ''),
        scenario.expected,
      );
      await card.locator('.flow-choice-details > summary').click();
      const position = await card.locator(':scope > .flow-recommended-action').evaluate((el) => ({
        bottom: el.getBoundingClientRect().bottom,
        height: innerHeight,
        folded: !!el.closest('details'),
      }));
      assert.equal(position.folded, false);
      assert(position.bottom <= position.height, scenario.id + ' recommendation stays on the first screen');
      await choiceCompact.screenshot({
        animations: 'disabled',
        path: path.join(results, `01-${scenario.id}.png`),
      });
      if (scenario.detailsExpected) {
        await card.locator('.flow-choice-details > summary').click();
        assert.match((await card.innerText()).replace(/\s+/g, ''), scenario.detailsExpected);
        await card.locator('.flow-choice-details > summary').click();
      }
      if (scenario.id === 'mowen-thankyou-gift-choice') {
        await revealAncestors(choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-12400"]'));
        await choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-12400"]').click();
        const relations = choiceCompact.locator('[data-task-relations]');
        await relations.waitFor();
        await relations
          .locator(':scope > details')
          .filter({ has: choiceCompact.locator('.entity-related-advice') })
          .locator(':scope > summary')
          .click();
        const advice = relations.locator('.entity-related-advice').filter({ hasText: '莫问' }).first();
        await advice.locator(':scope > summary').click();
        const sword = advice.getByRole('button', { name: '白光剑', exact: true });
        await entityPreview(choiceCompact, sword, /白光剑.*条同名资料/s, '01-codex-advice-preview');
        const scroll = await choiceCompact.locator('.drawer-body').evaluate((el) => el.scrollTop);
        await sword.click();
        await choiceCompact.locator('[aria-label="选择同名资料"] [data-id="item-1004"]').click();
        await choiceCompact.locator('[data-item-statistics]').waitFor();
        await assertProgressReference(choiceCompact, '2.sav');
        await assertSharedProgressUi(choiceCompact);
        await choiceCompact.locator('[data-action="drawer-back"]').click();
        await choiceCompact.locator('[data-action="drawer-back"]').click();
        await choiceCompact.locator('[data-task-relations]').waitFor();
        assert.equal(await advice.evaluate((el) => el.open), true);
        assert.equal(await sword.evaluate((el) => document.activeElement === el), true);
        assert(
          Math.abs((await choiceCompact.locator('.drawer-body').evaluate((el) => el.scrollTop)) - scroll) <=
            1,
        );
        await choiceCompact.screenshot({
          animations: 'disabled',
          path: path.join(results, '01-codex-advice-back.png'),
        });
        await choiceCompact.locator('[data-action="close-overlay"]').click();
      }
      writeChoice([...records, { id: scenario.exit, step: scenario.exitStep }]);
      await card.waitFor({ state: 'detached', timeout: 18000 });
      assert.equal(await choiceCompact.locator(`[data-flow-warning="${scenario.id}"]`).count(), 0);
    }
    for (const main of [20000, 5980]) {
      fs.writeFileSync(
        path.join(fakeSaves, '2.sav'),
        syntheticSave({
          full: true,
          trackingMainQuest: main,
          trackingQuest: main,
          quests: [{ id: main, step: 1 }],
        }),
      );
      await choiceCompact.waitForFunction(
        () =>
          document.querySelector('.flow-risk-window > summary')?.textContent &&
          document.querySelector('.flow-risks')?.innerText.includes('答应清虚任掌门'),
        null,
        { timeout: 18000 },
      );
      if (main === 5980)
        await choiceCompact.waitForFunction(
          () => !document.querySelector('.flow-risks')?.textContent.includes('元启寻物'),
          null,
          { timeout: 18000 },
        );
      const risks = choiceCompact.locator('.flow-compact-risks');
      assert.equal(
        await risks.evaluate((el) => el.open),
        true,
        'a new set of risks is visible even if the previous set was collapsed',
      );
      const visible = (await risks.innerText()).replace(/\s+/g, '');
      assert.match(visible, /清虚.*掌门.*关闭天机宫.*救商颂/);
      if (main === 20000) {
        assert.match(visible, /阎浮镇.*放弃调查.*关闭查明真相/);
        assert.match(visible, /小彤.*林地.*两个宝箱.*离开不返/);
      }
      assert.equal(await risks.locator('.flow-risk-window[open]').count(), 0);
      await choiceCompact.locator('.compact-body').evaluate((el) => {
        el.scrollTop = 0;
      });
      await choiceCompact.screenshot({
        animations: 'disabled',
        path: path.join(results, `01-stage-${main}-risk-summary.png`),
      });
    }
    fs.writeFileSync(path.join(fakeSaves, '2.sav'), beforeNpcProbe);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="home"]').click();
    await choiceCompact
      .locator('[data-flow-decision="early-woodcutter-axe-choice"]')
      .waitFor({ timeout: 18000 });
    await win.locator('[data-action="compact"]').first().click();
    const choiceSave = fs.readFileSync(path.join(fakeSaves, '2.sav'));
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        quests: [
          { id: 11002, step: 1 },
          { id: 11005, step: 4 },
          { id: 11007, step: 1 },
        ],
      }),
    );
    // No manual refresh: ordinary five-second saved-progress polling must retire the finished choice.
    await win.waitForFunction(
      () => !document.querySelector('[data-flow-decision="early-woodcutter-axe-choice"]'),
      null,
      { timeout: 18000 },
    );
    assert.match(
      await win.locator('[data-flow-quest="quest-11002"] .flow-next-action').innerText(),
      /斧子.*河里/,
    );
    assert.deepEqual(fs.readFileSync(path.join(fakeSaves, '1.sav')), originalSave);
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 8830,
        quests: [
          { id: 8830, step: 1 },
          { id: 8879, step: 1 },
        ],
      }),
    );
    // The companion now hands off to the complete checklist. This next scenario
    // Refresh from the history page, where the manual refresh action lives.
    await win.locator('.sidebar-nav [data-action="navigate"][data-id="home"]').click();
    await refreshProgress(win);
    const rosterWarning = win.locator('[data-flow-warning="late-roster-before-wudang"]');
    await rosterWarning.waitFor();
    assert.match(
      (await rosterWarning.locator('.flow-warning-message').innerText()).replace(/\s+/g, ''),
      /回武当前.*旧版/,
    );
    assert.match(
      (await win.locator('[data-flow-quest="quest-8830"] .flow-next-action').innerText()).replace(/\s+/g, ''),
      /返回武当/,
    );
    const returnPlaces = win.locator('[data-flow-quest="quest-8830"] .flow-targets');
    assert.match(await returnPlaces.innerText(), /武当派/);
    assert.match(await returnPlaces.innerText(), /名剑山庄/);
    await rosterWarning.locator('.flow-rule-details > summary').click();
    await rosterWarning
      .locator('details details')
      .evaluateAll((rows) => rows.forEach((row) => (row.open = true)));
    assert.match(await rosterWarning.innerText(), /v1\.23\.24.*不能保证当前版本/s);
    assert.match(await rosterWarning.innerText(), /商葶苧.*叶飞.*冷无情/s);
    await win.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-late-roster-preparation.png'),
    });
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 5920,
        quests: [
          { id: 8830, step: 4 },
          { id: 5920, step: 1 },
          { id: 5921, step: 1 },
        ],
      }),
    );
    await refreshProgress(win);
    assert.equal(await rosterWarning.count(), 0);
    assert.match(await win.locator('[data-flow-quest="quest-5920"] .flow-next-action').innerText(), /阎浮镇/);
    await revealAncestors(win.locator('.flow-chapter'));
    assert.match(await win.locator('.flow-chapter').innerText(), /少林后续路线待核对.*原版.*烟尘回响/s);
    fs.writeFileSync(
      path.join(fakeSaves, '2.sav'),
      syntheticSave({
        full: true,
        trackingMainQuest: 20000,
        quests: [
          { id: 20000, step: 1 },
          { id: 20001, step: 1 },
          { id: 20012, step: 4 },
          { id: 20050, step: 4 },
          { id: 20100, step: 1 },
          { id: 20101, step: 1 },
        ],
      }),
    );
    await refreshProgress(win);
    const yuanqiWarning = win.locator('[data-flow-warning="yuanqi-return-followthrough"]');
    await yuanqiWarning.waitFor();
    await revealAncestors(win.locator('.flow-chapter'));
    assert.match(await win.locator('.flow-chapter').innerText(), /下一主线关键节点.*天佛窟/s);
    assert.equal(
      await win.locator('.flow-chapter [data-action="source"][data-id="flow:biliLateFlow"]').count(),
      1,
    );
    assert.match(
      (await yuanqiWarning.locator('.flow-warning-message').innerText()).replace(/\s+/g, ''),
      /天剑宗.*存亡/,
    );
    assert.match(
      await win.locator('[data-flow-quest="quest-20100"] .flow-next-action').innerText(),
      /天剑宗/,
    );
    await yuanqiWarning.locator('.flow-rule-details > summary').click();
    await yuanqiWarning
      .locator('details details')
      .evaluateAll((rows) => rows.forEach((row) => (row.open = true)));
    assert.match(await yuanqiWarning.locator('.flow-warning-detail').innerText(), /前半段.*不等于/s);
    assert.match(await yuanqiWarning.innerText(), /断剑.*笔记.*上官虹.*叶飞/s);
    assert.match(await yuanqiWarning.innerText(), /不保证.*必然存活/s);
    fs.writeFileSync(path.join(fakeSaves, '2.sav'), choiceSave);
    fs.utimesSync(path.join(fakeSaves, '2.sav'), new Date('2025-01-01'), new Date('2025-01-01'));
    await refreshProgress(win);
    fs.renameSync(path.join(fakeSaves, '2.sav'), path.join(data, 'held-2.sav'));
    await refreshProgress(win);
    assert.match(await win.locator('.content').innerText(), /所选进度暂不可读/);
    assert.equal(await win.evaluate(async () => (await window.journal.refresh()).data.recent), null);
    assert.match(await win.locator('[data-flow]').innerText(), /暂无可读进度/);
    await openProgressSettings(win);
    await win.locator('[data-action="save-slot"]').click();
    assert.equal(await win.locator('#save-slot-select').inputValue(), '2.sav');
    await win.locator('[data-action="close-overlay"]').first().click();
    fs.renameSync(path.join(data, 'held-2.sav'), path.join(fakeSaves, '2.sav'));
    await refreshProgress(win);
    await selectProgressReference(win, '@latest');
    await navigatePage(win, 'saves');
    await win.locator('[data-action="save-detail"][data-id="1.sav"]').click();
    await win.locator('.save-recorded-quests > summary').click();
    await win.locator('[data-quest-id="5200"] details > summary').click();
    assert.equal(await win.locator('.save-recorded-quests').evaluate((e) => e.open), true);
    assert.equal(await win.locator('[data-quest-id="5200"] details').evaluate((e) => e.open), true);
    await win.locator('[data-action="close-overlay"]').click();
    await navigatePage(win, 'home');
    await revealAncestors(win.locator('#note'));
    await win.locator('#note').fill('测试随手记：下次去青木舫。');
    await win.waitForTimeout(1000);
    await win.locator('[data-action="goal-add"]').first().click();
    await win.locator('#goal-title').fill('测试目标 <script>你好</script>');
    await win.locator('#goal-detail').fill('目标说明 & 特殊字符');
    await win.locator('[data-action="goal-save"]').click();
    await win.locator('.nav-btn[data-id="checklist"]').click();
    const medicineConditions = win.locator('[data-flow-rule="conditions-13408"] .flow-conditions');
    await revealAncestors(medicineConditions);
    assert.match(await medicineConditions.innerText(), /已满足/);
    assert.match(await medicineConditions.innerText(), /未确认|未满足/);
    assert.equal(await win.locator('[data-flow-rule="conditions-11442"]').count(), 0);
    await win.locator('.flow-guide > summary').click();
    const completedGuide = win.locator('.flow-guide [data-flow-rule="lotus-meeting"]');
    assert.equal(await completedGuide.locator('.pill').first().innerText(), '已完成');
    assert.doesNotMatch(await completedGuide.innerText(), /存档已记录完成/);
    await win.locator('[data-persist-detail="flow-legacy"] > summary').click();
    assert.equal(await win.locator('.entry-row').count(), catalog.entries.filter((e) => e.checklist).length);
    assert.equal(await win.locator('[data-action="filter"].active').getAttribute('data-id'), 'all');
    assert.equal(await win.locator('.stage-step.active').count(), 0);
    await win.locator('[data-action="filter"][data-id="current"]').click();
    await win.locator('#stage-select').waitFor();
    await win.keyboard.press('Escape');
    await win.locator('[data-action="check"]').first().click();
    await win.locator('.nav-btn[data-id="library"]').click();
    await win.locator('#list-search').fill('上官虹');
    await win.locator('.entry-card [data-action="detail"]').first().click();
    assert.equal(await win.locator('.spoiler-box').count(), 1);
    await win.locator('[data-action="reveal"]').click();
    assert.ok((await win.locator('.steps li').count()) > 0);
    await win.locator('.drawer-actions [data-action="favorite"]').click();
    await win.waitForTimeout(250);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '02-detail.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('.nav-btn[data-id="goals"]').click();
    await win.locator('[data-action="entry-goal"]').first().click();
    await win.locator('.nav-btn[data-id="database"]').click();
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('清灵丹');
    await win.locator('[data-action="database-kind"][data-id="武学"]').click();
    assert.equal(await win.locator('.database-card').count(), 0);
    await win.locator('[data-action="database-reset"]').click();
    assert.equal(await win.locator('#list-search').inputValue(), '');
    assert.equal(await win.locator('#list-search').evaluate((e) => e === document.activeElement), true);
    assert.ok(await win.locator('.database-card').count());
    await win.locator('[data-action="database-kind"][data-id="物品"]').click();
    await win.locator('#list-search').fill('腾空剑');
    const swordCard = win.locator('.database-card[data-id="item-1029"]');
    assert.match(await swordCard.locator('.database-numeric').innerText(), /攻击力.*637\.89.*暴击率.*15%/);
    await swordCard.click();
    const swordStats = win.locator('[data-item-statistics]');
    assert.match(await swordStats.innerText(), /装备基础数值.*637\.89.*15%/s);
    assert.equal(await swordStats.locator('.item-random-stats').evaluate((el) => el.open), false);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '10-item-base-stats.png') });
    await swordStats.locator('.item-random-stats > summary').click();
    assert.match(await swordStats.locator('.item-random-stats').innerText(), /172.*4\.5%/s);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('金疮药');
    await win.locator('.database-card[data-id="item-133"]').click();
    assert.match(await win.locator('[data-item-statistics]').innerText(), /恢复气血.*400/s);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('锻骨法上篇');
    await win.locator('.database-card[data-id="item-10460"]').click();
    const boneConditions = win.locator('[data-item-statistics] .item-stat-restrictions');
    assert.match(await boneConditions.innerText(), /需同时满足.*锻骨法下篇.*1.*惔神秘鉴.*残.*1/s);
    assert.equal(
      await boneConditions.locator('[data-action="database-detail"][data-id="item-10486"]').count(),
      1,
    );
    await win.screenshot({ animations: 'disabled', path: path.join(results, '10-item-use-conditions.png') });
    await boneConditions.locator('[data-id="item-10486"]').click();
    assert.match(await win.locator('.drawer .game-detail-title h1').innerText(), /惔神秘鉴/);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('铁矿石');
    await win.locator('.database-card[data-id="item-10201"]').click();
    assert.ok((await win.locator('.drawer').innerText()).includes('梧桐村'));
    await win.locator('[data-action="database-goal"]').click();
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('下品清灵丹丹方');
    await win.locator('.database-card[data-id="item-100304"]').click();
    await win.locator('.item-teaches [data-id="alchemy-104"]').click();
    assert.ok((await win.locator('.recipe-learning').innerText()).includes('下品清灵丹丹方'));
    await win.locator('.recipe-learning [data-id="item-100304"]').click();
    await win.locator('.item-sellers summary').click();
    assert.ok((await win.locator('.item-sellers').innerText()).includes('元济'));
    await win.locator('.item-sellers [data-id="npc-5056"]').click();
    await win.locator('.shop-stock summary').click();
    await win.locator('.shop-stock [data-id="item-100304"]').click();
    assert.ok((await win.locator('.item-teaches').innerText()).includes('下品清灵丹'));
    await win.screenshot({ animations: 'disabled', path: path.join(results, '10-recipe-learning.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.waitForTimeout(300);
    assert.equal(await win.locator('#entity-preview').isVisible(), false);
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('长虹剑精良图纸');
    await win.locator('.database-card').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('3,396'));
    await win.locator('#recipe-materials [data-id="item-10226"]').click();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('精钢锭'));
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await assertProgressReference(win, '@latest');
    await assertSharedProgressUi(win);
    await win.locator('[data-action="recipe-goal"]').click();
    await win.waitForTimeout(250);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '07-recipe.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('水煮鱼');
    await win.locator('.database-card[data-id="cooking-102"]').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('已有 5 · 还缺 1'));
    await win.locator('.ingredient-options summary').click();
    assert.ok((await win.locator('.ingredient-options').innerText()).includes('鲤鱼'));
    await selectProgressReference(win, '@none', 'database');
    await win.locator('#list-search').fill('水煮鱼');
    await win.locator('.database-card[data-id="cooking-102"]').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.equal(await win.locator('#recipe-materials .material-owned').count(), 0);
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await selectProgressReference(win, '1.sav', 'database');
    await win.locator('#list-search').fill('水煮鱼');
    await win.locator('.database-card[data-id="cooking-102"]').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('已有 5 · 还缺 1'));
    const fishResult = (
      await win.evaluate(async () =>
        (await window.journal.bootstrap()).data.gameIndex.entries.find((e) => e.id === 'cooking-102'),
      )
    ).results[0];
    await win
      .locator(`#recipe-materials [data-recipe-output-id="${fishResult.id}"] [data-action="database-detail"]`)
      .click();
    await win.locator('.item-produced [data-id="cooking-102"]').click();
    assert.equal(await win.locator('.recipe-learning').count(), 1);
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await win.screenshot({ animations: 'disabled', path: path.join(results, '09-cooking.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await selectProgressReference(win, '@latest', 'database');
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('上官虹');
    await win.locator('.database-card').first().click();
    assert.ok((await win.locator('.drawer').innerText()).includes('茶具'));
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('.nav-btn[data-id="saves"]').click();
    assert.equal(await win.locator('[data-persist-detail="unused-timeline"]').evaluate((e) => e.open), false);
    await win.locator('[data-persist-detail="unused-timeline"] > summary').click();
    await win.locator('[data-action="refresh"]').click();
    assert.equal(await win.locator('[data-persist-detail="unused-timeline"]').evaluate((e) => e.open), true);
    await win.locator('[data-persist-detail="unused-timeline"] > summary').click();
    await win.locator('[data-action="backup"]').first().click();
    await win.locator('#backup-label').fill('测试备份');
    await win.locator('[data-action="backup-confirm"]').click();
    await win.waitForSelector('.backup-row');
    await win.locator('[data-action="verify"]').first().click();
    await win.screenshot({ animations: 'disabled', path: path.join(results, '03-saves.png') });
    await win.locator('[data-action="backup-preview"]').first().click();
    await win.locator('.comparison-grid').waitFor();
    assert.ok((await win.locator('.drawer').innerText()).includes('完全一致'));
    await win.locator('[data-action="backup-rename"]').click();
    await win.locator('#rename-backup').fill('改名后的测试副本');
    await win.locator('[data-action="backup-rename-save"]').click();
    assert.equal(await win.locator('.backup-row').filter({ hasText: '改名后的测试副本' }).count(), 1);
    await win.locator('[data-action="save-detail"]').first().click();
    await win.locator('.save-drawer').waitFor();
    assert.ok((await win.locator('.save-drawer').innerText()).includes('卫霍'));
    await win.locator('.save-quests summary').first().click();
    assert.ok((await win.locator('.save-drawer').innerText()).includes('武当求助'));
    await win.locator('.save-quests > summary').filter({ hasText: '这份存档的任务记录' }).click();
    await win.locator('[data-action="save-quest-goal"]').first().click();
    await win.locator('[data-action="save-quest-filter"][data-id="done"]').click();
    assert.ok((await win.locator('#save-quest-results').innerText()).includes('狂风寨救人'));
    await win.locator('.save-quests > summary').filter({ hasText: '物品记录' }).click();
    await win.locator('#save-inventory-search').fill('精钢');
    assert.ok((await win.locator('#save-inventory-results').innerText()).includes('× 3'));
    await win.waitForTimeout(250);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '08-save-recap.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-action="help"]').click();
    assert.ok((await win.locator('.help-copy').innerText()).includes('读取范围'));
    await win.locator('[data-action="close-overlay"]').click();
    await win.screenshot({ animations: 'disabled', path: path.join(results, '04-settings.png') });
    await win.locator('[data-action="compact"]').first().click();
    await win.waitForTimeout(500);
    const windows = app.windows();
    assert.equal(windows.length, 2);
    await windows[1].waitForSelector('.compact-shell');
    await windows[1].screenshot({ animations: 'disabled', path: path.join(results, '05-compact.png') });
    const quick = windows[1];
    quick.on('pageerror', (e) => errors.push(e.message));
    await quick.locator('[data-action="search"]').click();
    await quick.locator('#global-search').fill('司马铃');
    await quick.locator('.search-result').first().click();
    await quick.locator('.drawer').waitFor();
    assert.ok((await quick.locator('.drawer h1').innerText()).includes('司马铃'));
    await quick.screenshot({ animations: 'disabled', path: path.join(results, '05-compact-search.png') });
    await quick.keyboard.press('Escape');
    assert.equal(await quick.locator('.drawer').count(), 0);
    await quick.locator('.companion-tabs [data-action="navigate"][data-id="saves"]').click();
    await quick.locator('[data-persist-detail="compact-backups"]').waitFor();
    assert.equal(await quick.locator('[data-action="backup"]').isVisible(), true);
    const unusedTimeline = quick.locator('[data-persist-detail="unused-timeline"]');
    assert.equal(await unusedTimeline.evaluate((el) => el.open), false);
    await unusedTimeline.locator(':scope > summary').click();
    await quick.locator('.timeline-card').first().waitFor();
    await quick.screenshot({ animations: 'disabled', path: path.join(results, '05-compact-history.png') });
    await quick.locator('[data-action="navigate"][data-id="home"]').click();
    const automaticTasks = await quick.evaluate(
      async () => (await window.journal.companionSnapshot()).data.quests,
    );
    assert.ok(automaticTasks.length);
    assert.equal(automaticTasks[0].id, 11077);
    assert.equal(
      await quick.locator('[data-flow-now] [data-action="flow-quest"]').first().getAttribute('data-id'),
      'quest-11077',
    );
    await quick.locator('[data-flow-now] [data-action="flow-quest"]').first().click();
    await quick.locator('.world-drawer').waitFor();
    await quick.locator('[data-action="close-overlay"]').click();
    // Renderer presentation under a synthetic passive-mode event; controller focus/input
    // and native identity boundaries are separately tested without any game access.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact=1'));
      w.setMinimumSize(200, 90);
      w.setBounds({ ...w.getBounds(), width: 320, height: 112 });
      w.webContents.send('journal:companion', { mode: 'hint', visible: true });
    });
    await quick.locator('.hint-shell').waitFor();
    await quick.waitForFunction(() => innerWidth <= 321 && innerHeight <= 113);
    assert((await quick.locator('.hint-line').count()) <= 2);
    assert.equal(
      await quick.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    await quick.screenshot({ animations: 'disabled', path: path.join(results, '05-passive-hints.png') });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact=1'));
      w.setMinimumSize(360, 360);
      w.setBounds({ ...w.getBounds(), width: 460, height: 660 });
      w.webContents.send('journal:companion', { mode: 'expanded', visible: true });
    });
    await quick.locator('.compact-shell').waitFor();
    await quick.waitForFunction(() => innerWidth >= 450 && innerHeight >= 640);
    await quick.keyboard.press('Escape');
    // The companion is hidden now; inspect its shared controller state from the
    // visible window so background renderer scheduling cannot stall the check.
    assert.equal(
      await win.evaluate(async () => (await window.journal.companionSnapshot()).data.mode),
      'hint',
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('compact=1'))
          .isVisible(),
      ),
      false,
    );
    // The companion stays useful when the full window was closed first.
    await win.locator('[data-action="compact"]').first().click();
    await win.waitForTimeout(300);
    const companion = app.windows().find((w) => w !== win);
    await companion.waitForSelector('.compact-shell');
    await win.locator('[data-action="window-close"]').click();
    await companion.locator('[data-action="main"]').click();
    win = app.windows().find((w) => w !== companion);
    if (!win) win = await app.waitForEvent('window');
    await win.waitForSelector('.layout');
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('compact=1'))
          .isVisible(),
      ),
      false,
    );
    await win.locator('[data-action="profiles"]').first().click();
    await win.locator('#profile-name').fill('测试二周目');
    await win.locator('[data-action="profile-create"]').click();
    await win.locator('.nav-btn[data-id="home"]').click();
    assert.equal(await win.locator('#note').inputValue(), '');
    await win.locator('[data-action="profiles"]').first().click();
    await win.locator('#profile-select').selectOption({ label: '我的江湖' });
    await win.locator('[data-action="profile-switch"]').click();
    assert.equal(await win.locator('#note').inputValue(), '测试随手记：下次去青木舫。');
    await win.locator('[data-action="compact"]').first().click();
    const layoutCompanion = app.windows().find((page) => page !== win);
    await layoutCompanion.waitForSelector('.compact-shell');
    await layoutCompanion.evaluate(() =>
      window.journal.mutate({ type: 'settings', value: { companionPosition: 'bottom-left' } }),
    );
    // Exercise native geometry + the manual-gesture event contract without
    // controlling the desktop mouse or opening any actual game window.
    savedWindowLayouts = await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('compact=1'));
      const companion = BrowserWindow.getAllWindows().find((w) => w !== main);
      const chosen = {
        x: area.x + 35,
        y: area.y + 35,
        width: Math.min(1024, area.width - 70),
        height: Math.min(700, area.height - 70),
      };
      main.setBounds(chosen);
      main.emit('moved');
      const compact = {
        x: area.x + 90,
        y: area.y + 80,
        width: 520,
        height: Math.min(600, area.height - 100),
      };
      companion.emit('will-resize', {}, compact);
      companion.setBounds(compact);
      companion.emit('resized');
      return { main: main.getBounds(), companion: companion.getBounds() };
    });
    await layoutCompanion.evaluate(async () => window.journal.companionSnapshot());
    await layoutCompanion.locator('[data-action="companion-layout"]').first().click();
    assert.equal(
      await layoutCompanion.locator('[data-action="window-layout-reset"]').innerText(),
      '恢复默认位置与大小',
    );
    await app.close();
    const handoffTimeline = new Timeline(path.join(data, 'game-timeline'));
    handoffTimeline.configure(fakeSaves, false, 10);
    const handoffNode = handoffTimeline.record(originalSave, 'manual');
    handoffTimeline.updateNode(handoffNode.id, { label: '跨窗合成历史节点' });
    app = await launch();
    win = await attach();
    assert.equal(await win.locator('#note').inputValue(), '测试随手记：下次去青木舫。');
    const reopenedMain = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('compact=1'))
        .getBounds(),
    );
    for (const key of ['x', 'y', 'width', 'height'])
      assert(
        Math.abs(reopenedMain[key] - savedWindowLayouts.main[key]) <= 1,
        'main layout persisted: ' + key,
      );
    const restoredCompanionReady = app.waitForEvent('window');
    await win.locator('[data-action="compact"]').first().click();
    const restoredCompanion = await restoredCompanionReady;
    await restoredCompanion.waitForSelector('.compact-shell');
    const reopenedCompanion = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('compact=1'))
        .getBounds(),
    );
    for (const key of ['x', 'y', 'width', 'height'])
      assert(
        Math.abs(reopenedCompanion[key] - savedWindowLayouts.companion[key]) <= 1,
        'companion layout persisted: ' + key,
      );
    await restoredCompanion.locator('.companion-tabs [data-id="saves"]').click();
    await restoredCompanion
      .locator(`[data-action="timeline-preview"][data-id="${handoffNode.id}"]`)
      .first()
      .click();
    await restoredCompanion.locator('#timeline-note').fill('随行历史备注草稿');
    await restoredCompanion.locator('.drawer [data-action="main"]').click();
    await win.locator('#timeline-note').waitFor();
    assert.equal(await win.locator('#timeline-note').inputValue(), '随行历史备注草稿');
    assert.equal(await win.locator('[data-action="timeline-load"]').getAttribute('data-id'), handoffNode.id);
    await win.locator('[data-action="close-overlay"]').first().click();
    await win.locator('[data-action="compact"]').first().click();
    assert.equal(await restoredCompanion.locator('#timeline-note').inputValue(), '随行历史备注草稿');
    await restoredCompanion.locator('[data-action="close-overlay"]').first().click();
    await restoredCompanion.locator('.companion-tabs [data-id="home"]').click();
    await restoredCompanion.locator('.flow-personal > summary').click();
    const tuckedScroll = await restoredCompanion.locator('.compact-body').evaluate((body) => {
      body.scrollTop = Math.min(180, body.scrollHeight - body.clientHeight);
      return body.scrollTop;
    });
    await restoredCompanion.locator('[data-action="companion-tuck"]').click();
    await restoredCompanion.locator('[data-action="companion-untuck"]').waitFor();
    const edgeState = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact=1'));
      return { bounds: w.getBounds(), focusable: w.isFocusable(), resizable: w.isResizable() };
    });
    assert(Math.abs(edgeState.bounds.width - 44) <= 1);
    assert(Math.abs(edgeState.bounds.height - 88) <= 1);
    assert.equal(edgeState.focusable, false);
    assert.equal(edgeState.resizable, false);
    await restoredCompanion.screenshot({ path: path.join(results, '05-companion-edge.png') });
    await restoredCompanion.locator('[data-action="companion-untuck"]').click();
    await restoredCompanion.locator('.compact-shell').waitFor();
    const untuckedBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('compact=1'))
        .getBounds(),
    );
    for (const key of ['x', 'y', 'width', 'height'])
      assert(Math.abs(untuckedBounds[key] - savedWindowLayouts.companion[key]) <= 1, 'edge restore: ' + key);
    assert.equal(await restoredCompanion.locator('.flow-personal').evaluate((detail) => detail.open), true);
    assert(
      Math.abs(
        (await restoredCompanion.locator('.compact-body').evaluate((body) => body.scrollTop)) - tuckedScroll,
      ) <= 2,
      'edge restore keeps the reading position within native DPI rounding',
    );
    await restoredCompanion.locator('[data-action="companion-layout"]').first().click();
    await restoredCompanion.locator('[data-action="window-layout-reset"]').click();
    await restoredCompanion.waitForFunction(() => !document.querySelector('[data-companion-layout]'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'window-layout.json'))).companion, undefined);
    assert.equal(
      (await restoredCompanion.evaluate(async () => (await window.journal.bootstrap()).data)).state.settings
        .companionPosition,
      'top-right',
    );
    const resetCompanion = await app.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('compact=1'))
        .getBounds(),
      area: screen.getPrimaryDisplay().workArea,
    }));
    assert.equal(resetCompanion.bounds.width, 460);
    assert.equal(resetCompanion.bounds.height, 660);
    // A success message must not cover the only restore control after tucking.
    await restoredCompanion.locator('#toasts .toast').first().waitFor();
    await restoredCompanion.locator('[data-action="companion-tuck"]').click();
    await restoredCompanion.locator('[data-action="companion-untuck"]').waitFor();
    assert.equal(await restoredCompanion.locator('#toasts').isVisible(), false);
    assert.equal(await restoredCompanion.locator('[data-action="companion-untuck"]').isVisible(), true);
    await restoredCompanion.locator('[data-action="companion-untuck"]').click();
    await restoredCompanion.locator('.compact-shell').waitFor();
    assert(
      Math.abs(resetCompanion.bounds.x - (resetCompanion.area.x + resetCompanion.area.width - 472)) <= 1,
    );
    assert(Math.abs(resetCompanion.bounds.y - (resetCompanion.area.y + 12)) <= 1);
    await restoredCompanion.keyboard.press('Escape');
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-action="window-layout-reset"]').click();
    const resetMain = await app.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('compact=1'))
        .getBounds(),
      area: screen.getPrimaryDisplay().workArea,
    }));
    assert(Math.abs(resetMain.bounds.width - Math.min(1340, resetMain.area.width)) <= 1);
    assert(Math.abs(resetMain.bounds.height - Math.min(880, resetMain.area.height)) <= 1);
    await win.locator('.nav-btn[data-id="goals"]').click();
    assert.ok(
      (await win.locator('.goal-row').allInnerTexts()).some((s) => s.includes('<script>你好</script>')),
    );
    assert.ok((await win.locator('.goal-row').allInnerTexts()).some((s) => s.includes('精钢锭 ×9')));
    const recipeGoal = win.locator('.goal-row').filter({ hasText: '精钢锭 ×9' });
    const oldGoal = await recipeGoal.innerText();
    // A saved material note stays a snapshot; reopening uses current inventory.
    fs.writeFileSync(
      path.join(fakeSaves, '1.sav'),
      syntheticSave({ full: true, inventory: [{ id: 10226, count: 99 }] }),
    );
    const stableInventoryAt = new Date(Date.now() - 5000);
    fs.utimesSync(path.join(fakeSaves, '1.sav'), stableInventoryAt, stableInventoryAt);
    await recipeGoal.locator('[data-action="goal-source"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await assertProgressReference(win, '@latest');
    await assertSharedProgressUi(win);
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('已有 99'));
    await win.locator('[data-action="close-overlay"]').click();
    assert.equal(await recipeGoal.innerText(), oldGoal);
    await win
      .locator('.goal-row')
      .filter({ hasText: '寻找铁矿石' })
      .locator('[data-action="goal-source"]')
      .click();
    assert.equal(await win.locator('.drawer h1').innerText(), '铁矿石');
    await win.locator('[data-action="close-overlay"]').click();
    const guideGoal = win
      .locator('.goal-row')
      .filter({ hasText: '上官虹' })
      .filter({ has: win.locator('[data-action="goal-source"]') });
    await guideGoal.locator('[data-action="goal-source"]').click();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('上官虹'));
    await win.locator('[data-action="close-overlay"]').click();
    assert.equal(await win.locator('script:not([src])').count(), 0);
    await win.keyboard.press('Control+k');
    for (const query of ['种类:配方 铜锭', '铜锭 kind:配方', '种类：配方 "铜锭"', '种类:配方 名称:铜锭']) {
      await win.locator('#global-search').fill(query);
      assert.equal(
        await win.locator('.search-result[data-action="database-detail"]').first().getAttribute('data-id'),
        'fusion-9501',
        query,
      );
    }
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+k');
    assert.equal(await win.locator('#global-search').inputValue(), '种类:配方 名称:铜锭');
    await win.locator('#global-search').fill('司马铃');
    assert.ok((await win.locator('.search-result').count()) > 0);
    await win.keyboard.press('ArrowDown');
    assert.equal(
      await win
        .locator('.search-result')
        .first()
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await win.keyboard.press('ArrowUp');
    assert.equal(await win.locator('#global-search').evaluate((e) => e === document.activeElement), true);
    await win.keyboard.press('Enter');
    await win.locator('.drawer').waitFor();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('司马铃'));
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#global-search').inputValue(), '司马铃');
    assert.equal(
      await win
        .locator('.search-result')
        .first()
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await win.keyboard.press('Enter');
    await win.locator('.drawer').waitFor();
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+k');
    assert.equal(await win.locator('#global-search').inputValue(), '司马铃');
    await win.keyboard.press('Escape');
    // Compact-width and minimum-window layout checks.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await win.screenshot({ animations: 'disabled', path: path.join(results, '06-small-window.png') });
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await win.locator('.nav-btn[data-id="home"]').click();
    // Supply a supported-game display fixture; native IPC remains blocked by the isolated test mode.
    const launchDisplay = (await win.evaluate(() => window.journal.bootstrap())).data;
    launchDisplay.environment.game = { installed: true, build: launchDisplay.gameIndex.build };
    launchDisplay.environment.timeline.pathIssue =
      '存档目录包含原生组件不支持的路径格式，查询和完整自动备份可继续使用';
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.waitForSelector('.start-panel');
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'launch');
    assert.equal(await win.locator('.start-panel [data-action="start-assistance"]').count(), 0);
    await win.locator('.start-panel summary').click();
    assert.match(
      await win.locator('.start-panel details').innerText(),
      /不支持的路径格式.*查询和完整自动备份可继续使用/,
    );
    launchDisplay.environment.timeline.pathIssue = '';
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.waitForSelector('.start-actions');
    assert.equal(
      await win.locator('.start-actions .btn.primary').getAttribute('data-action'),
      'start-assistance',
    );
    launchDisplay.state = (
      await win.evaluate(() =>
        window.journal.mutate({
          type: 'settings',
          value: { offerAutoSaveOnStart: false },
        }),
      )
    ).data;
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.waitForSelector('.start-actions');
    assert.equal(await win.locator('.start-actions .btn.primary').getAttribute('data-action'), 'launch');
    assert.equal(await win.locator('.start-actions button').count(), 1);
    // Exercise the one-click setup's failure presentation without allowing game access.
    await win.locator('.start-actions .btn.primary').evaluate((el) => {
      el.dataset.action = 'start-assistance';
    });
    await win.locator('.start-actions .btn.primary').click();
    await win.waitForFunction(() =>
      document.querySelector('.start-panel h2')?.textContent.includes('自动存档暂未准备好'),
    );
    assert.match(await win.locator('.start-panel').innerText(), /测试环境/);
    await refreshProgress(win);
    assert.match(await win.locator('.start-panel h2').innerText(), /自动存档暂未准备好/);
    assert.equal(await win.locator('.start-panel [data-action="launch"]').count(), 1);
    // A stale machine-specific path must offer reconnection without hiding queries.
    launchDisplay.state.settings.savePath = path.join(data, 'previous-computer', 'SaveGames');
    launchDisplay.environment.saves = {
      path: launchDisplay.state.settings.savePath,
      files: [],
      total: 0,
      error: '模拟旧目录不可用',
    };
    launchDisplay.environment.timeline.error = '';
    launchDisplay.environment.timeline.pending = false;
    launchDisplay.environment.timeline.busy = false;
    launchDisplay.environment.recovery = null;
    launchDisplay.environment.detected = [];
    await app.evaluate(({ ipcMain, dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.locator('.start-panel').waitFor();
    assert.match(await win.locator('.start-panel h2').innerText(), /先前的存档目录暂不可用/);
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'choose-saves');
    assert.equal(await win.locator('.start-panel details').evaluate((el) => el.open), false);
    const storedBeforeCancel = fs.readFileSync(path.join(data, 'journal.json'));
    await win.locator('.start-panel .btn.primary').click();
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), storedBeforeCancel);
    const candidate = path.join(data, '76561190000000000', 'SaveGames');
    launchDisplay.environment.detected = [candidate];
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
      ipcMain.removeHandler('journal:use-detected-saves');
      ipcMain.handle('journal:use-detected-saves', (_event, value) => {
        globalThis.syntheticReconnectSelection = value;
        return { ok: true, data: { state: fixture.state, environment: fixture.environment } };
      });
    }, launchDisplay);
    await win.reload();
    await win.locator('.start-panel').waitFor();
    assert.equal(
      await win.locator('.start-panel .btn.primary').getAttribute('data-action'),
      'reconnect-detected',
    );
    await win.locator('.start-panel .btn.primary').click();
    assert.equal(await app.evaluate(() => globalThis.syntheticReconnectSelection), candidate);
    launchDisplay.environment.timeline.pending = true;
    launchDisplay.environment.health.protection = { warning: true, reason: '模拟中断记录' };
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.locator('.start-panel').waitFor();
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'navigate');
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-id'), 'saves');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'smoke-report.json'),
      JSON.stringify(
        {
          passed: true,
          data,
          checks: [
            'navigation',
            'checklist',
            'notes persistence',
            'goals and escaping',
            'favorites',
            'spoiler reveal',
            'snapshot and verification',
            'separate profiles',
            'restart',
            'compact window',
            'global search',
            'minimum size',
            'recipe navigation preserves quantity',
            'interchangeable cooking materials and stock reference',
            'native quest records and inventory search',
            'keyboard result navigation',
            'preferred save selection and missing-slot refusal to fall back',
            'goal references reopen after restart and re-read inventory without changing the saved note',
          ],
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log('Electron smoke PASS; isolated data:', data);
  } finally {
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
