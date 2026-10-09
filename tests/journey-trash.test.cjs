'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateJourneyTrash, applyJourneyTrashCommand } = require('../src/core/journey-trash.cjs');
const { emptyJourneyState, validateJourneyState, MAX } = require('../src/core/journey-state.cjs');
const world = require('../src/data/world-index.json');
const clone = (value) => structuredClone(value);
const T0 = '2026-10-08T08:00:00.000Z';
const T1 = '2026-10-09T08:00:00.000Z';
const shape = { place: ['places', 'placeId'], todo: ['todos', 'id'], gift: ['gifts', 'id'] };
const records = {
  place: { placeId: world.maps[0].id, note: '  原地点备注\n第二行  ', favorite: true, done: true },
  todo: {
    id: 'todo-1',
    title: '  原待办 × 2  ',
    detail: '  原详情\n😀完整保留  ',
    placeId: world.maps[0].id,
    done: true,
  },
  gift: {
    id: 'gift-1',
    npcId: 'npc-5011',
    itemId: 'item-1002',
    quantity: 999,
    placeId: world.maps[0].id,
    note: '  蓝色品质赠礼\n原备注  ',
    done: true,
  },
};
const row = (kind = 'todo', extra = {}) => ({
  id: `trash-${kind}`,
  kind,
  record: clone(records[kind]),
  deletedAt: T0,
  ...extra,
});
const profile = (journey = emptyJourneyState(), trash = []) => ({
  id: 'synthetic-profile',
  notes: '合成后续笔记',
  goals: [{ id: 'goal-1', title: '无关行囊目标', done: false }],
  journalEntries: [{ id: 'unrelated-history', body: '无关事件' }],
  journalTrash: [{ entry: { id: 'unrelated-history-trash' }, deletedAt: T0 }],
  journey,
  journeyTrash: trash,
});
function stateFor(kind, record = records[kind]) {
  const state = emptyJourneyState();
  state[shape[kind][0]].push(clone(record));
  return state;
}
const removal = (kind, record = records[kind], expected = true) => ({
  type: `journey-${kind}-remove`,
  [shape[kind][1]]: record[shape[kind][1]],
  ...(expected ? { expectedRecord: clone(record) } : {}),
});
const trashCommand = (value, type = 'journey-trash-restore') => ({
  type,
  id: value.id,
  expectedTrash: clone(value),
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

for (const kind of Object.keys(shape)) {
  test(`${kind}: remove preserves the complete raw record and only moves the selected object`, () => {
    const state = stateFor(kind),
      [list, key] = shape[kind];
    const retained = { ...records[kind], [key]: kind === 'place' ? world.maps[1].id : `${kind}-retained` };
    state[list].push(retained);
    state.handledActionIds = ['journey:todo:' + 'a'.repeat(32)];
    state.itinerary = { name: '后来接着办', status: 'active', steps: [] };
    const oldTrash = row('todo', { id: 'previous-trash' });
    const input = freeze(profile(state, [oldTrash])),
      before = clone(input);
    let clockCalls = 0,
      idCalls = 0;
    const result = applyJourneyTrashCommand(input, freeze(removal(kind)), {
      now: () => {
        clockCalls++;
        return T1;
      },
      id: () => {
        idCalls++;
        return 'new-trash';
      },
    });
    const expected = clone(state);
    expected[list].splice(0, 1);
    assert.deepEqual(result.journey, expected);
    assert.deepEqual(result.trash, [
      oldTrash,
      { id: 'new-trash', kind, record: records[kind], deletedAt: T1 },
    ]);
    assert.equal(clockCalls, 1);
    assert.equal(idCalls, 1);
    assert.notEqual(result.trash[1].record, records[kind]);
    assert.deepEqual(input, before);
    assert.equal(input.journalTrash[0].entry.id, 'unrelated-history-trash');
    assert.doesNotThrow(() => validateJourneyState(result.journey));
    assert.doesNotThrow(() => validateJourneyTrash(result.trash));
  });

  test(`${kind}: exact snapshots reject missing or changed objects; reordered fields remain equal`, () => {
    const current = records[kind],
      input = freeze(profile(stateFor(kind)));
    const changed = { ...current, [kind === 'todo' ? 'detail' : 'note']: '另一窗口后来修改' };
    for (const target of [profile(stateFor(kind, changed)), profile()]) {
      const before = clone(target);
      assert.throws(
        () => applyJourneyTrashCommand(target, removal(kind), { now: T1, id: () => 'new' }),
        /已变化/,
      );
      assert.deepEqual(target, before);
    }
    const reversed = Object.fromEntries(Object.entries(current).reverse());
    const result = applyJourneyTrashCommand(
      input,
      { ...removal(kind), expectedRecord: reversed },
      { now: T1, id: () => 'reordered' },
    );
    assert.deepEqual(result.trash[0].record, current);
    assert.throws(
      () =>
        applyJourneyTrashCommand(input, {
          ...removal(kind),
          expectedRecord: { ...current, done: !current.done },
        }),
      /已变化/,
    );
  });

  test(`${kind}: legacy removals work and absent objects are clone-only no-ops`, () => {
    const command = removal(kind, records[kind], false);
    const result = applyJourneyTrashCommand(freeze(profile(stateFor(kind))), command, {
      now: T1,
      id: () => 'legacy',
    });
    assert.equal(result.journey[shape[kind][0]].length, 0);
    assert.deepEqual(result.trash[0], row(kind, { id: 'legacy', deletedAt: T1 }));
    const absent = freeze(profile());
    const noop = applyJourneyTrashCommand(absent, command, {
      now: () => {
        throw Error('no clock on missing object');
      },
      id: () => {
        throw Error('no ID on missing object');
      },
    });
    assert.deepEqual(noop, { journey: absent.journey, trash: absent.journeyTrash });
    assert.notEqual(noop.journey, absent.journey);
    assert.notEqual(noop.trash, absent.journeyTrash);
  });

  test(`${kind}: restore merges with later arrangements without replacing their raw properties`, () => {
    const chosen = row(kind),
      otherTrash = row('todo', { id: 'other-trash' });
    const state = emptyJourneyState();
    state.todos = [{ id: 'later-todo', title: '删除后新写的待办', detail: '后来的详情', done: false }];
    state.gifts = [{ ...records.gift, id: 'later-gift', itemId: 'item-1000', quantity: 1, done: false }];
    state.places = [{ ...records.place, placeId: world.maps[1].id, note: '后来地点备注' }];
    state.itinerary = { name: '删除后保存的行程', status: 'draft', steps: [] };
    const input = freeze(profile(state, [chosen, otherTrash])),
      before = clone(input);
    const result = applyJourneyTrashCommand(input, freeze(trashCommand(chosen)), {
      now: () => {
        throw Error('restore must not rewrite time');
      },
      id: () => {
        throw Error('restore must retain entity identity');
      },
    });
    const expected = clone(state);
    expected[shape[kind][0]].push(records[kind]);
    assert.deepEqual(result, { journey: expected, trash: [otherTrash] });
    assert.deepEqual(input, before);
    assert.deepEqual(result.journey[shape[kind][0]].at(-1), records[kind]);
    assert.notEqual(result.journey[shape[kind][0]].at(-1), chosen.record);
  });

  test(`${kind}: an active entity with the same ID blocks restore even if its properties differ`, () => {
    const chosen = row(kind),
      current = { ...records[kind], done: false };
    const input = freeze(profile(stateFor(kind, current), [chosen])),
      before = clone(input);
    assert.throws(() => applyJourneyTrashCommand(input, trashCommand(chosen)), /同一安排已存在/);
    assert.deepEqual(input, before);
    const purged = applyJourneyTrashCommand(input, trashCommand(chosen, 'journey-trash-purge'));
    assert.deepEqual(purged, { journey: input.journey, trash: [] });
  });
}

test('each deletion lifecycle has its own wrapper and restores consume only the selected lifecycle', () => {
  let p = freeze(profile(stateFor('todo'))),
    counter = 0;
  const options = { now: () => (counter % 2 ? T1 : T0), id: () => `lifecycle-${++counter}` };
  const first = applyJourneyTrashCommand(p, removal('todo'), options);
  const restored = applyJourneyTrashCommand(
    profile(first.journey, first.trash),
    trashCommand(first.trash[0]),
  );
  const second = applyJourneyTrashCommand(
    profile(restored.journey, restored.trash),
    removal('todo'),
    options,
  );
  assert.equal(second.trash[0].record.id, first.trash[0].record.id);
  assert.notEqual(second.trash[0].id, first.trash[0].id);
  for (const type of ['journey-trash-restore', 'journey-trash-purge'])
    assert.throws(
      () =>
        applyJourneyTrashCommand(profile(second.journey, second.trash), trashCommand(first.trash[0], type)),
      /已变化/,
    );
  // Recreating and removing the same personal ID keeps both old complete objects.
  const recreated = stateFor('todo', { ...records.todo, detail: '第二次安排原文' });
  const third = applyJourneyTrashCommand(
    profile(recreated, second.trash),
    removal('todo', recreated.todos[0]),
    options,
  );
  assert.equal(third.trash.length, 2);
  assert.doesNotThrow(() => validateJourneyTrash(third.trash));
  const oldRestored = applyJourneyTrashCommand(
    profile(third.journey, third.trash),
    trashCommand(third.trash[0]),
  );
  assert.deepEqual(oldRestored.journey.todos, [records.todo]);
  assert.deepEqual(oldRestored.trash, [third.trash[1]]);
  assert.throws(
    () =>
      applyJourneyTrashCommand(profile(oldRestored.journey, oldRestored.trash), trashCommand(third.trash[1])),
    /同一安排已存在/,
  );
});

test('restore and purge require the exact complete wrapper, including changed note, kind and timestamp', () => {
  const chosen = row(),
    input = freeze(profile(emptyJourneyState(), [chosen, row('gift')]));
  for (const type of ['journey-trash-restore', 'journey-trash-purge']) {
    for (const command of [
      { type, id: chosen.id },
      { type, id: 'missing', expectedTrash: chosen },
      { type, id: chosen.id, expectedTrash: { ...chosen, id: 'changed' } },
      { type, id: chosen.id, expectedTrash: { ...chosen, deletedAt: T1 } },
      {
        type,
        id: chosen.id,
        expectedTrash: { ...chosen, record: { ...chosen.record, detail: '旧确认正文' } },
      },
      { type, id: chosen.id, expectedTrash: { ...row('gift'), id: chosen.id } },
      { ...trashCommand(chosen, type), profileId: input.id },
      { ...trashCommand(chosen, type), ids: [chosen.id] },
      { ...trashCommand(chosen, type), expectedTrash: { ...chosen, now: T0 } },
    ])
      assert.throws(() => applyJourneyTrashCommand(input, command));
    const reordered = Object.fromEntries(Object.entries(chosen).reverse());
    assert.doesNotThrow(() =>
      applyJourneyTrashCommand(input, { type, id: chosen.id, expectedTrash: reordered }),
    );
  }
  const purged = applyJourneyTrashCommand(input, trashCommand(chosen, 'journey-trash-purge'));
  assert.deepEqual(purged, { journey: input.journey, trash: [input.journeyTrash[1]] });
});

test('full trash refuses removal before generating time or ID and never expires or evicts rows', () => {
  const full = Array.from({ length: 5000 }, (_, index) =>
    row('todo', { id: `trash-${index}`, deletedAt: '2000-01-01T00:00:00Z' }),
  );
  const input = freeze(profile(stateFor('gift'), full)),
    before = clone(input);
  assert.equal(validateJourneyTrash(full), full);
  assert.throws(
    () =>
      applyJourneyTrashCommand(input, removal('gift'), {
        now: () => {
          throw Error('clock must follow capacity check');
        },
        id: () => {
          throw Error('ID must follow capacity check');
        },
      }),
    /已满/,
  );
  assert.deepEqual(input, before);
  assert.throws(() => validateJourneyTrash([...full, row('gift')]), /5000/);
  const fit = applyJourneyTrashCommand(profile(stateFor('gift'), full.slice(0, -1)), removal('gift'), {
    now: T1,
    id: () => 'exact-fit',
  });
  assert.equal(fit.trash.length, 5000);
  assert.deepEqual(fit.trash.slice(0, -1), full.slice(0, -1));
});

test('restore respects per-kind capacities and preserves every occupied arrangement on refusal', () => {
  for (const kind of ['todo', 'gift']) {
    const [list] = shape[kind],
      state = emptyJourneyState(),
      chosen = row(kind);
    state[list] = Array.from({ length: MAX[list] }, (_, index) => ({
      ...records[kind],
      id: `occupied-${index}`,
    }));
    const input = freeze(profile(state, [chosen])),
      before = clone(input);
    assert.throws(() => applyJourneyTrashCommand(input, trashCommand(chosen)), /数量已满/);
    assert.deepEqual(input, before);
    const room = clone(state);
    room[list].pop();
    const result = applyJourneyTrashCommand(profile(room, [chosen]), trashCommand(chosen));
    assert.equal(result.journey[list].length, MAX[list]);
    assert.deepEqual(result.journey[list].at(-1), chosen.record);
    assert.deepEqual(result.trash, []);
  }
  // The index includes duplicate rows; all distinct places fit the place limit.
  const chosen = row('place'),
    placeIds = [...new Set(world.maps.map((map) => map.id))];
  const places = placeIds
    .filter((id) => id !== chosen.record.placeId)
    .map((id) => ({ ...records.place, placeId: id }));
  const state = { ...emptyJourneyState(), places };
  const result = applyJourneyTrashCommand(profile(state, [chosen]), trashCommand(chosen));
  assert.equal(result.journey.places.length, placeIds.length);
  assert.ok(result.journey.places.length <= MAX.places);
  assert.deepEqual(result.journey.places.at(-1), chosen.record);
});

test('trash validation rejects unknown fields, invalid IDs, timestamps, references and typed properties', () => {
  const valid = [row('place'), row('todo'), row('gift')],
    before = clone(valid);
  assert.equal(validateJourneyTrash(valid), valid);
  assert.deepEqual(valid, before);
  const invalid = [
    null,
    {},
    [null],
    [row('todo', { id: '' })],
    [row('todo', { id: 'a'.repeat(81) })],
    [row('todo', { id: '中文' })],
    [row('todo', { id: 'white space' })],
    [row('todo', { kind: 'unknown' })],
    [row('todo', { kind: '__proto__' })],
    [row('todo', { kind: 1 })],
    [row('todo', { kind: ['todo'] })],
    [row('todo', { token: 'private' })],
    [row('todo', { deletedAt: '2026-02-30T08:00:00Z' })],
    [row('todo', { deletedAt: '2026-10-09T08:00:00' })],
    [row('todo', { deletedAt: '2026-10-09T24:00:00Z' })],
    [row('todo', { deletedAt: '2026-10-09T08:00:00+24:00' })],
    [row('todo', { deletedAt: 0 })],
    [row('todo', { deletedAt: new Date(T0) })],
    [row(), row()],
    [row('gift', { id: 'same' }), row('place', { id: 'same' })],
    [row('place', { record: { ...records.place, placeId: 'place-999999999' } })],
    [row('place', { record: { ...records.place, favorite: 'true' } })],
    [row('place', { record: { ...records.place, note: 'x'.repeat(1001) } })],
    [row('todo', { record: { ...records.todo, title: '' } })],
    [row('todo', { record: { ...records.todo, done: 1 } })],
    [row('todo', { record: { ...records.todo, placeId: 'place-999999999' } })],
    [row('gift', { record: { ...records.gift, npcId: 'npc-999999999' } })],
    [row('gift', { record: { ...records.gift, itemId: 'item-999999999' } })],
    [row('gift', { record: { ...records.gift, quantity: '999' } })],
    [row('gift', { record: { ...records.gift, quantity: 1.5 } })],
    [row('gift', { record: { ...records.gift, quantity: 0 } })],
    [row('gift', { record: { ...records.gift, quantity: 1000 } })],
    [row('gift', { record: { ...records.gift, inventory: { 1002: 999 } } })],
    [row('todo', { record: records.gift })],
    [row('gift', { record: records.todo })],
  ];
  for (const rows of invalid) assert.throws(() => validateJourneyTrash(rows));
  assert.doesNotThrow(() => validateJourneyTrash([row('gift', { deletedAt: '2024-02-29T08:00:00+08:00' })]));
  const optionalAbsent = clone(records.todo);
  delete optionalAbsent.placeId;
  const optionalRow = row('todo', { record: optionalAbsent });
  const restored = applyJourneyTrashCommand(
    profile(emptyJourneyState(), [optionalRow]),
    trashCommand(optionalRow),
  );
  assert.deepEqual(restored.journey.todos[0], optionalAbsent);
  assert.equal(Object.hasOwn(restored.journey.todos[0], 'placeId'), false);
});

test('strict JSON rejects accessors, proxies, symbols, hidden fields, type disguises and cycles without executing them', () => {
  let sideEffects = 0;
  const getter = row();
  Object.defineProperty(getter.record, 'detail', {
    enumerable: true,
    get: () => {
      sideEffects++;
      return records.todo.detail;
    },
  });
  const toJSON = row('todo', {
    toJSON: () => {
      sideEffects++;
      return row();
    },
  });
  const hidden = row();
  Object.defineProperty(hidden, 'token', { value: 'hidden' });
  const symbol = row();
  symbol[Symbol('token')] = 'symbol';
  const cycle = row();
  cycle.record.detail = cycle;
  const sparse = [row(), , row('gift')];
  const addedArrayField = [row()];
  addedArrayField.token = 'extra';
  class ForeignArray extends Array {}
  for (const rows of [
    [getter],
    [toJSON],
    [hidden],
    [symbol],
    [cycle],
    sparse,
    addedArrayField,
    new ForeignArray(row()),
    [Object.assign(Object.create({ inherited: true }), row())],
    [row('todo', { record: Object.assign(Object.create({ inherited: true }), records.todo) })],
    [
      new Proxy(row(), {
        get: () => {
          sideEffects++;
          throw Error('must not read proxy');
        },
      }),
    ],
    [row('todo', { record: { ...records.todo, detail: new String(records.todo.detail) } })],
    [row('gift', { record: { ...records.gift, quantity: new Number(999) } })],
    [row('gift', { record: { ...records.gift, quantity: NaN } })],
    [row('todo', { record: { ...records.todo, nativeCapability: undefined } })],
  ])
    assert.throws(() => validateJourneyTrash(rows));
  const getterProfile = profile();
  Object.defineProperty(getterProfile, 'journey', {
    enumerable: true,
    get: () => {
      sideEffects++;
      return emptyJourneyState();
    },
  });
  assert.throws(() => applyJourneyTrashCommand(getterProfile, removal('todo')));
  const getterCommand = removal('todo');
  Object.defineProperty(getterCommand, 'expectedRecord', {
    enumerable: true,
    get: () => {
      sideEffects++;
      return records.todo;
    },
  });
  assert.throws(() => applyJourneyTrashCommand(profile(stateFor('todo')), getterCommand));
  assert.equal(sideEffects, 0);
});

test('commands reject extra authority and invalid confirmation fields rather than silently sanitizing them', () => {
  const input = freeze(profile(stateFor('todo'))),
    before = clone(input);
  for (const command of [
    { ...removal('todo'), profileId: input.id },
    { ...removal('todo'), now: T0 },
    { ...removal('todo'), expectedRecord: { ...records.todo, nativeCapability: undefined } },
    { ...removal('todo'), expectedRecord: { ...records.todo, token: 'private' } },
    { ...removal('todo'), expectedRecord: undefined },
    { type: 'journey-todo-remove' },
    { type: 'journey-todo-remove', id: 'bad id' },
    { type: 'journey-place-remove', placeId: 'place-999999999' },
    { type: 'journey-todo-put', ...records.todo },
    { type: 'goal-remove', id: 'bad id' },
    { type: '__proto__', id: 'todo-1' },
    { type: 'constructor', id: 'todo-1' },
    null,
    [],
    new String('journey-todo-remove'),
  ])
    assert.throws(() => applyJourneyTrashCommand(input, command));
  assert.deepEqual(input, before);
});

test('trusted generation rejects invalid time and colliding IDs without mutating either collection', () => {
  const input = freeze(profile(stateFor('todo'), [row('gift')])),
    before = clone(input);
  for (const options of [
    { now: '2026-02-30T08:00:00Z', id: () => 'new' },
    { now: null, id: () => 'new' },
    { now: () => 123, id: () => 'new' },
    { now: T1, id: () => input.journeyTrash[0].id },
    { now: T1, id: () => 'invalid id' },
    { now: T1, id: () => 'x'.repeat(81) },
    { now: T1, id: () => undefined },
  ])
    assert.throws(() => applyJourneyTrashCommand(input, removal('todo'), options));
  assert.deepEqual(input, before);
  const defaults = applyJourneyTrashCommand(input, removal('todo'));
  assert.match(defaults.trash.at(-1).id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.doesNotThrow(() => validateJourneyTrash(defaults.trash));
  const rawTime = '2026-10-09T16:00:00.1+08:00';
  const custom = applyJourneyTrashCommand(input, removal('todo'), { now: rawTime, id: () => 'custom' });
  assert.equal(custom.trash.at(-1).deletedAt, rawTime);
});

test('every successful result is independent JSON including untouched records, arrays and default state', () => {
  const input = freeze(profile(stateFor('place'), [row('todo'), row('gift')])),
    before = clone(input);
  const command = freeze(trashCommand(input.journeyTrash[0], 'journey-trash-purge'));
  const result = applyJourneyTrashCommand(input, command);
  result.journey.places[0].note = 'returned journey edit';
  result.trash[0].record.note = 'returned trash edit';
  result.journey.handledActionIds.push('returned-array-edit');
  assert.deepEqual(input, before);
  assert.deepEqual(command.expectedTrash, before.journeyTrash[0]);
  const empty = applyJourneyTrashCommand(
    freeze({ id: 'synthetic-empty' }),
    removal('todo', records.todo, false),
  );
  assert.deepEqual(empty, { journey: emptyJourneyState(), trash: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
});
