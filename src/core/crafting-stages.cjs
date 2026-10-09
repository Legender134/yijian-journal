'use strict';
const { validateCraftList, allocate } = require('./material-plan.cjs');
const { availableInventory } = require('./reservations.cjs');
const data = require('../data/game-index.json');
const keyOf = (ids) => [...new Set(ids)].sort((a, b) => a - b).join(',');
const add = (a, b) => {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0) throw Error('加工数量超出可计算范围');
  return result;
};
function validateCraftChoices(choices = {}, recipeData = data.entries) {
  if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 100)
    throw Error('加工配方选择无效');
  for (const [id, recipeId] of Object.entries(choices)) {
    const recipe = recipeData.find((e) => e.id === recipeId && e.kind === '配方');
    if (
      !/^\d{1,9}$/.test(id) ||
      !recipe?.results.length ||
      !recipe.results.every((r) => r.id === Number(id) && Number.isSafeInteger(r.count) && r.count > 0)
    )
      throw Error('加工配方不能稳定产出对应物品');
  }
  return choices;
}
function craftingStages(
  list,
  metadata = null,
  reservations = {},
  choices = {},
  recipeData = data.entries,
  { aggregate = false, directMaterials = null } = {},
) {
  validateCraftList(list, aggregate ? { maxRecipes: 340, maxQuantity: 300000 } : undefined);
  validateCraftChoices(choices, recipeData);
  const recipes = recipeData.filter((e) => e.kind === '配方'),
    byId = new Map(recipes.map((r) => [r.id, r]));
  const producers = new Map();
  for (const recipe of recipes)
    for (const id of new Set(recipe.results.map((r) => r.id))) {
      const allSame =
        recipe.results.length &&
        recipe.results.every((r) => r.id === id && Number.isSafeInteger(r.count) && r.count > 0);
      if (!allSame) continue;
      if (!producers.has(id)) producers.set(id, []);
      producers.get(id).push({ recipe, yield: Math.min(...recipe.results.map((r) => r.count)) });
    }
  const known = Array.isArray(metadata?.inventory),
    physical = new Map(),
    planned = new Map();
  for (const item of availableInventory(metadata?.inventory, reservations) || []) {
    if (!Number.isSafeInteger(item.id) || item.id < 0 || !Number.isSafeInteger(item.count) || item.count < 0)
      throw Error('库存记录无效');
    physical.set(item.id, add(physical.get(item.id) || 0, item.count));
  }
  const stages = [],
    raw = new Map(),
    decisions = [],
    warnings = [],
    plannedOutputs = [];
  const physicalUsed = {},
    directPhysicalUsed = {},
    processingPhysicalUsed = {},
    plannedUsed = {};
  const maxCalls = 2000 * Math.max(1, Math.ceil(list.length / 40));
  let calls = 0,
    cost = 0,
    processingCost = 0,
    moneyKnown = true,
    unresolvedAlternatives = 0;
  const used = (totals, id, count) => {
    if (count) totals[id] = add(totals[id] || 0, count);
  };
  function stock() {
    const all = new Map(physical);
    for (const [id, batches] of planned)
      all.set(
        id,
        add(
          all.get(id) || 0,
          batches.reduce((n, b) => add(n, b.count), 0),
        ),
      );
    return all;
  }
  function consume(id, count, final) {
    const sources = [],
      fromInventory = Math.min(physical.get(id) || 0, count);
    physical.set(id, (physical.get(id) || 0) - fromInventory);
    if (fromInventory) {
      used(physicalUsed, id, fromInventory);
      used(final ? directPhysicalUsed : processingPhysicalUsed, id, fromInventory);
      sources.push({ id, count: fromInventory, source: 'inventory' });
    }
    let rest = count - fromInventory;
    for (const batch of planned.get(id) || []) {
      const taken = Math.min(batch.count, rest);
      batch.count -= taken;
      rest -= taken;
      if (taken) {
        used(plannedUsed, id, taken);
        sources.push({
          id,
          count: taken,
          source: 'planned-output',
          recipeId: batch.recipeId,
          conditional: true,
        });
      }
      if (!rest) break;
    }
    if (rest) throw Error('加工分配超过可用材料');
    return sources;
  }
  function addRaw(item, count, reason, path) {
    const current = raw.get(item.id) || { id: item.id, name: item.name, count: 0, sources: [] };
    current.count = add(current.count, count);
    current.sources.push({ count, reason, recipeId: path[path.length - 1] });
    raw.set(item.id, current);
  }
  function needed(item, count, path, final) {
    if (++calls > maxCalls || path.length > 20) throw Error('制作依赖过多，请拆分计划');
    const available = Math.min(stock().get(item.id) || 0, count);
    const sources = consume(item.id, available, final),
      missing = count - available;
    if (!missing) return { sources, missing: 0 };
    let options = producers.get(item.id) || [];
    const chosen = choices[String(item.id)];
    if (chosen) options = options.filter((o) => o.recipe.id === chosen);
    if (options.length > 1)
      decisions.push({
        itemId: item.id,
        name: item.name,
        count: missing,
        recipes: options.map((o) => ({ id: o.recipe.id, name: o.recipe.name, minimumYield: o.yield })),
      });
    const producer = options.length === 1 ? options[0] : null;
    if (producer && !path.includes(producer.recipe.id)) {
      const quantity = Math.ceil(missing / producer.yield);
      makeMany([{ recipe: producer.recipe, quantity, path: [...path, producer.recipe.id], final: false }]);
      if (!planned.has(item.id)) planned.set(item.id, []);
      planned.get(item.id).push({ recipeId: producer.recipe.id, count: add(0, quantity * producer.yield) });
      sources.push(...consume(item.id, missing, final));
      return { sources, missing: 0 };
    }
    const reason = producer
      ? 'cycle'
      : options.length > 1
        ? 'producer-choice-required'
        : 'no-guaranteed-producer';
    if (producer) warnings.push({ itemId: item.id, message: '加工资料形成循环，停止展开并保留缺口' });
    addRaw(item, missing, reason, path);
    return { sources, missing };
  }
  function fixedDirect(demands) {
    const groups = new Map();
    for (const group of directMaterials) {
      const key = keyOf(group.ids);
      if (groups.has(key)) throw Error('直接材料分配重复');
      groups.set(key, {
        count: group.count,
        used: 0,
        items: group.allocation.map((a) => ({ id: a.id, count: a.count })),
      });
    }
    const assigned = demands.map((demand) => {
      const group = groups.get(keyOf(demand.ids));
      if (!group) throw Error('直接材料分配与配方不匹配');
      group.used = add(group.used, demand.count);
      let rest = demand.count;
      const items = [];
      for (const item of group.items) {
        if (!demand.ids.includes(item.id) || !Number.isSafeInteger(item.count) || item.count < 0)
          throw Error('直接材料分配无效');
        const count = Math.min(rest, item.count);
        if (count) items.push({ id: item.id, count });
        item.count -= count;
        rest -= count;
      }
      return items;
    });
    if ([...groups.values()].some((g) => g.used !== g.count || g.items.some((i) => i.count)))
      throw Error('直接材料分配与配方不匹配');
    return assigned;
  }
  function makeMany(jobs) {
    const demands = jobs.flatMap((job) =>
      job.recipe.materials.map((material) => ({
        job,
        material,
        ids: [...new Set(material.alternatives || [material.id])],
        count: add(0, material.count * job.quantity),
      })),
    );
    const assigned =
      jobs.every((j) => j.final) && directMaterials !== null
        ? fixedDirect(demands)
        : allocate(demands, stock());
    // Reserve every ingredient together before expansion. This preserves the
    // residual-path allocation of flexible ingredients against fixed demands.
    const requirements = demands.map((demand, i) => ({
      name: demand.material.name,
      ids: demand.ids,
      count: demand.count,
      sources: assigned[i].flatMap((item) => consume(item.id, item.count, demand.job.final)),
      missing: demand.count - assigned[i].reduce((sum, item) => add(sum, item.count), 0),
    }));
    for (const job of jobs) {
      const materials = [];
      demands.forEach((demand, i) => {
        if (demand.job !== job) return;
        const requirement = requirements[i];
        if (requirement.missing) {
          if (demand.material.alternatives?.length) {
            // No producer is selected for an unresolved alternative group.
            decisions.push({
              name: demand.material.name,
              count: requirement.missing,
              alternatives: demand.ids,
            });
            unresolvedAlternatives = add(unresolvedAlternatives, requirement.missing);
          } else {
            const expanded = needed(demand.material, requirement.missing, job.path, job.final);
            requirement.sources.push(...expanded.sources);
            requirement.missing = expanded.missing;
          }
        }
        materials.push(requirement);
      });
      recordStage(job, materials);
    }
  }
  function recordStage({ recipe, quantity, final }, materials) {
    const learned =
      metadata?.[
        { fusion: 'fusionRecipes', alchemy: 'alchemyRecipes', cooking: 'cookingRecipes' }[recipe.recipeType]
      ];
    const stable =
      recipe.results.length &&
      recipe.results.every(
        (r) => r.id === recipe.results[0].id && Number.isSafeInteger(r.count) && r.count > 0,
      );
    const minimumYield = stable ? Math.min(...recipe.results.map((r) => r.count)) : null;
    const money =
      Number.isSafeInteger(recipe.money) && recipe.money >= 0 ? add(0, recipe.money * quantity) : null;
    stages.push({
      id: recipe.id,
      name: recipe.name,
      // Recipe / learning item identity is distinct from the result item.
      // These are display facts only; conservative budget quantities below
      // still use the same minimum yield and never add physical inventory.
      outputs: [...new Set(recipe.results.map((r) => r.id))].map((id) => {
        const results = recipe.results.filter((r) => r.id === id);
        const item = recipeData.find((e) => e.id === `item-${id}` && e.kind === '物品');
        const counts = results.map((r) => r.count);
        const valid = counts.every((count) => Number.isSafeInteger(count) && count > 0);
        return {
          id,
          name: item?.name || results[0].name || `物品 #${id}`,
          quality: item?.quality || '',
          minimumCount: valid ? add(0, Math.min(...counts) * quantity) : null,
          maximumCount: valid ? add(0, Math.max(...counts) * quantity) : null,
          weights: results
            .map((r) => r.weight)
            .filter((weight) => typeof weight === 'number' && Number.isFinite(weight)),
          guaranteedItem: !!stable,
        };
      }),
      learningItems: [...(recipe.learningItems || [])],
      quantity,
      final,
      materials: materials.map((m) => ({
        ...m,
        planningMissing: m.missing,
        missing: known ? m.missing : null,
      })),
      level: recipe.level,
      craft: recipe.craft || recipe.type,
      learned: Array.isArray(learned) ? learned.includes(recipe.gameId) : null,
      minimumYield,
      money,
      levelConfirmed: false,
      materialsAvailableNow: known
        ? materials.every(
            (m) =>
              m.sources.filter((s) => s.source === 'inventory').reduce((sum, s) => add(sum, s.count), 0) ===
              m.count,
          )
        : null,
    });
    plannedOutputs.push({
      recipeId: recipe.id,
      final,
      itemId: stable ? recipe.results[0].id : null,
      count: stable ? add(0, minimumYield * quantity) : null,
      conditional: true,
      guaranteedItem: !!stable,
    });
    if (money === null) moneyKnown = false;
    else {
      cost = add(cost, money);
      if (!final) processingCost = add(processingCost, money);
    }
  }
  const jobs = list.map((line) => {
    const recipe = byId.get(line.id);
    if (!recipe) throw Error('制作配方资料不存在');
    return { recipe, quantity: line.quantity, path: [recipe.id], final: true };
  });
  makeMany(jobs);
  const rawMaterials = [...raw.values()].map((m) => ({ ...m, missing: known ? m.count : null }));
  const rawMissingTotal = known
    ? rawMaterials.reduce((sum, m) => add(sum, m.count), unresolvedAlternatives)
    : null;
  const copper = Number.isSafeInteger(metadata?.money) && metadata.money >= 0 ? metadata.money : null;
  return {
    inventoryAvailable: known,
    stages,
    rawMaterials,
    decisions,
    warnings,
    physicalUsed,
    directPhysicalUsed,
    processingPhysicalUsed,
    plannedUsed,
    plannedOutputs,
    physicalRemaining: [...physical].map(([id, count]) => ({ id, count })),
    plannedSurplus: [...planned].flatMap(([id, batches]) =>
      batches
        .filter((b) => b.count)
        .map((b) => ({ id, count: b.count, recipeId: b.recipeId, conditional: true })),
    ),
    rawMissingTotal,
    hasAllBaseIngredients: known ? rawMissingTotal === 0 : null,
    workRemaining: {
      final: stages.filter((s) => s.final).reduce((n, s) => add(n, s.quantity), 0),
      processing: stages.filter((s) => !s.final).reduce((n, s) => add(n, s.quantity), 0),
    },
    money: moneyKnown ? cost : null,
    processingMoney: moneyKnown ? processingCost : null,
    moneyComplete: moneyKnown && !decisions.length && !warnings.length,
    copper,
    copperMissing: copper === null || !moneyKnown ? null : Math.max(0, cost - copper),
    reference: metadata ? { dataBuild: metadata.dataBuild } : null,
    notice:
      '按配方最小产量安排加工，不计入随机额外产出。计划产物还不是背包库存；制作等级与配方须在游戏内确认。',
  };
}
module.exports = { craftingStages, validateCraftChoices };
