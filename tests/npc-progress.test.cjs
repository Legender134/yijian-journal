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
