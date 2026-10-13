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
    currentFlow: () => null,
    referenceSave: null,
    referenceSaveName: '',
    referenceFollow: false,
    defaultFollow: () => false,
    route: 'home',
    query: '',
    databaseKind: '全部',
    databaseType: '全部',
    databasePage: 0,
    worldView: {},
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
  await context.receive(wire);
  assert.equal(context.currentDrawer.giftPage, 2);
  assert.equal(context.databasePage, 3);
  assert.equal(restored.at(-1).page, true);
  assert.equal(restored.at(-1).value.scroll, 840);
  await context.open(wire.history[0]);
  assert.equal(context.currentDrawer.id, 'name:莫弃');
  assert.equal(context.currentDrawer.flowReference.name, '2.sav');
  context.route = 'world';
  context.currentDrawer = null;
  const world = handbookContext(context.capture());
  assert.equal(world.reference.name, '2.sav', 'the world list keeps its selection instead of the flow slot');
  Object.assign(context.worldView, { status: 'all', page: 0, roots: true });
  await context.receive(world);
  assert.equal(context.worldView.status, 'active');
  assert.equal(context.worldView.page, 2);
  assert.equal(context.worldView.roots, false);
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

test('task materials preserve the exact flow reference when a separate crafting reference is selected', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf("    case 'database-detail': {");
  const end = app.indexOf("    case 'database-uses':", start);
  assert.ok(start > 0 && end > start);
  for (const fromFlow of [true, false]) {
    let opened;
    const flow = { name: '1.sav', hash: 'a'.repeat(64) };
    const context = {
      id: 'item-10016',
      target: { closest: () => fromFlow },
      currentDrawer: null,
      currentFlow: () => ({ reference: flow }),
      route: 'materials',
      mutationQueue: Promise.resolve(),
      materialView: { referenceName: '2.sav', follow: false },
      referenceSave: {},
      defaultReference: () => '3.sav',
      defaultFollow: () => true,
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
    assert.equal(opened.name, fromFlow ? '1.sav' : '2.sav');
    assert.equal(opened.expected?.hash, fromFlow ? flow.hash : undefined);
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

test('cancelling or navigating while sender drafts save prevents a stale handoff', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf("    case 'main':\n    case 'main-materials':"),
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
          assert.equal(context.worldView.referenceName, name);
          assert.equal(context.worldView.reference?.name, name || undefined);
          return (context.currentDrawer = { type });
        },
      };
      vm.createContext(context);
      vm.runInContext(app.slice(start, end) + '\nthis.open=openHandbookDetail;', context);
      assert.equal(
        await context.open({ detail: { type, id: type === 'database' ? 'item-133' : 'place-1' }, reference }),
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
