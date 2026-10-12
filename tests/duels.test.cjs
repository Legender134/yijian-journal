'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDuelProjector } = require('../src/core/duels.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const curatedGuide = require('../src/data/duel-guide.cjs');
const guide = {
  sources: { community: { title: 'Synthetic source', url: 'https://example.com' } },
  duels: [
    {
      id: 'inn-window',
      npcId: 10029,
      chapterRoots: [5062],
      afterAllComplete: [5063],
      untilAnyComplete: [5072],
      rewards: [{ name: 'Synthetic reward', method: '切磋私物' }],
      sourceIds: ['community'],
    },
  ],
};
const project = createDuelProjector({ guide, world, game });
test('challenge leads keep the return-for-wine window open until actual hand-in completion', () => {
  const states = [
    { id: 5063, step: 4 },
    { id: 5072, step: 1 },
  ];
  const before = structuredClone(states);
  const ready = project({ available: true, states, mainQuestId: 5062, difficultyName: '极难' });
  assert.equal(ready.candidates.length, 1);
  assert.equal(ready.candidates[0].personId, 'npc-10029');
  assert.equal(ready.candidates[0].conditions[0].status, 'met');
  assert.equal(ready.difficultyName, '极难');
  assert.match(ready.combatLimit, /不能直接换算胜率/);
  assert.equal(ready.candidates[0].sources[0].id, 'flow:community');
  assert.deepEqual(states, before);
  assert.equal(
    project({
      available: true,
      states: [
        { id: 5063, step: 4 },
        { id: 5072, step: 4 },
      ],
      mainQuestId: 5062,
    }).candidates.length,
    0,
  );
  for (const step of [0, 2, 3])
    assert.equal(
      project({
        available: true,
        states: [
          { id: 5063, step: 4 },
          { id: 5072, step },
        ],
        mainQuestId: 5062,
      }).candidates.length,
      1,
    );
});
test('challenge candidates require a recognized stage and do not turn unknown conditions into proof', () => {
  const unknown = project({ available: true, states: [], mainQuestId: 5062 });
  assert.equal(unknown.candidates.length, 1);
  assert.equal(unknown.candidates[0].conditions[0].status, 'unknown');
  assert.match(unknown.candidates[0].confidence, /待核对/);
  assert.equal(
    project({ available: true, states: [{ id: 5063, step: 1 }], mainQuestId: 5062 }).candidates.length,
    0,
  );
  for (const mainQuestId of [undefined, 5200])
    assert.equal(
      project({ available: true, states: [{ id: 5063, step: 4 }], mainQuestId }).candidates.length,
      0,
    );
  const offline = project({ available: false, states: [{ id: 5063, step: 4 }], mainQuestId: 5062 });
  assert.equal(offline.candidates.length, 0);
  assert.equal(offline.guide.length, 1);
  assert.match(offline.reason, /全部/);
});

const projectCurated = createDuelProjector({ guide: curatedGuide, world, game });
const tianshui = (states, options = {}) =>
  projectCurated({ available: true, states, mainQuestId: 5780, ...options });

test('Tianshui morning challenge opens after the night dialogue and retires on seating or pursuit', () => {
  for (const step of [0, 1, 2, 3]) {
    const before = tianshui([
      { id: 5789, step },
      { id: 5803, step: 0 },
    ]);
    assert.equal(before.candidates.length, 0);
  }
  const states = [
    { id: 5789, step: 4 },
    { id: 5790, step: 1 },
    { id: 5803, step: 0 },
  ];
  const before = structuredClone(states);
  const morning = tianshui(states, { difficultyName: '极难' });
  assert.deepEqual(
    morning.candidates.map((row) => row.id),
    ['npc052-zhidu'],
  );
  assert.equal(morning.candidates[0].personId, 'npc-16022');
  assert.equal(morning.candidates[0].conditions[0].status, 'met');
  assert.equal(morning.difficultyName, '极难');
  assert.deepEqual(states, before);
  for (const boundary of [{ id: 5790, step: 4 }, ...[1, 2, 4].map((step) => ({ id: 5801, step }))]) {
    const later = tianshui([{ id: 5789, step: 4 }, { id: 5803, step: 0 }, boundary]);
    assert.equal(later.candidates.length, 0);
    const row = later.guide.find((entry) => entry.id === 'npc052-zhidu');
    assert.equal(row.closed, true);
    assert.match(row.uncertainty, /不声称.*永久消失/);
  }
});

test('Tianshui road challenge requires the wall pursuit and retires at the next route steps', () => {
  for (const step of [0, 1, 2, 3]) {
    assert.equal(
      tianshui([
        { id: 5790, step: 4 },
        { id: 5803, step },
      ]).candidates.length,
      0,
    );
  }
  for (const step of [0, 1, 2, 3]) {
    const road = tianshui([
      { id: 5790, step: 4 },
      { id: 5803, step: 4 },
      { id: 5806, step },
    ]);
    assert.deepEqual(
      road.candidates.map((row) => row.id),
      ['npc052-tianshui-guard'],
    );
    const guard = road.candidates[0];
    assert.equal(guard.name, '天水守卫');
    assert.equal(guard.personId, null);
    assert.equal(guard.npcId, null);
    assert.equal(guard.level, null);
    assert.equal(guard.conditions[0].status, 'met');
    assert.match(guard.uncertainty, /尚不能确定/);
  }
  for (const boundary of [{ id: 5806, step: 4 }, ...[1, 2, 4].map((step) => ({ id: 5810, step }))]) {
    const later = tianshui([{ id: 5790, step: 4 }, { id: 5803, step: 4 }, boundary]);
    assert.equal(later.candidates.length, 0);
    const guard = later.guide.find((row) => row.id === 'npc052-tianshui-guard');
    assert.equal(guard.closed, true);
    assert.match(guard.uncertainty, /不声称.*永久失去/);
  }
});

test('Tianshui missing prerequisites remain uncertain and a chapter name is not proof of readiness', () => {
  const unknown = tianshui([]);
  assert.deepEqual(
    unknown.candidates.map((row) => row.id),
    ['npc052-zhidu', 'npc052-tianshui-guard'],
  );
  for (const row of unknown.candidates) {
    assert.equal(row.conditions[0].status, 'unknown');
    assert.match(row.confidence, /前置仍待核对/);
    assert.match(row.preparation, /尚未读取玩家实时面板/);
  }
  assert.match(unknown.combatLimit, /静态等级不能直接换算胜率/);
  for (const mainQuestId of [undefined, 5760, 5813]) {
    assert.equal(
      tianshui(
        [
          { id: 5789, step: 4 },
          { id: 5803, step: 4 },
        ],
        { mainQuestId },
      ).candidates.length,
      0,
    );
  }
  const offline = tianshui(
    [
      { id: 5789, step: 4 },
      { id: 5803, step: 4 },
    ],
    { available: false },
  );
  assert.equal(offline.candidates.length, 0);
  assert.equal(offline.guide.filter((row) => row.id.startsWith('npc052-')).length, 2);
});

test('Tianshui reward facts distinguish community leads and the official static template', () => {
  const [zhidu, guard] = tianshui([]).candidates;
  const communityUrl = 'https://www.gamersky.com/handbook/202608/2188490_37.shtml';
  assert.equal(zhidu.level, 60);
  assert.match(zhidu.levelBasis, /官方Build21798996.*同构建.*不是当前实战面板或胜率/);
  assert.deepEqual(
    zhidu.rewards.map((row) => [row.name, row.itemId]),
    [
      ['三转洗髓丹', 141],
      ['没药', 10315],
    ],
  );
  assert.deepEqual(
    guard.rewards.map((row) => [row.name, row.itemId]),
    [['一转洗髓丹', 139]],
  );
  for (const row of [zhidu, guard]) {
    for (const reward of row.rewards) {
      assert.equal(reward.method, '切磋私物');
      assert.match(reward.probability, /随机.*不保证首胜.*概率未知/);
    }
    assert.equal(row.sources[0].id, 'flow:npc052Tianshui');
    assert.equal(row.sources[0].url, communityUrl);
    assert.equal(row.sources[0].author, '力拔山兮气盖世呐');
    assert.match(row.sources[0].version, /ver1.24.25/);
    assert.equal(row.sources.length, 1);
  }
});

test('compact challenge summaries expose names, places and rewards with stable per-profile reading state', async () => {
  const { createDuelViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/duel-views.js')).href
  );
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const views = createDuelViews({
    esc,
    pill: esc,
    act: (action, title, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${title}</button>`,
  });
  const duels = project({ available: true, states: [], mainQuestId: 5062 });
  duels.candidates[0].place = '梧桐村客栈二楼';
  duels.candidates[0].level = 30;
  duels.candidates[0].preparation = '先修炼内功';
  const html = views.page({ duels, reference: { name: 'Synthetic.sav' } }, { compact: true, scope: 'first' });
  const summary = html.slice(
    html.indexOf('class="duel-card'),
    html.indexOf('</summary>', html.indexOf('class="duel-card')),
  );
  assert.match(summary, /吕轻祈.*静态等级 30.*客栈二楼.*Synthetic reward.*切磋私物/s);
  assert.doesNotMatch(summary, /先修炼内功|data-action="database-detail"/);
  assert.match(html, /前置记录仍待核对，不能据此认定现在可以挑战/);
  assert.match(html, /data-persist-detail="duel-card-first-inn-window"/);
  assert.match(html, /data-persist-detail="duel-info-first-inn-window"/);
  assert.match(views.page({ duels }, { compact: true, scope: 'second' }), /duel-card-second-inn-window/);
  assert.doesNotMatch(views.page({ duels }), /duel-compact-card/);
});
