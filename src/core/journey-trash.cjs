'use strict';

// Personal arrangements only. The caller owns persistence and history events.
const { randomUUID } = require('node:crypto');
const { emptyJourneyState, validateJourneyState, applyJourneyCommand, MAX } = require('./journey-state.cjs');
const { validateISOTime } = require('./event-journal.cjs');
const { intentFingerprint } = require('./intent-drafts.cjs');
const { validateCraftPlans } = require('./craft-plans.cjs');
const MAX_TRASH = 5000;
const localId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const kinds = {
  place: ['places', 'placeId'],
  todo: ['todos', 'id'],
  gift: ['gifts', 'id'],
  goal: ['goals', 'id'],
  'craft-plan': ['craftPlans', 'id'],
};
const clone = (value) => structuredClone(value);

function exact(value, required, optional = [], label = '已删除安排') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw Error(`${label}包含未知字段或缺少字段`);
}
function id(value) {
  if (typeof value !== 'string' || !localId.test(value)) throw Error('已删除安排 ID 无效');
}
function validateRecord(kind, record) {
  if (typeof kind !== 'string' || !Object.hasOwn(kinds, kind)) throw Error('已删除安排类型无效');
  if (kind === 'craft-plan') {
    validateCraftPlans([record]);
    return;
  }
  if (kind === 'goal') {
    // Archived references may outlive their craft plan. Store checks live source
    // ownership again on restore; an unavailable source must not erase this copy.
    exact(
      record,
      ['id', 'title', 'detail', 'done'],
      ['createdAt', 'source', 'pinned', 'progressMode'],
      '已移除目标',
    );
    if (typeof record.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(record.id)) throw Error('待办编号无效');
    if (
      typeof record.title !== 'string' ||
      !record.title.trim() ||
      record.title.length > 200 ||
      typeof record.detail !== 'string' ||
      record.detail.length > 2000 ||
      typeof record.done !== 'boolean'
    )
      throw Error('待办无效');
    if (record.createdAt !== undefined) validateISOTime(record.createdAt, '目标创建时间');
    if (record.pinned !== undefined && typeof record.pinned !== 'boolean') throw Error('目标置顶无效');
    if (
      record.progressMode !== undefined &&
      (!['auto', 'manual'].includes(record.progressMode) || record.source?.type !== 'quest')
    )
      throw Error('任务目标跟踪方式无效');
    if (record.source !== undefined) {
      const source = record.source;
      exact(source, ['type', 'id'], ['quantity'], '目标资料引用');
      if (
        !['guide', 'quest', 'database', 'planner'].includes(source.type) ||
        typeof source.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,120}$/.test(source.id)
      )
        throw Error('目标资料引用无效');
      if (source.type === 'database' && !/^(item|skill|npc|fusion|alchemy|cooking)-\d{1,9}$/.test(source.id))
        throw Error('待办图鉴引用无效');
      if (
        source.quantity !== undefined &&
        (source.type !== 'database' ||
          !Number.isSafeInteger(source.quantity) ||
          source.quantity < 1 ||
          source.quantity > 999)
      )
        throw Error('待办制作次数无效');
    }
    return;
  }
  const state = emptyJourneyState();
  state[kinds[kind][0]].push(record);
  validateJourneyState(state);
}
function validateJourneyTrash(rows) {
  // Validate descriptors before reading them; never invoke getters or toJSON.
  intentFingerprint(rows);
  if (!Array.isArray(rows) || rows.length > MAX_TRASH)
    throw Error('已删除安排最多保留 5000 条，请先恢复或确认永久清除部分安排');
  const seen = new Set();
  for (const row of rows) {
    exact(row, ['id', 'kind', 'record', 'deletedAt']);
    id(row.id);
    if (seen.has(row.id)) throw Error('已删除安排含重复 ID');
    seen.add(row.id);
    validateISOTime(row.deletedAt, '移除时间');
    validateRecord(row.kind, row.record);
  }
  return rows;
}
function same(left, right) {
  return intentFingerprint(left) === intentFingerprint(right);
}

function applyJourneyTrashCommand(profile, command, options = {}) {
  // The whole profile must be JSON, but unrelated profile fields belong to Store.
  intentFingerprint(profile);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('周目格式无效');
  intentFingerprint(command);
  const journey = profile.journey === undefined ? emptyJourneyState() : profile.journey;
  const trash = profile.journeyTrash === undefined ? [] : profile.journeyTrash;
  validateJourneyState(journey);
  validateJourneyTrash(trash);
  const next = clone(journey),
    nextTrash = clone(trash);
  let nextGoals, nextCraftPlans;
  if (['journey-trash-restore', 'journey-trash-purge', 'journey-trash-copy-goal'].includes(command?.type)) {
    exact(command, ['type', 'id', 'expectedTrash'], [], '已删除安排命令');
    id(command.id);
    validateJourneyTrash([command.expectedTrash]);
    const at = trash.findIndex((row) => row.id === command.id);
    if (at < 0 || !same(trash[at], command.expectedTrash))
      throw Error('所选已删除安排已变化，请重新核对；当前资料已保留');
    const row = trash[at],
      [list, key] = kinds[row.kind];
    if (command.type === 'journey-trash-copy-goal') {
      if (row.kind !== 'goal') throw Error('只能把已移除的行囊目标另存为独立目标');
      if (!Array.isArray(profile.goals) || profile.goals.length >= 300)
        throw Error('当前目标数量已满，原完整目标仍保留');
      const goalId = options.id === undefined ? randomUUID() : options.id();
      if (
        typeof goalId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(goalId) ||
        profile.goals.some((g) => g.id === goalId) ||
        trash.some((r) => r.kind === 'goal' && r.record.id === goalId)
      )
        throw Error('新目标编号无效或已存在，原完整目标仍保留');
      const createdAt =
        typeof options.now === 'function'
          ? options.now()
          : options.now === undefined
            ? new Date().toISOString()
            : options.now;
      validateISOTime(createdAt, '目标创建时间');
      const record = {
        id: goalId,
        title: row.record.title,
        detail: row.record.detail,
        done: row.record.done,
        createdAt,
        ...(row.record.pinned === undefined ? {} : { pinned: row.record.pinned }),
      };
      validateRecord('goal', record);
      return { journey: next, trash: nextTrash, goals: [...clone(profile.goals), record] };
    }
    if (command.type === 'journey-trash-restore') {
      const current =
        row.kind === 'goal'
          ? profile.goals
          : row.kind === 'craft-plan'
            ? profile.craftPlans || []
            : journey[list];
      if (!Array.isArray(current)) throw Error('当前目标无效，已移除安排仍保留');
      if (row.kind === 'craft-plan') validateCraftPlans(current);
      if (current.some((record) => record[key] === row.record[key]))
        throw Error('同一安排已存在，无法覆盖；已删除安排仍保留');
      if (current.length >= (row.kind === 'goal' ? 300 : row.kind === 'craft-plan' ? 40 : MAX[list]))
        throw Error('当前安排数量已满，暂时无法恢复；已删除安排仍保留');
      if (row.kind === 'goal') nextGoals = [...clone(current), clone(row.record)];
      else if (row.kind === 'craft-plan') {
        nextCraftPlans = [...clone(current), clone(row.record)];
        validateCraftPlans(nextCraftPlans);
      } else {
        next[list].push(clone(row.record));
        validateJourneyState(next);
      }
    }
    nextTrash.splice(at, 1);
  } else {
    const removeKinds = {
      'journey-place-remove': 'place',
      'journey-todo-remove': 'todo',
      'journey-gift-remove': 'gift',
      'goal-remove': 'goal',
      'craft-plan-remove': 'craft-plan',
    };
    if (typeof command?.type !== 'string' || !Object.hasOwn(removeKinds, command.type))
      throw Error('未知个人安排移除命令');
    const kind = removeKinds[command.type];
    const [list, key] = kinds[kind];
    exact(command, ['type', key], ['expectedRecord'], '个人安排移除命令');
    const { expectedRecord, ...remove } = command;
    // Keep the existing ID checks and legacy missing-object no-op behavior.
    if (
      ['goal', 'craft-plan'].includes(kind) &&
      (typeof command.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(command.id))
    )
      throw Error('待办编号无效');
    const removedJourney = ['goal', 'craft-plan'].includes(kind)
      ? next
      : applyJourneyCommand(journey, remove);
    const records =
      kind === 'goal' ? profile.goals : kind === 'craft-plan' ? profile.craftPlans || [] : journey[list];
    if (!Array.isArray(records)) throw Error('当前目标无效，已移除安排仍保留');
    if (kind === 'craft-plan') validateCraftPlans(records);
    const record = records.find((row) => row[key] === command[key]);
    if (Object.hasOwn(command, 'expectedRecord')) {
      validateRecord(kind, expectedRecord);
      if (!record || !same(record, expectedRecord))
        throw Error('所选个人安排已变化，请重新核对；当前资料已保留');
    }
    if (!record) return { journey: next, trash: nextTrash };
    validateRecord(kind, record);
    if (trash.length >= MAX_TRASH)
      throw Error('已删除安排已满，当前安排仍保留；请先恢复或确认永久清除部分安排');
    const deletedAt =
      typeof options.now === 'function'
        ? options.now()
        : options.now === undefined
          ? new Date().toISOString()
          : options.now;
    validateISOTime(deletedAt, '移除时间');
    const trashId = options.id === undefined ? randomUUID() : options.id();
    id(trashId);
    if (trash.some((row) => row.id === trashId)) throw Error('已删除安排 ID 已存在，当前安排仍保留');
    nextTrash.push({ id: trashId, kind, record: clone(record), deletedAt });
    return {
      journey: removedJourney,
      trash: nextTrash,
      ...(kind === 'goal' ? { goals: clone(records.filter((row) => row.id !== command.id)) } : {}),
      ...(kind === 'craft-plan' ? { craftPlans: clone(records.filter((row) => row.id !== command.id)) } : {}),
    };
  }
  return {
    journey: next,
    trash: nextTrash,
    ...(nextGoals ? { goals: nextGoals } : {}),
    ...(nextCraftPlans ? { craftPlans: nextCraftPlans } : {}),
  };
}

module.exports = { validateJourneyTrash, applyJourneyTrashCommand };
