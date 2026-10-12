'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot, createFlowProjector } = require('../src/core/flow.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { defaults } = require('../src/core/store.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const guide = require('../src/data/flow-guide.cjs');
const materialGuide = require('../src/data/material-guide.cjs');
const catalog = require('../src/data/catalog.cjs');
const profile = (extra = {}) => ({ id: 'flow', referenceMode: 'latest', ...extra });
const ref = (quests, extra = {}, name = 'Synthetic.sav') => ({
  name,
  hash: 'synthetic',
  modifiedAt: '2026-10-11T00:00:00Z',
  metadata: { quests, inventory: [], ...extra },
});

test('Changsheng rescue advice leads before departure, bridges battle branches and retires on saved outcomes', () => {
  const id = 'changsheng-rescue-choice';
  const root = { id: 8830, step: 1 };
  const snapshot = (records, scoped = profile()) => {
    const metadata = enrich(
      readMetadata(
        syntheticSave({
          full: true,
          trackingMainQuest: 8830,
          quests: records,
        }),
        { details: true },
      ),
    );
    const reference = ref(metadata.quests, metadata);
    return { flow: flowSnapshot(scoped, reference), reference };
  };
  for (const stepId of [8831, 8843, 8847, 8848, 8851, 8852, 8855, 8856, 8857, 8858, 8904]) {
    const records = [root, { id: stepId, step: 1 }];
    const before = structuredClone(records);
    const current = snapshot(records);
    const choice = current.flow.decisions.find((row) => row.id === id);
    assert(choice, String(stepId));
    assert.match(choice.recommendation.action, /另存.*出手相救/);
    assert.match(choice.recommendation.tradeoff, /好感.*不保证/);
    assert(choice.choices.some((row) => /不救/.test(row.label) && /油尽灯枯.*回读/.test(row.effect)));
    assert.equal(choice.sources.length, 2);
    const compact = companionSnapshot(defaults(), catalog, current.reference);
    assert.equal(compact.hints[0].type, 'flow-choice');
    assert.match(compact.hints[0].title, /长生殿.*先另存/);
    assert.deepEqual(records, before);
  }
  // Each combat variant can be the last saved step before the unnamed choice.
  for (const stepId of [8843, 8847, 8848, 8851, 8852, 8855, 8856, 8857, 8858, 8904])
    assert(snapshot([root, { id: stepId, step: 4 }]).flow.decisions.some((row) => row.id === id));
  for (const outcome of [8865, 8866, 8869, 8875, 8879, 5920, 5940, 9254]) {
    for (const step of [1, 2, 4]) {
      const current = snapshot([root, { id: 8855, step: 4 }, { id: outcome, step }]);
      for (const channel of ['decisions', 'warnings', 'advice', 'changes', 'opportunities'])
        assert(!current.flow[channel].some((row) => row.id === id), `${channel}:${outcome}:${step}`);
      assert(
        !companionSnapshot(defaults(), catalog, current.reference).hints.some(
          (row) => row.type === 'flow-choice' && /长生殿/.test(row.title),
        ),
      );
      if ([8865, 8866, 8869].includes(outcome)) {
        const saved = current.flow.active.find((row) => row.gameId === 8830).progress;
        assert(saved.some((row) => row.id === `quest-${outcome}`));
        assert(
          !saved.some((row) =>
            [8865, 8866, 8869].filter((n) => n !== outcome).includes(Number(row.id.replace('quest-', ''))),
          ),
          'do not invent another outcome from a same-name record',
        );
      }
    }
  }
  for (const records of [
    [],
    [root],
    [root, { id: 8843, step: 3 }],
    [
      { id: 8830, step: 4 },
      { id: 8855, step: 1 },
    ],
    [
      { id: 8830, step: 2 },
      { id: 8855, step: 1 },
    ],
  ])
    assert(!snapshot(records).flow.decisions.some((row) => row.id === id));
  for (const scoped of [
    profile({ referenceMode: 'none' }),
    profile({ referenceMode: 'slot', saveSlot: 'Other.sav' }),
  ])
    assert(!snapshot([root, { id: 8843, step: 1 }], scoped).flow.decisions.some((row) => row.id === id));
});

test('Tanlin preflight names Yuanjue interaction risk and retires without reporting unique-item loss', () => {
  const id = 'npc060-before-tanlin-yuanjue';
  const records = [
    { id: 5920, step: 1 },
    { id: 5921, step: 4 },
    { id: 5926, step: 1 },
  ];
  const reference = (quests) => {
    const metadata = enrich(
      readMetadata(syntheticSave({ full: true, trackingMainQuest: 5920, quests }), { details: true }),
    );
    return ref(metadata.quests, metadata);
  };
  const before = structuredClone(records);
  const snapshot = flowSnapshot(profile(), reference(records));
  const warning = snapshot.warnings.find((row) => row.id === id);
  assert(warning);
  assert.equal(warning.pickup.personIds[0], 'npc-5500');
  assert.match(warning.message, /少林寺.*切磋.*请教/);
  assert.match(warning.message, /不是进入檀林立刻失效/);
  const effect = snapshot.changes.find((row) => row.id === id).affectedTasks[0];
  assert.match(effect.name, /圆觉/);
  assert.match(effect.effect, /直接交互.*结束.*不代表秘籍永久绝版/);
  assert.equal(warning.sources.length, 3);
  assert(snapshot.duels.candidates.some((row) => row.npcId === 5500));
  assert(
    companionSnapshot(defaults(), catalog, reference(records)).hints.some((row) => /圆觉/.test(row.title)),
  );
  for (const boundary of [5940, 9254, 5950, 5953, 9133, 9249, 20000, 20001])
    for (const step of [1, 2, 4]) {
      const after = flowSnapshot(profile(), reference([...records, { id: boundary, step }]));
      for (const channel of ['warnings', 'changes', 'advice', 'opportunities'])
        assert(!after[channel].some((row) => row.id === id), `${channel}:${boundary}:${step}`);
    }
  assert(!flowSnapshot(profile(), reference([{ id: 5920, step: 4 }])).warnings.some((row) => row.id === id));
  assert(
    !flowSnapshot(profile({ referenceMode: 'none' }), reference(records)).warnings.some(
      (row) => row.id === id,
    ),
  );
  assert(
    !flowSnapshot(
      profile({ referenceMode: 'slot', saveSlot: 'Other.sav' }),
      reference(records),
    ).warnings.some((row) => row.id === id),
  );
  assert.deepEqual(records, before);
});

test('conference rest warning names the relocated NPC collection window and retires only after saved rest', () => {
  const id = 'npc059-conference-collection';
  const records = [
    { id: 5368, step: 1 },
    { id: 5424, step: 4 },
    { id: 5444, step: 1 },
  ];
  const project = (quests) => flowSnapshot(profile(), ref(quests, { trackingMainQuest: 5368 }));
  const before = structuredClone(records);
  const warning = project(records).warnings.find((row) => row.id === id);
  assert(warning);
  assert.match(warning.affectedTasks[0].name, /左江龙.*刘雄/);
  assert.match(warning.affectedTasks[0].effect, /移离名剑山庄.*犀皮兽纹甲.*承影剑/);
  assert.match(warning.uncertainty, /不会.*任务失败/);
  assert.equal(
    project([
      { id: 5368, step: 1 },
      { id: 5424, step: 1 },
    ]).warnings.some((row) => row.id === id),
    false,
  );
  const after = project([
    { id: 5368, step: 1 },
    { id: 5424, step: 4 },
    { id: 5444, step: 4 },
  ]);
  assert.equal(
    after.warnings.some((row) => row.id === id),
    false,
  );
  assert(after.guide.find((row) => row.id === id).deadlineReached);
  assert.equal(
    flowSnapshot(profile(), ref(records, { trackingMainQuest: 5780 })).warnings.some((row) => row.id === id),
    false,
  );
  assert.deepEqual(records, before);
});

test('optional pre-banquet island detour retires after seating or sparse saved pursuit records', () => {
  const project = (records) => flowSnapshot(profile(), ref(records, { trackingMainQuest: 5780 }));
  const main = { id: 5780, step: 1 };
  const id = 'mowen-island-window';
  for (const step of [0, 1, 2, 3])
    assert(project([main, { id: 5790, step }]).advice.some((row) => row.id === id));
  for (const boundary of [
    { id: 5790, step: 4 },
    ...[5801, 5803, 5806, 5810].flatMap((id) => [1, 2, 4].map((step) => ({ id, step }))),
  ]) {
    const records = [main, boundary];
    const before = structuredClone(records);
    const result = project(records);
    assert(!result.advice.some((row) => row.id === id), `${boundary.id}:${boundary.step}`);
    const reference = result.guide.find((row) => row.id === id);
    assert(reference.deadlineReached);
    assert.match(reference.uncertainty, /全部攻略回看.*不据此判定.*永久错过/);
    assert.deepEqual(records, before);
  }
});

test('Ganquan investigation advice opens at the departure step and retires on rescue or any arrival branch', () => {
  const id = 'ganquan-prison-before-yixiantian';
  const active = [
    { id: 13000, step: 1 },
    { id: 13001, step: 1 },
  ];
  const choice = (records) => flowSnapshot(profile(), ref(records)).decisions.find((row) => row.id === id);
  const before = structuredClone(active);
  const prompt = choice(active);
  assert(prompt);
  assert.equal(prompt.questId, 13000);
  assert.match(prompt.recommendation.action, /牢房.*卧秋山.*安置.*一线天/);
  assert.match(prompt.recommendation.tradeoff, /万彪.*牺牲/);
  assert.match(prompt.steps.join(' '), /冷鹰.*兆成.*甘泉村.*裴庆/);
  assert.match(prompt.choices[1].effect, /兆成死亡.*不同.*庆功宴/);
  assert(choice([...active, { id: 12935, step: 1 }, { id: 12936, step: 1 }]));
  assert.deepEqual(active, before);
  for (const record of [
    { id: 13001, step: 4 },
    { id: 13002, step: 4 },
    { id: 12935, step: 4 },
    { id: 12939, step: 4 },
    ...[13005, 13006, 13025, 13026, 13044, 13045, 13046].flatMap((id) =>
      [1, 2, 4].map((step) => ({ id, step })),
    ),
  ])
    assert(!choice([...active, record]), `departure/rescue boundary ${record.id}:${record.step}`);
  for (const records of [
    [],
    [{ id: 13000, step: 1 }],
    [
      { id: 13000, step: 1 },
      { id: 13001, step: 3 },
    ],
    ...[2, 3, 4].map((step) => [
      { id: 13000, step },
      { id: 13001, step: 1 },
    ]),
  ])
    assert(!choice(records));
});

test('Ganquan investigation advice retires when Guiying fails while the departure remains active', () => {
  const id = 'ganquan-prison-before-yixiantian';
  const active = [
    { id: 13000, step: 1 },
    { id: 13001, step: 1 },
  ];
  assert(
    flowSnapshot(profile(), ref([...active, { id: 12935, step: 1 }])).decisions.some((row) => row.id === id),
  );
  const snapshot = flowSnapshot(profile(), ref([...active, { id: 12935, step: 2 }]));
  for (const key of ['decisions', 'warnings', 'changes', 'advice', 'opportunities'])
    assert(!snapshot[key].some((row) => row.id === id), `failed rescue should retire ${key}`);
});

test('Mowen gift advice covers Moqi and the verified unnamed choice window, then stops at every gift branch', () => {
  const id = 'mowen-thankyou-gift-choice';
  const root = { id: 12400, step: 1 };
  const choice = (records) => flowSnapshot(profile(), ref(records)).decisions.find((row) => row.id === id);
  for (const records of [
    [root, { id: 12404, step: 1 }],
    [root, { id: 12401, step: 4 }, { id: 12406, step: 1 }],
    [root, { id: 12401, step: 4 }],
  ]) {
    const prompt = choice(records);
    assert(prompt);
    assert.match(prompt.recommendation.action, /棋盘.*程家村.*陆博枭/);
    assert.match(prompt.recommendation.tradeoff, /3000.*六博.*战斗.*不能保证/);
    assert.match(prompt.choices[0].effect, /好感\+20/);
    assert.match(prompt.choices[1].effect, /好感\+10.*白光剑/);
    assert.match(prompt.choices[2].effect, /不加.*好感.*花坞茶.*双井茶.*阳羡茶/);
    assert.match(prompt.uncertainty, /不把仅问过莫弃当作三人都已问完/);
  }
  const imminent = [root, { id: 12401, step: 4 }, { id: 12404, step: 1 }];
  for (const id of [
    12407, 12408, 12409, 12410, 12411, 12412, 12413, 12414, 12415, 12416, 12417, 12418, 12419, 12420, 12421,
    12422,
  ]) {
    for (const step of [1, 2, 4]) assert(!choice([...imminent, { id, step }]), `gift branch ${id}:${step}`);
  }
  assert(!choice([...imminent, { id: 12406, step: 4 }]));
  for (const records of [
    [root],
    [root, { id: 12401, step: 1 }, { id: 12402, step: 4 }],
    [root, { id: 12404, step: 4 }],
    ...[2, 3, 4].map((step) => [
      { id: 12400, step },
      { id: 12404, step: 1 },
      { id: 12401, step: 4 },
    ]),
  ])
    assert(!choice(records));
});

test('Caged Bird warns before the fight, keeps pre-fight dialogue separate from death, and retires at escape or hidden closure', () => {
  const id = 'nightcat-before-caged-bird';
  const root = { id: 12685, step: 1 };
  const project = (records) => flowSnapshot(profile(), ref(records));
  const warning = (records) => project(records).warnings.find((row) => row.id === id);
  const prompt = warning([root]);
  assert(prompt);
  assert.deepEqual(
    prompt.affectedTasks.map((row) => row.questId),
    [11885, 12310, 11405],
  );
  assert.match(prompt.warning, /1\.24\.31.*夜猫子身亡.*画舫旧事.*烟霞剑客.*旧比武招亲/);
  assert.match(prompt.affectedTasks[2].effect, /不把武家旧事.*一并/);
  assert.match(prompt.uncertainty, /已接任务.*交付.*待核对.*不单独当作人物死亡证明/);
  for (const id of [12686, 12687]) {
    assert(warning([root, { id, step: 1 }]));
    assert(warning([root, { id, step: 4 }]));
  }
  for (const id of [12688, 12689, 12693]) {
    for (const step of [1, 2, 4]) {
      const later = project([root, { id, step }]);
      assert(!later.warnings.some((row) => row.id === prompt.id));
      assert(!later.changes.some((row) => row.id === prompt.id));
    }
  }
  for (const step of [2, 3, 4])
    assert(
      !warning([
        { id: 12685, step },
        { id: 12686, step: 1 },
      ]),
    );
  assert(!warning([]));
  const alreadyFinished = warning([root, { id: 11885, step: 4 }, { id: 11405, step: 2 }]);
  assert.deepEqual(
    alreadyFinished.affectedTasks.map((row) => row.questId),
    [12310],
  );
  const accepted = warning([root, { id: 11885, step: 1 }]);
  assert.match(accepted.affectedTasks[0].effect, /已有进行中记录.*没有证明.*失败/);
});

test('new side-story prompts use only the selected reference and retain versioned evidence as offline guide material', () => {
  const ids = [
    'ganquan-prison-before-yixiantian',
    'mowen-thankyou-gift-choice',
    'nightcat-before-caged-bird',
  ];
  const records = [
    { id: 13000, step: 1 },
    { id: 13001, step: 1 },
    { id: 12400, step: 1 },
    { id: 12404, step: 1 },
    { id: 12685, step: 1 },
  ];
  const alternate = ref(records, {}, '1.sav');
  for (const [selectedProfile, reference] of [
    [profile({ referenceMode: 'none' }), alternate],
    [profile({ referenceMode: 'slot', saveSlot: '0.sav' }), alternate],
    [profile(), null],
  ]) {
    const flow = flowSnapshot(selectedProfile, reference);
    assert.equal(flow.available, false);
    for (const key of ['decisions', 'warnings', 'advice', 'changes'])
      assert(!flow[key].some((row) => ids.includes(row.id)), key);
    for (const id of ids) assert(flow.guide.some((row) => row.id === id));
  }
  const rule = guide.rules.find((row) => row.id === ids[1]);
  const authors = new Set(rule.sourceIds.map((id) => guide.sources[id].author).filter(Boolean));
  assert(authors.has('虚饮茶'));
  assert(authors.has('无敌大白熊丶'));
  const fixed = guide.sources.flow053MowenChoice;
  assert.match(fixed.url, /oldid=61152/);
  const sparse = flowSnapshot(
    profile(),
    ref([
      { id: 13000, step: 1 },
      { id: 12400, step: 1 },
    ]),
  );
  for (const key of ['decisions', 'warnings', 'changes', 'advice', 'opportunities'])
    assert(!sparse[key].some((row) => ids.slice(0, 2).includes(row.id)), key);
  const recipeReference = ref(
    [
      { id: 5062, step: 1 },
      { id: 5063, step: 4 },
      { id: 5072, step: 1 },
    ],
    { trackingMainQuest: 5062 },
  );
  const recipeIds = ['npc053-sunlao', 'npc053-inn-qinlie'];
  const ready = flowSnapshot(profile(), recipeReference);
  for (const id of recipeIds) assert(ready.duels.candidates.some((row) => row.id === id));
  for (const selectedProfile of [
    profile({ referenceMode: 'none' }),
    profile({ referenceMode: 'slot', saveSlot: '0.sav' }),
  ])
    assert(
      !flowSnapshot(selectedProfile, recipeReference).duels.candidates.some((row) =>
        recipeIds.includes(row.id),
      ),
    );
  for (const step of [2, 3, 4]) {
    const closed = ref(
      [
        { id: 5062, step },
        { id: 5063, step: 4 },
        { id: 5072, step: 1 },
      ],
      { trackingMainQuest: 5062 },
    );
    assert(!flowSnapshot(profile(), closed).duels.candidates.some((row) => recipeIds.includes(row.id)));
  }
});

test('wine delivery names the optional inn challenge window and retires when delivered', () => {
  const project = (step, extra = []) =>
    flowSnapshot(
      profile(),
      ref([{ id: 5062, step: 1 }, { id: 5063, step: 4 }, { id: 5072, step }, ...extra], {
        trackingMainQuest: 5062,
      }),
    );
  const before = project(1);
  const warning = before.warnings.find((row) => row.id === 'inn-before-delivering-wine');
  assert(warning);
  assert.match(warning.affectedTasks[0].name, /吕轻祈.*雷万钧.*岳九/);
  assert.match(warning.recommendation.tradeoff, /高成本.*不必.*不保证/);
  assert.equal(before.chapter.next.questId, 'quest-5072');
  assert(!before.opportunities.some((row) => row.id === warning.id));
  assert(!project(4).warnings.some((row) => row.id === warning.id));
  assert(
    !flowSnapshot(profile(), ref([{ id: 5062, step: 1 }])).warnings.some((row) => row.id === warning.id),
  );
});

test('Tianshui reminders follow the banquet and pursuit substeps rather than the entire chapter', () => {
  const project = (steps) =>
    flowSnapshot(profile(), ref([{ id: 5780, step: 1 }, ...steps], { trackingMainQuest: 5780 }));
  const banquet = project([
    { id: 5789, step: 4 },
    { id: 5790, step: 1 },
  ]);
  assert(
    banquet.warnings.some(
      (row) => row.id === 'tianshui-before-banquet-duel' && /智度上人/.test(row.affectedTasks[0].name),
    ),
  );
  for (const crossed of [[{ id: 5790, step: 4 }], [{ id: 5801, step: 1 }]]) {
    assert(
      !project([{ id: 5789, step: 4 }, ...crossed]).warnings.some(
        (row) => row.id === 'tianshui-before-banquet-duel',
      ),
    );
  }
  const journey = project([
    { id: 5803, step: 4 },
    { id: 5806, step: 1 },
  ]);
  assert(journey.warnings.some((row) => row.id === 'tianshui-before-yixiantian-duel'));
  assert(!journey.warnings.some((row) => row.id === 'tianshui-before-banquet-duel'));
  assert(
    !project([
      { id: 5803, step: 4 },
      { id: 5806, step: 4 },
    ]).warnings.some((row) => row.id === 'tianshui-before-yixiantian-duel'),
  );
  assert(!project([]).warnings.some((row) => row.id.startsWith('tianshui-before-')));
});

test('village pickup clues do not send players to the objective destination to accept the task', () => {
  const flow = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5062, step: 1 },
        { id: 5039, step: 4 },
      ],
      { trackingMainQuest: 5062 },
    ),
  );
  const snake = flow.opportunities.find((row) => row.questId === 11000);
  assert.match(snake.pickup.place, /梧桐村/);
  assert.doesNotMatch(snake.pickup.place, /山洞/);
  assert.match(snake.pickup.person, /李村长/);
  assert.match(snake.pickup.action, /交谈.*无妄蛇灾/);
  assert.match(snake.pickup.executionPlace, /山洞/);
  const tailor = flow.opportunities.find((row) => row.questId === 11052);
  assert.match(tailor.pickup.place, /梧桐村/);
  assert.match(tailor.pickup.person, /薛氏/);
  assert(tailor.sources.length);
});

test('mining puts the exact task route before distant merchants and retires the resolved axe recommendation', () => {
  const flow = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5062, step: 1 },
        { id: 11002, step: 1 },
        { id: 11005, step: 4 },
        { id: 11010, step: 1 },
      ],
      { trackingMainQuest: 5062, mapName: '梧桐村' },
    ),
  );
  const iron = flow.active.find((row) => row.gameId === 11002).steps.find((row) => row.id === 'quest-11010')
    .materials[0];
  assert.equal(iron.routes[0].kind, 'quest');
  assert.match(iron.routes[0].detail, /后山山洞.*四个铁矿石/);
  assert.equal(iron.routes[0].alternative, false);
  const merchants = iron.routes.filter((row) => row.personId?.startsWith('npc-'));
  assert(merchants.some((row) => /平康城/.test(row.label) && row.placeId === 'place-15'));
  assert(merchants.some((row) => /樊城/.test(row.label) && row.placeId === 'place-51'));
  assert(merchants.filter((row) => !row.placeId).every((row) => row.alternative));
  assert(!flow.advice.some((row) => row.id === 'early-woodcutter-axe-choice'));
  assert(!flow.opportunities.some((row) => row.id === 'early-woodcutter-axe-choice'));
});

test('advance warnings name affected quests, distinguish pickup windows, and retire resolved tasks', () => {
  const before = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5750, step: 1 },
    ]),
  );
  const qin = before.warnings.find((row) => row.id === 'qin-score-window');
  assert.equal(qin.affectedTasks[0].name, '绝响难求');
  assert.match(qin.affectedTasks[0].effect, /不能再触发接取/);
  assert.match(qin.affectedTasks[0].evidence, /2024.*不据此判已接任务失效/);
  assert.equal(before.changes.find((row) => row.id === qin.id).affectedTasks[0].questId, 12200);
  const accepted = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 12200, step: 1 },
    ]),
  );
  assert.match(
    accepted.warnings.find((row) => row.id === qin.id).affectedTasks[0].effect,
    /已有进行中记录.*没有证明/,
  );
  const crossed = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5780, step: 1 },
    ]),
  );
  assert.match(crossed.warnings.find((row) => row.id === qin.id).message, /没有任务记录不等于错过/);
  for (const step of [2, 4]) {
    const resolved = flowSnapshot(
      profile(),
      ref([
        { id: 5700, step: 4 },
        { id: 12200, step },
      ]),
    );
    assert(!resolved.warnings.some((row) => row.id === qin.id));
    assert.equal(resolved.guide.find((row) => row.id === qin.id).affectedTasks.length, 0);
  }
  const early = flowSnapshot(profile(), ref([{ id: 5200, step: 1 }]));
  assert.equal(early.warnings.find((row) => row.id === 'lotus-meeting').affectedTasks[0].name, '莲湖会晤');
  assert(!early.changes.some((row) => row.affectedTasks.some((task) => task.questId === 12200)));
});

test('contextual village advice requires its actual stage and retires before inviting Xiaotong', () => {
  const project = (quests, trackingMainQuest = 5020) =>
    flowSnapshot(profile(), ref(quests, { trackingMainQuest }));
  const before = project([
    { id: 5020, step: 1 },
    { id: 5024, step: 4 },
  ]);
  const advice = before.advice.find((row) => row.id === 'npc051-east-dialogue');
  assert(advice);
  assert.match(advice.recommendation.action, /村东.*李寡妇.*小彤/);
  assert.match(advice.recommendation.reason, /额外闲聊/);
  assert.match(advice.recommendation.tradeoff, /未发现独占物品奖励/);
  for (const step of [1, 2, 4]) {
    const after = project([
      { id: 5020, step: 1 },
      { id: 5024, step: 4 },
      { id: 5036, step },
    ]);
    assert(!after.advice.some((row) => row.id === advice.id));
  }
  assert(
    !project(
      [
        { id: 5200, step: 1 },
        { id: 5024, step: 4 },
      ],
      5200,
    ).advice.some((row) => row.id === advice.id),
  );
  assert(!project([{ id: 5020, step: 1 }]).advice.some((row) => row.id === advice.id));
});

test('an accepted Qiluo invitation still needs the departure window checked', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 5850, step: 1 },
      { id: 30150, step: 1 },
      { id: 30151, step: 4 },
    ]),
  );
  const affected = flow.warnings.find((row) => row.id === 'qiluo-window').affectedTasks[0];
  assert.equal(affected.scope, 'departure');
  assert.match(affected.effect, /出发条件不再满足/);
  assert.doesNotMatch(affected.effect, /只限制未接取|已有进行中记录/);
});

test('return-to-Wudang preparation follows the late boundary without calling a stage an unaccepted task', () => {
  const id = 'late-roster-before-wudang';
  const preparing = flowSnapshot(
    profile(),
    ref(
      [
        { id: 8830, step: 1 },
        { id: 8879, step: 1 },
      ],
      { trackingMainQuest: 8830 },
    ),
  );
  const warning = preparing.warnings.find((row) => row.id === id);
  assert(warning);
  assert.match(warning.message, /回武当前.*旧版/);
  assert.match(warning.uncertainty, /v1\.23\.24.*不能保证当前版本/);
  assert.equal(warning.sources.length, 2);
  assert.match(preparing.changes.find((row) => row.id === id).triggerName, /进入山门之前/);
  assert(!preparing.opportunities.some((row) => row.id === id));
  const ended = [{ id: 8830, step: 4 }];
  assert(flowSnapshot(profile(), ref(ended)).warnings.some((row) => row.id === id));
  for (const root of guide.rules.find((row) => row.id === id).untilAnyStarted) {
    for (const state of [1, 2, 4]) {
      const flow = flowSnapshot(
        profile(),
        ref([...ended, { id: root, step: state }], { trackingMainQuest: root }),
      );
      assert(!flow.warnings.some((row) => row.id === id), `${root}/${state} must retire preparation`);
      assert(!flow.changes.some((row) => row.id === id));
      assert(!flow.opportunities.some((row) => row.id === id));
      assert(
        flow.guide.some((row) => row.id === id),
        'still available for reference',
      );
    }
  }
  for (const state of [0, 3])
    assert(
      flowSnapshot(profile(), ref([...ended, { id: 5920, step: state }])).warnings.some(
        (row) => row.id === id,
      ),
    );
  assert(!flowSnapshot(profile(), ref([{ id: 5200, step: 1 }])).warnings.some((row) => row.id === id));
  assert(!flowSnapshot(profile({ referenceMode: 'none' }), ref(ended)).warnings.some((row) => row.id === id));
  assert(
    !flowSnapshot(profile({ referenceMode: 'slot', saveSlot: '0.sav' }), ref(ended)).warnings.some(
      (row) => row.id === id,
    ),
  );
});

test('Yuanqi follow-through remains a lead until the return quest is resolved, without inventing survival', () => {
  const id = 'yuanqi-return-followthrough';
  const records = [
    { id: 20000, step: 1 },
    { id: 20012, step: 4 },
    { id: 20050, step: 4 },
  ];
  const early = flowSnapshot(profile(), ref(records, { trackingMainQuest: 20000 }));
  const lead = early.opportunities.find((row) => row.id === id);
  assert(lead);
  assert.equal(lead.state, 'unrecorded');
  assert.match(lead.pickup.place, /弟子房.*天剑宗/);
  assert.match(lead.warning, /前半段.*不等于/);
  assert.match(lead.uncertainty, /不保证.*必然存活/);
  assert.equal(lead.sources.length, 3);
  const running = flowSnapshot(
    profile(),
    ref([...records, { id: 20100, step: 1 }, { id: 20101, step: 1 }], { trackingMainQuest: 20000 }),
  );
  assert(running.warnings.some((row) => row.id === id));
  assert(!running.opportunities.some((row) => row.id === id));
  assert.match(running.active.find((row) => row.gameId === 20100).steps[0].nextAction, /天剑宗/);
  for (const state of [2, 4]) {
    const resolved = flowSnapshot(profile(), ref([...records, { id: 20100, step: state }]));
    assert(!resolved.warnings.some((row) => row.id === id));
    assert(!resolved.opportunities.some((row) => row.id === id));
    assert.equal(resolved.guide.find((row) => row.id === id).state, state === 4 ? 'done' : 'failed');
  }
});

test('task locations recognize named destinations and do not choose arbitrary same-name map variants', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 8830, step: 1 },
      { id: 8879, step: 1 },
    ]),
  );
  const places = flow.active.find((row) => row.gameId === 8830).steps[0].places;
  assert.deepEqual(
    places.map((row) => row.name),
    ['武当派', '名剑山庄'],
  );
  assert(places.every((row) => row.id === null));
  assert(places.every((row) => /文字提及/.test(row.evidence)));
  const village = flowSnapshot(
    profile(),
    ref([
      { id: 5020, step: 1 },
      { id: 5021, step: 1 },
    ]),
  );
  for (const task of village.active)
    for (const step of task.steps) {
      assert.equal(new Set(step.places.map((row) => row.name)).size, step.places.length);
    }
});

test('an explicit interaction map can resolve a textual variant, while several interaction variants stay uncertain', () => {
  const maps = [
    { id: 'place-1', gameId: 1, key: 'base', name: '武当派' },
    { id: 'place-2', gameId: 2, key: 'later', name: '武当派' },
    { id: 'place-3', gameId: 3, key: 'valley', name: '武当药谷' },
  ];
  const task = {
    id: 'quest-1',
    gameId: 1,
    parentId: 0,
    kind: 'Secondary',
    name: '返回武当',
    description: '',
    requestNPCs: [],
    finishNPCs: [],
    requirements: [],
    placements: [{ mapKey: 'later', interactionTarget: true }],
  };
  const snapshot = (q) =>
    createFlowProjector({
      world: { quests: [q], people: [], maps, npcNames: {} },
      game: { entries: [] },
      guide: { rules: [], sources: {} },
    }).flowSnapshot(profile(), ref([{ id: 1, step: 1 }])).active[0].steps[0];
  assert.equal(snapshot(task).places[0].id, 'place-2');
  const ambiguous = snapshot({
    ...task,
    placements: [...task.placements, { mapKey: 'base', interactionTarget: true }],
  });
  assert.equal(ambiguous.places.length, 1);
  assert.equal(ambiguous.places[0].id, null);
  assert.match(ambiguous.places[0].evidence, /多个同名/);
  const valley = snapshot({ ...task, name: '前往武当药谷', placements: [] });
  assert.deepEqual(
    valley.places.map((row) => row.name),
    ['武当药谷'],
  );
  assert.equal(valley.places[0].id, 'place-3');
});

test('late-story milestones follow sourced routes and disclose ambiguous returns instead of guessing', () => {
  for (const [current, next] of [
    [9254, 20000],
    [20000, 22000],
    [22000, 22100],
    [22100, 22170],
    [22170, 24000],
    [24000, 24020],
  ]) {
    const node = flowSnapshot(profile(), ref([{ id: current, step: 1 }], { trackingMainQuest: current }))
      .chapter.nextMilestone;
    assert.equal(node.questId, `quest-${next}`);
    assert(node.sources.some((row) => row.id === 'flow:biliLateFlow'));
    assert.match(node.note, /参考.*前置条件/);
  }
  for (const root of [5920, 5940, 5980]) {
    const node = flowSnapshot(profile(), ref([{ id: root, step: 1 }], { trackingMainQuest: root })).chapter
      .nextMilestone;
    assert.equal(node.questId, null);
    assert.match(node.note, /原版.*烟尘回响.*不足以自动区分/);
  }
  assert.equal(
    flowSnapshot(profile(), ref([{ id: 5990, step: 1 }], { trackingMainQuest: 5990 })).chapter.nextMilestone
      .questId,
    'quest-6050',
  );
  assert.equal(
    flowSnapshot(
      profile(),
      ref([
        { id: 20000, step: 1 },
        { id: 22000, step: 1 },
      ]),
    ).chapter,
    null,
  );
});

test('unindexed active records stay visible without inventing names, ownership or next actions', () => {
  const metadata = enrich(
    readMetadata(
      syntheticSave({
        full: true,
        quests: [
          { id: 5200, step: 1 },
          { id: 999999, step: 1 },
          { id: 5858, step: 1 },
          { id: 999998, step: 4 },
          { id: 999997, step: 3 },
          { id: 999996, step: 2 },
        ],
        trackingQuest: 999999,
      }),
      { details: true },
    ),
  );
  const snapshot = flowSnapshot(profile(), { ...ref([]), metadata });
  assert.deepEqual(
    snapshot.unindexedActive.map((row) => row.id),
    [999999, 5858],
  );
  assert.equal(snapshot.unindexedActive[0].tracked, true);
  assert.equal(snapshot.active.length, 1);
  assert.equal(
    flowSnapshot(profile({ referenceMode: 'none' }), { ...ref([]), metadata }).unindexedActive.length,
    0,
  );
  assert.equal(
    flowSnapshot(profile({ referenceMode: 'slot', saveSlot: '2.sav' }), { ...ref([]), metadata })
      .unindexedActive.length,
    0,
  );
});

test('an unavailable fixed reference explains the actual recovery and never adopts another slot', () => {
  const fixed = profile({ referenceMode: 'slot', saveSlot: '0.sav' });
  const alternate = ref(
    [
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
    ],
    {},
    '1.sav',
  );
  for (const reference of [null, alternate]) {
    const flow = flowSnapshot(fixed, reference);
    assert.equal(flow.available, false);
    assert.equal(flow.reference, null);
    assert.equal(flow.active.length, 0);
    assert.equal(flow.decisions.length, 0);
    assert.equal(flow.referenceNeedsSelection, true);
    assert.match(flow.reason, /固定参照「0.sav」.*选择.*流程参照/);
    assert.doesNotMatch(flow.reason, /游戏里保存一次后/);
  }
  assert.match(
    flowSnapshot(profile({ referenceMode: 'none' }), alternate, '目录暂不可读').reason,
    /暂不读取游戏进度/,
  );
});

test('decision prompts follow an actual active choice step and disappear after choosing or closing its family', () => {
  const active = flowSnapshot(
    profile(),
    ref([
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
    ]),
  );
  const axe = active.decisions.find((row) => row.id === 'early-woodcutter-axe-choice');
  assert(axe);
  assert.match(axe.choices.map((row) => row.effect).join(' '), /700.*2000/);
  const state = defaults();
  const passive = companionSnapshot(
    state,
    catalog,
    ref([
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
    ]),
  );
  assert.equal(passive.hints[0].type, 'flow-choice');
  assert.match(passive.hints[0].title, /樵夫.*重锻.*铁矿石.*4/);
  for (const records of [
    [{ id: 11002, step: 1 }],
    [
      { id: 11002, step: 1 },
      { id: 11005, step: 4 },
      { id: 11007, step: 1 },
    ],
    [
      { id: 11002, step: 4 },
      { id: 11005, step: 1 },
    ],
    [
      { id: 11002, step: 2 },
      { id: 11005, step: 1 },
    ],
    [
      { id: 11002, step: 1 },
      { id: 11005, step: 3 },
    ],
  ]) {
    assert(!flowSnapshot(profile(), ref(records)).decisions.some((row) => row.id === axe.id));
  }
  for (const rule of guide.rules.filter((row) => row.decisionSteps?.length)) {
    for (const id of rule.decisionSteps) {
      const task = world.quests.find((row) => row.gameId === id);
      assert.equal(task?.parentId, rule.questId, rule.id);
    }
  }
});

test('weapon choice is recommended before the dialog and retires as soon as a saved weapon branch is known', () => {
  const id = 'early-jingyin-weapon-choice';
  const project = (records, extra = {}) =>
    flowSnapshot(profile(), ref(records, { trackingMainQuest: 5074, ...extra }));
  for (const step of [1, 4]) {
    const before = project([
      { id: 5074, step: 1 },
      { id: 5076, step },
    ]);
    const choice = before.decisions.find((row) => row.id === id);
    assert(choice, 'visible step or verified window before the unnamed dialog');
    assert.match(choice.recommendation.action, /普通新档.*剑系武器.*继承.*缺少/);
    assert.match(choice.choices.map((row) => row.effect).join(' '), /惊雷剑法.*霹雳霸刀.*化功绵掌/);
  }
  for (const exit of [5079, 5080, 5081, 5087]) {
    const after = project([
      { id: 5074, step: 1 },
      { id: 5076, step: 1 },
      { id: exit, step: 4 },
    ]);
    assert(
      !after.decisions.some((row) => row.id === id),
      `recorded branch ${exit} supersedes a stale active anchor`,
    );
    assert(!after.warnings.some((row) => row.id === id));
    assert(
      after.guide.some((row) => row.id === id),
      'reward reference remains searchable',
    );
  }
  for (const records of [
    [],
    [{ id: 5074, step: 1 }],
    [
      { id: 5074, step: 2 },
      { id: 5076, step: 4 },
    ],
    [{ id: 5076, step: 4 }],
  ]) {
    assert(!project(records).decisions.some((row) => row.id === id));
  }
});

test('Bai rescue recommendation replaces the dangerous default route before delivery and retires on either outcome', () => {
  const id = 'bai-jin-rescue-route';
  const project = (quests, metadata = {}) =>
    flowSnapshot(profile(), ref(quests, { trackingMainQuest: 5700, trackingQuest: 12035, ...metadata }));
  const stages = [
    [{ id: 12033, step: 1 }],
    [{ id: 12033, step: 4 }],
    [
      { id: 12033, step: 4 },
      { id: 12035, step: 1 },
    ],
  ];
  for (const stage of stages) {
    const quests = [{ id: 5700, step: 1 }, { id: 12030, step: 1 }, ...stage];
    const current = project(quests);
    const choice = current.decisions.find((row) => row.id === id);
    assert(choice);
    assert.match(choice.recommendation.action, /临昌.*渊军营寨.*救人.*再回峋谷关/);
    assert.match(choice.recommendation.reason, /危机解除.*保留白锦.*天罗地网钉/);
    assert.match(choice.recommendation.tradeoff, /霹雳雷火弹.*绝笔.*不能.*兼得/);
    assert.match(choice.choices.map((row) => row.effect).join(' '), /白锦获救.*白锦身亡/);
    assert.match(current.changes.find((row) => row.id === id).affectedTasks[0].effect, /身亡.*不能继续/);
    const sidebar = companionSnapshot(defaults(), catalog, ref(quests, { trackingQuest: 12035 }));
    assert.equal(sidebar.hints[0].type, 'flow-choice');
    assert.match(sidebar.hints[0].title, /临昌.*白锦/);
  }
  const before = [
    { id: 12030, step: 1 },
    { id: 12033, step: 4 },
    { id: 12035, step: 1 },
  ];
  for (const [exit, step] of [
    [12035, 4],
    [12036, 4],
    [12037, 1],
    [12038, 4],
    [12040, 4],
    [12041, 4],
  ]) {
    const current = project([...before.filter((row) => row.id !== exit), { id: exit, step }]);
    assert(!current.decisions.some((row) => row.id === id), String(exit));
    assert(!current.warnings.some((row) => row.id === id));
    assert(
      current.guide.some((row) => row.id === id),
      'branch rewards remain available as reference',
    );
  }
  for (const quests of [
    [],
    [{ id: 12030, step: 1 }],
    [
      { id: 12030, step: 1 },
      { id: 12032, step: 1 },
    ],
    [{ id: 12033, step: 4 }],
    [
      { id: 12030, step: 2 },
      { id: 12033, step: 4 },
    ],
    [
      { id: 12030, step: 4 },
      { id: 12035, step: 1 },
    ],
  ])
    assert(!project(quests).decisions.some((row) => row.id === id));
});

test('late-night dialogue advice survives the visible rest step but does not promise a hidden ending', () => {
  const id = 'cold-wuqing-night-choice';
  const saved = syntheticSave({
    full: true,
    quests: [
      { id: 22100, step: 1 },
      { id: 22125, step: 1 },
    ],
    trackingMainQuest: 22100,
    trackingQuest: 22125,
  });
  const reference = { ...ref([]), metadata: enrich(readMetadata(saved, { details: true })) };
  const untouched = structuredClone(reference);
  for (const step of [1, 4]) {
    const state = structuredClone(reference);
    state.metadata.questStates.find((row) => row.id === 22125).step = step;
    const current = companionSnapshot(defaults(), catalog, state);
    const choice = current.flow.decisions.find((row) => row.id === id);
    assert(choice);
    assert.equal(current.hints[0].type, 'flow-choice');
    assert.match(current.hints[0].title, /冷无情.*矢志于此/);
    assert.match(choice.recommendation.action, /矢志于此.*此前.*阎浮镇凶案/);
    assert.match(choice.recommendation.tradeoff, /好感100.*不保证.*江湖器量/);
    assert.match(choice.choices[1].effect, /完整结局后果尚未核定/);
    for (const [exit, exitStep] of [
      [22132, 4],
      [22133, 4],
      [22134, 4],
      [22150, 1],
      [23000, 1],
    ]) {
      const after = structuredClone(state);
      after.metadata.questStates.push({ id: exit, step: exitStep });
      const result = flowSnapshot(profile(), after);
      assert(!result.decisions.some((row) => row.id === id), String(exit));
      assert(!result.warnings.some((row) => row.id === id));
    }
  }
  for (const scoped of [
    profile({ referenceMode: 'none' }),
    profile({ referenceMode: 'slot', saveSlot: 'Other.sav' }),
  ]) {
    assert(!flowSnapshot(scoped, reference).decisions.some((row) => row.id === id));
  }
  for (const quests of [
    [],
    [{ id: 22100, step: 1 }],
    [{ id: 22125, step: 4 }],
    [
      { id: 22100, step: 4 },
      { id: 22125, step: 4 },
    ],
  ]) {
    assert(!flowSnapshot(profile(), ref(quests)).decisions.some((row) => row.id === id));
  }
  assert.deepEqual(reference, untouched);
});

test('Chengyu recommendation bridges the return dialog but closes on either saved departure choice', () => {
  const id = 'chengyu-stay-choice';
  const project = (records) => flowSnapshot(profile(), ref(records, { trackingMainQuest: 5820 }));
  for (const step of [1, 4]) {
    const before = project([
      { id: 5820, step: 1 },
      { id: 5821, step },
    ]);
    const choice = before.decisions.find((row) => row.id === id);
    assert(choice);
    assert.match(choice.recommendation.action, /赞成留下程钰/);
    assert.match(choice.recommendation.tradeoff, /不告而别.*清霄.*李天宝/);
    assert.match(before.changes.find((row) => row.id === id).affectedTasks[0].effect, /送走.*不告而别/);
  }
  for (const exit of [5827, 5828, 5829, 5831]) {
    const after = project([
      { id: 5820, step: 1 },
      { id: 5821, step: 4 },
      { id: exit, step: 4 },
    ]);
    assert(!after.decisions.some((row) => row.id === id));
    assert(!after.warnings.some((row) => row.id === id));
  }
  for (const records of [
    [{ id: 5820, step: 1 }],
    [{ id: 5821, step: 4 }],
    [
      { id: 5820, step: 4 },
      { id: 5821, step: 4 },
    ],
  ]) {
    assert(!project(records).decisions.some((row) => row.id === id));
  }
});

test('Yanfu investigation leads the sidebar before the choice and retires on continue or abandon', () => {
  const id = 'yanfu-investigation-choice';
  const saved = ref(
    [
      { id: 20000, step: 1 },
      { id: 21050, step: 1 },
      { id: 21123, step: 1 },
    ],
    { trackingMainQuest: 20000, trackingQuest: 21123 },
  );
  const bytes = syntheticSave({
    full: true,
    quests: saved.metadata.quests,
    trackingMainQuest: 20000,
    trackingQuest: 21123,
  });
  const parsed = enrich(readMetadata(bytes, { details: true }));
  const reference = { ...saved, metadata: parsed };
  const untouched = structuredClone(reference);
  const current = companionSnapshot(defaults(), catalog, reference);
  assert.equal(current.hints[0].type, 'flow-choice');
  assert.match(current.hints[0].title, /阎浮镇凶案.*继续调查/);
  const choice = current.flow.decisions.find((row) => row.id === id);
  assert(choice);
  assert.match(choice.recommendation.tradeoff, /其他选择.*不保证/);
  assert.match(choice.affectedTasks[0].effect, /放弃调查.*结束/);
  const duringDialog = structuredClone(reference);
  duringDialog.metadata.questStates.find((row) => row.id === 21123).step = 4;
  assert(flowSnapshot(profile(), duringDialog).decisions.some((row) => row.id === id));
  for (const exit of [21133, 21134, 21142, 21143, 21148, 21149]) {
    const after = structuredClone(reference);
    after.metadata.questStates.push({ id: exit, step: exit === 21148 ? 1 : 4 });
    const snapshot = companionSnapshot(defaults(), catalog, after);
    assert(!snapshot.flow.decisions.some((row) => row.id === id), String(exit));
    assert(!snapshot.flow.warnings.some((row) => row.id === id));
    assert(snapshot.flow.guide.some((row) => row.id === id));
  }
  for (const scoped of [
    profile({ referenceMode: 'none' }),
    profile({ referenceMode: 'slot', saveSlot: 'Other.sav' }),
  ]) {
    assert(!flowSnapshot(scoped, reference).decisions.some((row) => row.id === id));
  }
  assert.deepEqual(reference, untouched);
});

test('current choice recommendations lead ordinary warnings and follow the tracked task across saved changes', () => {
  const saved = ref(
    [
      { id: 5780, step: 1 },
      { id: 5700, step: 4 },
      { id: 11002, step: 1 },
      { id: 11005, step: 1 },
      { id: 11060, step: 1 },
      { id: 11061, step: 1 },
    ],
    { trackingMainQuest: 5780, trackingQuest: 11061 },
  );
  const before = structuredClone(saved);
  const state = defaults();
  const snapshot = companionSnapshot(state, catalog, saved);
  assert(snapshot.flow.warnings.length > 0, 'ordinary chapter warnings remain available');
  assert.deepEqual(
    snapshot.flow.decisions.map((row) => row.id),
    ['early-sun-homesickness-choice', 'early-woodcutter-axe-choice'],
  );
  assert.equal(snapshot.hints[0].type, 'flow-choice');
  assert.match(snapshot.hints[0].title, /孙老.*返乡/);
  assert.equal(snapshot.hints[1].type, 'flow-warning');
  const updated = structuredClone(saved);
  updated.metadata.quests.find((row) => row.id === 11061).step = 4;
  const after = companionSnapshot(state, catalog, updated);
  assert.match(after.hints[0].title, /樵夫.*重锻/);
  assert(!after.flow.decisions.some((row) => row.id === 'early-sun-homesickness-choice'));
  assert.deepEqual(saved, before);
  for (const scoped of [
    profile({ referenceMode: 'none' }),
    profile({ referenceMode: 'slot', saveSlot: 'Other.sav' }),
  ]) {
    const isolated = flowSnapshot(scoped, saved);
    assert.equal(isolated.decisions.length, 0);
    assert.equal(isolated.reference, null);
  }
});

test('critical recommendations state conditional goals and incompatible rewards instead of a universal best ending', () => {
  const entries = flowSnapshot(profile(), ref([])).guide;
  for (const entry of entries.filter((row) => row.decisionSteps?.length)) {
    assert(entry.recommendation?.action, entry.id);
    assert(entry.recommendation?.reason, entry.id);
    assert(entry.recommendation?.goal, entry.id);
    assert(entry.recommendation?.tradeoff, entry.id);
    assert(entry.sources.length, entry.id);
  }
  const find = (id) => entries.find((row) => row.id === id).recommendation;
  assert.match(find('chenlinxi-critical-choice').action, /先保存.*好感.*60.*低于70.*义正词严/);
  assert.match(find('chenlinxi-critical-choice').tradeoff, /70.*其他组合.*未确认/);
  assert.match(find('kongliang-choice').goal, /队友.*剧情/);
  assert.match(find('kongliang-choice').tradeoff, /漫天花雨.*一周目.*不救/);
  assert.match(find('golden-scorpion-choice').tradeoff, /不能兼走.*灵蝎挂坠.*截脉三式.*三条线/);
  assert.match(find('ending-commitment').action, /另存.*不愿意/);
  assert.match(find('ending-commitment').tradeoff, /互斥/);
  assert.equal(
    entries.find((row) => row.id === 'ending-commitment').decisionSteps,
    undefined,
    'no invented precise dialog binding',
  );
});

test('a new profile gets actionable saved steps, NPCs, material deficits and acquisition routes without setup', () => {
  const bytes = syntheticSave({
    full: true,
    trackingMainQuest: 5057,
    trackingQuest: 14082,
    quests: [
      { id: 5053, step: 1 },
      { id: 5057, step: 1 },
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
    inventory: [{ id: 10259, count: 1 }],
  });
  const metadata = enrich(readMetadata(bytes, { details: true }));
  const before = structuredClone(metadata),
    p = profile();
  const flow = flowSnapshot(p, ref(metadata.quests, metadata));
  assert.equal(flow.chapter.name, '初入江湖');
  assert.equal(flow.active.length, 2);
  const task = flow.active.find((q) => q.gameId === 14073).steps[0];
  assert.equal(task.nextAction, '收集茯苓和川芎');
  assert(task.people.some((p) => p.name.includes('道玄')));
  assert.deepEqual(
    task.materials.map((m) => [m.id, m.owned, m.missing]),
    [
      ['item-10259', 1, 0],
      ['item-10268', 0, 1],
    ],
  );
  assert(task.materials[1].routes.some((r) => r.detail.includes('桃花林') && r.detail.includes('落英林')));
  assert(task.materials[1].routes.every((r) => r.efficiency && !r.efficiency.includes('最快')));
  assert(task.materials[0].routes.some((r) => r.personId === 'npc-10001' && r.detail.includes('梧桐村')));
  assert(
    task.materials[1].routes.some((r) =>
      r.sources?.some((s) => s.id.startsWith('material:') && s.url.startsWith('https://')),
    ),
  );
  assert.deepEqual(metadata, before);
  assert.deepEqual(p, profile());
});

test('unknown stock, older saves and explicit source selection never inherit another save progress', () => {
  const p = profile({ referenceMode: 'slot', saveSlot: 'Synthetic.sav' });
  const newer = ref(
    [
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
    { inventory: [{ id: 10259, count: 10 }] },
  );
  assert.equal(flowSnapshot(p, newer).active[0].steps[0].materials[0].missing, 0);
  const older = ref(
    [
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
    { inventory: undefined },
  );
  assert.equal(flowSnapshot(p, older).active[0].steps[0].materials[0].missing, null);
  assert.equal(flowSnapshot(p, { ...newer, name: 'Foreign.sav' }).available, false);
  assert.equal(flowSnapshot(p, newer, '文件正在更新').active.length, 0);
  assert.equal(flowSnapshot(profile({ referenceMode: 'none' }), newer).active.length, 0);
  assert.equal(flowSnapshot(p, ref([{ id: 14073, step: 4 }])).active.length, 0);
});

test('a failed, completed or unaccepted ancestor cannot be resurrected by a contradictory child', () => {
  for (const step of [2, 3, 4]) {
    const flow = flowSnapshot(
      profile(),
      ref([
        { id: 11077, step },
        { id: 11078, step: 1 },
      ]),
    );
    assert.equal(flow.active.length, 0);
  }
  const orphan = flowSnapshot(profile(), ref([{ id: 11078, step: 1 }]));
  assert.equal(orphan.active[0].gameId, 11077);
  assert.equal(orphan.active[0].steps[0].id, 'quest-11078');
});

test('parallel active steps remain separate and quest IDs do not choose a branch or future successor', () => {
  const flow = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5368, step: 1 },
        { id: 5371, step: 1 },
        { id: 5372, step: 1 },
      ],
      { trackingQuest: 5372 },
    ),
  );
  assert.equal(flow.active[0].steps[0].name, '与莫弃交谈');
  assert.equal(flow.active[0].steps.length, 2);
  assert.equal(flowSnapshot(profile(), ref([{ id: 5368, step: 4 }])).chapter, null);
});

function ruleFixture() {
  const content = {
    sources: { synthetic: { title: '合成条件', url: 'https://example.com/synthetic', version: 'test' } },
    rules: [
      {
        id: 'window',
        title: '合成窗口',
        questId: 12200,
        chapterRoots: [5700, 5755],
        afterAllComplete: [5700],
        untilAnyStarted: [5780],
        pickup: { place: '合成地点', person: '合成人物', action: '核对任务' },
        warning: '推进前核对选择',
        steps: ['合成步骤'],
        choices: [
          { label: 'A', effect: '合成结果A' },
          { label: 'B', effect: '合成结果B' },
        ],
        sourceIds: ['synthetic'],
      },
    ],
  };
  return createFlowProjector({ world, game, guide: content }).flowSnapshot;
}
test('a guide window changes with saved main progress, without equating an absent quest with availability or failure', () => {
  const project = ruleFixture();
  const before = project(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5755, step: 1 },
    ]),
  );
  assert.equal(before.opportunities[0].state, 'unrecorded');
  assert.equal(before.warnings[0].choices.length, 2);
  assert.equal(before.chapter.next.title, '天水祝寿');
  assert.equal(before.changes.length, 1);
  const after = project(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5780, step: 1 },
    ]),
  );
  assert.equal(after.opportunities.length, 0);
  assert.match(after.warnings[0].message, /不等于错过/);
  const accepted = project(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 12200, step: 1 },
      { id: 12207, step: 1 },
    ]),
  );
  assert.equal(accepted.opportunities.length, 0);
  assert.equal(accepted.active[0].steps[0].nextAction, '前往姑苏迎仙楼找丘掌柜');
  assert.equal(
    project(
      profile(),
      ref([
        { id: 5700, step: 4 },
        { id: 12200, step: 4 },
      ]),
    ).warnings.length,
    0,
  );
  assert.equal(project(profile(), null).opportunities.length, 0);
});

test('public prerequisite leads expose unknown hidden exclusions and suppress positively unmet conditions', () => {
  const project = createFlowProjector({ world, game, guide: { sources: {}, rules: [] } }).flowSnapshot;
  const flow = project(profile(), ref([{ id: 5535, step: 4 }]));
  const medicine = flow.opportunities.find((q) => q.questId === 13407);
  assert(medicine);
  assert.equal(medicine.state, 'conditions-partial');
  assert.equal(medicine.conditions.filter((c) => c.status === 'unknown').length, 2);
  assert.match(medicine.uncertainty, /隐藏条件/);
  assert(
    !project(
      profile(),
      ref([
        { id: 5535, step: 4 },
        { id: 6008, step: 1 },
      ]),
    ).opportunities.some((q) => q.questId === 13407),
  );
  assert(!project(profile(), ref([])).opportunities.some((q) => q.questId === 13407));
});

test('money alone cannot recommend a later quest with an unknown explicit story prerequisite', () => {
  const records = [
    { id: 5020, step: 4 },
    { id: 5053, step: 1 },
    { id: 5054, step: 4 },
    { id: 5057, step: 1 },
  ];
  const flow = flowSnapshot(profile(), ref(records, { money: 4000 }));
  assert.equal(flow.chapter.name, '初入江湖');
  assert(!flow.opportunities.some((row) => row.questId === 11441));
  const confirmed = flowSnapshot(profile(), ref([...records, { id: 5406, step: 4 }], { money: 4000 }));
  const festival = confirmed.opportunities.find((row) => row.questId === 11441);
  assert(festival);
  assert.equal(festival.state, 'conditions-match');
  assert(festival.conditions.every((row) => row.status === 'met'));
  for (const [step, money] of [
    [1, 4000],
    [4, 500],
  ]) {
    assert(
      !flowSnapshot(profile(), ref([...records, { id: 5406, step }], { money })).opportunities.some(
        (row) => row.questId === 11441,
      ),
    );
  }
  const unaccepted = flowSnapshot(profile(), ref([...records, { id: 11442, step: 3 }], { money: 4000 }));
  const recorded = unaccepted.opportunities.find((row) => row.questId === 11441);
  assert.equal(recorded.state, 'not-accepted');
  assert(recorded.conditions.some((row) => row.status === 'unknown'));
});

test('explicit unaccepted step records can supply pickup leads without inventing prerequisite-free availability', () => {
  const project = createFlowProjector({ world, game, guide: { sources: {}, rules: [] } }).flowSnapshot;
  const flow = project(profile(), ref([{ id: 11080, step: 3 }]));
  const smith = flow.opportunities.find((row) => row.questId === 11079);
  assert(smith);
  assert.equal(smith.state, 'not-accepted');
  assert.match(smith.pickup.person, /铁匠/);
  assert.match(smith.pickup.place, /梧桐村/);
  assert.match(smith.uncertainty, /未列出可核对的接取条件/);
  assert(!project(profile(), ref([])).opportunities.some((row) => row.questId === 11079));
  assert(
    !project(
      profile(),
      ref([
        { id: 11079, step: 4 },
        { id: 11080, step: 3 },
      ]),
    ).opportunities.some((row) => row.questId === 11079),
  );
});

test('unknown or ambiguous main tracking never assigns an unrelated chapter or next milestone', () => {
  const unknown = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5200, step: 1 },
        { id: 999999, step: 1 },
      ],
      { trackingMainQuest: 999999 },
    ),
  );
  assert.equal(unknown.chapter, null);
  assert.match(unknown.stageUncertainty, /主线.*待核对/);
  assert(!unknown.opportunities.some((row) => row.id === 'early-bai-return-plan'));
  assert.equal(unknown.active[0].gameId, 5200);
  const ambiguous = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5200, step: 1 },
        { id: 5500, step: 1 },
      ],
      { trackingMainQuest: 0 },
    ),
  );
  assert.equal(ambiguous.chapter, null);
  assert.match(ambiguous.stageUncertainty, /多条进行中主线/);
  const child = world.quests.find((q) => q.parentId === 5500);
  const tracked = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5200, step: 1 },
        { id: 5500, step: 1 },
      ],
      { trackingMainQuest: child.gameId },
    ),
  );
  assert.equal(tracked.chapter.questId, 'quest-5500');
  assert.equal(tracked.stageUncertainty, '');
  assert.match(tracked.chapter.basis, /主线追踪/);
  const sole = flowSnapshot(profile(), ref([{ id: 5500, step: 1 }]));
  assert.equal(sole.chapter.questId, 'quest-5500');
  assert.match(sole.chapter.basis, /唯一已识别/);
});

test('early village choices remain useful after story changes without guessing deadlines', () => {
  const early = flowSnapshot(
    profile(),
    ref([
      { id: 5074, step: 1 },
      { id: 5111, step: 4 },
    ]),
  );
  assert(early.warnings.some((row) => row.id === 'early-jingyin-weapon-choice'));
  const smith = early.opportunities.find((row) => row.id === 'early-blacksmith-courtship');
  assert(smith);
  assert.equal(smith.deadlineReached, false);
  assert.equal(smith.state, 'unrecorded');
  const axe = early.guide.find((row) => row.id === 'early-woodcutter-axe-choice');
  assert.match(axe.choices.map((row) => row.effect).join(' '), /700.*2000/);
  assert.match(axe.steps.join(' '), /铁矿石×4/);
  const pig = early.guide.find((row) => row.id === 'early-wei-pig-return');
  assert.match(pig.steps.join(' '), /莲心湖.*李村长/);
});

test('Wudang onboarding tasks each respect their own completed or failed record', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 5231, step: 1 },
      { id: 14200, step: 4 },
      { id: 14065, step: 2 },
      { id: 13802, step: 3 },
    ]),
  );
  assert(
    !flow.opportunities.some((row) => row.id === 'early-wudang-martial' || row.id === 'early-wudang-boars'),
  );
  assert(flow.opportunities.some((row) => row.id === 'early-wudang-alchemy' && row.state === 'not-accepted'));
  assert.match(flow.guide.find((row) => row.id === 'early-wudang-alchemy').steps.join(' '), /茯苓、白芍各1/);
  const collecting = flowSnapshot(
    profile(),
    ref([
      { id: 13802, step: 1 },
      { id: 13803, step: 1 },
    ]),
  );
  const herb = collecting.active[0].steps[0].materials.find((row) => row.id === 'item-10261');
  assert.equal(herb.required, 1);
  assert(herb.routes.some((row) => row.placeId === 'place-14' && row.sources.length));
  assert(herb.routes.some((row) => row.placeId === 'place-22' && row.sources.length));
});

test('offline story index covers every non-demo main root once and distinguishes missing records from completion', () => {
  const flow = flowSnapshot(profile(), null);
  const actual = flow.chapters.flatMap((c) => c.roots.map((q) => q.id));
  const expected = world.quests
    .filter((q) => !q.parentId && q.kind === 'Primary' && !q.name.includes('试玩版'))
    .map((q) => q.id);
  assert.deepEqual([...actual].sort(), expected.sort());
  assert.equal(new Set(actual).size, actual.length);
  assert(flow.chapters.every((c) => c.roots.every((q) => q.status === '未核对存档')));
  assert.equal(flow.coverage.tasks, 1736);
  assert.equal(flow.coverage.curatedRules, guide.rules.length);
  for (const rule of guide.rules) {
    assert(rule.sourceIds.length, rule.id);
    for (const id of rule.sourceIds) assert(guide.sources[id]?.url.startsWith('https://'), rule.id);
    if (rule.questId)
      assert(
        world.quests.some((q) => q.gameId === rule.questId),
        rule.id,
      );
  }
  for (const [id, value] of Object.entries(materialGuide.items)) {
    assert(game.entries.some((item) => item.id === `item-${id}`));
    for (const route of value.routes) {
      assert(route.sourceIds.length);
      for (const key of route.sourceIds) assert(materialGuide.sources[key]?.url.startsWith('https://'));
      assert(!/600\s*秒|最快|每分钟\d/.test(route.efficiency));
    }
  }
});

test('actual current tasks take companion hint priority while preserving personal plans', () => {
  const state = defaults(),
    p = state.profiles[0];
  p.goals = [{ id: 'own', title: '我的个人计划', pinned: true, done: false }];
  const before = structuredClone(state);
  const snapshot = companionSnapshot(
    state,
    catalog,
    ref([
      { id: 11077, step: 1 },
      { id: 11078, step: 1 },
    ]),
  );
  assert.equal(snapshot.hints[0].id, 'quest-11077');
  assert.equal(snapshot.hints[0].type, 'quest');
  assert.equal(snapshot.hints[0].title, '收集药材向洛村郎中换取秘术');
  assert.equal(snapshot.hints[1].title, '我的个人计划');
  assert(snapshot.flow.advice.some((r) => r.id === 'medicine-shared-herbs'));
  assert.deepEqual(state, before);
});

test('native hidden story gates survive enrichment and close a guide pickup window', () => {
  const project = (gate) => {
    const bytes = syntheticSave({
      full: true,
      quests: [{ id: 12500, step: 4 }, { id: 5600, step: 1 }, ...(gate ? [{ id: 5603, step: 1 }] : [])],
    });
    const raw = readMetadata(bytes, { details: true });
    const before = structuredClone(raw);
    const metadata = enrich(raw);
    assert.deepEqual(raw, before);
    assert.equal(
      metadata.quests.some((q) => q.id === 5603),
      false,
      'hidden gate has no named public task',
    );
    assert.equal(
      metadata.questStates.some((q) => q.id === 5603),
      gate,
    );
    return flowSnapshot(profile(), ref(metadata.quests, metadata));
  };
  const before = project(false);
  assert(before.opportunities.some((q) => q.id === 'counterattack-window'));
  const after = project(true);
  assert.equal(
    after.opportunities.some((q) => q.id === 'counterattack-window'),
    false,
  );
  const notice = after.warnings.find((q) => q.id === 'counterattack-window');
  assert.equal(notice.deadlineReached, true);
  assert.match(notice.message, /没有任务记录不等于错过/);
  const metadata = enrich(
    readMetadata(
      syntheticSave({
        full: true,
        quests: [
          { id: 5850, step: 1 },
          { id: 30148, step: 4 },
          { id: 16107, step: 4 },
          { id: 5858, step: 1 },
        ],
      }),
      { details: true },
    ),
  );
  const banquet = flowSnapshot(profile(), ref(metadata.quests, metadata)).warnings.find(
    (row) => row.id === 'qiluo-window',
  );
  assert.equal(banquet.deadlineReached, true);
  assert.equal(banquet.conditions[0].status, 'met');
  assert.match(banquet.conditions[0].text, /道微请托/);
});

test('a root-only family record does not masquerade as a known current step', () => {
  const flow = flowSnapshot(profile(), ref([{ id: 11077, step: 1 }]));
  assert.match(flow.active[0].steps[0].nextAction, /具体步骤.*核对游戏任务栏/);
  assert.notEqual(flow.active[0].steps[0].nextAction, flow.active[0].name);
});

test('task progress retains saved completed, failed and pending steps without inventing missing branches', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 12200, step: 1 },
      { id: 12203, step: 4 },
      { id: 12205, step: 2 },
      { id: 12207, step: 1 },
      { id: 12209, step: 3 },
    ]),
  );
  const task = flow.active.find((row) => row.gameId === 12200);
  assert.deepEqual(
    task.steps.map((row) => row.id),
    ['quest-12207'],
  );
  assert.deepEqual(
    task.progress.map((row) => [row.id, row.status]),
    [
      ['quest-12203', '已完成'],
      ['quest-12205', '已失败'],
      ['quest-12207', '进行中'],
      ['quest-12209', '尚未接取'],
    ],
  );
  assert(!task.progress.some((row) => row.id === 'quest-12208'));
});

test('the shipped guide warns about the score window and consequential recruitment choices', () => {
  const before = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5750, step: 1 },
    ]),
  );
  const score = before.warnings.find((q) => q.id === 'qin-score-window');
  assert(score);
  assert.equal(score.pickup.person, '欧阳雪');
  assert.equal(score.choices.length, 2);
  const after = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5780, step: 1 },
    ]),
  );
  assert.equal(
    after.opportunities.some((q) => q.id === 'qin-score-window'),
    false,
  );
  assert.equal(after.warnings.find((q) => q.id === 'qin-score-window').deadlineReached, true);
  const chen = flowSnapshot(profile(), ref([{ id: 5246, step: 1 }])).warnings.find(
    (q) => q.id === 'chenlinxi-critical-choice',
  );
  assert(chen.choices.some((choice) => /恰好70/.test(choice.label) && /没有完整说明/.test(choice.effect)));
});

test('offline guide cards retain known outcomes rather than relabeling them as unknown', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 11942, step: 4 },
      { id: 11077, step: 2 },
    ]),
  );
  assert.equal(flow.guide.find((row) => row.id === 'lotus-meeting').state, 'done');
  assert.equal(flow.guide.find((row) => row.id === 'medicine-shared-herbs').state, 'failed');
  assert(!flow.opportunities.some((row) => row.questId === 11942 || row.questId === 11077));
  assert(!flow.warnings.some((row) => row.questId === 11942 || row.questId === 11077));
});

test('shared material demand discloses the combined deficit for simultaneously handing in saved active steps', () => {
  const flow = flowSnapshot(
    profile(),
    ref(
      [
        { id: 11077, step: 1 },
        { id: 11078, step: 1 },
        { id: 11052, step: 1 },
        { id: 11054, step: 1 },
      ],
      { inventory: [{ id: 10262, count: 1 }] },
    ),
  );
  const herb = flow.sharedMaterials.find((row) => row.id === 'item-10262');
  assert.equal(herb.required, 2);
  assert.equal(herb.owned, 1);
  assert.equal(herb.missing, 1);
  assert.equal(herb.steps.length, 2);
  const done = flowSnapshot(
    profile(),
    ref([
      { id: 11077, step: 4 },
      { id: 11078, step: 1 },
      { id: 11052, step: 1 },
      { id: 11054, step: 1 },
    ]),
  );
  assert.equal(done.sharedMaterials.length, 0);
});

test('phase changes name the departing companion and consequential guide branches name their actions and costs', () => {
  const licheng = flowSnapshot(profile(), ref([{ id: 5580, step: 1 }]));
  assert(licheng.changes.some((row) => /瑶姬.*离队/.test(row.consequence)));
  assert(
    licheng.guide.find((row) => row.id === 'hepu-sandtable').steps.some((row) => /猴儿林.*去年花/.test(row)),
  );
  assert(!licheng.opportunities.some((row) => row.id === 'licheng-team-departure'));
  const banquet = flowSnapshot(profile(), ref([{ id: 5850, step: 1 }])).warnings.find(
    (row) => row.id === 'qiluo-window',
  );
  assert(banquet.choices.some((row) => /白锦.*羽毛.*冷无情.*翼卫/.test(row.effect)));
  assert(
    banquet.choices.some((row) => /苦老/.test(row.label) && /火云神掌.*没有玄阳离火功/.test(row.effect)),
  );
});
