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

test('Yuanjue collection stays conditional until saved death, with exact private items and conservative preparation', () => {
  const projectYuanjue = createDuelProjector({ guide: curatedGuide, world, game });
  const facts = require('../src/data/npc-facts.json').people['5500'];
  const combat = {
    format: 14,
    player: {
      id: 0,
      level: 25,
      healthRatio: 0.3,
      manaRatio: 0.2,
      equipment: [],
      skills: [],
      skillPoints: 720,
      meridianPoints: 35,
    },
    opponents: [],
  };
  const before = structuredClone(combat);
  const get = (mainQuestId, states = [], available = true) =>
    projectYuanjue({ available, states, mainQuestId, combat });
  for (const stage of [5920, 5940, 9254]) {
    const row = get(stage).candidates.find((entry) => entry.id === 'npc060-yuanjue');
    assert(row, String(stage));
    assert.equal(row.personId, 'npc-5500');
    assert.equal(row.level, facts.level);
    assert.equal(row.readiness.status, 'defer');
    assert(row.readiness.checks.some((check) => check.id === 'weapon' && check.status === 'unmet'));
    assert.match(row.readiness.growth, /720.*35/);
    assert.match(row.recommendation.tradeoff, /龙爪手.*另有/);
    assert.match(row.uncertainty, /进入檀林不等于立即失效/);
    assert(row.sources.length >= 3);
    for (const reward of row.rewards) {
      assert(facts.fixedItems.some((item) => item.id === reward.itemId));
      assert.equal(game.entries.find((entry) => entry.id === 'item-' + reward.itemId)?.name, reward.name);
      assert.equal(reward.method, '切磋私物');
      assert.match(reward.probability, /不保证首胜.*概率未知/);
    }
  }
  // A Tanlin step or a still-living Yuanjue dialogue is not itself a death record.
  for (const [stage, record] of [
    [5920, 5926],
    [5940, 5947],
    [9254, 9246],
  ])
    assert(get(stage, [{ id: record, step: 1 }]).candidates.some((row) => row.id === 'npc060-yuanjue'));
  for (const boundary of [5950, 5953, 9133, 9249, 20000, 20001])
    for (const step of [1, 2, 4]) {
      const result = get(5920, [{ id: boundary, step }]);
      assert(!result.candidates.some((row) => row.id === 'npc060-yuanjue'), `${boundary}:${step}`);
      assert(result.guide.find((row) => row.id === 'npc060-yuanjue').closed);
    }
  for (const boundary of [5940, 9254])
    assert(!get(boundary, [{ id: boundary, step: 4 }]).candidates.some((row) => row.id === 'npc060-yuanjue'));
  assert(!get(20000).candidates.some((row) => row.id === 'npc060-yuanjue'));
  assert(!get(5920, [], false).candidates.some((row) => row.id === 'npc060-yuanjue'));
  assert.deepEqual(combat, before);
});

test('midgame collection follows conference, Xungu, Linchang and beggar saved windows', () => {
  const current = createDuelProjector({ guide: curatedGuide, world, game });
  const mids = (mainQuestId, states) =>
    current({ available: true, states, mainQuestId }).candidates.filter((row) =>
      row.id.startsWith('npc059-'),
    );
  const conference = [17100, 5006, 7500, 17102];
  assert.deepEqual(
    mids(5368, [{ id: 5424, step: 4 }]).map((row) => row.npcId),
    conference,
  );
  for (const step of [0, 1, 2, 3])
    assert.equal(mids(5368, [{ id: 5424, step }]).length, 0, 'winning must be saved first');
  assert.equal(
    mids(5368, [
      { id: 5424, step: 4 },
      { id: 5444, step: 1 },
    ]).length,
    4,
  );
  assert.equal(
    mids(5368, [
      { id: 5424, step: 4 },
      { id: 5444, step: 4 },
    ]).length,
    0,
  );
  assert(mids(5368, []).every((row) => row.conditions.some((condition) => condition.status === 'unknown')));

  const monastery = [
    { id: 5368, step: 4 },
    { id: 5532, step: 3 },
  ];
  assert.deepEqual(
    mids(5500, monastery).map((row) => row.npcId),
    [5501, 5502, 5503],
  );
  for (const step of [1, 2, 4])
    assert.equal(
      mids(5500, [...monastery, { id: 5509, step }]).length,
      0,
      'detour guidance retires on audience',
    );
  for (const step of [0, 1, 2, 3])
    assert.equal(
      mids(5500, [
        { id: 5368, step },
        { id: 5532, step: 3 },
      ]).length,
      0,
    );

  const afterNight = [
    { id: 5509, step: 4 },
    { id: 5532, step: 4 },
  ];
  assert.deepEqual(
    mids(5500, afterNight).map((row) => row.npcId),
    [19103],
  );
  assert.deepEqual(
    mids(5550, [...afterNight, { id: 5500, step: 4 }]).map((row) => row.npcId),
    [19103, 19510],
  );
  assert.equal(
    mids(5550, [
      { id: 5532, step: 3 },
      { id: 5500, step: 3 },
    ]).length,
    0,
  );
  assert.equal(mids(5550, [...afterNight, { id: 5500, step: 4 }, { id: 5580, step: 1 }]).length, 0);

  assert.deepEqual(
    mids(5750, [{ id: 12609, step: 4 }]).map((row) => row.npcId),
    [16017],
  );
  assert.equal(mids(5750, [{ id: 12609, step: 1 }]).length, 0);
  assert.equal(
    mids(5750, [
      { id: 12609, step: 4 },
      { id: 12661, step: 1 },
    ]).length,
    0,
  );
  assert.equal(mids(5780, []).length, 0, 'unrelated banquet should not be flooded with midgame detours');
  assert.equal(
    current({ available: false, states: [{ id: 5424, step: 4 }], mainQuestId: 5368 }).candidates.length,
    0,
  );
  const reference = current({ available: true, states: [{ id: 5444, step: 4 }], mainQuestId: 5368 }).guide;
  assert.equal(
    reference.filter((row) => row.id.startsWith('npc059-')).length,
    10,
    'retired routes remain available for reference',
  );
});

test('midgame rewards bind comparable NPC instances and current-build private items, not boss pools or teaching', () => {
  const facts = require('../src/data/npc-facts.json');
  const items = new Map(
    game.entries.filter((row) => row.id.startsWith('item-')).map((row) => [row.gameId, row]),
  );
  const current = createDuelProjector({ guide: curatedGuide, world, game })({ available: false, states: [] });
  const rows = current.guide.filter((row) => row.id.startsWith('npc059-'));
  const low = {
    format: 14,
    player: {
      id: 0,
      level: 25,
      healthRatio: 0.3,
      manaRatio: 0.2,
      equipment: [],
      skills: [],
      skillPoints: 720,
      meridianPoints: 35,
    },
    opponents: [],
  };
  const before = structuredClone(low);
  for (const row of rows) {
    const person = world.people.find((p) => p.gameId === row.npcId);
    assert(person.functions.includes('Compare'), row.name);
    assert.equal(row.level, facts.people[row.npcId].level);
    assert.equal(row.personId, 'npc-' + row.npcId);
    assert(row.sources.length >= 2);
    for (const reward of row.rewards) {
      assert.equal(reward.method, '切磋私物');
      assert.equal(items.get(reward.itemId)?.name, reward.name, 'item namespace identity must be exact');
      assert(facts.people[row.npcId].fixedItems.some((item) => item.id === reward.itemId));
      assert.match(reward.probability, /不保证首胜.*概率未知/);
    }
    const prepared = createDuelProjector({ guide: { ...curatedGuide, duels: [row] }, world, game })({
      available: true,
      states: [],
      combat: low,
    }).guide[0].readiness;
    assert.equal(prepared.status, 'defer');
    assert(prepared.checks.some((check) => check.id === 'weapon' && check.status === 'unmet'));
    assert.match(prepared.growth, /720.*35/);
    assert(prepared.opponentSkills.length > 0);
  }
  assert.deepEqual(low, before, 'preparation remains a read-only projection');
});
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
test('Pingkang guidance puts local medicine and equipment recipe leads ahead of distant masters', () => {
  const facts = require('../src/data/npc-facts.json');
  const expected = [
    ['npc057-zhanglao', 10219, 5, 100300, '下品血灵丹丹方'],
    ['npc057-ehan', 10240, 25, 100032, '虬龙拳套精良图纸'],
    ['npc057-zhangbu', 10249, 45, 100042, '银花镖精良图纸'],
    ['npc057-libu', 10250, 45, 100012, '紫铜刀精良图纸'],
  ];
  for (const mainQuestId of [5242, 5246, 5275]) {
    const result = projectCurated({ available: true, states: [], mainQuestId });
    assert.deepEqual(
      result.candidates.slice(0, 4).map((row) => row.id),
      expected.map((row) => row[0]),
    );
    for (const [id, npcId, level, itemId, name] of expected) {
      const row = result.candidates.find((entry) => entry.id === id);
      assert.equal(row.personId, `npc-${npcId}`);
      assert.equal(row.level, level);
      assert.equal(facts.people[npcId].level, level);
      assert(facts.people[npcId].fixedItems.some((item) => item.id === itemId && item.count === 1));
      assert.deepEqual(
        row.rewards.map((reward) => [reward.itemId, reward.name]),
        [[itemId, name]],
      );
      assert.equal(game.entries.find((entry) => entry.id === `item-${itemId}`).name, name);
      assert.match(row.place, /平康城/);
      assert.match(row.rewards[0].probability, /随机.*不保证首胜.*概率未知/);
      assert.equal(row.sources[0].url, 'https://steamcommunity.com/sharedfiles/filedetails/?id=3552565492');
      assert.ok(row.recommendation.action && row.recommendation.reason && row.recommendation.tradeoff);
    }
  }
  for (const mainQuestId of [undefined, 5062, 5780])
    assert(
      !projectCurated({ available: true, states: [], mainQuestId }).candidates.some((row) =>
        row.id.startsWith('npc057-'),
      ),
    );
});
test('Sunlao and Qinlie recipe leads preserve private-possession probability, exact items and distinct windows', () => {
  const project = (mainQuestId, states, available = true) =>
    projectCurated({ mainQuestId, states, available });
  const before = project(5062, [
    { id: 5063, step: 4 },
    { id: 5072, step: 1 },
  ]);
  const sun = before.candidates.find((row) => row.id === 'npc053-sunlao');
  const qin = before.candidates.find((row) => row.id === 'npc053-inn-qinlie');
  for (const [row, npcId, level, itemId, name] of [
    [sun, 10001, 5, 100329, '宁神散丹方'],
    [qin, 10023, 35, 100312, '下品烈阳丹丹方'],
  ]) {
    assert(row);
    assert.equal(row.personId, `npc-${npcId}`);
    assert.equal(row.level, level);
    assert.match(row.levelBasis, /官方Build21798996.*不是当前实战面板或胜率/);
    assert.deepEqual(
      row.rewards.map((reward) => [reward.itemId, reward.name]),
      [[itemId, name]],
    );
    assert.equal(game.entries.find((entry) => entry.id === `item-${itemId}`).name, name);
    assert.equal(row.rewards[0].method, '切磋私物');
    assert.match(row.rewards[0].probability, /随机.*不保证首胜.*概率未知/);
  }
  assert.match(sun.uncertainty, /不是取药剧情固定奖励.*未证实交酒后永久消失/);
  assert.match(qin.recommendation.tradeoff, /继承.*普通新档.*不保证首胜/);
  assert(!project(5062, [{ id: 5063, step: 1 }]).candidates.some((row) => row.id === qin.id));
  for (const boundary of [
    { id: 5072, step: 4 },
    { id: 5074, step: 1 },
  ]) {
    const later = project(5062, [{ id: 5063, step: 4 }, boundary]);
    assert(!later.candidates.some((row) => row.id === qin.id));
    assert(later.candidates.some((row) => row.id === sun.id));
  }
  for (const mainQuestId of [undefined, 5200])
    assert(
      !project(mainQuestId, [{ id: 5063, step: 4 }]).candidates.some((row) =>
        [sun.id, qin.id].includes(row.id),
      ),
    );
  const offline = project(5062, [{ id: 5063, step: 4 }], false);
  assert(!offline.candidates.some((row) => [sun.id, qin.id].includes(row.id)));
  assert(offline.guide.some((row) => row.id === sun.id));
});

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

const followthroughIds = ['npc053-chengyu', 'npc053-xiaowuyan', 'npc053-duanlvshuang'];
const followthrough = (snapshot) => {
  const projected = projectCurated({ available: true, ...snapshot });
  return {
    ...projected,
    candidates: projected.candidates.filter((row) => followthroughIds.includes(row.id)),
    guide: projected.guide.filter((row) => followthroughIds.includes(row.id)),
  };
};

test('Cheng Yu challenge follows the confirmed stay branch through promotion preparation', () => {
  for (const mainQuestId of [5820, 5850]) {
    for (const step of [0, 1, 2, 3]) {
      assert.equal(followthrough({ mainQuestId, states: [{ id: 5829, step }] }).candidates.length, 0);
    }
    const ready = followthrough({ mainQuestId, states: [{ id: 5829, step: 4 }] });
    assert.deepEqual(
      ready.candidates.map((row) => row.id),
      ['npc053-chengyu'],
    );
    assert.equal(ready.candidates[0].conditions[0].id, 'quest-5829');
    assert.equal(ready.candidates[0].conditions[0].status, 'met');
    const unknown = followthrough({ mainQuestId, states: [] });
    assert.deepEqual(
      unknown.candidates.map((row) => row.id),
      ['npc053-chengyu'],
    );
    assert.equal(unknown.candidates[0].conditions[0].status, 'unknown');
    assert.match(unknown.candidates[0].confidence, /前置仍待核对/);
  }
});

test('Cheng Yu leave branch and the southern journey retire the lead but keep its reference', () => {
  for (const id of [5831, 5860]) {
    for (const step of [1, 2, 4]) {
      const later = followthrough({
        mainQuestId: 5850,
        states: [
          { id: 5829, step: 4 },
          { id, step },
        ],
      });
      assert.equal(later.candidates.length, 0);
      const cheng = later.guide.find((row) => row.id === 'npc053-chengyu');
      assert.equal(cheng.closed, true);
      assert.match(cheng.uncertainty, /不声称.*永久失去/);
    }
  }
  const nextStage = followthrough({ mainQuestId: 5860, states: [{ id: 5829, step: 4 }] });
  assert.equal(nextStage.candidates.length, 0);
  assert.equal(nextStage.guide.find((row) => row.id === 'npc053-chengyu').stageMatch, false);
});

test('Changsheng challenges wait for the mountain gate aftermath and remain during the return task', () => {
  for (const step of [0, 1, 2, 3]) {
    assert.equal(followthrough({ mainQuestId: 8830, states: [{ id: 8875, step }] }).candidates.length, 0);
  }
  for (const step of [0, 1, 2, 3]) {
    const during = followthrough({
      mainQuestId: 8830,
      states: [
        { id: 8875, step: 4 },
        { id: 8879, step },
      ],
    });
    assert.deepEqual(
      during.candidates.map((row) => row.id),
      followthroughIds.slice(1),
    );
    for (const row of during.candidates) {
      assert.equal(row.conditions[0].id, 'quest-8875');
      assert.equal(row.conditions[0].status, 'met');
      assert.equal(row.closed, false);
    }
  }
  const returned = followthrough({
    mainQuestId: 8830,
    states: [
      { id: 8875, step: 4 },
      { id: 8879, step: 4 },
    ],
  });
  assert.equal(returned.candidates.length, 0);
  for (const row of returned.guide.filter((entry) => entry.id !== 'npc053-chengyu')) {
    assert.equal(row.closed, true);
    assert.match(row.uncertainty, /不声称永久失去/);
  }
});

test('followthrough leads keep absent prerequisites uncertain, require their stage and read inputs only', () => {
  const unknown = followthrough({ mainQuestId: 8830, states: [] });
  assert.deepEqual(
    unknown.candidates.map((row) => row.id),
    followthroughIds.slice(1),
  );
  for (const row of unknown.candidates) {
    assert.equal(row.conditions[0].status, 'unknown');
    assert.match(row.confidence, /前置仍待核对/);
    assert.match(row.preparation, /尚未读取玩家实时面板/);
  }
  for (const mainQuestId of [undefined, 5780, 8810, 8900]) {
    assert.equal(
      followthrough({
        mainQuestId,
        states: [
          { id: 5829, step: 4 },
          { id: 8875, step: 4 },
        ],
      }).candidates.length,
      0,
    );
  }
  for (const mainQuestId of [5820, 5850, 8830]) {
    const input = {
      available: true,
      mainQuestId,
      difficultyName: '极难',
      states: [
        { id: 5829, step: 4 },
        { id: 8875, step: 4 },
        { id: 8879, step: 1 },
      ],
    };
    const before = structuredClone(input);
    for (const row of input.states) Object.freeze(row);
    Object.freeze(input.states);
    Object.freeze(input);
    const ready = followthrough(input);
    assert.equal(ready.difficultyName, '极难');
    assert.match(ready.combatLimit, /静态等级不能直接换算胜率/);
    assert.deepEqual(input, before);
    const offline = followthrough({ ...input, available: false });
    assert.equal(offline.candidates.length, 0);
    assert.equal(offline.guide.length, 3);
  }
});

test('followthrough rewards link verified items and separate dialogue from random private possessions', () => {
  const rows = followthrough({ states: [] }).guide;
  const expected = [
    [
      'npc053-chengyu',
      5037,
      40,
      [
        ['清蒸赤鳞鱼菜谱', 100245],
        ['凤凰金瓶', 10176],
      ],
      '37',
    ],
    [
      'npc053-xiaowuyan',
      19702,
      85,
      [
        ['丙火丹', 117],
        ['壬水丹', 119],
      ],
      '48',
    ],
    ['npc053-duanlvshuang', 19703, 65, [['乙木丹', 114]], '48'],
  ];
  for (const [id, npcId, level, rewards, page] of expected) {
    const row = rows.find((entry) => entry.id === id);
    assert.equal(row.personId, `npc-${npcId}`);
    assert.equal(row.npcId, npcId);
    assert.equal(row.level, level);
    assert.match(row.levelBasis, /官方Build21798996.*同构建.*不是当前实战面板或胜率/);
    assert.deepEqual(
      row.rewards.map((reward) => [reward.name, reward.itemId]),
      rewards,
    );
    for (const reward of row.rewards) {
      assert.equal(reward.method, '切磋私物');
      assert.match(reward.condition, /官方ItemList模板为1/);
      assert.match(reward.probability, /随机.*不保证首胜.*概率未知/);
      assert.equal(
        game.entries.find((item) => item.kind === '物品' && item.gameId === reward.itemId)?.name,
        reward.name,
      );
    }
    assert.equal(row.sources.length, id === 'npc053-chengyu' ? 2 : 1);
    assert.equal(row.sources[0].url, `https://www.gamersky.com/handbook/202608/2188490_${page}.shtml`);
    assert.equal(row.sources[0].author, '力拔山兮气盖世呐');
    assert.match(row.sources[0].version, /ver1.24.25/);
    assert.ok(
      row.place && row.recommendation.action && row.recommendation.reason && row.recommendation.tradeoff,
    );
  }
  assert.match(rows[0].recommendation.tradeoff, /一气纯阳指秘籍来自对话/);
  assert.match(rows[1].uncertainty, /切磋写萧无颜.*对话写萧无言/);
  assert.match(rows[1].recommendation.tradeoff, /芙蓉金冠精良图纸不是本条切磋收益/);
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
  assert.doesNotMatch(summary, /先修炼内功/);
  assert.match(summary, /data-action="database-detail"/);
  assert.match(html, /前置记录仍待核对，不能据此认定现在可以挑战/);
  assert.match(html, /data-persist-detail="duel-card-first-inn-window"/);
  assert.match(html, /data-persist-detail="duel-info-first-inn-window"/);
  assert.match(views.page({ duels }, { compact: true, scope: 'second' }), /duel-card-second-inn-window/);
  assert.doesNotMatch(views.page({ duels }), /duel-compact-card/);
});
