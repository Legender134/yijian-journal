'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { defaults } = require('../src/core/store.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const catalog = require('../src/data/catalog.cjs');

const id = 'jinli-coin-before-accepting';
const state = () => defaults();
const reference = (quests = [], mapName = '津鲤村') => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-coin-choice',
  modifiedAt: '2026-10-14T00:00:00Z',
  metadata: { quests, inventory: [], mapName },
});
const current = (quests, mapName) => {
  const value = state();
  return flowSnapshot(value.profiles[0], reference(quests, mapName));
};

test('arrival guidance names the mutually exclusive tasks before either has been accepted', () => {
  for (const place of ['津鲤村', 'LV_28_P']) {
    const flow = current([], place);
    const choice = flow.decisions.find((row) => row.id === id);
    assert(choice);
    assert.match(choice.recommendation.hint, /小蝶之心/);
    assert.match(choice.recommendation.reason, /武学.*陶瓷塑像/);
    assert.match(choice.pickup.place, /小蝶右上方屋后宝箱/);
    assert.deepEqual(
      choice.affectedTasks.map((row) => row.questId),
      [11127, 11129],
    );
    assert(choice.choices.every((row) => /排除本次/.test(row.effect)));
    assert.equal(new Set(choice.sources.map((row) => row.author)).size, 2);
  }
  assert(!current([], '洛村').decisions.some((row) => row.id === id));
  assert(!current([], '').decisions.some((row) => row.id === id));
});

test('acceptance, completion or failure of either route retires the pre-acceptance recommendation', () => {
  for (const questId of [11127, 11128, 11129, 11130]) {
    for (const step of [1, 2, 4]) {
      const flow = current([{ id: questId, step }]);
      for (const list of [flow.decisions, flow.warnings, flow.advice, flow.opportunities])
        assert(!list.some((row) => row.id === id), `${questId}:${step} must not suggest changing routes`);
      assert(
        flow.guide.some((row) => row.id === id),
        'offline comparison remains available',
      );
    }
  }
  assert(current([{ id: 11129, step: 3 }]).decisions.some((row) => row.id === id));
});

test('the arrival choice reaches lightweight hints and respects reference-free mode', () => {
  const value = state();
  const snapshot = companionSnapshot(value, catalog, reference());
  assert.equal(snapshot.hints[0].type, 'flow-choice');
  assert.equal(snapshot.hints[0].id, 'quest-11129');
  assert.match(snapshot.hints[0].title, /小蝶之心/);
  value.profiles[0].referenceMode = 'none';
  const offline = companionSnapshot(value, catalog, reference());
  assert(!offline.flow.decisions.some((row) => row.id === id));
  assert(!offline.hints.some((row) => row.id === 'quest-11129'));
});

test('the same ancient coin entry exposes its location and both delivery choices', () => {
  const coin = encyclopedia().entries.find((row) => row.id === 'item-10055');
  const route = coin.acquisitionRoutes.find((row) => row.questId === 11129);
  assert.match(route.detail, /津鲤村小蝶右上方屋后/);
  assert.match(route.detail, /小蝶或司马相/);
  assert.equal(route.sources.length, 2);
  for (const questId of [11128, 11130]) {
    const flow = current([{ id: questId, step: 1 }]);
    const taskMaterial = flow.active[0].steps[0].materials[0];
    const taskRoute = taskMaterial.routes.find((row) => row.placeId === 'place-21');
    assert.equal(taskRoute.detail, route.detail);
    assert.match(taskRoute.efficiency, /一次性宝箱/);
  }
});

test('the saved village adds its two exact blueprint leads without guessing a main-story stage or victory', () => {
  const duels = current([]).duels;
  assert.match(duels.reason, /已保存地点/);
  const local = duels.candidates.filter((row) => row.id.startsWith('npc069-jinli-'));
  assert.deepEqual(
    local.map((row) => [row.npcId, row.level, row.rewards[0].itemId]),
    [
      [10352, 10, 100073],
      [10353, 15, 100052],
    ],
  );
  for (const row of local) {
    assert.equal(row.locationMatch, true);
    assert.equal(row.stageMatch, false);
    assert.match(row.rewards[0].probability, /不保证首胜/);
    assert.equal(row.readiness.status, 'verify');
    assert.match(row.readiness.reason, /没有可核定的角色记录/);
  }
  assert(!current([], '洛村').duels.candidates.some((row) => row.id.startsWith('npc069-jinli-')));
});
