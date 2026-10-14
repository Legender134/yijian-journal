'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { encyclopedia } = require('../src/core/game-data.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { readNpcObservation } = require('../src/core/live-npc-state.cjs');
const { handbookContext } = require('../src/core/handbook-context.cjs');

test('initial NPC previews and the related-task list retain the live cohort through navigation and handoff without a save', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    selected = { id: 'synthetic', referenceMode: 'latest', allocations: [] };
  const npc = (id) => ({
    id,
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
    skills: [],
    inventory: [],
    rawFriendliness: 70,
    visible: true,
    mapKey: 'LV_26_P',
    guildId: 0,
    skillPoints: 500,
  });
  const observed = readNpcObservation(
    {
      schema: 1,
      world: 'World /Synthetic.LV_26_P',
      pawn: 'Pawn Synthetic',
      sampledAt: 1800000000,
      quests: [
        { id: 12090, step: 1 },
        { id: 12094, step: 1 },
      ],
      npcs: [npc(0), npc(10221)],
    },
    { world: 'World /Synthetic.LV_26_P', pawn: 'Pawn Synthetic', now: 1800000000000 },
  );
  assert(observed);
  const flow = flowSnapshot(selected, null, '', { npcState: { ...observed, key: 'cohort-live-world' } });
  let readingFlow = flow;
  const act = (action, label, _style, id) =>
    `<button data-action="${action}" data-id="${id}">${label}</button>`;
  const helpers = {
    esc: String,
    act,
    icon: () => '',
    iconButton: () => '',
    pill: String,
    notice: String,
    empty: String,
    picture: () => '',
  };
  const references = createEntityReferences({
    index: () => index,
    ...helpers,
    qualityText: { html: (_e, value) => value },
  });
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const ctx = {
    currentDrawer: null,
    drawerHistory: [],
    referenceSave: null,
    referenceSaveName: undefined,
    referenceFollow: true,
    worldView: {},
    materialView: {},
    route: 'database',
    query: '',
    databaseKind: '人物',
    databaseType: '全部',
    databasePage: 0,
    handbookRequest: 0,
    detailRequest: 0,
    worldRequest: 0,
    compact: false,
    profile: () => selected,
    currentFlow: () => readingFlow,
    defaultFollow: () => selected.referenceMode === 'latest',
    defaultReference: () => '',
    latestReference: () => '',
    state: { settings: { spoiler: 'hints' } },
    environment: { saves: { files: [] } },
    gameIndex: index,
    gameViews: { byId: (_index, id) => index.entries.find((row) => row.id === id) },
    worldViews: createWorldViews(helpers),
    ...helpers,
    render() {},
    closeOverlay() {
      ctx.currentDrawer = null;
    },
    showOverlay(html) {
      ctx.html = html;
    },
    rememberDrawer(view) {
      ctx.currentDrawer = view;
    },
    call: async () => assert.fail('no synthetic save exists'),
    handbookPresentation: () => null,
    recipeQuantity: () => 1,
    placeMapScopes: new Map(),
    entityReferences: references,
    installEntityPreviews: (options) => options,
    document: { querySelector: () => null },
    window: {},
    overlay: { querySelector: () => null },
    captureJournalDraft() {},
    captureIntentDrafts() {},
    captureNodeDraft() {},
    flushNodeDrafts() {},
    saveNote() {},
    flushJournalDrafts() {},
    flushIntentDrafts() {},
    restoreHandbookPresentation() {},
    refresh: async () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    [
      part('let entityPreviewReference = null;', 'const materialViews ='),
      part('async function loadWorldReference(', 'async function showFlowWorldDetail('),
      part('async function showFlowWorldDetail(', 'async function calculateMaterials('),
      part('function handbookReadingContext(', 'function recipeDiscoveryPage('),
      "this.related=async(id)=>{switch('world-person'){" +
        part("    case 'world-person': {", "    case 'place-map-scope': {") +
        '}};',
      "this.quest=async(id,target)=>{switch('world-quest'){" +
        part("    case 'world-quest':", "    case 'flow-quest': {") +
        '}};',
      'this.preview=entityPreviews.context;',
    ].join('\n'),
    ctx,
  );
  const target = (id) => ({
    dataset: { action: id.startsWith('npc-') ? 'database-detail' : 'world-quest', id },
    closest: () => null,
  });
  const initial = await ctx.preview(target('npc-10221'));
  assert.equal(initial.reference, flow.liveReference);
  assert.equal(initial.npcProgress, flow.duels.progress);
  assert.match(references.preview('npc-10221', initial), /私物已清空/);
  assert.doesNotMatch(references.preview('npc-10221', initial), /固定私物/);
  ctx.currentDrawer = { type: 'timeline' };
  assert.equal(
    (await ctx.preview(target('npc-10221'))).reference,
    null,
    'historical lookup remains isolated',
  );
  ctx.currentDrawer = null;
  selected.referenceMode = 'none';
  assert.equal((await ctx.preview(target('npc-10221'))).reference, null, 'offline lookup remains isolated');
  selected.referenceMode = 'latest';
  ctx.currentDrawer = { type: 'database', id: 'npc-10221', liveContext: true, liveNpcContext: true };
  ctx.referenceSave = null;
  readingFlow = { ...flow, liveReference: null, npcStateKey: '' };
  await ctx.related('npc-10221');
  assert.equal(ctx.worldView.liveContext, true, 'temporary withdrawal preserves live list intent');
  assert.equal(ctx.worldView.reference, null, 'a withdrawn cohort is not reused');
  assert.equal(handbookContext(ctx.handbookReadingContext()).reference.live, true);
  readingFlow = flow;
  await ctx.loadWorldReference();
  assert.equal(ctx.worldView.reference, flow.liveReference);
  const wire = handbookContext(ctx.handbookReadingContext());
  assert.equal(wire.reference.live, true);
  assert.equal((await ctx.preview(target('quest-12090'))).reference, flow.liveReference);
  await ctx.quest('quest-12090', target('quest-12090'));
  assert.equal(ctx.currentDrawer.reference, flow.liveReference);
  assert.equal(ctx.currentDrawer.liveContext, true);
  assert.match(ctx.html, /进行中/);
  ctx.currentDrawer = null;
  ctx.worldView = {};
  ctx.referenceSave = null;
  await ctx.receiveHandbookContext(wire);
  assert.equal(
    ctx.worldView.reference,
    flow.liveReference,
    'the receiving list reacquires current live data',
  );
  assert.equal(ctx.worldView.liveContext, true);
  selected.referenceMode = 'none';
  await ctx.receiveHandbookContext(wire);
  assert.equal(ctx.worldView.liveContext, false, 'a queued live list handoff rechecks current Settings');
  assert.equal(ctx.worldView.reference, null);
});
