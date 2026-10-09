'use strict';
const { randomUUID } = require('node:crypto');
const { validateISOTime } = require('./event-journal.cjs');
const MAX_NOTE_REVISIONS = 20;
function validateNoteRevisions(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_NOTE_REVISIONS) throw Error('随手记旧内容格式无效');
  const ids = new Set();
  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
      Reflect.ownKeys(row).some((key) => !['id', 'body', 'replacedAt'].includes(key)) ||
      typeof row.id !== 'string' ||
      !/^[A-Za-z0-9-]{1,80}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row.body !== 'string' ||
      !row.body.trim() ||
      row.body.length > 20000
    )
      throw Error('随手记旧内容格式无效');
    ids.add(row.id);
    validateISOTime(row.replacedAt, '随手记保留时间');
  }
  return rows;
}
function retainNote(previous, next, rows = [], { force = false, now = new Date().toISOString() } = {}) {
  validateNoteRevisions(rows);
  if (previous === next || !previous.trim()) return structuredClone(rows);
  validateISOTime(now, '随手记保留时间');
  const elapsed = rows.length ? Date.parse(now) - Date.parse(rows[0].replacedAt) : Infinity;
  // Continuous automatic saves must not evict a cleared note after a few
  // keystrokes. Clearing and explicit restore always preserve the current text.
  if (!force && next.trim() && elapsed >= 0 && elapsed < 5 * 60 * 1000) return structuredClone(rows);
  const result = [
    { id: randomUUID(), body: previous, replacedAt: now },
    ...rows.filter((row) => row.body !== previous),
  ].slice(0, MAX_NOTE_REVISIONS);
  return validateNoteRevisions(result);
}
module.exports = { MAX_NOTE_REVISIONS, validateNoteRevisions, retainNote };
