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
    npcProgressView: { tab: 'remaining', query: '', page: 0 },
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

async function codexLiveHarness() {
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia();
  const saved = {
    name: '1.sav',
    hash: 'a'.repeat(64),
    metadata: { quests: [{ id: 12090, step: 1, status: '进行中' }] },
  };
  const older = {
    name: '2.sav',
    hash: 'b'.repeat(64),
    metadata: { quests: [{ id: 12090, step: 2, status: '已失败' }] },
  };
  const live = {
    origin: 'live',
    key: 'cohort-codex-1',
    metadata: {
      quests: [
        { id: 12090, step: 4 },
        { id: 12094, step: 1 },
      ],
    },
  };
  const selected = { id: 'synthetic', referenceMode: 'latest', saveSlot: older.name, allocations: [] };
  let flow = { reference: { ...saved, origin: 'live' }, liveReference: live };
  const reads = [];
  const helpers = {
    esc: String,
    act: () => '',
    icon: () => '',
    iconButton: () => '',
    pill: String,
    notice: String,
    empty: String,
    picture: () => '',
  };
  const ctx = {
    ...helpers,
    currentDrawer: null,
    route: 'database',
    worldView: {},
    referenceSaveName: undefined,
    referenceFollow: true,
    referenceSave: null,
    selectedSave: null,
    worldRequest: 0,
    detailRequest: 0,
    handbookRequest: 0,
    state: { settings: { spoiler: 'hints' } },
    gameIndex: index,
    environment: { saves: { files: [saved, older] } },
    profile: () => selected,
    currentFlow: () => flow,
    defaultFollow: () => selected.referenceMode === 'latest',
    defaultReference: () =>
      selected.referenceMode === 'none'
        ? ''
        : selected.referenceMode === 'slot'
          ? selected.saveSlot
          : saved.name,
    latestReference: () => saved.name,
    render() {},
    showOverlay(html) {
      ctx.html = html;
    },
    rememberDrawer(view) {
      ctx.currentDrawer = view;
    },
    closeOverlay() {
      ctx.currentDrawer = null;
    },
    call: async (method, name) => {
      assert.equal(method, 'saveDetails');
      reads.push(name);
      return [saved, older].find((row) => row.name === name) || null;
    },
    worldViews: createWorldViews(helpers),
    placeMapScopes: new Map(),
    query: '',
    entityReferences: { choices: () => [{}] },
    installEntityPreviews: (options) => options,
    document: {},
    window: {},
  };
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) => {
    const a = app.indexOf(start),
      b = app.indexOf(end, a);
    assert(a >= 0 && b > a, start);
    return app.slice(a, b);
  };
  vm.createContext(ctx);
  vm.runInContext(
    [
      part('let entityPreviewReference = null;', 'const materialViews ='),
      part('async function loadWorldReference(', 'async function calculateMaterials('),
      part('function searchQuestStatuses(', 'function showSearchResults('),
      "this.quest=async(id,target)=>{switch('world-quest'){" +
        part("    case 'world-quest':", "    case 'flow-quest': {") +
        '}};',
      "this.place=async(id,target)=>{switch('world-place'){" +
        part("    case 'world-place':", "    case 'world-kind':") +
        '}};',
      "this.all=async(id,target)=>{switch('search-all'){" +
        part("    case 'search-all': {", "    case 'library-search-all':") +
        '}};',
      'this.preview=entityPreviews.context;',
    ].join('\n'),
    ctx,
  );
  const target = (id) => ({
    dataset: { id, entityId: id, query: '种类:任务 状态:进行中' },
    closest: () => null,
  });
  function reset() {
    ctx.currentDrawer = null;
    ctx.route = 'database';
    ctx.worldView = {};
    ctx.referenceSaveName = undefined;
    ctx.referenceSave = null;
    ctx.referenceFollow = ctx.defaultFollow();
  }
  return {
    ctx,
    selected,
    saved,
    older,
    live,
    reads,
    target,
    reset,
    setFlow(next) {
      flow = next;
    },
  };
}

test('direct codex tasks, place previews and search results use the current live cohort', async () => {
  const h = await codexLiveHarness(),
    { ctx, target, live, reads } = h;
  assert.equal((await ctx.preview(target('quest-12090'))).reference, live);
  assert.equal((await ctx.preview(target('place-22'))).reference, live);
  await ctx.quest('quest-12090', target('quest-12090'));
  assert.equal(ctx.currentDrawer.reference, live);
  assert.equal(ctx.currentDrawer.liveContext, true);
  assert.match(ctx.html, /已完成/);
  assert.equal(ctx.searchQuestStatuses().get(12090), '已完成');
  assert.equal(ctx.searchQuestStatuses().get(12094), '进行中');
  h.reset();
  ctx.currentDrawer = { type: 'search', follow: true };
  await ctx.quest('quest-12090', target('quest-12090'));
  assert.equal(ctx.currentDrawer.reference, live);
  h.reset();
  await ctx.place('place-22', target('place-22'));
  assert.equal(ctx.currentDrawer.reference, live);
  assert.equal(ctx.currentDrawer.liveContext, true);
  h.reset();
  ctx.currentDrawer = { type: 'search', follow: true };
  ctx.worldView = { follow: false, reference: h.older };
  await ctx.all('quests', target(''));
  assert.equal(ctx.route, 'world');
  assert.equal(ctx.worldView.reference, live);
  assert.equal(ctx.worldView.liveContext, true);
  assert.deepEqual(reads, [], 'current live lookups do not read old saves');
});

test('codex reading withdraws and reacquires live state without keeping a stale cohort', async () => {
  const h = await codexLiveHarness(),
    { ctx, target, saved, live } = h;
  await ctx.quest('quest-12090', target('quest-12090'));
  h.setFlow({ reference: saved, liveReference: null });
  await ctx.loadWorldReference();
  assert.equal(ctx.currentDrawer.reference, saved);
  assert.equal(ctx.currentDrawer.liveContext, true, 'latest intent survives a temporary disconnect');
  assert.equal(ctx.searchQuestStatuses().get(12090), '进行中');
  const next = { ...live, key: 'cohort-codex-2', metadata: { quests: [{ id: 12090, step: 2 }] } };
  h.setFlow({ reference: saved, liveReference: next });
  await ctx.loadWorldReference();
  assert.equal(ctx.currentDrawer.reference, next);
  assert.equal(ctx.searchQuestStatuses().get(12090), '已失败');
  assert.equal(
    ctx.searchQuestStatuses().has(12094),
    false,
    'withdrawn task rows are not borrowed from the previous sample',
  );
  assert.equal((await ctx.preview(target('quest-12090'))).reference, next);
});

test('fixed, offline and historical codex reading never adopts current live task state', async () => {
  const h = await codexLiveHarness(),
    { ctx, target, older, selected } = h;
  selected.referenceMode = 'slot';
  h.reset();
  await ctx.quest('quest-12090', target('quest-12090'));
  assert.equal(ctx.currentDrawer.reference, older);
  assert.equal(ctx.currentDrawer.liveContext, false);
  assert.equal(ctx.searchQuestStatuses().get(12090), '已失败');
  selected.referenceMode = 'none';
  h.reset();
  await ctx.quest('quest-12090', target('quest-12090'));
  assert.equal(ctx.currentDrawer.reference, null);
  assert.equal(ctx.searchQuestStatuses().size, 0);
  selected.referenceMode = 'latest';
  h.reset();
  ctx.currentDrawer = { type: 'save', data: older };
  ctx.selectedSave = older;
  await ctx.quest('quest-12090', target('quest-12090'));
  assert.equal(ctx.currentDrawer.reference, older);
  assert.equal(ctx.currentDrawer.liveContext, false);
  for (const type of ['timeline', 'comparison']) {
    h.reset();
    ctx.currentDrawer = { type };
    await ctx.quest('quest-12090', target('quest-12090'));
    assert.equal(ctx.currentDrawer.reference, null, type);
    assert.equal(ctx.currentDrawer.liveContext, false, type);
  }
  h.reset();
  ctx.currentDrawer = { type: 'search', follow: false };
  ctx.referenceFollow = false;
  ctx.referenceSaveName = older.name;
  ctx.referenceSave = older;
  assert.equal(ctx.searchQuestStatuses().get(12090), '已失败');
  await ctx.all('quests', target(''));
  assert.equal(ctx.worldView.reference, older);
  assert.equal(ctx.worldView.liveContext, false);
});
