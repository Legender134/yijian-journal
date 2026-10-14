'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { defaults } = require('../src/core/store.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const catalog = require('../src/data/catalog.cjs');
const recipe = require('../src/data/game-index.json').entries.find((e) => e.id === 'fusion-1002');
const views = import(pathToFileURL(path.join(__dirname, '../src/renderer/companion-view.js')).href);
function fixture() {
  const state = defaults(),
    p = state.profiles[0],
    at = '2026-10-09T00:00:00.000Z';
  p.referenceMode = 'latest';
  p.craftList = [{ id: recipe.id, quantity: 1 }];
  p.craftPlans = [
    {
      id: 'first',
      name: '尚未完成的一份',
      list: structuredClone(p.craftList),
      choices: {},
      reserved: true,
      done: false,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'second',
      name: '已做完的 <img> 第二份',
      list: structuredClone(p.craftList),
      choices: {},
      reserved: true,
      done: true,
      createdAt: at,
      updatedAt: at,
    },
  ];
  p.activeCraftPlanId = 'second';
  return {
    state,
    p,
    reference: {
      name: '1.sav',
      hash: 'a'.repeat(64),
      modifiedAt: at,
      metadata: { inventory: recipe.materials.map((m) => ({ id: m.id, count: m.count })), money: 999999 },
    },
  };
}
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
test('completed selected plan has an identified redo preview, leaves real demand unchanged and never urges passive material work', async () => {
  const { state, p, reference } = fixture();
  const snapshot = companionSnapshot(state, catalog, reference);
  assert.equal(snapshot.materialsLabel, p.craftPlans[1].name);
  assert.equal(snapshot.materialsCompleted, true);
  assert.equal(snapshot.allocations.missingTotal, 0);
  assert.ok(snapshot.materials.missing > 0, 'hypothetical redo competes with the real unfinished plan');
  assert.ok(
    snapshot.hints.every((h) => h.type !== 'material'),
    'completed plan must not become a passive instruction to gather',
  );
  const { createCompanionViews } = await views;
  const ui = createCompanionViews({
    esc,
    icon: () => '',
    act: () => '',
    picture: () => '',
    qualityText: { name: (_id, text) => esc(text) },
  });
  const html = ui.materials(snapshot);
  assert.match(html, /个人已制作完成/);
  assert.match(html, /下方仅供若重新制作时核对/);
  assert.match(html, /若重做：/);
  assert.match(html, /已做完的 &lt;img&gt; 第二份/);
  assert.doesNotMatch(html, /<img>/);
  const restarted = companionSnapshot(JSON.parse(JSON.stringify(state)), catalog, reference);
  assert.equal(restarted.materialsCompleted, true);
  assert.equal(restarted.materialsLabel, snapshot.materialsLabel);
});
test('reopening the same selected plan restores actionable demand and keeps independent recipe goals out of completed redo scope', () => {
  const { state, p, reference } = fixture();
  p.goals.push({
    id: 'independent-recipe',
    title: '独立制作目标',
    detail: '',
    done: false,
    source: { type: 'database', id: recipe.id, quantity: 7 },
  });
  const completed = companionSnapshot(state, catalog, reference);
  assert.equal(completed.materials.recipes[0].quantity, 1);
  assert.ok(completed.hints.some((h) => h.id === 'independent-recipe'));
  p.goals = [];
  p.craftPlans[1].done = false;
  const reopened = companionSnapshot(state, catalog, reference);
  assert.equal(reopened.materialsCompleted, false);
  assert.ok(reopened.allocations.missingTotal > 0);
  assert.ok(reopened.hints.some((h) => h.type === 'material'));
});

test('companion material summaries link exact items and expose every alternative without assigning the first identity to the group', async () => {
  const { createCompanionViews } = await views;
  const index = require('../src/data/game-index.json');
  const calls = [];
  const ui = createCompanionViews({
    esc,
    icon: () => '',
    act: (action, label, _class, id) => {
      calls.push({ action, label, id });
      return `<button data-action="${action}" data-id="${id}">${label}</button>`;
    },
    picture: () => '',
    qualityText: { name: (_id, text) => esc(text) },
    index: () => index,
  });
  const { state, reference } = fixture();
  ui.materials(companionSnapshot(state, catalog, reference));
  for (const material of recipe.materials)
    assert(calls.some((call) => call.action === 'database-detail' && call.id === `item-${material.id}`));
  calls.length = 0;
  const html = ui.materials({
    materials: {
      recipes: [],
      money: 0,
      materials: [{ ids: [10525, 10529], name: '<鱼类>', count: 3, missing: 3 }],
    },
  });
  assert.match(html, /<summary>&lt;鱼类&gt; · 可替代材料<\/summary>/);
  assert.doesNotMatch(html.match(/<summary>[\s\S]*?<\/summary>/)[0], /data-id/);
  assert.match(html, /不需要备齐每一种/);
  for (const id of [10525, 10529]) {
    const item = index.entries.find((entry) => entry.id === `item-${id}`);
    assert(calls.some((call) => call.id === item.id && call.label === item.name));
  }
});

async function actionViews() {
  const game = require('../src/data/game-index.json');
  const world = require('../src/data/world-index.json');
  const index = { ...game, world };
  const { createEntityReferences } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/entity-references.js')).href
  );
  const references = createEntityReferences({
    index: () => index,
    esc,
    picture: (id) => `<i data-picture="${id}"></i>`,
    icon: () => '',
    qualityText: { html: (_id, label) => label },
  });
  const ui = (await views).createCompanionViews({
    esc,
    icon: () => '',
    act: references.button,
    picture: () => '',
    qualityText: { name: (_id, label) => esc(label) },
    index: () => index,
  });
  return { ui, index };
}
function actionState() {
  const state = defaults();
  const profile = state.profiles[0];
  profile.referenceMode = 'none';
  profile.journey = require('../src/core/journey-state.cjs').emptyJourneyState();
  return { state, profile };
}
function assertEntity(html, id, action = 'database-detail') {
  assert.match(
    html,
    new RegExp(
      `class="[^"]*pictured-link entity-link[^"]*" data-action="${action}" data-id="${id}" data-entity-id="${id}"`,
    ),
  );
  assert(html.includes(`data-picture="${id}"`));
}
test('companion next actions retain exact task, recipe, output, collection, gift and scene identities', async () => {
  const { ui, index } = await actionViews();
  const cases = [
    [
      'quest',
      (p) =>
        p.goals.push({
          id: 'task',
          title: '任务目标',
          done: false,
          source: { type: 'quest', id: 'quest-12035' },
        }),
      ['quest-12035'],
    ],
    [
      'craft',
      (p) => {
        p.craftList = [{ id: recipe.id, quantity: 1 }];
      },
      [recipe.id, `item-${recipe.results[0].id}`],
    ],
    [
      'material',
      (p) => {
        p.craftList = [{ id: recipe.id, quantity: 1 }];
      },
      [`item-${recipe.materials[0].id}`],
    ],
    [
      'collection',
      (p) =>
        p.goals.push({
          id: 'collect',
          title: '自己的采买',
          done: false,
          source: { type: 'database', id: 'item-100', quantity: 2 },
        }),
      ['item-100'],
    ],
    [
      'place',
      (p) => p.journey.places.push({ placeId: 'place-9', note: '', done: false, favorite: false }),
      ['place-9'],
    ],
  ];
  const otherPerson = index.entries.find(
    (row) => row.kind === '人物' && row.id !== 'npc-5014' && row.hobbies?.length,
  );
  const otherItem = index.entries.find((row) => row.kind === '物品' && row.id !== 'item-100' && row.giftable);
  for (const [npcId, itemId, placeId] of [
    ['npc-5014', 'item-100', 'place-22'],
    [otherPerson.id, otherItem.id, 'place-10'],
  ]) {
    cases.push([
      'gift',
      (p) =>
        p.journey.gifts.push({ id: 'present', npcId, itemId, placeId, quantity: 2, note: '', done: false }),
      [npcId, itemId, placeId],
    ]);
  }
  for (const [kind, arrange, ids] of cases) {
    const { state, profile } = actionState();
    arrange(profile);
    const before = JSON.stringify(state);
    const snapshot = companionSnapshot(state, catalog, null);
    const action = snapshot.nextActions.find((row) => row.kind === kind);
    assert(action, kind);
    if (kind === 'quest') assert.equal(action.questId, ids[0]);
    if (kind === 'craft') assert.equal(action.recipeId, recipe.id);
    if (kind === 'place') assert.deepEqual(action.places[0].mapIds, ids);
    const html = ui.actions(snapshot);
    for (const id of ids)
      assertEntity(
        html,
        id,
        id.startsWith('quest-') ? 'world-quest' : id.startsWith('place-') ? 'world-place' : 'database-detail',
      );
    assert.equal(JSON.stringify(state), before, 'summary rendering does not persist derived identities');
  }
});
test('companion selected next and upcoming actions reuse exact identities while detached records stay plain', async () => {
  const { ui } = await actionViews();
  const { state, profile } = actionState();
  const { journeyPlan } = require('../src/core/journey-plan.cjs');
  const { applyJourneyCommand } = require('../src/core/journey-state.cjs');
  profile.journey.gifts.push({
    id: 'present',
    npcId: 'npc-5014',
    itemId: 'item-100',
    placeId: 'place-22',
    quantity: 2,
    note: '',
    done: false,
  });
  profile.goals.push({
    id: 'collect',
    title: '自己的采买',
    done: false,
    source: { type: 'database', id: 'item-10525', quantity: 2 },
  });
  profile.goals.push({
    id: 'task',
    title: '任务目标',
    done: false,
    source: { type: 'quest', id: 'quest-12035' },
  });
  profile.craftList = [{ id: recipe.id, quantity: 1 }];
  profile.journey.places.push({ placeId: 'place-9', note: '', done: false, favorite: false });
  const plan = journeyPlan(profile, null);
  for (const kind of ['gift', 'collection', 'quest', 'craft', 'place']) {
    const action = plan.actions.find((row) => row.kind === kind);
    profile.journey = applyJourneyCommand(
      profile.journey,
      {
        type: 'journey-itinerary-add',
        id: action.id,
        ...(kind === 'gift' ? { placeId: 'place-22' } : kind === 'place' ? { placeId: 'place-9' } : {}),
      },
      { actions: plan.actions },
    );
  }
  let snapshot = companionSnapshot(state, catalog, null);
  const html = ui.actions(snapshot);
  const queueAt = html.indexOf('<summary>后续队列');
  assert(queueAt > 0);
  for (const id of ['npc-5014', 'item-100', 'place-22'])
    assertEntity(html.slice(0, queueAt), id, id.startsWith('place-') ? 'world-place' : 'database-detail');
  for (const id of ['item-10525', 'quest-12035', recipe.id, 'place-9'])
    assertEntity(
      html.slice(queueAt),
      id,
      id.startsWith('quest-') ? 'world-quest' : id.startsWith('place-') ? 'world-place' : 'database-detail',
    );
  const oldTitle = snapshot.itinerary.next.selectedTitle;
  profile.journey.gifts = [];
  snapshot = companionSnapshot(state, catalog, null);
  assert.equal(snapshot.itinerary.next.action, null);
  const detached = ui.actions(snapshot).split('<summary>后续队列')[0];
  assert(detached.includes(esc(oldTitle)));
  assert.doesNotMatch(
    detached,
    /data-entity-id=/,
    'historical source pointers do not bind old text to current objects',
  );
});
test('summary identities never come from personal titles, unknown IDs or an alternative material group name', async () => {
  const { ui, index } = await actionViews();
  const { createJourneySummaryViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/journey-summary-views.js')).href
  );
  const { state, profile } = actionState();
  const person = index.entries.find((row) => row.id === 'npc-5014');
  const item = index.entries.find((row) => row.id === 'item-100');
  const title = `${person.name}、${item.name}、梧桐村 <img>`;
  profile.journey.todos.push({ id: 'personal', title, detail: '', placeId: 'place-10', done: false });
  profile.goals.push({ id: 'own-goal', title, done: false });
  const html = ui.actions(companionSnapshot(state, catalog, null));
  assert(html.includes(esc(title)));
  assert.doesNotMatch(html, /data-entity-id="(?:npc-|item-|name:)/);
  assertEntity(html, 'place-10', 'world-place');
  assert.doesNotMatch(html, /<img>/);
  const summary = createJourneySummaryViews({
    esc,
    act: (_a, label, _class, id) => `<b data-id="${id}">${label}</b>`,
    index,
  });
  const unknown = summary.actionTitle({ kind: 'quest', questId: 'quest-missing', title });
  assert.equal(unknown, esc(title));
  assert.equal(
    createJourneySummaryViews({
      esc,
      act: () => {
        throw Error('unknown data cannot link');
      },
    }).actionTitle({ kind: 'quest', questId: 'quest-12035', title }),
    esc(title),
  );
  const alternatives = summary.actionTitle({
    kind: 'material',
    title: '补充 2 份鱼类',
    material: { ids: [10525, 10529] },
  });
  assert.match(alternatives, /^补充 2 份鱼类（可替代：/);
  assert.match(alternatives, /data-id="item-10525"/);
  assert.match(alternatives, /data-id="item-10529"/);
  assert.equal(summary.places({ places: [{ name: '梧桐村', mapIds: ['place-missing'] }] }), '梧桐村');
  const samePlaceEvidence = summary.places({
    places: [
      { name: '梧桐村', mapIds: ['place-9', 'place-10'] },
      { name: '梧桐村', mapIds: ['place-9'] },
    ],
  });
  assert.equal((samePlaceEvidence.match(/data-id="place-9"/g) || []).length, 1);
  assert.equal((samePlaceEvidence.match(/data-id="place-10"/g) || []).length, 1);
  const collection = summary.actionTitle({
    kind: 'collection',
    title: `${item.name}是我的备注 · 收集目标：${item.name} × 2`,
    material: { ids: [item.gameId] },
  });
  assert(collection.startsWith(esc(`${item.name}是我的备注 · 收集目标：`)));
  assert.equal((collection.match(/data-id="item-100"/g) || []).length, 1);
});
