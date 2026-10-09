'use strict';
const { createHash } = require('node:crypto');
const data = require('../data/game-index.json');
const { materialPlan, validateCraftList } = require('./material-plan.cjs');
const { subtractBudget } = require('./resource-budget.cjs');
const { selectedReference } = require('./goal-progress.cjs');
const recipes = data.entries.filter((entry) => entry.kind === '配方');
const byId = new Map(recipes.map((entry) => [entry.id, entry]));
const learningKeys = { fusion: 'fusionRecipes', alchemy: 'alchemyRecipes', cooking: 'cookingRecipes' };
const NEAR_UNITS = 2,
  NEAR_GROUPS = 2;
// Inspired by Teamcraft's pinned recipe finder workflow (MIT, Flavien Normand):
// ingredient pool -> missing-material ranking -> add to an existing list.
// No upstream code is copied. Allocation stays in this project's maximum flow.
const catalogIdentity = createHash('sha256')
  .update(JSON.stringify({ build: data.build, recipes }))
  .digest('hex');
function record(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function validateDiscoveryOptions(options = {}) {
  if (
    !record(options) ||
    Object.keys(options).some(
      (key) => !['query', 'craft', 'learned', 'view', 'page', 'pageSize', 'quantities'].includes(key),
    )
  )
    throw Error('配方反查条件无效');
  const out = {
    query: '',
    craft: '',
    learned: 'learned',
    view: 'supported',
    page: 1,
    pageSize: 8,
    quantities: {},
    ...options,
  };
  if (typeof out.query !== 'string' || out.query.length > 100) throw Error('配方搜索最多 100 字');
  if (
    !['', 'fusion', 'alchemy', 'cooking'].includes(out.craft) ||
    !['learned', 'all', 'unlearned', 'unknown'].includes(out.learned) ||
    !['supported', 'near', 'all'].includes(out.view)
  )
    throw Error('配方反查分类无效');
  if (!Number.isSafeInteger(out.page) || out.page < 1 || out.page > 10000 || ![8, 12].includes(out.pageSize))
    throw Error('配方反查分页无效');
  if (!record(out.quantities) || Object.keys(out.quantities).length > recipes.length)
    throw Error('配方反查数量设置无效');
  for (const [id, quantity] of Object.entries(out.quantities)) validateCraftList([{ id, quantity }]);
  out.query = out.query.trim();
  out.quantities = { ...out.quantities };
  return out;
}
function identity(reference) {
  return reference &&
    typeof reference.name === 'string' &&
    reference.name.length > 0 &&
    typeof reference.hash === 'string' &&
    reference.hash.length > 0 &&
    typeof reference.modifiedAt === 'string' &&
    Number.isFinite(Date.parse(reference.modifiedAt))
    ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt }
    : null;
}
function sameIdentity(a, b) {
  return !!a && !!b && ['name', 'hash', 'modifiedAt'].every((key) => a[key] === b[key]);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function context(profile, reference, budget) {
  if (!record(profile) || typeof profile.id !== 'string' || !profile.id) throw Error('当前周目无效');
  const selected = selectedReference(profile, reference),
    source = identity(selected);
  const reasons = [];
  let matched = false;
  if (!selected) reasons.push('本周目尚无匹配的存档参照，请先核对所选存档。');
  else if (!source) reasons.push('存档名称、指纹或时间不完整，暂不能核对反查来源。');
  else if (
    !record(budget) ||
    budget.profileId !== profile.id ||
    !sameIdentity(source, budget.referenceIdentity)
  )
    reasons.push('物资预算与当前周目或存档参照不匹配，请重新核对。');
  else if (
    typeof budget.inventoryAvailable !== 'boolean' ||
    budget.inventoryAvailable !== Array.isArray(selected.metadata?.inventory)
  )
    reasons.push('库存与物资预算的读取状态不一致，请重新核对。');
  else matched = true;
  if (
    matched &&
    (!record(budget.totals) ||
      Object.entries(budget.totals).some(
        ([id, count]) =>
          !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || !Number.isSafeInteger(count) || count < 0,
      ))
  )
    throw Error('物资预算记录无效');
  const inventoryAvailable = matched && budget.inventoryAvailable;
  if (matched && !inventoryAvailable) reasons.push('这份存档没有可核对的库存记录；材料数量保留未知。');
  const metadata = matched
    ? {
        ...selected.metadata,
        inventory: inventoryAvailable
          ? subtractBudget(selected.metadata.inventory, budget.totals)
          : undefined,
      }
    : null;
  const rawCopper =
    matched && Number.isSafeInteger(selected.metadata?.money) && selected.metadata.money >= 0
      ? selected.metadata.money
      : null;
  const committedMoneyKnown =
    matched && budget.moneyComplete === true && Number.isSafeInteger(budget.money) && budget.money >= 0;
  if (metadata) {
    metadata.money =
      rawCopper !== null && committedMoneyKnown ? Math.max(0, rawCopper - budget.money) : undefined;
    for (const key of Object.values(learningKeys))
      if (!Array.isArray(metadata[key]) || metadata[key].some((id) => !Number.isSafeInteger(id) || id < 0))
        metadata[key] = undefined;
  }
  const intent = {
    profileId: profile.id,
    referenceMode: profile.referenceMode,
    saveSlot: profile.saveSlot,
    reservations: profile.reservations,
    allocations: profile.allocations,
    goals: profile.goals,
    craftList: profile.craftList,
    craftChoices: profile.craftChoices,
    craftPlans: profile.craftPlans,
    activeCraftPlanId: profile.activeCraftPlanId,
    reserveCraftDraft: profile.reserveCraftDraft,
    gifts: profile.journey?.gifts,
    handledActionIds: profile.journey?.handledActionIds,
    resourcePriority: profile.resourcePriority,
  };
  const scopeToken = matched
    ? createHash('sha256')
        .update(
          JSON.stringify(
            canonical({
              schema: 1,
              catalogIdentity,
              intent,
              reference: source,
              budget,
              // These fields are already covered by a real save hash. Including them also
              // keeps synthetic/read-only callers honest when their hash is unchanged.
              inventory: selected.metadata?.inventory,
              money: selected.metadata?.money,
              learned: Object.fromEntries(
                Object.values(learningKeys).map((key) => [key, selected.metadata?.[key]]),
              ),
            }),
          ),
        )
        .digest('hex')
    : null;
  return {
    metadata,
    source: matched ? source : null,
    scopeToken,
    inventoryAvailable,
    reasons,
    status: matched
      ? inventoryAvailable
        ? 'ready'
        : 'inventory-unknown'
      : selected
        ? 'mismatch'
        : 'no-reference',
  };
}
function candidate(recipe, quantity, ctx, one) {
  const plan = quantity === 1 && one ? one : materialPlan([{ id: recipe.id, quantity }], ctx.metadata);
  one ||= quantity === 1 ? plan : materialPlan([{ id: recipe.id, quantity: 1 }], ctx.metadata);
  const learned = plan.recipes[0].learned;
  const moneyStatus = plan.copperMissing === null ? 'unknown' : plan.copperMissing ? 'missing' : 'supported';
  const unknowns = [...ctx.reasons];
  if (learned === null) unknowns.push('这份存档未提供此工种的有效学习记录。');
  if (moneyStatus === 'unknown') unknowns.push('剩余铜钱或既有计划费用未完整核对，费用支持情况未知。');
  unknowns.push('当前生活技能等级未读取；请在游戏内核对制作等级与状态。');
  return {
    recipeId: recipe.id,
    name: recipe.name,
    craft: recipe.craft || recipe.type,
    recipeType: recipe.recipeType,
    learned,
    requestedQuantity: quantity,
    materialStatus: plan.missing === null ? 'unknown' : plan.missing === 0 ? 'supported' : 'missing',
    missingTotal: plan.missing,
    missingItems: plan.materials
      .filter((material) => material.missing === null || material.missing > 0)
      .map((material) => ({
        name: material.name,
        ids: [...material.ids],
        needed: material.count,
        allocated: material.allocated,
        missing: material.missing,
      })),
    supportsOne: one.missing === null ? null : one.missing === 0,
    oneMissingTotal: one.missing,
    oneMissingGroups: one.materials.filter((material) => material.missing > 0).length,
    money: plan.money,
    moneyStatus,
    copperMissing: plan.copperMissing,
    remainingCopper: plan.copper,
    requirementLevel: recipe.level,
    currentLevel: null,
    learningItemIds: [...(recipe.learningItems || [])],
    blockingUnknowns: unknowns,
  };
}
function recipeDiscovery(profile, reference, budget, options = {}) {
  const filters = validateDiscoveryOptions(options),
    ctx = context(profile, reference, budget);
  const query = filters.query.toLocaleLowerCase('zh-CN');
  let rows = recipes
    .filter(
      (recipe) =>
        (!filters.craft || recipe.recipeType === filters.craft) &&
        (!query ||
          `${recipe.name} ${recipe.craft || recipe.type} ${recipe.description || ''}`
            .toLocaleLowerCase('zh-CN')
            .includes(query)),
    )
    .map((recipe) => candidate(recipe, 1, ctx));
  const summary = {
    totalRecipes: recipes.length,
    learned: rows.filter((row) => row.learned === true).length,
    learningUnknown: rows.filter((row) => row.learned === null).length,
    supportsOne: rows.filter((row) => row.supportsOne === true).length,
    inventoryUnknown: rows.filter((row) => row.supportsOne === null).length,
  };
  rows = rows.filter(
    (row) =>
      (filters.learned === 'all' ||
        (filters.learned === 'learned' && row.learned !== false) ||
        (filters.learned === 'unlearned' && row.learned === false) ||
        (filters.learned === 'unknown' && row.learned === null)) &&
      (filters.view === 'all' ||
        row.supportsOne === null ||
        (filters.view === 'supported' && row.supportsOne) ||
        (filters.view === 'near' &&
          row.oneMissingTotal > 0 &&
          row.oneMissingTotal <= NEAR_UNITS &&
          row.oneMissingGroups <= NEAR_GROUPS)),
  );
  rows.sort(
    (a, b) =>
      (a.oneMissingTotal ?? Infinity) - (b.oneMissingTotal ?? Infinity) ||
      (a.learned === true ? 0 : a.learned === null ? 1 : 2) -
        (b.learned === true ? 0 : b.learned === null ? 1 : 2) ||
      a.requirementLevel - b.requirementLevel ||
      a.name.localeCompare(b.name, 'zh-CN') ||
      a.recipeId.localeCompare(b.recipeId),
  );
  const total = rows.length,
    pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  filters.page = Math.min(filters.page, pageCount);
  rows = rows
    .slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize)
    .map((row) =>
      filters.quantities[row.recipeId] && filters.quantities[row.recipeId] !== 1
        ? candidate(byId.get(row.recipeId), filters.quantities[row.recipeId], ctx)
        : row,
    );
  return {
    schema: 1,
    profileId: profile.id,
    referenceIdentity: ctx.source,
    scopeToken: ctx.scopeToken,
    status: ctx.status,
    inventoryAvailable: ctx.inventoryAvailable,
    catalogBuild: data.build,
    filters,
    pagination: { page: filters.page, pageSize: filters.pageSize, pageCount, total },
    summary,
    rows,
    nearThreshold: { units: NEAR_UNITS, groups: NEAR_GROUPS },
    notices: [
      ...ctx.reasons,
      '余料已扣除留用、任务、所有制作计划、赠礼和真实加工占用；预计加工产物不计入库存。',
      '每张候选卡独立使用同一份余料核对，不表示这些配方能同时制作。',
      '材料支持只核对直接配料，配方学习、铜钱与游戏内生活技能等级分别核对。',
    ],
  };
}
function assertDiscoveryScope(profile, reference, budget, request) {
  if (
    !record(request) ||
    Object.keys(request).some((key) => !['scopeToken', 'recipeId', 'quantity'].includes(key)) ||
    typeof request.scopeToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.scopeToken)
  )
    throw Error('配方反查加入请求无效，请重新核对');
  validateCraftList([{ id: request.recipeId, quantity: request.quantity }]);
  const ctx = context(profile, reference, budget);
  if (!ctx.scopeToken || ctx.scopeToken !== request.scopeToken)
    throw Error('反查结果已过期，请重新核对后再加入计划');
  return candidate(byId.get(request.recipeId), request.quantity, ctx);
}
module.exports = { recipeDiscovery, assertDiscoveryScope, validateDiscoveryOptions };
