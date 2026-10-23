'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handbookContext } = require('../src/core/handbook-context.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readingHistoryHarness() {
  const catalog = require('../src/data/catalog.cjs');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const body = { scrollTop: 0 };
  const input = { value: '目标', focus() {}, select() {} };
  const context = {
    catalog,
    entry: (id) => catalog.entries.find((row) => row.id === id),
    source: (id) => catalog.sources.find((row) => row.id === id),
    profile: () => ({ id: 'synthetic', checks: {}, favorites: [] }),
    state: { settings: { spoiler: 'details' } },
    currentDrawer: null,
    drawerHistory: [],
    drawerId: '',
    detailRequest: 0,
    handbookRequest: 0,
    revealed: true,
    captureNodeDraft() {},
    handbookPresentation: () => ({ scroll: body.scrollTop, details: [] }),
    restoreHandbookPresentation: (value) => {
      if (value) body.scrollTop = value.scroll;
    },
    showOverlay(_html, drawer) {
      body.scrollTop = 0;
      if (!drawer) {
        context.currentDrawer = null;
        context.drawerHistory.length = 0;
      }
    },
    icon: () => '',
    iconButton: () => '',
    act: () => '',
    pill: () => '',
    notice: () => '',
    esc: String,
    entityReferences: { text: String },
    currentFlow: () => null,
    referenceSave: null,
    referenceSaveName: '',
    referenceFollow: false,
    defaultFollow: () => false,
    defaultReference: () => '',
    route: 'home',
    query: '',
    databaseKind: '全部',
    databaseType: '全部',
    databasePage: 0,
    npcProgressView: { tab: 'remaining', query: '', page: 0 },
    worldView: {},
    worldRequest: 0,
    recipeQuantity: () => 1,
    lastSearchQuery: '',
    showSearchResults() {},
    overlay: {
      querySelector: (selector) =>
        selector === '#global-search' && context.currentDrawer?.type === 'search' ? input : null,
      querySelectorAll: () => [],
    },
    document: {
      querySelector: (selector) => ({ '#global-search': input, '#global-results': body })[selector] || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      slice('function rememberDrawer(', 'const paths ='),
      slice('function handbookReadingContext(', 'function recipeDiscoveryPage('),
      slice('function showDetail(', 'function modal('),
      slice('function searchModal(', 'function showSearchResults('),
      'this.capture=handbookReadingContext; this.open=openHandbookDetail; this.guide=showDetail; this.remember=rememberDrawer;',
    ].join('\n'),
    context,
  );
  return { context, body };
}

test('guide and other read-only drawer histories retain reading position before handbook return', async () => {
  const { context, body } = readingHistoryHarness();
  context.guide('wei-training');
  body.scrollTop = 640;
  context.guide('wei-huo');
  const wire = handbookContext(context.capture());
  assert.equal(wire.history[0].detail.id, 'wei-training');
  assert.equal(wire.history[0].presentation.scroll, 640);
  context.currentDrawer = null;
  await context.open(wire.history[0]);
  assert.equal(body.scrollTop, 640);
  for (const type of ['entity-choice', 'timeline', 'save', 'backup', 'comparison']) {
    context.currentDrawer = { type };
    body.scrollTop = 370;
    context.remember({ type: 'guide', id: 'wei-huo' });
    assert.equal(context.drawerHistory.at(-1).presentation.scroll, 370, type);
  }
});

test('live NPC and task handoff select a fresh observed cohort, with saved fallback after withdrawal', async () => {
  const { context } = readingHistoryHarness();
  context.defaultFollow = () => true;
  const old = { name: '1.sav', hash: 'a'.repeat(64) };
  const latest = { name: '2.sav', hash: 'b'.repeat(64) };
  const live = { origin: 'live', key: 'cohort-new', metadata: { quests: [{ id: 12001, step: 1 }] } };
  context.referenceSave = old;
  context.referenceSaveName = old.name;
  context.currentDrawer = { type: 'database', id: 'npc-10047', liveNpcContext: true, flowReference: old };
  context.drawerHistory = [{ type: 'world-quest', id: 'quest-12001', liveContext: true }];
  const wire = handbookContext(context.capture());
  assert.deepEqual(wire.reference, { name: '', hash: '', follow: true, live: true });
  assert.deepEqual(wire.history[0].reference, wire.reference);
  assert.equal(
    handbookContext({ profileId: 'p', reference: { follow: false, live: true } }).reference.live,
    undefined,
  );
  const reads = [];
  context.latestReference = () => latest.name;
  context.call = async (_method, name) => {
    reads.push(name);
    return latest;
  };
  context.showWorldDetail = async (_id, _type, _replace, view) => {
    context.currentDrawer = { type: 'world-quest', id: 'quest-12001', ...view };
    return context.currentDrawer;
  };
  for (const observed of [live, null]) {
    context.currentFlow = () => ({ liveReference: observed });
    await context.open(wire.history[0]);
    assert.equal(context.currentDrawer.reference, observed || latest);
    assert.equal(context.currentDrawer.follow, true);
    assert.equal(context.currentDrawer.liveContext, true, 'live intent survives a temporary withdrawal');
  }
  assert.deepEqual(reads, ['2.sav'], 'the old saved cohort must not be resurrected');
});

test('search result mode survives direct handoff and handbook history, with strict boolean display state', async () => {
  for (const personalAll of [true, false])
    for (const showSaved of [true, false]) {
      const { context, body } = readingHistoryHarness();
      context.currentDrawer = { type: 'search', query: '目标', personalAll, showSaved };
      body.scrollTop = 440;
      const direct = handbookContext(context.capture());
      context.guide('wei-training');
      const historical = handbookContext(context.capture()).history[0];
      for (const wire of [direct, historical]) {
        await context.open(wire);
        assert.equal(context.currentDrawer.personalAll, personalAll);
        assert.equal(context.currentDrawer.showSaved, showSaved);
        assert.equal(body.scrollTop, 440);
      }
    }
  const invalid = handbookContext({
    profileId: 'p',
    detail: { type: 'search', id: '', personalAll: 'true', showSaved: 1 },
  });
  assert.equal(invalid.detail.personalAll, false);
  assert.equal(invalid.detail.showSaved, false);
});
test('read-only handoff retains a specific entity, search and saved reference without mutations', () => {
  const value = {
    route: 'materials',
    profileId: 'profile-1',
    query: '药草',
    reference: { name: '3.sav', hash: 'a'.repeat(64), follow: false },
    detail: { type: 'database', id: 'cooking-123', quantity: 4 },
    command: { type: 'delete' },
    path: 'private/path',
  };
  const result = handbookContext(value);
  assert.equal(result.detail.id, value.detail.id);
  assert.equal(result.detail.quantity, 4);
  assert.deepEqual(result.reference, value.reference);
  assert.equal(result.query, '药草');
  assert.equal(result.command, undefined);
  assert.equal(result.path, undefined);
});
test('map scene identities and overlapping marker choices survive handoff and history', () => {
  const detail = { type: 'world-place', id: 'place-96:LV_64_P2', mapScope: 'world' };
  const history = [
    { detail: { type: 'entity-choice', id: 'map-point:1367.43:648.71' } },
    { detail: { type: 'world-place', id: 'place-96:LV_KZ_P2' } },
  ];
  const result = handbookContext({ profileId: 'p', detail, history });
  assert.equal(result.detail.id, detail.id);
  assert.equal(result.detail.mapScope, 'world');
  assert.equal(
    handbookContext({ profileId: 'p', detail: { ...detail, mapScope: 'invalid' } }).detail.mapScope,
    'region',
  );
  assert.deepEqual(
    result.history.map((row) => row.detail.id),
    history.map((row) => row.detail.id),
  );
  for (const [type, ids] of [
    ['world-place', ['place-96:../LV_KZ_P2', 'place-96:C:\\files', 'place-96:LV_KZ_P2\u0000']],
    ['entity-choice', ['map-point:NaN:23', 'map-point:1:2/../../x', 'map-point:1000000:20']],
  ])
    for (const id of ids) assert.throws(() => handbookContext({ profileId: 'p', detail: { type, id } }));
});
test('handoff refuses paths, invalid identities and arbitrary detail types', () => {
  for (const patch of [
    { reference: { name: '../1.sav' } },
    { reference: { name: '1.sav', hash: 'not-a-hash' } },
    { detail: { type: 'restore', id: 'backup-1' } },
    { detail: { type: 'database', id: '../item-1' } },
    { profileId: '' },
  ])
    assert.throws(() => handbookContext({ profileId: 'p', ...patch }));
  assert.equal(handbookContext({ profileId: 'p', route: 'remove-all' }).route, 'home');
});

test('NPC handoff accepts only bounded list filters and resets missing or invalid values', () => {
  for (const tab of ['remaining', 'learning', 'locked', 'cleared']) {
    const npcProgress = { tab, query: '炼丹', page: 2 };
    assert.deepEqual(handbookContext({ profileId: 'p', npcProgress }).npcProgress, npcProgress);
  }
  for (const npcProgress of [undefined, null, [], { tab: 'delete', query: 'x'.repeat(101), page: -1 }])
    assert.deepEqual(handbookContext({ profileId: 'p', npcProgress }).npcProgress, {
      tab: 'remaining',
      query: '',
      page: 0,
    });
  for (const page of [1.5, Infinity, 100001, '1'])
    assert.equal(handbookContext({ profileId: 'p', npcProgress: { page } }).npcProgress.page, 0);
  for (const [tab, filter] of [
    ['remaining', 'ready'],
    ['learning', 'ready'],
    ['locked', 'missing'],
    ['cleared', 'nearby'],
  ])
    assert.equal(
      handbookContext({ profileId: 'p', npcProgress: { tab, filter } }).npcProgress.filter,
      filter,
    );
  for (const [tab, filter] of [
    ['remaining', 'remove'],
    ['learning', 'missing'],
    ['locked', 'ready'],
    ['cleared', 'missing'],
    ['remaining', {}],
  ])
    assert.equal(
      handbookContext({ profileId: 'p', npcProgress: { tab, filter } }).npcProgress.filter,
      undefined,
    );
  assert.deepEqual(
    handbookContext({
      profileId: 'p',
      npcProgress: {
        tab: 'learning',
        query: '江吟风',
        page: 1,
        command: 'remove',
        path: 'private',
      },
    }).npcProgress,
    { tab: 'learning', query: '江吟风', page: 1 },
  );
});

test('legacy scene chooser transfers directly and remains valid in exact-scene history', () => {
  for (const id of ['place-96', 'place-97']) {
    const detail = { type: 'entity-choice', id };
    assert.equal(handbookContext({ profileId: 'p', detail }).detail.id, id);
    const result = handbookContext({
      profileId: 'p',
      detail: { type: 'world-place', id: id + (id === 'place-96' ? ':LV_64_P2' : ':LV_64_P3') },
      history: [{ detail }],
    });
    assert.equal(result.history[0].detail.id, id);
  }
  for (const id of ['place-96/../../x', 'place-96:LV_64_P2', 'place-NaN', 'place-96\u0000'])
    assert.throws(() => handbookContext({ profileId: 'p', detail: { type: 'entity-choice', id } }));
});

test('handoff retains pages, filters, body reading and same-name history across the actual sender and receiver', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('function handbookReadingContext('),
    end = app.indexOf('function recipeDiscoveryPage(', start);
  const ref = { name: '2.sav', hash: 'b'.repeat(64), follow: false };
  const body = { scroll: 840, details: [{ summary: '准备', key: 'duel-readiness-test', open: true }] };
  const noop = () => {},
    asyncNoop = async () => {};
  const restored = [];
  const context = {
    currentDrawer: { type: 'database', id: 'npc-5003', giftPage: 2 },
    drawerHistory: [{ type: 'entity-choice', id: 'name:莫弃', flowReference: ref }],
    currentFlow: () => ({ reference: { name: '1.sav', hash: 'a'.repeat(64) } }),
    referenceSave: ref,
    referenceSaveName: ref.name,
    referenceFollow: false,
    profile: () => ({ id: 'p' }),
    route: 'duels',
    query: '',
    databaseKind: '人物',
    databaseType: '全部',
    databasePage: 3,
    npcProgressView: { tab: 'learning', query: '炼丹', page: 1 },
    worldView: {
      kind: 'quests',
      query: '药',
      status: 'active',
      roots: false,
      page: 2,
      referenceName: ref.name,
      reference: ref,
      follow: false,
    },
    defaultFollow: () => false,
    recipeQuantity: () => 1,
    handbookPresentation: (page) => (page ? body : null),
    overlay: { querySelector: () => ({}) },
    compact: false,
    detailRequest: 0,
    handbookRequest: 0,
    captureJournalDraft: noop,
    captureIntentDrafts: noop,
    captureNodeDraft: asyncNoop,
    flushNodeDrafts: asyncNoop,
    saveNote: asyncNoop,
    flushJournalDrafts: asyncNoop,
    flushIntentDrafts: asyncNoop,
    materialView: {},
    refresh: asyncNoop,
    render: noop,
    closeOverlay: () => {
      context.detailRequest++;
      context.currentDrawer = null;
    },
    restoreHandbookPresentation: (value, page) => restored.push({ value, page }),
    showDatabaseDetail: async (id, quantity, giftPage) =>
      (context.currentDrawer = { type: 'database', id, quantity, giftPage }),
    showEntityChoice: (id, flowReference) =>
      (context.currentDrawer = { type: 'entity-choice', id, flowReference }),
    call: async (method, name) => {
      assert.equal(method, 'saveDetails');
      assert.equal(name, ref.name);
      return ref;
    },
    loadWorldReference: asyncNoop,
  };
  vm.createContext(context);
  vm.runInContext(
    app.slice(start, end) +
      '\nthis.capture=handbookReadingContext;this.receive=receiveHandbookContext;this.open=openHandbookDetail;',
    context,
  );
  const wire = handbookContext(context.capture());
  assert.equal(wire.detail.giftPage, 2);
  assert.equal(wire.history[0].detail.id, 'name:莫弃');
  assert.equal(wire.history[0].detail.flowBound, true);
  assert.deepEqual(wire.npcProgress, { tab: 'learning', query: '炼丹', page: 1 });
  Object.assign(context.npcProgressView, { tab: 'remaining', query: '', page: 0 });
  await context.receive(wire);
  assert.equal(context.currentDrawer.giftPage, 2);
  assert.equal(context.databasePage, 3);
  assert.deepEqual(context.npcProgressView, { tab: 'learning', query: '炼丹', page: 1 });
  assert.equal(restored.at(-1).page, true);
  assert.equal(restored.at(-1).value.scroll, 840);
  await context.open(wire.history[0]);
  assert.equal(context.currentDrawer.id, 'name:莫弃');
  assert.equal(context.currentDrawer.flowReference.name, '2.sav');
  assert.deepEqual(context.npcProgressView, { tab: 'learning', query: '炼丹', page: 1 });
  context.route = 'world';
  context.currentDrawer = null;
  const world = handbookContext(context.capture());
  assert.equal(world.reference.name, '2.sav', 'the world list keeps its selection instead of the flow slot');
  Object.assign(context.worldView, { status: 'all', page: 0, roots: true });
  await context.receive(world);
  assert.equal(context.worldView.status, 'active');
  assert.equal(context.worldView.page, 2);
  assert.equal(context.worldView.roots, false);
  context.route = 'duels';
  const npcList = handbookContext(context.capture());
  Object.assign(context.npcProgressView, { tab: 'locked', query: '卫霍', page: 0 });
  await context.receive(npcList);
  assert.deepEqual(context.npcProgressView, { tab: 'learning', query: '炼丹', page: 1 });
});

test('body presentation restores semantic cards and folds despite a different main-window layout', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('function handbookPresentation('),
    end = app.indexOf('function handbookReadingContext(', start);
  const target = {
    getAttribute: (key) => (key === 'data-duel' ? 'synthetic-duel' : null),
    hasAttribute: (key) => key === 'data-duel',
    getBoundingClientRect: () => ({ top: -40 }),
  };
  const heading = {
    textContent: '准备卡片',
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: 5 }),
    closest: () => target,
  };
  const fold = {
    open: true,
    querySelector: () => ({ textContent: '核对准备' }),
    getAttribute: (key) => (key === 'data-persist-detail' ? 'duel-readiness-synthetic' : null),
  };
  const source = {
    scrollTop: 840,
    getBoundingClientRect: () => ({ top: 20 }),
    querySelectorAll: (selector) => (selector === 'details' ? [fold] : [heading]),
  };
  const context = { root: { querySelector: () => source }, overlay: { querySelector: () => null } };
  vm.createContext(context);
  vm.runInContext(
    app.slice(start, end) + '\nthis.capture=handbookPresentation;this.restore=restoreHandbookPresentation;',
    context,
  );
  const value = handbookContext({ profileId: 'p', pagePresentation: context.capture(true) }).pagePresentation;
  assert.equal(value.anchor.sectionKey, 'data-duel');
  const destinationFold = { ...fold, open: false };
  const destination = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 20 }),
    querySelectorAll: (selector) =>
      selector === 'details'
        ? [destinationFold]
        : selector === '[data-duel]'
          ? [{ ...target, getBoundingClientRect: () => ({ top: 300 }) }]
          : [],
  };
  context.root.querySelector = () => destination;
  context.restore(value, true);
  assert.equal(destinationFold.open, true);
  assert.equal(
    destination.scrollTop,
    1180,
    'the same card offset is restored even when heading text and layout differ',
  );
});

test('additional reading state is bounded and cannot carry arbitrary selectors or paths', () => {
  const value = handbookContext({
    profileId: 'p',
    databasePage: -1,
    worldPage: Infinity,
    worldStatus: 'execute',
    worldRoots: false,
    detail: { type: 'database', id: 'npc-5003', giftPage: 1e9 },
    pagePresentation: {
      scroll: Infinity,
      anchor: { label: 'x', occurrence: 0, offset: 0, sectionKey: 'script', sectionId: 'bad' },
    },
  });
  assert.equal(value.databasePage, 0);
  assert.equal(value.worldPage, 0);
  assert.equal(value.worldStatus, 'all');
  assert.equal(value.detail.giftPage, 0);
  assert.equal(value.pagePresentation.scroll, 0);
  assert.equal(value.pagePresentation.anchor.sectionKey, undefined);
  for (const id of ['name:../private', 'name:C:\\private', 'name:\nscript', 'name:' + 'a'.repeat(100)])
    assert.throws(() => handbookContext({ profileId: 'p', detail: { type: 'entity-choice', id } }));
});

test('flow item and NPC navigation follows live intent only in latest mode while fixed and crafting lookups keep their reference', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const gameViews = createGameViews({ esc: String });
  const gameIndex = require('../src/data/game-index.json');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf("    case 'database-detail': {");
  const end = app.indexOf("    case 'database-uses':", start);
  assert.ok(start > 0 && end > start);
  for (const id of ['item-10016', 'npc-10016'])
    for (const fromFlow of [true, false])
      for (const follow of [true, false]) {
        let opened;
        const flow = { name: '1.sav', hash: 'a'.repeat(64) };
        const context = {
          id,
          gameViews,
          gameIndex,
          target: { closest: () => fromFlow },
          currentDrawer: null,
          currentFlow: () => ({ reference: flow }),
          route: 'materials',
          mutationQueue: Promise.resolve(),
          materialView: { referenceName: '2.sav', follow: false },
          referenceSave: {},
          defaultReference: () => '3.sav',
          defaultFollow: () => follow,
          profile: () => ({ craftList: [] }),
          showDatabaseDetail: async (_id, _quantity, _page, expected) => {
            opened = { name: context.referenceSaveName, expected };
          },
        };
        vm.createContext(context);
        vm.runInContext(
          `this.run = async () => { switch ('database-detail') { ${app.slice(start, end)} } };`,
          context,
        );
        await context.run();
        const liveReading = fromFlow && follow;
        assert.equal(opened.name, liveReading ? undefined : fromFlow ? '1.sav' : '2.sav');
        assert.equal(opened.expected?.hash, fromFlow && !liveReading ? flow.hash : undefined);
        assert.equal(opened.expected?.origin, liveReading ? 'live' : undefined);
      }
});

test('choosing a namesake tracks its configured slot while explicit snapshots remain pinned', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf("    case 'database-detail': {"),
    end = source.indexOf("    case 'database-uses':", start);
  for (const follow of [true, false])
    for (const bound of [true, false]) {
      const reference = { name: '1.sav', hash: 'a'.repeat(64) };
      let expected;
      const context = {
        currentDrawer: { type: 'entity-choice', reference, follow, flowReference: bound ? reference : null },
        id: 'npc-5011',
        target: { closest: () => false },
        showDatabaseDetail: async (_id, _quantity, _page, value) => {
          expected = value;
        },
      };
      vm.createContext(context);
      vm.runInContext(
        `this.open=async()=>{switch('database-detail'){${source.slice(start, end)}}};`,
        context,
      );
      await context.open();
      assert.equal(context.referenceFollow, follow && !bound);
      assert.equal(context.referenceSaveName, '1.sav');
      assert.equal(
        expected?.hash || null,
        bound ? reference.hash : null,
        'live choices load latest; explicitly pinned snapshots still require hash validation',
      );
    }
});
test('a flow place uses its own saved task state and rejects changed bytes instead of a previous encyclopedia selection', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function showFlowWorldDetail(');
  const end = app.indexOf('async function showWorldDetail(', start);
  assert.ok(start > 0 && end > start);
  for (const changed of [false, true]) {
    let opened;
    const current = { name: '1.sav', hash: 'a'.repeat(64), metadata: { quests: [{ id: 1, step: 1 }] } };
    const context = {
      worldView: { referenceName: '2.sav', reference: { metadata: { quests: [{ id: 1, step: 4 }] } } },
      worldRequest: 0,
      detailRequest: 0,
      handbookRequest: 0,
      profile: () => ({ id: 'p' }),
      currentFlow: () => ({ reference: current }),
      defaultFollow: () => false,
      call: async (_action, name) => {
        assert.equal(name, '1.sav');
        return { ...current, hash: changed ? 'b'.repeat(64) : current.hash };
      },
      showWorldDetail: async (_id, type, _replace, view) => {
        opened = { type, ...view };
      },
    };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end) + '\nthis.openPlace = showFlowWorldDetail;', context);
    await context.openPlace('place-1', 'place', {});
    assert.equal(opened.type, 'place');
    assert.equal(opened.referenceName, '1.sav');
    assert.equal(opened.follow, false);
    if (changed) {
      assert.equal(opened.reference, null);
      assert.match(opened.error, /已变化/);
    } else assert.equal(opened.reference.metadata.quests[0].step, 1);
  }
});

test('history handoff retains only verified read-only identities and rejects paths', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const backup = `2026-10-13T12-34-56-000-_${id}`;
  for (const detail of [
    { type: 'timeline', id },
    { type: 'save', id: '1.sav', hash: 'a'.repeat(64) },
    { type: 'backup', id: backup },
    {
      type: 'comparison',
      id: '',
      left: '1.sav',
      right: '2.sav',
      query: '药草',
      questQuery: '求助',
      filter: 'less',
    },
  ]) {
    const result = handbookContext({
      profileId: 'p',
      detail: { ...detail, path: 'private', command: 'restore' },
    }).detail;
    for (const [key, value] of Object.entries(detail)) assert.equal(result[key], value);
    assert.equal(result.path, undefined);
    assert.equal(result.command, undefined);
  }
  for (const detail of [
    { type: 'timeline', id: '../node' },
    { type: 'backup', id: '../backup' },
    { type: 'save', id: '../1.sav' },
    { type: 'comparison', id: '', left: '../1.sav', right: '2.sav' },
    { type: 'save', id: '1.sav', hash: 'bad' },
  ])
    assert.throws(() => handbookContext({ profileId: 'p', detail }));
});

test('handbook captures history, save, backup and comparison details instead of only their list route', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('function handbookReadingContext('),
    end = app.indexOf('async function receiveHandbookContext(', start);
  const rows = [
    { type: 'timeline', data: { record: { id: 'node-1' } } },
    { type: 'save', data: { name: '1.sav', hash: 'a'.repeat(64) } },
    { type: 'backup', data: { id: 'backup-1' } },
    {
      type: 'comparison',
      data: { left: '1.sav', right: '2.sav', query: '药草', questQuery: '求助', filter: 'more' },
    },
  ];
  for (const currentDrawer of rows) {
    const context = {
      currentDrawer,
      currentFlow: () => null,
      referenceSave: null,
      referenceSaveName: '',
      referenceFollow: false,
      profile: () => ({ id: 'p' }),
      route: 'saves',
      query: '',
      databaseKind: '全部',
      databaseType: '全部',
      databasePage: 0,
      npcProgressView: { tab: 'remaining', query: '', page: 0 },
      worldView: {},
      defaultFollow: () => false,
      handbookPresentation: () => null,
      drawerHistory: [],
    };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end) + '\nthis.readContext=handbookReadingContext;', context);
    const detail = context.readContext().detail;
    assert.equal(detail.type, currentDrawer.type);
    assert.equal(
      detail.id,
      currentDrawer.type === 'timeline'
        ? 'node-1'
        : currentDrawer.type === 'save'
          ? '1.sav'
          : currentDrawer.type === 'backup'
            ? 'backup-1'
            : '',
    );
    if (currentDrawer.type === 'comparison') {
      assert.equal(detail.left, '1.sav');
      assert.equal(detail.right, '2.sav');
      assert.equal(detail.filter, 'more');
    }
  }
});

test('a pending flow place cannot replace a newer search, closed drawer, world selection or flow identity', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function showFlowWorldDetail('),
    end = app.indexOf('async function showWorldDetail(', start);
  for (const change of ['search', 'close', 'world', 'source']) {
    let resolve,
      opened = false;
    let flow = { reference: { name: '1.sav', hash: 'a'.repeat(64) } };
    const context = {
      detailRequest: 0,
      currentDrawer: null,
      handbookRequest: 0,
      drawerHistory: [],
      restoreHandbookPresentation: () => {},
      worldRequest: 0,
      worldView: { referenceName: '2.sav' },
      profile: () => ({ id: 'p' }),
      currentFlow: () => flow,
      defaultFollow: () => false,
      call: () => new Promise((r) => (resolve = r)),
      showWorldDetail: async () => {
        opened = true;
      },
    };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end) + '\nthis.open=showFlowWorldDetail;', context);
    const pending = context.open('place-1', 'place', {});
    if (change === 'world') context.worldRequest++;
    else if (change === 'source') flow = { reference: { name: '2.sav', hash: 'b'.repeat(64) } };
    else context.detailRequest++;
    resolve({ name: '1.sav', hash: 'a'.repeat(64) });
    await pending;
    assert.equal(opened, false, change);
    assert.equal(context.worldView.referenceName, '2.sav', change);
  }
});

test('history handoff reloads the same detail through existing inspect APIs and respects newer reading', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function receiveHandbookContext('),
    end = app.indexOf('function recipeDiscoveryPage(', start);
  for (const type of ['timeline', 'save', 'backup', 'comparison']) {
    let opened, comparison, inspected;
    const noop = () => {},
      asyncNoop = async () => {};
    const context = {
      compact: false,
      profile: () => ({ id: 'p' }),
      handbookRequest: 0,
      detailRequest: 0,
      captureJournalDraft: noop,
      currentDrawer: null,
      drawerHistory: [],
      restoreHandbookPresentation: noop,
      captureIntentDrafts: noop,
      captureNodeDraft: asyncNoop,
      flushNodeDrafts: asyncNoop,
      saveNote: asyncNoop,
      flushJournalDrafts: asyncNoop,
      flushIntentDrafts: asyncNoop,
      closeOverlay: () => context.detailRequest++,
      npcProgressView: { tab: 'remaining', query: '', page: 0 },
      worldView: {},
      materialView: {},
      refresh: asyncNoop,
      render: noop,
      call: async (method, id) => {
        inspected = { method, id };
        return { record: { id }, name: id, hash: 'a'.repeat(64) };
      },
      rememberDrawer: (view) => (context.currentDrawer = opened = view),
      showOverlay: noop,
      timelineViews: { preview: noop },
      gameViews: { saveDetail: noop },
      gameIndex: {},
      inspectBackupPreview: async (id) => {
        inspected = { method: 'inspectBackup', id };
      },
      showComparison: (_name, value) => {
        comparison = value;
      },
      readComparison: asyncNoop,
    };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end) + '\nthis.receive=receiveHandbookContext;', context);
    const detail = {
      type,
      id: type === 'comparison' ? '' : 'identity',
      hash: type === 'save' ? 'a'.repeat(64) : undefined,
      left: '1.sav',
      right: '2.sav',
      query: '药草',
      questQuery: '求助',
      filter: 'less',
    };
    await context.receive({ profileId: 'p', route: 'saves', query: '', detail });
    if (type === 'comparison') {
      assert.equal(comparison.left, '1.sav');
      assert.equal(comparison.right, '2.sav');
      assert.equal(comparison.filter, 'less');
    } else {
      assert.equal(inspected.id, 'identity');
      assert.equal(
        inspected.method,
        { timeline: 'timelineInspect', save: 'saveDetails', backup: 'inspectBackup' }[type],
      );
      if (type !== 'backup') assert.equal(opened.type, type);
    }
    if (type === 'timeline') {
      let resolve;
      opened = null;
      context.call = () => new Promise((r) => (resolve = r));
      const pending = context.receive({ profileId: 'p', route: 'saves', query: '', detail });
      while (!resolve) await new Promise((r) => setImmediate(r));
      context.detailRequest++;
      resolve({ record: { id: 'identity' } });
      await pending;
      assert.equal(opened, null);
    }
  }
});

test('reading history and presentation remain bounded read-only data', () => {
  const result = handbookContext({
    profileId: 'p',
    presentation: {
      scroll: 800,
      details: [{ summary: '用途', open: true, path: 'secret' }],
      anchor: { label: '用途', occurrence: 0, offset: -20 },
      command: 'restore',
    },
    history: [
      {
        detail: { type: 'search', id: '', query: '药草' },
        presentation: { scroll: 250 },
        history: [{ detail: { type: 'restore', id: 'bad' } }],
      },
      { detail: { type: 'database', id: 'item-133' }, reference: { name: '1.sav', hash: 'a'.repeat(64) } },
    ],
  });
  assert.equal(result.presentation.scroll, 800);
  assert.equal(result.presentation.details[0].open, true);
  assert.equal(result.presentation.details[0].path, undefined);
  assert.equal(result.presentation.command, undefined);
  assert.equal(result.history[0].detail.query, '药草');
  assert.equal(result.history[0].presentation.scroll, 250);
  assert.equal(result.history[0].history, undefined);
  assert.equal(result.history[1].reference.hash, 'a'.repeat(64));
  assert.equal(
    handbookContext({
      profileId: 'p',
      history: Array.from({ length: 40 }, () => ({ detail: { type: 'search', id: '' } })),
    }).history.length,
    30,
  );
});

test('complete shipped flow retains the final offline index disclosure through window handoff', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const view = createFlowViews({
    esc: String,
    act: (_action, label) => label,
    icon: () => '',
    pill: String,
    when: String,
  });
  for (const quest of [5200, 14073, 20000]) {
    const profile = { id: 'synthetic', referenceMode: 'slot', saveSlot: '2.sav' };
    const flow = flowSnapshot(profile, {
      name: '2.sav',
      hash: 'a'.repeat(64),
      metadata: {
        trackingMainQuest: quest,
        trackingQuest: quest,
        quests: [{ id: quest, step: 1 }],
        inventory: [],
      },
    });
    const html = view.panel(flow, { compact: true });
    const details = [...html.matchAll(/<details\b([^>]*)>/g)].map((match) => ({
      key: match[1].match(/data-persist-detail="([^"]+)"/)?.[1] || '',
      summary:
        html
          .slice(match.index + match[0].length)
          .match(/^<summary>([\s\S]*?)<\/summary>/)?.[1]
          .replace(/<[^>]+>/g, '') || '',
      open: match[1].includes('flow-offline-1') || match[1].includes('compact-offline'),
    }));
    assert(
      details.length > 200 && details.length < 512,
      `shipped flow ${quest}: ${details.length} disclosures`,
    );
    for (const field of ['presentation', 'pagePresentation']) {
      const wire = handbookContext({
        profileId: profile.id,
        route: 'checklist',
        [field]: {
          details,
          scroll: 4200,
          anchor: { label: '离线主线索引', occurrence: 0, offset: -12 },
        },
      });
      assert.deepEqual(wire[field].details, details);
      assert.equal(wire[field].details.find((row) => row.key === 'flow-offline-1').open, true);
      assert.equal(wire[field].anchor.label, '离线主线索引');
    }
  }
  const capped = handbookContext({
    profileId: 'synthetic',
    presentation: {
      details: Array.from({ length: 600 }, () => ({
        summary: '用途',
        open: true,
        occurrence: 600,
        command: 'restore',
      })),
    },
  });
  assert.equal(capped.presentation.details.length, 512);
  assert.deepEqual(capped.presentation.details[511], { summary: '用途', key: '', open: true });
});

test('cancelling or navigating while sender drafts save prevents a stale handoff', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf("    case 'main':"),
    end = app.indexOf("    case 'window-minimize':", start);
  assert.ok(start > 0 && end > start);
  for (const change of ['detail', 'navigation', 'profile', 'none']) {
    let resolve,
      sent = 0,
      profileId = 'p';
    const noop = async () => {};
    const context = {
      handbookRequest: 0,
      detailRequest: 0,
      profile: () => ({ id: profileId }),
      route: 'home',
      captureNodeDraft: noop,
      flushNodeDrafts: () => new Promise((r) => (resolve = r)),
      saveNote: noop,
      flushJournalDrafts: noop,
      flushIntentDrafts: noop,
      handbookReadingContext: () => ({
        profileId: 'p',
        route: 'home',
        detail: { type: 'database', id: 'item-133' },
      }),
      root: { querySelector: () => null },
      compact: true,
      handbookSuspended: false,
      call: async (_method, _action, reading) => {
        sent++;
        assert.equal(reading.detail.id, 'item-133');
        assert.equal(reading.route, 'checklist', 'companion flow reading opens the complete task list');
      },
    };
    vm.createContext(context);
    vm.runInContext(
      `this.send=async()=>{const action='main';switch(action){${app.slice(start, end)}}};`,
      context,
    );
    const pending = context.send();
    while (!resolve) await new Promise((r) => setImmediate(r));
    if (change === 'detail') context.detailRequest++;
    if (change === 'navigation') {
      context.route = 'library';
      context.handbookRequest++;
    }
    if (change === 'profile') profileId = 'other';
    resolve();
    await pending;
    assert.equal(sent, change === 'none' ? 1 : 0);
    assert.equal(context.handbookSuspended, change === 'none');
  }
});

test('actual navigation cancels a handoff waiting for refresh before opening its detail', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function receiveHandbookContext('),
    end = app.indexOf('async function openHandbookDetail(', start);
  const navStart = app.indexOf("    case 'navigate': {"),
    navEnd = app.indexOf("    case 'journey-refresh':", navStart);
  let resolve,
    opened = 0;
  const noop = () => {},
    asyncNoop = async () => {};
  const context = {
    compact: false,
    handbookRequest: 0,
    detailRequest: 0,
    profile: () => ({ id: 'p' }),
    captureJournalDraft: noop,
    captureIntentDrafts: noop,
    captureNodeDraft: asyncNoop,
    flushNodeDrafts: asyncNoop,
    saveNote: asyncNoop,
    flushJournalDrafts: asyncNoop,
    flushIntentDrafts: asyncNoop,
    closeOverlay: () => context.detailRequest++,
    overlay: { firstElementChild: null },
    defaultFollow: () => true,
    npcProgressView: { tab: 'remaining', query: '', page: 0 },
    worldView: {},
    materialView: {},
    refresh: () => new Promise((r) => (resolve = r)),
    render: noop,
    openHandbookDetail: async () => {
      opened++;
      return false;
    },
    currentDrawer: null,
    backupPreviewRequest: 0,
    protectionRequest: 0,
    navigationFocused: false,
  };
  vm.createContext(context);
  vm.runInContext(
    app.slice(start, end) +
      `\nthis.receive=receiveHandbookContext;this.navigate=async()=>{const id='library';switch('navigate'){${app.slice(navStart, navEnd)}}};`,
    context,
  );
  const pending = context.receive({
    profileId: 'p',
    route: 'saves',
    query: '',
    detail: { type: 'timeline', id: 'node' },
  });
  while (!resolve) await new Promise((r) => setImmediate(r));
  await context.navigate();
  resolve();
  await pending;
  assert.equal(opened, 0);
  assert.equal(context.route, 'library');
});

test('handbook back restores different slots and offline mode before opening database or place details', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function openHandbookDetail('),
    end = app.indexOf('function recipeDiscoveryPage(', start);
  for (const type of ['database', 'world-place'])
    for (const name of ['1.sav', '']) {
      const reference = { name, hash: name ? 'a'.repeat(64) : '', follow: false };
      const context = {
        detailRequest: 0,
        handbookRequest: 0,
        profile: () => ({ id: 'p' }),
        referenceSaveName: '2.sav',
        referenceFollow: true,
        worldView: { referenceName: '2.sav', reference: { name: '2.sav' } },
        placeMapScopes: new Map([['place-1', 'region']]),
        currentDrawer: null,
        restoreHandbookPresentation: () => {},
        call: async (_method, selected) => {
          assert.equal(selected, '1.sav');
          return { name: selected, hash: reference.hash };
        },
        showDatabaseDetail: async (_id, _quantity, _gift, expected) => {
          assert.equal(context.referenceSaveName, name);
          assert.equal(context.referenceFollow, false);
          assert.equal(expected?.hash, name ? reference.hash : undefined);
          return (context.currentDrawer = { type });
        },
        showWorldDetail: async () => {
          assert.equal(context.placeMapScopes.get('place-1'), 'world');
          assert.equal(context.worldView.referenceName, name);
          assert.equal(context.worldView.reference?.name, name || undefined);
          return (context.currentDrawer = { type });
        },
      };
      vm.createContext(context);
      vm.runInContext(app.slice(start, end) + '\nthis.open=openHandbookDetail;', context);
      assert.equal(
        await context.open({
          detail: { type, id: type === 'database' ? 'item-133' : 'place-1', mapScope: 'world' },
          reference,
        }),
        true,
      );
    }
});

test('a failed handbook back preserves the visible detail, history and its selected reference', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf("    case 'drawer-back': {"),
    end = app.indexOf("    case 'navigate': {", start);
  for (const throws of [false, true]) {
    const previous = { type: 'database', id: 'item-134' },
      view = { type: 'handbook', context: { detail: { type: 'database', id: 'item-133' } } };
    const context = {
      currentDrawer: previous,
      drawerHistory: [view],
      handbookRequest: 1,
      overlay: { firstChild: {} },
      referenceSaveName: '2.sav',
      referenceFollow: false,
      referenceSave: { name: '2.sav' },
      databaseId: 'item-134',
      worldView: { referenceName: '2.sav' },
      openHandbookDetail: async () => {
        context.referenceSaveName = '1.sav';
        context.databaseId = 'item-133';
        if (throws) throw Error('changed');
        return false;
      },
    };
    vm.createContext(context);
    vm.runInContext(`this.back=async()=>{switch('drawer-back'){${app.slice(start, end)}}};`, context);
    if (throws) await assert.rejects(context.back(), /changed/);
    else await context.back();
    assert.equal(context.currentDrawer, previous);
    assert.equal(context.drawerHistory.at(-1), view);
    assert.equal(context.referenceSaveName, '2.sav');
    assert.equal(context.databaseId, 'item-134');
  }
});

test('explicitly revealed guide text remains visible after handoff without changing the spoiler default', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function openHandbookDetail('),
    end = app.indexOf('function recipeDiscoveryPage(', start),
    guideStart = app.indexOf('function showDetail('),
    guideEnd = app.indexOf('function modal(', guideStart);
  for (const revealed of [true, false]) {
    let html = '';
    const context = {
      detailRequest: 0,
      handbookRequest: 0,
      profile: () => ({ id: 'p', checks: {}, favorites: [] }),
      currentDrawer: null,
      restoreHandbookPresentation: () => {},
      revealed: false,
      state: { settings: { spoiler: 'hints' } },
      entry: () => ({
        title: '合成攻略',
        kind: '任务',
        tags: [],
        location: '合成村',
        hint: '提示',
        stage: 0,
        steps: ['合成详细正文'],
        related: [],
        sourceIds: [],
      }),
      catalog: { stages: [{ title: '合成阶段' }] },
      esc: String,
      entityReferences: { text: String },
      pill: () => '',
      icon: () => '',
      iconButton: () => '',
      act: (_action, label) => `<button>${label}</button>`,
      rememberDrawer: (view) => (context.currentDrawer = view),
      showOverlay: (value) => (html = value),
    };
    vm.createContext(context);
    vm.runInContext(
      app.slice(start, end) + app.slice(guideStart, guideEnd) + '\nthis.open=openHandbookDetail;',
      context,
    );
    await context.open(
      handbookContext({ profileId: 'p', detail: { type: 'guide', id: 'synthetic-guide', revealed } }),
    );
    assert.equal(html.includes('合成详细正文'), revealed);
    assert.equal(html.includes('我需要详细线索'), !revealed);
    assert.equal(context.currentDrawer.revealed, revealed);
    assert.equal(context.state.settings.spoiler, 'hints');
  }
});

test('a newer timeline click wins over an older handoff regardless of IPC completion order', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function openHandbookDetail('),
    end = app.indexOf('function recipeDiscoveryPage(', start),
    handleStart = app.indexOf('async function handle('),
    switchStart = app.indexOf('  switch (action) {', handleStart),
    caseStart = app.indexOf("    case 'timeline-preview': {", switchStart),
    caseEnd = app.indexOf("    case 'timeline-load':", caseStart);
  for (const first of ['A', 'B']) {
    const pending = {},
      shown = [];
    const context = {
      detailRequest: 0,
      handbookRequest: 0,
      profile: () => ({ id: 'p' }),
      currentDrawer: null,
      restoreHandbookPresentation: () => {},
      call: (_method, id) => new Promise((resolve) => (pending[id] = resolve)),
      rememberDrawer: (view) => (context.currentDrawer = view),
      showOverlay: () => shown.push(context.currentDrawer.data.record.id),
      timelineViews: { preview: () => '' },
    };
    vm.createContext(context);
    vm.runInContext(
      app.slice(start, end) +
        app.slice(handleStart, switchStart) +
        `switch(action){${app.slice(caseStart, caseEnd)}}}\nthis.open=openHandbookDetail;this.click=handle;`,
      context,
    );
    const old = context.open({ detail: { type: 'timeline', id: 'A' } }),
      latest = context.click('timeline-preview', 'B', null);
    pending[first]({ record: { id: first } });
    await Promise.resolve();
    pending[first === 'A' ? 'B' : 'A']({ record: { id: first === 'A' ? 'B' : 'A' } });
    await Promise.all([old, latest]);
    assert.deepEqual(shown, ['B']);
    assert.equal(context.currentDrawer.data.record.id, 'B');
  }
});

test('duel skill details load their flow reference without relying on a prior entity cache', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function showDatabaseDetail(');
  const end = app.indexOf('function recipeQuantity()', start);
  const caseStart = app.indexOf("    case 'database-detail': {");
  const caseEnd = app.indexOf("    case 'database-uses':", caseStart);
  for (const cached of [null, { name: '2.sav', hash: 'b'.repeat(64) }]) {
    let reads = 0,
      renders = 0;
    const reference = { name: '1.sav', hash: 'a'.repeat(64) };
    const context = {
      id: 'skill-404',
      target: { closest: () => true },
      currentDrawer: null,
      handbookRequest: 0,
      detailRequest: 0,
      referenceSave: cached,
      referenceSaveName: undefined,
      referenceFollow: undefined,
      currentFlow: () => ({ reference }),
      route: 'duels',
      profile: () => ({ id: 'p', craftList: [], reservations: {} }),
      planningIntentSignature: () => '',
      gameIndex: {},
      gameViews: { byId: () => ({ id: 'skill-404', kind: '武学' }), detail: () => '罗汉拳' },
      toast: (text) => assert.fail(text),
      defaultFollow: () => true,
      latestReference: () => '1.sav',
      defaultReference: () => '1.sav',
      call: async (method, name) => {
        assert.equal(method, 'saveDetails');
        assert.equal(name, '1.sav');
        reads++;
        return reference;
      },
      document: { querySelector: () => null },
      reservableReference: (r) => r,
      environment: { saves: { files: [] } },
      catalog: { entries: [] },
      worldViews: {},
      planningTotals: () => ({}),
      rememberDrawer: (view) => (context.currentDrawer = view),
      showOverlay: (html) => {
        assert.equal(html, '罗汉拳');
        renders++;
      },
    };
    vm.createContext(context);
    vm.runInContext(
      app.slice(start, end) +
        `\nthis.run=async()=>{switch('database-detail'){${app.slice(caseStart, caseEnd)}}};`,
      context,
    );
    await context.run();
    assert.equal(reads, 1);
    assert.equal(renders, 1);
  }
});

test('item refresh preserves the latest unsubmitted reservation input only in the same drawer', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function showDatabaseDetail('),
    end = app.indexOf('function recipeQuantity()', start);
  for (const value of ['7', '']) {
    for (const same of [true, false]) {
      let field = { value: '3' },
        resolveRead;
      const saved = { id: 'p', reservations: { 1000: 2 } };
      const context = {
        currentDrawer: { type: 'database', id: same ? 'item-1000' : 'item-1001' },
        referenceSaveName: '1.sav',
        referenceFollow: false,
        referenceSave: null,
        handbookRequest: 0,
        detailRequest: 0,
        profile: () => saved,
        defaultFollow: () => false,
        planningIntentSignature: () => 'updated plans',
        gameIndex: {},
        catalog: { entries: [] },
        worldViews: {},
        gameViews: { byId: () => ({ kind: '物品' }), detail: () => 'item' },
        call: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
        reservableReference: (reference) => reference,
        environment: { saves: { files: [] } },
        planningTotals: () => ({}),
        projectItemUsage: () => ({}),
        itemUsageViews: { detail: () => '' },
        rememberDrawer: (view) => (context.currentDrawer = view),
        showOverlay: () => {
          field = { value: String(saved.reservations[1000]) };
        },
        document: { querySelector: (selector) => (selector === '#reserve-count' ? field : null) },
      };
      vm.createContext(context);
      vm.runInContext(app.slice(start, end) + '\nthis.open=showDatabaseDetail;', context);
      const pending = context.open('item-1000');
      field.value = value;
      resolveRead({ name: '1.sav', hash: 'new save hash' });
      await pending;
      assert.equal(field.value, same ? value : '2');
      assert.equal(saved.reservations[1000], 2);
    }
  }
});

test('late database reads cannot replace the newer preview reference or surface obsolete errors', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function showDatabaseDetail('),
    end = app.indexOf('function recipeQuantity()', start);
  for (const lateResult of ['success', 'failure', 'profile-change']) {
    const pending = new Map(),
      rendered = [],
      messages = [];
    let profileId = 'p';
    const context = {
      currentDrawer: null,
      referenceSaveName: '1.sav',
      referenceFollow: false,
      referenceSave: null,
      handbookRequest: 0,
      detailRequest: 0,
      profile: () => ({ id: profileId, reservations: {} }),
      defaultFollow: () => false,
      planningIntentSignature: () => '',
      gameIndex: {},
      catalog: { entries: [] },
      worldViews: {},
      gameViews: {
        byId: () => ({ kind: '武学' }),
        detail: (_index, id, _quantity, reference) => {
          rendered.push([id, reference.name]);
          return id;
        },
      },
      call: (_method, name) => new Promise((resolve, reject) => pending.set(name, { resolve, reject })),
      reservableReference: (reference) => reference,
      environment: { saves: { files: [] } },
      planningTotals: () => ({}),
      rememberDrawer: (view) => (context.currentDrawer = view),
      showOverlay: () => {},
      toast: (message) => messages.push(message),
      document: { querySelector: () => null },
    };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end) + '\nthis.open=showDatabaseDetail;', context);
    const older = context.open('skill-a');
    const currentReference = { name: '2.sav', hash: 'b'.repeat(64) };
    if (lateResult === 'profile-change') {
      profileId = 'other';
      context.referenceSaveName = undefined;
      context.referenceSave = null;
    } else {
      context.referenceSaveName = '2.sav';
      const newer = context.open('skill-b');
      pending.get('2.sav').resolve(currentReference);
      await newer;
    }
    if (lateResult === 'failure') pending.get('1.sav').reject(Error('obsolete read failure'));
    else pending.get('1.sav').resolve({ name: '1.sav', hash: 'a'.repeat(64) });
    await older;
    assert.equal(context.referenceSave, lateResult === 'profile-change' ? null : currentReference);
    assert.deepEqual(rendered, lateResult === 'profile-change' ? [] : [['skill-b', '2.sav']]);
    assert.deepEqual(messages, []);
  }
});

test('handbook handoff reads the exact saved reference before resuming latest-follow behavior', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  for (const follow of [false, true])
    for (const changed of [false, true]) {
      const original = { name: '1.sav', hash: 'a'.repeat(64) };
      const newer = { name: '2.sav', hash: 'b'.repeat(64) };
      const reads = [],
        rendered = [],
        messages = [];
      const context = {
        currentDrawer: null,
        detailRequest: 0,
        handbookRequest: 0,
        referenceSave: null,
        referenceSaveName: undefined,
        referenceFollow: undefined,
        profile: () => ({ id: 'synthetic', reservations: {} }),
        planningIntentSignature: () => '',
        gameIndex: {},
        catalog: { entries: [] },
        worldViews: {},
        defaultFollow: () => true,
        latestReference: () => newer.name,
        defaultReference: () => newer.name,
        currentFlow: () => null,
        gameViews: {
          byId: () => ({ kind: '武学' }),
          detail: (_index, id, _quantity, reference) => {
            rendered.push(reference.name);
            return id;
          },
        },
        call: async (_method, name) => {
          reads.push(name);
          return name === original.name
            ? { ...original, hash: changed ? 'c'.repeat(64) : original.hash }
            : newer;
        },
        reservableReference: (reference) => reference,
        planningTotals: () => ({}),
        environment: { saves: { files: [] } },
        document: { querySelector: () => null },
        rememberDrawer: (view) => (context.currentDrawer = view),
        showOverlay: () => {},
        restoreHandbookPresentation: () => {},
        toast: (message) => messages.push(message),
      };
      vm.createContext(context);
      vm.runInContext(
        part('async function showDatabaseDetail(', 'function recipeQuantity()') +
          part('async function openHandbookDetail(', 'function recipeDiscoveryPage(') +
          '\nthis.handoff=openHandbookDetail;this.open=showDatabaseDetail;',
        context,
      );
      const opened = await context.handoff({
        detail: { type: 'database', id: 'skill-404', quantity: 1 },
        reference: { ...original, follow },
      });
      assert.deepEqual(reads, ['1.sav']);
      assert.equal(opened, !changed);
      assert.deepEqual(rendered, changed ? [] : ['1.sav']);
      assert.equal(messages.length, changed ? 1 : 0);
      assert.equal(context.referenceFollow, follow);
      if (!changed) {
        await context.open('skill-405');
        assert.equal(
          reads.at(-1),
          follow ? '2.sav' : '1.sav',
          'subsequent navigation still honors the saved follow preference',
        );
      }
    }
});
test('saved-detail and pinned-choice previews cannot borrow a different progress snapshot', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const at = source.indexOf('  context: async (target) => {', source.indexOf('const entityPreviews'));
  const end = source.indexOf('\n  },\n});', at);
  assert(at > 0 && end > at);
  const callback = source.slice(at + '  context: '.length, end + 4);
  const saved = { name: '1.sav', hash: 'old', metadata: { quests: [{ id: 5200, step: 4 }] } };
  const newer = { name: '2.sav', hash: 'new', metadata: { quests: [{ id: 5200, step: 1 }] } };
  const sandbox = {
    currentDrawer: { type: 'save', data: saved },
    referenceSave: newer,
    worldView: { reference: newer },
    currentFlow: () => ({ reference: newer, active: [{ id: 'quest-5200' }] }),
    entityPreviewReference: null,
    call: async () => saved,
  };
  const context = vm.runInNewContext('(' + callback + ')', sandbox);
  const target = { closest: () => false };
  assert.equal((await context(target)).reference, saved);
  sandbox.currentDrawer = { type: 'entity-choice', flowReference: saved };
  const pinned = await context(target);
  assert.equal(pinned.reference, saved);
  assert.equal(
    pinned.statuses.size,
    0,
    'newer active-task labels cannot override the pinned completed record',
  );
  sandbox.currentDrawer = { type: 'entity-choice', reference: saved };
  assert.equal((await context(target)).reference, saved);
  sandbox.currentDrawer = { type: 'comparison' };
  assert.equal(
    (await context(target)).reference,
    null,
    'two-sided comparisons do not invent one current inventory',
  );
});
test('same-name chooser keeps pinned snapshots and follows latest through task and place navigation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function followsLiveWorld(');
  const end = source.indexOf('async function calculateMaterials(', start);
  for (const type of ['quest', 'place'])
    for (const mode of ['pinned', 'changed-pinned', 'fixed', 'latest']) {
      const changed = mode === 'changed-pinned',
        follow = mode === 'latest';
      const saved = { name: '1.sav', hash: 'old', metadata: { quests: [] } };
      const latest = { name: '2.sav', hash: 'new', metadata: { quests: [] } };
      const rendered = [];
      const reads = [];
      const context = {
        currentDrawer: {
          type: 'entity-choice',
          reference: saved,
          referenceName: saved.name,
          referenceHash: saved.hash,
          follow,
          flowReference: mode.includes('pinned') ? saved : null,
        },
        defaultFollow: () => follow,
        detailRequest: 0,
        handbookRequest: 0,
        worldView: { reference: latest, referenceName: latest.name, follow: true },
        placeMapScopes: new Map(),
        referenceSaveName: latest.name,
        referenceSave: latest,
        referenceFollow: true,
        call: async (_method, name) => {
          reads.push(name);
          return follow ? latest : changed || mode === 'fixed' ? { ...saved, hash: 'replacement' } : saved;
        },
        state: { settings: {} },
        profile: () => ({ allocations: [] }),
        gameIndex: {},
        latestReference: () => latest.name,
        worldViews: {
          questDetail: (_index, _id, view) => {
            rendered.push(view);
            return '<p>task</p>';
          },
          placeDetail: (_index, _id, view) => {
            rendered.push(view);
            return '<p>place</p>';
          },
        },
        rememberDrawer: (drawer) => {
          context.currentDrawer = drawer;
        },
        showOverlay: () => {},
      };
      vm.createContext(context);
      vm.runInContext(source.slice(start, end) + '\nthis.open = showWorldDetail;', context);
      await context.open(type === 'quest' ? 'quest-5200' : 'place-9', type);
      assert.deepEqual(reads, [follow ? '2.sav' : '1.sav']);
      assert.equal(rendered.length, 1);
      if (mode === 'fixed') assert.equal(rendered[0].reference.hash, 'replacement');
      else assert.equal(rendered[0].reference, follow ? latest : changed ? null : saved);
      assert.equal(rendered[0].follow, follow);
      assert.equal(Boolean(rendered[0].error), changed);
    }
});
test('legacy journal place links open scene choices without rewriting the stored identity', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  for (const id of ['place-96', 'place-97']) {
    const record = { links: [{ type: 'place', id, label: '原地点记录' }] };
    const original = JSON.stringify(record);
    const opened = [];
    const ctx = {
      id: `place:${id}`,
      profile: () => ({ journalEntries: [record] }),
      currentDrawer: null,
      route: 'journal',
      defaultFollow: () => false,
      gameIndex: {
        world: {
          maps: [
            { id, key: 'scene-a' },
            { id, key: 'scene-b' },
          ],
        },
      },
      showEntityChoice: async (choice, reference) => opened.push({ choice, reference }),
    };
    vm.createContext(ctx);
    vm.runInContext(
      slice('function followsLiveWorld(', 'async function calculateMaterials(') +
        `async function open() { switch ('journal-link') {` +
        slice("    case 'journal-link': {", "    case 'search-personal-all':") +
        '}} this.open = open;',
      ctx,
    );
    await ctx.open();
    assert.deepEqual(opened, [{ choice: id, reference: null }]);
    assert.equal(JSON.stringify(record), original);
  }
});

test('top-level and unbound guide/search choices use Settings while explicit snapshots and none stay distinct', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('async function showEntityChoice(');
  const end = source.indexOf('function render(', start);
  const old = { name: 'older.sav', hash: 'old' };
  const latest = { name: 'current.sav', hash: 'new' };
  for (const drawer of [null, 'guide', 'search']) {
    for (const mode of ['latest', 'fixed', 'none', 'restored', 'saved-detail']) {
      const reads = [];
      const context = {
        currentDrawer:
          mode === 'saved-detail' ? { type: 'save', data: old } : drawer ? { type: drawer } : null,
        referenceSave: drawer ? null : old,
        referenceSaveName: drawer ? undefined : old.name,
        referenceFollow: false,
        handbookRequest: 0,
        detailRequest: 0,
        profile: () => ({ id: 'synthetic' }),
        defaultReference: () => (mode === 'none' ? '' : latest.name),
        defaultFollow: () => mode === 'latest',
        call: async (_method, name) => {
          reads.push(name);
          return latest;
        },
        entityReferences: {
          choices: () => [{ id: 'place-9', name: '梧桐村', kind: '地点' }],
          choiceSummary: () => '',
        },
        rememberDrawer: (drawer) => {
          context.currentDrawer = drawer;
        },
        showOverlay() {},
        esc: String,
        act: () => '',
        iconButton: () => '',
      };
      vm.createContext(context);
      vm.runInContext(source.slice(start, end) + '\nthis.open = showEntityChoice;', context);
      await context.open(
        'name:梧桐村',
        null,
        null,
        mode === 'restored' ? { reference: old, referenceName: old.name, follow: false } : null,
      );
      assert.equal(
        context.currentDrawer.reference,
        ['restored', 'saved-detail'].includes(mode) ? old : mode === 'none' ? null : latest,
      );
      assert.deepEqual(reads, ['latest', 'fixed'].includes(mode) ? [latest.name] : []);
      assert.equal(context.currentDrawer.follow, mode === 'latest');
      assert.equal(context.currentDrawer.flowReference, mode === 'saved-detail' ? old : null);
    }
  }
});

test('latest and fixed-slot choosers refresh while explicit snapshots keep their identity', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const slice = (start, end) =>
    source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  for (const mode of ['latest-slot', 'latest-bytes', 'fixed', 'pinned']) {
    const newSlot = mode === 'latest-slot',
      follow = mode.startsWith('latest'),
      pinned = mode === 'pinned';
    const old = { name: '1.sav', hash: 'old', metadata: {} };
    const latest = { name: newSlot ? '2.sav' : '1.sav', hash: 'new', metadata: {} };
    const opened = [];
    const ctx = {
      currentDrawer: {
        type: 'entity-choice',
        id: 'name:道通',
        reference: old,
        referenceName: old.name,
        referenceHash: old.hash,
        follow,
        flowReference: pinned ? old : null,
      },
      referenceSave: old,
      referenceSaveName: old.name,
      referenceFollow: follow,
      refreshRequest: 0,
      root: {},
      entityPreviews: { refreshOutside() {} },
      handbookRequest: 0,
      detailRequest: 0,
      environment: { saves: { files: [old] } },
      worldView: {},
      materialView: {},
      journeyDraft: null,
      route: 'home',
      composing: false,
      recipeDiscoverySourceSignature: () => '',
      latestReference: () => latest.name,
      profile: () => ({ id: 'p' }),
      render() {},
      call: async (method) => (method === 'refresh' ? { saves: { files: [latest] } } : latest),
      entityReferences: {
        choices: () => [{ id: 'npc-5011', kind: '人物', name: '道通' }],
        choiceSummary: () => '',
      },
      rememberDrawer: (value, replace) => {
        assert.equal(replace, true);
        ctx.currentDrawer = value;
      },
      showOverlay() {},
      esc: String,
      act: () => '',
      iconButton: () => '',
      showDatabaseDetail: async (_id, _quantity, _page, expected) => opened.push(expected),
    };
    vm.createContext(ctx);
    vm.runInContext(
      slice('async function showEntityChoice(', 'function render(') +
        slice('async function refreshLiveNpcDetail(', 'async function handle(') +
        `async function select(id, target) { switch ('database-detail') {` +
        slice("    case 'database-detail': {", "    case 'database-uses': {") +
        '}}\nthis.poll = refresh; this.select = select;',
      ctx,
    );
    await ctx.poll(true);
    assert.equal(ctx.currentDrawer.reference, pinned ? old : latest);
    assert.equal(ctx.currentDrawer.referenceName, pinned ? old.name : latest.name);
    assert.equal(ctx.currentDrawer.referenceHash, pinned ? old.hash : latest.hash);
    assert.equal(ctx.currentDrawer.follow, follow);
    // A save can also change just before the next poll: live choices must still read latest.
    Object.assign(ctx.currentDrawer, { reference: old, referenceName: old.name, referenceHash: old.hash });
    await ctx.select('npc-5011', { closest: () => null });
    assert.equal(ctx.referenceFollow, follow);
    assert.deepEqual(opened, [pinned ? old : null]);
  }
});

test('new search from a historical drawer uses Settings while restored search keeps its snapshot', () => {
  for (const restored of [false, true]) {
    const { context } = readingHistoryHarness();
    const old = { name: 'old.sav', hash: 'old' };
    context.currentDrawer = { type: 'save', data: old };
    context.referenceSave = old;
    context.referenceSaveName = old.name;
    context.referenceFollow = false;
    Object.assign(context.worldView, { reference: old, referenceName: old.name, follow: false });
    context.defaultFollow = () => true;
    context.searchModal(restored ? { query: '物品' } : undefined);
    assert.equal(context.referenceSave, restored ? old : null);
    assert.equal(context.referenceSaveName, restored ? old.name : undefined);
    assert.equal(context.referenceFollow, !restored);
    assert.equal(context.worldView.reference, restored ? old : null);
    assert.equal(context.worldView.referenceName, restored ? old.name : undefined);
    assert.equal(context.worldView.follow, !restored);
    assert.equal(context.drawerHistory.length, 0);
  }
});

test('closing or replacing a pending world-detail return cancels the old drawer', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf("    case 'drawer-back': {"),
    end = app.indexOf("    case 'navigate': {", start);
  for (const cancel of [false, true]) {
    let complete;
    let opened = 0;
    const context = {
      currentDrawer: { type: 'database', id: 'item-1' },
      drawerHistory: [{ type: 'world-quest', id: 'quest-1', referenceName: 'old.sav', follow: false }],
      handbookRequest: 1,
      detailRequest: 1,
      worldView: {},
      loadWorldReference: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      showWorldDetail: async () => {
        opened++;
      },
    };
    vm.createContext(context);
    vm.runInContext(`this.back=async()=>{switch('drawer-back'){${app.slice(start, end)}}};`, context);
    const pending = context.back();
    if (cancel) {
      context.detailRequest++;
      context.currentDrawer = null;
    }
    complete();
    await pending;
    assert.equal(opened, cancel ? 0 : 1);
  }
});

test('new searches reject late historical refreshes and preview the Settings reference in latest, fixed and none modes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const a = source.indexOf('async function refreshLiveNpcDetail('),
    b = source.indexOf('async function handle(', a);
  const previewStart = source.indexOf(
    '  context: async (target) => {',
    source.indexOf('const entityPreviews'),
  );
  const previewEnd = source.indexOf('\n  },\n});', previewStart);
  for (const mode of ['latest', 'slot', 'none']) {
    const { context } = readingHistoryHarness();
    let resolveOld;
    const old = { name: 'old.sav', hash: 'old-current', metadata: { inventory: [{ id: 133, count: 99 }] } };
    const latest = { name: 'latest.sav', hash: 'new', metadata: { inventory: [{ id: 133, count: 1 }] } };
    Object.assign(context, {
      route: 'database',
      currentDrawer: { type: 'database', id: 'item-133' },
      referenceSave: { ...old, hash: 'old-before' },
      referenceSaveName: old.name,
      referenceFollow: false,
      worldView: {},
      materialView: {},
      journeyDraft: null,
      refreshRequest: 0,
      recipeDiscoverySourceSignature: () => '',
      recipeDiscoveryNeedsRefresh: false,
      composing: false,
      render() {},
      entityPreviewReference: null,
      defaultFollow: () => mode === 'latest',
      defaultReference: () => (mode === 'none' ? '' : latest.name),
      latestReference: () => latest.name,
      environment: { saves: { files: [old, latest] } },
      call: async (method, name) =>
        method === 'refresh'
          ? context.environment
          : name === old.name
            ? new Promise((resolve) => {
                resolveOld = resolve;
              })
            : latest,
    });
    vm.runInContext(
      source.slice(a, b) +
        '\nthis.refreshActual = refresh;\nthis.previewActual = ' +
        source.slice(previewStart + '  context: '.length, previewEnd + 4) +
        ';',
      context,
    );
    const pending = context.refreshActual(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof resolveOld, 'function');
    context.searchModal();
    resolveOld(old);
    await pending;
    assert.equal(
      context.referenceSave,
      mode === 'none' ? null : latest,
      'only the selected current progress may populate the new search',
    );
    const preview = await context.previewActual({ closest: () => false });
    assert.equal(preview.reference, mode === 'none' ? null : latest);
    context.currentDrawer = { type: 'guide', id: 'wei-huo' };
    const guidePreview = await context.previewActual({ closest: () => false });
    assert.equal(guidePreview.reference, mode === 'none' ? null : latest);
  }
});

test('Settings updates from another window reload an open item or chooser and invalidate pending reads', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) =>
    source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  for (const [mode, drawerType] of ['none', 'slot', 'latest'].flatMap((mode) =>
    ['database', 'entity-choice'].map((type) => [mode, type]),
  )) {
    const old = { name: '1.sav', hash: 'old', metadata: { inventory: [{ id: 133, count: 9 }] } };
    const nextSave = { name: '2.sav', hash: 'new', metadata: { inventory: [{ id: 133, count: 3 }] } };
    const initial = {
      activeProfileId: 'p',
      settings: { savePath: 'synthetic' },
      profiles: [{ id: 'p', referenceMode: 'slot', saveSlot: '1.sav' }],
    };
    const reloads = [];
    const context = {
      state: initial,
      profile: () => context.state.profiles[0],
      currentDrawer: {
        type: drawerType,
        id: 'item-133',
        planningSignature: '',
        reference: old,
        referenceName: old.name,
        referenceHash: old.hash,
        flowReference: old,
        follow: false,
      },
      referenceSave: old,
      referenceSaveName: old.name,
      referenceFollow: false,
      worldView: {},
      materialView: {},
      route: 'database',
      compact: false,
      environment: { saves: { files: [old, nextSave] }, recent: old },
      recipeDiscoveryTimer: null,
      recipeDiscoveryRequest: 0,
      recipeDiscoveryNeedsRefresh: false,
      worldRequest: 0,
      materialRequest: 0,
      refreshRequest: 0,
      handbookRequest: 0,
      detailRequest: 40,
      root: {},
      drawerHistory: [],
      entityPreviews: { close() {}, refreshOutside() {} },
      journeyDraft: null,
      composing: false,
      recipeDiscoverySourceSignature: () => '',
      planningIntentSignature: () => '',
      defaultReference: () =>
        context.profile().referenceMode === 'none' ? '' : context.profile().saveSlot || nextSave.name,
      defaultFollow: () => context.profile().referenceMode === 'latest',
      latestReference: () => nextSave.name,
      gameIndex: {},
      gameViews: { byId: () => ({ kind: '物品' }) },
      entityReferences: {
        choices: () => [{ id: 'item-133', name: '物品', kind: '物品' }],
        choiceSummary: () => '',
      },
      esc: String,
      act: () => '',
      iconButton: () => '',
      rememberDrawer(drawer, replace) {
        assert.equal(replace, true, 'a Settings refresh must not add history');
        context.currentDrawer = drawer;
        reloads.push([drawer.id, drawer.referenceName]);
      },
      showOverlay() {},
      clearTimeout() {},
      invalidateBackupPreview() {},
      render() {},
      showDatabaseDetail(id) {
        reloads.push([id, context.defaultReference()]);
      },
      api: {
        onState(callback) {
          context.changed = callback;
        },
      },
      call: async (method, name) =>
        method === 'saveDetails'
          ? (assert.equal(name, nextSave.name), nextSave)
          : { saves: { files: [old, nextSave] }, recent: null },
      toast(message) {
        assert.fail(message);
      },
      showSearchResults() {},
    };
    vm.createContext(context);
    vm.runInContext(
      part('function resetPlanningViews()', 'function worldPage()') +
        part('async function showEntityChoice(', 'function render(') +
        part('async function refreshLiveNpcDetail(', 'async function handle(') +
        part('  api.onState((next) => {', '  api.onEvent((event) => {'),
      context,
    );
    context.changed({
      ...initial,
      profiles: [{ id: 'p', referenceMode: mode, saveSlot: mode === 'slot' ? '2.sav' : '' }],
    });
    if (drawerType === 'entity-choice') {
      assert.equal(context.currentDrawer.reference, null, 'old snapshot is cleared before any async reload');
      assert.equal(context.currentDrawer.flowReference, null);
      assert.equal(context.currentDrawer.referenceName, undefined);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reloads, [['item-133', mode === 'none' ? '' : '2.sav']]);
    assert.equal(context.detailRequest, drawerType === 'entity-choice' ? 42 : 41);
    if (drawerType === 'entity-choice') {
      assert.equal(context.currentDrawer.reference, mode === 'none' ? null : nextSave);
      assert.equal(context.currentDrawer.follow, mode === 'latest');
    }
  }
});

test('historical comparisons open static codex entries without substituting current game progress', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) =>
    source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const previewStart = source.indexOf(
    '  context: async (target) => {',
    source.indexOf('const entityPreviews'),
  );
  const previewEnd = source.indexOf('\n  },\n});', previewStart);
  for (const drawerType of ['comparison', 'timeline']) {
    const live = { name: 'current.sav', hash: 'latest', metadata: { quests: [{ id: 5200, step: 4 }] } };
    const context = {
      currentDrawer: { type: drawerType },
      defaultFollow: () => true,
      target: { closest: () => false },
      id: 'item-133',
      referenceSave: live,
      referenceSaveName: live.name,
      referenceFollow: true,
      worldView: { reference: live, referenceName: live.name, follow: true },
      gameIndex: { world: { maps: [] } },
      state: { settings: {} },
      environment: { saves: { files: [live] } },
      profile: () => ({ allocations: [] }),
      detailRequest: 0,
      handbookRequest: 0,
      placeMapScopes: new Map(),
      call: () => assert.fail('historical lookup must not read the current slot'),
      loadWorldReference: () => assert.fail('historical lookup must not follow latest'),
      worldViews: {
        questDetail: (_data, _id, view) => {
          assert.equal(view.reference, null);
          assert.equal(view.referenceName, '');
          assert.equal(view.follow, false);
          return 'static quest';
        },
      },
      rememberDrawer: (view) => {
        context.currentDrawer = view;
      },
      showOverlay() {},
      showDatabaseDetail: () => {
        assert.equal(context.referenceSave, null);
        assert.equal(context.referenceSaveName, '');
        assert.equal(context.referenceFollow, false);
      },
    };
    vm.createContext(context);
    vm.runInContext(
      part('function followsLiveWorld(', 'async function calculateMaterials(') +
        `this.openItem = async () => { switch ('database-detail') { ${part("    case 'database-detail': {", "    case 'database-uses':")} } };` +
        '\nthis.preview = ' +
        source.slice(previewStart + '  context: '.length, previewEnd + 4) +
        ';',
      context,
    );
    assert.equal((await context.preview(context.target)).reference, null);
    await context.openItem();
    await context.showWorldDetail('quest-5200');
    assert.equal(context.currentDrawer.referenceName, '');
    assert.equal(context.currentDrawer.follow, false);
  }
});

test('archive entity previews and navigation never substitute the current slot', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const a = source.indexOf("    case 'archive-entity': {"),
    b = source.indexOf("    case 'database-detail': {", a);
  const previewStart = source.indexOf(
    '  context: async (target) => {',
    source.indexOf('const entityPreviews'),
  );
  const previewEnd = source.indexOf('\n  },\n});', previewStart);
  for (const kind of ['人物', '物品', '任务', '地点']) {
    const target = { dataset: { action: 'archive-entity' }, closest: () => false };
    const ctx = {
      gameIndex: {},
      entityCatalog: () => ({ resolve: () => [{ kind }] }),
      id: 'exact-identity',
      target,
      referenceSaveName: 'current.sav',
      referenceFollow: true,
      referenceSave: { name: 'current.sav' },
      call: () => assert.fail('static entity must not read a save'),
      showWorldDetail: (_id, _type, _replace, view) => {
        assert.equal(view.referenceName, '');
        assert.equal(view.reference, null);
        assert.equal(view.follow, false);
      },
      showDatabaseDetail: () => {
        assert.equal(ctx.referenceSaveName, '');
        assert.equal(ctx.referenceSave, null);
        assert.equal(ctx.referenceFollow, false);
      },
    };
    vm.createContext(ctx);
    vm.runInContext(
      `this.open = async () => { switch ('archive-entity') { ${source.slice(a, b)} } };` +
        '\nthis.preview = ' +
        source.slice(previewStart + '  context: '.length, previewEnd + 4) +
        ';',
      ctx,
    );
    assert.equal((await ctx.preview(target)).reference, null);
    await ctx.open();
  }
});

test('global quest filtering follows settings and keeps a historical search reference', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const begin = source.indexOf('function searchQuestStatuses(');
  const end = source.indexOf('function showSearchResults(', begin);
  const older = { name: '1.sav', metadata: { quests: [{ id: 5200, status: '进行中' }] } };
  const latest = { name: '2.sav', metadata: { quests: [{ id: 5200, status: '已完成' }] } };
  let chosen = latest.name;
  const ctx = {
    referenceSaveName: undefined,
    referenceSave: null,
    referenceFollow: true,
    currentDrawer: null,
    route: 'database',
    worldView: {},
    currentFlow: () => null,
    defaultFollow: () => !!chosen,
    defaultReference: () => chosen,
    environment: { recent: latest, saves: { files: [older, latest] } },
  };
  vm.createContext(ctx);
  const helperStart = source.indexOf('function followsLiveWorld(');
  const helperEnd = source.indexOf('async function showWorldDetail(', helperStart);
  vm.runInContext(source.slice(helperStart, helperEnd) + source.slice(begin, end), ctx);
  assert.equal(ctx.searchQuestStatuses().get(5200), '已完成');
  chosen = older.name;
  assert.equal(ctx.searchQuestStatuses().get(5200), '进行中');
  chosen = '';
  assert.equal(ctx.searchQuestStatuses().size, 0);
  chosen = 'missing.sav';
  assert.equal(ctx.searchQuestStatuses().size, 0);
  chosen = latest.name;
  ctx.referenceSaveName = older.name;
  ctx.referenceSave = older;
  assert.equal(ctx.searchQuestStatuses().get(5200), '进行中');
  ctx.referenceSaveName = '';
  assert.equal(ctx.searchQuestStatuses().size, 0);
});

test('typed place choices survive handoff and history without accepting paths or unbounded identifiers', () => {
  const id = 'place-name:和璞山庄';
  const result = handbookContext({
    profileId: 'p',
    detail: { type: 'entity-choice', id },
    history: [{ detail: { type: 'entity-choice', id: 'place-name:五仙教' } }],
  });
  assert.equal(result.detail.id, id);
  assert.equal(result.history[0].detail.id, 'place-name:五仙教');
  assert.equal(
    handbookContext({ profileId: 'p', detail: { type: 'entity-choice', id: 'place-name:' + 'a'.repeat(89) } })
      .detail.id.length,
    100,
  );
  for (const suffix of ['', '../private', 'C:\\private', '\nscript', 'a'.repeat(90)])
    assert.throws(() =>
      handbookContext({ profileId: 'p', detail: { type: 'entity-choice', id: 'place-name:' + suffix } }),
    );
});
