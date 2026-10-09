'use strict';
const { allocationSummary } = require('./resource-allocations.cjs');
const { materialPlan, allocate } = require('./material-plan.cjs');
const { availableInventory } = require('./reservations.cjs');
const { createHash } = require('node:crypto');
const { selectedReference } = require('./goal-progress.cjs');
const { craftingStages } = require('./crafting-stages.cjs');
const { validateResourcePriority, orderedOwnerIds } = require('./resource-priority.cjs');
const gameEntries = require('../data/game-index.json').entries;
const { giftItemLabel, giftPersonLabel } = require('./gift-labels.cjs');
const add = (a, b) => {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0) throw Error('物资预算超出可计算范围');
  return result;
};
function recipeGoalList(profile, list = []) {
  const goals = new Map(),
    combined = new Map(list.map((line) => [line.id, line.quantity]));
  for (const g of profile.goals || [])
    if (!g.done && g.source?.type === 'database' && /^(fusion|alchemy|cooking)-/.test(g.source.id))
      goals.set(g.source.id, add(goals.get(g.source.id) || 0, g.source.quantity || 1));
  for (const [id, quantity] of goals) combined.set(id, Math.max(combined.get(id) || 0, quantity));
  return [...combined].map(([id, quantity]) => ({ id, quantity }));
}
function subtractBudget(inventory, totals) {
  if (!Array.isArray(inventory)) return inventory;
  const remaining = new Map(Object.entries(totals).map(([id, count]) => [Number(id), count]));
  return inventory.map((item) => {
    const used = Math.min(item.count, remaining.get(item.id) || 0);
    remaining.set(item.id, (remaining.get(item.id) || 0) - used);
    return { ...item, count: item.count - used };
  });
}
function stockMap(inventory) {
  const stock = new Map();
  for (const item of inventory || []) stock.set(item.id, add(stock.get(item.id) || 0, item.count));
  return stock;
}
function craftMoneySummary(budget) {
  if (!budget?.crafts?.length) return null;
  const number = (value) => value.toLocaleString('zh-CN');
  const feeKnown = Number.isSafeInteger(budget.money) && budget.money >= 0;
  const copperKnown = Number.isSafeInteger(budget.copper) && budget.copper >= 0;
  const complete = budget.moneyComplete === true;
  const status = !feeKnown
    ? 'unknown-fee'
    : !copperKnown
      ? 'unknown-copper'
      : !budget.inventoryAvailable
        ? 'unknown-inventory'
        : !complete
          ? 'incomplete'
          : budget.copperMissing > 0
            ? 'shortfall'
            : 'supported';
  const cost = feeKnown
    ? `${complete ? '含加工预计需' : '已确定步骤费用'} ${number(budget.money)} 文`
    : '含加工制作费待核对';
  const balance = copperKnown ? `存档铜钱 ${number(budget.copper)} 文` : '存档铜钱待核对';
  const support = !feeKnown
    ? '费用资料未齐，共同缺口待核对'
    : !copperKnown
      ? '共同费用是否足够待核对'
      : !budget.inventoryAvailable
        ? '库存未核对，加工费用与共同缺口仍待核对'
        : budget.copperMissing > 0
          ? `${complete ? '共同还差' : '仅已确定步骤已至少缺'} ${number(budget.copperMissing)} 文${complete ? '' : '，完整费用仍待核对'}`
          : complete
            ? '铜钱足够支付全部已安排路线'
            : '完整路线费用待核对，实际费用可能增加';
  return {
    status,
    message: `全部有效制作计划：${cost}；${balance}；${support}。费用不含购买原料。`,
    shortMessage:
      status === 'shortfall'
        ? `全部制作计划铜钱还差 ${number(budget.copperMissing)} 文`
        : status === 'supported'
          ? ''
          : status === 'unknown-copper'
            ? '共同制作铜钱待核对'
            : '完整制作费用待核对',
  };
}
function resourceBudget(
  profile,
  reference,
  {
    excludeDraft = false,
    excludePlanId = '',
    excludeRecipeGoals = false,
    excludeRecipeId = '',
    excludeGiftId = '',
    error = '',
    processingRecipeData,
  } = {},
) {
  validateResourcePriority(profile.resourcePriority);
  const summary = allocationSummary(profile, reference, error);
  reference = selectedReference(profile, reference, error);
  const metadata = reference?.metadata;
  const inventory = availableInventory(metadata?.inventory, summary.totals);
  const known = Array.isArray(inventory),
    owned = stockMap(inventory);
  const goals = profile.goals || [];
  const active = (plan) => {
    const linked = goals.filter((g) => g.source?.type === 'planner' && g.source.id === plan.id);
    return plan.done !== true && plan.reserved !== false && (!linked.length || linked.some((g) => !g.done));
  };
  const selected = profile.craftPlans?.find((p) => p.id === profile.activeCraftPlanId);
  const plans = [];
  if (
    !excludeDraft &&
    profile.reserveCraftDraft !== false &&
    profile.craftList?.length &&
    (!selected || active(selected)) &&
    selected?.id !== excludePlanId
  )
    plans.push({
      id: selected?.id || '@draft',
      name: selected ? selected.name + ' · 编辑清单' : '当前制作清单',
      list: profile.craftList,
      choices: profile.craftChoices || {},
    });
  for (const plan of profile.craftPlans || [])
    if (active(plan) && plan.id !== selected?.id && plan.id !== excludePlanId) plans.push(plan);
  if (!excludeRecipeGoals) {
    const draft = new Map(
      (profile.reserveCraftDraft !== false && (!selected || active(selected))
        ? profile.craftList || []
        : []
      ).map((line) => [line.id, line.quantity]),
    );
    const goalList = recipeGoalList(profile)
      .map((line) => ({ ...line, quantity: Math.max(0, line.quantity - (draft.get(line.id) || 0)) }))
      .filter((line) => line.quantity > 0 && line.id !== excludeRecipeId);
    if (goalList.length)
      plans.push({ id: '@recipe-goals', name: '行囊中的制作目标', list: goalList, choices: {} });
  }
  const groups = [];
  for (const plan of plans)
    for (const group of materialPlan(plan.list, null, {}, { aggregate: true }).materials)
      groups.push({ ...group, ownerId: plan.id });
  const handledGifts = new Set(profile.journey?.handledActionIds || []);
  const giftPlans = (profile.journey?.gifts || []).filter(
    (g) =>
      !g.done &&
      g.id !== excludeGiftId &&
      !handledGifts.has(
        'journey:gift:' +
          createHash('sha256')
            .update(JSON.stringify([g.id]))
            .digest('hex')
            .slice(0, 32),
      ),
  );
  for (const gift of giftPlans)
    groups.push({
      name: gift.itemId,
      ids: [Number(gift.itemId.slice(5))],
      count: gift.quantity,
      ownerId: '@gift:' + gift.id,
    });
  const priorityOwners = [
    ...plans.map((plan) => ({ id: plan.id, name: plan.name, kind: 'craft' })),
    ...giftPlans.map((gift) => ({
      id: '@gift:' + gift.id,
      kind: 'gift',
      name:
        '赠予' +
        giftPersonLabel(
          gameEntries.find((e) => e.id === gift.npcId),
          gameEntries,
        ) +
        ' · ' +
        giftItemLabel(gameEntries.find((e) => e.id === gift.itemId)),
    })),
  ];
  const ownerOrder = orderedOwnerIds(
    profile.resourcePriority || [],
    priorityOwners.map((o) => o.id),
  );
  priorityOwners.sort((a, b) => ownerOrder.indexOf(a.id) - ownerOrder.indexOf(b.id));
  if (profile.resourcePriority?.length)
    plans.sort((a, b) => ownerOrder.indexOf(a.id) - ownerOrder.indexOf(b.id));
  const assigned = known
    ? allocate(
        groups,
        owned,
        profile.resourcePriority?.length
          ? {
              priorities: groups.map((g) => ownerOrder.indexOf(g.ownerId)),
            }
          : {},
      )
    : null;
  const totals = { ...summary.totals };
  if (assigned)
    for (const group of assigned) for (const { id, count } of group) totals[id] = add(totals[id] || 0, count);
  const directTotals = { ...totals };
  const crafts = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    list: plan.list,
    materials: groups.flatMap((group, i) =>
      group.ownerId !== plan.id
        ? []
        : [
            {
              name: group.name,
              ids: group.ids,
              count: group.count,
              allocation: assigned?.[i] || [],
              missing: known
                ? group.count - assigned[i].reduce((sum, line) => add(sum, line.count), 0)
                : null,
            },
          ],
    ),
    inventoryAvailable: known,
  }));
  const gifts = giftPlans.map((gift) => {
    const i = groups.findIndex((g) => g.ownerId === '@gift:' + gift.id);
    const allocated = known ? assigned[i].reduce((sum, a) => add(sum, a.count), 0) : null;
    return {
      ...gift,
      allocated,
      missing: known ? gift.quantity - allocated : null,
      inventoryAvailable: known,
    };
  });
  // Direct allocations across all plans and gifts are now fixed. Only actual
  // remaining inventory is shared across processing projections; a plan's
  // hypothetical surplus never becomes another plan's physical stock.
  const remaining = stockMap(subtractBudget(metadata?.inventory, directTotals));
  for (let i = 0; i < crafts.length; i++) {
    const craft = crafts[i],
      plan = plans[i],
      stock = new Map(remaining);
    for (const group of craft.materials)
      for (const item of group.allocation) stock.set(item.id, add(stock.get(item.id) || 0, item.count));
    const planningMetadata = metadata
      ? { ...metadata, inventory: known ? [...stock].map(([id, count]) => ({ id, count })) : undefined }
      : null;
    const processing = craftingStages(
      plan.list,
      planningMetadata,
      {},
      plan.choices || {},
      processingRecipeData,
      { aggregate: true, directMaterials: craft.materials },
    );
    craft.processing = processing;
    craft.processingAllocation = Object.entries(processing.processingPhysicalUsed).map(([id, count]) => ({
      id: Number(id),
      count,
      source: 'inventory',
    }));
    for (const item of craft.processingAllocation) {
      if (item.count > (remaining.get(item.id) || 0)) throw Error('加工占用超过剩余真实库存');
      remaining.set(item.id, remaining.get(item.id) - item.count);
      totals[item.id] = add(totals[item.id] || 0, item.count);
    }
  }
  const raw = stockMap(Array.isArray(metadata?.inventory) ? metadata.inventory : []);
  const claimStock = new Map(raw);
  const allocateClaims = (items, released = false) =>
    Object.entries(items).map(([id, count]) => {
      const allocated = known ? (released ? 0 : Math.min(count, claimStock.get(Number(id)) || 0)) : null;
      if (known && !released) claimStock.set(Number(id), (claimStock.get(Number(id)) || 0) - allocated);
      return { id: Number(id), count, allocated, missing: known ? (released ? 0 : count - allocated) : null };
    });
  const manualAllocation = allocateClaims(summary.manual);
  const owners = summary.owners.map((owner) => ({
    ...owner,
    itemAllocations: allocateClaims(owner.items, owner.complete),
  }));
  const baseMissing = known
    ? Object.entries(summary.totals).reduce(
        (sum, [id, count]) => add(sum, Math.max(0, count - (raw.get(Number(id)) || 0))),
        0,
      )
    : null;
  const missingTotal = known
    ? add(
        baseMissing,
        groups.reduce(
          (sum, g, i) => add(sum, g.count - assigned[i].reduce((count, a) => add(count, a.count), 0)),
          0,
        ),
      )
    : null;
  const baseMaterialMissingTotal = known
    ? crafts.reduce(
        (sum, craft) => add(sum, craft.processing.rawMissingTotal),
        gifts.reduce((sum, gift) => add(sum, gift.missing), baseMissing),
      )
    : null;
  const physicalUsed = {};
  if (known)
    for (const [id, count] of raw) {
      const used = Math.min(count, totals[id] || 0);
      if (used) physicalUsed[id] = used;
    }
  const moneyKnown = crafts.every((craft) => craft.processing.money !== null);
  const money = moneyKnown ? crafts.reduce((sum, craft) => add(sum, craft.processing.money), 0) : null;
  const processingMoney = moneyKnown
    ? crafts.reduce((sum, craft) => add(sum, craft.processing.processingMoney), 0)
    : null;
  const copper = Number.isSafeInteger(metadata?.money) && metadata.money >= 0 ? metadata.money : null;
  const budget = {
    ...summary,
    owners,
    manualAllocation,
    profileId: profile.id,
    totals,
    directTotals,
    physicalUsed,
    crafts,
    gifts,
    priorityOwners,
    explicitPriority: !!profile.resourcePriority?.length,
    missingTotal,
    directMissingTotal: missingTotal,
    baseMaterialMissingTotal,
    money,
    processingMoney,
    moneyComplete: moneyKnown && crafts.every((craft) => craft.processing.moneyComplete),
    copper,
    copperMissing: copper === null || money === null ? null : Math.max(0, money - copper),
    inventoryAvailable: known,
    processingOrder: plans.map((plan) => plan.id),
    referenceIdentity: reference
      ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt }
      : null,
    processingNotice:
      '先保留任务与留用，再共同分配所有制作及赠礼的直接材料；' +
      (profile.resourcePriority?.length
        ? '直接分配按你确认的用途顺序，加工按相同制作顺序使用剩余真实库存。'
        : '默认依次核对编辑清单、保存计划、配方目标和赠礼；可预览并调整用途顺序。') +
      '加工产物仍须制作，不计入真实库存。',
  };
  budget.moneySummary = craftMoneySummary(budget);
  return budget;
}
function recipeBudget(profile, reference, id) {
  if (typeof id !== 'string' || !/^(fusion|alchemy|cooking)-\d+$/.test(id)) throw Error('配方编号无效');
  const inDraft = profile.craftList?.some((line) => line.id === id);
  return resourceBudget(profile, reference, {
    excludeDraft: !!inDraft,
    excludePlanId: inDraft ? profile.activeCraftPlanId : '',
    excludeRecipeId: id,
  });
}
function materialReport(
  profile,
  reference,
  list = profile.craftList || [],
  { aggregate = false, error = '', planId = profile.activeCraftPlanId, excludeRecipeGoals = false } = {},
) {
  reference = selectedReference(profile, reference, error);
  const sharedBudget = resourceBudget(profile, reference, { error });
  const ownerId = planId || '@draft';
  const sameList = (craft) => JSON.stringify(craft.list) === JSON.stringify(list);
  const assigned =
    sharedBudget.crafts.find((craft) => craft.id === ownerId && sameList(craft)) ||
    sharedBudget.crafts.find((craft) => craft.id === '@recipe-goals' && sameList(craft));
  const others = resourceBudget(profile, reference, {
    error,
    excludeDraft: !planId || planId === profile.activeCraftPlanId,
    excludePlanId: planId,
    excludeRecipeGoals,
  });
  const result = materialPlan(list, reference?.metadata || null, others.totals, { aggregate });
  if (assigned) {
    result.materials = result.materials.map((material) => {
      const allocated = assigned.materials.find(
        (m) =>
          m.count === material.count &&
          [...m.ids].sort((a, b) => a - b).join(',') === [...material.ids].sort((a, b) => a - b).join(','),
      );
      if (!allocated) throw Error('编辑清单与统一预算不一致，请重新核对');
      return {
        ...material,
        allocation: allocated.allocation,
        missing: allocated.missing,
        allocated: result.inventoryAvailable
          ? allocated.allocation.reduce((sum, a) => add(sum, a.count), 0)
          : null,
      };
    });
    result.allocated = result.inventoryAvailable
      ? result.materials.reduce((sum, m) => add(sum, m.allocated), 0)
      : null;
    result.missing = result.inventoryAvailable
      ? result.materials.reduce((sum, m) => add(sum, m.missing), 0)
      : null;
  }
  result.stages =
    assigned?.processing ||
    craftingStages(list, reference?.metadata || null, others.totals, profile.craftChoices || {}, undefined, {
      aggregate,
    });
  result.allocations = others;
  result.sharedBudget = sharedBudget;
  if (reference)
    result.reference = {
      name: reference.name,
      hash: reference.hash,
      modifiedAt: reference.modifiedAt,
      mapName: reference.metadata?.mapName,
    };
  return result;
}
module.exports = {
  resourceBudget,
  subtractBudget,
  recipeGoalList,
  recipeBudget,
  materialReport,
  craftMoneySummary,
};
