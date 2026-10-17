'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { resourcePriorityPreview } = require('../src/core/resource-priority.cjs');
const { giftPersonLabel } = require('../src/core/gift-labels.cjs');
const { emptyJourneyState } = require('../src/core/journey-state.cjs');
const index = require('../src/core/game-data.cjs').encyclopedia();
const gift = (npcId, id, quantity = 1) => ({
  id,
  npcId,
  itemId: 'item-134',
  quantity,
  note: '',
  done: false,
});
const profile = (gifts) => ({
  id: 'synthetic-budget',
  goals: [],
  referenceMode: 'latest',
  journey: { ...emptyJourneyState(), gifts },
});
const reference = (count) => ({
  name: '1.sav',
  hash: 'a'.repeat(64),
  modifiedAt: '2026-10-16T00:00:00Z',
  metadata: { inventory: [{ id: 134, count }] },
});

test('every indexed recipient keeps a nonempty exact identity in allocation labels, including world-only NPC forms', () => {
  const people = index.entries.filter((entry) => entry.kind === '人物');
  assert(people.length >= 452);
  for (let first = 0; first < people.length; first += 100) {
    const batch = people.slice(first, first + 100);
    const input = profile(batch.map((person) => gift(person.id, 'gift-' + person.gameId)));
    const before = structuredClone(input);
    const budget = resourceBudget(input, reference(100));
    for (const person of batch) {
      const owner = budget.priorityOwners.find((row) => row.gift.npcId === person.id);
      assert.equal(owner.gift.npcName, giftPersonLabel(person, index.entries));
      assert(owner.gift.npcName.length > 0);
      assert(owner.name.includes(person.name));
      assert.equal(owner.gift.itemName, '武学笔记（绿色品质）');
    }
    assert.deepEqual(input, before);
  }
  const input = profile([gift('npc-9001', 'wan')]);
  assert.equal(resourceBudget(input, reference(1)).priorityOwners[0].gift.npcName, '万花红');
});

test('shared-stock reordering preserves named recipient links and exact quantities in before and after previews', async () => {
  const input = profile([gift('npc-9001', 'a-wan', 2), gift('npc-5011', 'b-other', 2)]),
    saved = reference(3);
  const before = structuredClone({ input, saved });
  const budget = resourceBudget(input, saved);
  const result = resourcePriorityPreview(
    input,
    saved,
    [...budget.priorityOwners].reverse().map((row) => row.id),
  );
  const named = result.changes.find((row) => row.gift?.npcId === 'npc-9001');
  assert.equal(named.gift.npcName, '万花红');
  assert.equal(named.items.find((row) => row.id === 134).beforeDirect, 2);
  assert.equal(named.items.find((row) => row.id === 134).afterDirect, 1);
  const { createResourcePriorityViews } = await import(
    pathToFileURL(path.join(root, 'src/renderer/resource-priority-views.js')).href
  );
  const view = createResourcePriorityViews({
    esc: (value) => String(value ?? ''),
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    notice: String,
    when: String,
    getIndex: () => index,
  });
  const html = view.editor({ preview: result, order: result.afterOrder, loading: false }, index);
  assert.match(html, /data-id="npc-9001">万花红<\/button>/);
  assert.doesNotMatch(html, /data-id="npc-9001"><\/button>|赠予 ·/);
  assert.deepEqual({ input, saved }, before);
});

test('same-name and world-only people keep one identity through saved plans, new history and journal choices', async () => {
  const { journeyPlan } = require('../src/core/journey-plan.cjs');
  const { appendSystemEvent } = require('../src/core/event-journal.cjs');
  const { journalReferenceChoices } = await import(
    pathToFileURL(path.join(root, 'src/renderer/event-journal-views.js')).href
  );
  const people = index.entries.filter((row) => row.kind === '人物');
  const originalIds = new Set(require('../src/data/game-index.json').entries.map((row) => row.id));
  const selected = people.filter(
    (row) =>
      !originalIds.has(row.id) || people.some((other) => other.id !== row.id && other.name === row.name),
  );
  assert(selected.length >= 50);
  for (const person of selected) {
    const input = profile([gift(person.id, 'exact-person')]);
    const before = structuredClone(input);
    const saved = reference(1),
      expected = giftPersonLabel(person, index.entries);
    const action = journeyPlan(input, saved, resourceBudget(input, saved)).actions.find(
      (row) => row.kind === 'gift',
    );
    assert(action.title.startsWith('赠礼意图：' + expected + ' · '), person.id);
    assert.equal(
      journalReferenceChoices(input, index, 'exact-person').find((row) => row.type === 'gift').label,
      expected + ' · 武学笔记（绿色品质） × 1',
      person.id,
    );
    const completed = structuredClone(input);
    completed.journey.gifts[0].done = true;
    const history = appendSystemEvent(
      [],
      { type: 'gift', id: 'exact-person', beforeDone: false, afterDone: true },
      { profile: completed, game: index, world: index.world },
      { now: '2026-10-18T00:00:00Z', id: 'identity-event' },
    );
    assert(history[0].title.includes(expected), person.id);
    assert.equal(
      history[0].links.find((row) => row.type === 'gift').label,
      expected + ' · 武学笔记（绿色品质） × 1',
      person.id,
    );
    assert.deepEqual(input, before);
  }
});
