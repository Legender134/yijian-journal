'use strict';
// Independent synthetic user-flow regression. YIJIAN_TEST_DATA blocks all native game commands.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'playwright',
);
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { Activity } = require('../src/core/activity.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const gameIndex = require('../src/core/game-data.cjs').encyclopedia();
const base = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const reportFile = path.join(base, 'test-results', `review-regressions-${version}${process.env.YIJIAN_REVIEW_REPORT_SUFFIX || ''}.json`);
const report = {
  version,
  executable: process.env.YIJIAN_EXECUTABLE || 'development Electron',
  startedAt: new Date().toISOString(),
  cases: [],
  errors: [],
  externalRequests: [],
};
const makeData = (name) => {
  const dir = fs.mkdtempSync(path.join(base, '.test-data', `review-${name}-`));
  report[name + 'Data'] = dir;
  return dir;
};
const save = (inventoryCount, questStep = 1, seconds = 3661) =>
  syntheticSave({
    full: true,
    seconds,
    money: 10000,
    quests: [{ id: 5200, step: questStep }],
    inventory: [{ id: 10300, count: inventoryCount }],
  });
const journal = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'));
const activity = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'));
const timeline = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'game-timeline', 'timeline.json'), 'utf8'));
const check = (name, facts) => {
  report.cases.push({ name, passed: true, ...facts });
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, inProgress: true }, null, 2));
  console.log('PASS:', name);
};
const launch = async (data, tray = false) => {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  if (tray) env.YIJIAN_TEST_TRAY = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
  });
  const win = await app.firstWindow();
  win.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  win.on('pageerror', (e) => report.errors.push(e.message));
  win.on('request', (r) => {
    if (/^https?:/i.test(r.url())) report.externalRequests.push(r.url());
  });
  await win.locator('.layout').waitFor();
  return { app, win };
};
const nav = (win, id) => win.locator(`.nav-btn[data-id="${id}"]`).click();
const close = async (win) => {
  await win.keyboard.press('Escape');
  await win.locator('.drawer').waitFor({ state: 'detached' });
};
const select = async (win, id, value) => {
  await win.locator(id).selectOption(value);
  assert.equal(await win.locator(id).inputValue(), value);
};
const stateSummary = (win) =>
  win.evaluate(async () => {
    const r = await window.journal.refresh();
    return { timeline: r.data.timeline, settings: r.data.health };
  });
let running;

async function referenceAndPolling() {
  const data = makeData('references');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(10, 1, 3661));
  fs.writeFileSync(path.join(source, '2.sav'), save(2, 4, 4661));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'stage', value: 0 });
  store.mutate({ type: 'goal-add', title: '小窗撤销目标' });
  const goalId = store.get().profiles[0].goals[0].id;
  running = await launch(data);
  const { app, win } = running;
  try {
    const initial = await stateSummary(win);
    assert.equal(initial.timeline.enabled, false);
    assert.equal(journal(data).settings.autoBackup, false);
    await nav(win, 'world');
    await select(win, '#world-save', '1.sav');
    await win.waitForFunction(() => document.querySelector('.world-reference')?.textContent.includes('已读取 1.sav'));
    await win.locator('#world-search').fill('找山下的孙郎中取药材');
    await win.locator('#world-scope').selectOption('all');
    await win.locator('.world-quest-card[data-id="quest-5054"]').click();
    await win.locator('[data-action="database-detail"][data-id="npc-10001"]').first().click();
    assert.equal(await win.locator('#person-save').inputValue(), '1.sav');
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.world-drawer .save-note').first().innerText(), /对照 1\.sav/);
    await close(win);
    await select(win, '#world-save', '');
    await win.locator('.world-quest-card[data-id="quest-5054"]').click();
    await win.locator('[data-action="database-detail"][data-id="npc-10001"]').first().click();
    assert.equal(await win.locator('#person-save').inputValue(), '');
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.world-drawer .save-note').first().innerText(), /当前仅查资料/);
    check('world fixed slot and reference-free mode survive person detail and back', { fixed: '1.sav', none: '' });
    await close(win);

    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-7000"]').click();
    await select(win, '#recipe-save', '1.sav');
    await win.locator('#recipe-quantity').fill('3');
    await win.locator('#recipe-materials [data-action="database-detail"][data-id="item-10300"]').click();
    await win.locator('.item-sellers summary').click();
    await win.locator('.item-sellers [data-action="database-detail"][data-id="npc-10802"]').click();
    await select(win, '#person-save', '@latest');
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.drawer h1').innerText(), /麻布/);
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    // The reverse direction: latest parent remains latest after a fixed child selection.
    await select(win, '#recipe-save', '@latest');
    await win.locator('#recipe-quantity').fill('4');
    await win.locator('#recipe-materials [data-action="database-detail"][data-id="item-10300"]').click();
    await win.locator('.item-sellers summary').click();
    await win.locator('.item-sellers [data-action="database-detail"][data-id="npc-10802"]').click();
    await select(win, '#person-save', '1.sav');
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '4');
    check('nested recipe item person navigation restores both reference modes and quantity', { fixedQuantity: 3, latestQuantity: 4 });

    // Native and backup automation stay disabled; only an external synthetic file write changes data.
    await select(win, '#recipe-save', '1.sav');
    await win.locator('#recipe-quantity').fill('3');
    await win.locator('.drawer-body').evaluate((e) => { e.scrollTop = 180; });
    const recipeScroll = await win.locator('.drawer-body').evaluate((e) => e.scrollTop);
    assert.ok(recipeScroll > 0);
    assert.match(await win.locator('#recipe-materials').innerText(), /已有 10/);
    fs.writeFileSync(path.join(source, '1.sav'), save(0, 4, 3662));
    await win.waitForFunction(() => document.querySelector('#recipe-materials')?.textContent.includes('已有 0'), null, { timeout: 16000 });
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.ok((await win.locator('.drawer-body').evaluate((e) => e.scrollTop)) > 0);
    check('recipe open drawer polls changed saved inventory without a synthetic event', { beforeOwned: 10, afterOwned: 0, quantity: 3, scrollBefore: recipeScroll });
    await close(win);

    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('余裁缝');
    await win.locator('[data-action="database-detail"][data-id="npc-10802"]').click();
    await select(win, '#person-save', '1.sav');
    await win.locator('.person-gifts').scrollIntoViewIfNeeded();
    const beforeGifts = await win.locator('.person-gifts').innerText();
    assert.match(beforeGifts, /没有记录符合偏好/);
    fs.writeFileSync(path.join(source, '1.sav'), save(6, 1, 3663));
    await win.waitForFunction(() => document.querySelector('.person-gifts')?.textContent.includes('麻布'), null, { timeout: 16000 });
    assert.equal(await win.locator('#person-save').inputValue(), '1.sav');
    check('person open drawer polls changed gifts without a synthetic event', { item: '麻布', selected: '1.sav' });
    await close(win);

    await nav(win, 'world');
    await select(win, '#world-save', '1.sav');
    await win.locator('#world-search').fill('武当求助');
    await win.waitForFunction(() => document.querySelector('.world-quest-card[data-id="quest-5200"]')?.textContent.includes('进行中'));
    await win.locator('.world-quest-card[data-id="quest-5200"]').click();
    await win.locator('.world-drawer details').first().evaluate((e) => { e.open = true; });
    const expanded = await win.locator('.world-drawer details').first().evaluate((e) => e.open);
    assert.equal(expanded, true);
    fs.writeFileSync(path.join(source, '1.sav'), save(6, 4, 3664));
    await win.waitForFunction(() => document.querySelector('.world-drawer .tag-row')?.textContent.includes('已完成'), null, { timeout: 16000 });
    assert.equal(await win.locator('.world-drawer details').first().evaluate((e) => e.open), true);
    await close(win);
    assert.equal(await win.locator('#world-save').inputValue(), '1.sav');
    assert.equal(await win.locator('#world-search').inputValue(), '武当求助');
    check('world open drawer polls changed quest status and preserves expansion, query and slot', { old: '进行中', next: '已完成' });

    await nav(win, 'home');
    await win.locator('[data-action="compact"]').first().click();
    const companion = app.windows().find((w) => w !== win) || (await app.waitForEvent('window'));
    await companion.locator('.compact-shell').waitFor();
    const goal = companion.locator(`[data-action="goal-toggle"][data-id="${goalId}"]`);
    await goal.click();
    const undo = companion.locator('[data-action="compact-undo"]');
    await undo.waitFor();
    assert.match(await companion.locator('.compact-body').innerText(), /小窗撤销目标/);
    await undo.click();
    await goal.waitFor();
    assert.equal(journal(data).profiles[0].goals.find((g) => g.id === goalId).done, false);
    const reminder = companion.locator('.compact-body .check-row [data-action="check"]').first();
    const reminderId = await reminder.getAttribute('data-id');
    await reminder.click();
    await undo.waitFor();
    await undo.click();
    await companion.locator(`.compact-body .check-row [data-action="check"][data-id="${reminderId}"]`).waitFor();
    assert.equal(journal(data).profiles[0].checks[reminderId], undefined);
    check('compact goal and checklist completion expose immediate undo and restore disk state', { goalId, reminderId });
    await companion.close();
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function firstSaveAppears() {
  const data = makeData('first-save');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'save-slot', value: '', mode: 'latest' });
  running = await launch(data);
  const { app, win } = running;
  try {
    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-7000"]').click();
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.doesNotMatch(await win.locator('#recipe-materials').innerText(), /已有\s+\d+/);
    fs.writeFileSync(path.join(source, '1.sav'), save(7));
    await win.waitForFunction(() => document.querySelector('#recipe-materials')?.textContent.includes('已有 7'), null, { timeout: 16000 });
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    check('latest recipe with no initial save follows first readable file through natural polling', { file: '1.sav', owned: 7 });
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function referenceRefreshEdges() {
  const data = makeData('reference-edges');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const sample = (count, questStep, learned, seconds) => syntheticSave({
    full: true, seconds, money: 10000,
    quests: [{ id: 5424, step: questStep }],
    inventory: [{ id: 10300, count }],
    fusionRecipes: learned ? [7000] : [],
  });
  fs.writeFileSync(path.join(source, '1.sav'), sample(10, 1, false, 3000));
  const person = gameIndex.entries.filter((e) => e.kind === '人物').find((e) =>
    gameIndex.entries.filter((x) => x.kind === '物品' && x.giftable && e.hobbyKeys?.includes(x.typeKey)).length > 30);
  assert.ok(person);
  const gifts = gameIndex.entries.filter((x) => x.kind === '物品' && x.giftable && person.hobbyKeys.includes(x.typeKey));
  fs.writeFileSync(path.join(source, '2.sav'), syntheticSave({
    full: true, inventory: gifts.slice(0, 36).map((x) => ({ id: x.gameId, count: 10 })),
  }));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  running = await launch(data);
  const { app, win } = running;
  try {
    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-7000"]').click();
    await select(win, '#recipe-save', '1.sav');
    assert.match(await win.locator('.drawer').innerText(), /还没有此配方/);
    await win.locator('#recipe-quantity').fill('');
    fs.writeFileSync(path.join(source, '1.sav'), sample(0, 4, true, 3001));
    await win.waitForFunction(() => document.querySelector('.drawer')?.textContent.includes('已记录此配方'), null, { timeout: 16000 });
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '');
    assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    await win.locator('#recipe-quantity').fill('3');
    await win.waitForFunction(() => document.querySelector('#recipe-materials')?.textContent.includes('已有 0'));
    await win.locator('#recipe-quantity').fill('0');
    fs.writeFileSync(path.join(source, '1.sav'), sample(8, 1, false, 3002));
    await win.waitForFunction(() => document.querySelector('.drawer')?.textContent.includes('还没有此配方'), null, { timeout: 16000 });
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '0');
    assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
    await win.locator('#recipe-quantity').fill('2');
    await win.waitForFunction(() => document.querySelector('#recipe-materials')?.textContent.includes('已有 8'));
    check('invalid empty and zero recipe quantities preserve input while external inventory and learned status refresh', { quantities: ['', '0'], refreshedOwned: [0, 8] });
    await win.locator('#recipe-quantity').fill('');
    await select(win, '#recipe-save', '@latest');
    await win.waitForFunction(() => document.querySelector('#recipe-save')?.value === '@latest' &&
      document.querySelector('#recipe-materials')?.textContent.includes('填写 1 至 999'));
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '');
    assert.match(await win.locator('.recipe-reference').innerText(), /已读取这份存档/);
    await select(win, '#recipe-save', '');
    await win.waitForFunction(() => document.querySelector('#recipe-save')?.value === '' &&
      document.querySelector('.recipe-reference')?.textContent.includes('可连接本机存档'));
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '');
    assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
    check('recipe reference changes from fixed slot through latest to reference-free with invalid quantity intact', { modes: ['1.sav', '@latest', ''], invalidQuantity: '' });
    await close(win);

    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill(person.name);
    await win.locator(`[data-action="database-detail"][data-id="${person.id}"]`).click();
    await select(win, '#person-save', '2.sav');
    await win.locator('.person-gifts [data-action="gift-page"]').last().click();
    assert.match(await win.locator('.person-gifts').innerText(), /第 2 \/ 2 页/);
    const gift = win.locator('.person-gifts [data-action="database-detail"]').first();
    const giftId = await gift.getAttribute('data-id');
    await gift.click();
    assert.match(await win.locator('.drawer h1').innerText(), /.+/);
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.person-gifts').innerText(), /第 2 \/ 2 页/);
    assert.equal(await win.locator('#person-save').inputValue(), '2.sav');
    check('gift page two and selected save survive opening item detail and returning', { person: person.id, item: giftId, page: 2 });
    await close(win);

    await nav(win, 'world');
    await select(win, '#world-save', '1.sav');
    await win.locator('#world-scope').selectOption('all');
    await win.locator('#world-search').fill('赢得品剑大会');
    await win.locator('.world-quest-card[data-id="quest-5424"]').click();
    const detail = win.locator('.world-drawer details').filter({ hasText: '关联场景线索' });
    await detail.locator('summary').click();
    assert.equal(await detail.evaluate((e) => e.open), true);
    const before = await win.locator('.world-drawer .drawer-body').evaluate((e) => {
      e.scrollTop = Math.min(400, e.scrollHeight - e.clientHeight);
      return { top: e.scrollTop, max: e.scrollHeight - e.clientHeight };
    });
    assert.ok(before.top >= 150, `quest drawer is not deep enough: ${JSON.stringify(before)}`);
    fs.writeFileSync(path.join(source, '1.sav'), sample(9, 4, true, 3003));
    await win.waitForFunction(() => document.querySelector('.world-drawer .tag-row')?.textContent.includes('已完成'), null, { timeout: 16000 });
    const after = await win.locator('.world-drawer .drawer-body').evaluate((e) => e.scrollTop);
    assert.equal(await detail.evaluate((e) => e.open), true);
    assert.ok(Math.abs(after - before.top) <= 1, `deep quest scroll changed from ${before.top} to ${after}`);
    check('quest 5424 external refresh preserves expanded details and exact deep scroll', { before: before.top, after });
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function fullDraftCapacity() {
  const data = makeData('draft-capacity');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(4));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const record = t.record(save(4), 'auto', Date.now() - 10000);
  const a = new Activity(data);
  for (let i = 0; i < 100; i++) a.draft(`orphan-${i}`, { label: `旧草稿 ${i}`, note: `旧内容 ${i}` });
  assert.equal(Object.keys(activity(data).drafts).length, 100);
  running = await launch(data);
  let { app, win } = running;
  try {
    await nav(win, 'saves');
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    await win.locator('#timeline-note').fill('满额后暂存失败的文字');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    assert.equal(activity(data).drafts[record.id], undefined);
    await win.locator('[data-action="timeline-draft-discard"]').click();
    await close(win);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    assert.equal(activity(data).drafts['orphan-0'].note, '旧内容 0');
    await Promise.all([
      win.waitForEvent('close', { timeout: 12000 }),
      win.locator('[data-action="window-close"]').click(),
    ]);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    check('failed new draft can be explicitly discarded and application exits with all old drafts intact', { oldDrafts: 100 });
    await app.close().catch(() => {});
    running = await launch(data);
    ({ app, win } = running);
    await nav(win, 'saves');
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    await win.locator('#timeline-note').fill('释放容量后可保存');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    await close(win);
    await win.locator('details').filter({ hasText: '尚未正式保存的节点草稿' }).first().locator('summary').click();
    await win.locator('[data-action="node-draft-remove"][data-id="orphan-0"]').click();
    await win.locator('[data-action="node-draft-remove"][data-id="orphan-0"]').waitFor({ state: 'detached' });
    assert.equal(activity(data).drafts['orphan-0'], undefined);
    assert.equal(activity(data).drafts[record.id].note, '释放容量后可保存');
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    assert.equal(await win.locator('#timeline-note').inputValue(), '释放容量后可保存');
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.waitForFunction((id) => !document.querySelector('#timeline-note')?.value.includes('暂存失败'), record.id);
    assert.equal(timeline(data).records.find((r) => r.id === record.id).note, '释放容量后可保存');
    assert.equal(activity(data).drafts[record.id], undefined);
    check('deleting an orphan frees capacity and flushes pending new draft, then formal save clears it', { oldRemoved: 'orphan-0', recordId: record.id });
    await close(win);

    const topUp = await win.evaluate(() => window.journal.nodeDraft('orphan-replacement', { label: '补满', note: '仍保留' }));
    assert.equal(topUp.ok, true);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    await win.locator('#timeline-note').fill('满额仍可正式保存');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.waitForFunction(() => document.querySelector('.drawer h1'));
    assert.equal(timeline(data).records.find((r) => r.id === record.id).note, '满额仍可正式保存');
    assert.equal(activity(data).drafts[record.id], undefined);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    check('formal node save succeeds even when unfinished draft storage is full', { oldDrafts: 100 });
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function interleavedNodeSave() {
  const data = makeData('interleaved-node');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(3));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const nodeA = t.record(save(3, 1, 3000), 'manual', Date.now() - 30000);
  const nodeB = t.record(save(4, 4, 4000), 'manual', Date.now() - 20000);
  t.updateNode(nodeA.id, { label: '节点 A', note: 'A 原备注' });
  t.updateNode(nodeB.id, { label: '节点 B', note: 'B 原备注' });
  running = await launch(data);
  const { app, win } = running;
  try {
    // Patch only this isolated process's Activity method. The gate resolves solely for A's
    // first draft write; the main IPC handler actually awaits it while the renderer opens B.
    await app.evaluate(({ app }, id) => {
      const requireForApp = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const ActivityClass = requireForApp('./src/core/activity.cjs').Activity;
      globalThis.reviewDraftOriginal = ActivityClass.prototype.draft;
      globalThis.reviewDraftClass = ActivityClass;
      globalThis.reviewWaiting = false;
      globalThis.reviewReleased = false;
      globalThis.reviewTargetNote = 'A 新备注';
      ActivityClass.prototype.draft = function (draftId, value) {
        if (draftId === id && value?.note === globalThis.reviewTargetNote && !globalThis.reviewWaiting) {
          globalThis.reviewWaiting = true;
          return new Promise((resolve) => {
            globalThis.reviewRelease = () => {
              globalThis.reviewReleased = true;
              resolve(globalThis.reviewDraftOriginal.call(this, draftId, value));
            };
          });
        }
        return globalThis.reviewDraftOriginal.call(this, draftId, value);
      };
    }, nodeA.id);
    await nav(win, 'saves');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    await win.locator('#timeline-label').fill('A 新名称');
    await win.locator('#timeline-note').fill('A 新备注');
    await app.evaluate(async () => {
      const deadline = Date.now() + 4000;
      while (!globalThis.reviewWaiting && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!globalThis.reviewWaiting) throw Error('A draft did not reach the controlled IPC gate');
    });
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.keyboard.press('Escape');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeB.id}"]`).first().click();
    assert.equal(await win.locator('.drawer h1').innerText(), '节点 B');
    assert.equal(await win.locator('#timeline-note').inputValue(), 'B 原备注');
    assert.equal(await app.evaluate(() => globalThis.reviewReleased), false);
    await app.evaluate(() => globalThis.reviewRelease());
    await win.waitForFunction((id) => document.querySelector('.drawer h1')?.textContent === '节点 B', nodeB.id);
    await win.waitForTimeout(250);
    const records = timeline(data).records;
    assert.equal(records.find((r) => r.id === nodeA.id).label, 'A 新名称');
    assert.equal(records.find((r) => r.id === nodeA.id).note, 'A 新备注');
    assert.equal(records.find((r) => r.id === nodeB.id).label, '节点 B');
    assert.equal(records.find((r) => r.id === nodeB.id).note, 'B 原备注');
    assert.equal(await win.locator('.drawer h1').innerText(), '节点 B');
    assert.equal(await win.locator('#timeline-note').inputValue(), 'B 原备注');
    check('delayed A draft IPC does not read B fields or replace B preview after A save resumes', {
      aId: nodeA.id, bId: nodeB.id, gateReached: true, releasedAfterBOpened: true,
    });
    await win.keyboard.press('Escape');
    await app.evaluate(() => {
      globalThis.reviewTargetNote = 'A 第二备注';
      globalThis.reviewWaiting = false;
      globalThis.reviewReleased = false;
      globalThis.reviewRelease = null;
    });
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    await win.locator('#timeline-note').fill('A 第二备注');
    await app.evaluate(async () => {
      const deadline = Date.now() + 4000;
      while (!globalThis.reviewWaiting && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!globalThis.reviewWaiting) throw Error('second A draft did not reach IPC gate');
    });
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.keyboard.press('Escape');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    assert.equal(await win.locator('#timeline-note').isDisabled(), true);
    assert.equal(await win.locator('[data-action="timeline-edit-save"]').first().isDisabled(), true);
    assert.equal(await win.locator('[data-action="timeline-draft-discard"]').isDisabled(), true);
    assert.equal(await win.locator('#timeline-note').inputValue(), 'A 第二备注');
    await app.evaluate(() => globalThis.reviewRelease());
    await win.waitForFunction(() => document.querySelector('#timeline-note') && !document.querySelector('#timeline-note').disabled);
    assert.equal(timeline(data).records.find((r) => r.id === nodeA.id).note, 'A 第二备注');
    await win.locator('#timeline-note').fill('A 最终备注');
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.waitForFunction(() => document.querySelector('#timeline-note')?.value === 'A 最终备注');
    assert.equal(timeline(data).records.find((r) => r.id === nodeA.id).note, 'A 最终备注');
    check('reopened same node stays locked during pending save, then unlocks for a durable follow-up edit', { aId: nodeA.id });
  } finally {
    await app.evaluate(() => {
      if (globalThis.reviewRelease && !globalThis.reviewReleased) globalThis.reviewRelease();
      if (globalThis.reviewDraftClass && globalThis.reviewDraftOriginal)
        globalThis.reviewDraftClass.prototype.draft = globalThis.reviewDraftOriginal;
    }).catch(() => {});
    await app.close().catch(() => {});
    running = null;
  }
}

async function inFlightLoadUi() {
  const data = makeData('inflight-load-ui');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(3));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  new Saves(path.join(data, 'save-backups')).capture(source, '隔离备份预览');
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const nodeA = t.record(save(3, 1, 3000), 'manual', Date.now() - 30000);
  const nodeB = t.record(save(4, 4, 4000), 'manual', Date.now() - 20000);
  t.updateNode(nodeA.id, { label: '等待节点 A' });
  t.updateNode(nodeB.id, { label: '等待节点 B' });
  running = await launch(data);
  const { app, win } = running;
  const waitCalls = (count) => app.evaluate(async (_context, n) => {
    const deadline = Date.now() + 4000;
    while (globalThis.reviewLoadCalls.length < n && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (globalThis.reviewLoadCalls.length < n) throw Error(`expected ${n} controlled load IPC calls`);
  }, count);
  const pulse = async () => {
    const result = await win.evaluate(() => window.journal.health());
    assert.equal(result.ok, true);
    assert.equal(result.data.timeline.ready, true);
    await app.evaluate(({ app }, health) => {
      const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      for (const w of req('electron').BrowserWindow.getAllWindows())
        w.webContents.send('journal:event', { type: 'health', health });
    }, result.data);
  };
  try {
    await app.evaluate(({ app }, expectedData) => {
      if (process.env.YIJIAN_TEST_DATA !== expectedData) throw Error('controlled IPC requires isolated test data');
      const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const { ipcMain } = req('electron');
      const GameBridgeClass = req('./src/core/game-bridge.cjs').GameBridge;
      globalThis.reviewBridgeClass = GameBridgeClass;
      globalThis.reviewSummaryOriginal = GameBridgeClass.prototype.summary;
      GameBridgeClass.prototype.summary = function () {
        return { ...globalThis.reviewSummaryOriginal.call(this), ready: true, connected: true,
          busy: false, pending: false, quiescing: false, reason: '隔离测试可读档' };
      };
      globalThis.reviewLoadCalls = [];
      ipcMain.removeHandler('journal:timeline-load');
      ipcMain.handle('journal:timeline-load', (_event, id) => new Promise((resolve, reject) => {
        globalThis.reviewLoadCalls.push({ id, resolve, reject });
      }));
    }, data);
    await pulse();
    await nav(win, 'saves');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    const loadButton = win.locator('#timeline-load-button');
    await win.waitForFunction(() => document.querySelector('#timeline-load-button')?.disabled === false);
    await loadButton.click();
    await waitCalls(1);
    assert.equal((await app.evaluate(() => globalThis.reviewLoadCalls.map((c) => c.id)))[0], nodeA.id);
    await pulse();
    await win.waitForFunction(() => document.querySelector('#timeline-load-button')?.disabled === true);
    assert.match(await loadButton.innerText(), /确认或读档处理中/);
    assert.match(await win.locator('#timeline-load-readiness').innerText(), /关闭预览不会取消已确认的读档/);
    assert.match(await win.locator('.drawer-actions [data-action="close-overlay"]').innerText(), /关闭预览（不取消读档）/);
    check('healthy status event cannot reenable an in-flight load; closing label states it does not cancel', { nodeId: nodeA.id });

    await win.keyboard.press('Escape');
    await win.locator('.drawer').waitFor({ state: 'detached' });
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeB.id}"]`).first().click();
    assert.equal(await win.locator('.drawer h1').innerText(), '等待节点 B');
    assert.equal(await loadButton.isDisabled(), true);
    assert.match(await win.locator('.drawer-actions [data-action="close-overlay"]').innerText(), /关闭预览（不取消读档）/);
    await loadButton.evaluate((e) => e.click());
    await win.waitForTimeout(100);
    assert.deepEqual(await app.evaluate(() => globalThis.reviewLoadCalls.map((c) => c.id)), [nodeA.id]);
    check('Escape and reopening another node preserve the global load lock and refuse a second request', { first: nodeA.id, reopened: nodeB.id });

    await app.evaluate(() => globalThis.reviewLoadCalls[0].resolve({ ok: true, data: { cancelled: true } }));
    await win.waitForFunction(() => document.querySelector('.drawer h1')?.textContent === '等待节点 B' &&
      document.querySelector('#timeline-load-button')?.disabled === false);
    assert.match(await loadButton.innerText(), /保护当前进度并读档/);
    assert.match(await win.locator('.drawer-actions [data-action="close-overlay"]').innerText(), /先不读档/);
    check('cancelled load restores B controls without closing B preview', { cancelled: nodeA.id, visible: nodeB.id });

    await loadButton.click();
    await waitCalls(2);
    assert.equal((await app.evaluate(() => globalThis.reviewLoadCalls.map((c) => c.id)))[1], nodeB.id);
    await app.evaluate(() => globalThis.reviewLoadCalls[1].reject(Error('合成读档失败')));
    await win.locator('.toast.error').filter({ hasText: '合成读档失败' }).waitFor();
    await win.waitForFunction(() => document.querySelector('.drawer h1')?.textContent === '等待节点 B' &&
      document.querySelector('#timeline-load-button')?.disabled === false);
    check('rejected load restores B controls and retains its preview', { rejected: nodeB.id });

    await loadButton.click();
    await waitCalls(3);
    const environment = (await win.evaluate(() => window.journal.refresh())).data;
    await app.evaluate((_context, snapshot) =>
      globalThis.reviewLoadCalls[2].resolve({ ok: true, data: { cancelled: false, environment: snapshot } }), environment);
    await win.locator('.drawer').waitFor({ state: 'detached' });
    await win.locator('.toast').filter({ hasText: '历史进度已读入' }).waitFor();
    check('simulated successful load follows the normal close-and-refresh path', { completed: nodeB.id });
    await win.locator('[data-action="backup-preview"]').first().click();
    assert.match(await win.locator('.drawer h1').innerText(), /隔离备份预览/);
    await pulse();
    assert.equal(await win.locator('#timeline-load-button').count(), 0);
    assert.equal(await win.locator('.drawer-actions [data-action="close-overlay"]').last().innerText(), '先不恢复');
    check('healthy status event leaves backup preview footer labelled as declining restore', { backup: '隔离备份预览' });
    assert.equal(fs.existsSync(path.join(data, 'game-bridge', 'command.txt')), false);
  } finally {
    await app.evaluate(({ app }) => {
      const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const { ipcMain } = req('electron');
      for (const call of globalThis.reviewLoadCalls || []) call.resolve({ ok: true, data: { cancelled: true } });
      ipcMain.removeHandler('journal:timeline-load');
      if (globalThis.reviewBridgeClass && globalThis.reviewSummaryOriginal)
        globalThis.reviewBridgeClass.prototype.summary = globalThis.reviewSummaryOriginal;
    }).catch(() => {});
    await app.close().catch(() => {});
    running = null;
  }
}

async function cancelledTrayQuit() {
  const data = makeData('tray-quit');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(5));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const record = t.record(save(5), 'manual', Date.now() - 10000);
  const a = new Activity(data);
  for (let i = 0; i < 100; i++) a.draft(`tray-old-${i}`, { label: `旧稿 ${i}`, note: `内容 ${i}` });
  running = await launch(data, true);
  const { app, win } = running;
  try {
    console.log('tray: launched');
    const initial = await win.evaluate(async () => (await window.journal.health()).data);
    assert.equal(initial.background, true, 'the isolated tray must actually be available');
    console.log('tray: active');
    await nav(win, 'saves');
    await win.locator(`[data-action="timeline-preview"][data-id="${record.id}"]`).first().click();
    await win.locator('#timeline-note').fill('退出前写不下的新稿');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    console.log('tray: failed draft visible');
    assert.equal(activity(data).drafts[record.id], undefined);
    // Bypass the renderer's explicit quit preflush so the real requestQuit -> app.quit ->
    // beforeunload/will-prevent-unload chain is exercised with a failed pending draft.
    await win.evaluate(() => { window.journal.window('quit'); });
    console.log('tray: quit requested');
    await win.waitForFunction(async () => {
      const r = await window.journal.health();
      return r.ok && !r.data.quitting && !r.data.timeline.quiescing;
    }, null, { timeout: 12000 });
    assert.equal(win.isClosed(), false);
    console.log('tray: quit latch reset');
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    await win.locator('[data-action="window-quit-discard"]').waitFor();
    assert.match(await win.locator('.modal').innerText(), /仍有节点草稿未保存/);
    await Promise.all([
      win.waitForEvent('close', { timeout: 12000 }),
      win.locator('[data-action="window-quit-discard"]').click(),
    ]);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    assert.equal(activity(data).drafts['tray-old-0'].note, '内容 0');
    console.log('tray: final quit complete');
    check('tray quit cancelled for failed new draft resets quitting latch; modal discard exits with old drafts', {
      oldDrafts: 100, recordId: record.id, healthReset: true,
    });
  } finally {
    const killTimer = setTimeout(() => app.process()?.kill(), 8000);
    await app.close().catch(() => {});
    clearTimeout(killTimer);
    running = null;
  }
}

(async () => {
  try {
    const groups = {
      references: referenceAndPolling,
      firstSave: firstSaveAppears,
      referenceEdges: referenceRefreshEdges,
      draftCapacity: fullDraftCapacity,
      interleavedNode: interleavedNodeSave,
      loadInFlight: inFlightLoadUi,
      trayQuit: cancelledTrayQuit,
    };
    const requested = process.env.YIJIAN_REVIEW_ONLY?.split(',') || Object.keys(groups);
    for (const name of requested) {
      if (!groups[name]) throw Error('Unknown review group: ' + name);
      await groups[name]();
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
  } catch (e) {
    report.passed = false;
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    if (running) await running.app.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(report);
  }
})();
