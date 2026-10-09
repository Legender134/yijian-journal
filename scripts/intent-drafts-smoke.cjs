'use strict';
// Real main/compact windows with isolated synthetic saves; no real game integration.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto');
const base = path.resolve(__dirname, '..'),
  data = path.join(
    process.env.YIJIAN_INTENT_EVIDENCE || path.join(base, '.test-data'),
    'intent-drafts-' + Date.now(),
  ),
  userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames'),
  results = process.env.YIJIAN_INTENT_EVIDENCE ? path.join(data, 'results') : path.join(base, 'test-results'),
  toolTemp = path.join(data, 'tool-temp');
fs.mkdirSync(toolTemp, { recursive: true });
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = toolTemp;
const { _electron } = require('playwright'),
  { Store } = require('../src/core/store.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs'),
  { resourceBudget } = require('../src/core/resource-budget.cjs');
const catalog = require('../src/data/catalog.cjs'),
  game = require('../src/data/game-index.json');
const originalMemo = '\n\n原正式说明 <literal> & 原文\n  尾部空白  ';
const override = process.env.YIJIAN_EXECUTABLE;
const executable = path.join(
  base,
  'dist',
  'v' + require('../package.json').version,
  '逸剑手札-win32-x64',
  '逸剑手札.exe',
);
if (override && path.resolve(override).toLowerCase() !== executable.toLowerCase())
  throw Error('只接受本候选实际 EXE');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const file = path.join(source, '1.sav');
fs.writeFileSync(
  file,
  syntheticSave({
    full: true,
    quests: [
      { id: 5200, step: 1 },
      { id: 11077, step: 1 },
    ],
    inventory: [
      { id: 1000, count: 10 },
      { id: 10201, count: 4 },
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
store.mutate({
  type: 'journey-todo-put',
  id: 'existing-todo',
  title: '原正式待办',
  detail: originalMemo,
  placeId: 'place-9',
  done: false,
});
const npc = game.entries.find((e) => e.kind === '人物').id,
  item = game.entries.find((e) => e.kind === '物品' && e.giftable).id;
store.mutate({
  type: 'journey-gift-put',
  id: 'existing-gift',
  npcId: npc,
  itemId: item,
  quantity: 2,
  note: originalMemo,
  done: false,
});
store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 1 });
let p = store.get().profiles[0],
  actions = journeyPlan(p, null, resourceBudget(p, null)).actions;
store.mutate(
  { type: 'journey-itinerary-add', id: actions.find((a) => a.kind === 'todo').id, placeId: 'place-9' },
  { journeyActions: actions },
);
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('compact'))
      ?.setSize(1000, 700),
  );
}
async function current() {
  const r = await page.evaluate(() => window.journal.bootstrap());
  assert(r.ok, r.error);
  return r.data.state.profiles.find((p) => p.id === r.data.state.activeProfileId);
}
async function until(predicate) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const p = await current();
    if (predicate(p)) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('安排操作未完成');
}
async function nav(route) {
  await page.locator('.nav-btn[data-id="' + route + '"]').click();
}
async function resume(id, target = page) {
  const button = target.locator('[data-action="intent-draft-resume"][data-id="' + id + '"]').first();
  if (!(await button.count())) await target.locator('[data-action="intent-drafts"]').first().click();
  if (!(await button.isVisible()))
    await button.locator('xpath=ancestor::details[1]').locator('summary').first().click();
  await button.click();
}
async function reveal(button) {
  const parents = button.locator('xpath=ancestor::details');
  for (let i = 0; i < (await parents.count()); i++) {
    const parent = parents.nth(i);
    if ((await parent.getAttribute('open')) === null) await parent.locator(':scope > summary').click();
  }
}
async function mutate(target, command) {
  const r = await target.evaluate((value) => window.journal.mutate(value), command);
  assert(r.ok, r.error);
  return r.data;
}
async function collectionQuantityJourney() {
  await page.locator('.topbar [data-action="search"]').click();
  await page.locator('#global-search').fill('铁矿石');
  await page.locator('[data-action="database-detail"][data-id="item-10201"]').first().click();
  await page.locator('[data-action="database-goal"][data-id="item-10201"]').click();
  let p = await until((p) => p.goals.some((g) => g.source?.id === 'item-10201'));
  const goal = p.goals.find((g) => g.source?.id === 'item-10201');
  await page.keyboard.press('Escape');
  await nav('goals');
  await page.locator('[data-action="goal-edit"][data-id="' + goal.id + '"]').click();
  assert.equal(await page.locator('#goal-quantity').inputValue(), '1');
  assert.equal(await page.locator('#goal-quantity').getAttribute('max'), '999');
  assert.equal(await page.locator('#journey-place').count(), 0);
  await page.locator('#goal-title').fill('采集铁矿石 10 个');
  await page.locator('#goal-detail').fill('下次出发需要 10 个铁矿石');
  await page.locator('#goal-quantity').fill('10');
  await page.keyboard.press('Escape');
  p = await until((p) => p.intentDrafts?.some((r) => r.targetId === goal.id && r.values.quantity === '10'));
  const draftId = p.intentDrafts.find((r) => r.targetId === goal.id).id;
  assert.equal(p.goals.find((g) => g.id === goal.id).source.quantity, undefined);
  await app.close();
  app = null;
  await launch();
  await nav('goals');
  await resume(draftId);
  assert.equal(await page.locator('#goal-quantity').inputValue(), '10');
  await page.locator('#goal-quantity').fill('1000');
  await page.locator('[data-action="goal-save"]').click();
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('收集数量'));
  assert.equal((await current()).goals.find((g) => g.id === goal.id).source.quantity, undefined);
  await page.locator('#goal-quantity').fill('10');
  await page.locator('[data-action="goal-save"]').click();
  p = await until((p) => p.goals.find((g) => g.id === goal.id)?.source.quantity === 10);
  assert.equal(p.goals.find((g) => g.id === goal.id).createdAt, goal.createdAt);
  assert.equal(p.goals.filter((g) => g.source?.id === 'item-10201').length, 1);
  assert.match(await page.locator('#goal-' + goal.id).innerText(), /收集数量：10 件/);
  assert.match(await page.locator('#goal-' + goal.id).innerText(), /查看物品原资料/);
  await nav('journey');
  const action = journeyPlan(p, null).actions.find((a) => a.goalIds?.includes(goal.id));
  const card = page.locator('[data-journey-id="' + action.id + '"]');
  assert.match(await card.innerText(), /需 10 · 已保存持有 4/);
  await card.locator('[data-action="journey-itinerary-add"]').click();
  p = await until((p) => p.journey.itinerary.steps.some((s) => s.actionId === action.id));
  const selection = p.journey.itinerary.steps.find((s) => s.actionId === action.id);
  const todoAction = journeyPlan(p, null).actions.find((a) => a.kind === 'todo');
  await page.locator('[data-action="journey-itinerary-remove"][data-id="' + todoAction.id + '"]').click();
  await page.locator('[data-action="journey-itinerary-status"][data-id="active"]').first().click();
  await until((p) => p.journey.itinerary.status === 'active');
  const created = app.waitForEvent('window');
  await page.locator('.topbar [data-action="compact"]').click();
  companion = await created;
  companion.on('pageerror', (e) => errors.push(e.message));
  await companion.locator('.compact-shell').waitFor();
  await companion.waitForFunction(() => document.body.textContent.includes('铁矿石 × 10'));
  await companion.screenshot({ path: path.join(results, 'item-quantity-compact.png') });
  await page.locator('.topbar [data-action="search"]').click();
  await page.locator('#global-search').fill('铁矿石');
  await page.waitForFunction(() =>
    document.querySelector('#global-results').textContent.includes('铁矿石 × 10'),
  );
  await page.screenshot({ path: path.join(results, 'item-quantity-search.png') });
  await page.keyboard.press('Escape');
  await nav('goals');
  await page.locator('[data-action="goal-edit"][data-id="' + goal.id + '"]').click();
  await page.locator('#goal-quantity').fill('12');
  await until((p) => p.intentDrafts.some((r) => r.targetId === goal.id && r.values.quantity === '12'));
  await page.locator('[data-action="intent-draft-copy"]').click();
  p = await until((p) => p.intentDrafts.some((r) => r.targetId === goal.id && r.values.quantity === '12'));
  assert.equal(await page.locator('[data-action="intent-draft-copy"]').innerText(), '另存此目标的编辑草稿');
  await page.locator('[data-action="goal-save"]').click();
  p = await until((p) => p.goals.find((g) => g.id === goal.id)?.source.quantity === 12);
  assert.deepEqual(
    p.journey.itinerary.steps.find((s) => s.actionId === action.id),
    selection,
  );
  await companion.waitForFunction(() => document.body.textContent.includes('铁矿石 × 12'));
  const stale = p.intentDrafts.find((r) => r.targetId === goal.id);
  assert(stale, 'the original independent editing draft remains');
  await resume(stale.id);
  await page.locator('[data-action="intent-draft-copy"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#toasts').textContent.includes('原物品目标已变化'),
  );
  assert.equal((await current()).goals.find((g) => g.id === goal.id).source.quantity, 12);
  await page.keyboard.press('Escape');
  await page.locator('[data-action="intent-drafts"]').first().click();
  await page.locator('[data-action="intent-draft-discard"][data-id="' + stale.id + '"]').click();
  await page.locator('[data-action="intent-draft-discard-confirm"]').click();
  await until((p) => !p.intentDrafts.some((r) => r.id === stale.id));
  await page.locator('[data-action="goal-edit"][data-id="' + goal.id + '"]').click();
  await page.locator('#goal-quantity').fill('13');
  await page.keyboard.press('Escape');
  p = await until((p) => p.intentDrafts.some((r) => r.targetId === goal.id && r.values.quantity === '13'));
  const removedDraft = p.intentDrafts.find((r) => r.targetId === goal.id);
  await page.locator('[data-action="goal-remove"][data-id="' + goal.id + '"]').click();
  await page.locator('[data-action="goal-remove-confirm"]').click();
  p = await until((p) => !p.goals.some((g) => g.id === goal.id));
  await resume(removedDraft.id);
  assert.equal(await page.locator('#goal-quantity').inputValue(), '13');
  assert.match(await page.locator('#overlay').innerText(), /原物品目标已移除，草稿仍保留/);
  await page.locator('[data-action="intent-draft-copy"]').click();
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('请先恢复原目标'));
  await page.keyboard.press('Escape');
  const removed = p.journeyTrash.find((r) => r.kind === 'goal' && r.record.id === goal.id);
  await mutate(page, { type: 'journey-trash-restore', id: removed.id, expectedTrash: removed });
  await until((p) => p.goals.some((g) => g.id === goal.id));
  await resume(removedDraft.id);
  await page.locator('#goal-quantity').fill('12');
  await page.locator('[data-action="goal-save"]').click();
  await until((p) => !p.intentDrafts.some((r) => r.id === removedDraft.id));
  for (const source of [
    undefined,
    { type: 'quest', id: 'quest-5200' },
    { type: 'database', id: 'fusion-1000', quantity: 2 },
  ]) {
    await mutate(page, {
      type: 'goal-add',
      title: '非物品数量隔离',
      detail: '',
      ...(source ? { source } : {}),
    });
    p = await until((p) => p.goals[0].title === '非物品数量隔离');
    await page.locator('[data-action="goal-edit"][data-id="' + p.goals[0].id + '"]').click();
    assert.equal(await page.locator('#goal-quantity').count(), 0);
    await page.keyboard.press('Escape');
  }
  await app.close();
  app = null;
  companion = null;
  await launch();
  await nav('journey');
  p = await current();
  assert.equal(p.goals.find((g) => g.id === goal.id).source.quantity, 12);
  assert.deepEqual(
    p.journey.itinerary.steps.find((s) => s.actionId === action.id),
    selection,
  );
  assert.match(await page.locator('[data-itinerary]').innerText(), /铁矿石 × 12/);
  await page.screenshot({ path: path.join(results, 'item-quantity-restarted.png') });
  await page
    .locator('[data-journey-id="' + todoAction.id + '"] [data-action="journey-itinerary-add"]')
    .click();
  checks.push(
    '图鉴物品默认1件，明确编辑10件并对照持有4；数量草稿冷重启、超限拒绝、同目标另存并发保护、已选行程/搜索/小窗同步12件且重启保留；普通/任务/配方目标不显示件数',
  );
}
(async () => {
  try {
    await launch();
    await collectionQuantityJourney();
    await nav('journey');
    await page.locator('[data-action="journey-todo-dialog"][data-id="existing-todo"]').click();
    assert.equal(await page.locator('#journey-note').inputValue(), originalMemo);
    await page.locator('#journey-title').fill('还没提交的待办');
    await page.locator('#journey-note').fill('下次接着填写的重要文字\n第二行');
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts?.some((r) => r.kind === 'journey-todo'));
    const todoDraft = p.intentDrafts.find((r) => r.kind === 'journey-todo').id;
    await page.waitForFunction((id) => {
      const row = document.querySelector('[data-intent-draft-id="' + id + '"]');
      return row && !row.textContent.includes('尚未成功暂存');
    }, todoDraft);
    checks.push('关闭安排编辑器后，成功暂存立即清除列表中的未保存提示');
    assert.equal(p.journey.todos[0].title, '原正式待办');
    await page.locator('[data-action="journey-gift-edit"][data-id="existing-gift"]').click();
    assert.equal(await page.locator('#journey-note').inputValue(), originalMemo);
    await page.locator('#journey-quantity').fill('');
    await page.locator('#journey-note').fill('\n\n赠礼数量还在核对\n  尾部空白  ');
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'journey-gift' && r.values.quantity === ''));
    const giftDraft = p.intentDrafts.find((r) => r.kind === 'journey-gift').id;
    assert.equal(p.journey.gifts[0].quantity, 2);
    await nav('goals');
    const goalsBeforePartial = (await current()).goals.length;
    await page.locator('[data-action="goal-add"]').first().click();
    await page.locator('#goal-detail').fill('只写说明也要保留');
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'goal'));
    const goalDraft = p.intentDrafts.find((r) => r.kind === 'goal').id;
    assert.equal(p.goals.length, goalsBeforePartial);
    await nav('materials');
    await page.locator('[data-action="craft-plan-dialog"]').first().click();
    await page.locator('#craft-plan-name').fill('仍未提交的制作名称');
    await page.locator('#craft-plan-goal').check();
    await page.locator('#craft-plan-reserved').uncheck();
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'craft-plan'));
    const craftDraft = p.intentDrafts.find((r) => r.kind === 'craft-plan').id;
    assert.equal(p.craftPlans?.length || 0, 0);
    await nav('journey');
    const name = page.locator('#journey-itinerary-name');
    await name.locator('xpath=ancestor::details[1]').locator('summary').first().click();
    await name.fill('未提交的这一程名称');
    await name.blur();
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'itinerary-name'));
    const nameDraft = p.intentDrafts.find((r) => r.kind === 'itinerary-name').id;
    assert.equal(p.journey.itinerary.name, '本次行程');
    const placeButton = page.locator('[data-action="journey-place-dialog"][data-id="place-9"]').first();
    await reveal(placeButton);
    await placeButton.click();
    await page.locator('#journey-note').fill('\n\n地点还在研究，先留下完整想法\n  尾部空白  ');
    await page.locator('#journey-favorite').check();
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'journey-place'));
    const placeDraft = p.intentDrafts.find((r) => r.kind === 'journey-place').id;
    assert.equal(p.journey.places.length, 0);
    const plan = await page.evaluate(() => window.journal.journeyPlan());
    assert(plan.ok, plan.error);
    const questAction = plan.data.actions.find(
      (r) =>
        new Set(r.places.flatMap((place) => place.mapIds)).size > 1 &&
        !p.journey.itinerary.steps.some((step) => step.actionId === r.id),
    );
    assert(questAction);
    const choice = page.locator('[data-journey-id="' + questAction.id + '"] [data-itinerary-place]');
    await reveal(choice);
    await choice.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    const picked = await choice.inputValue();
    assert(picked);
    await choice.blur();
    p = await until((p) =>
      p.intentDrafts.some((r) => r.kind === 'itinerary-choice' && r.targetId === questAction.id),
    );
    const choiceDraft = p.intentDrafts.find(
      (r) => r.kind === 'itinerary-choice' && r.targetId === questAction.id,
    ).id;
    assert(!p.journey.itinerary.steps.some((r) => r.actionId === questAction.id));
    assert.deepEqual(
      new Set(p.intentDrafts.map((r) => r.kind)),
      new Set([
        'journey-place',
        'journey-todo',
        'journey-gift',
        'goal',
        'craft-plan',
        'itinerary-name',
        'itinerary-choice',
      ]),
    );
    checks.push('七类个人编辑均暂存，包括未完成数量、地点备注和场景选择，正式状态保持');
    await app.close();
    app = null;
    await launch();
    await nav('journey');
    await resume(nameDraft);
    assert.equal(await page.locator('#journey-itinerary-name').inputValue(), '未提交的这一程名称');
    await page.locator('[data-action="journey-itinerary-name"]').click();
    p = await until((p) => p.journey.itinerary.name === '未提交的这一程名称');
    assert(!p.intentDrafts.some((r) => r.id === nameDraft));
    await resume(choiceDraft);
    assert.equal(
      await page.locator('[data-journey-id="' + questAction.id + '"] [data-itinerary-place]').inputValue(),
      picked,
    );
    await page.locator('[data-action="journey-itinerary-add"][data-id="' + questAction.id + '"]').click();
    p = await until((p) =>
      p.journey.itinerary.steps.some((r) => r.actionId === questAction.id && r.placeId === picked),
    );
    assert(!p.intentDrafts.some((r) => r.id === choiceDraft));
    await resume(todoDraft);
    assert.equal(await page.locator('#journey-title').inputValue(), '还没提交的待办');
    assert.match(await page.locator('#journey-note').inputValue(), /重要文字/);
    await page.locator('[data-action="journey-intent-save"]').click();
    p = await until((p) => p.journey.todos[0].title === '还没提交的待办');
    assert(!p.intentDrafts.some((r) => r.id === todoDraft));
    await resume(giftDraft);
    assert.equal(await page.locator('#journey-quantity').inputValue(), '');
    assert.equal(await page.locator('#journey-note').inputValue(), '\n\n赠礼数量还在核对\n  尾部空白  ');
    await page.locator('#journey-quantity').fill('3');
    await page.locator('[data-action="journey-intent-save"]').click();
    p = await until((p) => p.journey.gifts[0].quantity === 3);
    assert(!p.intentDrafts.some((r) => r.id === giftDraft));
    await resume(goalDraft);
    assert.equal(await page.locator('#goal-detail').inputValue(), '只写说明也要保留');
    await page.locator('#goal-title').fill('重新出发前核对');
    await page.locator('[data-action="goal-save"]').click();
    p = await until((p) => p.goals.some((g) => g.title === '重新出发前核对'));
    assert(!p.intentDrafts.some((r) => r.id === goalDraft));
    await resume(craftDraft);
    assert.equal(await page.locator('#craft-plan-name').inputValue(), '仍未提交的制作名称');
    assert(await page.locator('#craft-plan-goal').isChecked());
    assert.equal(await page.locator('#craft-plan-reserved').isChecked(), false);
    await page.locator('[data-action="craft-plan-save"]').click();
    p = await until((p) => p.craftPlans.some((r) => r.name === '仍未提交的制作名称'));
    assert.equal(p.craftPlans[0].reserved, false);
    await nav('journey');
    await resume(placeDraft);
    assert.equal(
      await page.locator('#journey-note').inputValue(),
      '\n\n地点还在研究，先留下完整想法\n  尾部空白  ',
    );
    assert(await page.locator('#journey-favorite').isChecked());
    await page.locator('[data-action="journey-intent-save"]').click();
    p = await until((p) => p.journey.places.some((r) => r.placeId === 'place-9'));
    assert(!p.intentDrafts.some((r) => r.id === placeDraft));
    checks.push('冷重启逐份续填七种编辑并正式提交，仅消耗相应草稿，原引用/说明/选项保留');
    for (const [action, id, expected] of [
      ['journey-place-dialog', 'place-9', '\n\n地点还在研究，先留下完整想法\n  尾部空白  '],
      ['journey-gift-edit', 'existing-gift', '\n\n赠礼数量还在核对\n  尾部空白  '],
    ]) {
      const button = page.locator('[data-action="' + action + '"][data-id="' + id + '"]').first();
      await reveal(button);
      await button.click();
      assert.equal(await page.locator('#journey-note').inputValue(), expected);
      await page.locator('[data-action="journey-intent-save"]').click();
      await page.locator('#journey-note').waitFor({ state: 'detached' });
    }
    p = await current();
    assert.equal(
      p.journey.places.find((r) => r.placeId === 'place-9').note,
      '\n\n地点还在研究，先留下完整想法\n  尾部空白  ',
    );
    assert.equal(p.journey.gifts[0].note, '\n\n赠礼数量还在核对\n  尾部空白  ');
    checks.push('原待办与赠礼编辑、地点和赠礼草稿续填及重开保存均保留首部空行和尾部空白');
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await created;
    companion.on('pageerror', (e) => errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await page.locator('[data-action="journey-todo-dialog"][data-id="existing-todo"]').click();
    await page.locator('#journey-title').fill('冲突时仍保留这段编辑');
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'journey-todo'));
    const conflictDraft = p.intentDrafts.find((r) => r.kind === 'journey-todo').id;
    await mutate(companion, {
      type: 'journey-todo-put',
      id: 'existing-todo',
      title: '另一个窗口改过的正式事项',
      detail: '后续内容',
      placeId: 'place-9',
      done: false,
    });
    await page.locator('[data-action="journey-intent-save"]').click();
    await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('原安排已'));
    p = await current();
    assert.equal(p.journey.todos[0].title, '另一个窗口改过的正式事项');
    assert(p.intentDrafts.some((r) => r.id === conflictDraft));
    assert.equal(await page.locator('#journey-title').inputValue(), '冲突时仍保留这段编辑');
    await page.locator('#overlay [data-action="intent-draft-recheck"]').click();
    await page.keyboard.press('Escape');
    assert.equal((await current()).journey.todos[0].title, '另一个窗口改过的正式事项');
    await resume(conflictDraft);
    await page.locator('#overlay [data-action="intent-draft-copy"]').click();
    p = await until((p) => p.intentDrafts.some((r) => r.kind === 'journey-todo' && r.id !== conflictDraft));
    const copied = p.intentDrafts.find((r) => r.kind === 'journey-todo' && r.id !== conflictDraft);
    assert.equal(copied.targetId, '');
    assert.equal(copied.values.title, '冲突时仍保留这段编辑');
    assert(p.intentDrafts.some((r) => r.id === conflictDraft));
    assert.equal(p.journey.todos[0].title, '另一个窗口改过的正式事项');
    await page.keyboard.press('Escape');
    await page.locator('[data-action="intent-draft-discard"][data-id="' + copied.id + '"]').click();
    await page.locator('[data-action="intent-draft-discard-confirm"]').click();
    await until((p) => !p.intentDrafts.some((r) => r.id === copied.id));
    await resume(conflictDraft);
    await page.locator('#overlay [data-action="intent-draft-recheck"]').click();
    await page.locator('[data-action="intent-draft-recheck-confirm"]').click();
    await page.locator('[data-action="journey-intent-save"]').click();
    p = await until((p) => p.journey.todos[0].title === '冲突时仍保留这段编辑');
    checks.push('另一窗口改变原安排后拒绝旧提交，另存保留原稿与原安排，明确核对后才能提交');
    await page.locator('[data-action="journey-todo-dialog"]:not([data-id])').click();
    await page.locator('#journey-title').fill('需要明确放弃的草稿');
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts.some((r) => r.values.title === '需要明确放弃的草稿'));
    const discardId = p.intentDrafts.find((r) => r.values.title === '需要明确放弃的草稿').id;
    await page.locator('[data-action="intent-draft-discard"][data-id="' + discardId + '"]').click();
    await page.keyboard.press('Escape');
    assert((await current()).intentDrafts.some((r) => r.id === discardId));
    await page.locator('[data-action="intent-draft-discard"][data-id="' + discardId + '"]').click();
    await page.locator('[data-action="intent-draft-discard-confirm"]').click();
    p = await until((p) => !p.intentDrafts.some((r) => r.id === discardId));
    assert.equal(p.journey.todos.length, 1);
    checks.push('放弃可取消，确认仅删除所选草稿，不删除正式待办');
    await mutate(page, {
      type: 'intent-draft-put',
      id: 'unknown-place',
      kind: 'journey-place',
      targetId: 'place-999999',
      context: {},
      values: { note: '迁移后待核对的完整地点想法', favorite: false, done: true },
      expectedRevision: 0,
      expectedTarget: null,
    });
    await until((p) => p.intentDrafts.some((r) => r.id === 'unknown-place'));
    await resume('unknown-place');
    assert((await page.locator('#overlay').innerText()).includes('迁移后待核对的完整地点想法'));
    assert((await page.locator('#overlay').innerText()).includes('place-999999'));
    assert((await page.locator('#overlay').innerText()).includes('拟标为已完成'));
    await page.locator('#overlay [data-action="intent-draft-discard"]').click();
    await page.locator('[data-action="intent-draft-discard-confirm"]').click();
    await until((p) => !p.intentDrafts.some((r) => r.id === 'unknown-place'));
    checks.push('资料版本暂不识别原地点时仍可查看原引用、完整文字和选项，由用户明确放弃');
    assert.equal(hash(), initialSaveHash);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(results, 'intent-drafts-final.png'), timeout: 15000 });
    fs.writeFileSync(
      path.join(results, 'intent-drafts-result.json'),
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
      path.join(results, 'intent-drafts-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(results, 'intent-drafts-failure.png'), timeout: 15000 })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
