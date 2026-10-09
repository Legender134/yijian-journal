'use strict';
const data = require('../data/game-index.json');

// Shared display facts for recipe discovery and processing steps. These
// conditional results never allocate stock or change a recipe's minimum yield.
function recipeOutputs(recipe, quantity, entries = data.entries) {
  const stable =
    recipe.results.length &&
    recipe.results.every(
      (r) => r.id === recipe.results[0].id && Number.isSafeInteger(r.count) && r.count > 0,
    );
  const total = (count) => {
    const value = count * quantity;
    if (!Number.isSafeInteger(value) || value < 0) throw Error('加工数量超出可计算范围');
    return value;
  };
  return [...new Set(recipe.results.map((r) => r.id))].map((id) => {
    const results = recipe.results.filter((r) => r.id === id);
    const item = entries.find((e) => e.id === `item-${id}` && e.kind === '物品');
    const counts = results.map((r) => r.count);
    const valid = counts.every((count) => Number.isSafeInteger(count) && count > 0);
    return {
      id,
      name: item?.name || results[0].name || `物品 #${id}`,
      quality: item?.quality || '',
      minimumCount: valid ? total(Math.min(...counts)) : null,
      maximumCount: valid ? total(Math.max(...counts)) : null,
      weights: results
        .map((r) => r.weight)
        .filter((weight) => typeof weight === 'number' && Number.isFinite(weight)),
      guaranteedItem: !!stable,
    };
  });
}
module.exports = { recipeOutputs };
