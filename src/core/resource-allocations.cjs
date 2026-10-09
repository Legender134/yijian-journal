'use strict';
const { validateReservations } = require('./reservations.cjs');
const { selectedReference } = require('./goal-progress.cjs');
const world = require('../data/world-index.json');
const quests = new Map(world.quests.map((q) => [q.id, q]));
function validateAllocations(allocations = [], manual = {}) {
  validateReservations(manual);
  if (!Array.isArray(allocations) || allocations.length > 100) throw Error('最多为 100 项任务预留物资');
  const seen = new Set(),
    totals = { ...manual };
  for (const a of allocations) {
    if (
      !a ||
      typeof a !== 'object' ||
      Array.isArray(a) ||
      Object.keys(a).some((k) => !['questId', 'items'].includes(k)) ||
      !quests.has(a.questId) ||
      seen.has(a.questId)
    )
      throw Error('任务预留归属无效');
    seen.add(a.questId);
    validateReservations(a.items);
    if (!Object.keys(a.items).length) throw Error('任务预留物品不能为空');
    for (const [id, count] of Object.entries(a.items)) totals[id] = (totals[id] || 0) + count;
  }
  validateReservations(totals);
  return allocations;
}
function allocationSummary(profile, reference, error = '') {
  reference = selectedReference(profile, reference, error);
  const records = Array.isArray(reference?.metadata?.quests) ? reference.metadata.quests : null;
  const byId = new Map((records || []).map((q) => [q.id, q]));
  const totals = { ...(profile.reservations || {}) };
  const owners = (profile.allocations || []).map((a) => {
    const quest = quests.get(a.questId),
      record = byId.get(quest.gameId);
    const complete = record?.step === 4;
    if (!complete) for (const [id, count] of Object.entries(a.items)) totals[id] = (totals[id] || 0) + count;
    return {
      ...a,
      name: quest.name,
      complete,
      status: complete ? '任务已完成 · 当前不扣除' : !record ? '任务进度待核对 · 继续保留' : '为此任务保留',
      source: records
        ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt }
        : null,
    };
  });
  validateReservations(totals);
  return { totals, manual: profile.reservations || {}, owners };
}
module.exports = { validateAllocations, allocationSummary };
