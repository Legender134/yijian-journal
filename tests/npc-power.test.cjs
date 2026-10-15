'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { currentNpcPower } = require('../src/core/npc-power.cjs');
const attributes = (health) => ({ 9: 0, 10: 0, 14: 0, 11: 0, 12: 0, 2: health, 4: 0 });
test('float32 power boundaries and inclusive, zero-based title levels', () => {
  // Independent float32 reference vectors from static native SSE/config audit.
  for (const [health, power, level] of [
    [695.7142333984375, 486.9999694824219, 0],
    [695.7142944335938, 487, 1],
    [695.71435546875, 487.0000305175781, 1],
    [0, 0, 0],
  ]) {
    const result = currentNpcPower(attributes(health));
    assert.equal(result.value, power);
    assert.equal(result.level, level);
  }
  assert.equal(currentNpcPower(attributes(695.7142944335938)).title, '初窥门径');
  const missing = attributes(1000);
  delete missing[14];
  assert.equal(currentNpcPower(missing), null);
  assert.equal(currentNpcPower({ ...attributes(1000), 9: Infinity }), null);
  assert.equal(currentNpcPower({ ...attributes(1000), 9: -1 }), null);
});
