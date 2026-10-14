'use strict';
const contract = require('../data/npc-power.json');
// Only complete current attributes from one accepted live cohort are eligible.
// Saving base attributes and cached TeamInfo power are not equivalent inputs.
function currentNpcPower(attributes) {
  let power = 0;
  for (const w of contract.weights) {
    const value = attributes?.[w.id];
    if (!Number.isFinite(value) || value < 0 || value > 10000000) return null;
    power = Math.fround(power + Math.fround(Math.fround(value) * w.value));
  }
  let level = 0;
  for (let i = contract.titles.length - 1; i >= 0; i--) {
    if (power >= contract.titles[i].minimum) {
      level = i;
      break;
    }
  }
  return { value: power, level, title: contract.titles[level].name };
}
module.exports = { currentNpcPower };
