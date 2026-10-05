'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { selectAutomatic, MAX_AUTOMATIC, TOLERANCES } = require('../src/core/timeline-retention.cjs');
test('bounded automatic sampling supplies precise targets throughout 24 hours with varying save latency', () => {
  for (const offset of [0, 7346, 42991]) {
    let records = [],
      at = Date.UTC(2026, 9, 1) + offset,
      first = at;
    for (let i = 0; at - first < 86400000; i++) {
      const all = [...records, { id: String(i), at }],
        ids = selectAutomatic(all, at);
      records = all.filter((r) => ids.has(r.id));
      assert.ok(records.length <= MAX_AUTOMATIC);
      if (at - first > 4500000)
        for (const [age, tolerance] of Object.entries(TOLERANCES)) {
          const target = at - Number(age) * 1000,
            r = [...records].reverse().find((r) => r.at <= target);
          assert.ok(r, age);
          assert.ok((target - r.at) / 1000 <= tolerance, age + ': ' + (target - r.at) / 1000);
        }
      at += 10000 + ((i * 173) % 2001);
    }
  }
});
