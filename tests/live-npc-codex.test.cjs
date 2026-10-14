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
  assert.match(html, />符合偏好的物品 · \d+ 种 · 金色起</);
  assert.doesNotMatch(html, />背包中的礼物</);
  assert.match(html, />现场更新</);
  const fixed = views.detail(index, wei.id, 1, saved);
  assert.match(fixed, /存档：进行中/);
  assert.doesNotMatch(fixed, /现场：已完成/);
});

test('NPC gift suggestions respect observed quality and gate without inventing availability', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const act = (action, label, _cls, id) =>
    `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`;
  const views = createGameViews({
    esc,
    act,
    pill: esc,
    icon: () => '',
    iconButton: (action, _icon, label, id) => act(action, label, '', id),
    notice: esc,
    empty: esc,
    picture: () => '',
    when: esc,
    bytes: esc,
    hours: esc,
    qualityText: { label: () => '', name: (_e, name) => esc(name), quality: () => '' },
  });
  const jiang = {
    ...game.entries.find((e) => e.id === 'npc-10016'),
    ...world.people.find((p) => p.gameId === 10016),
  };
  const index = { ...game, world, entries: game.entries.map((e) => (e.id === jiang.id ? jiang : e)) };
  const project = createNpcProgressProjector({
    world,
    game,
    contracts: require('../src/data/npc-interactions.json'),
  });
  const attrs = { 44: 100, 9: 0, 10: 0, 14: 0, 11: 0, 12: 0, 2: 1000, 4: 0 };
  const metadata = {
    quests: [],
    combat: {
      origin: 'live',
      player: { attributes: attrs, skills: [] },
      npcStates: [
        {
          id: 10016,
          attributes: attrs,
          skills: [],
          inventory: [],
          rawFriendliness: 70,
          visible: true,
          mapKey: 'LV_25_P',
        },
      ],
    },
  };
  const gifts = (html) => html.match(/<details class="detail-block person-gifts"[\s\S]*?<\/details>/)[0];
  let progress = project(metadata);
  assert.equal(progress.people[0].gift.status, 'met');
  assert.equal(progress.people[0].gift.minimumQuality, '金');
  const live = { origin: 'live', metadata: { quests: [] } };
  const render = (p = progress, ref = live) =>
    gifts(views.detail(index, jiang.id, 1, null, [], '', false, {}, 0, {}, '', p, ref));
  let html = render();
  assert.match(html, /金色起/);
  assert.doesNotMatch(html, /data-id="item-1003"/, 'white sword cannot be offered to affinity 70');
  const suggestedIds = [...html.matchAll(/data-action="database-detail" data-id="(item-\d+)"/g)].map(
    (m) => m[1],
  );
  assert(suggestedIds.length > 0);
  assert(
    suggestedIds.every((id) => ['金', '暗金', '红'].includes(index.entries.find((e) => e.id === id).quality)),
  );
  const goldId = Number(suggestedIds[0].slice(5));
  html = render(progress, {
    ...live,
    metadata: {
      quests: [],
      inventory: [
        { id: 1003, count: 1 },
        { id: goldId, count: 2 },
      ],
    },
  });
  assert.match(html, /背包中的偏好物品 · 1 种 · 金色起/);
  assert.match(html, /2 件/);
  metadata.combat.npcStates[0].rawFriendliness = 100;
  progress = project(metadata);
  assert.equal(progress.people[0].gift.status, 'unmet');
  assert.doesNotMatch(
    render(),
    /data-action="journey-gift-dialog"/,
    'blocked NPC does not invite a per-item gift',
  );
  html = render(null);
  assert.match(html, /符合偏好的物品/);
  assert.doesNotMatch(html, /色起|可送礼物/);
  const notice = '现场更新暂停 · 暂按最近保存显示';
  const fallback = views.detail(index, jiang.id, 1, null, [], '', false, {}, 0, {}, '', null, null, notice);
  assert.equal(fallback.split(notice).length - 1, 1);
  assert(
    fallback.indexOf(notice) < fallback.indexOf('<details'),
    'downgrade remains visible outside disclosure',
  );
});
