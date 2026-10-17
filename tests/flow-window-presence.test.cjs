'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs'),
  { syntheticSave } = require('./fixtures.cjs'),
  { readMetadata } = require('../src/core/save-reader.cjs'),
  { enrich } = require('../src/core/game-data.cjs');
const profile = { id: 'synthetic-window', referenceMode: 'latest' };
function saved(quests, name = 'Synthetic.sav') {
  const bytes = syntheticSave({ full: true, quests, trackingMainQuest: 5200, trackingQuest: 5201 }),
    before = Buffer.from(bytes),
    metadata = enrich(readMetadata(bytes, { details: true }));
  assert.deepEqual(bytes, before);
  return { name, hash: 'synthetic', metadata };
}
const lotus = (flow) => flow.guide.find((row) => row.id === 'lotus-meeting');

test('Lotus advice puts the lake encounter before the first Wudang gate visit', () => {
  const flow = flowSnapshot(profile, saved([{ id: 5200, step: 1 }]));
  assert.equal(lotus(flow).deadlineReached, false);
  assert.match(lotus(flow).deadlineLabel, /首次.*山门/);
  assert.match(flow.warnings.find((row) => row.id === 'lotus-meeting').message, /莲心湖.*武当山门/);
  assert.doesNotMatch(lotus(flow).affectedTasks[0].effect, /正式拜入|开始拜师任务不等于/);
});

test('any explicitly recorded Wudang entry gate closes the Lotus pickup window, including step zero', () => {
  for (const step of [0, 1, 2, 3, 4]) {
    const reference = saved([
      { id: 5200, step: 1 },
      { id: 5202, step },
    ]);
    assert(reference.metadata.questStates.some((row) => row.id === 5202 && row.step === step));
    const flow = flowSnapshot(profile, reference),
      row = lotus(flow),
      warning = flow.warnings.find((row) => row.id === 'lotus-meeting');
    assert.equal(row.deadlineReached, true, `recorded gate ${step}`);
    assert.equal(row.failed, false, 'closing pickup does not assert that the task failed');
    assert(!flow.opportunities.some((row) => row.id === 'lotus-meeting'));
    assert.match(warning.message, /山门剧情已推进.*接取窗口已关闭/);
    assert.doesNotMatch(warning.message, /是否仍可接取|正式拜入/);
  }
});

test('a closed pickup window does not erase accepted or completed Lotus progress', () => {
  for (const step of [1, 4]) {
    const flow = flowSnapshot(
      profile,
      saved([
        { id: 5200, step: 1 },
        { id: 5202, step: 0 },
        { id: 11942, step },
      ]),
    );
    assert.equal(lotus(flow).deadlineReached, true);
    assert.equal(lotus(flow).state, step === 1 ? 'active' : 'done');
    assert.equal(lotus(flow).failed, false);
    assert(!flow.warnings.some((row) => row.id === 'lotus-meeting'));
    assert(!flow.opportunities.some((row) => row.id === 'lotus-meeting'));
  }
});

test('an explicitly recorded lake encounter is not offered again or falsely marked complete', () => {
  for (const step of [0, 1, 4]) {
    for (const entryGate of [[], [{ id: 5202, step: 0 }]]) {
      const flow = flowSnapshot(profile, saved([{ id: 5200, step: 1 }, { id: 11943, step }, ...entryGate]));
      assert.equal(lotus(flow).deadlineReached, true);
      assert.equal(lotus(flow).state, 'unrecorded', 'the root outcome is not inferred from a related record');
      assert.equal(lotus(flow).done, false);
      assert.equal(lotus(flow).failed, false);
      assert(!flow.opportunities.some((row) => row.id === 'lotus-meeting'));
      assert.match(flow.warnings.find((row) => row.id === 'lotus-meeting').message, /已有触发记录/);
      assert.doesNotMatch(flow.warnings.find((row) => row.id === 'lotus-meeting').message, /山门剧情已推进/);
    }
  }
});

test('a before-entry historical lookup remains separate from a later reference', () => {
  const before = saved([{ id: 5200, step: 1 }], 'Before.sav'),
    after = saved(
      [
        { id: 5200, step: 1 },
        { id: 5202, step: 0 },
      ],
      'After.sav',
    );
  assert.equal(lotus(flowSnapshot(profile, after)).deadlineReached, true);
  const historical = flowSnapshot(profile, before);
  assert.equal(lotus(historical).deadlineReached, false);
  assert.equal(historical.reference.name, 'Before.sav');
  assert.equal(lotus(flowSnapshot(profile, after)).deadlineReached, true);
  assert(!before.metadata.questStates.some((row) => row.id === 5202));
});

test('unreadable, fixed-missing and disabled reference modes do not invent an open pickup window', () => {
  const available = saved([{ id: 5200, step: 1 }]);
  for (const [selected, reference] of [
    [profile, { name: 'Partial.sav', metadata: {} }],
    [{ ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' }, available],
    [{ ...profile, referenceMode: 'none' }, available],
  ]) {
    const flow = flowSnapshot(selected, reference);
    assert.equal(flow.available, false);
    assert(!flow.opportunities.some((row) => row.id === 'lotus-meeting'));
    assert(!flow.warnings.some((row) => row.id === 'lotus-meeting'));
  }
});

const otherWindows = [
  { id: 'counterattack-window', root: 12540, main: 5600, anchors: [12500], gate: 5603 },
  { id: 'qiluo-window', root: 30150, main: 5850, anchors: [30148, 16107], gate: 5858 },
];
for (const window of otherWindows) {
  test(`${window.id} retires the window for every explicitly recorded NoQuest boundary`, () => {
    const before = [{ id: window.main, step: 1 }, ...window.anchors.map((id) => ({ id, step: 4 }))];
    assert(flowSnapshot(profile, saved(before)).opportunities.some((row) => row.id === window.id));
    for (const step of [0, 1, 2, 3, 4]) {
      const flow = flowSnapshot(profile, saved([...before, { id: window.gate, step }]));
      const row = flow.guide.find((row) => row.id === window.id);
      assert.equal(row.deadlineReached, true, `explicit gate ${step}`);
      assert.equal(row.failed, false);
      assert.equal(row.done, false);
      assert(!flow.opportunities.some((row) => row.id === window.id));
      assert(flow.warnings.some((row) => row.id === window.id && row.closedWindowMessage));
    }
  });
  test(`${window.id} retains accepted/completed progress and isolates missing or earlier references`, () => {
    const before = saved([{ id: window.main, step: 1 }, ...window.anchors.map((id) => ({ id, step: 4 }))]);
    const after = saved([...before.metadata.questStates, { id: window.gate, step: 0 }]);
    for (const step of [1, 4]) {
      const flow = flowSnapshot(profile, saved([...after.metadata.questStates, { id: window.root, step }]));
      const row = flow.guide.find((row) => row.id === window.id);
      assert.equal(row.state, step === 1 ? 'active' : 'done');
      assert.equal(row.failed, false);
      assert(!flow.opportunities.some((row) => row.id === window.id));
    }
    assert.equal(
      flowSnapshot(profile, before).guide.find((row) => row.id === window.id).deadlineReached,
      false,
    );
    for (const scoped of [
      { ...profile, referenceMode: 'none' },
      { ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' },
    ]) {
      const flow = flowSnapshot(scoped, after);
      assert.equal(flow.available, false);
      assert(!flow.warnings.some((row) => row.id === window.id));
      assert(!flow.opportunities.some((row) => row.id === window.id));
    }
  });
}

test('an accepted Qiluo departure step explains the blocked departure without marking the quest failed', () => {
  const before = [
    { id: 30150, step: 1 },
    { id: 30152, step: 1 },
    { id: 30148, step: 4 },
    { id: 16107, step: 4 },
  ];
  const current = (rows) =>
    flowSnapshot(profile, saved(rows))
      .active.find((row) => row.gameId === 30150)
      .steps.find((row) => row.id === 'quest-30152');
  assert.doesNotMatch(current(before).nextAction, /暂不能/);
  for (const step of [0, 1, 2, 3, 4]) {
    const flow = flowSnapshot(profile, saved([...before, { id: 5858, step }]));
    const row = flow.active.find((row) => row.gameId === 30150).steps.find((row) => row.id === 'quest-30152');
    assert.match(row.nextAction, /暂不能前往绮罗筵.*晋升执法/);
    assert.equal(row.blockedWindow, true);
    assert.equal(row.requirements.filter((row) => row.status === 'unmet').length, 1);
    assert.equal(flow.guide.find((row) => row.id === 'qiluo-window').state, 'active');
  }
  const departed = flowSnapshot(
    profile,
    saved([
      ...before.filter((row) => row.id !== 30152),
      { id: 30152, step: 4 },
      { id: 30153, step: 1 },
      { id: 5858, step: 4 },
    ]),
  );
  const active = departed.active.find((row) => row.gameId === 30150);
  assert(active.steps.every((row) => !row.blockedWindow && !/暂不能前往/.test(row.nextAction)));
});

test('saved NoQuest pickup requirements remain conservative without becoming blockers on an accepted step', () => {
  const active = [
    { id: 8499, step: 1 },
    { id: 8536, step: 1 },
    { id: 8537, step: 1 },
  ];
  const world = require('../src/data/world-index.json');
  const pickup = {
    ...world.quests.find((row) => row.gameId === 8537),
    id: 'quest-999991',
    gameId: 999991,
    parentId: 0,
    name: '合成接取测试',
  };
  const projection = require('../src/core/flow.cjs').createFlowProjector({
    world: { ...world, quests: [...world.quests, pickup] },
    game: require('../src/data/game-index.json'),
    guide: require('../src/data/flow-guide.cjs'),
  });
  const check = (rows) => {
    const reading = saved(rows);
    reading.metadata.inventory = [{ id: 10488, count: 1 }];
    const flow = projection.flowSnapshot(profile, reading);
    const accepted = flow.active
      .find((row) => row.gameId === 8499)
      .steps.find((row) => row.id === 'quest-8537');
    assert(
      !accepted.requirements.some((row) => row.text.includes('人面蛛毒元')),
      'pickup exclusion is not a current completion check',
    );
    return flow.opportunities.find((row) => row.id === 'conditions-999991');
  };
  assert.equal(check(active).conditions.find((row) => row.text.includes('人面蛛毒元')).status, 'unknown');
  for (const step of [0, 1, 2, 3, 4]) assert.equal(check([...active, { id: 8538, step }]), undefined);
});
