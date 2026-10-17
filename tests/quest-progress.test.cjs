'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { questSection, syntheticSave } = require('./fixtures.cjs');
const { readQuestSpecs, readMetadata } = require('../src/core/save-reader.cjs');
const { enrich, encyclopedia } = require('../src/core/game-data.cjs');
const { completionChecks } = require('../src/shared/task-completion.mjs');
const { createTaskTargetProjector } = require('../src/core/task-targets.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { readNpcObservation } = require('../src/core/live-npc-state.cjs');
const world = require('../src/data/world-index.json');
const targets = createTaskTargetProjector(world, require('../src/data/material-guide.cjs').items);
const quest = (id) => world.quests.find((q) => q.gameId === id);
const counter = (type, id, value) => ({ type, id, value });
const record = (id, progress, step = 1) => ({ id, step, progress });
function reading(id, progress) {
  const q = quest(id);
  return enrich(
    readMetadata(
      syntheticSave({
        full: true,
        quests: [...(q.parentId ? [{ id: q.parentId, step: 1 }] : []), record(id, progress)],
      }),
      { details: true },
    ),
  );
}

test('the actual packed progress row is enum-byte, signed Id and IEEE float, without changing source bytes', () => {
  const bytes = questSection([record(14066, [counter(22, 45045, 3)])]);
  const before = Buffer.from(bytes);
  // Independent literal: 16 f5 af 00 00 00 00 40 40 = KillMonster,45045,3.0f.
  const literal = Buffer.from('16f5af000000004040', 'hex');
  assert(bytes.includes(literal));
  assert.deepEqual(readQuestSpecs(bytes, 0, bytes.length), [record(14066, [counter(22, 45045, 3)])]);
  assert.deepEqual(bytes, before);
  assert.equal(readQuestSpecs(bytes, 0, bytes.length - 1), null);
});

test('ambiguous or invalid counters are omitted while old quest-state metadata stays usable', () => {
  for (const rows of [
    [counter(22, 45045, NaN)],
    [counter(22, 45045, Infinity)],
    [counter(22, 45045, -1)],
    [counter(22, 45045, 1), counter(22, 45045, 5)],
    [counter(255, 45045, 3)],
    [counter(22, -1, 3)],
  ]) {
    const bytes = questSection([record(14066, rows)]);
    assert.deepEqual(readQuestSpecs(bytes, 0, bytes.length), [{ id: 14066, step: 1 }]);
  }
  const rows = Array.from({ length: 1000 }, (_, id) => counter(22, id, 0));
  const bytes = questSection(Array.from({ length: 101 }, (_, id) => record(id + 1, rows)));
  const result = readQuestSpecs(bytes, 0, bytes.length);
  assert.equal(result.length, 101);
  assert.equal(result[99].progress.length, 1000);
  assert.equal(result[100].progress, undefined, 'global counter budget does not erase basic quest state');
});

test('enrichment preserves independent counters even for hidden steps, without aliasing source rows', () => {
  const raw = { quests: [record(987654, [counter(22, 45045, 3)])] };
  const value = enrich(raw);
  assert.deepEqual(value.questStates, raw.quests);
  value.questStates[0].progress[0].value = 4;
  assert.equal(raw.quests[0].progress[0].value, 3);
});

test('completion matches current quest, requirement type and exact group Id, not lifetime or member kills', () => {
  const requirement = quest(11132).finishingRequirements;
  const checks = (states) => completionChecks(requirement, { questStates: states }, 11132)[0];
  for (const states of [
    [],
    [record(11132, [])],
    [record(12022, [counter(25, 3, 99)])],
    [record(11132, [counter(22, 3, 99)])],
    [record(11132, [counter(22, 45331, 99)])],
    [record(11132, [counter(25, 3, 2.5)])],
    [record(11132, [counter(25, 3, 5)], 4)],
    [record(11132, [counter(25, 3, 1), counter(25, 3, 5)])],
  ]) {
    assert.equal(checks(states).status, 'unknown');
    assert.equal(checks(states).progress, undefined);
  }
  const partial = checks([record(11132, [counter(25, 3, 2)])]);
  assert.equal(partial.status, 'unmet');
  assert.deepEqual(partial.progress, { current: 2, total: 5, remaining: 3 });
  assert.equal(checks([record(11132, [counter(25, 3, 0)])]).progress.current, 0);
  assert.equal(checks([record(11132, [counter(25, 3, 7)])]).status, 'met');
});

test('all eighteen published kill objectives use their own quest-local counters', () => {
  let count = 0;
  for (const q of world.quests.filter((q) =>
    q.finishingRequirements?.some((r) => r.type.startsWith('KillMonster')),
  )) {
    const rows = q.finishingRequirements.map((r) =>
      counter(r.type === 'KillMonster' ? 22 : 25, r.id, r.value),
    );
    const current = completionChecks(q.finishingRequirements, { quests: [record(q.gameId, rows)] }, q.gameId);
    assert(
      current.every((r) => r.status === 'met'),
      q.id,
    );
    count += current.length;
  }
  assert.equal(count, 18);
});

test('partial hunt shows remaining objectives; all objectives switch to the bound recipient and clear hunting destinations', () => {
  let state = reading(6259, [counter(25, 4, 10), counter(22, 45240, 0)]);
  let result = targets.project(quest(6259), state);
  assert.match(result.nextAction, /张破帆.*0\/1/);
  assert.doesNotMatch(
    result.nextAction,
    /雷山海盗/,
    'already completed objective is folded away from the current action',
  );
  assert.notEqual(result.actionState, 'ready');
  state = reading(6259, [counter(25, 4, 10), counter(22, 45240, 1)]);
  result = targets.project(quest(6259), state);
  assert.equal(result.nextAction, '找清霄道长回报');
  assert.equal(result.actionState, 'ready');
  assert.deepEqual(
    result.people.map((p) => p.id),
    ['npc-5006'],
  );
  assert(!result.places.some((p) => p.name === '雷山'));
  assert.equal(
    targets.project(quest(11936), reading(11936, [counter(25, 5, 5)])).nextAction,
    '目标已达成，继续任务',
  );
  result = targets.project(quest(12022), reading(12022, [counter(25, 3, 5)]));
  assert.notEqual(result.actionState, 'ready', 'an unobserved party requirement still blocks readiness');
  assert.match(result.nextAction, /白锦/);
});

test('saved flow, task hover target and codex share counters; historical task rows do not show current badges', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const metadata = reading(14066, [counter(22, 45045, 3)]);
  const reference = { name: '1.sav', hash: 'a'.repeat(64), modifiedAt: new Date().toISOString(), metadata };
  const flow = flowSnapshot({ referenceMode: 'latest', goals: [] }, reference);
  const step = flow.active.flatMap((q) => q.steps).find((q) => q.id === 'quest-14066');
  assert.match(step.nextAction, /野猪.*3\/5/);
  assert.deepEqual(step.completionRequirements[0].progress, { current: 3, total: 5, remaining: 2 });
  assert(
    !flow.advice.some((row) => row.id === 'early-wudang-boars'),
    'accepted hunt does not repeat pickup advice',
  );
  assert(
    flow.guide.some((row) => row.id === 'early-wudang-boars'),
    'full guide remains queryable',
  );
  const esc = (s) =>
    String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  const helpers = {
    esc,
    pill: (s) => `<i>${esc(s)}</i>`,
    act: (_a, s) => `<button>${s}</button>`,
    iconButton: () => '',
    picture: () => '',
    icon: () => '',
    notice: esc,
    empty: esc,
  };
  const html = createFlowViews(helpers).panel(flow, { compact: true });
  assert.match(html, /3 \/ 5/);
  const codex = createWorldViews(helpers);
  let detail = codex.questDetail(encyclopedia(), 'quest-14066', { reference }, false);
  assert.match(detail, /data-quest-completion[\s\S]*3 \/ 5/);
  metadata.questStates.find((q) => q.id === 14066).step = 4;
  metadata.quests.find((q) => q.id === 14066).step = 4;
  detail = codex.questDetail(encyclopedia(), 'quest-14066', { reference }, false);
  assert.doesNotMatch(detail.match(/data-quest-completion[\s\S]*?<\/details>/)?.[0] || '', /3 \/ 5/);
});

test('live current counters replace saved values, missing live counters stay unknown, fixed/history stays isolated', () => {
  const old = { name: '1.sav', hash: 'a'.repeat(64), metadata: reading(14066, [counter(22, 45045, 5)]) };
  const player = {
    id: 0,
    rawFriendliness: 0,
    visible: true,
    mapKey: 'LV_25_P',
    guildId: 1,
    skillPoints: 0,
    skills: [],
    inventory: [],
    attributes: Object.fromEntries(
      [5, 27, 48, 61, 63, 65, 67, 44, 9, 10, 14, 11, 12, 2, 4].map((key) => [key, 10]),
    ),
  };
  const packet = {
    schema: 1,
    sampledAt: 1800000000,
    world: 'World /Synthetic.LV_25_P',
    pawn: 'Pawn Synthetic',
    quests: [record(14066, [counter(22, 45045, 2)])],
    npcs: [player],
  };
  const observed = () =>
    readNpcObservation(packet, { world: packet.world, pawn: packet.pawn, now: 1800000000000 });
  let live = observed();
  assert(live);
  let flow = flowSnapshot({ referenceMode: 'latest' }, old, '', { npcState: live });
  let step = flow.active.flatMap((q) => q.steps).find((q) => q.id === 'quest-14066');
  assert.equal(step.completionRequirements[0].progress.current, 2);
  assert.equal(flow.liveReference.metadata.quests[0].progress[0].value, 2);
  packet.quests[0].progress = [];
  flow = flowSnapshot({ referenceMode: 'latest' }, old, '', { npcState: observed() });
  step = flow.active.flatMap((q) => q.steps).find((q) => q.id === 'quest-14066');
  assert.equal(step.completionRequirements[0].status, 'unknown');
  const fixed = flowSnapshot({ referenceMode: 'slot', saveSlot: '1.sav' }, old, '', { npcState: live });
  assert.equal(fixed.stateOrigin, 'saved');
  assert.equal(
    fixed.active.flatMap((q) => q.steps).find((q) => q.id === 'quest-14066').completionRequirements[0]
      .progress.current,
    5,
  );
  assert.equal(old.metadata.questStates.find((q) => q.id === 14066).progress[0].value, 5);
  for (const invalid of [counter(22, 45045, NaN), counter(255, 45045, 1), counter(22, 45045, -1)]) {
    packet.quests[0].progress = [invalid];
    assert.equal(observed(), null);
  }
});
