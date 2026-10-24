'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { defaults } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const world = require('../src/data/world-index.json');
const guide = require('../src/data/flow-guide.cjs');
const contracts = require('../src/data/flow-window-contracts.json');
const { syntheticSave } = require('./fixtures.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const profile = { id: 'pickup-window', referenceMode: 'latest' };
const elite = [
  [5304, 1],
  [5322, 1],
  [5317, 4],
  [5302, 4],
  [12230, 4],
];
const wine = [
  [5850, 1],
  [5857, 1],
  [5175, 4],
];
const chief = [
  [5980, 1],
  [6260, 1],
  [12118, 4],
];
function reference(main, pairs, overrides = {}) {
  const bytes = syntheticSave({
    full: true,
    trackingMainQuest: main,
    trackingQuest: { 5304: 5322, 5850: 5857, 5980: 6260 }[main] || main,
    quests: pairs.map(([id, step]) => ({ id, step })),
  });
  const before = Buffer.from(bytes);
  const metadata = enrich(readMetadata(bytes, { details: true }));
  assert.deepEqual(bytes, before, 'only isolated synthetic saves are read');
  return { name: 'Synthetic-pickup.sav', hash: 'synthetic', metadata, ...overrides };
}
const snapshot = (main, rows) => flowSnapshot(profile, reference(main, rows));
const warning = (flow, id) => flow.warnings.find((row) => row.id === id);
const normalize = (rows) => rows.map(({ type, id, value }) => ({ type, id, value }));
const pickupIds = (flow) =>
  flow.warnings
    .filter((row) => /^(elite-pickup-|chief-pickup-|five-fairy-wine-pickup)/.test(row.id))
    .map((row) => row.id);

test('pickup contracts match shipped real task conditions and retain the pinned raw provenance', () => {
  assert.equal(contracts.build, world.build);
  assert.equal(
    contracts.questTable.uassetSha256,
    'ca4fb2762930e4473fa10301678874e9ebbe4d0ee97b4a193b6ae71badcf3e41',
  );
  assert.equal(
    contracts.questTable.uexpSha256,
    '2d84daae1fc93fc6f098fd5897091704960581d305adffd2f42a26315a881a86',
  );
  assert.equal(
    contracts.questTable.tableDataSha256,
    'f1ddf79d01d5d143512ce55b1007b19cd8dc5c57c48ff00cb3ee396f5ef5fecf',
  );
  assert.equal(
    contracts.questTable.decoder['UAssetAPI.dll'],
    'd7b9fd4341ac22dd9ab8d9f49455ea5ebcf571abced64313ab15eb1944de07d9',
  );
  for (const group of [contracts.windows.elitePromotionPickups, contracts.windows.chiefPromotionPickups]) {
    assert.equal(group.conditionField, 'RequestRequirements');
    for (const pickup of group.pickups) {
      const task = world.quests.find((row) => row.gameId === pickup.conditionQuestId);
      assert(task, `real task ${pickup.conditionQuestId}`);
      assert.equal(task.parentId || task.gameId, pickup.questId);
      assert.deepEqual(normalize(task.requirements), pickup.requirements.values);
      assert.deepEqual(task.requestNPCs, pickup.requestNPCIds);
      assert(
        pickup.requirements.values.some(
          (row) => row.type === 'NoQuest' && group.closedByQuestPresence.includes(row.id),
        ),
      );
    }
  }
  const dependent = contracts.windows.elitePromotionPickups.dependentPickup;
  assert.deepEqual(
    normalize(world.quests.find((row) => row.gameId === dependent.conditionQuestId).requirements),
    dependent.requirements.values,
  );
  assert.deepEqual(contracts.windows.chiefPromotionPickups.entryTransition, {
    fromQuestId: 6260,
    type: 'JumpStep',
    id: 6261,
    value: 0,
  });
  assert.deepEqual(contracts.windows.fiveFairyWine.entryTransitions, [5932, 5933, 5935, 5936]);
  assert.deepEqual(contracts.windows.fiveFairyWine.transition, { type: 'JumpStep', id: 5863, value: 1 });
});

test('precision warnings name elite promotion consequences before the saved challenge action', () => {
  const flow = snapshot(5304, elite);
  const martial = warning(flow, 'elite-pickup-14074');
  assert(martial);
  assert.match(martial.warning, /演武试艺.*八卦刀法.*元启/);
  assert.match(martial.pickup.action, /元风.*元启/);
  assert.match(martial.deadlineLabel, /挑战道通.*晋升精英/);
  assert(
    martial.conditions.some((row) => /晋升精英弟子剧情.*尚未触发/.test(row.text) && row.status === 'unknown'),
  );
  assert(!martial.conditions.some((row) => /#5323|#5317/.test(row.text)));
  assert(
    flow.changes.some(
      (row) => row.id === martial.id && row.affectedTasks.some((task) => task.questId === 14074),
    ),
  );
  assert(warning(flow, 'elite-pickup-13825'));
  assert(
    !warning(flow, 'elite-pickup-13826'),
    'a later round is not offered before any preceding round is known',
  );
});

test('challenge rounds retire independently while retaining the next unaccepted round', () => {
  let rows = [...elite, [13824, 1]];
  for (const id of [13825, 13826, 13827, 13828, 13829]) {
    const before = snapshot(5304, rows);
    assert(warning(before, `elite-pickup-${id}`));
    const active = snapshot(5304, [...rows, [id, 1]]);
    assert(
      !warning(active, `elite-pickup-${id}`),
      'the current accepted round no longer needs a pickup warning',
    );
    if (id < 13829) {
      const next = warning(active, `elite-pickup-${id + 1}`);
      assert(next, 'the active current round does not accept its successor');
      assert.match(next.pickup.action, /当前一轮.*完成.*下一轮/);
      assert(
        next.conditions.some((row) => row.status === 'unmet'),
        'the next pickup is a future check, not currently unlocked',
      );
    }
    const failed = snapshot(5304, [...rows, [id, 2]]);
    assert(!warning(failed, `elite-pickup-${id}`));
    if (id < 13829) assert(!warning(failed, `elite-pickup-${id + 1}`));
    rows = [...rows, [id, 4]];
  }
  assert(!pickupIds(snapshot(5304, rows)).some((id) => /^elite-pickup-138/.test(id)));
});

test('every recorded NoQuest boundary closes pickup including zero and not-accepted states', () => {
  for (const [main, rows, gate, ruleId, root] of [
    [5304, elite, 5323, 'elite-pickup-14074', 14074],
    [5850, wine, 5863, 'five-fairy-wine-pickup', 11237],
    [5980, chief, 6261, 'chief-pickup-13511', 13510],
  ]) {
    assert(warning(snapshot(main, rows), ruleId));
    for (const step of [0, 1, 2, 3, 4]) {
      const flow = snapshot(main, [...rows, [gate, step]]);
      const rule = flow.guide.find((row) => row.id === ruleId);
      assert.equal(rule.deadlineReached, true, `${gate}:${step}`);
      assert.equal(rule.failed, false, 'pickup closure is not quest failure');
      assert(!flow.opportunities.some((row) => row.questId === root));
      const notice = warning(flow, ruleId);
      assert(notice && notice.deadlineReached);
      assert.match(notice.message, /接取条件已不满足.*不表示已接任务失败/);
    }
  }
});

test('accepted, completed and failed pickup steps retire their own warning', () => {
  for (const [main, rows, root, pickup, ruleId] of [
    [5304, elite, 14074, 14074, 'elite-pickup-14074'],
    [5850, wine, 11237, 11238, 'five-fairy-wine-pickup'],
    [5980, chief, 13510, 13511, 'chief-pickup-13511'],
  ])
    for (const step of [1, 2, 4]) {
      for (const id of new Set([root, pickup])) {
        const flow = snapshot(main, [...rows, [id, step]]);
        assert(!warning(flow, ruleId), `${ruleId}, ${id}:${step}`);
        assert(!flow.changes.some((row) => row.id === ruleId));
      }
    }
});

test('NoQuest checks never become failure or completion blockers on an already accepted task', () => {
  const flow = snapshot(5304, [...elite, [5323, 0], [14074, 1], [14083, 1], [13824, 1], [13825, 1]]);
  const martial = flow.active
    .find((row) => row.gameId === 14074)
    .steps.find((row) => row.id === 'quest-14083');
  assert.equal(martial.blockedWindow, false);
  assert(!martial.requirements.some((row) => /晋升/.test(row.text)));
  assert(!warning(flow, 'elite-pickup-14074'));
  assert(!warning(flow, 'elite-pickup-13825'));
  assert(
    warning(flow, 'elite-pickup-13826')?.deadlineReached,
    'only the future round loses its pickup condition',
  );
});

test('hidden five-fairy pickup adds an actionable early clue without mutating the world index', () => {
  assert(!world.quests.some((row) => row.gameId === 11238));
  const pickup = guide.pickupQuests.find((row) => row.gameId === 11238);
  assert.equal(pickup.parentId, 11237);
  assert.deepEqual(pickup.requestNPCs, [10245]);
  assert.deepEqual(pickup.requirements, [
    { type: 'PreQuest', id: 5175, value: 4 },
    { type: 'NoQuest', id: 5863, value: 0 },
  ]);
  const flow = snapshot(5200, [
    [5200, 1],
    [5175, 4],
  ]);
  const lead = flow.opportunities.find((row) => row.id === 'conditions-11238');
  assert(lead);
  assert.equal(lead.state, 'conditions-partial');
  assert.match(lead.pickup.place, /平康城.*客栈二楼.*社区线索/);
  assert.equal(lead.pickup.person, '幻紫');
  assert.match(lead.pickup.action, /当前在场.*证明/);
  assert.equal(lead.pickup.executionPlace, '', 'asking about the sect is not a destination');
  assert(lead.sources.some((row) => row.id === 'flow:rankPickupWindowsGame'));
  assert(
    !warning(flow, 'five-fairy-wine-pickup'),
    'the imminent departure warning belongs to the later main stage',
  );
  assert(!world.quests.some((row) => row.gameId === 11238));
  assert.equal(flow.coverage.tasks, world.quests.length);
});

test('five-fairy warning precedes departure teaching and is retired by actual family progress', () => {
  const flow = snapshot(5850, wine);
  const row = warning(flow, 'five-fairy-wine-pickup');
  assert(row);
  assert.match(row.warning, /接受授武.*不要等实际抵达名剑山庄/);
  assert.match(row.pickup.action, /平康城客栈二楼.*幻紫/);
  for (const stepId of [11238, 11240, 11245]) {
    assert(!warning(snapshot(5850, [...wine, [stepId, 1]]), row.id));
  }
});

test('hidden wine dialog keeps its progress identity while all detail links open the public task', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { entityCatalog } = await import('../src/renderer/entity-catalog.js');
  const index = { ...require('../src/data/game-index.json'), world };
  const views = createFlowViews({
    esc: String,
    act: (action, label, _cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    icon: () => '',
    pill: String,
    when: String,
  });
  for (const pairs of [
    [...wine, [11237, 1], [11238, 1]],
    [...wine, [11237, 1], [11238, 4], [11239, 4], [11240, 1]],
  ]) {
    const flow = snapshot(5850, pairs);
    const task = flow.active.find((row) => row.gameId === 11237);
    const dialog = task.progress.find((row) => row.id === 'quest-11238');
    assert.equal(dialog.detailId, 'quest-11237');
    assert.equal(dialog.status, pairs.some(([id, step]) => id === 11238 && step === 4) ? '已完成' : '进行中');
    for (const compact of [false, true]) {
      const html = views.panel(flow, { compact });
      assert.match(html, /data-action="flow-quest" data-id="quest-11237"/);
      assert.doesNotMatch(html, /data-action="flow-quest" data-id="quest-11238"/);
      for (const [, id] of html.matchAll(/data-action="flow-quest" data-id="([^"]+)"/g))
        assert(entityCatalog(index).entries.has(id), `detail target ${id} exists in the public catalog`);
    }
  }
  assert(
    !world.quests.some((row) => row.gameId === 11238),
    'the hidden dialog is not given a false public identity',
  );
});

test('chief protection appears before replying to Daotong and covers the separate Bai followup', () => {
  const flow = snapshot(5980, chief);
  for (const id of [12001, 12781, 13511]) {
    const row = warning(flow, `chief-pickup-${id}`);
    assert(row);
    assert.match(row.deadlineLabel, /回复道通师叔.*之前/);
    assert.match(row.warning, /回复.*直接建立.*早于晋升战结束/);
    assert(!row.conditions.some((condition) => /#6261/.test(condition.text)));
  }
  assert(!warning(flow, 'chief-pickup-12016'), 'the food followup requires a known active 落英之约');
  const followup = snapshot(5980, [...chief, [12000, 4], [12015, 1], [12014, 1]]);
  assert(!warning(followup, 'chief-pickup-12001'));
  assert(
    warning(followup, 'chief-pickup-12016'),
    'an active root or preceding invitation does not accept the food step',
  );
  assert(!warning(snapshot(5980, [...chief, [12015, 1], [12014, 1], [12016, 1]]), 'chief-pickup-12016'));
  const afterReply = snapshot(5980, [...chief.filter(([id]) => id !== 6260), [6260, 4], [6261, 0]]);
  assert(!afterReply.opportunities.some((row) => row.questId === 13510));
  assert(
    warning(afterReply, 'chief-pickup-13511')?.deadlineReached,
    'zero closes the window before winning a challenge',
  );
});

test('pickup warnings do not infer stages or availability from missing, disabled or another fixed reference', () => {
  assert.equal(
    pickupIds(
      snapshot(5000, [
        [5000, 1],
        [5317, 4],
        [5302, 4],
        [12230, 4],
        [5175, 4],
        [12118, 4],
      ]),
    ).length,
    0,
  );
  const incomplete = snapshot(5304, [
    [5304, 1],
    [5322, 1],
  ]);
  assert(!warning(incomplete, 'elite-pickup-14074'));
  assert(!warning(incomplete, 'elite-pickup-13825'));
  const source = reference(5304, elite);
  for (const [selected, ref] of [
    [{ ...profile, referenceMode: 'none' }, source],
    [{ ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' }, source],
    [profile, { name: 'Partial.sav', metadata: {} }],
  ])
    assert.equal(pickupIds(flowSnapshot(selected, ref)).length, 0);
});

test('main and companion renderer keep concrete pickup impacts and leave closed/accepted advice accurate', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const views = createFlowViews({
    esc: String,
    act: (_action, label) => label,
    icon: () => '',
    pill: String,
    when: String,
  });
  for (const [main, pairs, id, expected] of [
    [5304, elite, 'elite-pickup-14074', /演武试艺.*八卦刀法.*元启/s],
    [5850, wine, 'five-fairy-wine-pickup', /平康城.*客栈二楼.*幻紫/s],
    [5980, chief, 'chief-pickup-13511', /平阳王家.*回复道通/s],
  ]) {
    const ref = reference(main, pairs);
    const flow = flowSnapshot(profile, ref);
    const companion = companionSnapshot(defaults(), catalog, ref);
    assert.equal(companion.hints[0].type, 'flow-warning');
    assert.match(
      companion.hints[0].title,
      main === 5304 ? /演武试艺/ : main === 5850 ? /五仙花酿/ : /重回碗子山/,
    );
    for (const compact of [false, true]) {
      const html = views.panel(flow, { compact });
      assert(html.includes(`data-flow-warning="${id}"`));
      assert.match(html, expected);
      assert.doesNotMatch(
        warning(flow, id)
          .conditions.map((row) => row.text)
          .join(' '),
        /#5323|#6261/,
      );
    }
  }
  const closed = snapshot(5980, [...chief, [6261, 0]]);
  for (const compact of [false, true]) {
    const html = views.panel(closed, { compact });
    assert.match(html, /平阳王家：接取条件已不满足/);
    assert.match(html, /不表示已接任务失败/);
  }
});
