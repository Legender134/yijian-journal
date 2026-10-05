'use strict';
// Nested, wall-clock-aligned sampling grids keep promotion candidates without
// retaining every ten-second save. The age tiers overlap each requested target.
const TIERS = Object.freeze([
  { until: 70, step: 10 },
  { until: 150, step: 20 },
  { until: 750, step: 60 },
  { until: 1920, step: 120 },
  { until: 4320, step: 240 },
]);
const MAX_AUTOMATIC =
  1 + TIERS.reduce((n, t, i) => n + Math.ceil((t.until - (TIERS[i - 1]?.until || 0)) / t.step) + 1, 0);
const TOLERANCES = Object.freeze({
  10: 15,
  20: 15,
  30: 15,
  40: 15,
  50: 15,
  60: 20,
  120: 45,
  300: 90,
  600: 90,
  1800: 240,
  3600: 300,
});
function selectAutomatic(records, at) {
  const buckets = new Map();
  const sorted = [...records].sort((a, b) => a.at - b.at);
  for (const r of sorted) {
    const age = Math.max(0, (at - r.at) / 1000),
      tier = TIERS.findIndex((t) => age <= t.until);
    if (tier < 0) continue;
    const key = tier + ':' + Math.floor(r.at / (TIERS[tier].step * 1000));
    if (!buckets.has(key)) buckets.set(key, r.id);
  }
  const ids = new Set(buckets.values());
  if (sorted.length) ids.add(sorted.at(-1).id);
  return ids;
}
module.exports = { TIERS, MAX_AUTOMATIC, TOLERANCES, selectAutomatic };
