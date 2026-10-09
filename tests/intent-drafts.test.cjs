'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  validateIntentDrafts,
  intentTarget,
  intentFingerprint,
  applyIntentDraftCommand,
} = require('../src/core/intent-drafts.cjs');
const { emptyJourneyState, applyJourneyCommand } = require('../src/core/journey-state.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const T0 = '2026-10-09T08:00:00.000Z';
const T1 = '2026-10-09T08:01:00.000Z';
const PLACE = world.maps[0].id;
const NPC = world.people[0].id;
const ITEM = game.entries.find((entry) => entry.kind === '物品' && entry.giftable === true).id;
const RECIPE = game.entries.find((entry) => entry.kind === '配方').id;
const OWNER = 'journey:todo:' + 'a'.repeat(32);
const ACTION = 'journey:quest:' + 'b'.repeat(32);
const clone = (value) => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function profile() {
  return {
    id: 'synthetic-profile',
    goals: [{ id: 'goal-1', title: '旧目标', detail: '旧详情', done: false, pinned: true }],
    craftList: [{ id: RECIPE, quantity: 7 }],
    craftChoices: {},
    reserveCraftDraft: true,
    reservations: { 1000: 2 },
    allocations: [{ questId: 'quest-11010', items: { 10201: 4 } }],
    craftPlans: [
      {
        id: 'plan-1',
        name: '旧计划',
        list: [{ id: RECIPE, quantity: 1 }],
        choices: {},
        reserved: false,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    journey: {
      ...emptyJourneyState(),
      places: [{ placeId: PLACE, note: '旧备注', favorite: false, done: false }],
      todos: [{ id: 'todo-1', title: '旧待办', detail: '旧详情', placeId: PLACE, done: false }],
      gifts: [{ id: 'gift-1', npcId: NPC, itemId: ITEM, quantity: 1, note: '旧赠礼', done: false }],
      itinerary: {
        name: '旧行程',
        status: 'active',
        steps: [
          {
            actionId: OWNER,
            title: '旧行动',
            placeId: PLACE,
            sources: [{ type: 'user', id: 'todo-1', field: 'journey' }],
            skipped: false,
            progressMode: 'manual',
          },
        ],
      },
    },
    intentDrafts: [],
  };
}
function sample(kind, extra = {}) {
  const specs = {
    'journey-place': {
      targetId: PLACE,
      context: {},
      values: { note: '我的地点备注', favorite: true, done: false },
    },
    'journey-todo': {
      targetId: '',
      context: {},
      values: { title: '我的待办', detail: '未完的详情', placeId: '', done: false, placeQuery: '场景筛选' },
    },
    'journey-gift': {
      targetId: '',
      context: {},
      values: {
        npcId: NPC,
        itemId: ITEM,
        quantity: ' 02 ',
        placeId: '',
        note: '我的赠礼',
        done: false,
        personQuery: '人物筛选',
        itemQuery: '物品筛选',
        itemQuality: '蓝',
        preferredOnly: true,
        stockOnly: true,
        placeQuery: '场景筛选',
      },
    },
    goal: { targetId: '', context: {}, values: { title: '我的目标', detail: '我的详情' } },
    'craft-plan': {
      targetId: '',
      context: { list: [{ id: RECIPE, quantity: 2 }], choices: {} },
      values: { name: '我的制作计划', addGoal: true, reserved: true },
    },
    'itinerary-name': { targetId: '', context: {}, values: { name: '我的行程' } },
    'itinerary-choice': {
      targetId: ACTION,
      context: { mode: 'add', actionId: ACTION },
      values: { placeId: PLACE },
    },
  };
  return { id: 'main-draft', kind, ...clone(specs[kind]), ...extra };
}
function put(p, spec, extra = {}) {
  return {
    type: 'intent-draft-put',
    ...spec,
    expectedRevision: 0,
    expectedTarget: intentTarget(p, spec.kind, spec.targetId, spec.context),
    ...extra,
  };
}
function create(p, spec = sample('goal'), options = { now: T0 }) {
  return { ...p, intentDrafts: applyIntentDraftCommand(p, put(p, spec), options).drafts };
}
function guarded(p, type = 'intent-draft-commit', id = p.intentDrafts[0].id, extra = {}) {
  return { type, id, expectedDraft: clone(p.intentDrafts.find((row) => row.id === id)), ...extra };
}
function commit(p, id) {
  return applyIntentDraftCommand(p, guarded(p, 'intent-draft-commit', id));
}

test('optional collection draft quantity is bounded raw text until explicit commit and legacy goal values stay unchanged', () => {
  const original = profile();
  original.goals[0].source = { type: 'database', id: ITEM, quantity: 2 };
  for (const quantity of ['', '...', '0', '1.5', '1000', '1e2']) {
    const p = create(
      original,
      sample('goal', { targetId: 'goal-1', values: { title: '数量草稿', detail: '', quantity } }),
    );
    assert.equal(p.intentDrafts[0].values.quantity, quantity);
    assert.throws(() => commit(p), /收集数量/);
    assert.equal(p.goals[0].source.quantity, 2);
  }
  for (const quantity of [null, 10, true, {}, '1'.repeat(33)])
    assert.throws(() =>
      create(
        original,
        sample('goal', { targetId: 'goal-1', values: { title: '数量草稿', detail: '', quantity } }),
      ),
    );
  const valid = create(
    original,
    sample('goal', { targetId: 'goal-1', values: { title: '数量草稿', detail: '', quantity: '999' } }),
  );
  assert.equal(commit(valid).intent.quantity, 999);
  const legacy = create(original, sample('goal', { targetId: 'goal-1' }));
  assert.equal(Object.hasOwn(commit(legacy).intent, 'quantity'), false);
  assert.deepEqual(original.goals[0].source, { type: 'database', id: ITEM, quantity: 2 });
});

test('canonical fingerprints sort object keys, preserve arrays, and hash only JSON without invoking hooks', () => {
  const first = { z: [1, { b: false, a: null }], a: '逸剑', zero: -0 };
  const second = { zero: 0, a: '逸剑', z: [1, { a: null, b: false }] };
  assert.equal(intentFingerprint(first), intentFingerprint(second));
  assert.equal(intentFingerprint({ b: 2, a: 1 }), createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
  assert.notEqual(intentFingerprint([1, 2]), intentFingerprint([2, 1]));
  assert.equal(intentFingerprint(Object.assign(Object.create(null), { a: 1 })), intentFingerprint({ a: 1 }));
  let executed = 0;
  const getter = Object.defineProperty({}, 'a', {
    enumerable: true,
    get() {
      executed++;
      return 1;
    },
  });
  const serializer = {
    toJSON() {
      executed++;
      return {};
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        executed++;
        return [];
      },
    },
  );
  const cycle = {};
  cycle.self = cycle;
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const extraArray = [1];
  extraArray.extra = 2;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol('x'),
    () => {},
    new Date(T0),
    new Map(),
    new Set(),
    Buffer.from('x'),
    Object.create({ a: 1 }),
    getter,
    serializer,
    { toJSON: 'x' },
    proxy,
    cycle,
    hidden,
    extraArray,
    Array(1),
    { a: undefined },
    { [Symbol('x')]: 1 },
  ])
    assert.throws(() => intentFingerprint(value));
  assert.equal(executed, 0);
});

test('all seven kinds preserve incomplete portable values without an existence check or reservation', () => {
  const original = freeze(profile()),
    before = clone(original);
  let p = original;
  for (const kind of [
    'journey-place',
    'journey-todo',
    'journey-gift',
    'goal',
    'craft-plan',
    'itinerary-name',
    'itinerary-choice',
  ]) {
    const spec = sample(kind, { id: 'partial-' + kind });
    for (const [key, value] of Object.entries(spec.values))
      if (typeof value === 'string') spec.values[key] = '';
    if (kind === 'journey-gift')
      Object.assign(spec.values, {
        quantity: '还没写完..',
        personQuery: '张',
        itemQuery: '剑',
        itemQuality: '暂选品质',
        placeId: 'place-999999999',
        npcId: 'npc-999999999',
        itemId: 'item-999999999',
      });
    p = create(p, spec);
    assert.deepEqual(p.intentDrafts.at(-1).values, spec.values);
  }
  assert.equal(validateIntentDrafts(p.intentDrafts), p.intentDrafts);
  assert.equal(p.intentDrafts.length, 7);
  assert.deepEqual(original, before);
  for (const key of [
    'journey',
    'goals',
    'craftList',
    'craftPlans',
    'reservations',
    'allocations',
    'reserveCraftDraft',
  ])
    assert.deepEqual(p[key], before[key]);
});

test('main and compact drafts have independent revisions even when they edit the same target', () => {
  const original = freeze(profile()),
    before = clone(original);
  let p = create(original, sample('goal', { id: 'main', targetId: 'goal-1' }));
  p = create(p, sample('goal', { id: 'compact', targetId: 'goal-1' }));
  const update = put(
    p,
    sample('goal', { id: 'main', targetId: 'goal-1', values: { title: '', detail: '继续输入' } }),
    { expectedRevision: 1 },
  );
  const drafts = applyIntentDraftCommand(freeze(p), freeze(update), { now: T1 }).drafts;
  assert.equal(drafts[0].revision, 2);
  assert.equal(drafts[1].revision, 1);
  assert.equal(drafts[0].values.title, '');
  assert.throws(() => applyIntentDraftCommand({ ...p, intentDrafts: drafts }, update), /另一个窗口/);
  const compact = commit({ ...p, intentDrafts: drafts }, 'compact');
  assert.equal(compact.drafts.length, 1);
  assert.equal(compact.drafts[0].id, 'main');
  assert.deepEqual(original, before);
  drafts[0].values.detail = '变更返回值';
  compact.intent.detail = '变更返回命令';
  assert.equal(p.intentDrafts[0].values.detail, '我的详情');
});

test('new rows require an explicit current preview and exact optimistic revision', () => {
  const p = profile(),
    valid = put(p, sample('goal', { targetId: 'goal-1' }));
  const missing = clone(valid);
  delete missing.expectedTarget;
  assert.throws(() => applyIntentDraftCommand(p, missing), /明确核对/);
  assert.throws(() => applyIntentDraftCommand(p, { ...valid, expectedTarget: null }), /明确核对/);
  assert.throws(() => applyIntentDraftCommand(p, { ...valid, expectedRevision: 1 }), /另一个窗口/);
  const created = create(p, sample('goal', { targetId: 'goal-1' }));
  assert.throws(() => applyIntentDraftCommand(created, valid), /另一个窗口/);
  for (const replacement of [
    { kind: 'journey-todo', targetId: 'todo-1', context: {}, values: sample('journey-todo').values },
    { targetId: '' },
  ])
    assert.throws(
      () => applyIntentDraftCommand(created, { ...valid, ...replacement, expectedRevision: 1 }),
      /不能更换/,
    );
});

test('remove, rebase and commit require the full stored snapshot, including values and lifecycle', () => {
  const p = freeze(create(profile(), sample('goal'))),
    before = clone(p);
  for (const type of ['intent-draft-remove', 'intent-draft-rebase', 'intent-draft-commit']) {
    const extra = type === 'intent-draft-rebase' ? { expectedTarget: null } : {};
    for (const change of [
      (row) => {
        row.values.detail = '伪造';
      },
      (row) => {
        row.updatedAt = T1;
      },
      (row) => {
        row.targetFingerprint = 'a'.repeat(64);
      },
      (row) => {
        row.id = 'foreign';
      },
    ]) {
      const command = guarded(p, type, undefined, extra);
      change(command.expectedDraft);
      assert.throws(() => applyIntentDraftCommand(p, command), /已变化|不存在|不属于/);
    }
    assert.throws(
      () => applyIntentDraftCommand(p, { ...guarded(p, type, undefined, extra), id: 'foreign' }),
      /已变化|不存在|不属于/,
    );
    assert.throws(
      () => applyIntentDraftCommand(p, { type, id: 'main-draft', revision: 1 }),
      /未知字段|缺少字段/,
    );
  }
  const reordered = guarded(p, 'intent-draft-remove');
  reordered.expectedDraft = Object.fromEntries(Object.entries(reordered.expectedDraft).reverse());
  assert.deepEqual(applyIntentDraftCommand(p, reordered), { drafts: [] });
  assert.deepEqual(p, before);
});

test('changed personal targets without timestamps reject commit while subsequent typing retains the old fingerprint', () => {
  let p = create(profile(), sample('goal', { targetId: 'goal-1' }));
  const initial = clone(p.intentDrafts[0]);
  p.goals[0].done = true;
  const update = put(
    p,
    sample('goal', { targetId: 'goal-1', values: { title: '继续写', detail: '保留新输入' } }),
    { expectedRevision: 1, expectedTarget: initial },
  );
  p = { ...p, intentDrafts: applyIntentDraftCommand(p, update, { now: T1 }).drafts };
  assert.equal(p.intentDrafts[0].targetFingerprint, initial.targetFingerprint);
  assert.throws(() => commit(p), /已被修改或删除/);
  const before = clone(p);
  assert.throws(
    () => applyIntentDraftCommand(p, guarded(p, 'intent-draft-rebase', undefined, { expectedTarget: null })),
    /明确预览/,
  );
  assert.deepEqual(p, before);
  const current = intentTarget(p, 'goal', 'goal-1', {});
  const rebased = applyIntentDraftCommand(
    freeze(p),
    guarded(p, 'intent-draft-rebase', undefined, { expectedTarget: current }),
    { now: T1 },
  );
  assert.equal(rebased.drafts[0].revision, 3);
  assert.deepEqual(rebased.drafts[0].values, before.intentDrafts[0].values);
  assert.equal(rebased.drafts[0].targetFingerprint, intentFingerprint(current));
  assert.deepEqual(commit({ ...p, intentDrafts: rebased.drafts }).intent, {
    type: 'goal-edit',
    id: 'goal-1',
    title: '继续写',
    detail: '保留新输入',
  });
  assert.deepEqual(p, before);
});

test('deleted and foreign edit targets remain rejected after explicit rebase, while a fixed scene annotation may be recreated', () => {
  for (const [kind, targetId, remove] of [
    [
      'journey-todo',
      'todo-1',
      (p) => {
        p.journey.todos = [];
      },
    ],
    [
      'journey-gift',
      'gift-1',
      (p) => {
        p.journey.gifts = [];
      },
    ],
    [
      'goal',
      'goal-1',
      (p) => {
        p.goals = [];
      },
    ],
    [
      'craft-plan',
      'plan-1',
      (p) => {
        p.craftPlans = [];
      },
    ],
  ]) {
    let p = create(profile(), sample(kind, { targetId }));
    remove(p);
    const before = clone(p);
    assert.throws(() => commit(p), /已被修改或删除/);
    p = {
      ...p,
      intentDrafts: applyIntentDraftCommand(
        p,
        guarded(p, 'intent-draft-rebase', undefined, { expectedTarget: null }),
        { now: T1 },
      ).drafts,
    };
    assert.throws(() => commit(p), /已被删除|当前周目/);
    assert.deepEqual(p.intentDrafts[0].values, before.intentDrafts[0].values);
    const foreign = create(profile(), sample(kind, { targetId: 'foreign-record' }));
    assert.throws(() => commit(foreign), /已被删除|当前周目/);
  }
  let p = create(profile(), sample('journey-place'));
  p.journey.places = [];
  assert.throws(() => commit(p), /已被修改或删除/);
  p = {
    ...p,
    intentDrafts: applyIntentDraftCommand(
      p,
      guarded(p, 'intent-draft-rebase', undefined, { expectedTarget: null }),
      { now: T1 },
    ).drafts,
  };
  assert.equal(commit(p).intent.placeId, PLACE);
});

test('target projections are detached exact personal records; itinerary names guard the full itinerary', () => {
  const p = profile();
  p.saveDerived = { inventory: [{ id: 1000, count: 999 }], path: 'synthetic-only' };
  const targets = [
    ['journey-place', PLACE, {}, p.journey.places[0]],
    ['journey-todo', 'todo-1', {}, p.journey.todos[0]],
    ['journey-gift', 'gift-1', {}, p.journey.gifts[0]],
    ['goal', 'goal-1', {}, p.goals[0]],
    ['craft-plan', 'plan-1', sample('craft-plan').context, p.craftPlans[0]],
    ['itinerary-name', '', {}, p.journey.itinerary],
    [
      'itinerary-choice',
      OWNER,
      { mode: 'place', actionId: OWNER, ownerId: OWNER },
      { status: 'active', step: p.journey.itinerary.steps[0] },
    ],
  ];
  for (const [kind, targetId, context, expected] of targets) {
    const target = intentTarget(freeze(p), kind, targetId, context);
    assert.deepEqual(target, expected);
    assert(!JSON.stringify(target).includes('synthetic-only'));
    if (target) target.extra = true;
    assert.equal(expected.extra, undefined);
  }
  assert.deepEqual(intentTarget({}, 'itinerary-choice', ACTION, { mode: 'add', actionId: ACTION }), {
    status: 'draft',
    step: null,
  });
  const named = create(clone(p), sample('itinerary-name'));
  named.journey.itinerary.steps[0].skipped = true;
  assert.throws(() => commit(named), /已被修改或删除/);
});

test('normalized commits cover each kind, strip filters, and consume only the chosen draft', () => {
  const cases = [
    [
      sample('journey-place'),
      { type: 'journey-place-put', placeId: PLACE, note: '我的地点备注', favorite: true, done: false },
    ],
    [
      sample('journey-todo'),
      {
        type: 'journey-todo-put',
        id: 'draft-main-draft',
        title: '我的待办',
        detail: '未完的详情',
        done: false,
      },
    ],
    [
      sample('journey-todo', {
        targetId: 'todo-1',
        values: { ...sample('journey-todo').values, placeId: PLACE },
      }),
      {
        type: 'journey-todo-put',
        id: 'todo-1',
        title: '我的待办',
        detail: '未完的详情',
        placeId: PLACE,
        done: false,
      },
    ],
    [
      sample('journey-gift'),
      {
        type: 'journey-gift-put',
        id: 'draft-main-draft',
        npcId: NPC,
        itemId: ITEM,
        quantity: 2,
        note: '我的赠礼',
        done: false,
      },
    ],
    [
      sample('journey-gift', {
        targetId: 'gift-1',
        values: { ...sample('journey-gift').values, placeId: PLACE },
      }),
      {
        type: 'journey-gift-put',
        id: 'gift-1',
        npcId: NPC,
        itemId: ITEM,
        quantity: 2,
        note: '我的赠礼',
        placeId: PLACE,
        done: false,
      },
    ],
    [sample('goal'), { type: 'goal-add', title: '我的目标', detail: '我的详情' }],
    [
      sample('goal', { targetId: 'goal-1' }),
      { type: 'goal-edit', id: 'goal-1', title: '我的目标', detail: '我的详情' },
    ],
    [
      sample('craft-plan'),
      {
        type: 'craft-plan-save',
        name: '我的制作计划',
        list: [{ id: RECIPE, quantity: 2 }],
        choices: {},
        addGoal: true,
        reserved: true,
      },
    ],
    [
      sample('craft-plan', { targetId: 'plan-1' }),
      {
        type: 'craft-plan-save',
        id: 'plan-1',
        name: '我的制作计划',
        list: [{ id: RECIPE, quantity: 2 }],
        choices: {},
        addGoal: true,
        reserved: true,
      },
    ],
    [sample('itinerary-name'), { type: 'journey-itinerary-name', name: '我的行程' }],
    [sample('itinerary-choice'), { type: 'journey-itinerary-add', id: ACTION, placeId: PLACE }],
    [
      sample('itinerary-choice', {
        targetId: OWNER,
        context: { mode: 'place', actionId: OWNER, ownerId: OWNER },
        values: { placeId: '' },
      }),
      { type: 'journey-itinerary-place', id: OWNER },
    ],
    [
      sample('itinerary-choice', {
        targetId: OWNER,
        context: { mode: 'continue', actionId: ACTION, ownerId: OWNER },
      }),
      { type: 'journey-itinerary-continue', id: OWNER, targetId: ACTION, placeId: PLACE },
    ],
  ];
  for (const [spec, expected] of cases) {
    let p = create(profile(), spec);
    p = create(p, sample('goal', { id: 'compact' }));
    const before = clone(p),
      result = commit(freeze(p));
    assert.deepEqual(result.intent, expected);
    assert.deepEqual(result.drafts, [before.intentDrafts[1]]);
    assert.deepEqual(p, before);
    if (spec.kind.startsWith('journey-'))
      assert.doesNotThrow(() => applyJourneyCommand(p.journey, result.intent));
  }
});

test('new todo and gift IDs cannot upsert a foreign record and rejected input preserves all drafts', () => {
  for (const [kind, table] of [
    ['journey-todo', 'todos'],
    ['journey-gift', 'gifts'],
  ]) {
    const p = create(profile(), sample(kind));
    p.journey[table].push({ ...p.journey[table][0], id: 'draft-main-draft' });
    const before = clone(p);
    assert.throws(() => commit(p), /属于其他记录/);
    assert.deepEqual(p, before);
  }
});

test('partial gift quantities and filters survive put; malformed or incomplete commits fail without consumption', () => {
  for (const quantity of [
    '',
    ' ',
    '还没写完',
    '-1',
    '0',
    '1000',
    '1.1',
    '1e2',
    '+2',
    '1 2',
    '9'.repeat(32),
  ]) {
    const p = create(
      profile(),
      sample('journey-gift', { values: { ...sample('journey-gift').values, quantity } }),
    );
    const before = clone(p);
    assert.equal(p.intentDrafts[0].values.quantity, quantity);
    assert.throws(() => commit(p), /赠礼数量/);
    assert.deepEqual(p, before);
  }
  for (const values of [
    { npcId: '' },
    { itemId: '' },
    { npcId: 'npc-999999999' },
    { itemId: 'item-999999999' },
    { placeId: 'place-999999999' },
  ]) {
    const p = create(
      profile(),
      sample('journey-gift', { values: { ...sample('journey-gift').values, ...values } }),
    );
    assert.throws(() => commit(p), /不存在|地点/);
    assert.equal(p.intentDrafts.length, 1);
  }
  for (const kind of ['journey-todo', 'goal', 'craft-plan', 'itinerary-name']) {
    const spec = sample(kind);
    spec.values[Object.hasOwn(spec.values, 'title') ? 'title' : 'name'] = ' ';
    const p = create(profile(), spec);
    assert.throws(() => commit(p), /标题|名称/);
    assert.equal(p.intentDrafts.length, 1);
  }
});

test('craft-plan context is an immutable explicit list snapshot even when another editor changes', () => {
  const spec = sample('craft-plan');
  spec.context.choices = { 10216: 'fusion-9500' };
  let p = create(profile(), spec);
  spec.context.list[0].quantity = 99;
  p.craftList[0].quantity = 11;
  p.craftChoices = {};
  assert.deepEqual(commit(p).intent.list, [{ id: RECIPE, quantity: 2 }]);
  assert.deepEqual(commit(p).intent.choices, { 10216: 'fusion-9500' });
  const changed = put(
    p,
    sample('craft-plan', { context: { list: [{ id: RECIPE, quantity: 3 }], choices: {} } }),
    { expectedRevision: 1 },
  );
  assert.throws(() => applyIntentDraftCommand(p, changed), /上下文不能更换/);
  p = create(profile(), sample('craft-plan', { context: { list: [], choices: {} } }));
  assert.throws(() => commit(p), /至少需要/);
  const duplicate = sample('craft-plan');
  duplicate.context.list.push(clone(duplicate.context.list[0]));
  assert.throws(() => create(profile(), duplicate), /重复配方/);
  assert.throws(
    () =>
      create(
        profile(),
        sample('craft-plan', { context: { list: [{ id: RECIPE, quantity: 0 }], choices: {} } }),
      ),
    /制作次数/,
  );
  assert.throws(
    () =>
      create(
        profile(),
        sample('craft-plan', { context: { list: [{ id: RECIPE, quantity: 1 }], choices: { 1: RECIPE } } }),
      ),
    /加工配方/,
  );
});

test('itinerary ownership, full step changes and trusted current action validation remain explicit', () => {
  for (const context of [
    { mode: 'place', actionId: ACTION, ownerId: OWNER },
    { mode: 'add', actionId: ACTION, ownerId: OWNER },
    { mode: 'continue', actionId: ACTION },
    { mode: 'other', actionId: ACTION },
  ])
    assert.throws(() => create(profile(), sample('itinerary-choice', { targetId: OWNER, context })));
  assert.throws(() => create(profile(), sample('itinerary-choice', { targetId: OWNER })), /不属于/);
  const spec = sample('itinerary-choice', {
    targetId: OWNER,
    context: { mode: 'place', actionId: OWNER, ownerId: OWNER },
  });
  let p = create(profile(), spec);
  p.journey.itinerary.steps[0].sources[0].id = 'other-todo';
  assert.throws(() => commit(p), /已被修改或删除/);
  p = create(profile(), spec);
  p.journey.itinerary.steps = [];
  assert.throws(() => commit(p), /已被修改或删除/);
  p = {
    ...p,
    intentDrafts: applyIntentDraftCommand(
      p,
      guarded(p, 'intent-draft-rebase', undefined, {
        expectedTarget: intentTarget(p, spec.kind, spec.targetId, spec.context),
      }),
      { now: T1 },
    ).drafts,
  };
  assert.throws(() => commit(p), /不存在/);
  const alreadyAdded = create(
    profile(),
    sample('itinerary-choice', { targetId: OWNER, context: { mode: 'add', actionId: OWNER } }),
  );
  assert.throws(() => commit(alreadyAdded), /已变化/);
  const added = create(profile(), sample('itinerary-choice'));
  const command = commit(added).intent;
  assert.throws(() => applyJourneyCommand(added.journey, command), /当前清单/);
  const trustedAction = {
    id: ACTION,
    kind: 'quest',
    title: '测试资料行动',
    places: [{ mapIds: [PLACE] }],
    sources: [{ type: 'user', id: 'goal-1', field: 'goals' }],
    progress: { status: 'manual' },
  };
  const domain = applyJourneyCommand(added.journey, command, { actions: [trustedAction] });
  assert.equal(domain.itinerary.steps.at(-1).actionId, ACTION);
  assert.throws(
    () => applyJourneyCommand(added.journey, command, { actions: [{ ...trustedAction, places: [] }] }),
    /不属于/,
  );
  const continuing = create(
    profile(),
    sample('itinerary-choice', {
      targetId: OWNER,
      context: { mode: 'continue', actionId: ACTION, ownerId: OWNER },
    }),
  );
  assert.throws(
    () => applyJourneyCommand(continuing.journey, commit(continuing).intent, { actions: [trustedAction] }),
    /接续步骤已变化/,
  );
});

test('optional itinerary labels are bounded immutable display text with no target or command authority', () => {
  const context = { mode: 'add', actionId: ACTION, label: '当时可见的行动名称' };
  const p = create(profile(), sample('itinerary-choice', { context }));
  assert.equal(p.intentDrafts[0].context.label, context.label);
  assert.deepEqual(
    intentTarget(p, 'itinerary-choice', ACTION, context),
    intentTarget(p, 'itinerary-choice', ACTION, { mode: 'add', actionId: ACTION }),
  );
  assert.deepEqual(commit(p).intent, { type: 'journey-itinerary-add', id: ACTION, placeId: PLACE });
  const replaced = put(p, sample('itinerary-choice', { context: { ...context, label: '另一个名称' } }), {
    expectedRevision: 1,
  });
  assert.throws(() => applyIntentDraftCommand(p, replaced), /上下文不能更换/);
  for (const label of [null, 1, [], 'x'.repeat(361), '名称\u0000'])
    assert.throws(
      () => create(profile(), sample('itinerary-choice', { context: { ...context, label } })),
      /行程选择名称/,
    );
  assert.doesNotThrow(() =>
    create(profile(), sample('itinerary-choice', { context: { ...context, label: 'x'.repeat(360) } })),
  );
});

test('capacity never evicts and a full collection permits only an existing-row update or explicit removal', () => {
  let p = profile();
  for (let i = 0; i < 32; i++) p = create(p, sample('goal', { id: 'draft-' + i }));
  const before = clone(p),
    overflow = put(p, sample('goal', { id: 'overflow' }));
  assert.throws(() => applyIntentDraftCommand(freeze(p), overflow), /最多保留 32/);
  assert.deepEqual(p, before);
  const updated = applyIntentDraftCommand(
    p,
    put(p, sample('goal', { id: 'draft-17' }), { expectedRevision: 1 }),
    { now: T1 },
  );
  assert.equal(updated.drafts.length, 32);
  assert.equal(updated.drafts[17].revision, 2);
  const removed = applyIntentDraftCommand(
    { ...p, intentDrafts: updated.drafts },
    guarded({ ...p, intentDrafts: updated.drafts }, 'intent-draft-remove', 'draft-17'),
  );
  assert.equal(removed.drafts.length, 31);
  assert.deepEqual(
    removed.drafts.map((row) => row.id),
    before.intentDrafts.filter((row) => row.id !== 'draft-17').map((row) => row.id),
  );
  assert.throws(
    () => validateIntentDrafts([...before.intentDrafts, { ...before.intentDrafts[0], id: 'overflow' }]),
    /最多保留 32/,
  );
});

test('strict kind shapes, pointer ownership, text bounds, identity and command keys reject widened interfaces', () => {
  const p = create(profile(), sample('journey-gift')),
    row = p.intentDrafts[0];
  for (const mutate of [
    (r) => {
      r.extra = true;
    },
    (r) => {
      delete r.createdAt;
    },
    (r) => {
      r.context.extra = true;
    },
    (r) => {
      r.values.savePath = 'synthetic';
    },
    (r) => {
      delete r.values.personQuery;
    },
    (r) => {
      r.values.quantity = 2;
    },
    (r) => {
      r.values.quantity = '1'.repeat(33);
    },
    (r) => {
      r.values.note = 'x'.repeat(1001);
    },
    (r) => {
      r.values.personQuery = 'x'.repeat(101);
    },
    (r) => {
      r.values.itemQuality = 'x'.repeat(31);
    },
    (r) => {
      r.values.preferredOnly = 1;
    },
    (r) => {
      r.values.npcId = 'item-1';
    },
    (r) => {
      r.values.placeId = 'scene-1';
    },
    (r) => {
      r.kind = 'custom';
    },
    (r) => {
      r.kind = ['journey-gift'];
    },
    (r) => {
      r.id = '_bad';
    },
    (r) => {
      r.id = '中';
    },
    (r) => {
      r.id = 'a'.repeat(65);
    },
    (r) => {
      r.targetId = 'bad/id';
    },
    (r) => {
      r.values.note = '\u0000';
    },
  ]) {
    const bad = clone(row);
    mutate(bad);
    assert.throws(() => validateIntentDrafts([bad]));
  }
  assert.throws(() => validateIntentDrafts([row, clone(row)]), /重复/);
  for (const kind of [
    'journey-place',
    'journey-todo',
    'goal',
    'craft-plan',
    'itinerary-name',
    'itinerary-choice',
  ]) {
    const created = create(profile(), sample(kind));
    const bad = clone(created.intentDrafts[0]);
    bad.values.extra = true;
    assert.throws(() => validateIntentDrafts([bad]), /未知字段/);
    const missing = clone(created.intentDrafts[0]);
    delete missing.values[Object.keys(missing.values)[0]];
    assert.throws(() => validateIntentDrafts([missing]), /缺少字段/);
  }
  for (const kind of ['journey-todo', 'goal', 'craft-plan', 'itinerary-name']) {
    const spec = sample(kind),
      key = Object.hasOwn(spec.values, 'title') ? 'title' : 'name';
    spec.values[key] = 'x'.repeat(kind === 'journey-todo' ? 121 : kind === 'goal' ? 201 : 81);
    assert.throws(() => create(profile(), spec), /最多/);
  }
  for (const type of ['intent-draft-remove', 'intent-draft-commit', 'intent-draft-rebase']) {
    const command = guarded(
      p,
      type,
      undefined,
      type === 'intent-draft-rebase' ? { expectedTarget: null } : {},
    );
    assert.throws(() => applyIntentDraftCommand(p, { ...command, profileId: p.id }), /未知字段/);
  }
  assert.throws(() => applyIntentDraftCommand(p, { type: 'goal-add', title: '绕过草稿' }), /未知/);
  assert.throws(
    () => applyIntentDraftCommand(profile(), { ...put(profile(), sample('goal')), sourceId: 'other' }),
    /未知字段/,
  );
  assert.throws(() => intentTarget(profile(), 'itinerary-name', 'foreign', {}), /须为空/);
});

test('strict ISO calendar dates, monotonic lifecycle, fingerprint and bounded revisions are enforced', () => {
  const p = create(profile(), sample('goal')),
    row = p.intentDrafts[0];
  for (const date of [
    '2026-02-30T08:00:00Z',
    '2025-02-29T08:00:00Z',
    '2026-13-01T08:00:00Z',
    '2026-10-09T24:00:00Z',
    '2026-10-09',
    '2026-10-09T08:00:00',
    '0000-01-01T00:00:00Z',
    '2026-10-09T08:00:00+24:00',
  ])
    assert.throws(() => validateIntentDrafts([{ ...row, createdAt: date }]));
  const offset = { ...row, createdAt: '2026-10-09T16:00:00+08:00', updatedAt: T1 };
  assert.doesNotThrow(() => validateIntentDrafts([offset]));
  for (const revision of [0, -1, 1.5, '1', 2147483648, NaN])
    assert.throws(() => validateIntentDrafts([{ ...row, revision }]));
  for (const targetFingerprint of ['A'.repeat(64), 'a'.repeat(63), '', null])
    assert.throws(() => validateIntentDrafts([{ ...row, targetFingerprint }]));
  assert.throws(() => validateIntentDrafts([{ ...row, createdAt: T1 }]), /早于/);
  assert.throws(
    () =>
      applyIntentDraftCommand(p, put(p, sample('goal'), { expectedRevision: 1 }), {
        now: '2026-10-09T07:59:59.000Z',
      }),
    /不能倒退/,
  );
  const atMax = { ...p, intentDrafts: [{ ...row, revision: 2147483647 }] };
  assert.throws(
    () => applyIntentDraftCommand(atMax, put(atMax, sample('goal'), { expectedRevision: 2147483647 })),
    /版本已达上限/,
  );
  assert.throws(
    () =>
      applyIntentDraftCommand(
        atMax,
        guarded(atMax, 'intent-draft-rebase', undefined, { expectedTarget: null }),
      ),
    /版本已达上限/,
  );
  assert.doesNotThrow(() => commit(atMax));
  const fromDate = create(profile(), sample('goal'), { now: new Date(T0) });
  assert.equal(fromDate.intentDrafts[0].createdAt, T0);
  const same = applyIntentDraftCommand(p, put(p, sample('goal'), { expectedRevision: 1 }), { now: T0 });
  assert.equal(same.drafts[0].updatedAt, T0);
});

test('put, remove and rebase leave all domain state and every unselected draft unchanged', () => {
  let p = create(profile(), sample('goal', { id: 'selected', targetId: 'goal-1' }));
  p = create(
    p,
    sample('journey-gift', {
      id: 'unselected',
      values: { ...sample('journey-gift').values, quantity: '...' },
    }),
  );
  p.goals[0].detail = '其他窗口更新';
  const before = clone(p);
  const rebased = applyIntentDraftCommand(
    freeze(p),
    guarded(p, 'intent-draft-rebase', 'selected', { expectedTarget: intentTarget(p, 'goal', 'goal-1', {}) }),
    { now: T1 },
  );
  const withRebase = { ...p, intentDrafts: rebased.drafts };
  const removed = applyIntentDraftCommand(withRebase, guarded(withRebase, 'intent-draft-remove', 'selected'));
  assert.deepEqual(removed, { drafts: [before.intentDrafts[1]] });
  assert.deepEqual(rebased.drafts[1], before.intentDrafts[1]);
  assert.deepEqual(p, before);
  assert.deepEqual(Object.keys(rebased), ['drafts']);
});
