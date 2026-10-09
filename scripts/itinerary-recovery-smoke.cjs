'use strict';
// Bounded source/candidate GUI check. Only isolated synthetic notes and saves.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto'),
  { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { journeyPlan } = require('../src/core/journey-plan.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs'),
  migration = require('../src/core/migration.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..'),
  version = require('../package.json').version;
const expectedExecutable = path.join(base, 'dist', 'v' + version, '逸剑手札-win32-x64', '逸剑手札.exe');
const override = process.env.YIJIAN_EXECUTABLE;
if (override && path.resolve(override).toLowerCase() !== expectedExecutable.toLowerCase())
  throw Error('只接受本候选实际EXE');
const results = path.join(base, 'test-results', 'itinerary-recovery-' + Date.now());
const userData = path.join(results, 'userdata'),
  saves = path.join(results, 'synthetic-SaveGames');
fs.mkdirSync(saves, { recursive: true });
const saveFile = path.join(saves, '0.sav');
fs.writeFileSync(saveFile, syntheticSave({ full: true, inventory: [] }));
const stamp = new Date(Date.now() - 5000);
fs.utimesSync(saveFile, stamp, stamp);
const hash = () => createHash('sha256').update(fs.readFileSync(saveFile)).digest('hex'),
  initialSaveHash = hash();
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
for (const [id, title, placeId] of [
  ['first', '精确场景九的原事项', 'place-9'],
  ['second', '先去精确场景二十二', 'place-22'],
])
  store.mutate({ type: 'journey-todo-put', id, title, detail: '原行程完整说明\n末行', placeId, done: false });
const owner = () => {
  const s = store.get();
  return s.profiles.find((p) => p.id === s.activeProfileId);
};
const actions = journeyPlan(owner(), null).actions;
const A = actions.find((a) => a.sources.some((s) => s.type === 'user' && s.id === 'first')).id;
const B = actions.find((a) => a.sources.some((s) => s.type === 'user' && s.id === 'second')).id;
for (const [id, placeId] of [
  [A, 'place-9'],
  [B, 'place-22'],
])
  store.mutate({ type: 'journey-itinerary-add', id, placeId }, { journeyActions: actions });
store.mutate({ type: 'journey-itinerary-move', id: B, direction: 'up' });
store.mutate({ type: 'journey-itinerary-skip', id: B, skipped: true });
store.mutate({ type: 'journey-itinerary-name', name: '可单独找回的原两项行程' });
store.mutate({ type: 'journey-itinerary-status', status: 'active' });
const original = structuredClone(owner().journey.itinerary),
  historyState = store.get();
historyState.profiles[0].journeyTrash = [
  { id: 'historical-trip', kind: 'itinerary', record: original, deletedAt: '2026-10-09T01:00:00.000Z' },
];
const historicalStore = new Store(path.join(results, 'historical-source'), catalog);
historicalStore.importData(historyState);
const protection = path.join(results, 'synthetic-history.yijian-protection');
const checks = [],
  errors = [];
let app, page, companion;
const clone = (v) => structuredClone(v);
async function current(target = page) {
  const r = await target.evaluate(() => window.journal.bootstrap());
  assert(r.ok, r.error);
  return r.data.state.profiles.find((p) => p.id === r.data.state.activeProfileId);
}
async function mutate(command, target = page) {
  const r = await target.evaluate((c) => window.journal.mutate(c), command);
  assert(r.ok, r.error);
  return r;
}
async function until(predicate) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const p = await current();
    if (predicate(p)) return p;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw Error('行程操作未在短测试窗口完成');
}
const bytes = () =>
  ['journal.json', 'journal.json.previous'].map((name) => fs.readFileSync(path.join(userData, name)));
const nav = (route) => page.locator('.nav-btn[data-id="' + route + '"]').click();
const tripRow = (id) => page.locator('[data-itinerary-step="' + id + '"]');
const archived = (id) => page.locator('[data-journey-trash-id="' + id + '"]');
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (/^YIJIAN_GAME.*(?:PATH|EXECUTABLE|EXE)$/.test(key)) delete env[key];
  app = await _electron.launch({
    executablePath: override || require('electron'),
    args: override ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.layout').waitFor();
}
async function openCompact() {
  const window = app.waitForEvent('window');
  await page.locator('.topbar [data-action="compact"]').click();
  companion = await window;
  companion.on('pageerror', (error) => errors.push(error.message));
  await companion.locator('.compact-shell').waitFor();
}
async function previewRestore(id) {
  await archived(id).locator('[data-action="journey-trash-restore-preview"]').click();
}
function assertIndependent(p, before) {
  for (const key of [
    'notes',
    'goals',
    'journalEntries',
    'journalDrafts',
    'journalTrash',
    'journalRevisions',
    'intentDrafts',
    'craftList',
    'craftPlans',
  ])
    assert.deepEqual(p[key], before[key], key);
  assert.deepEqual(p.journey, { ...before.journey, itinerary: p.journey.itinerary });
}
(async () => {
  try {
    await migration.exportProtection({ dataRoot: historicalStore.dir, file: protection });
    await launch();
    await nav('journey');
    await openCompact();
    await tripRow(B).locator('[data-action="journey-itinerary-remove"]').click();
    let p = await until((p) => p.journeyTrash?.length === 1 && p.journey.itinerary.steps.length === 1);
    assert.deepEqual(p.journeyTrash[0].record, original);
    assert.equal(await tripRow(B).count(), 0);
    const removed = p.journeyTrash[0];
    await page.locator('#toasts [data-action="journey-trash-open"]').click();
    await previewRestore(removed.id);
    let text = await page.locator('#overlay').innerText();
    for (const expected of [
      original.name,
      '当前待替换行程',
      'place-22',
      'place-9',
      '仅本次跳过',
      '个人已处理按当前状态保留',
    ])
      assert(text.includes(expected), expected);
    let raw = bytes();
    await page.keyboard.press('Escape');
    assert.deepEqual(bytes(), raw);
    for (const command of [
      { type: 'journey-todo-put', id: 'later', title: '后来保存的待办', detail: '后来完整内容', done: true },
      {
        type: 'journey-gift-put',
        id: 'later-gift',
        npcId: 'npc-5011',
        itemId: 'item-1002',
        quantity: 7,
        note: '后来精确赠礼',
        done: true,
      },
      { type: 'goal-add', title: '后来保存的目标', detail: '后来目标详情' },
      {
        type: 'journal-entry-put',
        title: '后来保存的手记',
        body: '后来正文\n完整末行',
        occurredAt: '2026-10-09T02:00:00.000Z',
        tags: [],
        links: [],
        snapshotMode: 'none',
      },
      { type: 'note', value: '后来保存的笔记' },
      { type: 'journey-action-handle', id: B, handled: true },
    ])
      await mutate(command, companion);
    await previewRestore(removed.id);
    await mutate({ type: 'journey-itinerary-name', name: '另一窗后来修改的一项行程' }, companion);
    raw = bytes();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    await page.waitForFunction(() => /本次行程已变化/.test(document.querySelector('#toasts').textContent));
    assert.deepEqual(bytes(), raw);
    await page.keyboard.press('Escape');
    const beforeRestore = await current();
    await previewRestore(removed.id);
    await page.screenshot({ path: path.join(results, 'full-recovery-preview.png'), animations: 'disabled' });
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.journey.itinerary.steps.length === 2);
    assert.deepEqual(p.journey.itinerary, original);
    assertIndependent(p, beforeRestore);
    assert(p.journey.handledActionIds.includes(B));
    assert.deepEqual(p.journeyTrash.at(-1).record, beforeRestore.journey.itinerary);
    checks.push(
      '即时移出可点找回；双完整预览可取消，真实小窗更改使旧确认拒绝且两份文件字节保持；恢复完整两项/顺序/精确场景/跳过并保留后来独立安排与当前个人已处理',
    );

    await page.locator('[data-action="journey-trash-close"]').click();
    await page.locator('[data-action="journey-itinerary-clear"]').click();
    assert.match(await page.locator('#overlay').innerText(), /清空前的完整行程[\s\S]*place-22[\s\S]*place-9/);
    raw = bytes();
    await page.keyboard.press('Escape');
    assert.deepEqual(bytes(), raw);
    await page.locator('[data-action="journey-itinerary-clear"]').click();
    await mutate({ type: 'journey-itinerary-name', name: '清空前另一窗修改的完整行程' }, companion);
    raw = bytes();
    await page.locator('[data-action="journey-itinerary-clear-confirm"]').click();
    await page.waitForFunction(() => /本次行程已变化/.test(document.querySelector('#toasts').textContent));
    assert.deepEqual(bytes(), raw);
    await page.keyboard.press('Escape');
    const beforeClear = await current();
    await page.locator('[data-action="journey-itinerary-clear"]').click();
    await page.locator('[data-action="journey-itinerary-clear-confirm"]').click();
    p = await until((p) => p.journey.itinerary.steps.length === 0);
    const cleared = p.journeyTrash.at(-1);
    assert.deepEqual(cleared.record, beforeClear.journey.itinerary);
    await mutate({ type: 'journey-itinerary-name', name: '清空后后来选择的一程' }, companion);
    await mutate({ type: 'journey-itinerary-add', id: A, placeId: 'place-9' }, companion);
    await app.close();
    app = null;
    await launch();
    await nav('journey');
    await page.locator('[data-action="journey-trash-open"]').click();
    const beforeColdRestore = await current();
    await previewRestore(cleared.id);
    text = await page.locator('#overlay').innerText();
    assert(text.includes('清空后后来选择的一程'));
    await page.screenshot({
      path: path.join(results, 'cold-clear-recovery-preview.png'),
      animations: 'disabled',
    });
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.journey.itinerary.steps.length === 2);
    assert.deepEqual(p.journey.itinerary, cleared.record);
    assertIndependent(p, beforeColdRestore);
    assert.deepEqual(p.journeyTrash.at(-1).record, beforeColdRestore.journey.itinerary);
    checks.push(
      '清空前完整内容可取消；真实小窗改变后旧清空拒绝且字节不变；确认清空后冷重启可单独恢复，后来当前行程先留副本',
    );

    const purge = p.journeyTrash[0],
      beforePurge = clone(p.journeyTrash);
    await archived(purge.id).locator('[data-action="journey-trash-purge-preview"]').click();
    raw = bytes();
    await page.keyboard.press('Escape');
    assert.deepEqual(bytes(), raw);
    await archived(purge.id).locator('[data-action="journey-trash-purge-preview"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.journeyTrash.length === beforePurge.length - 1);
    assert.deepEqual(
      p.journeyTrash,
      beforePurge.filter((row) => row.id !== purge.id),
    );
    const previousOwner = clone(p),
      stale = {
        type: 'journey-trash-restore',
        profileId: p.id,
        id: p.journeyTrash[0].id,
        expectedTrash: p.journeyTrash[0],
        expectedItinerary: p.journey.itinerary,
      };
    await mutate({ type: 'profile-add', name: '另一个合成周目' });
    raw = bytes();
    const rejected = await page.evaluate((command) => window.journal.mutate(command), stale);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /周目已变化/);
    assert.deepEqual(bytes(), raw);
    await mutate({ type: 'profile-switch', id: previousOwner.id });
    assert.deepEqual((await current()).journey, previousOwner.journey);
    checks.push('永久清除可取消并仅移走确认的副本；真实IPC切周目后旧行程恢复拒绝且current/previous字节保持');

    const beforeHistory = await current();
    await nav('saves');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, protection);
    await page.locator('[data-action="protection-import"]').click();
    const historicTrip = page.locator('.historical-itinerary').first();
    await historicTrip.waitFor({ state: 'attached' });
    const ancestorCount = await historicTrip.locator('xpath=ancestor::details').count();
    for (let depth = ancestorCount; depth > 0; depth--) {
      const ancestor = historicTrip.locator('xpath=ancestor::details[' + depth + ']');
      if ((await ancestor.getAttribute('open')) === null) await ancestor.locator('summary').first().click();
    }
    if ((await historicTrip.getAttribute('open')) === null)
      await historicTrip.locator('summary').first().click();
    text = await historicTrip.innerText();
    for (const expected of [original.name, 'place-22', 'place-9', '仅本次跳过'])
      assert(text.includes(expected), expected);
    assert(text.indexOf('先去精确场景二十二') < text.indexOf('精确场景九的原事项'));
    assert.equal(await historicTrip.locator('[data-action]').count(), 0);
    const historicalTrash = page.locator('.journey-trash-panel').first();
    assert.equal(
      await historicalTrash
        .locator('[data-action="journey-trash-restore-preview"],[data-action="journey-trash-purge-preview"]')
        .count(),
      0,
    );
    await page.screenshot({
      path: path.join(results, 'historical-itinerary-read-only.png'),
      animations: 'disabled',
    });
    await historicalTrash.locator('[data-action="historical-journey-trash-detail"]').click();
    assert.match(
      await page.locator('#overlay').innerText(),
      /历史已移除安排 · 只读[\s\S]*place-22[\s\S]*place-9/,
    );
    text = await page.locator('#overlay').innerText();
    assert(!text.includes(A));
    assert(!text.includes(B));
    for (const sourceDetail of await page.locator('#overlay .itinerary-recovery-detail details').all())
      if ((await sourceDetail.getAttribute('open')) === null) await sourceDetail.locator('summary').click();
    text = await page.locator('#overlay').innerText();
    assert(text.includes(A));
    assert(text.includes(B));
    await page.screenshot({
      path: path.join(results, 'historical-itinerary-sources.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    assert.deepEqual(await current(), beforeHistory);
    checks.push(
      '实际保护包导入历史完整行程与历史回收均只读：名称/顺序/精确场景/跳过/原行动完整，无当前行程修改按钮且当前周目完全保持',
    );
    assert.equal(hash(), initialSaveHash);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          version,
          executionMode: override ? 'packaged-assistant' : 'source-electron',
          checks,
          errors,
          initialSaveHash,
          results,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, results }));
  } catch (error) {
    fs.writeFileSync(
      path.join(results, 'result.json'),
      JSON.stringify({ status: 'FAIL', version, checks, errors, error: error.stack, results }, null, 2),
    );
    if (page && !page.isClosed())
      await page.screenshot({ path: path.join(results, 'failure.png'), timeout: 10000 }).catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
