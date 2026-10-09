'use strict';
// Synthetic-only user workflows. Never launches, attaches to, or commands the real game.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { Timeline } = require('../src/core/timeline.cjs'),
  { Activity } = require('../src/core/activity.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs'),
  catalog = require('../src/data/catalog.cjs'),
  index = require('../src/core/game-data.cjs').encyclopedia();
const base = path.resolve(__dirname, '..'),
  data = fs.mkdtempSync(path.join(base, '.test-data', 'usability-')),
  source = path.join(data, 'SaveGames');
fs.mkdirSync(source);
const stock = (count = 10, quests = [{ id: 5200, step: 1 }]) =>
  syntheticSave({ full: true, quests, inventory: [{ id: 10300, count }], money: 10000 });
fs.writeFileSync(path.join(source, '1.sav'), stock());
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'save-slot', value: '1.sav' });
const original = store.get().activeProfileId;
const t = new Timeline(path.join(data, 'game-timeline'));
t.configure(source, false, 10);
const node = t.record(stock(), 'auto', Date.now() - 20000);
t.updateNode(node.id, { label: '已保存名称', note: '已保存备注' });
new Activity(data).record('error', '时间线已停止：合成测试连接异常');
const report = {
  version: require('../package.json').version,
  data,
  checks: [],
  errors: [],
  externalRequests: [],
};
let app, win;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
  });
  win = await app.firstWindow();
  win.on('pageerror', (e) => report.errors.push(e.message));
  win.on('request', (r) => {
    if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await win.locator('.layout').waitFor();
}
async function broadcast() {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('journal:event', { type: 'timeline', text: '' }),
  );
}
async function route(id) {
  await win.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function close() {
  await win.keyboard.press('Escape');
  await win.locator('.drawer').waitFor({ state: 'detached' });
}
async function shot(name) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.capturePage());
  await win.screenshot({ path: path.join(base, 'test-results', 'usability-' + name + '.png') });
}
(async () => {
  try {
    await launch();
    assert.match(await win.locator('.save-health').first().innerText(), /自动保存已停止/);
    assert.match(await win.locator('.start-panel h2').innerText(), /存档保护需要核对/);
    await win.locator('.start-panel .btn.primary[data-action="navigate"][data-id="saves"]').click();
    assert.match(await win.locator('.operation-history').innerText(), /合成测试连接异常/);
    assert.equal(await win.locator('[data-save-ready]').first().isDisabled(), true);
    assert.equal(await win.locator('[data-action="timeline-target"]').count(), 11);
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    assert.equal(await win.locator('#timeline-load-button').isDisabled(), true);
    await win.locator('#timeline-note').fill('关闭和重启后仍要找回的草稿');
    await win.locator('#timeline-label').fill('新的尝试起点');
    await close();
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    assert.equal(await win.locator('#timeline-note').inputValue(), '关闭和重启后仍要找回的草稿');
    await win.waitForFunction(() =>
      document.querySelector('#node-draft-status')?.textContent.includes('草稿'),
    );
    await app.close();
    app = null;
    await launch();
    await route('saves');
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    assert.equal(await win.locator('#timeline-note').inputValue(), '关闭和重启后仍要找回的草稿');
    await win.locator('[data-action="timeline-edit-save"][data-retain="true"]').click();
    await win.locator('.drawer h1').filter({ hasText: '新的尝试起点' }).waitFor();
    const persisted = JSON.parse(fs.readFileSync(path.join(data, 'game-timeline/timeline.json')));
    assert.equal(persisted.records.find((r) => r.id === node.id).bookmarked, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'activity.json'))).drafts[node.id], undefined);
    await shot('retained-draft');
    await close();
    report.checks.push(
      'durable fault feedback, 11 target choices, latest reliable node, disabled unsafe actions, draft survives Escape and restart, explicit save and retain',
    );

    await route('world');
    await win.locator('#world-search').fill('武当求助');
    const card = win.locator('.world-quest-card[data-id="quest-5200"]');
    await win.waitForFunction(() =>
      document.querySelector('.world-quest-card[data-id="quest-5200"]')?.textContent.includes('进行中'),
    );
    fs.writeFileSync(path.join(source, '1.sav'), stock(10, [{ id: 5200, step: 4 }]));
    await broadcast();
    await win.waitForFunction(() =>
      document.querySelector('.world-quest-card[data-id="quest-5200"]')?.textContent.includes('已完成'),
    );
    assert.equal(await win.locator('#world-search').inputValue(), '武当求助');
    fs.writeFileSync(
      path.join(source, '2.sav'),
      stock(10, [
        { id: 5200, step: 4 },
        { id: 5201, step: 1 },
      ]),
    );
    await broadcast();
    await win.waitForFunction(() => !!document.querySelector('#world-save option[value="2.sav"]'));
    await win.locator('#world-save').selectOption('@latest');
    await win.waitForFunction(() =>
      document.querySelector('.world-reference')?.textContent.includes('已读取 2.sav'),
    );
    await win.locator('#world-save').selectOption('1.sav');
    fs.writeFileSync(path.join(source, '2.sav'), stock(9, [{ id: 5200, step: 1 }]));
    await broadcast();
    await win.waitForFunction(() =>
      document.querySelector('.world-reference')?.textContent.includes('已读取 1.sav'),
    );
    await win.evaluate(() => window.journal.mutate({ type: 'save-slot', value: '', mode: 'latest' }));
    fs.writeFileSync(
      path.join(source, '2.sav'),
      stock(10, [
        { id: 5200, step: 4 },
        { id: 5201, step: 1 },
      ]),
    );
    await broadcast();
    await route('home');
    await win.locator('[data-action="refresh"]').click();
    await win.locator('[data-action="save-quest-jump"][data-id="5200"]').first().waitFor();
    const home = (await win.evaluate(() => window.journal.refresh())).data;
    assert.equal(home.recent.pendingTasks, 1);
    assert.equal(home.recent.activeQuests[0].status, '已完成');
    assert.match(await win.locator('.content').innerText(), /当前步骤：/);
    await win.locator('[data-action="save-quest-jump"][data-id="5200"]').first().click();
    assert.match(await win.locator('[data-quest-id="5200"]').innerText(), /已完成/);
    await close();
    report.checks.push(
      'task cache refreshes automatically, fixed slot stays fixed, latest mode follows new slot, active child appears on home without rewriting parent state',
    );

    await route('materials');
    await win.locator('#craft-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="craft-add"][data-id="fusion-7000"]').click();
    await win.locator('#craft-save').selectOption('2.sav');
    await win.locator('[data-action="craft-calculate"]').click();
    await win.waitForFunction(() => document.querySelector('.craft-totals')?.textContent.includes('0 件'));
    await win.locator('#craft-qty-fusion-7000').fill('3');
    await win.locator('.craft-line [data-action="database-detail"][data-id="fusion-7000"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.equal(await win.locator('#recipe-save').inputValue(), '2.sav');
    await win.locator('#recipe-materials [data-action="database-detail"]').first().click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.equal(await win.locator('#recipe-save').inputValue(), '2.sav');
    await close();
    for (const reference of ['@latest', '']) {
      await win.locator('#craft-save').selectOption(reference);
      await win.locator('.craft-line [data-action="database-detail"][data-id="fusion-7000"]').click();
      assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
      assert.equal(await win.locator('#recipe-save').inputValue(), reference);
      if (!reference) assert.equal(await win.locator('#recipe-materials .material-owned').count(), 0);
      await close();
    }
    await win.locator('#craft-save').selectOption('2.sav');
    await win.locator('#craft-qty-fusion-7000').fill('1');
    await win.locator('[data-action="craft-calculate"]').click();
    await win.waitForFunction(() => document.querySelector('.craft-totals')?.textContent.includes('0 件'));
    report.checks.push(
      'planned recipe retains quantity and fixed, latest, or no save; ingredient return keeps context',
    );
    fs.writeFileSync(path.join(source, '2.sav'), stock(0));
    await broadcast();
    await win.waitForFunction(() => document.querySelector('.craft-totals')?.textContent.includes('5 件'));
    assert.equal(await win.locator('#craft-search').inputValue(), '布锦鞋精良图纸');
    assert.match(await win.locator('.material-sources:not(.crafting-stages)').innerText(), /获取线索/);
    fs.writeFileSync(path.join(source, '2.sav'), stock(10));
    await broadcast();
    await win.waitForFunction(() => document.querySelector('.craft-totals')?.textContent.includes('0 件'));
    await win
      .locator('.craft-material [data-action="database-detail"][data-id="item-10300"]')
      .first()
      .click();
    await win.locator('#reserve-count').fill('8');
    await win.locator('[data-action="reserve-save"]').click();
    await win.waitForFunction(() => document.querySelector('#reserve-count')?.value === '8');
    await close();
    await win.locator('[data-action="craft-calculate"]').click();
    await win.waitForFunction(() => document.querySelector('.craft-totals')?.textContent.includes('3 件'));
    assert.match(await win.locator('.craft-layout').innerText(), /保留 8 件/);
    await shot('reserved-materials');
    const person = index.entries
      .filter((e) => e.kind === '人物')
      .find(
        (e) =>
          index.entries.filter((x) => x.kind === '物品' && x.giftable && e.hobbyKeys?.includes(x.typeKey))
            .length > 30,
      );
    const gifts = index.entries.filter(
      (x) => x.kind === '物品' && x.giftable && person.hobbyKeys.includes(x.typeKey),
    );
    fs.writeFileSync(
      path.join(source, '2.sav'),
      syntheticSave({
        full: true,
        inventory: gifts.slice(0, 36).map((x) => ({ id: x.gameId, count: 10 })),
        money: 10000,
      }),
    );
    await route('database');
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill(person.name);
    await win.locator('[data-action="database-detail"][data-id="' + person.id + '"]').click();
    await win.locator('#person-save').selectOption('2.sav');
    await win.locator('.person-gifts [data-action="gift-page"]').last().click();
    assert.equal(await win.locator('#person-save').inputValue(), '2.sav');
    assert.match(await win.locator('.person-gifts').innerText(), /第 2 \/ 2 页/);
    await shot('gift-page');
    await close();
    report.checks.push(
      'material cache reflects spent stock automatically, manual reservations reduce available stock, actionable missing-material source clues, gifts page past 24 with reference retained',
    );

    await route('goals');
    await win.locator('[data-action="goal-add"]').first().click();
    await win.locator('#goal-title').fill('此刻最重要');
    await win.locator('[data-action="goal-save"]').click();
    const pinned = JSON.parse(fs.readFileSync(path.join(data, 'journal.json'))).profiles[0].goals[0].id;
    await win.locator('[data-action="goal-pin"][data-id="' + pinned + '"]').click();
    for (let i = 0; i < 5; i++)
      await win.evaluate((i) => window.journal.mutate({ type: 'goal-add', title: '其他目标 ' + i }), i);
    await route('home');
    assert.match(await win.locator('.goal-row').first().innerText(), /此刻最重要/);
    await win.locator('[data-action="profiles"]').click();
    await win.locator('#profile-name').fill('二周目 · 尚未开始');
    assert.equal(await win.locator('#profile-binding').inputValue(), '@none');
    await win.locator('[data-action="profile-create"]').click();
    await win.waitForFunction(() =>
      document.querySelector('.home-save-choice')?.textContent.includes('仅查资料'),
    );
    assert.equal((await win.evaluate(() => window.journal.refresh())).data.recent, null);
    assert.equal(await win.locator('[data-persist-detail="home-stage"]').evaluate((el) => el.open), false);
    await win.locator('[data-persist-detail="home-stage"] summary').click();
    await win.locator('[data-action="stage"]').first().click();
    await win.locator('#stage-select').selectOption('0');
    await win.locator('[data-action="stage-save"]').click();
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(data, 'journal.json'))).profiles[1].stageConfirmed,
      true,
    );
    await win.locator('[data-action="save-slot"]').click();
    await win.locator('#save-slot-select').selectOption('2.sav');
    await win.locator('[data-action="save-slot-save"]').click();
    assert.equal((await win.evaluate(() => window.journal.refresh())).data.recent.name, '2.sav');
    await shot('new-profile');
    await win.evaluate((id) => window.journal.mutate({ type: 'profile-switch', id }), original);
    await route('library');
    await win.locator('#list-search').fill('铁矿石');
    await win.locator('[data-action="library-search-all"]').click();
    await win.locator('[data-action="search-all"][data-id="database"]').click();
    assert.equal(await win.locator('#list-search').inputValue(), '铁矿石');
    assert.ok(await win.locator('.database-card').count());
    await win.keyboard.press('Control+k');
    await win.locator('#global-search').fill('剑');
    const searchSource = fs.readFileSync(path.join(base, 'src/renderer/search-query.js'), 'utf8');
    const { compileSearch } = await import(
      'data:text/javascript;base64,' + Buffer.from(searchSource).toString('base64')
    );
    const matches = index.entries.filter(compileSearch('剑'));
    assert.equal(
      await win.locator('[data-action="search-all"][data-id="database"]').innerText(),
      `百物图鉴 ${matches.length} 项 · 查看全部`,
    );
    await shot('search-all');
    await win.locator('[data-action="search-all"][data-id="database"]').click();
    assert.equal(await win.locator('#list-search').inputValue(), '剑');
    const reachable = [];
    const pages = Math.ceil(matches.length / 24);
    for (let page = 0; page < pages; page++) {
      await win.waitForFunction(
        ({ current, total }) =>
          document.querySelector('.pagination')?.textContent.includes(`第 ${current} / ${total} 页`),
        { current: page + 1, total: pages },
      );
      reachable.push(
        ...(await win.locator('.database-card').evaluateAll((cards) => cards.map((card) => card.dataset.id))),
      );
      if (page + 1 < pages) await win.locator('[data-action="database-page"]').last().click();
    }
    assert.deepEqual(
      reachable,
      matches.map((entry) => entry.id),
    );
    const blocked = await win.evaluate(async () => ({
      launch: await window.journal.launchGame(),
      save: await window.journal.timelineSave(),
    }));
    assert.equal(blocked.launch.ok, false);
    assert.equal(blocked.save.ok, false);
    report.checks.push(
      'pinned goal survives adding new goals, new profile defaults to unbound, stage needs explicit confirmation, per-profile fixed binding, cross-library search and full counts, game launch blocked in isolation',
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
  } catch (e) {
    report.passed = false;
    report.error = e.stack;
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(
      path.join(base, 'test-results', 'usability-' + report.version + '.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
})();
