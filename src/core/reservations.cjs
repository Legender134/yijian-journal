'use strict';
const entries = require('../data/game-index.json').entries;
const items = new Set(entries.filter((e) => e.kind === '物品').map((e) => String(e.gameId)));
function validateReservations(value = {}, maximum = 999999) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 300)
    throw Error('保留材料清单无效');
  for (const [id, count] of Object.entries(value))
    if (!items.has(id) || !Number.isSafeInteger(count) || count < 1 || count > maximum)
      throw Error('保留材料须为已知物品及 1 至 999999 的整数');
  return value;
}
function availableInventory(inventory, reservations = {}) {
  validateReservations(reservations, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(inventory)) return inventory;
  const remaining = new Map(Object.entries(reservations).map(([id, count]) => [Number(id), count]));
  return inventory.map((i) => {
    const reserved = Math.min(i.count, remaining.get(i.id) || 0);
    remaining.set(i.id, (remaining.get(i.id) || 0) - reserved);
    return { ...i, count: Math.max(0, i.count - reserved) };
  });
}
module.exports = { validateReservations, availableInventory };
