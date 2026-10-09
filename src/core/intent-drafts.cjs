'use strict';

// Partial personal edits only. The caller owns domain validation and one atomic Store write.
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { validateCraftList } = require('./material-plan.cjs');
const { validateCraftChoices } = require('./crafting-stages.cjs');
const { validateJourneyState, emptyJourneyState } = require('./journey-state.cjs');
const MAX_DRAFTS = 32;
const MAX_REVISION = 2147483647;
const localId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const draftId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const actionId = /^journey:[a-z-]+:[a-f0-9]{32}$/;
const valueShapes = {
  'journey-place': { note: 1000, favorite: 'boolean', done: 'boolean' },
  'journey-todo': { title: 120, detail: 2000, placeId: 'place', done: 'boolean', placeQuery: 100 },
  'journey-gift': {
    npcId: 'npc',
    itemId: 'item',
    quantity: 32,
    placeId: 'place',
    note: 1000,
    done: 'boolean',
    personQuery: 100,
    itemQuery: 100,
    itemQuality: 30,
    preferredOnly: 'boolean',
    stockOnly: 'boolean',
    placeQuery: 100,
  },
  goal: { title: 200, detail: 2000, placeId: 'place', placeQuery: 100, quantity: 32 },
  'craft-plan': { name: 80, addGoal: 'boolean', reserved: 'boolean' },
  'itinerary-name': { name: 80 },
  'itinerary-choice': { placeId: 'place' },
};
const rowKeys = [
  'id',
  'kind',
  'targetId',
  'context',
  'values',
  'targetFingerprint',
  'revision',
  'createdAt',
  'updatedAt',
];

// Inspect data descriptors rather than reading getters or invoking toJSON. Canonical
// objects sort their keys; arrays retain their order and may not omit elements.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || types.isProxy(value)) throw Error('草稿须为纯 JSON 数据');
  const array = Array.isArray(value),
    proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    throw Error('草稿 JSON 对象原型无效');
  if (ancestors.has(value)) throw Error('草稿 JSON 不能循环引用');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string' ||
      key === 'toJSON' ||
      !Object.hasOwn(descriptor, 'value') ||
      (!(array && key === 'length') && !descriptor.enumerable)
    )
      throw Error('草稿须为纯 JSON 数据');
  }
  ancestors.add(value);
  try {
    if (array) {
      if (
        keys.length !== value.length + 1 ||
        keys.some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
      )
        throw Error('草稿 JSON 数组格式无效');
      const rows = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) throw Error('草稿 JSON 数组不能缺项');
        rows.push(canonical(descriptors[i].value, ancestors));
      }
      return '[' + rows.join(',') + ']';
    }
    return (
      '{' +
      keys
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(descriptors[key].value, ancestors))
        .join(',') +
      '}'
    );
  } finally {
    ancestors.delete(value);
  }
}
const clone = (value) => JSON.parse(canonical(value));
function intentFingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function exact(value, required, optional = [], label = '草稿') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw Error(`${label}包含未知字段或缺少字段`);
}
function text(value, max, label, blank = true) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!blank && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw Error(`${label}无效，最多 ${max} 字`);
}
function pointer(value, kind, blank = false) {
  if (
    typeof value !== 'string' ||
    (!(blank && value === '') && !new RegExp(`^${kind}-\\d{1,9}$`).test(value))
  )
    throw Error(`${kind} ID 无效`);
}
function id(value, pattern = localId) {
  if (typeof value !== 'string' || !pattern.test(value)) throw Error('草稿或目标 ID 无效');
}
function iso(value) {
  const match =
    typeof value === 'string' &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw Error('草稿时间须为带时区的 ISO 时间');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = match[8] === 'Z' ? [0, 0] : match[8].slice(1).split(':').map(Number);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offset[0] > 23 ||
    offset[1] > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error('草稿时间不是有效日期');
  return new Date(value).toISOString();
}
function revision(value, min = 1) {
  if (!Number.isSafeInteger(value) || value < min || value > MAX_REVISION) throw Error('草稿版本无效');
}
function identity(kind, targetId, context) {
  if (typeof kind !== 'string' || !Object.hasOwn(valueShapes, kind)) throw Error('未识别的个人安排草稿');
  if (kind === 'craft-plan') {
    exact(context, ['list', 'choices'], [], '制作计划草稿上下文');
    validateCraftList(context.list);
    for (const line of context.list) exact(line, ['id', 'quantity'], [], '制作计划配方');
    validateCraftChoices(context.choices);
  } else if (kind === 'itinerary-choice') {
    if (!['add', 'place', 'continue'].includes(context?.mode)) throw Error('行程选择模式无效');
    exact(
      context,
      ['mode', 'actionId', ...(context.mode === 'add' ? [] : ['ownerId'])],
      ['label'],
      '行程选择草稿上下文',
    );
    if (context.label !== undefined) text(context.label, 360, '行程选择名称');
    id(context.actionId, actionId);
    if (context.mode !== 'add') id(context.ownerId, actionId);
    if (
      targetId !== (context.mode === 'add' ? context.actionId : context.ownerId) ||
      (context.mode === 'place' && context.actionId !== context.ownerId)
    )
      throw Error('行程选择不属于草稿目标');
    return;
  } else exact(context, [], [], '草稿上下文');
  if (kind === 'journey-place') pointer(targetId, 'place');
  else if (kind === 'itinerary-name') {
    if (targetId !== '') throw Error('行程名称草稿目标须为空');
  } else if (targetId !== '') {
    id(targetId, kind === 'goal' || kind === 'craft-plan' ? /^[a-zA-Z0-9-]{1,80}$/ : localId);
    if (kind === 'craft-plan' && targetId === 'current') throw Error('制作计划草稿目标无效');
  }
}
function values(kind, value) {
  const shape = valueShapes[kind];
  // Earlier goal drafts only held text. Missing place fields must retain the
  // original goal's place; an explicit empty placeId is the user's removal.
  const optional = kind === 'goal' ? ['placeId', 'placeQuery', 'quantity'] : [];
  exact(
    value,
    Object.keys(shape).filter((key) => !optional.includes(key)),
    optional,
    '草稿编辑值',
  );
  for (const [key, rule] of Object.entries(shape)) {
    if (optional.includes(key) && !Object.hasOwn(value, key)) continue;
    if (typeof rule === 'number') text(value[key], rule, key);
    else if (rule === 'boolean') {
      if (typeof value[key] !== 'boolean') throw Error(`${key}须为布尔值`);
    } else pointer(value[key], rule, true);
  }
}
function validateIntentDrafts(rows) {
  canonical(rows);
  if (!Array.isArray(rows) || rows.length > MAX_DRAFTS)
    throw Error('每个周目最多保留 32 份安排草稿，请明确处理已有草稿');
  const seen = new Set();
  for (const row of rows) {
    exact(row, rowKeys);
    id(row.id, draftId);
    if (seen.has(row.id)) throw Error('安排草稿 ID 重复');
    seen.add(row.id);
    identity(row.kind, row.targetId, row.context);
    values(row.kind, row.values);
    revision(row.revision);
    if (typeof row.targetFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.targetFingerprint))
      throw Error('草稿目标指纹无效');
    iso(row.createdAt);
    iso(row.updatedAt);
    if (Date.parse(row.updatedAt) < Date.parse(row.createdAt)) throw Error('草稿更新时间早于创建时间');
  }
  return rows;
}
function intentTarget(profile, kind, targetId, context = {}) {
  canonical(context);
  identity(kind, targetId, context);
  const journey = profile.journey || {};
  let target;
  if (kind === 'journey-place') target = journey.places?.find((row) => row.placeId === targetId) || null;
  else if (kind === 'journey-todo') target = journey.todos?.find((row) => row.id === targetId) || null;
  else if (kind === 'journey-gift') target = journey.gifts?.find((row) => row.id === targetId) || null;
  else if (kind === 'goal') target = profile.goals?.find((row) => row.id === targetId) || null;
  else if (kind === 'craft-plan') target = profile.craftPlans?.find((row) => row.id === targetId) || null;
  else if (kind === 'itinerary-name') target = journey.itinerary || null;
  else
    target = {
      status: journey.itinerary?.status || 'draft',
      step: journey.itinerary?.steps.find((row) => row.actionId === targetId) || null,
    };
  return clone(target);
}
function normalizedIntent(profile, row, target) {
  const { kind, targetId, context, values: value } = row;
  const place = value.placeId ? { placeId: value.placeId } : {};
  let intent;
  if (['journey-todo', 'journey-gift', 'goal', 'craft-plan'].includes(kind) && targetId && target === null)
    throw Error('原安排已被删除或不在当前周目，草稿仍保留');
  if (kind === 'journey-place')
    intent = {
      type: 'journey-place-put',
      placeId: targetId,
      note: value.note,
      favorite: value.favorite,
      done: value.done,
    };
  else if (kind === 'journey-todo' || kind === 'journey-gift') {
    const domainId = targetId || `draft-${row.id}`;
    const table = kind === 'journey-todo' ? 'todos' : 'gifts';
    if (!targetId && profile.journey?.[table]?.some((record) => record.id === domainId))
      throw Error('新安排编号已属于其他记录，草稿仍保留');
    if (kind === 'journey-todo') {
      text(value.title, 120, '待办标题', false);
      intent = {
        type: 'journey-todo-put',
        id: domainId,
        title: value.title,
        detail: value.detail,
        ...place,
        done: value.done,
      };
    } else {
      const raw = value.quantity.trim(),
        quantity = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999)
        throw Error('赠礼数量须为 1 至 999');
      intent = {
        type: 'journey-gift-put',
        id: domainId,
        npcId: value.npcId,
        itemId: value.itemId,
        quantity,
        note: value.note,
        ...place,
        done: value.done,
      };
    }
  } else if (kind === 'goal') {
    text(value.title, 200, '目标标题', false);
    let quantity;
    if (Object.hasOwn(value, 'quantity')) {
      if (!targetId) throw Error('收集数量须编辑原物品目标');
      const raw = value.quantity.trim();
      quantity = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999)
        throw Error('收集数量须为 1 至 999 的整数');
    }
    intent = {
      type: targetId ? 'goal-edit' : 'goal-add',
      ...(targetId ? { id: targetId } : {}),
      title: value.title,
      detail: value.detail,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(Object.hasOwn(value, 'placeId') ? { placeId: value.placeId } : {}),
    };
  } else if (kind === 'craft-plan') {
    text(value.name, 80, '制作计划名称', false);
    if (!context.list.length) throw Error('制作计划至少需要一份配方');
    intent = {
      type: 'craft-plan-save',
      ...(targetId ? { id: targetId } : {}),
      name: value.name,
      list: context.list,
      choices: context.choices,
      addGoal: value.addGoal,
      reserved: value.reserved,
    };
  } else if (kind === 'itinerary-name') {
    text(value.name, 80, '行程名称', false);
    intent = { type: 'journey-itinerary-name', name: value.name };
  } else {
    if (context.mode === 'add' ? target.step !== null : target.step === null)
      throw Error('行程步骤已变化或不存在，草稿仍保留');
    intent =
      context.mode === 'continue'
        ? { type: 'journey-itinerary-continue', id: context.ownerId, targetId: context.actionId, ...place }
        : { type: `journey-itinerary-${context.mode}`, id: context.actionId, ...place };
  }
  if (kind.startsWith('journey-')) {
    const table = kind === 'journey-place' ? 'places' : kind === 'journey-todo' ? 'todos' : 'gifts';
    const { type, ...record } = intent;
    validateJourneyState({ ...emptyJourneyState(), [table]: [record] });
  }
  return clone(intent);
}
function clock(options, previous) {
  exact(options, [], ['now'], '草稿选项');
  const raw =
    options.now === undefined
      ? new Date().toISOString()
      : options.now instanceof Date
        ? Date.prototype.toISOString.call(options.now)
        : options.now;
  const stamp = iso(raw);
  if (previous && Date.parse(stamp) < Date.parse(previous.updatedAt)) throw Error('草稿更新时间不能倒退');
  return stamp;
}
function applyIntentDraftCommand(profile, command, options = {}) {
  canonical(command);
  const schemas = {
    'intent-draft-put': [
      ['type', 'id', 'kind', 'targetId', 'context', 'values', 'expectedRevision'],
      ['expectedTarget'],
    ],
    'intent-draft-remove': [['type', 'id', 'expectedDraft'], []],
    'intent-draft-rebase': [['type', 'id', 'expectedDraft', 'expectedTarget'], []],
    'intent-draft-commit': [['type', 'id', 'expectedDraft'], []],
  };
  if (typeof command?.type !== 'string' || !Object.hasOwn(schemas, command.type))
    throw Error('未知安排草稿命令');
  exact(command, ...schemas[command.type], '安排草稿命令');
  id(command.id, draftId);
  const drafts = profile.intentDrafts === undefined ? [] : profile.intentDrafts;
  validateIntentDrafts(drafts);
  const at = drafts.findIndex((row) => row.id === command.id),
    previous = drafts[at];
  if (command.type === 'intent-draft-put') {
    identity(command.kind, command.targetId, command.context);
    values(command.kind, command.values);
    revision(command.expectedRevision, 0);
    if (command.expectedRevision !== (previous?.revision || 0))
      throw Error('这份草稿已在另一个窗口变化，当前编辑仍保留');
    if (
      previous &&
      (previous.kind !== command.kind ||
        previous.targetId !== command.targetId ||
        canonical(previous.context) !== canonical(command.context))
    )
      throw Error('草稿种类、目标和上下文不能更换，请另存一份草稿');
    if (previous?.revision === MAX_REVISION) throw Error('草稿版本已达上限，请另存一份草稿');
    const target = intentTarget(profile, command.kind, command.targetId, command.context);
    if (
      !previous &&
      (!Object.hasOwn(command, 'expectedTarget') || canonical(command.expectedTarget) !== canonical(target))
    )
      throw Error('新草稿须明确核对当前目标，原安排已变化');
    if (!previous && drafts.length >= MAX_DRAFTS)
      throw Error('每个周目最多保留 32 份安排草稿，请明确处理已有草稿');
    const stamp = clock(options, previous);
    const row = {
      id: command.id,
      kind: command.kind,
      targetId: command.targetId,
      context: command.context,
      values: command.values,
      targetFingerprint: previous?.targetFingerprint || intentFingerprint(target),
      revision: command.expectedRevision + 1,
      createdAt: previous?.createdAt || stamp,
      updatedAt: stamp,
    };
    const next = clone(drafts);
    if (previous) next[at] = clone(row);
    else next.push(clone(row));
    validateIntentDrafts(next);
    return { drafts: next };
  }
  validateIntentDrafts([command.expectedDraft]);
  if (!previous || canonical(command.expectedDraft) !== canonical(previous))
    throw Error('这份草稿已变化、不存在或不属于当前周目，请重新核对');
  if (command.type === 'intent-draft-remove')
    return { drafts: clone(drafts.filter((row) => row.id !== command.id)) };
  const target = intentTarget(profile, previous.kind, previous.targetId, previous.context);
  if (command.type === 'intent-draft-rebase') {
    if (canonical(command.expectedTarget) !== canonical(target))
      throw Error('原安排已变化，请明确预览当前目标后重新核对');
    if (previous.revision === MAX_REVISION) throw Error('草稿版本已达上限，请另存一份草稿');
    const next = clone(drafts);
    next[at] = {
      ...next[at],
      targetFingerprint: intentFingerprint(target),
      revision: previous.revision + 1,
      updatedAt: clock(options, previous),
    };
    validateIntentDrafts(next);
    return { drafts: next };
  }
  if (previous.targetFingerprint !== intentFingerprint(target))
    throw Error('原安排已被修改或删除，草稿仍保留，请先明确核对');
  const intent = normalizedIntent(profile, previous, target);
  return { drafts: clone(drafts.filter((row) => row.id !== command.id)), intent };
}

module.exports = { validateIntentDrafts, intentTarget, intentFingerprint, applyIntentDraftCommand };
