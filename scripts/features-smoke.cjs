'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { sha } = require('../src/core/saves.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs'),
  { materialPlan } = require('../src/core/material-plan.cjs'),
  catalog = require('../src/data/catalog.cjs');
const index = encyclopedia(),
  base = path.resolve(__dirname, '..'),
  data = fs.mkdtempSync(path.join(base, '.test-data', 'features-')),
  source = path.join(data, 'SaveGames');
fs.mkdirSync(source);
const wei = index.entries.find((e) => e.id === 'npc-10047'),
  gift = index.entries.find((e) => e.kind === '物品' && e.giftable && wei.hobbyKeys.includes(e.typeKey));
const quest = index.world.quests.find(
  (q) => q.materials?.length && q.requestNPCs.some((id) => index.entries.some((e) => e.id === `npc-${id}`)),
);
const inventory = [
  { id: 10226, count: 3 },
  { id: gift.gameId, count: 7 },
];
fs.writeFileSync(
  path.join(source, '1.sav'),
  syntheticSave({
    full: true,
    inventory,
    money: 100,
    quests: [
      { id: 5200, step: 1 },
      { id: 5201, step: 1 },
      { id: quest.gameId, step: 1 },
    ],
  }),
);
fs.writeFileSync(
  path.join(source, '2.sav'),
  syntheticSave({
    full: true,
    inventory: [],
    quests: [
      { id: 5200, step: 4 },
      { id: 5201, step: 1 },
    ],
  }),
);
fs.writeFileSync(path.join(source, '3.sav'), syntheticSave());
const originals = fs.readdirSync(source).map((name) => ({
  name,
  hash: sha(fs.readFileSync(path.join(source, name))),
  time: fs.statSync(path.join(source, name), { bigint: true }).mtimeNs.toString(),
}));
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'save-slot', value: '1.sav' });
const initialId = store.get().activeProfileId;
const report = { startedAt: new Date().toISOString(), checks: [], errors: [], externalRequests: [] };
let app, win;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
  });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  win.on('pageerror', (e) => report.errors.push(e.message));
  win.on('request', (r) => {
    if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
  });
  await win.locator('.layout').waitFor();
  await win.emulateMedia({ reducedMotion: 'reduce' });
}
const nav = async (route) => win.locator(`.nav-btn[data-id="${route}"]`).click();
const state = async () => (await win.evaluate(() => window.journal.bootstrap())).data.state;
const close = async () => win.keyboard.press('Escape');
const shot = async (name) => {
  // A hidden compositor needs a frame before accepting pixels after DOM changes.
  await app.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  });
  await win.waitForTimeout(200);
  const encoded = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayAwake: true,
      })
    )
      .toPNG()
      .toString('base64'),
  );
  fs.writeFileSync(path.join(base, 'test-results', name + '.png'), Buffer.from(encoded, 'base64'));
};
(async () => {
  try {
    await launch();
    report.version = (await win.evaluate(() => window.journal.bootstrap())).data.version;
    await nav('world');
    await win
      .locator('#world-save')
      .filter({ has: win.locator('option[value="1.sav"]') })
      .waitFor();
    await win.locator('#world-search').fill('武当求助');
    await win.locator('[data-action="world-quest"][data-id="quest-5200"]').click();
    assert.ok((await win.locator('.world-drawer .tag-row').innerText()).includes('进行中'));
    assert.equal(
      await win
        .locator('.world-drawer details')
        .first()
        .evaluate((e) => e.open),
      false,
    );
    await win.locator('[data-action="world-quest"][data-id="quest-5201"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.ok((await win.locator('.world-drawer h1').innerText()).includes('武当求助'));
    await win.locator('[data-action="world-quest-goal"]').click();
    await close();
    await win.locator('#world-save').selectOption('2.sav');
    await win.locator('#world-status').selectOption('active');
    await win.locator('.world-quest-card').filter({ hasText: '已完成' }).waitFor();
    assert.ok((await win.locator('.world-quest-card').innerText()).includes('进行中的步骤'));
    await shot('13-world');
    report.checks.push(
      'root/child status, spoiler disclosure, link-back, goal reference, active child under completed parent',
    );
    await win.locator('#world-status').selectOption('all');
    await win.locator('#world-scope').selectOption('all');
    await win.locator('#world-search').fill(quest.name);
    await win.locator(`.world-quest-card[data-id="${quest.id}"]`).click();
    assert.ok((await win.locator('.world-drawer').innerText()).includes('未出现在记录'));
    assert.ok((await win.locator('.world-drawer .material-row').first().innerText()).includes('库存 0'));
    const itemButton = win.locator('.world-drawer .material-row [data-action="database-detail"]').first();
    await itemButton.click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.ok((await win.locator('.world-drawer h1').innerText()).includes(quest.name));
    await close();
    await win.locator('[data-action="world-kind"][data-id="places"]').click();
    await win.locator('#world-search').fill('梧桐村');
    await win.locator('.world-place-card').first().click();
    assert.ok((await win.locator('.world-drawer').innerText()).includes('不是全地图收集清单'));
    await shot('14-place');
    await close();
    report.checks.push(
      'unrecorded quests remain unknown; material inventory, item navigation and source-qualified scene relations',
    );
    await nav('database');
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('卫霍');
    await win.locator('.database-card[data-id="npc-10047"]').click();
    await win.locator('#person-save').selectOption('1.sav');
    await win.locator('.person-gifts').filter({ hasText: gift.name }).waitFor();
    assert.ok((await win.locator('.person-gifts').innerText()).includes('7 件'));
    await shot('15-gifts');
    await win.locator(`.person-gifts [data-id="${gift.id}"]`).click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#person-save').inputValue(), '1.sav');
    await win.locator('#person-save').selectOption('2.sav');
    await win.locator('.person-gifts').filter({ hasText: '没有记录符合偏好' }).waitFor();
    await win.locator('#person-save').selectOption('3.sav');
    assert.ok((await win.locator('.person-gifts').innerText()).includes('物品示例'));
    await win.locator('[data-action="world-person"]').click();
    assert.equal(await win.locator('#world-search').inputValue(), '卫霍');
    assert.ok(await win.locator('.world-quest-card').count());
    report.checks.push(
      'owned gifts versus unknown/empty inventory, NPC initial skill and affinity clues, references and related task search',
    );
    await nav('materials');
    await win.locator('#craft-search').fill('长虹剑精良图纸');
    await win.locator('.craft-suggestions [data-action="craft-add"][data-id="fusion-1002"]').click();
    await win.locator('#craft-search').fill('银蛇剑精良图纸');
    await win.locator('.craft-suggestions [data-action="craft-add"][data-id="fusion-1003"]').click();
    await win.locator('#craft-qty-fusion-1002').fill('2');
    await win.locator('#craft-search').focus();
    await win.locator('#craft-save').selectOption('1.sav');
    await win.locator('[data-action="craft-calculate"]').click();
    await win.locator('.craft-totals').first().waitFor();
    const list = [
        { id: 'fusion-1002', quantity: 2 },
        { id: 'fusion-1003', quantity: 1 },
      ],
      expected = materialPlan(list, { inventory, money: 100, fusionRecipes: [1002] });
    const actual = await win.evaluate((list) => window.journal.materialPlan(list, '1.sav'), list);
    assert.equal(actual.data.missing, expected.missing);
    assert.equal(actual.data.materials.find((m) => m.ids.includes(10226)).allocated, 3);
    assert.ok(
      (await win.locator('.craft-totals').first().innerText()).includes(expected.money.toLocaleString()),
    );
    await shot('16-materials');
    await win.locator('[data-action="craft-missing"]').click();
    assert.ok((await win.locator('.craft-materials').innerText()).includes('还缺'));
    await win.locator('[data-action="craft-goal"]').click();
    await win.locator('#craft-plan-name').fill('打包验收制作计划');
    await win.locator('[data-action="craft-plan-save"]').click();
    await nav('goals');
    await win.locator('.goal-row [data-action="goal-source"]').first().click();
    await win.locator('.craft-totals').first().waitFor();
    await win.locator('.craft-line [data-id="fusion-1002"]').first().click();
    await win.locator('#recipe-quantity').fill('3');
    await win.locator('.drawer [data-action="craft-add"]').click();
    await win.locator('[data-action="craft-open"]').click();
    assert.equal(await win.locator('#craft-qty-fusion-1002').inputValue(), '5');
    await win.locator('.craft-totals').first().waitFor();
    await win.locator('#craft-qty-fusion-1002').fill('0');
    await win.locator('#craft-search').focus();
    assert.equal(await win.locator('#craft-qty-fusion-1002').inputValue(), '5');
    for (const invalid of [
      [{ id: 'item-10226', quantity: 1 }],
      [{ id: 'fusion-1002', quantity: 1000 }],
      [{ id: 'fusion-1002', quantity: 1, unexpected: true }],
    ])
      assert.equal(
        (await win.evaluate((list) => window.journal.materialPlan(list, '1.sav'), invalid)).ok,
        false,
      );
    assert.equal(
      (
        await win.evaluate(() =>
          window.journal.materialPlan([{ id: 'fusion-1002', quantity: 1 }], '../1.sav'),
        )
      ).ok,
      false,
    );
    report.checks.push(
      'shared-stock allocation and fees, quantity edits/additions, invalid IPC/input refusal, goal source and recipe-to-planner flow',
    );
    await win.locator('#craft-save').selectOption('');
    await win.locator('[data-action="craft-calculate"]').click();
    await win.locator('.craft-totals').first().filter({ hasText: '未核对' }).waitFor();
    assert.ok(!(await win.locator('.craft-materials').innerText()).includes('还缺'));
    assert.ok(
      await win.locator('.craft-material').count(),
      'Unknown stock is still shown after missing-only filter',
    );
    await win.locator('#craft-save').selectOption('3.sav');
    await win.locator('[data-action="craft-calculate"]').click();
    assert.ok((await win.locator('.craft-result-card').innerText()).includes('背包未能读取'));
    assert.ok(await win.locator('.craft-material').count());
    const oldHash = sha(fs.readFileSync(path.join(data, 'journal.json')));
    await app.close();
    app = null;
    await launch();
    assert.equal(sha(fs.readFileSync(path.join(data, 'journal.json'))), oldHash);
    await nav('materials');
    await win.locator('#craft-qty-fusion-1002').waitFor();
    assert.equal(await win.locator('#craft-qty-fusion-1002').inputValue(), '5');
    await win.locator('[data-action="profiles"]').click();
    await win.locator('#profile-name').fill('第二程');
    await win.locator('[data-action="profile-create"]').click();
    assert.equal(await win.locator('.craft-line').count(), 0);
    await win.locator('[data-action="profiles"]').click();
    await win.locator('#profile-select').selectOption(initialId);
    await win.locator('[data-action="profile-switch"]').click();
    assert.equal(await win.locator('#craft-qty-fusion-1002').inputValue(), '5');
    report.checks.push(
      'unknown inventory and no-reference plans, restart without rewriting records and per-profile basket isolation',
    );
    fs.renameSync(path.join(source, '1.sav'), path.join(data, 'held-1.sav'));
    await nav('world');
    assert.equal(await win.locator('#world-save').inputValue(), '1.sav');
    await win.locator('.world-reference').filter({ hasText: '已不存在' }).waitFor();
    await nav('materials');
    await win.locator('.craft-result-card').filter({ hasText: '已不存在' }).waitFor();
    assert.equal(await win.locator('.craft-totals').first().count(), 0);
    assert.equal(await win.locator('#craft-save').inputValue(), '1.sav');
    fs.renameSync(path.join(data, 'held-1.sav'), path.join(source, '1.sav'));
    await win.locator('[data-action="craft-calculate"]').click();
    await win.locator('.craft-totals').first().waitFor();
    report.checks.push(
      'missing pinned reference never silently selects another slot; restored slot can be reread',
    );
    await win.locator('.search-trigger').click();
    await win.locator('#global-search').fill('武当求助');
    await win.locator('.search-result[data-action="world-quest"]').first().click();
    await win.locator('.world-drawer').waitFor();
    await close();
    await win.locator('.search-trigger').click();
    await win.locator('#global-search').fill('梧桐村');
    assert.ok(await win.locator('.search-result[data-action="world-place"]').count());
    await close();
    await nav('world');
    await win.locator('#world-search').evaluate((e) => {
      e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      e.value = '卫霍';
      e.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '卫霍' }));
    });
    assert.equal(await win.locator('#world-search').inputValue(), '卫霍');
    await win.context().setOffline(true);
    await win.reload();
    await win.locator('.layout').waitFor();
    await nav('world');
    await win.locator('#world-search').fill('武当');
    assert.ok(await win.locator('.world-quest-card').count());
    await nav('materials');
    await win.locator('.craft-totals').first().waitFor();
    report.checks.push('global task/place search, Chinese composition and offline restart');
    // A deliberately delayed IPC fixture exercises UI cancellation without touching real files.
    await app.evaluate(
      ({ ipcMain }, { base, source, data }) => {
        const load = process.getBuiltinModule('node:module').createRequire(pathModule(base));
        function pathModule(base) {
          return base + '/src/core/material-plan.cjs';
        }
        const { materialPlan } = load(pathModule(base)),
          { Saves } = load(base + '/src/core/saves.cjs');
        const reader = new Saves(data + '/delayed-backups');
        ipcMain.removeHandler('journal:material-plan');
        ipcMain.handle('journal:material-plan', async (_e, list, name) => {
          const plan = materialPlan(list, name ? reader.details(source, name).metadata : null);
          await new Promise((r) => setTimeout(r, 250));
          return { ok: true, data: plan };
        });
      },
      { base, source, data },
    );
    await win.locator('#craft-save').selectOption('1.sav');
    await win.locator('[data-action="craft-calculate"]').click();
    await win.locator('#craft-save').selectOption('2.sav');
    await win.waitForTimeout(350);
    assert.equal(await win.locator('.craft-totals').first().count(), 0);
    assert.ok(!(await win.locator('.craft-result-card').innerText()).includes('正在核对'));
    await win.locator('[data-action="craft-calculate"]').click();
    await win.locator('[data-action="profiles"]').click();
    await win.locator('#profile-name').fill('迟到结果验证');
    await win.locator('[data-action="profile-create"]').click();
    await win.waitForTimeout(350);
    assert.equal(await win.locator('.craft-line').count(), 0);
    assert.equal(await win.locator('.craft-totals').first().count(), 0);
    report.checks.push('late material response discarded after reference or profile changes');
    await app.evaluate(
      ({ ipcMain }, { base, source, data }) => {
        const load = process.getBuiltinModule('node:module').createRequire(base + '/src/core/saves.cjs');
        const { Saves } = load(base + '/src/core/saves.cjs'),
          reader = new Saves(data + '/late-details');
        ipcMain.removeHandler('journal:save-details');
        ipcMain.handle('journal:save-details', async (_event, name) => {
          const file = reader.details(source, name);
          await new Promise((r) => setTimeout(r, 250));
          return { ok: true, data: file };
        });
      },
      { base, source, data },
    );
    assert.equal(
      (await win.evaluate((id) => window.journal.mutate({ type: 'profile-switch', id }), initialId)).ok,
      true,
    );
    await win.locator('#craft-qty-fusion-1002').waitFor();
    await win.locator('.search-trigger').click();
    await win.locator('#global-search').fill('武当求助');
    await win.locator('.search-result[data-action="world-quest"]').first().click();
    await close();
    await win.waitForTimeout(350);
    assert.equal(await win.locator('.world-drawer').count(), 0);
    assert.equal(await win.locator('#app').evaluate((e) => e.inert), false);
    report.checks.push('late task detail cannot reopen a dismissed search dialog');
    for (const f of originals) {
      assert.equal(sha(fs.readFileSync(path.join(source, f.name))), f.hash);
      assert.equal(fs.statSync(path.join(source, f.name), { bigint: true }).mtimeNs.toString(), f.time);
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
    console.log('New features smoke PASS:', report.checks.length, 'flows');
  } catch (e) {
    report.passed = false;
    report.failure = e.stack;
    await shot('features-failure').catch(() => {});
    throw e;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(base, 'test-results', 'features-smoke-report.json'),
      JSON.stringify(report, null, 2),
    );
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
