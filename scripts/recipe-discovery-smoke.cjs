'use strict';
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { createRequire } = require('node:module');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.join(__dirname, '..');
const evidence = path.join(base, 'test-results', 'recipe-discovery');
fs.mkdirSync(evidence, { recursive: true });
const flavor = process.env.YIJIAN_EXECUTABLE ? 'exe' : 'source';
const run = fs.mkdtempSync(path.join(evidence, `ui-${flavor}-`));
const userData = path.join(run, 'userdata'),
  saves = path.join(run, 'fixture-SaveGames');
fs.mkdirSync(saves, { recursive: true });
const fixture = path.join(saves, '1.sav');
const original = syntheticSave({
  full: true,
  inventory: [
    { id: 10216, count: 3 },
    { id: 10246, count: 1 },
    { id: 10205, count: 1 },
  ],
  fusionRecipes: [1000],
  alchemyRecipes: [],
  cookingRecipes: [],
  money: 100000000,
  quests: [],
});
function writeFixture(buffer) {
  fs.writeFileSync(fixture, buffer);
  // This harness controls the synthetic file. Make it a settled save so the
  // runtime's recent-write guard cannot stand in for an unknown inventory test.
  const settled = new Date(Date.now() - 5000);
  fs.utimesSync(fixture, settled, settled);
}
writeFixture(original);
const store = new Store(userData, catalog);
store.setPath('savePath', saves);
const startState = store.get(),
  profileId = startState.activeProfileId;
const errors = [],
  checks = [];
const raceEvidence = [];
let rendererHarnessEvidence;
let app, win;
function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
const options = { query: '纯钢剑', craft: 'fusion', learned: 'all', view: 'all', page: 1, pageSize: 8 };
async function api(name, ...args) {
  const response = await win.evaluate(async ({ name, args }) => window.journal[name](...args), {
    name,
    args,
  });
  assert.equal(response.ok, true, response.error || `${name} failed`);
  return response.data;
}
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData, YIJIAN_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.YIJIAN_TEST_TRAY;
  const executablePath = process.env.YIJIAN_EXECUTABLE || require('electron');
  delete env.YIJIAN_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
    timeout: 30000,
  });
  win = await app.firstWindow();
  win.on('pageerror', (error) => errors.push(error.message));
  await win.waitForSelector('.layout');
  await installRendererHarness();
}
async function installRendererHarness() {
  // Keep the real backend, IPC and immutable preload intact. Intercept only
  // the app module in this isolated test session and substitute its local api
  // variable with a wrapper that can hold one genuine read response. Imports
  // still resolve from the original app.js URL, and no application file changes.
  const scriptURL = new URL('app.js', win.url()).href;
  const sourcePath = fileURLToPath(scriptURL),
    asarOffset = sourcePath.indexOf('.asar' + path.sep);
  const source =
    asarOffset < 0
      ? fs.readFileSync(sourcePath, 'utf8')
      : createRequire(require.resolve('@electron/packager'))('@electron/asar')
          .extractFile(sourcePath.slice(0, asarOffset + 5), sourcePath.slice(asarOffset + 6))
          .toString('utf8');
  assert.equal(source.split('const api = window.journal;').length, 2);
  const wrapper = `const api = (() => {
    const real = window.journal;
    const harness = window.__recipeDiscoveryHarness = { holdNext: false, held: null, released: 0, calls: [] };
    return { ...real, recipeDiscovery: async (...args) => {
      const hold = harness.holdNext;
      if (hold) harness.holdNext = false;
      const response = await real.recipeDiscovery(...args);
      harness.calls.push({ scopeToken: response.data?.scopeToken, hash: response.data?.referenceIdentity?.hash,
        profileId: response.data?.profileId, held: hold });
      if (hold) {
        await new Promise((release) => { harness.held = { response, release }; });
        harness.released++;
      }
      return response;
    } };
  })();`;
  const wrapped = source.replace('const api = window.journal;', wrapper);
  const wrapperFile = path.join(run, 'renderer-api-wrapper.js');
  fs.writeFileSync(wrapperFile, wrapped);
  rendererHarnessEvidence = {
    originalScriptURL: scriptURL,
    originalSha256: hash(source),
    wrappedSha256: hash(wrapped),
    wrapperFile,
    realPreloadUnchanged: true,
    realBackendUnchanged: true,
  };
  const intercepted = await app.evaluate(
    ({ session }, { scriptURL, wrapperFile }) => {
      return session.defaultSession.protocol.interceptFileProtocol('file', (request, callback) => {
        callback({
          path:
            request.url === scriptURL
              ? wrapperFile
              : decodeURIComponent(new URL(request.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
        });
      });
    },
    { scriptURL, wrapperFile },
  );
  assert.equal(intercepted, true, 'isolated file protocol interception must be installed');
  await win.reload();
  await win.waitForSelector('.layout');
  assert.equal(await win.evaluate(() => typeof window.__recipeDiscoveryHarness), 'object');
}
async function pageRefresh() {
  // Exercise the existing generic page refresh action while remaining on the
  // discovery page. This test-only DOM trigger never calls recipe-refresh.
  await win.evaluate(() => {
    const button = document.createElement('button');
    button.dataset.action = 'refresh';
    button.textContent = '隔离测试页面刷新';
    document.body.append(button);
    button.click();
    button.remove();
  });
}
async function awaitCandidate({ scope, missing, hash: sourceHash }) {
  await win.waitForFunction(
    ({ scope, missing, sourceHash }) => {
      const node = document.querySelector('[data-recipe-discovery-id="fusion-1000"]');
      const token = node?.querySelector('[data-action="recipe-discovery-add"]')?.dataset.discoveryScope;
      const material = missing === 0 ? '直接材料支持 1 次' : `按 1 次还缺 ${missing} 件`;
      return (
        !!token &&
        (!scope || token !== scope) &&
        node.textContent.includes(material) &&
        (!sourceHash || document.querySelector('.recipe-discovery-source')?.textContent.includes(sourceHash))
      );
    },
    { scope, missing, sourceHash },
  );
  return card().locator('[data-action="recipe-discovery-add"]').getAttribute('data-discovery-scope');
}
const card = () => win.locator('[data-recipe-discovery-id="fusion-1000"]');
async function filterAll() {
  await win.locator('[data-action="recipe-discovery-view"][data-id="all"]').click();
  await win.locator('#recipe-discovery-craft').selectOption('fusion');
  await win.locator('#recipe-discovery-learned').selectOption('all');
  await win.locator('#recipe-discovery-search').fill('纯钢剑');
  await card().waitFor();
}
async function staleAdd(scopeToken, quantity = 1) {
  const current = (await api('bootstrap')).state.profiles.find((p) => p.id === profileId);
  const command = {
    type: 'craft-set',
    profileId,
    id: 'fusion-1000',
    quantity: (current.craftList?.find((line) => line.id === 'fusion-1000')?.quantity || 0) + quantity,
    discovery: { scopeToken, recipeId: 'fusion-1000', quantity },
  };
  const response = await win.evaluate((command) => window.journal.mutate(command), command);
  assert.equal(response.ok, false);
  assert.match(response.error, /过期|重新核对|变化/);
  assert.equal(
    (await api('bootstrap')).state.profiles
      .find((p) => p.id === profileId)
      .craftList.find((line) => line.id === 'fusion-1000').quantity,
    2,
  );
}
(async () => {
  try {
    await launch();
    assert.equal(await win.evaluate(() => typeof window.journal.recipeDiscovery), 'function');
    await win.locator('[data-action="recipe-discovery-open"]').first().click();
    await card().waitFor();
    assert.match(await card().innerText(), /已学配方/);
    assert.match(await card().innerText(), /直接材料支持 1 次/);
    assert.match(await card().innerText(), /当前生活技能等级未知/);
    assert.match(await card().locator('[data-recipe-discovery-outputs]').innerText(), /纯钢剑\s* · 蓝色 × 1/);
    assert.equal(await card().locator('[data-recipe-discovery-outputs] [data-id="item-1002"]').count(), 1);
    assert.match(await win.locator('.recipe-discovery-source').innerText(), /1\.sav/);
    assert.match(await win.locator('.recipe-discovery-source').innerText(), new RegExp(hash(original)));
    await win.screenshot({ path: path.join(run, '01-known-candidate.png'), animations: 'disabled' });
    checks.push('home entry, learned/direct-material/fee/level separation and exact save source');
    const learning = card()
      .locator('details')
      .filter({ has: win.locator('summary', { hasText: '学习图纸' }) });
    await learning.locator('summary').click();
    await learning.locator('[data-action="database-detail"]').first().click();
    await win.waitForSelector('.drawer');
    assert.match(await win.locator('.drawer').innerText(), /使用后可学习/);
    await win.locator('[data-action="close-overlay"]').click();
    await filterAll();
    await awaitCandidate({ missing: 0 });
    const variants = win.locator('[data-recipe-discovery-id="fusion-1100"]');
    assert.match(await variants.locator('[data-recipe-discovery-outputs]').innerText(), /白色 × 0–1/);
    assert.match(await variants.locator('[data-recipe-discovery-outputs]').innerText(), /绿色 × 0–1/);
    assert.match(await variants.locator('[data-recipe-discovery-outputs]').innerText(), /蓝色 × 0–1/);
    await variants.locator('[data-recipe-discovery-quantity]').fill('2');
    await variants.locator('[data-recipe-discovery-quantity]').dispatchEvent('change');
    await win.waitForFunction(() =>
      document
        .querySelector('[data-recipe-discovery-id="fusion-1100"] [data-recipe-discovery-outputs]')
        ?.textContent.includes('蓝色 × 0–2'),
    );
    await variants.locator('[data-recipe-discovery-outputs] [data-id="item-1001"]').click();
    await win.waitForSelector('.drawer');
    assert.match(await win.locator('.drawer').innerText(), /纯钢剑/);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#recipe-discovery-search').fill('铁锭');
    const iron = win.locator('[data-recipe-discovery-id="fusion-9500"]');
    await iron.waitFor();
    await iron.locator('[data-recipe-discovery-quantity]').fill('2');
    await iron.locator('[data-recipe-discovery-quantity]').dispatchEvent('change');
    await win.waitForFunction(() =>
      document
        .querySelector('[data-recipe-discovery-id="fusion-9500"] [data-recipe-discovery-outputs]')
        ?.textContent.includes('× 2–6'),
    );
    await win.screenshot({ path: path.join(run, '01b-output-range.png'), animations: 'disabled' });
    await filterAll();
    await awaitCandidate({ missing: 0 });
    checks.push(
      'candidate cards show actual output quality, exact detail links, variable yield, quantity scaling and zero-minimum alternative results separately from blueprints',
    );
    const oldScope = await card()
      .locator('[data-action="recipe-discovery-add"]')
      .getAttribute('data-discovery-scope');
    await win.evaluate(() => {
      window.__recipeDiscoveryHarness.holdNext = true;
    });
    await win.locator('#recipe-discovery-search').dispatchEvent('input');
    await win.waitForFunction(() => !!window.__recipeDiscoveryHarness.held?.response?.data?.scopeToken);
    assert.equal(await card().locator('[data-action="recipe-discovery-add"]').isDisabled(), true);
    const held = await win.evaluate(() => ({
      scope: window.__recipeDiscoveryHarness.held.response.data.scopeToken,
      missing: window.__recipeDiscoveryHarness.held.response.data.rows.find(
        (r) => r.recipeId === 'fusion-1000',
      )?.missingTotal,
    }));
    assert.equal(held.scope, oldScope);
    assert.equal(held.missing, 0);
    await api('mutate', { type: 'reserve-set', profileId, id: '10216', count: 1 });
    const changedScope = await awaitCandidate({ scope: oldScope, missing: 1 });
    const afterRelease = await win.evaluate(async () => {
      window.__recipeDiscoveryHarness.held.release();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const node = document.querySelector('[data-recipe-discovery-id="fusion-1000"]');
      return {
        released: window.__recipeDiscoveryHarness.released,
        scope: node.querySelector('[data-action="recipe-discovery-add"]').dataset.discoveryScope,
        text: node.textContent,
      };
    });
    assert.equal(afterRelease.released, 1);
    assert.equal(afterRelease.scope, changedScope);
    assert.match(afterRelease.text, /按 1 次还缺 1 件/);
    assert.equal((await api('recipeDiscovery', options)).scopeToken, changedScope);
    raceEvidence.push({
      kind: 'delayed-old-read-after-reservation',
      oldScope,
      newScope: changedScope,
      beforeMissing: held.missing,
      afterMissing: 1,
      oldResponseReleased: true,
      oldResponseIgnored: true,
    });
    checks.push(
      'direct IPC reservation automatically refreshes scope and deficit; a delayed genuine old read cannot overwrite it',
    );
    await api('mutate', { type: 'reserve-set', profileId, id: '10216', count: 0 });
    await awaitCandidate({ scope: changedScope, missing: 0 });
    await api('mutate', {
      type: 'craft-plan-save',
      profileId,
      name: '自动反查占用测试',
      list: [{ id: 'fusion-1000', quantity: 1 }],
      choices: {},
      reserved: true,
      addGoal: false,
    });
    const planningState = (await api('bootstrap')).state.profiles.find((p) => p.id === profileId);
    const occupying = planningState.craftPlans.find((p) => p.name === '自动反查占用测试');
    const planScope = await awaitCandidate({ missing: 5 });
    const priorityPreview = await api('resourcePriorityPreview', profileId, [occupying.id]);
    await api('mutate', {
      type: 'resource-priority-set',
      profileId,
      order: [occupying.id],
      fingerprint: priorityPreview.fingerprint,
    });
    const priorityScope = await awaitCandidate({ scope: planScope, missing: 5 });
    await api('mutate', { type: 'craft-plan-reserve', profileId, id: occupying.id, value: false });
    const releasedPlanScope = await awaitCandidate({ scope: priorityScope, missing: 0 });
    const defaultPreview = await api('resourcePriorityPreview', profileId, []);
    await api('mutate', {
      type: 'resource-priority-set',
      profileId,
      order: [],
      fingerprint: defaultPreview.fingerprint,
    });
    await awaitCandidate({ scope: releasedPlanScope, missing: 0 });
    checks.push(
      'direct IPC saved-plan reservation and explicit priority changes automatically refresh the visible scope and correct material status',
    );
    await card().locator('[data-recipe-discovery-quantity]').fill('2');
    await card().locator('[data-recipe-discovery-quantity]').dispatchEvent('change');
    await win.waitForFunction(() =>
      document
        .querySelector('[data-recipe-discovery-id="fusion-1000"]')
        ?.textContent.includes('按 2 次还缺 5 件'),
    );
    assert.match(await card().locator('[data-recipe-discovery-outputs]').innerText(), /纯钢剑\s* · 蓝色 × 2/);
    await card().locator('[data-action="recipe-discovery-add"]').click();
    await win.waitForFunction(async () => {
      const state = (await window.journal.bootstrap()).data.state;
      return (
        state.profiles
          .find((p) => p.id === state.activeProfileId)
          .craftList?.find((line) => line.id === 'fusion-1000')?.quantity === 2
      );
    });
    await filterAll();
    await win.waitForFunction(() =>
      document.querySelector('[data-recipe-discovery-id="fusion-1000"]')?.textContent.includes('还缺 10 件'),
    );
    checks.push('quantity two updates allocation; add merges current list and recomputes the full budget');
    await api('mutate', {
      type: 'craft-plan-save',
      profileId,
      name: '合成保存计划',
      list: [{ id: 'fusion-1000', quantity: 1 }],
      choices: {},
      reserved: false,
      addGoal: false,
    });
    await api('refresh');
    await win.locator('[data-action="recipe-discovery-refresh"]').click();
    const state = (await api('bootstrap')).state;
    const beforeMerge = state.profiles.find((p) => p.id === profileId);
    const saved = beforeMerge.craftPlans.find((p) => p.name === '合成保存计划');
    await win.locator('#recipe-discovery-target-plan').selectOption(saved.id);
    await card().locator('[data-recipe-discovery-quantity]').fill('1');
    await card().locator('[data-recipe-discovery-quantity]').dispatchEvent('change');
    await win.waitForFunction(
      () =>
        document.querySelector('[data-recipe-discovery-id="fusion-1000"] input')?.value === '1' &&
        document
          .querySelector('[data-recipe-discovery-id="fusion-1000"]')
          ?.textContent.includes('按 1 次还缺 5 件'),
    );
    await card().locator('[data-action="recipe-discovery-add"]').click();
    await win.waitForFunction(
      async (id) =>
        (await window.journal.bootstrap()).data.state.profiles
          .flatMap((p) => p.craftPlans || [])
          .find((p) => p.id === id)?.list[0].quantity === 2,
      saved.id,
    );
    const afterMerge = (await api('bootstrap')).state.profiles.find((p) => p.id === profileId);
    assert.equal(afterMerge.craftList[0].quantity, 2);
    assert.equal(afterMerge.craftPlans.find((p) => p.id === saved.id).reserved, false);
    assert.equal(
      afterMerge.activeCraftPlanId,
      beforeMerge.activeCraftPlanId,
      'merging into another saved plan must not silently bind and release the current draft',
    );
    assert.equal(afterMerge.reserveCraftDraft, beforeMerge.reserveCraftDraft);
    checks.push('selected saved plan receives merged quantity, preserving draft and plan reserve intent');
    let projection = await api('recipeDiscovery', options);
    await api('mutate', { type: 'reserve-set', profileId, id: '10216', count: 1 });
    await staleAdd(projection.scopeToken);
    const beforeHashScope = await awaitCandidate({ missing: 5 });
    checks.push('changed planning intent rejects stale add without changing craft quantity');
    projection = await api('recipeDiscovery', options);
    assert.equal(
      hash(fs.readFileSync(fixture)),
      hash(original),
      'runtime reads/planning never write the synthetic save',
    );
    const newer = syntheticSave({
      full: true,
      seconds: 7200,
      inventory: [
        { id: 10216, count: 9 },
        { id: 10246, count: 3 },
        { id: 10205, count: 3 },
      ],
      fusionRecipes: [1000],
      alchemyRecipes: [],
      cookingRecipes: [],
      money: 100000000,
    });
    writeFixture(newer);
    await pageRefresh();
    const afterHashScope = await awaitCandidate({ scope: beforeHashScope, missing: 1, hash: hash(newer) });
    raceEvidence.push({
      kind: 'save-hash-page-refresh',
      oldScope: beforeHashScope,
      newScope: afterHashScope,
      hash: hash(newer),
      beforeMissing: 5,
      afterMissing: 1,
    });
    await staleAdd(projection.scopeToken);
    checks.push(
      'generic page refresh automatically reflects changed save hash and deficit without recipe-refresh; old add is rejected',
    );
    const unknown = syntheticSave({ full: false, seconds: 8000 });
    writeFixture(unknown);
    await pageRefresh();
    await win.waitForFunction(
      () =>
        document
          .querySelector('[data-recipe-discovery-id="fusion-1000"]')
          ?.textContent.includes('直接材料未知') &&
        document.querySelector('.recipe-discovery-source')?.textContent.includes('SHA-256'),
    );
    assert.match(await card().innerText(), /学习记录未知/);
    projection = await api('recipeDiscovery', options);
    assert.equal(projection.status, 'inventory-unknown');
    assert.equal(projection.referenceIdentity.hash, hash(unknown));
    assert.equal(projection.rows[0].missingTotal, null);
    assert.equal(projection.rows[0].learned, null);
    await win.screenshot({ path: path.join(run, '02-unknown-source.png'), animations: 'disabled' });
    await win.locator('#recipe-discovery-search').fill('');
    await win.locator('#recipe-discovery-craft').selectOption('');
    await win.waitForFunction(() =>
      document.querySelector('.recipe-discovery-pagination')?.textContent.includes('303 条结果'),
    );
    await win.locator('[data-action="recipe-discovery-page"][data-id="2"]').first().click();
    await win.waitForFunction(() =>
      document.querySelector('.recipe-discovery-pagination')?.textContent.includes('第 2 / 38 页'),
    );
    assert.equal(await win.locator('[data-recipe-discovery-id]').count(), 8);
    const ids = await win
      .locator('[data-recipe-discovery-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.recipeDiscoveryId));
    assert.equal(new Set(ids).size, 8);
    checks.push('all 303 recipes paginate eight per page without duplicate cards');
    await api('mutate', { type: 'save-slot', profileId, value: '', mode: 'none' });
    await win.waitForFunction(
      () =>
        document.querySelector('.recipe-discovery-source')?.textContent.includes('尚无可确认的存档参照') &&
        [...document.querySelectorAll('[data-action="recipe-discovery-add"]')].every(
          (button) => button.disabled,
        ),
    );
    assert.equal((await api('recipeDiscovery', options)).status, 'no-reference');
    await api('mutate', { type: 'save-slot', profileId, value: '', mode: 'latest' });
    await win.waitForFunction(
      (expected) =>
        document.querySelector('.recipe-discovery-source')?.textContent.includes(expected) &&
        [...document.querySelectorAll('[data-action="recipe-discovery-add"]')].some(
          (button) => button.dataset.discoveryScope,
        ),
      hash(unknown),
    );
    assert.equal((await api('recipeDiscovery', options)).status, 'inventory-unknown');
    checks.push(
      'reference-mode reset while staying on discovery automatically rereads and disables unbound old results',
    );
    await win.locator('[data-action="navigate"][data-id="materials"]').first().click();
    assert.equal(await win.locator('[data-action="recipe-discovery-open"]').count(), 1);
    checks.push('unknown inventory and learning remain unknown; materials page also has the entry');
    await app.close();
    app = null;
    await launch();
    const persisted = (await api('bootstrap')).state.profiles.find((p) => p.id === profileId);
    assert.equal(persisted.craftList[0].quantity, 2);
    assert.equal(persisted.craftPlans.find((p) => p.id === saved.id).list[0].quantity, 2);
    assert.equal(hash(fs.readFileSync(fixture)), hash(unknown));
    assert.deepEqual(errors, []);
    checks.push(
      'restart preserves both plans; all runtime access to fixtures stays read-only; no renderer errors',
    );
    fs.writeFileSync(
      path.join(run, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          flavor,
          checks,
          profileId,
          syntheticOnly: true,
          initialSaveHash: hash(original),
          finalSaveHash: hash(unknown),
          fixtureWritesByHarness: 3,
          gameLaunched: false,
          personalSavesUsed: false,
          raceEvidence,
          rendererHarness: rendererHarnessEvidence,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: true, flavor, run, checks }, null, 2));
  } catch (error) {
    if (win && !win.isClosed()) {
      const visible = await win
        .evaluate(() => ({
          source: document.querySelector('.recipe-discovery-source')?.textContent,
          rows: [...document.querySelectorAll('[data-recipe-discovery-id]')].map((node) => ({
            id: node.dataset.recipeDiscoveryId,
            text: node.textContent,
            scope: node.querySelector('[data-action="recipe-discovery-add"]')?.dataset.discoveryScope,
          })),
          calls: window.__recipeDiscoveryHarness?.calls,
          released: window.__recipeDiscoveryHarness?.released,
        }))
        .catch(() => null);
      fs.writeFileSync(path.join(run, 'failure-ui.json'), JSON.stringify(visible, null, 2));
      await win
        .screenshot({ path: path.join(run, 'failure-ui.png'), animations: 'disabled' })
        .catch(() => {});
    }
    fs.writeFileSync(
      path.join(run, 'result.json'),
      JSON.stringify(
        {
          ok: false,
          flavor,
          checks,
          errors,
          raceEvidence,
          rendererHarness: rendererHarnessEvidence,
          message: error.message,
          stack: error.stack,
        },
        null,
        2,
      ),
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
