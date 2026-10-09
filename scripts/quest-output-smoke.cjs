'use strict';
// Real source / exact packaged assistant UI, isolated synthetic saves only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const { stableId } = require('../src/core/journey-plan.cjs');
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
const data = path.join(base, '.test-data', 'quest-output-ui-' + Date.now());
const userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames');
fs.mkdirSync(source, { recursive: true });
const file = path.join(source, '1.sav');
const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inventory = [
  { id: 10216, count: 3 },
  { id: 10246, count: 2 },
  { id: 10205, count: 2 },
];
let expectedHash;
function save(quests) {
  const before = fs.existsSync(file) ? hash() : null;
  fs.writeFileSync(
    file,
    syntheticSave({
      full: true,
      map: 'LV_20_P',
      quests,
      inventory,
      fusionRecipes: [1001, 1101],
      trackingQuest: 11077,
      trackingMainQuest: 0,
    }),
  );
  const settled = new Date(Date.now() - 5000);
  fs.utimesSync(file, settled, settled);
  expectedHash = hash();
  fs.appendFileSync(
    path.join(data, 'fixture-mutations.jsonl'),
    JSON.stringify({
      file,
      before,
      after: expectedHash,
      reason: 'synthetic harness advances quest records',
    }) + '\n',
  );
}
const root = { id: 11077, step: 1 },
  child = { id: 11078, step: 1 },
  otherRoot = { id: 11079, step: 1 };
save([root, otherRoot]);
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '1.sav', mode: 'slot' });
for (const id of ['quest-11077', 'quest-11079'])
  store.mutate({ type: 'goal-add', title: '按自己的打算办 ' + id, source: { type: 'quest', id } });
store.mutate({
  type: 'craft-plan-save',
  name: '合成白光剑精良配方',
  list: [{ id: 'fusion-1001', quantity: 1 }],
  reserved: true,
});
const deterministicPlan = store.get().profiles[0].craftPlans[0].id;
store.mutate({
  type: 'craft-plan-save',
  name: '合成白光剑多品质配方',
  list: [{ id: 'fusion-1101', quantity: 1 }],
  reserved: false,
});
const randomPlan = store.get().profiles[0].craftPlans[0].id;
store.mutate({ type: 'craft-plan-open', id: deterministicPlan });
let app, page, companion;
const checks = [],
  errors = [];
async function api(name, ...args) {
  const response = await page.evaluate(({ name, args }) => window.journal[name](...args), { name, args });
  assert.equal(response.ok, true, response.error);
  return response.data;
}
const current = async () => {
  const boot = await api('bootstrap');
  return boot.state.profiles.find((p) => p.id === boot.state.activeProfileId);
};
const plan = () => api('journeyPlan');
async function until(fn, predicate, message) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error(message);
}
const nav = (id) => page.locator(`.nav-btn[data-id="${id}"]`).click();
const row = (id) => page.locator(`[data-itinerary-step="${id}"]`);
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
async function shot(name, target = page) {
  await target.screenshot({ path: path.join(data, name + '.png'), fullPage: true });
  fs.writeFileSync(path.join(data, name + '.txt'), await target.locator('body').innerText());
}
(async () => {
  try {
    await launch();
    await nav('journey');
    const anchor = stableId('quest', ['quest-11077']),
      otherAnchor = stableId('quest', ['quest-11079']);
    for (const [id, placeId] of [
      [anchor, 'place-13'],
      [otherAnchor, 'place-9'],
    ]) {
      const card = page.locator(`[data-journey-id="${id}"]`);
      await card.locator('[data-itinerary-place]').selectOption(placeId);
      await card.locator('[data-action="journey-itinerary-add"]').click();
    }
    await page.locator('[data-itinerary] [data-action="journey-itinerary-status"][data-id="active"]').click();
    const original = structuredClone((await current()).journey.itinerary);
    save([root, child, otherRoot, { id: 11080, step: 1 }, { id: 11081, step: 1 }]);
    await page.locator('[data-action="journey-refresh"]').click();
    const advanced = await until(
      plan,
      (p) => p.itinerary.next?.action?.questId === 'quest-11078',
      'root did not continue',
    );
    assert.equal(advanced.itinerary.next.status, 'pending');
    assert.equal(advanced.itinerary.next.actionId, anchor);
    assert.equal(advanced.itinerary.next.selectedPlace.id, 'place-13');
    assert.deepEqual((await current()).journey.itinerary, original);
    assert.equal(advanced.goalProgress.find((g) => g.questId === 'quest-11077').status, 'active');
    assert.match(
      await page.locator(`[data-itinerary-next="${anchor}"]`).innerText(),
      /收集药材向洛村郎中换取秘术/,
    );
    await shot('01-root-continues');
    await compact();
    await companion.locator(`[data-itinerary-next="${anchor}"] [data-action="journey-open"]`).click();
    await companion.locator(`[data-journey-id="${stableId('quest', ['quest-11078'])}"]`).waitFor();
    await shot('02-compact-continues', companion);
    await companion.locator('.companion-tabs [data-action="navigate"][data-id="home"]').click();
    await companion.locator('[data-companion-itinerary]').waitFor();
    await companion
      .locator(`[data-itinerary-next="${anchor}"] [data-action="journey-itinerary-handle"]`)
      .click();
    await until(plan, (p) => p.itinerary.steps[0].handled, 'compact handling did not advance');
    assert((await current()).journey.handledActionIds.includes(stableId('quest', ['quest-11078'])));
    assert(!(await current()).journey.handledActionIds.includes(anchor));
    await row(anchor).locator('[data-action="journey-itinerary-handle"]').click();
    await until(plan, (p) => p.itinerary.next?.actionId === anchor, 'main undo failed');
    await page.locator(`[data-itinerary-next="${anchor}"] [data-action="journey-itinerary-handle"]`).click();
    await until(plan, (p) => p.itinerary.steps[0].handled, 'main handling failed');
    await companion.getByText('撤回个人处理、完成计划或本次跳过', { exact: true }).click();
    await companion.locator(`[data-action="journey-itinerary-handle"][data-id="${anchor}"]`).click();
    await until(plan, (p) => p.itinerary.next?.actionId === anchor, 'compact undo failed');
    checks.push('real root-to-child continuation, both-window source navigation, processing and undo');

    for (const [recordStep, label, status] of [
      [2, '已失败', 'failed'],
      [3, '尚未接取', 'not-accepted'],
    ]) {
      save([
        { id: 11077, step: recordStep },
        child,
        otherRoot,
        { id: 11080, step: 1 },
        { id: 11081, step: 1 },
      ]);
      await page.locator('[data-action="journey-refresh"]').click();
      const conflict = await until(
        plan,
        (p) => p.itinerary.steps[0].status === 'unavailable',
        'terminal root still continues',
      );
      assert.equal(conflict.goalProgress.find((g) => g.questId === 'quest-11077').status, status);
      assert.equal(conflict.itinerary.steps[0].action, null);
      assert.equal(conflict.itinerary.steps[0].continuation, null);
      assert.equal(conflict.itinerary.steps[0].completionSource, null);
      for (const target of [page, companion]) {
        const next = target.locator(`[data-itinerary-next="${anchor}"]`);
        await until(
          () => next.innerText(),
          (t) => t.includes(label),
          'terminal record missing from current-step UI',
        );
        assert.equal(await next.locator('[data-action="journey-itinerary-handle"]').count(), 0);
        assert.equal(await next.locator('[data-action="journey-open"]').count(), 0);
      }
      assert.deepEqual((await current()).journey.itinerary, original);
      assert.equal(hash(), expectedHash);
      await shot(`02-terminal-${recordStep}`);
      await shot(`02-terminal-${recordStep}-compact`, companion);
    }
    save([root, child, otherRoot, { id: 11080, step: 1 }, { id: 11081, step: 1 }]);
    await page.locator('[data-action="journey-refresh"]').click();
    await until(
      plan,
      (p) => p.itinerary.next?.action?.questId === 'quest-11078',
      'older active reference did not restore continuation',
    );
    checks.push(
      'failed and unaccepted real parent records stop continuation in both windows; older active reference restores unchanged intent',
    );

    const ambiguous = (await plan()).itinerary.steps[1];
    assert.equal(ambiguous.action, null);
    assert.equal(ambiguous.continuation.candidates.length, 2);
    await page.locator(`[data-itinerary-next="${anchor}"] [data-action="journey-itinerary-handle"]`).click();
    await until(
      plan,
      (p) => p.itinerary.next?.actionId === otherAnchor,
      'ambiguous step did not become next',
    );
    await companion.locator(`[data-itinerary-next="${otherAnchor}"] [data-action="journey-open"]`).waitFor();
    assert.match(
      await companion.locator(`[data-itinerary-next="${otherAnchor}"]`).innerText(),
      /选择接续步骤/,
    );
    await shot('02b-compact-ambiguous-choice', companion);
    await companion.locator(`[data-itinerary-next="${otherAnchor}"] [data-action="journey-open"]`).click();
    const childActionId = stableId('quest', ['quest-11080']);
    const selection = companion
      .locator(`[data-itinerary-step="${otherAnchor}"]`)
      .locator(`[data-itinerary-continuation]:has([data-target-id="${childActionId}"])`);
    await selection.locator('[data-itinerary-place]').selectOption('place-9');
    await selection.locator('[data-action="journey-itinerary-continue"]').click();
    await until(
      plan,
      (p) => p.itinerary.steps[1].action?.questId === 'quest-11080',
      'explicit branch choice failed',
    );
    assert.deepEqual(
      (await current()).journey.itinerary.steps.map((s) => s.actionId),
      [anchor, otherAnchor],
    );
    await companion.locator('.companion-tabs [data-action="navigate"][data-id="home"]').click();
    await companion.locator('[data-companion-itinerary]').waitFor();
    await companion
      .locator(`[data-itinerary-next="${otherAnchor}"] [data-action="journey-itinerary-handle"]`)
      .click();
    await until(plan, (p) => p.itinerary.steps[1].handled, 'selected child compact processing failed');
    await row(otherAnchor).locator('[data-action="journey-itinerary-handle"]').click();
    await until(plan, (p) => !p.itinerary.steps[1].handled, 'selected child main undo failed');
    await page
      .locator(`[data-itinerary-next="${otherAnchor}"] [data-action="journey-itinerary-handle"]`)
      .click();
    await until(plan, (p) => p.itinerary.steps[1].handled, 'selected child main processing failed');
    save([root, child, otherRoot, { id: 11080, step: 4 }, { id: 11082, step: 1 }]);
    await page.locator('[data-action="journey-refresh"]').click();
    const changedScene = await until(
      plan,
      (p) =>
        p.itinerary.steps[1].continuation?.candidates.some(
          (c) => c.actionId === stableId('quest', ['quest-11082']),
        ),
      'known successor did not offer scene confirmation',
    );
    assert.equal(changedScene.itinerary.steps[1].status, 'unavailable');
    assert.equal(changedScene.itinerary.steps[1].selectedPlace.id, 'place-9');
    await row(otherAnchor)
      .locator(
        `[data-action="journey-itinerary-continue"][data-target-id="${stableId('quest', ['quest-11082'])}"]`,
      )
      .click();
    const successor = await until(
      plan,
      (p) => p.itinerary.steps[1].action?.questId === 'quest-11082',
      'explicit successor confirmation failed',
    );
    assert.equal(successor.itinerary.steps[1].status, 'pending');
    assert.equal(successor.itinerary.steps[1].handled, false);
    await shot('03-confirmed-branch-successor');
    checks.push(
      'multiple real active branches and changed scene require selection; successor retains order and no old handling',
    );

    await nav('materials');
    await page.locator('#craft-save').selectOption('1.sav');
    await page.locator('[data-action="craft-calculate"]').click();
    const stage = page.locator('[data-craft-stage="fusion-1001"]');
    await stage.waitFor();
    assert.match(await stage.innerText(), /执行配方：\s*白光剑精良图纸/);
    assert.match(await stage.innerText(), /预计产物：\s*白光剑\s*· 蓝色 × 1/);
    assert.equal(await stage.getByText('目标成品', { exact: true }).count(), 0);
    assert.equal(await stage.locator('[data-craft-outputs] [data-id="item-1005"]').count(), 1);
    await stage.getByText('学习这份配方的物品', { exact: true }).click();
    assert.equal(await stage.locator('[data-craft-outputs] [data-id="item-100001"]').count(), 1);
    const report = await api('materialPlan', [{ id: 'fusion-1001', quantity: 1 }], '1.sav');
    assert.deepEqual(report.stages.physicalUsed, { 10216: 3, 10246: 2, 10205: 2 });
    assert.equal(report.stages.plannedOutputs.find((o) => o.final).itemId, 1005);
    assert.equal(hash(), expectedHash);
    await shot('04-recipe-versus-output');
    checks.push(
      'real fusion-1001 recipe, blue result, learning item, unchanged physical budget and read-only synthetic save',
    );

    await page
      .locator(`[data-craft-plan-id="${deterministicPlan}"] [data-action="craft-plan-complete"]`)
      .click();
    await page.locator('[data-action="craft-plan-complete-confirm"]').click();
    await until(
      current,
      (p) => p.craftPlans.find((c) => c.id === deterministicPlan).done,
      'plan completion failed',
    );
    await page.locator('[data-action="craft-calculate"]').click();
    await page.getByText('已完成计划的配方记录', { exact: true }).waitFor();
    await until(
      () => page.locator('.crafting-stages').innerText(),
      (t) => t.includes('若重做目标制作'),
      'completed plan still says pending craft',
    );
    assert(!(await page.locator('.crafting-stages').innerText()).includes('还需先加工'));
    await shot('05-completed-plan-record');
    checks.push('completed plan is recipe history and hypothetical re-craft demand');

    await page.locator(`[data-craft-plan-id="${randomPlan}"] [data-action="craft-plan-open"]`).click();
    const randomStage = page.locator('[data-craft-stage="fusion-1101"]');
    await randomStage.waitFor();
    const text = await randomStage.innerText();
    assert.equal((text.match(/可能产物/g) || []).length, 3);
    assert.match(text, /白色/);
    assert.match(text, /绿色/);
    assert.match(text, /蓝色/);
    assert.match(text, /不表示会同时得到全部结果/);
    assert(!text.includes('预计产物'));
    await shot('06-alternative-quality-output');
    checks.push('real multi-quality recipe labels alternative outputs without simultaneous guaranteed yield');

    await app.close();
    app = null;
    await launch();
    await nav('journey');
    const restarted = await plan();
    assert.equal(restarted.itinerary.steps[0].action.questId, 'quest-11078');
    assert.equal(restarted.itinerary.steps[1].action.questId, 'quest-11082');
    assert.equal(restarted.itinerary.steps[1].selectedPlace, null);
    assert.equal((await current()).goals.find((g) => g.source.id === 'quest-11077').done, false);
    assert.equal(hash(), expectedHash);
    assert.deepEqual(errors, []);
    await shot('07-cold-restart');
    checks.push(
      'cold restart retains original queue and explicit continuation intent without game completion',
    );
    fs.writeFileSync(
      path.join(data, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          executionMode: override ? 'packaged-assistant' : 'source-electron',
          checks,
          errors,
          data,
          saveHash: expectedHash,
          personalOrRealGameData: false,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: true, checks: checks.length, data }));
  } catch (error) {
    if (page) await shot('failure').catch(() => {});
    fs.writeFileSync(
      path.join(data, 'result.json'),
      JSON.stringify({ ok: false, checks, errors, error: error.stack, data }, null, 2),
    );
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
