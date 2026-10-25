'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { encyclopedia } = require('../src/core/game-data.cjs');
const {
  emptyJourneyState,
  validateJourneyState,
  applyJourneyCommand,
} = require('../src/core/journey-state.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { Store } = require('../src/core/store.cjs');
const { intentTarget } = require('../src/core/intent-drafts.cjs');
const catalog = require('../src/data/catalog.cjs');
const index = encyclopedia();
const sulfurId = 'item-10501';
const medicineId = 'item-100';
const gift = (extra = {}) => ({
  id: 'legacy-sulfur',
  npcId: 'npc-12600',
  itemId: sulfurId,
  quantity: 1,
  note: '玩家保留的旧备注',
  done: false,
  ...extra,
});
const command = (row) => ({ type: 'journey-gift-put', ...row });
const legacyJourney = () => ({ ...emptyJourneyState(), gifts: [gift()] });
const current = (store) => store.get().profiles.find((p) => p.id === store.get().activeProfileId);
const renderer = (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer', file)).href);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const dependencies = {
  esc,
  act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
  picture: () => '',
  qualityText: { name: (_, label) => esc(label) },
  icon: () => '',
  pill: () => '',
  empty: () => '',
  notice: () => '',
  bytes: String,
  when: String,
  hours: String,
  iconButton: () => '',
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-gift-item-'));
  t.after(() => {
    assert(path.basename(directory).startsWith('yijian-gift-item-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store: new Store(path.join(directory, 'source'), catalog) };
}
function atomicReject(store, operation) {
  const snapshot = store.get(),
    bytes = fs.readFileSync(store.file),
    previous = fs.readFileSync(store.file + '.previous');
  assert.throws(operation, /不可赠送/);
  assert.deepEqual(store.get(), snapshot);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(fs.readFileSync(store.file + '.previous'), previous);
}
function putDraft(store, id, targetId = '', values = {}) {
  store.mutate({
    type: 'intent-draft-put',
    id,
    kind: 'journey-gift',
    targetId,
    context: {},
    expectedRevision: 0,
    expectedTarget: intentTarget(current(store), 'journey-gift', targetId, {}),
    values: {
      npcId: 'npc-12600',
      itemId: sulfurId,
      quantity: '1',
      placeId: '',
      note: '旧草稿备注',
      done: false,
      personQuery: '',
      itemQuery: '硫磺',
      itemQuality: 'all',
      preferredOnly: false,
      stockOnly: false,
      placeQuery: '',
      ...values,
    },
  });
  return current(store).intentDrafts.find((row) => row.id === id);
}

test('real encyclopedia and picker reject sulfur while an old exact selection stays visible and disabled', async () => {
  const { giftChoices, createGiftPicker } = await renderer('gift-picker.js');
  const { createGameViews } = await renderer('game-views.js');
  const sulfur = index.entries.find((e) => e.id === sulfurId);
  assert.equal(sulfur.name, '硫磺');
  assert.equal(sulfur.giftable, false);
  assert.equal(giftChoices(index, 'item', { query: '硫磺' }).total, 0);
  assert.equal(giftChoices(index, 'item', { query: '硫磺' }).excludedMatch, true);
  assert.equal(giftChoices(index, 'item', { query: sulfurId, personId: 'npc-12600' }).total, 0);
  const view = {
    selectedId: sulfurId,
    query: '其他物品',
    quality: '白',
    preferredOnly: true,
    stockOnly: true,
    minimumQuality: '红',
  };
  const choice = giftChoices(index, 'item', view);
  assert.equal(choice.selected.id, sulfurId);
  assert.equal(choice.pinned.id, sulfurId);
  assert(!choice.rows.some((e) => e.id === sulfurId));
  const field = createGiftPicker(dependencies).field(index, 'item', view);
  assert.match(field, /value="item-10501" selected disabled/);
  assert.match(field, /此物品不可赠送，请改选物品。/);
  assert.doesNotMatch(field, /尚未选择物品|可先规划赠礼|礼物需要至少|data-id="item:item-10501"/);
  assert.match(field, /gift-selected-facts/);
  assert.match(field, new RegExp(esc(sulfur.description)));
  const picker = createGiftPicker(dependencies);
  assert.match(picker.options(index, 'item', { query: '硫磺' }), /匹配的物品不可赠送。/);
  const sameName = { entries: [sulfur, { ...sulfur, id: 'item-99999998', giftable: true, quality: '白' }] };
  for (const filter of [{ quality: '蓝' }, { stockOnly: true, stock: { known: true, available: {} } }]) {
    const filtered = giftChoices(sameName, 'item', { query: '硫磺', ...filter });
    assert.equal(filtered.total, 0);
    assert.equal(filtered.excludedMatch, false);
    assert.doesNotMatch(picker.options(sameName, 'item', { query: '硫磺', ...filter }), /匹配的物品不可赠送/);
  }
  const html = createGameViews(dependencies).detail(index, sulfurId);
  assert.match(html, /不可赠送/);
  assert.doesNotMatch(html, /可以赠送|data-action="journey-gift-dialog"/);
  const medicine = index.entries.find((e) => e.id === medicineId);
  const control = giftChoices(index, 'item', { query: medicine.name });
  assert(control.rows.some((row) => row.id === medicineId));
  assert.match(
    picker.selection(index, 'item', { selectedId: medicineId, minimumQuality: '红' }),
    /礼物需要至少/,
  );
  assert.match(createGameViews(dependencies).detail(index, medicineId), /data-action="journey-gift-dialog"/);
});

test('known historical items validate but only an unchanged historical pair can retain an unavailable item', () => {
  const legacy = legacyJourney(),
    snapshot = structuredClone(legacy);
  assert.equal(validateJourneyState(legacy), legacy);
  const edited = applyJourneyCommand(legacy, command(gift({ note: '保留并更新', done: true, quantity: 2 })));
  assert.equal(edited.gifts[0].note, '保留并更新');
  assert.equal(edited.gifts[0].done, true);
  assert.deepEqual(legacy, snapshot);
  assert.throws(() => applyJourneyCommand(emptyJourneyState(), command(gift())), /不可赠送/);
  assert.throws(() => applyJourneyCommand(legacy, command(gift({ id: 'new-id' }))), /不可赠送/);
  assert.throws(() => applyJourneyCommand(legacy, command(gift({ npcId: 'npc-9001' }))), /不可赠送/);
  const valid = applyJourneyCommand(legacy, command(gift({ itemId: medicineId })));
  assert.equal(valid.gifts[0].itemId, medicineId);
  assert.throws(() => applyJourneyCommand(valid, command(gift())), /不可赠送/);
  assert.deepEqual(legacy, snapshot);
  assert.equal(applyJourneyCommand(legacy, { type: 'journey-gift-remove', id: gift().id }).gifts.length, 0);
  assert.throws(
    () => validateJourneyState({ ...legacy, gifts: [gift({ itemId: 'item-999999999' })] }),
    /物品不存在/,
  );
});

test('legacy main/previous files, import and saved drafts survive with source snapshots unchanged', (t) => {
  const { directory, store } = fixture(t);
  const historical = store.get();
  historical.profiles[0].journey = legacyJourney();
  store.commit(historical);
  const draft = putDraft(store, 'old-new-sulfur');
  const existingDraft = putDraft(store, 'old-edit-sulfur', gift().id, { note: '草稿编辑旧安排', done: true });
  const source = store.get(),
    snapshot = structuredClone(source);
  const cold = new Store(path.join(directory, 'source'), catalog);
  assert.deepEqual(current(cold).journey.gifts, [gift()]);
  assert.equal(current(cold).intentDrafts.length, 2);
  atomicReject(cold, () => cold.mutate({ type: 'intent-draft-commit', id: draft.id, expectedDraft: draft }));
  cold.mutate({ type: 'intent-draft-commit', id: existingDraft.id, expectedDraft: existingDraft });
  assert.equal(current(cold).journey.gifts[0].note, '草稿编辑旧安排');
  assert.equal(current(cold).journey.gifts[0].done, true);
  const recoveryDir = path.join(directory, 'previous-recovery');
  fs.mkdirSync(recoveryDir);
  fs.writeFileSync(path.join(recoveryDir, 'journal.json'), '{synthetic damaged primary');
  fs.writeFileSync(path.join(recoveryDir, 'journal.json.previous'), JSON.stringify(source));
  const recovered = new Store(recoveryDir, catalog);
  assert.match(recovered.warning, /恢复上一份/);
  assert.deepEqual(current(recovered).journey.gifts, [gift()]);
  assert.equal(current(recovered).intentDrafts.length, 2);
  const imported = new Store(path.join(directory, 'imported'), catalog);
  imported.importData(source);
  assert.deepEqual(current(imported).journey.gifts, [gift()]);
  assert.equal(current(imported).intentDrafts.length, 2);
  assert.deepEqual(source, snapshot);
  assert(fs.readdirSync(recoveryDir).some((name) => name.startsWith('journal-damaged-')));
});

test('Store rejects direct and draft creation/reassignment atomically and keeps edit/delete/replace usable', (t) => {
  const { store } = fixture(t);
  // Make a previous atomic copy available before checking failure nonmutation.
  store.mutate({ type: 'note', value: '合成测试' });
  atomicReject(store, () => store.mutate(command(gift())));
  const draft = putDraft(store, 'new-sulfur');
  atomicReject(store, () =>
    store.mutate({ type: 'intent-draft-commit', id: draft.id, expectedDraft: draft }),
  );
  store.mutate(command(gift({ itemId: medicineId })));
  atomicReject(store, () => store.mutate(command(gift())));
  const reassignment = putDraft(store, 'change-to-sulfur', gift().id);
  atomicReject(store, () =>
    store.mutate({ type: 'intent-draft-commit', id: reassignment.id, expectedDraft: reassignment }),
  );
  const historical = store.get();
  historical.profiles[0].journey = legacyJourney();
  store.commit(historical);
  atomicReject(store, () => store.mutate(command(gift({ npcId: 'npc-9001' }))));
  store.mutate(command(gift({ note: '可编辑', done: true })));
  assert.equal(current(store).journey.gifts[0].note, '可编辑');
  store.mutate(command(gift({ itemId: medicineId, note: '已改选药品' })));
  assert.equal(current(store).journey.gifts[0].itemId, medicineId);
  const next = store.get();
  next.profiles[0].journey = legacyJourney();
  store.commit(next);
  store.mutate({ type: 'journey-gift-remove', id: gift().id, expectedRecord: gift() });
  assert.equal(current(store).journey.gifts.length, 0);
  const trash = current(store).journeyTrash.find((row) => row.kind === 'gift');
  assert.deepEqual(trash.record, gift());
  store.mutate({ type: 'journey-trash-restore', id: trash.id, expectedTrash: trash });
  assert.deepEqual(current(store).journey.gifts, [gift()]);
});

test('old sulfur intent cannot consume task material or claim budget support; itinerary retains its user title', () => {
  const p = {
    id: 'synthetic',
    goals: [],
    referenceMode: 'latest',
    allocations: [{ questId: 'quest-11703', items: { 10501: 5 } }],
    journey: { ...legacyJourney(), gifts: [gift(), gift({ id: 'medicine', itemId: medicineId })] },
  };
  const ref = {
    name: 'synthetic.sav',
    hash: 'synthetic',
    modifiedAt: '2026-10-25T00:00:00.000Z',
    metadata: {
      inventory: [
        { id: 10501, count: 6 },
        { id: 100, count: 2 },
      ],
      quests: [],
    },
  };
  const sourceSnapshot = structuredClone(ref);
  const budget = resourceBudget(p, ref);
  assert.equal(budget.totals[10501], 5);
  assert.equal(budget.physicalUsed[10501], 5);
  assert(!budget.gifts.some((row) => row.id === gift().id));
  assert.equal(budget.gifts.find((row) => row.id === 'medicine').allocated, 1);
  let action = journeyPlan(p, ref, budget).actions.find(
    (row) => row.kind === 'gift' && row.gift.itemId === sulfurId,
  );
  assert.match(action.title, /硫磺.*物品不可赠送/);
  assert.equal(action.detail, gift().note);
  assert.equal(action.gift.allocated, null);
  assert.equal(action.gift.enough, null);
  assert(!action.unknowns.some((row) => row.code.startsWith('gift-')));
  p.journey.itinerary = {
    name: '旧行程',
    status: 'active',
    steps: [
      {
        actionId: action.id,
        title: '玩家选择的原始标题',
        sources: [{ type: 'user', id: gift().id, field: 'journey' }],
        skipped: false,
        progressMode: 'manual',
      },
    ],
  };
  const before = structuredClone(p);
  const step = journeyPlan(p, ref, budget).itinerary.steps[0];
  assert.equal(step.selectedTitle, '玩家选择的原始标题');
  assert.match(step.title, /物品不可赠送/);
  assert.equal(step.status, 'unavailable');
  assert.equal(step.reason, '此物品不可赠送，请改选物品。');
  assert.deepEqual(p, before);
  assert.deepEqual(ref, sourceSnapshot);
  const stale = { ...budget, gifts: [{ ...gift(), allocated: 1, missing: 0, inventoryAvailable: true }] };
  action = journeyPlan(p, ref, stale).actions.find(
    (row) => row.kind === 'gift' && row.gift.itemId === sulfurId,
  );
  assert.equal(action.gift.allocationKnown, false);
  // Preserve existing unknown synthetic-data budget behavior; only known false is excluded.
  const unknown = {
    ...p,
    allocations: [],
    journey: { ...emptyJourneyState(), gifts: [gift({ itemId: 'item-999999999' })] },
  };
  assert.equal(
    resourceBudget(unknown, { ...ref, metadata: { quests: [], inventory: [{ id: 999999999, count: 1 }] } })
      .gifts[0].allocated,
    1,
  );
});

test('actual journey page keeps unavailable gifts as manageable records without executable gift suggestions', async () => {
  const { createJourneyViews } = await renderer('journey-views.js');
  const views = createJourneyViews({ ...dependencies, pill: (text) => `<span class="pill">${text}</span>` });
  const card = (html, id) => {
    const at = html.indexOf(`data-journey-id="${id}"`);
    assert(at >= 0);
    return html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at) + 10);
  };
  for (const state of ['pending', 'handled', 'done']) {
    const p = { id: 'synthetic', goals: [], referenceMode: 'latest', journey: legacyJourney() };
    const originalAction = journeyPlan(p, null).actions.find((row) => row.kind === 'gift');
    if (state === 'handled') p.journey.handledActionIds = [originalAction.id];
    if (state === 'done') p.journey.gifts[0].done = true;
    const snapshot = structuredClone(p),
      plan = journeyPlan(p, null, resourceBudget(p, null));
    const html = views.page(plan, { query: '', place: '', completed: true }, index);
    const actual = card(html, originalAction.id);
    assert.equal((actual.match(/不可赠送/g) || []).length, 1);
    assert.match(
      actual,
      state === 'done'
        ? /个人已完成 · 不可赠送/
        : state === 'handled'
          ? /手动已处理 · 不可赠送/
          : />不可赠送</,
    );
    assert.doesNotMatch(actual, /待赠送|赠礼数量待核对|已备齐|还缺|赠送完成|释放预留|journey-itinerary-add/);
    assert.match(actual, /data-action="journey-gift-edit"/);
    assert.match(actual, /data-action="database-detail" data-id="item-10501"/);
    if (state !== 'done') assert.match(actual, state === 'handled' ? /撤回个人已处理/ : /标记个人已处理/);
    assert.deepEqual(p, snapshot);
    assert.doesNotMatch(views.home(plan, index), new RegExp(originalAction.id));
  }
  const p = { id: 'synthetic', goals: [], referenceMode: 'latest', journey: legacyJourney() };
  const action = journeyPlan(p, null).actions.find((row) => row.kind === 'gift');
  p.journey.itinerary = {
    name: '旧行程',
    status: 'active',
    steps: [
      {
        actionId: action.id,
        title: '玩家原始行程标题',
        sources: [{ type: 'user', id: gift().id, field: 'journey' }],
        skipped: false,
        progressMode: 'manual',
      },
    ],
  };
  const plan = journeyPlan(p, null),
    html = views.page(plan, { query: '', place: '', completed: false }, index);
  assert.equal(plan.itinerary.steps[0].selectedTitle, '玩家原始行程标题');
  assert.match(html, /data-action="journey-itinerary-remove"/);
  assert.doesNotMatch(card(html, action.id), /journey-itinerary-add|journey-gift-complete/);
  p.journey = { ...emptyJourneyState(), gifts: [gift({ itemId: medicineId })] };
  const ordinary = journeyPlan(p, null);
  const ordinaryCard = card(views.page(ordinary, { query: '', completed: false }, index), action.id);
  assert.match(ordinaryCard, /待赠送/);
  assert.match(ordinaryCard, /赠礼数量待核对/);
  assert.match(ordinaryCard, /data-action="journey-gift-complete"/);
  assert.match(ordinaryCard, /data-action="journey-itinerary-add"/);
  assert.match(views.home(ordinary, index), new RegExp(action.id));
});

// Render the real editor and extract only its actual controls into a minimal DOM
// stub. Native browser validity and interaction are covered by separate GUI QA.
async function editorHarness(p) {
  const { createGiftPicker } = await renderer('gift-picker.js');
  const { createPlacePicker } = await renderer('place-picker.js');
  const { readIntentValues, writeIntentValues } = await renderer('intent-draft-views.js');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const nodes = new Map(),
    dialogs = [];
  const decode = (value) =>
    String(value).replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name],
    );
  const attr = (text, name) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] || '');
  function controls(html) {
    for (const match of html.matchAll(/<(select|input|textarea)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\/?>)/g)) {
      const [, tag, attrs, body = ''] = match,
        id = attr(attrs, 'id');
      if (!id) continue;
      const node = {
        tagName: tag.toUpperCase(),
        value: attr(attrs, 'value'),
        checked: /\bchecked\b/.test(attrs),
        focus() {},
      };
      if (tag === 'select') {
        node.options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((option) => ({
          value: attr(option[1], 'value'),
          disabled: /\bdisabled\b/.test(option[1]),
          selected: /\bselected\b/.test(option[1]),
        }));
        node.value = (node.options.find((option) => option.selected) || node.options[0])?.value || '';
      } else if (tag === 'textarea') node.value = decode(body).replace(/^\n/, '');
      nodes.set('#' + id, node);
    }
  }
  const generic = () => ({
    textContent: '',
    className: '',
    classList: { add() {} },
    focus() {},
    set innerHTML(html) {
      controls(html);
    },
    get innerHTML() {
      return '';
    },
  });
  const document = { activeElement: null, querySelector: (selector) => nodes.get(selector) || null };
  const overlay = {
    querySelector: (selector) => (selector === '.modal' ? generic() : document.querySelector(selector)),
  };
  const ctx = {
    profile: () => p,
    gameIndex: index,
    journeyDraft: null,
    esc,
    act: dependencies.act,
    giftPicker: createGiftPicker(dependencies),
    placePicker: createPlacePicker(dependencies),
    document,
    overlay,
    writeIntentValues,
    activateIntentEditor() {},
    loadGiftStock() {},
    modal: (...args) => {
      dialogs.push(args);
      controls(args[2]);
      for (const id of [
        'journey-gift-quantity-status',
        'journey-gift-budget-note',
        'journey-gift-done-label',
        'journey-person-options',
        'journey-person-selection',
        'journey-person-picker > summary',
        'journey-item-options',
        'journey-item-selection',
        'journey-item-picker > summary',
      ])
        nodes.set('#' + id, generic());
    },
  };
  require('node:vm').createContext(ctx);
  const pickerStart = source.indexOf('function refreshGiftPicker('),
    pickerEnd = source.indexOf('async function loadGiftStock(', pickerStart);
  const dialogStart = source.indexOf('function journeyDialog('),
    dialogEnd = source.indexOf('async function loadProtectionList(', dialogStart);
  require('node:vm').runInContext(
    source.slice(pickerStart, pickerEnd) + source.slice(dialogStart, dialogEnd),
    ctx,
  );
  ctx.journeyDialog('gift', gift().id);
  return {
    ctx,
    nodes,
    html: dialogs[0][2],
    actions: dialogs[0][3],
    values: () => readIntentValues('journey-gift', overlay),
  };
}

test('actual gift editor suppresses intrinsic-ban stock guidance and preserves collected historical IDs through note save and replacement', async (t) => {
  const { store } = fixture(t),
    seed = store.get();
  seed.profiles[0].journey = { ...emptyJourneyState(), gifts: [gift({ quantity: 2 })] };
  store.commit(seed);
  const harness = await editorHarness(current(store)),
    { ctx, nodes } = harness;
  assert.match(harness.html, /value="item-10501" selected disabled/);
  assert.match(harness.html, /此物品不可赠送，请改选物品。/);
  assert.match(harness.html, /id="journey-gift-budget-note" class="save-note"><\/p>/);
  assert.match(harness.html, /id="journey-gift-done-label">这项个人安排已完成</);
  assert.doesNotMatch(harness.html, /赠礼安排会参与库存分配|我已经完成这份赠礼/);
  assert.match(harness.actions, /journey-intent-save/);
  assert.match(harness.actions, /journey-intent-remove/);
  assert.equal(harness.values().itemId, sulfurId);
  for (const stock of [null, { known: true, available: {} }, { known: true, available: { 10501: 6 } }]) {
    ctx.journeyDraft.giftPicker.item.stock = stock;
    ctx.refreshGiftQuantityHint();
    assert.equal(nodes.get('#journey-gift-quantity-status').textContent, '');
    assert.equal(nodes.get('#journey-gift-budget-note').textContent, '');
    assert.equal(nodes.get('#journey-gift-done-label').textContent, '这项个人安排已完成');
  }
  nodes.get('#journey-note').value = '通过实际表单收集的旧备注';
  function commitValues(id) {
    store.mutate({
      type: 'intent-draft-put',
      id,
      kind: 'journey-gift',
      targetId: gift().id,
      context: {},
      expectedRevision: 0,
      expectedTarget: intentTarget(current(store), 'journey-gift', gift().id),
      values: harness.values(),
    });
    const draft = current(store).intentDrafts.find((row) => row.id === id);
    store.mutate({ type: 'intent-draft-commit', id, expectedDraft: draft });
  }
  commitValues('actual-editor-note');
  assert.equal(current(store).journey.gifts[0].itemId, sulfurId);
  assert.equal(current(store).journey.gifts[0].note, '通过实际表单收集的旧备注');
  nodes.get('#journey-item-search').value = index.entries.find((row) => row.id === medicineId).name;
  ctx.refreshGiftPicker('item');
  assert.equal(harness.values().itemId, sulfurId);
  assert(
    nodes.get('#journey-item').options.some((option) => option.value === medicineId && !option.disabled),
  );
  nodes.get('#journey-item').value = medicineId;
  ctx.journeyDraft.giftPicker.item.stock = null;
  ctx.refreshGiftPicker('item');
  assert.equal(harness.values().itemId, medicineId);
  for (const [stock, expected] of [
    [null, '可用数量待核对'],
    [{ known: true, available: {} }, '还缺 2 件'],
    [{ known: true, available: { 100: 6 } }, ''],
  ]) {
    ctx.journeyDraft.giftPicker.item.stock = stock;
    ctx.refreshGiftQuantityHint();
    assert.equal(nodes.get('#journey-gift-quantity-status').textContent, expected);
    assert.equal(
      nodes.get('#journey-gift-budget-note').textContent,
      '赠礼安排会参与库存分配；实际赠送后再标为完成。',
    );
    assert.equal(nodes.get('#journey-gift-done-label').textContent, '我已经完成这份赠礼');
  }
  commitValues('actual-editor-replace');
  assert.equal(current(store).journey.gifts[0].itemId, medicineId);
  const ordinary = await editorHarness(current(store));
  assert.match(ordinary.html, /赠礼安排会参与库存分配；实际赠送后再标为完成。/);
  assert.match(ordinary.html, /id="journey-gift-done-label">我已经完成这份赠礼</);
});

test('real compact projection and view omit new unavailable suggestions while preserving saved itinerary management', async (t) => {
  const { companionSnapshot } = require('../src/core/companion.cjs');
  const { createCompanionViews } = await renderer('companion-view.js');
  const { store } = fixture(t),
    state = store.get();
  const p = state.profiles.find((row) => row.id === state.activeProfileId);
  p.journey = legacyJourney();
  const original = structuredClone(state);
  const views = createCompanionViews({ ...dependencies, index: () => index });
  const unavailable = companionSnapshot(state, catalog, null);
  const action = journeyPlan(p, null).actions.find((row) => row.kind === 'gift');
  assert(!unavailable.nextActions.some((row) => row.id === action.id));
  assert(!unavailable.hints.some((row) => row.id === action.id));
  assert.doesNotMatch(
    views.actions(unavailable) + views.passive(unavailable),
    /硫磺|赠礼数量待核对|调整与完成/,
  );
  assert.deepEqual(state, original);
  p.journey.gifts[0].itemId = medicineId;
  const ordinary = companionSnapshot(state, catalog, null);
  assert(ordinary.nextActions.some((row) => row.id === action.id));
  assert(ordinary.hints.some((row) => row.id === action.id));
  assert.match(views.actions(ordinary), /一转血气丹/);
  assert.match(views.actions(ordinary), /赠礼数量待核对/);
  assert.match(views.actions(ordinary), /调整与完成/);
  p.journey.gifts[0].itemId = sulfurId;
  p.journey.itinerary = {
    name: '历史行程',
    status: 'active',
    steps: [
      {
        actionId: action.id,
        title: '玩家小窗原始标题',
        sources: [{ type: 'user', id: gift().id, field: 'journey' }],
        skipped: false,
        progressMode: 'manual',
      },
    ],
  };
  const saved = companionSnapshot(state, catalog, null),
    snapshot = structuredClone(state);
  assert.equal(saved.itinerary.steps[0].selectedTitle, '玩家小窗原始标题');
  assert.equal(saved.itinerary.steps[0].status, 'unavailable');
  const html = views.actions(saved);
  assert.match(html, /不可赠送/);
  assert.match(html, /查看与调整完整行程/);
  assert.doesNotMatch(html, /赠礼数量待核对|调整与完成|data-action="journey-itinerary-handle"/);
  assert.deepEqual(state, snapshot);
});
