'use strict';
const { chooseCodexKind } = require('./ui-smoke-actions.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(base, '.test-data', 'live-guidance-'));
const data = path.join(output, 'state');
const source = path.join(data, '76561190000000000', 'SaveGames');
fs.mkdirSync(source, { recursive: true });
const saveFile = path.join(source, '1.sav');
const writeSave = (quests, inventory = []) => {
  const bytes = syntheticSave({
    full: true,
    map: 'LV_25_P',
    quests,
    inventory,
    trackingQuest: 0,
    trackingMainQuest: 0,
  });
  fs.writeFileSync(saveFile, bytes);
  fs.utimesSync(saveFile, new Date('2020-01-01'), new Date('2020-01-01'));
  return bytes;
};
const original = writeSave([{ id: 5020, step: 1 }]);
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({
  type: 'journal-entry-put',
  title: '筛选连续性',
  body: '白锦的合成记录',
  tags: ['支线'],
  links: [],
  snapshotMode: 'none',
  occurredAt: '2026-10-14T00:00:00.000Z',
});
const revision = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(base, 'src/game-bridge/main.lua')))
  .digest('hex');
const env = { ...process.env, YIJIAN_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const packet = (extra = {}) => ({
  schema: 1,
  sequence: 1,
  questId: 11005,
  npcId: 10038,
  options: [
    { index: 1, text: '买把新的比较好' },
    { index: 2, text: '重新锻造一番吧' },
  ],
  ...extra,
});
const errors = [];
let app,
  timer,
  current = null,
  session = '1800000000-123456',
  token;
const pulse = () =>
  fs.writeFileSync(
    path.join(data, 'game-bridge/state.json'),
    JSON.stringify({
      protocol: 2,
      revision,
      token,
      source,
      at: Math.floor(Date.now() / 1000),
      ready: false,
      reason: '菜单或对话中暂停保存',
      session,
      dialogue: current,
    }),
  );
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    const win = await app.firstWindow();
    win.on('pageerror', (error) => errors.push(error.message));
    await win.locator('.layout').waitFor();
    token = fs.readFileSync(path.join(data, 'game-bridge/token.txt'), 'utf8');
    timer = setInterval(pulse, 250);
    async function checkBodyPreviews(surface, firstSequence) {
      const reference = surface.locator('.duel-card [data-entity-id]').first();
      for (const [offset, intent] of ['hover', 'focus'].entries()) {
        if (intent === 'hover') await reference.hover();
        else {
          await surface.mouse.move(0, 0);
          await reference.focus();
        }
        await surface.locator('#entity-preview').waitFor({ state: 'visible' });
        await surface.waitForFunction(
          () =>
            document.querySelector('.duel-card [data-entity-id]')?.getAttribute('aria-describedby') ===
            'entity-preview',
        );
        const name = await surface.locator('#entity-preview strong').first().innerText();
        const oldEntry = await reference.elementHandle();
        current = packet({ sequence: firstSequence + offset });
        pulse();
        await surface.waitForFunction((node) => !node.isConnected, oldEntry);
        await surface.waitForFunction(
          () =>
            document.querySelector('.duel-card [data-entity-id]')?.getAttribute('aria-describedby') ===
            'entity-preview',
        );
        await surface.locator('#entity-preview').waitFor({ state: 'visible' });
        assert.equal(
          await reference.getAttribute('aria-describedby'),
          'entity-preview',
          `${intent} body preview rebinds through a real guidance event`,
        );
        assert.equal(await surface.locator('#entity-preview strong').first().innerText(), name);
        if (intent === 'focus')
          assert.equal(await reference.evaluate((el) => document.activeElement === el), true);
      }
    }
    const choice = '[data-flow-decision="early-woodcutter-axe-choice"]';
    assert.equal(await win.locator(choice).count(), 0, 'the saved reference has not reached the choice');
    await win.locator('.sidebar-nav [data-id="duels"]').click();
    await win.locator('.duel-all > summary').click();
    await win.waitForFunction(() => {
      const content = document.querySelector('.content');
      return document.querySelector('.duel-all')?.open && content.scrollHeight > content.clientHeight + 400;
    });
    const mainScroll = await win.locator('.content').evaluate((el) => {
      el.scrollTop = 650;
      return el.scrollTop;
    });
    assert(mainScroll > 400, 'the main window starts deep in a real long page');
    await win.locator('.duel-all > summary').evaluate((el) => el.focus({ preventScroll: true }));
    current = packet();
    pulse();
    await win.locator(choice).waitFor({ timeout: 5000 });
    assert(await win.locator('.live-choice-dock ' + choice).isVisible());
    assert.equal(await win.locator('.content').evaluate((el) => el.scrollTop), mainScroll);
    assert.equal(
      await win.locator('.duel-all > summary').evaluate((el) => document.activeElement === el),
      true,
    );
    const mainBounds = await win.locator(choice).boundingBox();
    assert(
      mainBounds &&
        mainBounds.y >= 0 &&
        mainBounds.y + mainBounds.height <= (await win.evaluate(() => innerHeight)),
    );
    assert.match(await win.locator(choice).innerText(), /樵夫.*重锻/s);
    assert.equal(await win.locator(choice + ' > details').evaluate((el) => el.open), false);
    assert.deepEqual(
      fs.readFileSync(saveFile),
      original,
      'live guidance never saves or chooses for the player',
    );
    await checkBodyPreviews(win, 2);
    await win.locator('.sidebar-nav [data-id="settings"]').click();
    const readingSummary = win.locator('summary').filter({ hasText: '读取方式与资料说明' });
    await readingSummary.click();
    await readingSummary.evaluate((el) => {
      el.focus({ preventScroll: true });
      window.__syntheticSummary = el;
    });
    await win.evaluate(() => window.journal.mutate({ type: 'settings', value: { autoBackup: false } }));
    await win.waitForFunction(() => !window.__syntheticSummary.isConnected);
    assert.equal(
      await readingSummary.evaluate((el) => document.activeElement === el),
      true,
      'the settings reading disclosure retains focus',
    );
    assert.equal(
      await readingSummary.evaluate((el) => el.parentElement.open),
      true,
      'background refresh keeps the settings explanation expanded',
    );
    const spoiler = win.locator('button[data-action="spoiler"]');
    const spoilerState = await spoiler.getAttribute('aria-checked');
    await spoiler.evaluate((el) => {
      el.focus({ preventScroll: true });
      window.__syntheticAction = el;
    });
    current = packet({ sequence: 4 });
    pulse();
    await win.waitForFunction(() => !window.__syntheticAction.isConnected);
    assert.equal(
      await spoiler.evaluate((el) => document.activeElement === el),
      true,
      'a real guidance event preserves an ordinary settings button focus',
    );
    assert.equal(
      await spoiler.getAttribute('aria-checked'),
      spoilerState,
      'restoring focus does not activate the switch',
    );
    assert.equal(
      await readingSummary.evaluate((el) => el.parentElement.open),
      true,
      'a real guidance event also keeps the reading disclosure expanded',
    );
    const opened = app.waitForEvent('window');
    await win.locator('[data-action="compact"]').first().click();
    const small = await opened;
    small.on('pageerror', (error) => errors.push(error.message));
    await small.locator(choice).waitFor();
    await small.locator('.companion-tabs [data-id="duels"]').click();
    await small.locator(choice).waitFor();
    assert.equal(
      await small.locator(choice).count(),
      1,
      'the current choice remains available on another companion tab',
    );
    for (const surface of [win, small]) {
      const materials = surface.locator(choice + ' > .flow-material-brief');
      assert(await materials.isVisible(), 'live choice requirements stay visible before expansion');
      assert.match(await materials.innerText(), /铁矿石[\s\S]*需 4[\s\S]*后山山洞/);
      assert.match(await materials.innerText(), /库存未读取/);
    }
    await small.screenshot({ path: path.join(output, 'live-choice-brief.png'), animations: 'disabled' });
    await checkBodyPreviews(small, 5);
    await small.locator(choice + ' > details > summary').click();
    assert.match(
      await small.locator(choice + ' .flow-choices').innerText(),
      /买把新的比较好.*重新锻造一番吧/s,
    );
    await small.locator(choice + ' > details > summary').evaluate((el) => el.focus({ preventScroll: true }));
    const dockScroll = await small.locator('.live-choice-dock').evaluate((el) => {
      el.scrollTop = 80;
      return el.scrollTop;
    });
    assert(dockScroll > 0, 'expanded choice details have their own scroll position');
    await small.evaluate(() => {
      window.__syntheticDock = document.querySelector('.live-choice-dock');
    });
    await small.evaluate(() => window.journal.mutate({ type: 'settings', value: { autoBackup: false } }));
    await small.waitForFunction(() => !window.__syntheticDock.isConnected);
    await small.locator(choice + ' > details[open]').waitFor();
    assert.equal(await small.locator('.live-choice-dock').evaluate((el) => el.scrollTop), dockScroll);
    assert.equal(
      await small.locator(choice + ' > details > summary').evaluate((el) => document.activeElement === el),
      true,
    );
    await small.screenshot({ path: path.join(output, 'live-choice-on-duels.png'), animations: 'disabled' });
    const oldChoice = writeSave([
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
    ]);
    current = null;
    pulse();
    await small.locator(choice).waitFor({ state: 'detached', timeout: 5000 });
    await win.locator(choice).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(
      await small.evaluate(async () =>
        (await window.journal.companionSnapshot()).data.flow.decisions.some(
          (r) => r.id === 'early-woodcutter-axe-choice',
        ),
      ),
      false,
    );
    await small.locator('.duel-all > summary').click();
    const compactScroll = await small.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 650;
      return el.scrollTop;
    });
    assert(compactScroll > 400, 'the companion starts deep in a real long page');
    await small.locator('.duel-all > summary').evaluate((el) => el.focus({ preventScroll: true }));
    current = packet({ sequence: 7 });
    pulse();
    await small.locator(choice).waitFor({ timeout: 5000 });
    assert(await small.locator('.live-choice-dock ' + choice).isVisible());
    assert.equal(await small.locator('.compact-body').evaluate((el) => el.scrollTop), compactScroll);
    assert.equal(
      await small.locator('.duel-all > summary').evaluate((el) => document.activeElement === el),
      true,
    );
    const bounds = await small.locator(choice).boundingBox();
    assert.equal(
      await small.locator(choice + ' > details').evaluate((el) => el.open),
      false,
      'a newly opened native choice starts concise; only the same window retains its reading state',
    );
    assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= (await small.evaluate(() => innerHeight)));
    // Exercise the real navigation handler for the task page not present in the short tab strip.
    await small.evaluate(() => {
      const link = document.createElement('button');
      link.dataset.action = 'navigate';
      link.dataset.id = 'checklist';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    await small.locator('.flow-legacy').waitFor();
    assert.equal(
      await small.locator(choice).count(),
      1,
      'the full task page does not duplicate its live card',
    );
    current = packet({ sequence: 8, questId: 5076, npcId: 10016 });
    pulse();
    await small.locator(choice).waitFor({ state: 'detached', timeout: 5000 });
    const beforeUnknown = await small.locator('.flow-panel').elementHandle();
    session = '1800000001-123456';
    current = packet({
      sequence: 9,
      questId: 999999,
      npcId: 0,
      options: [{ index: 1, text: '继续' }],
    });
    pulse();
    await small.waitForFunction((node) => !node.isConnected, beforeUnknown);
    await win.locator('.sidebar-nav [data-id="home"]').click();
    for (const surface of [win, small]) {
      assert.equal(await surface.locator(choice).count(), 0);
      assert.equal(
        await surface.locator('[data-flow-suggestion="early-woodcutter-axe-choice"]').count(),
        0,
        'a new single-option session cannot leak the never-observed saved choice as advice',
      );
    }
    const beforeMultiple = await small.locator('.flow-panel').elementHandle();
    session = '1800000002-123456';
    current = packet({ sequence: 10, questId: 999999, npcId: 0 });
    pulse();
    await small.waitForFunction((node) => !node.isConnected, beforeMultiple);
    for (const surface of [win, small]) {
      assert.equal(await surface.locator(choice).count(), 0);
      assert.equal(await surface.locator('[data-flow-suggestion="early-woodcutter-axe-choice"]').count(), 0);
    }
    current = packet({
      sequence: 11,
      questId: 5078,
      npcId: 10016,
      options: [
        { index: 1, text: '剑系武器' },
        { index: 2, text: '拳系武器' },
        { index: 3, text: '刀系武器' },
      ],
    });
    pulse();
    for (const surface of [win, small]) {
      await surface.locator('[data-flow-decision="early-jingyin-weapon-choice"]').waitFor();
      assert.equal(
        await surface.locator('[data-flow-suggestion="early-woodcutter-axe-choice"]').count(),
        0,
        'a different matched current choice cannot retain saved choice advice',
      );
    }
    assert.deepEqual(fs.readFileSync(saveFile), oldChoice);
    current = null;
    writeSave([{ id: 5020, step: 1 }]);
    pulse();
    await win.locator('[data-flow-decision="early-jingyin-weapon-choice"]').waitFor({ state: 'detached' });
    await win.locator('.sidebar-nav [data-id="checklist"]').click();
    const offlineQuest = win
      .locator('.flow-guide [data-flow-rule="early-woodcutter-axe-choice"] [data-id="quest-11002"]')
      .first();
    await offlineQuest.evaluate((el) => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      el.scrollIntoView({ block: 'center' });
      el.focus();
    });
    await win.locator('#entity-preview').waitFor({ state: 'visible' });
    const oldOfflineQuest = await offlineQuest.elementHandle();
    current = packet({ sequence: 12 });
    pulse();
    await win.waitForFunction((node) => !node.isConnected, oldOfflineQuest);
    assert.equal(
      await offlineQuest.evaluate((el) => document.activeElement === el),
      true,
      'a new dock copy does not steal focus from the offline guide',
    );
    await win.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.equal(await offlineQuest.getAttribute('aria-describedby'), 'entity-preview');
    assert((await win.locator('.live-choice-dock [data-id="quest-11002"]').count()) > 0);
    const stockQuests = [
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
    ];
    const stock = (count, sequence) => {
      const bytes = writeSave(stockQuests, [{ id: 10201, count }]);
      current = { ...current, sequence };
      pulse();
      return bytes;
    };
    stock(5, 13);
    await win.locator('[data-action="search"]').first().click();
    await win.locator('#global-search').fill('铁矿石');
    const searchItem = win.locator('.search-result[data-id="item-10201"]').first();
    await searchItem.hover();
    await win.locator('#entity-preview').filter({ hasText: '保存持有 5' }).waitFor();
    const keptSearch = await searchItem.elementHandle();
    stock(9, 14);
    await win.locator('#entity-preview').filter({ hasText: '保存持有 9' }).waitFor({ timeout: 10000 });
    assert.equal(await keptSearch.evaluate((el) => el.isConnected), true, 'search markup remains connected');
    await win.locator('#global-search').fill('樵夫的斧子');
    await win.locator('.search-result[data-id="quest-11002"]').click();
    await win
      .locator('[data-task-relations] > details > summary')
      .filter({ hasText: '全部步骤用料' })
      .click();
    const taskItem = win.locator('[data-task-relations] [data-id="item-10201"]').first();
    assert.equal(await taskItem.isVisible(), true);
    await taskItem.scrollIntoViewIfNeeded();
    await taskItem.focus();
    await win.locator('#entity-preview').filter({ hasText: '保存持有 9' }).waitFor();
    const oldTaskItem = await taskItem.elementHandle();
    stock(13, 15);
    await win.waitForFunction((node) => !node.isConnected, oldTaskItem);
    await win.locator('#entity-preview').filter({ hasText: '保存持有 13' }).waitFor({ timeout: 10000 });
    assert.equal(
      await taskItem.evaluate((el) => document.activeElement === el),
      true,
      'world task overlay refresh preserves its reference focus',
    );
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="search"]').first().click();
    await win.locator('#global-search').fill('铁锭');
    await win.locator('.search-result[data-id="fusion-9500"]').click();
    const recipeItem = win.locator('.drawer-body [data-id="item-10201"]').first();
    await recipeItem.scrollIntoViewIfNeeded();
    await recipeItem.focus();
    await win.locator('#entity-preview').filter({ hasText: '保存持有 13' }).waitFor();
    const oldRecipeItem = await recipeItem.elementHandle();
    const lastStock = stock(17, 16);
    await win.waitForFunction((node) => !node.isConnected, oldRecipeItem);
    await win.locator('#entity-preview').filter({ hasText: '保存持有 17' }).waitFor({ timeout: 10000 });
    assert.equal(
      await recipeItem.evaluate((el) => document.activeElement === el),
      true,
      'database overlay refresh preserves its reference focus',
    );
    assert.deepEqual(fs.readFileSync(saveFile), lastStock);
    for (const [index, surface] of [win, small].entries()) {
      if (await surface.locator('#overlay [data-action="close-overlay"]').count())
        await surface.locator('#overlay [data-action="close-overlay"]').first().click();
      current = null;
      pulse();
      await surface.locator('.live-choice-dock').waitFor({ state: 'detached' });
      await surface.locator('[data-action="search"]').first().click();
      const input = surface.locator('#global-search');
      await input.fill('铁');
      await input.pressSequentially('矿石');
      await input.press('Control+z');
      const undoValue = await input.inputValue();
      await input.press('Control+y');
      assert.equal(await input.inputValue(), '铁矿石');
      const keptInput = await input.elementHandle();
      current = packet({ sequence: 100 + index * 4 });
      pulse();
      const visibleDock = surface.locator('#overlay .live-choice-dock');
      await visibleDock.waitFor({ state: 'visible' });
      assert.equal(await keptInput.evaluate((el) => el.isConnected && document.activeElement === el), true);
      assert.equal(await surface.locator('.live-choice-dock').count(), 1);
      await input.press('Control+z');
      assert.equal(await input.inputValue(), undoValue, 'live arrival retains the native search undo stack');
      await input.press('Control+y');
      const assertExposed = async () => {
        assert.equal(
          await visibleDock.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return (
              box.height > 40 &&
              box.top >= 0 &&
              box.bottom <= innerHeight + 1 &&
              el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 20))
            );
          }),
          true,
          'the current choice is painted above the active reader',
        );
      };
      await assertExposed();
      await surface.locator('.search-result[data-id="item-10201"]').first().click();
      await surface.locator('.drawer-body h1').waitFor();
      await assertExposed();
      assert.equal(await surface.locator('.live-choice-dock').count(), 1);
      await surface.locator('#overlay [data-action="close-overlay"]').first().click();
      if (index) {
        await surface.locator('.companion-tabs [data-id="database"]').click();
        await chooseCodexKind(surface, '地点');
      } else await surface.locator('.sidebar-nav [data-id="world"]').click();
      if (await surface.locator('[data-action="world-kind"][data-id="places"]').count())
        await surface.locator('[data-action="world-kind"][data-id="places"]').click();
      await surface.locator('.place-map-pin[aria-label="查看梧桐村"]').click();
      await surface.locator('.drawer .place-map-frame').waitFor();
      current = null;
      pulse();
      await visibleDock.waitFor({ state: 'detached' });
      const mapControl = surface.locator('.drawer [data-action="place-map-scope"]').first();
      await mapControl.focus();
      const keptMap = await mapControl.elementHandle();
      current = packet({ sequence: 101 + index * 4 });
      pulse();
      await visibleDock.waitFor({ state: 'visible' });
      assert.equal(await keptMap.evaluate((el) => el.isConnected && document.activeElement === el), true);
      await assertExposed();
      await surface.screenshot({
        path: path.join(output, `live-choice-reader-${index}.png`),
        animations: 'disabled',
      });
      current = null;
      pulse();
      await visibleDock.waitFor({ state: 'detached' });
      await surface.locator('.drawer .place-map-frame').waitFor({ state: 'visible' });
      await surface.locator('#overlay [data-action="close-overlay"]').first().click();
    }
    async function checkPageSearch(surface, field, sequence) {
      const input = surface.locator('#' + field);
      await input.scrollIntoViewIfNeeded();
      await input.fill('铁');
      await input.pressSequentially('矿石');
      const kept = await input.elementHandle();
      await input.press('Control+z');
      const undoValue = await input.inputValue();
      assert.notEqual(undoValue, '铁矿石', field + ' supports native undo after typing');
      await input.press('Control+y');
      assert.equal(await input.inputValue(), '铁矿石');
      current = packet({ sequence });
      pulse();
      await surface.locator('.live-choice-dock').waitFor({ state: 'visible' });
      assert.equal(await kept.evaluate((el) => el.isConnected && document.activeElement === el), true);
      await input.press('Control+z');
      assert.equal(await input.inputValue(), undoValue, field + ' preserves undo across live arrival');
      await input.press('Control+y');
      current = null;
      pulse();
      await surface.locator('.live-choice-dock').waitFor({ state: 'detached' });
      assert.equal(await kept.evaluate((el) => el.isConnected && document.activeElement === el), true);
      await input.press('Control+z');
      assert.equal(await input.inputValue(), undoValue, field + ' preserves undo across live retirement');
      await input.press('Control+y');
      assert.equal(await input.inputValue(), '铁矿石');
    }
    await win.locator('.sidebar-nav [data-id="database"]').click();
    await checkPageSearch(win, 'list-search', 120);
    for (const [index, [route, field]] of [
      ['world', 'world-search'],
      ['materials', 'craft-search'],
      ['journey', 'journey-search'],
      ['recipe-discovery', 'recipe-discovery-search'],
    ].entries()) {
      if (route === 'recipe-discovery') {
        await win.locator('.sidebar-nav [data-id="materials"]').click();
        await win.locator('[data-action="recipe-discovery-open"]').first().click();
      } else await win.locator('.sidebar-nav [data-id="' + route + '"]').click();
      await checkPageSearch(win, field, 150 + index);
    }
    for (const [index, surface] of [win, small].entries()) {
      await surface
        .locator(index ? '.companion-tabs [data-id="saves"]' : '.sidebar-nav [data-id="saves"]')
        .click();
      const timelineFold = surface.locator('details[data-persist-detail="unused-timeline"] > summary');
      if (await timelineFold.count()) await timelineFold.click();
      await checkPageSearch(surface, 'timeline-search', 121 + index);
    }
    {
      const surface = win;
      await surface.locator('.sidebar-nav [data-id="journal"]').click();
      const form = surface.locator('#journal-filter-form');
      await form.waitFor();
      await surface.locator('#journal-search').fill('白');
      await surface.locator('#journal-search').pressSequentially('锦');
      await surface.locator('#journal-from').fill('2026-10-01');
      await surface.locator('#journal-to').fill('2026-10-14');
      await surface.locator('#journal-kind').selectOption('manual');
      await surface.locator('#journal-tag').selectOption('支线');
      await surface.locator('#journal-from').focus();
      const keptForm = await form.elementHandle();
      const expected = ['白锦', '2026-10-01', '2026-10-14', 'manual', '支线'];
      const values = () => form.locator('input,select').evaluateAll((rows) => rows.map((el) => el.value));
      current = packet({ sequence: 125 });
      pulse();
      await surface.locator('.live-choice-dock').waitFor({ state: 'visible' });
      assert.equal(
        await keptForm.evaluate((el) => el.isConnected && el.contains(document.activeElement)),
        true,
      );
      assert.deepEqual(await values(), expected, 'live arrival preserves the complete pending filter group');
      current = null;
      pulse();
      await surface.locator('.live-choice-dock').waitFor({ state: 'detached' });
      assert.deepEqual(await values(), expected, 'retirement does not submit or clear pending filters');
      {
        await surface.evaluate(() =>
          window.journal.mutate({
            type: 'journal-entry-put',
            title: '其他记录',
            body: '合成标签更新',
            tags: ['探索'],
            links: [],
            snapshotMode: 'none',
            occurredAt: '2026-10-14T00:00:00.000Z',
          }),
        );
        await form.locator('#journal-tag option[value="探索"]').waitFor({ state: 'attached' });
        assert.deepEqual(await values(), expected, 'new tags update without clearing pending criteria');
      }
      const search = surface.locator('#journal-search');
      await search.focus();
      await search.press('Control+z');
      assert.equal(await search.inputValue(), '白', 'the inactive query keeps its native undo history');
      await search.press('Control+y');
      assert.equal(await search.inputValue(), '白锦');
      await form.locator('[data-action="journal-filter"]').click();
      assert.equal(
        await surface.locator('[data-journal-id]').count(),
        1,
        'the preserved filters still apply normally',
      );
    }
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact=1'));
      w.setMinimumSize(200, 90);
      w.setBounds({ ...w.getBounds(), width: 320, height: 112 });
      w.webContents.send('journal:companion', { mode: 'hint', visible: true });
    });
    const rules = require('../src/data/flow-guide.cjs').rules;
    const nativePackets = [
      ['chenlinxi-critical-choice', 12079, ['好言相劝', '义正辞严']],
      ['tianji-rebuild-choice', 24063, ['重建天机宫', '回绝此事']],
      ['changsheng-rescue-choice', 8861, ['置之不理', '出手相救']],
    ];
    for (const [index, [id, questId, options]] of nativePackets.entries()) {
      const rule = rules.find((row) => row.id === id);
      current = packet({
        sequence: 130 + index,
        questId,
        npcId: 0,
        options: options.map((text, i) => ({ index: i + 1, text })),
      });
      pulse();
      await small.locator('.hint-caution').filter({ hasText: rule.recommendation.caution }).waitFor();
      assert.equal(await small.locator('.hint-line').count(), 2);
      assert.equal(
        await small.locator('.hint-caution > span').evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const box = range.getBoundingClientRect();
          return box.bottom <= innerHeight && box.right <= innerWidth && box.left >= 0;
        }),
        true,
        id + ' complete consequence fits the default passive window',
      );
      await small.screenshot({ path: path.join(output, 'passive-' + id + '.png'), animations: 'disabled' });
    }
    assert.deepEqual(fs.readFileSync(saveFile), lastStock);
    assert.deepEqual(errors, []);
    console.log(
      'Live guidance PASS: pre-save advice, both windows, other tab, close retirement, reopen and unmatched-dialogue isolation;',
      output,
    );
  } finally {
    clearInterval(timer);
    await app?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
