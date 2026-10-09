'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { applyJourneyTrashCommand, validateJourneyTrash } = require('../src/core/journey-trash.cjs');
const { emptyJourneyState, validateItinerary } = require('../src/core/journey-state.cjs');
const clone = (value) => structuredClone(value);
const T0 = '2026-10-09T01:00:00.000Z',
  T1 = '2026-10-09T02:00:00.000Z';
const A = 'journey:todo:' + 'a'.repeat(32),
  B = 'journey:quest:' + 'b'.repeat(32);
const trip = () => ({
  name: '  原行程 × 2\n完整名称  ',
  status: 'ended',
  steps: [
    {
      actionId: B,
      title: '第二项先去 <精确场景>',
      placeId: 'place-22',
      sources: [{ type: 'quest', id: 'quest-999999', field: 'placements' }],
      skipped: true,
      progressMode: 'save',
      continuationId: 'journey:quest:' + 'c'.repeat(32),
    },
    {
      actionId: A,
      title: '第一项后去\n完整原文字',
      placeId: 'place-9',
      sources: [{ type: 'user', id: 'original', field: 'journey' }],
      skipped: false,
      progressMode: 'manual',
    },
  ],
});
const currentTrip = () => ({ name: '后来独立选择的一程', status: 'active', steps: [clone(trip().steps[1])] });
const row = (id = 'original-trash', record = trip()) => ({ id, kind: 'itinerary', record, deletedAt: T0 });
function profile(itinerary = currentTrip(), trash = [row()]) {
  const journey = emptyJourneyState();
  if (itinerary !== null) journey.itinerary = itinerary;
  journey.todos = [{ id: 'later', title: '后来待办', detail: '后来的完整详情', done: true }];
  journey.gifts = [
    { id: 'later-gift', npcId: 'npc-5011', itemId: 'item-1002', quantity: 7, note: '', done: true },
  ];
  journey.handledActionIds = [A];
  return {
    id: 'synthetic-only',
    notes: '后来笔记',
    goals: [{ id: 'later-goal', title: '后来目标', done: true }],
    journalEntries: [{ id: 'later-event', body: '后来手记' }],
    journey,
    journeyTrash: trash,
  };
}
const restore = (p, chosen = p.journeyTrash[0]) => ({
  type: 'journey-trash-restore',
  id: chosen.id,
  expectedTrash: clone(chosen),
  expectedItinerary: clone(p.journey.itinerary ?? null),
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const noGeneration = {
  now() {
    throw Error('no clock');
  },
  id() {
    throw Error('no ID');
  },
};

test('remove and clear preserve full raw itinerary intent and change only selected steps/status', () => {
  for (const type of ['journey-itinerary-remove', 'journey-itinerary-clear']) {
    const input = freeze(profile(trip(), [])),
      before = clone(input);
    const command = { type, ...(type.endsWith('remove') ? { id: B } : {}), expectedItinerary: clone(trip()) };
    const result = applyJourneyTrashCommand(input, freeze(command), { now: T1, id: () => 'protected-trip' });
    assert.deepEqual(
      result.trash,
      [row('protected-trip', trip())].map((r) => ({ ...r, deletedAt: T1 })),
    );
    assert.deepEqual(result.journey.todos, input.journey.todos);
    assert.deepEqual(result.journey.gifts, input.journey.gifts);
    assert.deepEqual(result.journey.handledActionIds, [A]);
    assert.deepEqual(result.journey.itinerary.steps, type.endsWith('remove') ? [trip().steps[1]] : []);
    assert.equal(result.journey.itinerary.status, type.endsWith('remove') ? 'ended' : 'draft');
    assert.equal(result.journey.itinerary.name, trip().name);
    assert.deepEqual(input, before);
    validateJourneyTrash(result.trash);
  }
});

test('restore exchanges whole itinerary intent while retaining current independent arrangements and handled state', () => {
  const input = freeze(profile()),
    before = clone(input),
    current = clone(input.journey.itinerary);
  const result = applyJourneyTrashCommand(input, freeze(restore(input)), {
    now: T1,
    id: () => 'current-copy',
  });
  assert.deepEqual(result.journey, { ...input.journey, itinerary: trip() });
  assert.deepEqual(result.trash, [{ id: 'current-copy', kind: 'itinerary', record: current, deletedAt: T1 }]);
  assert.deepEqual(Object.keys(result).sort(), ['journey', 'trash']);
  assert.deepEqual(input, before);
  const swapped = { ...input, journey: result.journey, journeyTrash: result.trash };
  const back = applyJourneyTrashCommand(swapped, restore(swapped), { now: T1, id: () => 'old-trip-copy' });
  assert.deepEqual(back.journey.itinerary, current);
  assert.deepEqual(back.trash[0].record, trip());
  assert.deepEqual(back.journey.handledActionIds, [A]);
});

test('full itinerary confirmations reject stale archive/current content and missing preview without any mutation', () => {
  const input = freeze(profile()),
    before = clone(input),
    good = restore(input);
  for (const command of [
    { type: good.type, id: good.id, expectedTrash: good.expectedTrash },
    { ...good, expectedItinerary: null },
    { ...good, expectedItinerary: { ...currentTrip(), name: '另一窗原名称' } },
    { ...good, expectedTrash: { ...row(), record: { ...trip(), status: 'draft' } } },
    { ...good, expectedItinerary: { ...currentTrip(), steps: [trip().steps[0]] } },
    { ...good, nativeCapability: true },
    { ...good, type: 'journey-trash-purge' },
  ])
    assert.throws(() => applyJourneyTrashCommand(input, command, noGeneration));
  for (const type of ['journey-itinerary-remove', 'journey-itinerary-clear'])
    assert.throws(
      () =>
        applyJourneyTrashCommand(
          input,
          { type, ...(type.endsWith('remove') ? { id: A } : {}), expectedItinerary: trip() },
          noGeneration,
        ),
      /已变化/,
    );
  assert.deepEqual(input, before);
});

test('full trash blocks destructive selection changes but permits capacity-neutral recovery exchange without eviction', () => {
  const full = Array.from({ length: 5000 }, (_, i) =>
    row('copy-' + i, { name: '副本 ' + i, status: 'draft', steps: [] }),
  );
  full[0] = row();
  const input = freeze(profile(currentTrip(), full)),
    before = clone(input);
  for (const type of ['journey-itinerary-remove', 'journey-itinerary-clear'])
    assert.throws(
      () =>
        applyJourneyTrashCommand(
          input,
          {
            type,
            ...(type.endsWith('remove') ? { id: A } : {}),
            expectedItinerary: clone(input.journey.itinerary),
          },
          noGeneration,
        ),
      /已满/,
    );
  const recovered = applyJourneyTrashCommand(input, restore(input), {
    now: T1,
    id: () => 'replacement-copy',
  });
  assert.equal(recovered.trash.length, 5000);
  assert.deepEqual(recovered.trash.slice(0, -1), full.slice(1));
  assert.deepEqual(recovered.trash.at(-1).record, currentTrip());
  assert.deepEqual(input, before);
});

test('no-op empty clear, absent remove and identical restore never consume clock, ID or trash capacity', () => {
  const blank = { name: '空行程仍保留名称', status: 'draft', steps: [] };
  for (const p of [profile(null, []), profile(blank, [])]) {
    for (const command of [
      { type: 'journey-itinerary-clear' },
      { type: 'journey-itinerary-remove', id: A },
    ]) {
      const result = applyJourneyTrashCommand(
        p,
        { ...command, expectedItinerary: clone(p.journey.itinerary ?? null) },
        noGeneration,
      );
      assert.deepEqual(result, { journey: p.journey, trash: p.journeyTrash });
    }
  }
  const p = profile(trip());
  assert.deepEqual(applyJourneyTrashCommand(p, restore(p), noGeneration), {
    journey: p.journey,
    trash: p.journeyTrash,
  });
});

test('restoring into a legacy absent itinerary consumes only the selected copy; purge requires an exact archive', () => {
  const p = freeze(profile(null, [row(), row('other', currentTrip())]));
  const restored = applyJourneyTrashCommand(p, restore(p), noGeneration);
  assert.deepEqual(restored.journey.itinerary, trip());
  assert.deepEqual(restored.trash, [p.journeyTrash[1]]);
  const purged = applyJourneyTrashCommand(
    p,
    { type: 'journey-trash-purge', id: row().id, expectedTrash: row() },
    noGeneration,
  );
  assert.deepEqual(purged, { journey: p.journey, trash: [p.journeyTrash[1]] });
});

test('strict itinerary and command JSON rejects hooks, proxies, undefined and sparse/custom arrays without invoking code', () => {
  let calls = 0;
  const hook = trip();
  Object.defineProperty(hook, 'name', {
    enumerable: true,
    get() {
      calls++;
      return 'hook';
    },
  });
  const extraArray = trip();
  extraArray.steps.extra = true;
  const sparse = trip();
  delete sparse.steps[0];
  const undefinedField = trip();
  undefinedField.nativeCapability = undefined;
  for (const bad of [
    hook,
    new Proxy(trip(), {
      get() {
        calls++;
      },
    }),
    extraArray,
    sparse,
    undefinedField,
    { ...trip(), nativeCapability: true },
    { ...trip(), steps: [{ ...trip().steps[0], handled: true }] },
  ]) {
    assert.throws(() => validateItinerary(bad));
    assert.throws(() => validateJourneyTrash([row('bad', bad)]));
  }
  const p = freeze(profile());
  for (const bad of [
    { ...restore(p), expectedItinerary: hook },
    { ...restore(p), expectedItinerary: undefined },
    { type: 'journey-itinerary-clear', expectedItinerary: extraArray },
    { type: 'journey-itinerary-clear', expectedItinerary: null, force: true },
  ])
    assert.throws(() => applyJourneyTrashCommand(p, bad, noGeneration));
  assert.equal(calls, 0);
});

test('invalid generated time and archive IDs preserve original/current itinerary and all occupied rows', () => {
  const p = freeze(profile()),
    before = clone(p);
  for (const options of [
    { now: 'invalid', id: () => 'new' },
    { now: T1, id: () => row().id },
    { now: T1, id: () => '../outside' },
    { now: T1, id: () => undefined },
  ])
    assert.throws(() => applyJourneyTrashCommand(p, restore(p), options));
  assert.deepEqual(p, before);
});

test('current and read-only itinerary previews show full order, precise scene, skip state and escaped source content', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer/journey-trash-views.js'), 'utf8');
  const { createJourneyTrashViews } = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  const esc = (s) =>
    String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const views = createJourneyTrashViews({
    esc,
    when: (t) => t,
    act: (action, label) => `<button data-action="${action}">${label}</button>`,
  });
  const index = {
    world: {
      maps: [
        { id: 'place-22', name: '相同场景名', gameId: 22 },
        { id: 'place-9', name: '相同场景名', gameId: 9 },
      ],
      quests: [],
    },
    entries: [],
  };
  const html = views.detail(row(), index);
  assert(html.indexOf('1. 第二项先去') < html.indexOf('2. 第一项后去'));
  for (const text of [
    '场景 #22',
    'place-22',
    '场景 #9',
    'place-9',
    '仅本次跳过',
    '本次未跳过',
    '个人已处理按当前状态保留',
    'quest-999999',
    B,
    'journey:quest:' + 'c'.repeat(32),
    '&lt;精确场景&gt;',
  ])
    assert(html.includes(text), text);
  assert(!html.includes('<精确场景>'));
  assert(views.panel(profile(), index, { query: 'quest-999999' }).includes('找回这一程'));
  const historical = views.panel(profile(), index, {}, true);
  assert(historical.includes('historical-journey-trash-detail'));
  assert(!historical.includes('data-action="journey-trash-restore'));
  assert(!historical.includes('data-action="journey-trash-purge'));
  assert(views.itineraryDetail(null, index, { heading: '当前待替换行程' }).includes('当前尚无'));
});
