'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { completionChecks } = require('../src/shared/task-completion.mjs');
const { flowSnapshot, createFlowProjector } = require('../src/core/flow.cjs');
const { createTaskTargetProjector } = require('../src/core/task-targets.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const { readNpcObservation } = require('../src/core/live-npc-state.cjs');
const { projectCompletionRequirements } = require('../scripts/quest-completion-data.cjs');
const world = require('../src/data/world-index.json'),
  game = require('../src/data/game-index.json');
const guide = require('../src/data/flow-guide.cjs');
const task = (id) => world.quests.find((row) => row.gameId === id);
const reference = (id, extra = {}) => ({
  name: '1.sav',
  hash: 'synthetic',
  metadata: {
    quests: [
      { id: task(id).parentId, step: 1 },
      { id, step: 1 },
    ],
    ...extra,
  },
});
const selected = { id: 'synthetic-completion', referenceMode: 'latest' };
const projector = createTaskTargetProjector(world);
const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
const helpers = {
  esc,
  act: (action, label, _class, id) =>
    `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  pill: esc,
  when: esc,
  icon: () => '',
  picture: () => '',
  iconButton: () => '',
  notice: esc,
  empty: esc,
};

test('the shipped completion projection preserves enemy groups, party identities and distinct gift qualities', () => {
  assert.equal(world.quests.filter((row) => row.finishingRequirements?.length).length, 137);
  assert.equal(
    world.quests.filter((row) => row.finishingRequirements?.some((r) => r.type !== 'Item')).length,
    39,
  );
  assert.deepEqual(
    task(6259).finishingRequirements.map((row) => [row.name, row.value]),
    [
      ['雷山海盗', 10],
      ['横刀贼-张破帆', 1],
    ],
  );
  assert.deepEqual(
    task(11924).finishingRequirements.map((row) => row.id),
    [11708, 10268],
  );
  assert.deepEqual(
    task(12407).finishingRequirements[0].alternatives.map((row) => [row.id, row.quality]),
    [
      [1003, '白'],
      [1004, '绿'],
      [1005, '蓝'],
    ],
  );
});

test('the builder retains a hidden condition identity and uses its public owner only for navigation', () => {
  const rows = projectCompletionRequirements([{ Type: 'ERequirementType::PreQuest', Id: 51, Num: 4 }], {
    quests: new Map([
      [51, { QuestId: 51, OwnerQuestId: 50, Name: '' }],
      [50, { QuestId: 50, Name: '【支线】访友' }],
    ]),
    published: new Set([50]),
    npcNames: new Map(),
    items: new Map(),
    itemGroups: new Map(),
    npcGroups: new Map(),
    guilds: new Map(),
  });
  assert.equal(rows[0].id, 51);
  assert.equal(rows[0].entityId, 'quest-50');
  assert.equal(rows[0].name, '访友相关进度');
  assert.equal(completionChecks(rows, { quests: [{ id: 50, step: 4 }] })[0].status, 'unknown');
  assert.equal(
    completionChecks(rows, {
      quests: [
        { id: 51, step: 1 },
        { id: 50, step: 4 },
      ],
    })[0].status,
    'unmet',
  );
});

test('primary money finishing thresholds reject exact equality and cannot offer a premature hand-in', () => {
  for (const [id, threshold] of [
    [12412, 3000],
    [17009, 100000],
  ]) {
    const cash = task(id).finishingRequirements.filter((row) => row.type === 'Money');
    for (const money of [threshold - 1, threshold, threshold + 1]) {
      const reading = { money, inventory: task(id).materials || [] };
      const before = structuredClone(reading);
      const result = completionChecks(cash, reading)[0];
      assert.equal(result.status, money > threshold ? 'met' : 'unmet');
      if (money === threshold) assert.equal(result.hint, '还需 1 文');
      const target = projector.project(task(id), reading);
      if (id === 17009) assert.equal(target.materialState, money > threshold ? 'ready' : 'missing');
      assert.deepEqual(reading, before);
    }
    assert.equal(completionChecks(cash, {})[0].status, 'unknown');
  }
});

test('an active step uses completion conditions instead of making historical pickup money a current blocker', () => {
  const active = { ...task(11878), requirements: [{ type: 'Money', id: 0, value: 1000000, name: '铜钱' }] };
  const projection = createFlowProjector({
    world: { ...world, quests: world.quests.map((row) => (row.gameId === active.gameId ? active : row)) },
    game,
    guide,
  });
  const ref = reference(11878, { money: 0, inventory: active.materials, teamIds: [10047] });
  const flow = projection.flowSnapshot(selected, ref);
  const step = flow.active.flatMap((row) => row.steps).find((row) => row.id === active.id);
  assert.deepEqual(step.requirements, []);
  assert.equal(step.completionRequirements[0].type, 'TeamMember');
  assert.equal(step.completionRequirements[0].status, 'met');
  assert.equal(step.targets.materialState, 'ready');
  assert.doesNotMatch(step.nextAction, /铜钱|1000000/);
});

test('alternative hand-ins accept a permitted item, disclose each quality and never count an unrelated sword', () => {
  const requirement = task(12407).finishingRequirements;
  for (const inventory of [[], [{ id: 1002, count: 9 }]]) {
    const checks = completionChecks(requirement, { inventory });
    assert.equal(checks[0].status, 'unmet');
    assert.match(projector.project(task(12407), { inventory }).conditionHint, /任一种/);
  }
  const result = completionChecks(requirement, { inventory: [{ id: 1004, count: 1 }] })[0];
  assert.equal(result.status, 'met');
  assert.deepEqual(
    result.alternatives.map((row) => row.owned),
    [0, 1, 0],
  );
  assert.equal(completionChecks(requirement, {})[0].alternatives[0].owned, null);
  const ready = projector.project(task(12407), { inventory: [{ id: 1004, count: 1 }] });
  assert.equal(ready.nextAction, '向莫问交付');
  assert.deepEqual(
    ready.people.map((row) => row.ids),
    [[5015]],
  );
  assert(
    !ready.places.some((place) => place.name === '平康城'),
    'a buying clue is never a hand-in destination',
  );
  const spent = projector.project(task(12407), { inventory: [] });
  assert.notEqual(spent.nextAction, ready.nextAction);
  assert(
    spent.places.some((place) => place.name === '平康城'),
    'buying clues return after the item is used',
  );
});

test('item hover labels current observed stock and saved stock according to the selected reading', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const refs = createEntityReferences({ ...helpers, index: () => encyclopedia() });
  const metadata = { inventory: [{ id: 10181, count: 7 }] };
  const observed = refs.preview('item-10181', { reference: { origin: 'live', metadata } });
  assert.match(observed, /当前持有 7/);
  assert.doesNotMatch(observed, /保存持有/);
  assert.match(refs.preview('item-10181', { reference: { name: '1.sav', metadata } }), /保存持有 7/);
});

test('unread counters and contribution remain named objectives without guessed counts or an inferred complete state', () => {
  for (const id of [5243, 6259, 5768]) {
    const checks = completionChecks(task(id).finishingRequirements, {
      money: 999999,
      inventory: [],
      quests: [{ id, step: 1, progress: [{ count: 99999 }] }],
    });
    assert(checks.every((row) => row.status === 'unknown'));
    assert(checks.every((row) => !Object.hasOwn(row, 'owned')));
    assert(checks.every((row) => !/GuildHonor|KillMonster|记录 #|人物 #/.test(row.text)));
  }
});

test('fresh observed inventory flows into current material checks and codex while fixed saves stay isolated', () => {
  const id = 17009,
    itemId = task(id).materials[0].id;
  const old = reference(id, { money: 100001, inventory: [{ id: itemId, count: 1 }] });
  const npc = (inventory) => ({
    id: 0,
    rawFriendliness: 0,
    visible: true,
    mapKey: 'LV_37_P',
    guildId: 1,
    skillPoints: 0,
    skills: [],
    inventory,
    attributes: {
      5: 15,
      44: 100,
      27: 1,
      48: 1,
      61: 1,
      63: 1,
      65: 1,
      67: 1,
      9: 100,
      10: 10,
      14: 20,
      11: 100,
      12: 10,
      2: 1000,
      4: 800,
    },
  });
  for (const count of [0, 1]) {
    const observed = readNpcObservation(
      {
        schema: 1,
        world: 'World /Synthetic.LV_37_P',
        pawn: 'Pawn Synthetic',
        sampledAt: 1800000000,
        quests: old.metadata.quests,
        npcs: [npc(count ? [{ id: itemId, count }] : [])],
      },
      { world: 'World /Synthetic.LV_37_P', pawn: 'Pawn Synthetic', now: 1800000000000 },
    );
    assert(observed);
    const flow = flowSnapshot(selected, old, '', { npcState: observed });
    const step = flow.active.flatMap((row) => row.steps).find((row) => row.id === 'quest-' + id);
    assert.equal(step.materials[0].owned, count);
    assert.equal(
      step.targets.materialState,
      count ? 'unknown' : 'missing',
      'fresh items do not supply unobserved money',
    );
    assert.equal(
      flow.liveReference.metadata.inventory.reduce((sum, row) => sum + row.count, 0),
      count,
    );
    assert.equal(
      completionChecks(task(id).finishingRequirements, flow.liveReference.metadata).find(
        (row) => row.type === 'Item',
      ).status,
      count ? 'met' : 'unmet',
    );
    const fixed = flowSnapshot({ ...selected, referenceMode: 'slot', saveSlot: '1.sav' }, old, '', {
      npcState: observed,
    });
    assert.equal(fixed.stateOrigin, 'saved');
    assert.equal(fixed.liveReference, null);
    assert.equal(
      fixed.active.flatMap((row) => row.steps).find((row) => row.id === 'quest-' + id).targets.materialState,
      'ready',
    );
  }
  assert.equal(old.metadata.inventory[0].count, 1);
});

test('flow and task codex expose the same completion requirements in disclosures without duplicating item rows', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia();
  const ref = reference(17009, { money: 100000, inventory: task(17009).materials });
  const flow = flowSnapshot(selected, ref);
  const compact = createFlowViews(helpers).panel(flow, { compact: true });
  assert.match(compact, /还需 1 文/);
  assert.match(compact, /完成条件[\s\S]*铜钱至少 100,001 文[\s\S]*未满足/);
  assert.doesNotMatch(compact.match(/完成条件[\s\S]*?<\/ul>/)?.[0] || '', /夜明珠/);
  const views = createWorldViews(helpers);
  const details = views.questDetail(index, 'quest-17009', { reference: ref }, false);
  assert.match(
    details,
    /data-quest-completion[^>]*><summary>完成条件<\/summary>[\s\S]*100,001 文[\s\S]*未满足/,
  );
  assert.doesNotMatch(details.match(/data-quest-completion[\s\S]*?<\/details>/)?.[0] || '', /夜明珠/);
  const closed = structuredClone(ref);
  closed.metadata.quests[1].step = 4;
  const historical =
    views
      .questDetail(index, 'quest-17009', { reference: closed }, false)
      .match(/data-quest-completion[\s\S]*?<\/details>/)?.[0] || '';
  assert.match(historical, /100,001 文/);
  assert.doesNotMatch(historical, /未满足|未确认|已满足/);
});
