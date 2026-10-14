'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { readNpcObservation } = require('../src/core/live-npc-state.cjs');
const profile = { id: 'live-npc', referenceMode: 'latest' };
const saved = {
  name: '1.sav',
  hash: 'synthetic',
  modifiedAt: '2026-10-14T00:00:00Z',
  metadata: {
    quests: [{ id: 5020, step: 1 }],
    inventory: [{ id: 100034, count: 99 }],
    map: 'LV_25_P',
    mapName: '梧桐村',
  },
};
const npc = (id, rawFriendliness = 70) => ({
  id,
  rawFriendliness,
  visible: true,
  mapKey: 'LV_26_P',
  guildId: 0,
  skillPoints: 500,
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
  inventory: [{ id: 100034, count: 1 }],
  skills: [],
});
const observation = (friend = 70, extraQuests = []) =>
  readNpcObservation(
    {
      schema: 1,
      world: 'World /Synthetic.LV_26_P',
      pawn: 'Pawn Synthetic',
      sampledAt: 1800000000,
      quests: [
        { id: 12071, step: 4 },
        { id: 12075, step: 4 },
        { id: 12090, step: 1 },
        { id: 12094, step: 1 },
        { id: 11272, step: 1 },
        ...extraQuests,
      ],
      npcs: [npc(0), npc(10221, friend)],
    },
    { world: 'World /Synthetic.LV_26_P', pawn: 'Pawn Synthetic', now: 1800000000000 },
  );
test('nonlinear future checkpoint uses actual same-cohort affinity and active affected tasks', () => {
  for (const [friend, phrase] of [
    [69, /低于 70/],
    [70, /取胜会让他离场.*线索也会失败/],
    [90, /取胜会让他离场/],
  ]) {
    const flow = flowSnapshot(profile, saved, '', {
      dialogue: null,
      suppressedQuestIds: [],
      npcState: observation(friend),
    });
    assert.equal(flow.stateOrigin, 'live');
    assert.equal(flow.duels.progress.origin, 'live');
    assert.match(flow.guide.find((r) => r.id === 'chenlinxi-recruit-followup').warning, phrase);
    assert(
      !flow.active.some((r) => r.gameId === 5020),
      'old saved route cannot leak into current quest cohort',
    );
    const chen = flow.duels.progress.people.find((r) => r.npcId === 10221);
    assert.equal(chen.friendship.value, friend);
    assert.equal(
      chen.remainingItems[0].owned,
      null,
      'saved player holdings cannot masquerade as live holdings',
    );
  }
  const branched = flowSnapshot(profile, saved, '', { npcState: observation(90, [{ id: 12095, step: 1 }]) });
  assert(
    !branched.advice.some((r) => r.id === 'chenlinxi-recruit-followup'),
    'resolved branch retires its pre-branch advice',
  );
});
test('historical lookup suppresses live NPC and route projection; withdrawal returns to saved state', () => {
  const fixed = flowSnapshot({ ...profile, referenceMode: 'slot', saveSlot: '1.sav' }, saved, '', {
    npcState: observation(),
  });
  assert.equal(fixed.stateOrigin, 'saved');
  assert(!fixed.duels.progress.available);
  const withdrawn = flowSnapshot(profile, saved, '', { dialogue: null });
  assert.equal(withdrawn.stateOrigin, 'saved');
  assert(withdrawn.active.some((r) => r.gameId === 5020));
});

test('current checkpoint consequences are visible before disclosure in both windows', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const view = createFlowViews({
    esc: String,
    icon: () => '',
    pill: String,
    when: String,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
  });
  const id = 'chenlinxi-recruit-followup';
  for (const [friend, affectedStep, expected] of [
    [69, 1, /好感 69.*低于 70.*保留人物.*赠礼可能改变结果/],
    [70, 1, /好感 70.*取胜会让他离场.*线索也会失败.*先不要推进/],
    [90, 1, /好感 90.*取胜会让他离场.*线索也会失败/],
    [90, 4, /好感 90.*取胜会让他离场/],
    [null, 1, /先核对.*达到 70.*取胜会让他离场.*线索也会失败/],
  ]) {
    const observed = observation(friend ?? 70);
    if (friend === null) observed.npcStates = [];
    observed.questStates.find((row) => row.id === 11272).step = affectedStep;
    const flow = flowSnapshot(profile, saved, '', { npcState: observed });
    assert(flow.warnings.some((row) => row.id === id));
    assert(!flow.advice.some((row) => row.id === id));
    for (const compact of [false, true]) {
      const html = view.panel(flow, { compact });
      const start = html.indexOf(
        compact ? `data-persist-detail="flow-risk-window-${id}"` : `data-flow-warning="${id}"`,
      );
      assert(start > 0);
      const visible = html.slice(start, html.indexOf(compact ? '</summary>' : '<details', start));
      assert.match(visible, expected);
      assert.doesNotMatch(visible, /再在武馆与他对话/);
      if (affectedStep === 4) assert.doesNotMatch(visible, /线索也会失败/);
    }
  }
  for (const branch of [12095, 12098]) {
    const flow = flowSnapshot(profile, saved, '', { npcState: observation(90, [{ id: branch, step: 1 }]) });
    assert(!flow.warnings.some((row) => row.id === id));
    assert(!flow.advice.some((row) => row.id === id));
  }
  const fixed = flowSnapshot({ ...profile, referenceMode: 'slot', saveSlot: '1.sav' }, saved, '', {
    npcState: observation(90),
  });
  assert(!fixed.warnings.some((row) => row.id === id), 'fixed save cannot inherit a live checkpoint');
});

test('a live flow without any readable save preserves its cohort through actual namesake navigation', async () => {
  const fs = require('node:fs'),
    path = require('node:path'),
    vm = require('node:vm');
  const { encyclopedia } = require('../src/core/game-data.cjs');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { handbookContext } = require('../src/core/handbook-context.cjs');
  const index = encyclopedia();
  const references = createEntityReferences({
    index: () => index,
    esc: String,
    picture: () => '',
    icon: () => '',
    qualityText: { html: (_e, value) => value },
  });
  const choices = references.choices('name:武当');
  assert(choices.length > 1);
  const place = index.world.maps.find((row) => row.id === choices[0].id);
  const observed = {
    ...observation(),
    key: 'no-save-cohort',
    world: 'World /Synthetic.' + place.key,
    player: { ...observation().player, mapKey: place.key },
  };
  const flow = flowSnapshot(profile, null, '', { npcState: observed });
  assert.equal(flow.available, true);
  assert.equal(flow.reference.origin, 'live');
  assert.equal(flow.reference.name, undefined);
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const ctx = {
    currentDrawer: null,
    drawerHistory: [],
    referenceSave: null,
    referenceSaveName: undefined,
    referenceFollow: true,
    detailRequest: 0,
    handbookRequest: 0,
    entityReferences: references,
    defaultFollow: () => true,
    defaultReference: () => '',
    latestReference: () => '',
    currentFlow: () => flow,
    profile: () => profile,
    act: () => '',
    esc: String,
    iconButton: () => '',
    showOverlay() {},
    rememberDrawer(view) {
      ctx.currentDrawer = view;
    },
    worldView: {},
    placeMapScopes: new Map(),
    call: async () => assert.fail('there is no save to read'),
    route: 'duels',
    query: '',
    databaseKind: '全部',
    databaseType: '全部',
    databasePage: 0,
    recipeQuantity: () => 1,
    handbookPresentation: () => null,
    overlay: { querySelector: () => null },
    restoreHandbookPresentation() {},
    showWorldDetail: async (_id, _type, _replace, view) =>
      (ctx.currentDrawer = { type: 'world-place', ...view }),
  };
  vm.createContext(ctx);
  vm.runInContext(
    [
      part('async function showEntityChoice(', 'function captureDetailFolds('),
      part('function handbookReadingContext(', 'async function receiveHandbookContext('),
      part('async function openHandbookDetail(', 'function recipeDiscoveryPage('),
      "this.choose=async(id,target)=>{switch('entity-choice'){" +
        part("    case 'entity-choice':", "    case 'archive-entity': {") +
        '}};',
    ].join('\n'),
    ctx,
  );
  await ctx.choose('name:武当', { closest: () => ({}) });
  assert.equal(ctx.currentDrawer.liveContext, true);
  assert.equal(ctx.currentDrawer.reference, flow.liveReference);
  assert.match(references.choiceSummary(choices[0], choices, ctx.currentDrawer.reference), /当前地点/);
  const wire = handbookContext(ctx.handbookReadingContext());
  assert.equal(wire.reference.live, true);
  await ctx.openHandbookDetail(wire);
  assert.equal(ctx.currentDrawer.reference, flow.liveReference);
  await ctx.openHandbookDetail({ ...wire, detail: { type: 'world-place', id: choices[0].id, quantity: 1 } });
  assert.equal(ctx.currentDrawer.reference, flow.liveReference);
  assert.equal(ctx.currentDrawer.liveContext, true);
});
