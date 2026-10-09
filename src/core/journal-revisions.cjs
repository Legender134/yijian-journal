'use strict';
// Full manual-record versions. No game operations or replay of system events.
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { MAX_ENTRIES, validateEntries, validateISOTime, detachLinks } = require('./event-journal.cjs');
const MAX_REVISIONS = 5000;
const MAX_REVISION_BYTES = 8 * 1024 * 1024;
const clone = (value) => structuredClone(value);
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw Error('记录旧版本包含未知字段或格式无效');
}
function validateRevisions(rows, context) {
  if (!Array.isArray(rows) || rows.length > MAX_REVISIONS)
    throw Error('记录旧版本最多保留 5000 份；请明确永久清除部分旧版本后再编辑');
  const seen = new Set();
  for (const row of rows) {
    exact(row, ['id', 'entry', 'replacedAt']);
    if (!validId(row.id) || seen.has(row.id)) throw Error('记录旧版本 ID 无效或重复');
    seen.add(row.id);
    if (!validId(row.entry?.id)) throw Error('旧版本原记录 ID 无效');
    if (![Object.prototype, null].includes(Object.getPrototypeOf(row.entry)))
      throw Error('旧版本原记录格式无效');
    if (row.entry.kind !== 'manual') throw Error('系统事件不能成为可恢复的手写旧版本');
    validateISOTime(row.replacedAt, '版本保留时间');
    if (Date.parse(row.replacedAt) <= Date.parse(row.entry.updatedAt))
      throw Error('版本保留时间须晚于原记录更新时间');
  }
  // Versions can share a source record ID. Use their already-checked unique
  // version IDs only for the batch validator's uniqueness check.
  validateEntries(
    rows.map((row) => ({ ...row.entry, id: row.id })),
    context,
  );
  if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > MAX_REVISION_BYTES)
    throw Error('记录旧版本容量最多 8 MiB；请明确永久清除部分旧版本后再编辑');
  return rows;
}
function retainEditedRevisions(before, after, rows, context, options = {}) {
  validateRevisions(rows, context);
  const next = clone(rows),
    oldById = new Map(before.map((entry) => [entry.id, entry]));
  for (const entry of after) {
    const previous = oldById.get(entry.id);
    // Saving unchanged content still advances updatedAt for concurrent editors,
    // but that timestamp-only write must not consume historical capacity.
    if (!previous || isDeepStrictEqual({ ...previous, updatedAt: entry.updatedAt }, entry)) continue;
    if (previous.kind !== 'manual' || entry.kind !== 'manual') throw Error('系统事件不能编辑');
    const id = typeof options.id === 'function' ? options.id() : (options.id ?? randomUUID());
    next.push({ id, entry: clone(previous), replacedAt: entry.updatedAt });
  }
  try {
    validateRevisions(next, context);
  } catch (error) {
    throw Error(error.message + '；原记录与草稿仍保留');
  }
  return next;
}
function assertFreshEntryIds(before, after, rows, trash = []) {
  const existing = new Set(before.map((entry) => entry.id));
  const reserved = new Set([...rows.map((row) => row.entry.id), ...trash.map((row) => row.entry.id)]);
  if (after.some((entry) => !existing.has(entry.id) && reserved.has(entry.id)))
    throw Error('新记录编号与已保留历史冲突；原记录、旧版本与草稿仍保留');
}
function applyRevisionCommand(entries, rows, command, context, options = {}) {
  exact(command, ['type', 'id', 'expectedRevision', 'expectedEntry']);
  if (!['journal-revision-restore', 'journal-revision-purge'].includes(command.type))
    throw Error('未知记录旧版本操作');
  validateEntries(entries, context);
  validateRevisions(rows, context);
  if (!validId(command.id)) throw Error('记录旧版本 ID 无效');
  const row = rows.find((item) => item.id === command.id);
  if (!row || !isDeepStrictEqual(row, command.expectedRevision))
    throw Error('旧版本已变化或尚未核对，请重新打开；当前记录与旧版本已保留');
  validateRevisions([command.expectedRevision], context);
  const original = entries.find((entry) => entry.id === row.entry.id) || null;
  if (!isDeepStrictEqual(original, command.expectedEntry))
    throw Error('原记录已变化，请重新核对；当前记录与旧版本已保留');
  if (original && original.createdAt !== row.entry.createdAt)
    throw Error('原记录编号已被另一条记录使用，请重新核对；旧版本仍保留');
  if (command.type === 'journal-revision-purge')
    return { entries: clone(entries), revisions: rows.filter((item) => item.id !== row.id).map(clone) };
  if (entries.length >= MAX_ENTRIES) throw Error('正式记录最多 5000 条；原记录与旧版本仍保留');
  const id = typeof options.id === 'function' ? options.id() : (options.id ?? randomUUID());
  if (
    !validId(id) ||
    entries.some((entry) => entry.id === id) ||
    rows.some((item) => item.entry.id === id) ||
    context.profile.journalTrash?.some((item) => item.entry.id === id)
  )
    throw Error('新记录编号冲突；原记录与旧版本仍保留');
  const raw = typeof options.now === 'function' ? options.now() : (options.now ?? new Date().toISOString());
  validateISOTime(raw, '恢复时间');
  const stamp = new Date(Math.max(Date.parse(raw), Date.parse(row.replacedAt) + 1)).toISOString();
  const restored = { ...clone(row.entry), id, kind: 'manual', createdAt: stamp, updatedAt: stamp };
  const next = [...clone(entries), restored];
  validateEntries(next, context);
  return { entries: next, revisions: clone(rows), restoredId: id };
}
function detachRevisionLinks(rows, type, id) {
  return rows.map((row) => ({ ...clone(row), entry: detachLinks([row.entry], type, id)[0] }));
}
module.exports = {
  MAX_REVISIONS,
  MAX_REVISION_BYTES,
  validateRevisions,
  retainEditedRevisions,
  assertFreshEntryIds,
  applyRevisionCommand,
  detachRevisionLinks,
};
