'use strict';
const data = require('../data/game-index.json');
const entries = new Map(data.entries.map((e) => [e.id, e]));
const MAX_CRAFTS = 40;
const { availableInventory } = require('./reservations.cjs');
const add = (a, b) => {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0) throw Error('备料数量超出可计算范围');
  return value;
};
function validateCraftList(list, { maxRecipes = MAX_CRAFTS, maxQuantity = 999 } = {}) {
  if (!Array.isArray(list) || list.length > maxRecipes) throw Error(`备料清单最多 ${maxRecipes} 种配方`);
  const seen = new Set();
  for (const line of list) {
    if (
      !line ||
      typeof line !== 'object' ||
      Array.isArray(line) ||
      Object.keys(line).some((k) => !['id', 'quantity'].includes(k))
    )
      throw Error('备料清单格式无效');
    if (entries.get(line.id)?.kind !== '配方' || seen.has(line.id)) throw Error('备料清单含未知或重复配方');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQuantity)
      throw Error(`制作次数须为 1 至 ${maxQuantity}`);
    seen.add(line.id);
  }
  return list;
}
function allocate(groups, inventory, { priorities } = {}) {
  if (
    priorities !== undefined &&
    (!Array.isArray(priorities) ||
      priorities.length !== groups.length ||
      priorities.some((rank) => !Number.isSafeInteger(rank) || rank < 0 || rank > 200))
  )
    throw Error('物资分配顺序无效');
  const ids = [...new Set(groups.flatMap((g) => g.ids))]
    .filter((id) => inventory.get(id) > 0)
    .sort((a, b) => a - b);
  const source = 0,
    itemStart = 1,
    groupStart = itemStart + ids.length,
    sink = groupStart + groups.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const edge = (from, to, capacity) => {
    const forward = { to, capacity, initial: capacity, reverse: graph[to].length };
    const backward = { to: from, capacity: 0, initial: 0, reverse: graph[from].length };
    graph[from].push(forward);
    graph[to].push(backward);
    return forward;
  };
  const links = [];
  ids.forEach((id, i) => {
    edge(source, itemStart + i, inventory.get(id));
    groups.forEach((g, j) => {
      if (g.ids.includes(id))
        links.push({
          id,
          group: j,
          edge: edge(itemStart + i, groupStart + j, Math.min(inventory.get(id), g.count)),
        });
    });
  });
  const sinks = groups.map((g, j) => edge(groupStart + j, sink, priorities ? 0 : g.count));
  // Residual paths can move a flexible ingredient away from a fixed demand.
  // Greedy recipe-by-recipe subtraction would incorrectly report shortages.
  const phases = priorities ? [...new Set(priorities)].sort((a, b) => a - b) : [null];
  for (const phase of phases) {
    if (priorities)
      groups.forEach((g, j) => {
        if (priorities[j] === phase) sinks[j].capacity = g.count;
      });
    while (true) {
      const previous = Array(graph.length).fill(null),
        queue = [source];
      previous[source] = { from: -1 };
      for (let i = 0; i < queue.length && !previous[sink]; i++)
        for (const e of graph[queue[i]])
          if (e.capacity > 0 && !previous[e.to]) {
            previous[e.to] = { from: queue[i], edge: e };
            queue.push(e.to);
          }
      if (!previous[sink]) break;
      let amount = Number.MAX_SAFE_INTEGER;
      for (let at = sink; at !== source; at = previous[at].from)
        amount = Math.min(amount, previous[at].edge.capacity);
      for (let at = sink; at !== source; at = previous[at].from) {
        const e = previous[at].edge;
        e.capacity -= amount;
        graph[e.to][e.reverse].capacity = add(graph[e.to][e.reverse].capacity, amount);
      }
    }
    // Keep each earlier owner's granted demand fixed, including any deficit.
    // Item-to-group residual edges remain available: later owners can move a
    // flexible earlier ingredient to another physical item without taking
    // away its grant. This preserves substitution instead of greedy subtraction.
    if (priorities)
      groups.forEach((_g, j) => {
        if (priorities[j] === phase) sinks[j].capacity = 0;
      });
  }
  const allocations = groups.map(() => []);
  for (const link of links) {
    const count = link.edge.initial - link.edge.capacity;
    if (count > 0) {
      const item = entries.get(`item-${link.id}`);
      allocations[link.group].push({
        id: link.id,
        name: item?.name || `物品 #${link.id}`,
        quality: item?.quality || '',
        count,
      });
    }
  }
  return allocations;
}
function materialPlan(list, metadata = null, reservations = {}, { aggregate = false } = {}) {
  validateCraftList(list, aggregate ? { maxRecipes: 340, maxQuantity: 300000 } : undefined);
  const owned = new Map(),
    inventoryAvailable = Array.isArray(metadata?.inventory);
  if (inventoryAvailable) {
    if (metadata.inventory.length > 10000) throw Error('库存记录过多');
    for (const item of metadata.inventory) {
      if (
        !Number.isSafeInteger(item.id) ||
        item.id < 0 ||
        !Number.isSafeInteger(item.count) ||
        item.count < 0 ||
        item.count > 1000000000000
      )
        throw Error('库存记录无效');
      owned.set(item.id, add(owned.get(item.id) || 0, item.count));
    }
    for (const item of availableInventory(
      [...owned].map(([id, count]) => ({ id, count })),
      reservations,
    ))
      owned.set(item.id, item.count);
  }
  const demands = new Map();
  let money = 0;
  const recipes = list.map((line) => {
    const recipe = entries.get(line.id),
      cost = recipe.money * line.quantity;
    money = add(money, cost);
    for (const material of recipe.materials) {
      const ids = [...new Set(material.alternatives || [material.id])].sort((a, b) => a - b),
        key = ids.join(',');
      const needed = material.count * line.quantity;
      const group = demands.get(key) || { key, ids, name: material.name, count: 0, recipes: [] };
      group.count = add(group.count, needed);
      group.recipes.push({ id: recipe.id, name: recipe.name, count: needed });
      demands.set(key, group);
    }
    const learned =
      metadata?.[
        { fusion: 'fusionRecipes', alchemy: 'alchemyRecipes', cooking: 'cookingRecipes' }[recipe.recipeType]
      ];
    return {
      id: recipe.id,
      name: recipe.name,
      quantity: line.quantity,
      craft: recipe.craft || recipe.type,
      level: recipe.level,
      money: cost,
      learned: Array.isArray(learned) ? learned.includes(recipe.gameId) : null,
    };
  });
  const groups = [...demands.values()].sort(
    (a, b) => a.ids.length - b.ids.length || a.name.localeCompare(b.name, 'zh-CN'),
  );
  const allocation = inventoryAvailable ? allocate(groups, owned) : null;
  const materials = groups.map((g, i) => {
    const used = allocation?.[i].reduce((sum, a) => add(sum, a.count), 0);
    return {
      ...g,
      allocated: inventoryAvailable ? used : null,
      missing: inventoryAvailable ? g.count - used : null,
      allocation: allocation?.[i] || [],
    };
  });
  const copper = Number.isSafeInteger(metadata?.money) && metadata.money >= 0 ? metadata.money : null;
  return {
    recipes,
    materials,
    inventoryAvailable,
    money,
    copper,
    copperMissing: copper === null ? null : Math.max(0, money - copper),
    allocated: inventoryAvailable ? materials.reduce((sum, m) => add(sum, m.allocated), 0) : null,
    missing: inventoryAvailable ? materials.reduce((sum, m) => add(sum, m.missing), 0) : null,
    reservations: Object.entries(reservations).map(([id, count]) => ({
      id: Number(id),
      count,
      name: entries.get(`item-${id}`)?.name || `物品 #${id}`,
    })),
  };
}
module.exports = { materialPlan, validateCraftList, allocate, MAX_CRAFTS };
