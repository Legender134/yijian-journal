'use strict';
// Recoverable local history only. Restore never changes goals, inventories or game saves.
const {
  MAX_ENTRIES,
  validateEntries,
  applyEntryCommand,
  detachLinks,
  validateISOTime,
} = require('./event-journal.cjs');
const MAX_TRASH = 5000;
const clone = (value) => structuredClone(value);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw Error('已删除记录包含未知字段或格式无效');
}
function validateTrash(rows, context, entries = []) {
  if (!Array.isArray(rows) || rows.length > MAX_TRASH)
    throw Error('已删除记录最多保留 5000 条，请先恢复或确认永久清除部分记录');
  for (const row of rows) {
    exact(row, ['entry', 'deletedAt']);
    validateISOTime(row.deletedAt, '移除时间');
    if (Date.parse(row.deletedAt) < Date.parse(row.entry?.updatedAt)) throw Error('移除时间早于记录修订时间');
  }
  validateEntries(
    rows.map((row) => row.entry),
    context,
  );
  const active = new Set(entries.map((entry) => entry.id));
  if (rows.some((row) => active.has(row.entry.id))) throw Error('记录同时存在于当前记录与已删除记录');
  return rows;
}
function time(options, minimum) {
  const raw = typeof options.now === 'function' ? options.now() : (options.now ?? new Date().toISOString());
  validateISOTime(raw);
  return new Date(Math.max(Date.parse(raw), minimum + 1)).toISOString();
}
function moveEntriesToTrash(entries, trash, command, context, options = {}) {
  if (!['journal-entry-remove', 'journal-entries-remove'].includes(command?.type))
    throw Error('仅能将明确选中的历史记录移入已删除记录');
  validateTrash(trash, context, entries);
  const next = applyEntryCommand(entries, command, context, options);
  const kept = new Set(next.map((entry) => entry.id)),
    removed = entries.filter((entry) => !kept.has(entry.id));
  if (trash.length + removed.length > MAX_TRASH)
    throw Error('已删除记录已满，当前记录仍保留；请先恢复或确认永久清除部分已删除记录');
  const deletedAt = time(options, Math.max(0, ...removed.map((entry) => Date.parse(entry.updatedAt))));
  const nextTrash = [...clone(trash), ...removed.map((entry) => ({ entry: clone(entry), deletedAt }))];
  validateTrash(nextTrash, context, next);
  return { entries: next, trash: nextTrash };
}
function applyTrashCommand(entries, trash, command, context, options = {}) {
  exact(command, ['type', 'ids', 'expectedEntries']);
  if (!['journal-trash-restore', 'journal-trash-purge'].includes(command.type))
    throw Error('未知已删除记录操作');
  validateEntries(entries, context);
  validateTrash(trash, context, entries);
  const ids = command.ids;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > MAX_TRASH ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
  )
    throw Error('请选择要处理的已删除记录');
  const selected = new Set(ids),
    rows = trash.filter((row) => selected.has(row.entry.id));
  if (rows.length !== ids.length) throw Error('所选已删除记录或周目已变化，请重新核对；当前资料已保留');
  if (!Array.isArray(command.expectedEntries) || command.expectedEntries.length !== rows.length)
    throw Error('请重新核对所选已删除记录后再确认');
  const expected = new Map(command.expectedEntries.map((row) => [row?.entry?.id, row]));
  if (
    expected.size !== rows.length ||
    rows.some((row) => JSON.stringify(row) !== JSON.stringify(expected.get(row.entry.id)))
  )
    throw Error('所选已删除记录已变化，请重新核对；当前资料已保留');
  validateTrash(command.expectedEntries, context);
  let next = clone(entries);
  if (command.type === 'journal-trash-restore') {
    if (entries.length + rows.length > MAX_ENTRIES)
      throw Error('正式记录最多 5000 条，暂时无法恢复；已删除记录仍保留');
    const restoredAt = time(options, Math.max(0, ...rows.map((row) => Date.parse(row.deletedAt))));
    next.push(...rows.map((row) => ({ ...clone(row.entry), updatedAt: restoredAt })));
  }
  const nextTrash = trash.filter((row) => !selected.has(row.entry.id)).map(clone);
  validateEntries(next, context);
  validateTrash(nextTrash, context, next);
  return { entries: next, trash: nextTrash };
}
function detachTrashLinks(trash, type, id) {
  const entries = detachLinks(
    trash.map((row) => row.entry),
    type,
    id,
  );
  return trash.map((row, index) => ({ entry: entries[index], deletedAt: row.deletedAt }));
}
module.exports = { MAX_TRASH, validateTrash, moveEntriesToTrash, applyTrashCommand, detachTrashLinks };
