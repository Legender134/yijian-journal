'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const world = require('../src/data/world-index.json');
const { flowSnapshot } = require('../src/core/flow.cjs');
const quests = new Map(world.quests.map((q) => [q.gameId, q]));
const parents = new Set(world.quests.map((q) => q.parentId));
const profile = { id: 'synthetic-player-coverage', referenceMode: 'latest' };
function rootOf(q) {
  const seen = new Set();
  while (q?.parentId && !seen.has(q.gameId)) {
    seen.add(q.gameId);
    const parent = quests.get(q.parentId);
    if (!parent) return null;
    q = parent;
  }
  return q;
}
const mainRoots = world.quests.filter(
  (q) => q.kind === 'Primary' && !q.parentId && !q.name.includes('试玩版'),
);
test('every formal main root retains its own chapter, actionable step and identity without changing the synthetic progress', () => {
  assert.equal(world.build, '21798996');
  assert.equal(mainRoots.length, 59);
  const sections = new Set();
  for (const root of mainRoots) {
    const leaf =
      world.quests.find((q) => q.parentId && !parents.has(q.gameId) && rootOf(q)?.gameId === root.gameId) ||
      root;
    const metadata = {
      quests: [
        ...new Map([
          [root.gameId, 1],
          [leaf.gameId, 1],
        ]),
      ].map(([id, step]) => ({ id, step })),
      trackingMainQuest: root.gameId,
      trackingQuest: leaf.gameId,
      inventory: [],
    };
    const reference = { name: 'SYNTHETIC-NO-DISK.sav', hash: 'synthetic-' + root.gameId, metadata };
    const before = structuredClone(reference),
      flow = flowSnapshot(profile, reference);
    assert.equal(flow.available, true, root.name);
    assert.equal(flow.chapter?.questId, root.id, root.name + ' chapter identity');
    const current = flow.active.find((row) => row.gameId === root.gameId);
    assert(current, root.name + ' active task');
    assert.equal(current.id, root.id);
    assert(
      current.steps.some((step) => step.nextAction?.trim()),
      root.name + ' current action',
    );
    for (const step of current.steps)
      assert(quests.has(Number(step.id.slice(6))), root.name + ' uses a known step');
    sections.add(flow.chapter.name);
    assert.deepEqual(reference, before);
  }
  assert.equal(sections.size, 14);
});
test('missing progress cannot inherit the last chapter or advertise a current choice', () => {
  const known = {
    name: 'SYNTHETIC.sav',
    hash: 'one',
    metadata: {
      quests: [
        { id: 5820, step: 1 },
        { id: 5821, step: 4 },
      ],
      trackingMainQuest: 5820,
      inventory: [],
    },
  };
  assert.equal(flowSnapshot(profile, known).chapter.questId, 'quest-5820');
  const missing = flowSnapshot(profile, null);
  assert.equal(missing.available, false);
  assert.equal(missing.chapter, null);
  assert.deepEqual(missing.active, []);
  assert.deepEqual(missing.decisions, []);
  const empty = flowSnapshot(profile, {
    name: 'SYNTHETIC-EMPTY.sav',
    hash: 'two',
    metadata: { quests: [], inventory: [] },
  });
  assert.equal(empty.chapter, null);
  assert.deepEqual(empty.active, []);
  assert.deepEqual(empty.decisions, []);
});

test('short choice titles use verified instructions without replacing the underlying task description', () => {
  const flow = flowSnapshot(profile, {
    name: 'SYNTHETIC.sav',
    hash: 'instruction',
    metadata: {
      quests: [
        { id: 11079, step: 1 },
        { id: 11080, step: 1 },
      ],
      inventory: [],
    },
  });
  const current = flow.active
    .find((row) => row.gameId === 11079)
    .steps.find((row) => row.choiceStepId === 11080);
  assert.match(current.nextAction, /与铁匠交谈.*决定是否替他转交信物/);
  assert.notEqual(current.nextAction, current.name);
  assert.equal(current.description, quests.get(11080).description);
});
