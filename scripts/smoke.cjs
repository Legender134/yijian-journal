'use strict';
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
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
async function entityPreview(page, trigger, expected, name, throughRefresh = false) {
  await trigger.hover();
  const preview = page.locator('#entity-preview');
  await preview.waitFor({ state: 'visible' });
  assert.match(await preview.innerText(), expected);
  if (throughRefresh) {
    const entry = await trigger.elementHandle();
    const scroll = await page.locator('.content').evaluate((el) => el.scrollTop);
    await page.waitForTimeout(5300);
    assert.equal(
      await entry.evaluate((el) => el.isConnected),
      true,
      'unchanged polling retains the hovered entry',
    );
    assert.equal(await preview.isVisible(), true, 'preview survives the background refresh');
    assert.equal(await page.locator('.content').evaluate((el) => el.scrollTop), scroll);
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
  await page.mouse.move(rect.x + 15, rect.y + 15);
  await page.waitForTimeout(220);
  assert.equal(await preview.isVisible(), true, 'preview stays open while moving into it');
  await page.screenshot({ animations: 'disabled', path: path.join(results, name + '.png') });
  await page.keyboard.press('Escape');
  assert.equal(await preview.isVisible(), false);
  await page.mouse.move(2, 2);
  await trigger.focus();
  await preview.waitFor({ state: 'visible' });
  assert.match(await preview.innerText(), expected);
  await page.keyboard.press('Escape');
  assert.equal(await preview.isVisible(), false);
}
(async () => {
  try {
    app = await launch();
    let win = await attach();
    assert.equal(await win.locator('.start-panel').count(), 1);
    assert.equal(await win.locator('[data-flow]').count(), 1);
    assert.match(await win.locator('[data-flow-unindexed]').innerText(), /1 条进行中记录待识别/);
    await win.locator('[data-flow-unindexed] summary').click();
    assert.match(await win.locator('[data-flow-unindexed]').innerText(), /#999999/);
    await win.locator('[data-flow-quest="quest-5200"]').waitFor();
    assert.match(await win.locator('[data-flow-quest="quest-5200"]').innerText(), /当前行动/);
    const flowProgress = win.locator('[data-flow-quest="quest-5200"] .flow-task-progress');
    assert.match(await flowProgress.locator('summary').innerText(), /进行中 1/);
    await flowProgress.locator('summary').click();
    assert.match(await flowProgress.innerText(), /只列本次已保存的步骤记录/);
    assert.equal(await win.locator('[data-flow-quest="quest-11077"] .flow-step h4').count(), 0);
    assert.match(
      await win.locator('[data-flow-quest="quest-11077"] .flow-next-action').innerText(),
      /具体步骤.*核对游戏任务栏/,
    );
    const flowFirst = await win.evaluate(() => {
      const flow = document.querySelector('[data-flow]');
      const personal = document.querySelector('.home-journey, [data-home-itinerary]');
      return !personal || !!(flow.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(flowFirst, true, 'saved quest guidance must precede personal journey planning');
    const flowMaterials = win.locator('[data-flow-quest="quest-14073"] .flow-materials');
    assert.match(await flowMaterials.innerText(), /茯苓.*川芎/s);
    await flowMaterials.locator('summary').first().click();
    await win.locator('[data-action="refresh"]').click();
    assert.equal(await flowProgress.evaluate((el) => el.open), true);
    assert.equal(
      await flowMaterials
        .locator('details')
        .first()
        .evaluate((el) => el.open),
      true,
    );
    assert.equal(await win.locator('.start-panel details').evaluate((el) => el.open), false);
    assert.equal(await win.locator('[data-persist-detail="home-stage"]').evaluate((el) => el.open), false);
    await win.locator('.start-panel summary').click();
    await win.waitForFunction(() => document.querySelector('.start-panel details')?.open);
    await win.locator('[data-action="refresh"]').click();
    await win.waitForFunction(() =>
      document.querySelector('#toasts')?.textContent.includes('已刷新本机存档'),
    );
    assert.equal(await win.locator('.start-panel details').evaluate((el) => el.open), true);
    await win.locator('.start-panel summary').click();
    const firstUse = await win.evaluate(async () => (await window.journal.bootstrap()).data);
    assert.equal(firstUse.state.settings.autoBackup, true);
    assert.equal(firstUse.state.profiles[0].referenceMode, 'latest');
    assert.equal(firstUse.environment.timeline.enabled, false);
    const deniedStart = await win.evaluate(() => window.journal.startAssistance());
    assert.equal(deniedStart.ok, false);
    assert.match(deniedStart.error, /测试环境/);
    await win.waitForFunction(() =>
      document.querySelector('.home-protection')?.textContent.includes('1 份完整保护副本'),
    );
    const automatic = (await win.evaluate(async () => (await window.journal.refresh()).data.backups)).find(
      (b) => b.kind === 'auto',
    );
    assert.ok(automatic);
    await win.waitForFunction(() =>
      document.querySelector('.save-health')?.textContent.includes('完整备份守护中'),
    );
    assert.match(await win.locator('.save-health').first().getAttribute('title'), /游戏内自动存档尚未开启/);
    assert.deepEqual(fs.readFileSync(path.join(fakeSaves, '1.sav')), originalSave);
    assert.deepEqual(
      fs.readFileSync(path.join(data, 'save-backups', automatic.id, 'files', '1.sav')),
      originalSave,
    );
    await win.screenshot({ animations: 'disabled', path: path.join(results, '01-home.png') });
    await entityPreview(
      win,
      win.locator('[data-flow] [data-id="npc-5003"]').first(),
      /人物.*清虚道长.*相关任务/s,
      '01-main-person-preview',
    );
    await entityPreview(
      win,
      win.locator('[data-flow-quest="quest-5200"] h3 [data-id="quest-5200"]'),
      /任务.*1\.sav · 进行中/s,
      '01-main-task-preview',
    );
    await entityPreview(
      win,
      flowMaterials.locator('[data-action="database-detail"]').first(),
      /物品.*模板基础/s,
      '01-main-item-preview',
      true,
    );
    await win.locator('[data-flow] [data-id="npc-5003"]').first().click();
    assert.equal(await win.locator('[data-person-relations]').isVisible(), true);
    await win.locator('[data-person-relations] [data-id="quest-5200"]').first().click();
    assert.equal(await win.locator('[data-task-relations]').isVisible(), true);
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('[data-person-relations]').isVisible(), true);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="save-slot"]').click();
    await win.locator('#save-slot-select').selectOption('2.sav');
    await win.locator('[data-action="save-slot-save"]').click();
    assert.equal(await win.evaluate(async () => (await window.journal.refresh()).data.recent.name), '2.sav');
    assert.ok((await win.locator('.hero').innerText()).includes('2 时 0 分'));
    const currentChoice = win.locator('[data-flow-decision="early-woodcutter-axe-choice"]');
    assert.equal(await currentChoice.isVisible(), true);
    assert.match(await currentChoice.innerText(), /700.*2000/s);
    assert.match(
      await currentChoice.locator('.flow-recommendation').innerText(),
      /推荐做法.*重新锻造.*为什么.*亮银甲.*取舍.*武学笔记/s,
    );
    assert.equal(
      await currentChoice.locator('.flow-recommendation').evaluate((el) => !!el.closest('details')),
      false,
    );
    assert.equal(
      await currentChoice.locator('.flow-choices').evaluate((el) => !!el.closest('details')),
      false,
    );
    const armorChoice = currentChoice.locator('.flow-recommendation [data-id="name:亮银甲"]').first();
    await entityPreview(win, armorChoice, /同名资料.*同名不等于/s, '01-same-name-preview');
    await armorChoice.click();
    await win.locator('[aria-label="选择同名资料"]').waitFor();
    await win.locator('[aria-label="选择同名资料"] [data-id="item-9004"]').click();
    await win.locator('[data-item-statistics]').waitFor();
    assert.match(await win.locator('.drawer-body').innerText(), /2\.sav/);
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[aria-label="选择同名资料"]').waitFor();
    await win.locator('[data-action="close-overlay"]').click();
    const choiceWindowReady = app.waitForEvent('window');
    await win.locator('[data-action="compact"]').first().click();
    const choiceCompact = await choiceWindowReady;
    await choiceCompact.waitForSelector('.compact-shell');
    await choiceCompact.locator('[data-flow-decision="early-woodcutter-axe-choice"]').waitFor();
    await entityPreview(
      choiceCompact,
      choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]'),
      /任务.*相关步骤/s,
      '01-companion-task-preview',
    );
    await entityPreview(
      choiceCompact,
      choiceCompact
        .locator(
          '[data-flow-decision="early-woodcutter-axe-choice"] .flow-recommended-action [data-id="item-10201"]',
        )
        .first(),
      /物品.*铁矿石.*2\.sav · 库存/s,
      '01-companion-item-preview',
    );
    await choiceCompact.locator('[data-flow-now] > h3 [data-id="quest-11002"]').click();
    await choiceCompact.locator('[data-task-relations]').waitFor();
    await entityPreview(
      choiceCompact,
      choiceCompact
        .locator('[data-task-relations] [data-action="database-detail"][data-id="npc-10005"]')
        .first(),
      /人物.*相关任务/s,
      '01-companion-person-preview',
    );
    await choiceCompact.locator('[data-action="close-overlay"]').click();
    await choiceCompact.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 0;
    });
    const compactRisk = choiceCompact.locator('.flow-compact-risks');
    assert.equal(await compactRisk.evaluate((el) => el.open), false);
    const currentPosition = await choiceCompact
      .locator('[data-flow-decision="early-woodcutter-axe-choice"] .flow-recommended-action')
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
    assert.match(await compactRisk.locator('summary').first().innerText(), /7 项推进提醒/);
    assert.equal(await choiceCompact.locator('.companion-reference').count(), 0);
    assert.equal(await choiceCompact.locator('.flow-compact-reference').count(), 1);
    const actionPosition = await choiceCompact
      .locator('[data-flow-now] > .flow-next-action')
      .evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }));
    assert(actionPosition.bottom <= actionPosition.viewport, JSON.stringify(actionPosition));
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-first-screen.png'),
    });
    const compactChoiceDetails = choiceCompact.locator('.flow-choice-details');
    await compactChoiceDetails.locator('summary').click();
    assert.match(await compactChoiceDetails.innerText(), /700.*2000/s);
    await compactChoiceDetails.locator('summary').click();
    await compactRisk.locator('summary').first().click();
    assert.equal(await compactRisk.locator('.flow-risk').first().isVisible(), true);
    await compactRisk.locator('summary').first().click();
    await choiceCompact.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 0;
    });
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-current-choice.png'),
    });
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
    assert.match(await innChallenge.innerText(), /静态等级 30.*梧桐村.*客栈.*七品拳套图纸/s);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="home"]').click();
    await choiceCompact.locator('.flow-impact-summary').waitFor();
    assert.match(await choiceCompact.locator('.flow-impact-summary').innerText(), /吕轻祈.*雷万钧.*岳九/);
    await choiceCompact.locator('.companion-tabs [data-action="navigate"][data-id="duels"]').click();
    await choiceCompact.screenshot({
      animations: 'disabled',
      path: path.join(results, '01-compact-duels.png'),
    });
    await innChallenge.locator(':scope > summary').click();
    assert.match(await innChallenge.innerText(), /准备与实力.*2932/s);
    await innChallenge.locator('details > summary').click();
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
          ?.textContent.includes('前置记录仍待核对'),
      null,
      { timeout: 18000 },
    );
    assert.equal(await innChallenge.evaluate((el) => el.open), true);
    assert.equal(await innChallenge.locator('details').evaluate((el) => el.open), true);
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
      () => document.querySelector('.flow-impact-summary')?.textContent.includes('智度上人'),
      null,
      { timeout: 18000 },
    );
    assert.doesNotMatch(await choiceCompact.locator('.flow-impact-summary').innerText(), /吕轻祈/);
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
      assert.match(
        (await card.locator('.flow-recommendation').innerText()).replace(/\s+/g, ''),
        scenario.expected,
      );
      const position = await card.locator('.flow-recommended-action').evaluate((el) => ({
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
        assert.match(
          (await card.locator('.flow-choice-details').innerText()).replace(/\s+/g, ''),
          scenario.detailsExpected,
        );
        await card.locator('.flow-choice-details > summary').click();
      }
      writeChoice([...records, { id: scenario.exit, step: scenario.exitStep }]);
      await card.waitFor({ state: 'detached', timeout: 18000 });
      assert.equal(await choiceCompact.locator(`[data-flow-warning="${scenario.id}"]`).count(), 0);
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
    await win.locator('[data-action="refresh"]').click();
    const rosterWarning = win.locator('[data-flow-warning="late-roster-before-wudang"]');
    await rosterWarning.waitFor();
    assert.match(await rosterWarning.locator('.flow-warning-message').innerText(), /回武当前.*旧版/);
    assert.match(
      await win.locator('[data-flow-quest="quest-8830"] .flow-next-action').innerText(),
      /返回武当/,
    );
    const returnPlaces = win.locator('[data-flow-quest="quest-8830"] .flow-places p');
    assert.equal(await returnPlaces.count(), 2);
    assert.match(await returnPlaces.nth(0).innerText(), /武当派/);
    assert.match(await returnPlaces.nth(1).innerText(), /名剑山庄/);
    await rosterWarning.locator('summary').click();
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
    await win.locator('[data-action="refresh"]').click();
    assert.equal(await rosterWarning.count(), 0);
    assert.match(await win.locator('[data-flow-quest="quest-5920"] .flow-next-action').innerText(), /阎浮镇/);
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
    await win.locator('[data-action="refresh"]').click();
    const yuanqiWarning = win.locator('[data-flow-warning="yuanqi-return-followthrough"]');
    await yuanqiWarning.waitFor();
    assert.match(await win.locator('.flow-chapter').innerText(), /下一主线关键节点.*天佛窟/s);
    assert.equal(
      await win.locator('.flow-chapter [data-action="source"][data-id="flow:biliLateFlow"]').count(),
      1,
    );
    assert.match(await yuanqiWarning.locator('.flow-warning-message').innerText(), /前半段.*不等于/);
    assert.match(
      await win.locator('[data-flow-quest="quest-20100"] .flow-next-action').innerText(),
      /天剑宗/,
    );
    await yuanqiWarning.locator('summary').click();
    assert.match(await yuanqiWarning.innerText(), /断剑.*笔记.*上官虹.*叶飞/s);
    assert.match(await yuanqiWarning.innerText(), /不保证.*必然存活/s);
    fs.writeFileSync(path.join(fakeSaves, '2.sav'), choiceSave);
    fs.utimesSync(path.join(fakeSaves, '2.sav'), new Date('2025-01-01'), new Date('2025-01-01'));
    await win.locator('[data-action="refresh"]').click();
    fs.renameSync(path.join(fakeSaves, '2.sav'), path.join(data, 'held-2.sav'));
    await win.locator('[data-action="refresh"]').click();
    assert.ok((await win.locator('.content').innerText()).includes('不会自动改用其他槽位'));
    assert.equal(await win.evaluate(async () => (await window.journal.refresh()).data.recent), null);
    assert.match(await win.locator('.flow-empty').innerText(), /固定参照「2.sav」/);
    await win.locator('.flow-empty [data-action="save-slot"]').click();
    assert.equal(await win.locator('#save-slot-select').inputValue(), '2.sav');
    await win.locator('[data-action="close-overlay"]').first().click();
    fs.renameSync(path.join(data, 'held-2.sav'), path.join(fakeSaves, '2.sav'));
    await win.locator('[data-action="refresh"]').click();
    await win.locator('[data-action="save-slot"]').click();
    await win.locator('#save-slot-select').selectOption('@latest');
    await win.locator('[data-action="save-slot-save"]').click();
    await win.locator('[data-action="save-quest-jump"][data-id="5200"]').first().click();
    assert.equal(await win.locator('.save-recorded-quests').evaluate((e) => e.open), true);
    assert.equal(await win.locator('[data-quest-id="5200"] details').evaluate((e) => e.open), true);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#note').fill('测试随手记：下次去青木舫。');
    await win.waitForTimeout(1000);
    await win.locator('[data-action="goal-add"]').first().click();
    await win.locator('#goal-title').fill('测试目标 <script>你好</script>');
    await win.locator('#goal-detail').fill('目标说明 & 特殊字符');
    await win.locator('[data-action="goal-save"]').click();
    await win.locator('.nav-btn[data-id="checklist"]').click();
    assert.match(
      await win.locator('[data-flow-rule="conditions-13408"]').innerText(),
      /部分条件满足 · 仍待核对/,
    );
    assert.equal(await win.locator('[data-flow-rule="conditions-11442"]').count(), 0);
    await win.locator('.flow-guide > summary').click();
    const completedGuide = win.locator('.flow-guide [data-flow-rule="lotus-meeting"]');
    assert.equal(await completedGuide.locator('.pill').first().innerText(), '已完成');
    assert.match(await completedGuide.innerText(), /存档已记录完成/);
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
    await win.locator('.entry-card').first().click();
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
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('长虹剑精良图纸');
    await win.locator('.database-card').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('3,396'));
    await win.locator('#recipe-materials [data-id="item-10226"]').click();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('精钢锭'));
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.match(await win.locator('.reference-freshness').innerText(), /新存档同步/);
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
    await win.locator('#recipe-save').selectOption('');
    assert.equal(await win.locator('#recipe-materials .material-owned').count(), 0);
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await win.locator('#recipe-save').selectOption('1.sav');
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
      w.setBounds({ ...w.getBounds(), width: 460, height: 660 });
      w.webContents.send('journal:companion', { mode: 'expanded', visible: true });
    });
    await quick.locator('.compact-shell').waitFor();
    await quick.waitForFunction(() => innerWidth >= 450 && innerHeight >= 640);
    await quick.locator('[data-action="companion-collapse"]').click();
    assert.equal(
      await quick.evaluate(async () => (await window.journal.companionSnapshot()).data.mode),
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
    await app.close();
    app = await launch();
    win = await attach();
    assert.equal(await win.locator('#note').inputValue(), '测试随手记：下次去青木舫。');
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
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
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
    await win.waitForSelector('.start-panel');
    assert.equal(
      await win.locator('.start-panel .btn.primary').getAttribute('data-action'),
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
    await win.waitForSelector('.start-panel');
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'launch');
    assert.match(await win.locator('.start-panel').innerText(), /开始游戏会直接启动/);
    await win.locator('.start-panel summary').click();
    assert.equal(await win.locator('.start-panel details [data-action="start-assistance"]').count(), 1);
    // Exercise the one-click setup's failure presentation without allowing game access.
    await win.locator('.start-panel .btn.primary').evaluate((el) => {
      el.dataset.action = 'start-assistance';
    });
    await win.locator('.start-panel .btn.primary').click();
    await win.waitForFunction(() =>
      document.querySelector('.start-panel h2')?.textContent.includes('自动存档暂未准备好'),
    );
    assert.match(await win.locator('.start-panel').innerText(), /测试环境/);
    await win.locator('[data-action="refresh"]').click();
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
