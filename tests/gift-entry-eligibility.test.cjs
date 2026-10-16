'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const index = require('../src/core/game-data.cjs').encyclopedia();
const state = require('../src/core/journey-state.cjs');
const planner = require('../src/core/journey-plan.cjs');
const views = import(
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(root, 'src/renderer/gift-picker.js')).toString('base64')
);
const missing = [8500, 10011, 10309, 19112];
const gift = (npcId, id = 'new-gift') => ({
  type: 'journey-gift-put',
  id,
  npcId,
  itemId: 'item-134',
  quantity: 1,
  note: '',
  done: false,
});

test('known missing Gift entries are excluded without hiding ordinary Gift or unknown entries', async () => {
  const { giftChoices } = await views;
  for (const id of missing) {
    const result = giftChoices(index, 'person', { query: 'npc-' + id });
    assert.equal(result.total, 0);
    assert.equal(result.excludedMatch, true);
    assert.equal(result.selected, undefined);
  }
  assert.equal(giftChoices(index, 'person', { query: 'npc-9001' }).rows[0].id, 'npc-9001');
  const rows = [
    { kind: '人物', id: 'npc-unknown', name: '未收录功能' },
    { kind: '人物', id: 'npc-future', name: '暂时好感受限', functions: ['Gift'], affinityCap: 0 },
    { kind: '人物', id: 'npc-none', name: '已知无功能', functions: [] },
  ];
  assert.deepEqual(
    new Set(giftChoices({ entries: rows }, 'person').rows.map((row) => row.id)),
    new Set(['npc-unknown', 'npc-future']),
  );
});

test('old exact selections remain visible and explain the missing Gift entry', async () => {
  const { giftChoices, createGiftPicker } = await views;
  const options = createGiftPicker({
    esc: (value) => String(value),
    act: () => '',
    picture: () => '',
    qualityText: { name: (_, value) => value },
  }).options;
  for (const id of missing) {
    const view = { query: 'npc-' + id, selectedId: 'npc-' + id };
    const result = giftChoices(index, 'person', view);
    assert.equal(result.pinned.id, 'npc-' + id);
    assert.equal(result.selected.id, 'npc-' + id);
    assert.match(options(index, 'person', view), new RegExp('value="npc-' + id + '" selected disabled'));
    assert.match(options(index, 'person', view), /暂无赠礼入口，请改选人物。已有安排仍保留。/);
  }
  assert.match(options(index, 'person', { query: 'npc-8500' }), /匹配的人物暂无赠礼入口/);
});

test('new impossible gifts and recipient changes are rejected without mutating existing intent', () => {
  const original = state.emptyJourneyState();
  const before = JSON.stringify(original);
  for (const id of missing)
    assert.throws(() => state.applyJourneyCommand(original, gift('npc-' + id)), /暂无赠礼入口/);
  assert.equal(JSON.stringify(original), before);
  const valid = state.applyJourneyCommand(original, gift('npc-9001'));
  assert.equal(valid.gifts[0].npcId, 'npc-9001');
  assert.throws(() => state.applyJourneyCommand(valid, gift('npc-8500')), /暂无赠礼入口/);
  assert.equal(valid.gifts[0].npcId, 'npc-9001');
});

test('legacy gifts remain valid and editable, with current warning preserved in action and itinerary', () => {
  for (const id of missing) {
    const old = state.emptyJourneyState();
    const { type, ...row } = gift('npc-' + id, 'legacy-' + id);
    old.gifts = [row];
    assert.equal(state.validateJourneyState(old), old);
    const edited = state.applyJourneyCommand(old, { type, ...row, note: '稍后改选', done: true });
    assert.equal(edited.gifts[0].note, '稍后改选');
    assert.equal(edited.gifts[0].done, true);
    assert.equal(old.gifts[0].note, '');
    const profile = { id: 'synthetic', goals: [], referenceMode: 'latest', journey: old };
    const action = planner.journeyPlan(profile, null, null).actions.find((row) => row.kind === 'gift');
    assert.match(action.title, /暂无赠礼入口/);
    assert.equal(action.gift.npcId, 'npc-' + id);
    assert(action.navigation.some((link) => link.id === 'npc-' + id));
    old.itinerary = {
      name: '旧行程',
      status: 'active',
      steps: [
        {
          actionId: action.id,
          title: '旧版已保存的名称',
          sources: action.sources
            .filter((source) => source.type === 'user' || source.type === 'database')
            .map(({ type, id, field }) => ({ type, id, field })),
          skipped: false,
          progressMode: 'manual',
        },
      ],
    };
    const step = planner.journeyPlan(profile, null, null).itinerary.steps[0];
    assert.match(step.title, /暂无赠礼入口/);
    assert.equal(step.selectedTitle, '旧版已保存的名称');
    assert.equal(old.gifts[0].npcId, 'npc-' + id);
  }
});

test('Store rejects direct and draft-committed impossible gifts atomically while retaining editable legacy records', (t) => {
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-gift-entry-'));
  t.after(() => {
    assert(path.basename(directory).startsWith('yijian-gift-entry-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { Store } = require('../src/core/store.cjs');
  const { intentTarget } = require(path.join(root, 'src/core/intent-drafts.cjs'));
  const store = new Store(directory, require(path.join(root, 'src/data/catalog.cjs')));
  let before = store.get(),
    bytes = fs.readFileSync(store.file);
  assert.throws(() => store.mutate(gift('npc-8500')), /暂无赠礼入口/);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  const profile = before.profiles.find((p) => p.id === before.activeProfileId);
  store.mutate({
    type: 'intent-draft-put',
    id: 'gift-draft',
    kind: 'journey-gift',
    targetId: '',
    context: {},
    values: {
      npcId: 'npc-8500',
      itemId: 'item-134',
      quantity: '1',
      placeId: '',
      note: '保留草稿',
      done: false,
      personQuery: '',
      itemQuery: '',
      itemQuality: 'all',
      preferredOnly: false,
      stockOnly: false,
      placeQuery: '',
    },
    expectedRevision: 0,
    expectedTarget: intentTarget(profile, 'journey-gift', '', {}),
  });
  before = store.get();
  bytes = fs.readFileSync(store.file);
  const draft = before.profiles[0].intentDrafts[0];
  assert.throws(
    () => store.mutate({ type: 'intent-draft-commit', id: draft.id, expectedDraft: draft }),
    /暂无赠礼入口/,
  );
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  const legacy = store.get();
  const { type, ...row } = gift('npc-8500', 'old-gift');
  legacy.profiles[0].journey = { ...state.emptyJourneyState(), gifts: [row] };
  store.commit(legacy);
  store.mutate({ type, ...row, note: '更新旧备注', done: true });
  const restarted = new Store(directory, require(path.join(root, 'src/data/catalog.cjs')));
  assert.equal(restarted.get().profiles[0].journey.gifts[0].note, '更新旧备注');
  assert.equal(restarted.get().profiles[0].journey.gifts[0].done, true);
  assert.equal(restarted.get().profiles[0].intentDrafts[0].id, draft.id);
  restarted.mutate(gift('npc-9001', 'valid-gift'));
  assert(restarted.get().profiles[0].journey.gifts.some((row) => row.npcId === 'npc-9001'));
});
