'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(base, '.test-data/npc-progress-'));
const data = path.join(output, 'state');
const source = path.join(data, '76561190000000000/SaveGames');
fs.mkdirSync(source, { recursive: true });
const file = path.join(source, '1.sav');
const attributes = { 1: 100, 2: 100, 3: 50, 4: 50, 5: 15, 44: 100, 27: 1, 48: 1, 61: 1, 63: 1, 65: 1, 67: 1 };
const player = { id: 0, attributes, skills: [{ id: 850, level: 1 }] };
const savedNpc = (id, extra = {}) => ({ id, attributes, map: 'LV_25_P', friendliness: [[0, 70]], ...extra });
const npcs = [
  player,
  savedNpc(10016, {
    attributes: { ...attributes, 65: 3 },
    skills: [{ id: 100, level: 10 }],
    inventory: [{ id: 100034, count: 1 }],
  }),
  savedNpc(10047, { inventory: [{ id: 100073, count: 1 }] }),
  savedNpc(10038),
];
const writeSave = (rows) => {
  const bytes = syntheticSave({
    full: true,
    npcs: rows,
    inventory: [{ id: 100073, count: 987654 }],
    quests: [],
    map: 'LV_25_P',
    trackingQuest: 0,
    trackingMainQuest: 0,
  });
  fs.writeFileSync(file, bytes);
  return bytes;
};
let expected = writeSave(npcs);
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
const env = { ...process.env, YIJIAN_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let app,
  timer,
  currentObservation = null,
  sequence = 0,
  blobVersion = 0,
  token;
const revision = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(base, 'src/game-bridge/main.lua')))
  .digest('hex');
const session = '1800000000-123456';
const liveAttributes = { ...attributes, 9: 100, 10: 10, 14: 20, 11: 100, 12: 10, 2: 1000, 4: 800 };
const liveNpc = (id, extra = {}) => ({
  id,
  rawFriendliness: 70,
  visible: true,
  mapKey: 'LV_25_P',
  guildId: 0,
  skillPoints: 500,
  attributes: liveAttributes,
  skills: [],
  inventory: [],
  ...extra,
});
const hmac = (bytes) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(bytes).digest('hex');
const publish = (bag, overrides = {}) => {
  blobVersion++;
  const body = {
    schema: 1,
    source,
    session,
    revision,
    epoch: 1,
    version: blobVersion,
    world: 'World /Synthetic.LV_25_P',
    pawn: 'Pawn Synthetic',
    identity: ['gi', 'sm', 'nm', 'qm', 'player'],
    quests: [
      { id: 5062, step: 4 },
      { id: 5066, step: 4 },
      { id: 5091, step: 4 },
      { id: 12001, step: 1 },
    ],
    npcs: [
      liveNpc(0, { skills: [{ id: 850, level: 1 }] }),
      liveNpc(10016, {
        attributes: { ...liveAttributes, 65: 4 },
        skills: [{ id: 100, level: 10 }],
        inventory: bag,
      }),
      liveNpc(10047, { rawFriendliness: 60, inventory: [{ id: 100073, count: 1 }] }),
      liveNpc(10131, { rawFriendliness: 30, inventory: [{ id: 100034, count: 1 }] }),
    ],
    ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify(body));
  fs.writeFileSync(path.join(data, 'game-bridge/npc-observation.json'), bytes);
  currentObservation = { epoch: 1, version: blobVersion, mac: hmac(bytes) };
};
const pulse = () => {
  const at = Math.floor(Date.now() / 1000);
  const ref = currentObservation ? { ...currentObservation, sequence: ++sequence, at } : null;
  if (ref)
    ref.sampleMac = hmac(
      [
        'npc-sample-v1',
        source,
        session,
        revision,
        'World /Synthetic.LV_25_P',
        'Pawn Synthetic',
        ref.epoch,
        ref.version,
        ref.sequence,
        ref.at,
        ref.mac,
      ].join('\n'),
    );
  fs.writeFileSync(
    path.join(data, 'game-bridge/state.json'),
    JSON.stringify({
      protocol: 2,
      revision,
      token,
      source,
      session,
      at,
      ready: false,
      reason: '菜单或对话中暂停保存',
      world: 'World /Synthetic.LV_25_P',
      pawn: 'Pawn Synthetic',
      dialogue: null,
      npcObservation: ref,
    }),
  );
};
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    const main = await app.firstWindow();
    main.on('pageerror', (error) => errors.push(error.message));
    await main.locator('.layout').waitFor();
    await main.locator('.sidebar-nav [data-id="duels"]').click();
    await main.locator('[data-npc-progress-page]').waitFor();
    await main.locator('[data-npc-progress-card="10016"]').waitFor();
    assert.equal(await main.locator('[data-npc-progress-card="10016"]').evaluate((node) => node.open), false);
    await main.screenshot({ path: path.join(output, 'main-pending.png') });
    await main.locator('[data-action="npc-progress-tab"][data-id="locked"]').click();
    const wei = main.locator('[data-npc-progress-card="10047"]');
    await wei.locator('> summary').click();
    assert.match(await wei.innerText(), /前往村口|买酒/);
    assert.match(await wei.innerText(), /暂时上限 0/);
    await main.locator('[data-action="npc-progress-tab"][data-id="learning"]').click();
    const jiang = main.locator('[data-npc-progress-card="10016"]');
    await jiang.locator('> summary').click();
    await jiang.locator('[data-persist-detail="npc-learning-10016"] > summary').click();
    assert.match(await jiang.innerText(), /炼丹.*1 → 3/s);
    await jiang.locator('[data-action="database-detail"][data-id="npc-10016"]').first().click();
    await main.locator('#overlay [data-npc-progress="10016"]').waitFor();
    assert.match(await main.locator('#overlay [data-npc-progress="10016"]').innerText(), /私物还剩 1 种/);
    await main.keyboard.press('Escape');
    const opening = app.waitForEvent('window');
    await main.locator('[data-action="compact"]').click();
    const small = await opening;
    small.on('pageerror', (error) => errors.push(error.message));
    await small.locator('.compact-shell').waitFor();
    await small.locator('.companion-tabs [data-id="duels"]').click();
    await small.locator('[data-npc-progress-card="10016"]').waitFor();
    await small.screenshot({ path: path.join(output, 'companion-pending.png') });
    const search = small.locator('#npc-progress-search');
    await search.fill('江吟风');
    await small.locator('[data-npc-progress-card="10016"] > summary').click();
    await small.screenshot({ path: path.join(output, 'companion-expanded.png') });
    // Clearing the NPC bag after saving removes only the collection entry;
    // its unlearned arts and higher craft level remain available to consult.
    expected = writeSave([player, { ...npcs[1], inventory: [] }, npcs[2], npcs[3]]);
    await small.locator('[data-npc-progress-card="10016"]').waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await search.inputValue(), '江吟风');
    await small.locator('[data-action="npc-progress-tab"][data-id="cleared"]').click();
    await small.locator('[data-npc-progress-card="10016"]').waitFor();
    await small.locator('[data-action="npc-progress-tab"][data-id="learning"]').click();
    await small.locator('[data-npc-progress-card="10016"]').waitFor();
    token = fs.readFileSync(path.join(data, 'game-bridge/token.txt'), 'utf8');
    publish([{ id: 100034, count: 2 }]);
    pulse();
    timer = setInterval(pulse, 500);
    await small.locator('[data-action="npc-progress-tab"][data-id="remaining"]').click();
    await small.locator('[data-npc-progress-card="10016"]').waitFor();
    await small.waitForFunction(() =>
      document.querySelector('[data-npc-progress-page]')?.textContent.includes('现场更新'),
    );
    // An ordinary codex list must use the same current NPC state before a
    // detail has ever been opened; the saved fixture says this bag is empty.
    await main.locator('.sidebar-nav [data-id="database"]').click();
    await main.locator('[data-action="database-kind"][data-id="人物"]').click();
    await main.locator('#list-search').fill('江吟风');
    const initialPerson = main.locator('[data-action="database-detail"][data-id="npc-10016"]').first();
    await initialPerson.focus();
    await main.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.match(await main.locator('#entity-preview').innerText(), /私物还剩 1 种/);
    assert.doesNotMatch(await main.locator('#entity-preview').innerText(), /固定私物|私物已清空/);
    await main.keyboard.press('Escape');
    await small
      .locator('[data-npc-progress-card="10016"] [data-action="database-detail"][data-id="npc-10016"]')
      .first()
      .click();
    await small.locator('#overlay [data-npc-progress="10016"]').waitFor();
    await small.locator('#overlay [data-persist-detail="npc-private-10016"] > summary').click();
    assert.match(await small.locator('#overlay [data-npc-progress="10016"]').innerText(), /×2/);
    publish([]);
    pulse();
    await small.waitForFunction(() =>
      document.querySelector('#overlay [data-npc-progress="10016"]')?.textContent.includes('私物已清空'),
    );
    await small.screenshot({ animations: 'disabled', path: path.join(output, 'live-codex-cleared.png') });
    await small.keyboard.press('Escape');
    await search.fill('卫霍');
    await small.locator('[data-action="npc-progress-tab"][data-id="remaining"]').click();
    await small
      .locator('[data-npc-progress-card="10047"] [data-action="database-detail"][data-id="npc-10047"]')
      .first()
      .click();
    const weiCodex = small.locator('#overlay [data-npc-progress="10047"]');
    await weiCodex.waitFor();
    assert.match(await weiCodex.innerText(), /好感 60/);
    await small
      .locator('#overlay details')
      .filter({ has: small.locator('summary', { hasText: '好感解锁条件' }) })
      .locator('> summary')
      .click();
    assert.match(await small.locator('#overlay').innerText(), /现场：已完成/);
    assert.doesNotMatch(await small.locator('#overlay').innerText(), /存档：进行中/);
    await small.locator('#overlay [data-action="world-person"][data-id="npc-10047"]').click();
    const relatedTask = small.locator('[data-action="world-quest"][data-id="quest-5062"]').first();
    await relatedTask.focus();
    await small.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.match(await small.locator('#entity-preview').innerText(), /已完成/);
    await small.keyboard.press('Escape');
    await relatedTask.click();
    await small.locator('#overlay .world-drawer').waitFor();
    assert.match(await small.locator('#overlay .world-drawer .tag-row').first().innerText(), /已完成/);
    await small.locator('#overlay [data-action="main"]').click();
    await main.locator('#overlay .world-drawer').waitFor();
    assert.match(await main.locator('#overlay .world-drawer .tag-row').first().innerText(), /已完成/);
    await main.keyboard.press('Escape');
    await main.locator('[data-action="compact"]').first().click();
    await small.keyboard.press('Escape');
    await small.locator('.companion-tabs [data-id="duels"]').click();
    await small
      .locator('[data-npc-progress-card="10047"] [data-action="database-detail"][data-id="npc-10047"]')
      .first()
      .click();
    await small.locator('#overlay [data-npc-progress="10047"]').waitFor();
    await small.locator('#overlay [data-persist-detail="npc-private-10047"] > summary').click();
    await small.locator('#overlay [data-action="database-detail"][data-id="item-100073"]').first().click();
    await small.waitForFunction(() =>
      document.querySelector('#overlay .drawer h1')?.textContent.includes('碧玉扳指精良图纸'),
    );
    assert.doesNotMatch(await small.locator('#overlay').innerText(), /987,?654/);
    await small.locator('#overlay [data-action="main"]').click();
    await main.waitForFunction(() =>
      document.querySelector('#overlay .drawer h1')?.textContent.includes('碧玉扳指精良图纸'),
    );
    assert.doesNotMatch(await main.locator('#overlay').innerText(), /987,?654/);
    await main.locator('#overlay [data-action="drawer-back"]').click();
    await main.locator('#overlay [data-npc-progress="10047"]').waitFor();
    assert.match(await main.locator('#overlay [data-npc-progress="10047"]').innerText(), /私物还剩 1 种/);
    await main.keyboard.press('Escape');
    await main.locator('[data-action="compact"]').first().click();
    await small.locator('#overlay [data-action="drawer-back"]').click();
    await small.locator('#overlay [data-npc-progress="10047"]').waitFor();
    assert.match(await small.locator('#overlay [data-npc-progress="10047"]').innerText(), /私物还剩 1 种/);
    if (await small.locator('[data-persist-detail="person-related-quests-npc-10047"]:not([open])').count())
      await small.locator('[data-persist-detail="person-related-quests-npc-10047"] > summary').click();
    await small.locator('#overlay [data-action="world-quest"][data-id="quest-5062"]').first().click();
    await small.locator('#overlay .world-drawer').waitFor();
    assert.match(await small.locator('#overlay .world-drawer .tag-row').first().innerText(), /已完成/);
    await small.locator('#overlay [data-action="drawer-back"]').click();
    await small.locator('#overlay [data-npc-progress="10047"]').waitFor();
    assert.match(await small.locator('#overlay [data-npc-progress="10047"]').innerText(), /好感 60/);
    await small.locator('#overlay [data-action="main"]').click();
    await main.waitForFunction(() =>
      document.querySelector('#overlay [data-npc-progress="10047"]')?.textContent.includes('好感 60'),
    );
    assert.doesNotMatch(await main.locator('#overlay').innerText(), /存档：进行中/);
    await main.keyboard.press('Escape');
    await main.locator('[data-action="compact"]').first().click();
    await small.keyboard.press('Escape');
    await search.fill('白锦');
    await small.locator('[data-action="npc-progress-tab"][data-id="locked"]').click();
    const bai = small.locator('[data-npc-progress-card="10131"]');
    if (!(await bai.evaluate((node) => node.open))) await bai.locator('> summary').click();
    await bai.locator('[data-action="world-quest"][data-id="quest-12001"]').first().click();
    await small.locator('#overlay .world-drawer').waitFor();
    assert.match(await small.locator('#overlay .world-drawer .tag-row').first().innerText(), /进行中/);
    await small.locator('#overlay [data-action="main"]').click();
    await main.locator('#overlay .world-drawer').waitFor();
    assert.match(await main.locator('#overlay .world-drawer .tag-row').first().innerText(), /进行中/);
    await main.keyboard.press('Escape');
    await main.locator('[data-action="compact"]').first().click();
    await small.keyboard.press('Escape');
    await search.fill('江吟风');
    currentObservation = null;
    pulse();
    await small.waitForFunction(() =>
      document.querySelector('[data-npc-progress-page]')?.textContent.includes('保存后更新'),
    );
    await small.locator('[data-action="npc-progress-tab"][data-id="learning"]').click();
    const fallback = small.locator('[data-npc-progress-card="10016"]');
    if (!(await fallback.evaluate((node) => node.open))) await fallback.locator('> summary').click();
    const learningDetail = fallback.locator('[data-persist-detail="npc-learning-10016"]');
    if (!(await learningDetail.evaluate((node) => node.open)))
      await learningDetail.locator('> summary').click();
    assert.match(await fallback.innerText(), /1 → 3/);
    const latestFile = path.join(source, '2.sav');
    const latestBytes = syntheticSave({ full: true, npcs, quests: [], map: 'LV_25_P' });
    fs.writeFileSync(latestFile, latestBytes);
    publish([{ id: 100034, count: 1 }]);
    pulse();
    await small.waitForFunction(() =>
      document.querySelector('[data-npc-progress-page]')?.textContent.includes('现场更新'),
    );
    await small
      .locator('[data-npc-progress-card="10016"] [data-action="database-detail"][data-id="npc-10016"]')
      .first()
      .click();
    await small.locator('#overlay [data-npc-progress="10016"]').waitFor();
    assert.match(await small.locator('#overlay [data-npc-progress="10016"]').innerText(), /私物还剩 1 种/);
    await main.evaluate(async () => {
      const result = await window.journal.mutate({ type: 'save-slot', value: '1.sav', mode: 'slot' });
      if (!result.ok) throw Error(result.error);
    });
    await small.waitForFunction(() =>
      document.querySelector('#overlay [data-npc-progress="10016"]')?.textContent.includes('私物已清空'),
    );
    await small.locator('#overlay [data-action="main"]').click();
    await main.waitForFunction(() =>
      document.querySelector('#overlay [data-npc-progress="10016"]')?.textContent.includes('私物已清空'),
    );
    assert.match(await main.locator('#overlay').innerText(), /保存后更新/);
    await main.keyboard.press('Escape');
    if (await small.locator('#overlay .drawer').isVisible()) await small.keyboard.press('Escape');
    await main.evaluate(async () => {
      const result = await window.journal.mutate({ type: 'save-slot', value: '', mode: 'latest' });
      if (!result.ok) throw Error(result.error);
    });
    await main.locator('.sidebar-nav [data-id="home"]').click();
    await main.locator('[data-action="compact"]').first().click();
    const closeSmallDetail = small.locator('#overlay [data-action="close-overlay"]').first();
    if (await closeSmallDetail.isVisible()) await closeSmallDetail.click();
    await small.locator('.companion-tabs [data-id="home"]').click();
    const checkpointQuests = [
      { id: 12071, step: 4 },
      { id: 12075, step: 4 },
      { id: 12090, step: 1 },
      { id: 12094, step: 1 },
      { id: 11272, step: 1 },
    ];
    for (const [friend, pattern] of [
      [70, '好感 70.*取胜会让他离场.*线索也会失败'],
      [90, '好感 90.*取胜会让他离场.*线索也会失败'],
      [69, '好感 69.*低于 70.*保留人物.*赠礼可能改变结果'],
      [null, '先核对.*达到 70.*取胜会让他离场.*线索也会失败'],
    ]) {
      publish([], {
        quests: checkpointQuests,
        npcs: [liveNpc(0), ...(friend === null ? [] : [liveNpc(10221, { rawFriendliness: friend })])],
      });
      pulse();
      for (const [page, selector] of [
        [main, '[data-flow-warning="chenlinxi-recruit-followup"] .flow-warning-message'],
        [small, '[data-persist-detail="flow-risk-window-chenlinxi-recruit-followup"] > summary'],
      ]) {
        await page.waitForFunction(
          ([selector, pattern]) =>
            new RegExp(pattern).test(document.querySelector(selector)?.textContent || ''),
          [selector, pattern],
        );
        assert.equal(await page.locator(selector).isVisible(), true);
      }
      await small.screenshot({
        animations: 'disabled',
        path: path.join(output, `checkpoint-${friend ?? 'unknown'}.png`),
      });
    }
    publish([], {
      quests: [...checkpointQuests, { id: 12095, step: 1 }],
      npcs: [liveNpc(0), liveNpc(10221, { rawFriendliness: 90 })],
    });
    pulse();
    await main.locator('[data-flow-warning="chenlinxi-recruit-followup"]').waitFor({ state: 'detached' });
    await small
      .locator('[data-persist-detail="flow-risk-window-chenlinxi-recruit-followup"]')
      .waitFor({ state: 'detached' });
    assert.deepEqual(fs.readFileSync(latestFile), latestBytes);
    assert.deepEqual(fs.readFileSync(file), expected, 'only the fixture writer changes the synthetic save');
    assert.deepEqual(errors, []);
    console.log(
      'NPC progress PASS: saved and live private bags, learning, caps, both windows, live codex refresh, withdrawal fallback, visible conditional checkpoint consequences and unchanged save;',
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
