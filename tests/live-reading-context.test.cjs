'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { handbookContext } = require('../src/core/handbook-context.cjs');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const part = (start, end) => {
  const a = app.indexOf(start),
    b = app.indexOf(end, a);
  assert(a >= 0 && b > a);
  return app.slice(a, b);
};
function harness() {
  const selected = { id: 'synthetic', referenceMode: 'latest', saveSlot: '', reservations: {} };
  const old = { name: '1.sav', hash: 'a'.repeat(64), metadata: { inventory: [{ id: 100034, count: 99 }] } };
  const latest = { name: '2.sav', hash: 'b'.repeat(64), metadata: { quests: [] } };
  const live = { origin: 'live', key: 'cohort-live', metadata: { quests: [{ id: 12001, step: 1 }] } };
  const progress = { origin: 'live', people: [{ npcId: 10038, remainingItems: [{ id: 100034, count: 1 }] }] };
  let observed = live;
  const renders = [],
    reads = [];
  const context = {
    currentDrawer: null,
    drawerHistory: [],
    referenceSave: old,
    referenceSaveName: old.name,
    referenceFollow: true,
    databaseId: '',
    detailRequest: 0,
    handbookRequest: 0,
    profile: () => selected,
    defaultFollow: () => selected.referenceMode === 'latest',
    defaultReference: () => (selected.referenceMode === 'none' ? '' : selected.saveSlot || latest.name),
    latestReference: () => latest.name,
    currentFlow: () => ({
      reference: selected.referenceMode === 'latest' ? latest : old,
      liveReference: selected.referenceMode === 'latest' ? observed : null,
      npcStateKey: selected.referenceMode === 'latest' ? observed?.key || '' : '',
      duels: { progress: observed ? progress : { origin: 'saved', people: [] } },
    }),
    planningIntentSignature: () => 'stable',
    planningTotals: () => ({}),
    reservableReference: (x) => x,
    gameIndex: {},
    catalog: { entries: [] },
    environment: { saves: { files: [old, latest] } },
    worldViews: {},
    gameViews: {
      byId: (_index, id) => ({ id, kind: id.startsWith('npc-') ? '人物' : '物品' }),
      detail: (...args) => {
        renders.push({ id: args[1], reference: args[3], progress: args[11], live: args[12] });
        return 'synthetic HTML';
      },
    },
    esc: String,
    act: () => '',
    iconButton: () => '',
    entityReferences: {
      choices: () => [{ id: 'npc-10038', name: '合成人物', kind: '人物' }],
      choiceSummary: () => '',
    },
    itemUsageViews: { detail: () => '' },
    projectItemUsage: () => ({}),
    document: { querySelector: () => null },
    overlay: { querySelector: () => null },
    call: async (method, name) => {
      assert.equal(method, 'saveDetails');
      reads.push(name);
      return name === old.name ? old : latest;
    },
    toast: (message) => assert.fail(message),
    captureNodeDraft() {},
    showOverlay() {},
    handbookPresentation: () => ({ scroll: 0, details: [] }),
    restoreHandbookPresentation() {},
    worldView: {},
    route: 'duels',
    query: '',
    databaseKind: '全部',
    databaseType: '全部',
    databasePage: 0,
    recipeQuantity: () => 1,
    recipeDiscoveryRequest: 0,
    recipeDiscoveryTimer: null,
    worldRequest: 0,
    materialRequest: 0,
    clearTimeout() {},
  };
  vm.createContext(context);
  const backHeader = "      } else if (view.type === 'database') {";
  vm.runInContext(
    [
      part('function rememberDrawer(', 'const paths ='),
      part('function resetPlanningViews()', 'function worldPage()'),
      part('async function showDatabaseDetail(', 'function recipeQuantity()'),
      part('async function showEntityChoice(', 'function captureDetailFolds('),
      part('async function refreshLiveNpcDetail()', 'async function refresh('),
      part('function handbookReadingContext(', 'async function receiveHandbookContext('),
      part('async function openHandbookDetail(', 'function recipeDiscoveryPage('),
      "this.navigate=async(id,target)=>{switch('database-detail'){" +
        part("    case 'database-detail': {", "    case 'database-uses':") +
        '}};',
      'this.back=async(view)=>{' +
        part(backHeader, "      } else if (view.type === 'entity-choice')").slice(backHeader.length) +
        '};',
    ].join('\n'),
    context,
  );
  return {
    context,
    selected,
    old,
    latest,
    live,
    progress,
    renders,
    reads,
    setObserved: (value) => {
      observed = value;
    },
  };
}
test('live private-item navigation, related NPC, Back and handbook handoff preserve the cohort without old holdings', async () => {
  const h = harness(),
    c = h.context;
  await c.showDatabaseDetail('npc-10038');
  await c.navigate('item-100034', { closest: () => null });
  assert.equal(h.renders.at(-1).reference, h.live);
  assert.equal(h.renders.at(-1).reference.metadata.inventory, undefined);
  assert.equal(c.currentDrawer.liveContext, true);
  const previousNpc = c.drawerHistory.at(-1);
  assert.equal(previousNpc.follow, true);
  assert.equal(previousNpc.referenceHash, '');
  const itemWire = handbookContext(c.handbookReadingContext());
  assert.equal(itemWire.reference.live, true);
  assert.equal(itemWire.history[0].reference.live, true);
  await c.back(previousNpc);
  assert.equal(h.renders.at(-1).progress, h.progress);
  assert.equal(c.currentDrawer.liveNpcContext, true);
  await c.navigate('item-100034', { closest: () => null });
  await c.navigate('npc-10038', { closest: () => null });
  assert.equal(h.renders.at(-1).progress, h.progress);
  await c.openHandbookDetail(itemWire);
  assert.equal(h.renders.at(-1).reference, h.live);
  assert.equal(c.currentDrawer.liveContext, true);
  assert.deepEqual(h.reads, [], 'live partial data cannot borrow saved holdings');
  await c.navigate('npc-10038', { closest: () => null });
  await c.openHandbookDetail({
    detail: { type: 'database', id: 'npc-10038', quantity: 1 },
    reference: { name: '', hash: '', follow: false },
  });
  assert.equal(h.renders.at(-1).reference, null, 'explicit offline lookup overrides the same live drawer');
  assert.equal(h.renders.at(-1).progress, null);
  assert.equal(c.currentDrawer.liveContext, false);
});
test('switching to fixed or offline mode clears live reading and queued handoff cannot restore latest', async () => {
  for (const mode of ['slot', 'none']) {
    const h = harness(),
      c = h.context;
    await c.showDatabaseDetail('npc-10038');
    const queuedWire = handbookContext(c.handbookReadingContext());
    c.drawerHistory.push({ ...c.currentDrawer });
    h.selected.referenceMode = mode;
    h.selected.saveSlot = mode === 'slot' ? h.old.name : '';
    c.resetPlanningViews();
    c.referenceSave = null;
    c.referenceSaveName = undefined;
    assert.equal(c.currentDrawer.liveContext, false);
    assert.equal(c.drawerHistory[0].liveNpcContext, false);
    await c.showDatabaseDetail('npc-10038');
    const refreshedWire = handbookContext(c.handbookReadingContext());
    assert.equal(refreshedWire.reference.live, undefined);
    assert.equal(refreshedWire.reference.follow, false);
    await c.openHandbookDetail(queuedWire);
    assert.equal(h.renders.at(-1).reference, mode === 'slot' ? h.old : null);
    assert.equal(h.renders.at(-1).progress, null);
    assert.equal(c.currentDrawer.liveContext, false);
    assert(!h.reads.includes(h.latest.name));
  }
});
test('live namesake selection withdraws and reacquires the same reading mode through handoff', async () => {
  const h = harness(),
    c = h.context;
  await c.showDatabaseDetail('npc-10038');
  await c.showEntityChoice('name:合成人物', c.currentDrawer.flowReference);
  assert.equal(c.currentDrawer.reference, h.live);
  h.setObserved(null);
  await c.refreshLiveNpcDetail();
  assert.equal(c.currentDrawer.reference, h.latest);
  assert.equal(c.currentDrawer.liveContext, true);
  const wire = handbookContext(c.handbookReadingContext());
  assert.equal(wire.reference.live, true);
  await c.openHandbookDetail(wire);
  assert.equal(c.currentDrawer.reference, h.latest);
  const newer = { ...h.live, key: 'cohort-reconnected' };
  h.setObserved(newer);
  await c.refreshLiveNpcDetail();
  assert.equal(c.currentDrawer.reference, newer);
  await c.navigate('npc-10038', { closest: () => null });
  assert.equal(h.renders.at(-1).reference, newer);
  assert.equal(h.renders.at(-1).progress, h.progress);
  assert(!h.reads.includes(h.old.name));
});
