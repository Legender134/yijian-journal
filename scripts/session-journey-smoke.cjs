'use strict';
// Actual assistant source/packaged Electron, isolated synthetic saves only.
// Only the exact candidate assistant EXE may override source Electron.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
if (
  override &&
  (path.resolve(override).toLowerCase() !== expectedExecutable.toLowerCase() ||
    path.basename(override) !== '逸剑手札.exe')
)
  throw Error('只接受本候选打包的逸剑手札.exe作为UI测试目标');
const executionMode = override ? 'packaged-assistant' : 'source-electron';
const executable = override ? expectedExecutable : require('electron');
const data = path.join(base, '.test-data', 'session-journey-ui-' + Date.now());
const userData = path.join(data, 'userdata');
const source = path.join(data, 'synthetic-SaveGames');
const saveFile = path.join(source, '0.sav');
const resultDir = path.join(base, 'test-results');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(resultDir, { recursive: true });
function save(step) {
  fs.writeFileSync(
    saveFile,
    syntheticSave({ full: true, seconds: 9000, quests: [{ id: 14082, step }], inventory: [] }),
  );
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(saveFile, old, old);
  return crypto.createHash('sha256').update(fs.readFileSync(saveFile)).digest('hex');
}
let expectedHash = save(1);
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '0.sav', mode: 'slot' });
for (const [id, title] of [
  ['first', '合成先看药材'],
  ['second', '合成再核对配方'],
])
  store.mutate({ type: 'journey-todo-put', id, title, detail: '合成测试，不操作游戏。', done: false });
store.mutate({
  type: 'goal-add',
  title: '合成桃花林事项',
  source: { type: 'quest', id: 'quest-14082' },
  progressMode: 'automatic',
});
let app, page, companion;
const checks = [],
  errors = [],
  visibility = [];
async function current(target = page) {
  const result = await target.evaluate(() => window.journal.bootstrap());
  assert.equal(result.ok, true, result.error);
  return result.data.state.profiles.find((p) => p.id === result.data.state.activeProfileId);
}
async function plan(target = page) {
  const result = await target.evaluate(() => window.journal.journeyPlan());
  assert.equal(result.ok, true, result.error);
  return result.data;
}
async function until(fn, predicate, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error(label);
}
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (/^YIJIAN_GAME.*(?:PATH|EXECUTABLE|EXE)$/.test(key)) delete env[key];
  app = await _electron.launch({ executablePath: executable, args: override ? [] : [base], cwd: base, env });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.layout').waitFor();
}
async function nav(id) {
  await page.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function compact() {
  const made = app.waitForEvent('window');
  await page.locator('.topbar [data-action="compact"]').click();
  companion = await made;
  companion.on('pageerror', (error) => errors.push(error.message));
  await companion.locator('[data-companion-itinerary]').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact'));
    if (!win) throw Error('synthetic companion window not found');
    win.setContentSize(460, 660);
  });
}
async function next(target, id) {
  await target.locator('[data-itinerary-next="' + id + '"]').waitFor();
}
function row(id) {
  return page.locator('[data-itinerary-step="' + id + '"]');
}
async function expandUndo() {
  const summary = companion.locator('summary').filter({ hasText: '撤回个人处理、完成计划或本次跳过' });
  if (!(await summary.locator('..').getAttribute('open'))) await summary.click();
}
(async () => {
  try {
    await launch();
    await nav('journey');
    assert.match(await page.locator('[data-itinerary]').innerText(), /挑选本次/);
    const firstPlan = await plan();
    const a = firstPlan.actions.find((a) => a.sources.some((s) => s.type === 'user' && s.id === 'first'));
    const b = firstPlan.actions.find((a) => a.sources.some((s) => s.type === 'user' && s.id === 'second'));
    const q = firstPlan.actions.find((a) => a.questId === 'quest-14082');
    for (const id of [a.id, b.id])
      await page.locator('[data-journey-id="' + id + '"] [data-action="journey-itinerary-add"]').click();
    const questCard = page.locator('[data-journey-id="' + q.id + '"]');
    await questCard.locator('[data-action="journey-itinerary-add"]').click();
    await until(current, (p) => p.journey.itinerary.steps.length === 3, 'pending scene was not saved');
    assert.equal(
      Object.hasOwn(
        (await current()).journey.itinerary.steps.find((s) => s.actionId === q.id),
        'placeId',
      ),
      false,
    );
    assert.match(await row(q.id).innerText(), /场景待核定/);
    for (let i = 0; i < 2; i++)
      await row(q.id).locator('[data-action="journey-itinerary-move"][data-direction="up"]').click();
    await until(current, (p) => p.journey.itinerary.steps[0].actionId === q.id, 'pending scene ordering');
    await nav('home');
    assert.match(await page.locator('[data-home-itinerary-next="' + q.id + '"]').innerText(), /场景待核定/);
    await page.screenshot({
      path: path.join(resultDir, 'session-scene-pending-home.png'),
      animations: 'disabled',
    });
    await compact();
    await next(companion, q.id);
    assert.match(await companion.locator('[data-itinerary-next="' + q.id + '"]').innerText(), /场景待核定/);
    await companion.screenshot({
      path: path.join(resultDir, 'session-scene-pending-compact.png'),
      animations: 'disabled',
    });
    await app.close();
    await launch();
    await nav('journey');
    assert.equal((await current()).journey.itinerary.steps[0].actionId, q.id);
    assert.equal((await plan()).itinerary.next.placePending, true);
    assert.match(await row(q.id).innerText(), /场景待核定/);
    const chosenPlace = [...new Set(q.places.flatMap((p) => p.mapIds))][1];
    assert.ok(chosenPlace);
    await row(q.id).locator('summary').filter({ hasText: '更换本次场景' }).click();
    await row(q.id).locator('[data-itinerary-place]').selectOption(chosenPlace);
    await row(q.id).locator('[data-action="journey-itinerary-place"]').click();
    await until(
      current,
      (p) => p.journey.itinerary.steps[0].placeId === chosenPlace,
      'later exact scene did not persist',
    );
    for (let i = 0; i < 2; i++)
      await row(q.id).locator('[data-action="journey-itinerary-move"][data-direction="down"]').click();
    await until(current, (p) => p.journey.itinerary.steps[2].actionId === q.id, 'original order restored');
    checks.push('多场景行动可先按场景待核定加入，首页/小窗与冷重启保留名称、顺序和来源，之后可补选确切场景');
    await row(a.id).locator('[data-action="journey-itinerary-move"][data-direction="down"]').click();
    await until(current, (p) => p.journey.itinerary.steps[0].actionId === b.id, 'ordering did not persist');
    await page.locator('[data-itinerary] summary').filter({ hasText: '调整名称' }).click();
    await page.locator('#journey-itinerary-name').fill('本次合成行程');
    await page.locator('[data-action="journey-itinerary-name"]').click();
    await until(
      current,
      (p) => p.journey.itinerary.name === '本次合成行程',
      'renaming after selection and ordering did not persist',
    );
    await page.locator('[data-itinerary] [data-action="journey-itinerary-status"][data-id="active"]').click();
    await next(page, b.id);
    checks.push('全部行动挑选、场景选择、去重、排序、默认名称与开始已持久化');
    await page.screenshot({ path: path.join(resultDir, 'session-journey-main.png'), fullPage: true });

    await nav('home');
    await page.locator('[data-home-itinerary-next="' + b.id + '"]').waitFor();
    assert.match(await page.locator('[data-home-itinerary]').innerText(), /本次合成行程/);
    const originalMainSize = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('compact'));
      const size = win.getContentSize();
      win.setContentSize(980, 660);
      return size;
    });
    const homeNextBounds = await page
      .locator('[data-home-itinerary-next] [data-action="journey-itinerary-handle"]')
      .boundingBox();
    const homeViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(
      homeNextBounds &&
        homeNextBounds.y >= 0 &&
        homeNextBounds.y + homeNextBounds.height <= homeViewport.height,
      'chosen next action must be usable in the first minimum main-window viewport',
    );
    visibility.push({ target: 'home', viewport: homeViewport, nextBounds: homeNextBounds });
    await page.screenshot({ path: path.join(resultDir, 'session-journey-home.png') });
    await page.locator('[data-home-itinerary-next] [data-action="journey-itinerary-handle"]').click();
    await page.locator('[data-home-itinerary-next="' + a.id + '"]').waitFor();
    await nav('journey');
    await row(b.id).locator('[data-action="journey-itinerary-handle"]').click();
    await next(page, b.id);
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('compact'));
      win.setContentSize(...size);
    }, originalMainSize);
    checks.push('首页显示玩家命名和排序的行程下一项，可直接个人处理；撤回后与主行程保持一致');

    await compact();
    await next(companion, b.id);
    const nextButton = companion.locator('[data-itinerary-next] [data-action="journey-itinerary-handle"]');
    const nextBounds = await nextButton.boundingBox();
    const viewport = await companion.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(
      nextBounds &&
        nextBounds.x >= 0 &&
        nextBounds.y >= 0 &&
        nextBounds.x + nextBounds.width <= viewport.width &&
        nextBounds.y + nextBounds.height <= viewport.height,
      'next action must be usable in the first small-window viewport',
    );
    visibility.push({ viewport, nextBounds });
    await companion.screenshot({ path: path.join(resultDir, 'session-journey-companion-first-screen.png') });
    await companion.locator('[data-itinerary-next] [data-action="journey-itinerary-handle"]').click();
    await next(companion, a.id);
    await next(page, a.id);
    await companion.locator('[data-itinerary-next] [data-action="journey-itinerary-skip"]').click();
    await next(companion, q.id);
    const skipped = await plan(companion);
    assert.equal(skipped.actions.find((x) => x.id === a.id).handled, false);
    assert.equal(skipped.actions.find((x) => x.id === a.id).userDone, false);
    assert.equal(skipped.itinerary.steps.find((s) => s.actionId === a.id).status, 'skipped');
    await expandUndo();
    await companion.locator('[data-action="journey-itinerary-skip"][data-id="' + a.id + '"]').click();
    await next(companion, a.id);
    await companion.locator('[data-itinerary-next] [data-action="journey-itinerary-handle"]').click();
    await next(companion, q.id);
    await row(a.id).locator('[data-action="journey-itinerary-skip"]').click();
    await expandUndo();
    await companion.locator('[data-action="journey-itinerary-handle"][data-id="' + a.id + '"]').click();
    const both = await until(
      () => plan(companion),
      (p) => p.itinerary.steps.find((s) => s.actionId === a.id).handled === false,
      'handling undo did not persist while skipped',
    );
    assert.equal(both.itinerary.steps.find((s) => s.actionId === a.id).skipped, true);
    checks.push('小窗与主页面共享当前项；个人处理推进，本次跳过不改变全量待办，两种状态可独立撤回');
    await companion.screenshot({
      path: path.join(resultDir, 'session-journey-companion.png'),
      fullPage: true,
    });

    expectedHash = save(4);
    await page.locator('[data-action="journey-refresh"]').click();
    await until(
      plan,
      (p) => p.itinerary.steps.find((s) => s.actionId === q.id).status === 'game-complete',
      'save-derived completion did not project',
    );
    await until(
      () => companion.evaluate(() => window.journal.companionSnapshot()).then((r) => r.data),
      (p) => p.itinerary.summary['game-complete'] === 1,
      'small-window completion did not project',
    );
    await companion.locator('[data-action="journey-itinerary-status"][data-id="ended"]').click();
    await companion.locator('[data-action="journey-itinerary-journal"]').waitFor();
    await companion.locator('[data-action="journey-itinerary-journal"]').click();
    await companion.locator('#journal-entry-form').waitFor();
    assert.match(await companion.locator('#journal-title').inputValue(), /本次合成行程/);
    assert.match(await companion.locator('#journal-body').inputValue(), /不代表这一程新增/);
    await companion.locator('[data-action="journal-entry-save"]').click();
    await until(
      current,
      (p) => (p.journalEntries || []).some((e) => e.title === '本次合成行程 · 行程回顾'),
      'recap did not use existing journal writer',
    );
    checks.push('合成存档更新自动推进且仍保留原选择；结束回顾预填并保存既有江湖记录');

    const firstId = (await current()).id;
    await page.evaluate(async () => {
      const add = await window.journal.mutate({ type: 'profile-add', name: '第二合成周目', mode: 'none' });
      if (!add.ok) throw Error(add.error);
      const todo = await window.journal.mutate({
        type: 'journey-todo-put',
        title: '第二程合成待办',
        detail: '',
        done: false,
      });
      if (!todo.ok) throw Error(todo.error);
    });
    await nav('journey');
    const second = await current();
    await page.locator('[data-action="journey-itinerary-add"]').first().click();
    await page.locator('[data-itinerary] [data-action="journey-itinerary-status"][data-id="active"]').click();
    const secondChoice = (await current()).journey.itinerary.steps[0].actionId;
    await page.evaluate(async (id) => {
      const result = await window.journal.mutate({ type: 'profile-switch', id });
      if (!result.ok) throw Error(result.error);
    }, firstId);
    await until(
      current,
      (p) => p.id === firstId && p.journey.itinerary.status === 'ended',
      'first profile did not restore',
    );
    await app.close();
    app = null;
    await launch();
    await page.locator('[data-home-itinerary]').waitFor();
    assert.match(await page.locator('[data-home-itinerary]').innerText(), /本次合成行程/);
    await page
      .locator('[data-home-itinerary] [data-action="navigate"]')
      .filter({ hasText: '查看这一程回顾' })
      .waitFor();
    await nav('journey');
    assert.equal((await current()).journey.itinerary.status, 'ended');
    assert.equal((await current()).journey.itinerary.steps.length, 3);
    assert.equal(
      (await current()).journey.itinerary.steps.find((s) => s.actionId === q.id).placeId,
      chosenPlace,
    );
    await page.locator('[data-itinerary] [data-action="journey-itinerary-status"][data-id="active"]').click();
    await page.evaluate(async (id) => {
      const result = await window.journal.mutate({ type: 'profile-switch', id });
      if (!result.ok) throw Error(result.error);
    }, second.id);
    await until(current, (p) => p.id === second.id, 'second profile did not restore');
    await compact();
    await next(companion, secondChoice);
    assert.equal((await current()).journey.itinerary.steps.length, 1);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(saveFile)).digest('hex'), expectedHash);
    checks.push('结束/继续及精确场景在冷重启保留；周目切换与小窗恢复独立队列；应用未改合成游戏文件');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(resultDir, 'session-journey-ui-result.json'),
      JSON.stringify(
        { status: 'PASS', executionMode, executable, checks, data, expectedHash, visibility, errors },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', executionMode, executable, checks, data }, null, 2));
  } catch (error) {
    fs.writeFileSync(
      path.join(resultDir, 'session-journey-ui-result.json'),
      JSON.stringify(
        { status: 'FAIL', executionMode, executable, checks, data, error: error.stack, errors },
        null,
        2,
      ),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(resultDir, 'session-journey-failure.png'), fullPage: true })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
