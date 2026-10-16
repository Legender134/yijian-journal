'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve(__dirname, '..');
const { encyclopedia } = require(path.join(root, 'src/core/game-data.cjs'));
const { createNpcProgressProjector } = require(path.join(root, 'src/core/npc-progress.cjs'));
const world = require(path.join(root, 'src/data/world-index.json')),
  game = require(path.join(root, 'src/data/game-index.json')),
  contracts = require(path.join(root, 'src/data/npc-interactions.json'));
const { pathToFileURL } = require('node:url');
const loaded = Promise.all(
  ['npc-progress-views.js', 'entity-references.js'].map(
    (name) => import(pathToFileURL(path.join(root, 'src/renderer', name)).href),
  ),
);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const helpers = {
  esc,
  act: (_a, label) => label,
  richText: esc,
  picture: () => '',
  icon: () => '',
  qualityText: { html: (_id, label) => label },
};
test('no-Consult variants never promise learnable upgrades in hover or detail', async () => {
  const [{ createNpcProgressViews }, { createEntityReferences }] = await loaded;
  const index = encyclopedia(),
    project = createNpcProgressProjector({ world, game, contracts });
  const attrs = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 40, 44: 100, 27: 5, 48: 0, 61: 0, 63: 0, 65: 0, 67: 0 };
  for (const id of [10011, 9001]) {
    const person = world.people.find((p) => p.gameId === id);
    const input = {
      combat: {
        format: 14,
        player: { attributes: attrs, skills: [], skillPoints: 100000 },
        npcStates: [
          {
            id,
            inventory: [{ id: 10201, count: 1 }],
            skills: person.skills.map((s) => ({ id: Number(s.id.slice(6)), level: s.level })),
            attributes: { ...attrs, 61: 1, 63: 1, 65: 1, 67: 1 },
            rawFriendliness: 90,
            visible: true,
            mapKey: 'LV_25_P',
            level: 60,
          },
        ],
      },
      inventory: [],
      quests: [],
    };
    const before = structuredClone(input),
      data = project(input),
      row = data.people[0];
    assert(row.learning.length > 0);
    assert(row.learning.every((i) => i.status === 'unmet'));
    const refs = createEntityReferences({ ...helpers, index: () => index }),
      html = refs.preview('npc-' + id, { npcProgress: data });
    assert.match(html, /请教受限/);
    assert.match(html, /请教[^<]*暂无入口/);
    assert.doesNotMatch(html, /可提升|可请教 \d+ 项|待确认 \d+ 项/);
    assert.match(createNpcProgressViews(helpers).person(row), /请教受限/);
    if (id === 10011) assert.match(html, /赠礼、请教：暂无入口/);
    assert.deepEqual(input, before);
  }
});
test('hover and detail share met, unknown and blocked counts without promoting unknown', async () => {
  const [{ createNpcProgressViews, npcLearningSummary }, { createEntityReferences }] = await loaded;
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index }),
    views = createNpcProgressViews(helpers);
  const cases = [
    [[], ''],
    [['unmet', 'unmet'], '请教受限'],
    [['met', 'met'], '可请教 2 项'],
    [['unknown'], '待确认 1 项'],
    [['met', 'unknown', 'unmet', 'unmet'], '可请教 1 项 · 待确认 1 项 · 受限 2 项'],
  ];
  for (const [statuses, expected] of cases) {
    const row = {
      npcId: 8500,
      id: 'npc-8500',
      name: '江小彤',
      remainingItems: [],
      learning: statuses.map((status, i) => ({ status, name: '技艺' + i, checks: [] })),
      friendship: { value: 90, cap: 100, checks: [] },
      gift: { checks: [] },
      compare: { checks: [] },
      consult: { checks: [] },
    };
    assert.equal(npcLearningSummary(row.learning), expected);
    if (expected) {
      assert(refs.preview(row.id, { npcProgress: { people: [row] } }).includes(expected));
      assert(views.person(row).includes(expected));
    }
    assert.doesNotMatch(refs.preview(row.id, { npcProgress: { people: [row] } }), /可提升/);
  }
});
test('martial teaching shows current teacher proficiency without promising that learned level', async () => {
  const [{ createNpcProgressViews }] = await loaded;
  const row = {
    npcId: 8500,
    remainingItems: [],
    learning: [{ kind: 'martial', name: '江湖拳掌', teacherLevel: 7, status: 'unknown', checks: [] }],
    friendship: { value: 90, cap: 100, checks: [] },
    gift: { checks: [] },
    compare: { checks: [] },
    consult: { checks: [] },
  };
  const views = createNpcProgressViews(helpers);
  assert.match(views.person(row), /江湖拳掌 · 对方 7 级/);
  assert.doesNotMatch(views.person(row), /0 → 7|学会.*7/);
  row.learning[0].teacherLevel = null;
  assert.doesNotMatch(views.person(row), /对方.*级/);
});

test('unobserved actor previews retain known missing operations without advertising a Gift entry', async () => {
  const [, { createEntityReferences }] = await loaded;
  const index = encyclopedia();
  const refs = createEntityReferences({ ...helpers, index: () => index });
  for (const id of [8500, 10011, 10309, 19112]) {
    const html = refs.preview('npc-' + id);
    assert.match(html, /赠礼[^<]*暂无入口/);
    assert.doesNotMatch(html, /赠礼偏好/);
    if (id === 10011) assert.match(html, /赠礼、请教：暂无入口/);
  }
  assert.doesNotMatch(refs.preview('npc-9001'), /赠礼[^<]*暂无入口/);
});
