'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/data/game-index.json');
const world = require('../src/data/world-index.json');
const { createNpcProgressProjector } = require('../src/core/npc-progress.cjs');
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
test('NPC codex renders one live quest cohort and never labels saved holdings as current', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const { createEntityDetailViews } = await import('../src/renderer/entity-detail-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const act = (action, label, cls, id) =>
    `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`;
  const pill = (value) => `<span>${esc(value)}</span>`;
  const helpers = {
    esc,
    act,
    pill,
    icon: () => '',
    iconButton: () => '',
    notice: esc,
    empty: esc,
    picture: () => '',
    when: esc,
    bytes: esc,
    hours: esc,
    qualityText: { label: () => '', name: (_e, name) => esc(name), quality: () => '' },
  };
  const relations = createEntityDetailViews(helpers);
  const views = createGameViews({ ...helpers, personRelations: relations.person });
  const worldViews = createWorldViews(helpers);
  const wei = {
    ...game.entries.find((e) => e.id === 'npc-10047'),
    ...world.people.find((p) => p.gameId === 10047),
  };
  const index = {
    ...game,
    world,
    entries: game.entries.map((e) => (e.id === wei.id ? wei : e)),
    renderRequirements: worldViews.requirementRows,
  };
  const saved = {
    name: '1.sav',
    hash: 'synthetic-old',
    metadata: {
      quests: [
        { id: 5062, step: 1 },
        { id: 5066, step: 1 },
      ],
      inventory: [{ id: 10262, count: 99 }],
    },
  };
  const live = {
    origin: 'live',
    key: 'live-cohort',
    metadata: {
      quests: [
        { id: 5062, step: 4 },
        { id: 5066, step: 4 },
        { id: 5091, step: 4 },
      ],
    },
  };
  const project = createNpcProgressProjector({
    world,
    game,
    contracts: require('../src/data/npc-interactions.json'),
  });
  const progress = project({
    quests: live.metadata.quests,
    combat: {
      origin: 'live',
      player: { id: 0, attributes: { 44: 100 }, skills: [], skillPoints: 500 },
      npcStates: [
        {
          id: 10047,
          attributes: {},
          skills: [],
          inventory: [],
          rawFriendliness: 60,
          visible: true,
          mapKey: 'LV_25_P',
        },
      ],
    },
  });
  const html = views.detail(index, wei.id, 1, saved, [], saved.name, false, {}, 0, {}, '', progress, live);
  assert.match(html, /好感 60/);
  assert.match(html, /现场：已完成/);
  assert.doesNotMatch(html, /存档：进行中/);
  assert.match(html, />可送礼物</);
  assert.doesNotMatch(html, />背包中的礼物</);
  assert.match(html, />现场更新</);
  const fixed = views.detail(index, wei.id, 1, saved);
  assert.match(fixed, /存档：进行中/);
  assert.doesNotMatch(fixed, /现场：已完成/);
});
