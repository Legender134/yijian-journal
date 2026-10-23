'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNpcProgressProjector } = require('../src/core/npc-progress.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const contracts = require('../src/data/npc-interactions.json');
const make = (extra = {}) =>
  createNpcProgressProjector({
    world,
    game,
    contracts: { ...contracts, friendlyLimits: { Compare: 20 }, ...extra },
  });
const project = make();
test('live gift title gap, vigor boundaries and useful life-skill floor are distinct gates', () => {
  const input = metadata([npc(10016, { attributes: { 27: 0.8 }, inventory: [{ id: 100034, count: 1 }] })]);
  const powers = (health) => ({ 9: 0, 10: 0, 14: 0, 11: 0, 12: 0, 2: health, 4: 0 });
  input.combat.origin = 'live';
  input.combat.player.attributes = { ...input.combat.player.attributes, ...powers(0), 27: 0 };
  input.combat.npcStates[0].attributes = { ...input.combat.npcStates[0].attributes, ...powers(2000) };
  let row = project(input).people[0];
  assert.equal(row.gift.status, 'unmet', 'two title levels above player blocks the proved gift gate');
  assert.match(row.gift.checks.find((r) => /赠礼境界/.test(r.text)).text, /相差两阶/);
  assert(
    !row.learning.some((r) => r.kind === 'life'),
    'teacher below native level 1 is not a useful consult',
  );
  input.combat.npcStates[0].attributes[2] = 1000;
  assert.equal(project(input).people[0].gift.status, 'met', 'one title level passes this gate');
  for (const [vigor, status] of [
    [4, 'unmet'],
    [5, 'unknown'],
    [9, 'unknown'],
    [10, 'met'],
  ]) {
    input.combat.player.attributes[44] = vigor;
    assert.equal(project(input).people[0].compare.status, status);
  }
  delete input.combat.origin;
  input.combat.player.attributes[44] = 100;
  row = project(input).people[0];
  assert.equal(row.gift.status, 'unknown', 'saved base values do not determine current gift title');
});
const npc = (id, extra = {}) => ({
  id,
  level: 15,
  rawFriendliness: 70,
  visible: true,
  attributes: { 27: 1, 48: 1, 61: 1, 63: 1, 65: 1, 67: 1 },
  inventory: [],
  equipment: [],
  skills: [],
  mapKey: 'LV_25_P',
  ...extra,
});
const metadata = (npcs = [], quests = [], extra = {}) => ({
  map: 'LV_25_P',
  quests,
  inventory: [],
  combat: {
    format: 14,
    player: {
      id: 0,
      attributes: { 44: 100, 27: 1, 48: 1, 61: 1, 63: 1, 65: 1, 67: 1 },
      skills: [{ id: 850, level: 3 }],
      skillPoints: 500,
    },
    npcStates: npcs,
  },
  ...extra,
});

test('remaining private inventory is actual state, distinct from equipment, ownership and unknown NPCs', () => {
  const input = metadata(
    [
      npc(10038, {
        inventory: [
          { id: 100034, count: 1 },
          { id: 10201, count: 2 },
          { id: 10201, count: 3 },
          { id: 100, count: 0 },
        ],
        equipment: [{ id: 1002, count: 1 }],
      }),
      npc(10047),
    ],
    [
      { id: 5066, step: 4 },
      { id: 5091, step: 4 },
    ],
    { inventory: [{ id: 100034, count: 1 }] },
  );
  const before = structuredClone(input);
  const result = project(input);
  const woodcutter = result.people.find((row) => row.npcId === 10038);
  assert.deepEqual(
    woodcutter.remainingItems.map((row) => row.id),
    [100034, 10201],
  );
  assert.equal(woodcutter.remainingItems[0].owned, 1, 'owning another copy does not clear this NPC');
  assert.equal(woodcutter.remainingItems[0].important, true);
  assert.equal(woodcutter.remainingItems[1].count, 5, 'multiple private stacks count as one item kind');
  assert.equal(woodcutter.collection, 'remaining');
  assert(result.cleared.some((row) => row.npcId === 10047));
  assert(!result.cleared.some((row) => row.npcId === 5003), 'unrecorded teacher is not completed');
  assert.deepEqual(input, before);
  assert.equal(project({}).available, false);
  assert.equal(project({ combat: { ...input.combat, format: 13 } }).available, false);
});

test('story caps use the first unmet lock in order and block only interactions above the effective cap', () => {
  const saved = npc(10047, { rawFriendliness: 90, inventory: [{ id: 100034, count: 1 }] });
  let row = project(metadata([saved])).people[0];
  assert.equal(row.friendship.value, 0);
  assert.equal(
    row.compare.status,
    'met',
    'Compare uses raw friendship, not the story-capped consultation value',
  );
  assert(row.gift.checks.some((check) => check.id === 5066));
  row = project(metadata([saved], [{ id: 5066, step: 4 }])).people[0];
  assert.equal(row.friendship.cap, 20);
  assert.equal(row.compare.status, 'met', '20 cap does not block a 20 threshold');
  assert.equal(row.gift.status, 'unmet', 'do not waste more gifts at a locked cap');
  assert(row.gift.checks.some((check) => check.id === 5091));
  row = project(
    metadata(
      [saved],
      [
        { id: 5066, step: 4 },
        { id: 5091, step: 4 },
      ],
    ),
  ).people[0];
  assert.equal(row.friendship.cap, 60);
  row = project(
    metadata(
      [saved],
      [
        { id: 5066, step: 4 },
        { id: 5091, step: 4 },
        { id: 14301, step: 4 },
      ],
    ),
  ).people[0];
  assert.equal(row.friendship.cap, 100);
  assert.equal(row.friendship.value, 90);
  const incomplete = metadata([saved]);
  delete incomplete.quests;
  row = project(incomplete).people[0];
  assert.equal(
    row.friendship.value,
    null,
    'failed quest parsing is different from a complete collection with missing keys',
  );
  assert.equal(
    row.compare.status,
    'met',
    'the raw Compare gate does not depend on unresolved consultation caps',
  );
  assert.equal(project(metadata([npc(10047, { rawFriendliness: 0 })])).people[0].compare.status, 'unmet');
});

test('consultation compares saved life skills and learned martial arts, respecting real function and native exclusion', () => {
  const skills = [
    { id: 850, level: 10 },
    { id: 100, level: 8 },
    { id: 101, level: 7 },
  ];
  const teacher = npc(10016, { attributes: { 65: 3, 67: 2, 48: 1 }, skills });
  const input = metadata([teacher, npc(10038, { attributes: { 67: 4 }, skills })]);
  let result = project(input);
  const jiang = result.people.find((row) => row.npcId === 10016);
  assert.deepEqual(
    jiang.learning
      .filter((row) => row.kind === 'life')
      .map((row) => [row.name, row.playerLevel, row.teacherLevel]),
    [
      ['炼丹', 1, 3],
      ['采集', 1, 2],
    ],
  );
  assert(
    !jiang.learning.some((row) => row.id === 850),
    'an already learned skill is not recommended again at the teacher level',
  );
  assert(jiang.learning.some((row) => row.id === 100 && row.threshold === 50));
  assert(
    result.people.find((row) => row.npcId === 10038).learning.every((row) => row.status === 'unmet'),
    'having a skill does not create a consultation menu',
  );
  const filtered = make({
    skills: {
      ...contracts.skills,
      100: { ...contracts.skills[100], excluded: true },
      101: { ...contracts.skills[101], openForPlayer: false },
    },
  });
  result = filtered(input);
  assert(!result.people[0].learning.some((row) => row.kind === 'martial'));
  const missing = metadata([npc(10016, { attributes: { 65: 3 }, skills: [] })]);
  delete missing.combat.player.attributes[65];
  assert.equal(
    project(missing).people[0].learning.length,
    0,
    'missing saved life values are not guessed to be zero',
  );
});

test('hidden saved locations remain blocked leads, never a claim of death or permanent route loss', () => {
  const row = project(metadata([npc(10038, { visible: false, inventory: [{ id: 100034, count: 1 }] })]))
    .people[0];
  assert.equal(row.compare.status, 'unknown');
  assert.match(row.compare.checks.map((x) => x.text).join(''), /地图中暂未显示/);
  assert.equal(row.collection, 'remaining');
  assert.equal(row.place.name, '梧桐村');
  assert.equal(Object.hasOwn(row, 'dead'), false);
});

test('pending NPC views stay concise, linked, searchable and escaped in both sidebar and codex', async () => {
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const esc = (value) =>
    String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const view = createNpcProgressViews({
    esc,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  });
  const data = project(metadata([npc(10038, { inventory: [{ id: 100034, count: 1 }] }), npc(10047)]));
  const html = view.page(data, { query: '寒铁', scope: 'synthetic' });
  assert.match(html, /data-npc-progress-card="10038"/);
  assert.doesNotMatch(html, /data-npc-progress-card="10047"/);
  assert.match(html, /data-id="item-100034"/);
  assert.match(html, /data-id="place-9"/);
  assert.match(html, /data-persist-detail="npc-progress-synthetic-10038"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(view.person(null), /还没有此人物的状态/);
  data.people[0].name = '<img src=x onerror=bad>';
  assert.doesNotMatch(view.page(data), /<img src=x/);
  const bai = project(metadata([npc(10131, { inventory: [{ id: 100034, count: 1 }] })])).people[0];
  assert.match(view.person(bai), /data-action="world-quest" data-id="quest-12001"/);
  assert.doesNotMatch(view.person(bai), /data-id="npc-10131">白锦<\/button>的好奇/);
});

test('effective friendship 100 blocks further gift instead of inviting waste', () => {
  const input = metadata([npc(10016, { rawFriendliness: 100 })]);
  const row = project(input).people[0];
  assert.equal(row.friendship.value, 100);
  assert.equal(row.gift.status, 'unmet');
  assert(row.gift.checks.some((check) => check.status === 'unmet' && /好感已满/.test(check.text)));
});

test('gift quality boundaries and private stack count are directly usable by the UI', async () => {
  for (const [friend, quality] of [
    [0, '白'],
    [19, '白'],
    [20, '绿'],
    [39, '绿'],
    [40, '蓝'],
    [59, '蓝'],
    [60, '金'],
    [79, '金'],
    [80, '暗金'],
    [99, '暗金'],
  ]) {
    const row = project(metadata([npc(10016, { rawFriendliness: friend })])).people[0];
    assert.equal(row.gift.minimumQuality, quality, `affinity ${friend}`);
  }
  const input = metadata([npc(10047)]);
  delete input.quests;
  assert.equal(
    project(input).people[0].gift.minimumQuality,
    null,
    'unknown effective affinity has no inferred threshold',
  );
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const view = createNpcProgressViews({ esc: String, act: (_a, label) => label });
  const data = project(metadata([npc(10038, { inventory: [{ id: 100034, count: 3 }] })]));
  const summary = view.page(data).match(/<summary>([\s\S]*?)<\/summary>/)[1];
  assert.match(summary, /寒铁.*×3/);
});

test('learning summary prioritizes currently available arts while retaining other restrictions in details', async () => {
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const view = createNpcProgressViews({ esc: String, act: (_action, label) => label });
  const projector = createNpcProgressProjector({
    world: {
      people: [{ id: 'npc-1', gameId: 1, name: '合成教师', functions: ['Consult'], friendshipLocks: [] }],
      quests: [],
      maps: [],
    },
    game: { entries: [1, 2, 3].map((id) => ({ id: 'skill-' + id, gameId: id, name: '合成功法' + id })) },
    contracts: { skills: { 1: { friendliness: 90 }, 2: { friendliness: 90 }, 3: { friendliness: 40 } } },
  });
  const input = {
    combat: {
      format: 14,
      player: { attributes: { 44: 100 }, skills: [] },
      npcStates: [
        {
          id: 1,
          attributes: { 44: 100 },
          skills: [1, 2, 3].map((id) => ({ id, level: 1 })),
          inventory: [],
          rawFriendliness: 50,
          visible: true,
          mapKey: '',
          level: 1,
        },
      ],
    },
    quests: [],
  };
  let data = projector(input);
  assert.deepEqual(
    data.people[0].learning.map((row) => row.status),
    ['unmet', 'unmet', 'met'],
  );
  const before = structuredClone(data);
  const html = view.page(data, { tab: 'learning' });
  const summary = html.match(/<details class="npc-progress-card"[\s\S]*?<summary>([\s\S]*?)<\/summary>/)[1];
  assert.match(summary, /合成功法3/);
  assert.doesNotMatch(summary, /合成功法1|合成功法2|好感 90/);
  const details = view.person(data.people[0], true);
  assert(details.indexOf('合成功法3') < details.indexOf('合成功法1'));
  assert.match(details, /合成功法1.*好感 90.*合成功法2/s);
  assert.deepEqual(data, before, 'presentation cannot reorder or modify shared progress');
  input.combat.npcStates[0].rawFriendliness = 30;
  data = projector(input);
  assert.equal(data.learning.length, 0, 'a fully restricted teacher leaves the actionable list');
  assert.match(view.person(data.people[0], true), /好感 90/, 'full restrictions remain available');
});

test('NPC details show shared story blockers once and the locked summary exposes its actual restricted operation', async () => {
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const view = createNpcProgressViews({
    esc: String,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
  });
  const data = project(
    metadata([
      npc(10047, {
        rawFriendliness: 90,
        inventory: [{ id: 100034, count: 1 }],
        skills: [{ id: 151, level: 5 }],
      }),
    ]),
  );
  const row = data.people[0];
  const html = view.person(row);
  for (const check of row.friendship.checks.filter((check) => check.status !== 'met')) {
    if (check.entityId)
      assert.equal((html.match(new RegExp(`data-id="${check.entityId}"`, 'g')) || []).length, 1);
  }
  assert.match(html, /暂时上限/);
  assert.match(html, /比武|请教/);
  assert.equal(row.compare.status, 'met', 'raw affinity may permit compare while gifts are story-capped');
  const card = view.page(data, { tab: 'locked' }).split('</summary>')[0];
  assert.match(card, /npc-progress-blocker.*好感暂时上限/s);
  assert.match(html, /私物还剩/);
});

test('actionable opponents and teachers rank ahead of nearby unresolved leads', () => {
  const nearbyUnknown = npc(10038, { visible: false, inventory: [{ id: 100034, count: 1 }] });
  const ready = npc(10016, {
    mapKey: 'LV_26_P',
    attributes: { 65: 3 },
    inventory: [{ id: 100034, count: 1 }],
  });
  const unknownTeacher = npc(10047, { attributes: { 65: 3 }, rawFriendliness: 90 });
  const input = metadata([nearbyUnknown, unknownTeacher, ready]);
  delete input.quests;
  const result = project(input);
  assert.equal(result.remaining[0].npcId, 10016);
  assert.equal(result.learning[0].npcId, 10016);
  assert.equal(result.people.find((row) => row.npcId === 10047).learning[0].status, 'unknown');
  assert.equal(result.people.find((row) => row.npcId === 10038).compare.status, 'unknown');
});

test('player backpack stacks sum without clearing remaining NPC loot; unknown ownership stays unknown', () => {
  const input = metadata([npc(10038, { inventory: [{ id: 100034, count: 1 }] })], [], {
    inventory: [
      { id: 100034, count: 2 },
      { id: 100034, count: 3 },
    ],
  });
  const before = structuredClone(input);
  let result = project(input);
  assert.equal(result.inventoryKnown, true);
  assert.equal(result.remaining[0].remainingItems[0].owned, 5);
  assert.equal(result.remaining[0].collection, 'remaining');
  assert.deepEqual(input, before);
  delete input.inventory;
  result = project(input);
  assert.equal(result.inventoryKnown, false);
  assert.equal(result.remaining[0].remainingItems[0].owned, null);
});

test('readiness, scene and unowned key-item filters retain search, unknowns and collection boundaries', async () => {
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const view = createNpcProgressViews({
    esc: String,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
  });
  const input = metadata(
    [
      npc(10038, { visible: false, inventory: [{ id: 100034, count: 1 }] }),
      npc(10016, { mapKey: 'LV_26_P', inventory: [{ id: 100073, count: 1 }], attributes: { 65: 3 } }),
    ],
    [],
    { inventory: [{ id: 100073, count: 1 }] },
  );
  const data = project(input);
  const before = structuredClone(data);
  const cards = (html) =>
    [...html.matchAll(/data-npc-progress-card="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(cards(view.page(data, { filter: 'ready' })), [10016]);
  assert.deepEqual(cards(view.page(data, { filter: 'nearby' })), [10038]);
  assert.deepEqual(cards(view.page(data, { filter: 'missing' })), [10038]);
  assert.deepEqual(cards(view.page(data, { tab: 'learning', filter: 'ready' })), [10016]);
  const noMatch = view.page(data, { filter: 'missing', query: '江吟风' });
  assert.deepEqual(cards(noMatch), []);
  assert.match(noMatch, /data-action="npc-progress-filter" data-id="all"/);
  assert.match(noMatch, /value="江吟风"/);
  assert.deepEqual(data, before);
  delete input.inventory;
  const unknown = view.page(project(input), { filter: 'missing' });
  assert.deepEqual(cards(unknown), []);
  assert.match(unknown, /背包状态未读取/);
  delete input.map;
  assert.match(view.page(project(input), { filter: 'nearby' }), /当前场景未读取/);
  input.inventory = [];
  assert.deepEqual(cards(view.page(project(input), { filter: 'missing' })), [10016, 10038]);
});

test('collapsed cards expose one actionable condition and current power, keeping all conditions in details', async () => {
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const view = createNpcProgressViews({ esc: String, act: (_action, label) => label });
  const input = metadata([npc(10016, { rawFriendliness: 0, inventory: [{ id: 100034, count: 1 }] })]);
  input.combat.player.attributes[44] = 0;
  const data = project(input);
  const html = view.page(data, { tab: 'locked' });
  const summary = html.split('</summary>')[0];
  assert.match(summary, /比武好感 20/);
  assert.doesNotMatch(summary, /比武：比武/);
  assert.doesNotMatch(summary, /精力不足/);
  assert.match(html, /精力不足/);
  const powers = { 9: 100, 10: 10, 14: 20, 11: 100, 12: 10, 2: 1000, 4: 800, 44: 100 };
  input.combat.origin = 'live';
  input.combat.player.attributes = powers;
  input.combat.npcStates[0].attributes = { ...powers, 2: 2000 };
  input.combat.npcStates[0].rawFriendliness = 70;
  const ready = view.page(project(input)).split('</summary>')[0];
  assert.match(ready, /可比武/);
  assert.match(ready, /战力：你 \d+ \/ 对方 \d+/);
  assert.doesNotMatch(ready, /必胜|胜率/);
  delete input.combat.origin;
  assert.doesNotMatch(view.page(project(input)).split('</summary>')[0], /战力：/);
});
