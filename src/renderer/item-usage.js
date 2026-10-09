// Read-only reverse lookup of existing intentions by exact item identity.
// Workflow references: DIM ItemTriage (d7c02e5c) and Teamcraft NotInList
// (53405826). This projection uses this project's budget facts, not upstream code.
const quantity = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const identity = (reference) =>
  reference ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt } : null;
const sameReference = (a, b) =>
  !!a && !!b && ['name', 'hash', 'modifiedAt'].every((key) => a[key] === b[key]);
function sum(rows, predicate = () => true) {
  let total = 0;
  for (const row of rows.filter(predicate)) {
    const count = quantity(row.count);
    if (count === null || !Number.isSafeInteger(total + count)) return null;
    total += count;
  }
  return total;
}
function craftSource(id) {
  return id === '@draft'
    ? { action: 'navigate', id: 'materials', label: '查看编辑清单' }
    : id === '@recipe-goals'
      ? { action: 'navigate', id: 'goals', label: '查看制作目标' }
      : { action: 'craft-plan-open', id, label: '打开制作计划' };
}

/**
 * reference is the full saveDetails(name) response, including its complete
 * resourceBudget in planning. A recipeBudget deliberately omits its own recipe
 * and must not be used here. The caller owns request/intent freshness checks.
 * Quantities unavailable from the selected reference remain null.
 */
export function projectItemUsage(itemId, { profile, reference, gameIndex, error = '' } = {}) {
  const match = /^item-(\d{1,9})$/.exec(itemId || '');
  const gameId = match ? Number(match[1]) : null;
  const entry = gameIndex?.entries?.find((item) => item.id === itemId && item.kind === '物品');
  const result = {
    item: {
      id: itemId,
      gameId,
      name: entry?.name || (match ? `物品 #${gameId}` : '未识别物品'),
      quality: entry?.quality || '',
    },
    profileId: profile?.id || '',
    referenceIdentity: identity(reference),
    status: 'ready',
    reason: '',
    inventoryAvailable: false,
    stock: { owned: null, allocated: null, remaining: null },
    usages: [],
    notice:
      '只核对本周目已有用途与这份已保存参照；预计加工产物不计入持有。没有已记录用途不代表可以出售，余量也不代表可以安全出售。',
  };
  const unavailable = (status, reason) => ({ ...result, status, reason });
  if (!match || `item-${gameId}` !== itemId)
    return unavailable('invalid-item', '请选择具体物品编号；同名或不同品质不会合并。');
  if (error || reference?.error) return unavailable('unreadable', error || reference.error);
  if (!reference) return unavailable('no-reference', '尚未选择可读存档参照，持有与用途分配待核对。');
  const budget = reference.planning;
  if (
    !budget ||
    !Array.isArray(budget.owners) ||
    !Array.isArray(budget.manualAllocation) ||
    !Array.isArray(budget.crafts) ||
    !Array.isArray(budget.gifts) ||
    !budget.physicalUsed
  )
    return unavailable('budget-unavailable', '这份参照尚未提供完整的本周目物资预算，请重新核对。');
  if (!profile?.id || budget.profileId !== profile.id)
    return unavailable('profile-mismatch', '用途预算属于另一周目，请重新读取当前周目的参照。');
  if (!sameReference(budget.referenceIdentity, result.referenceIdentity))
    return unavailable('reference-mismatch', '用途预算与当前参照的文件、时间或哈希不一致，请重新核对。');
  const known = budget.inventoryAvailable === true && Array.isArray(reference.metadata?.inventory);
  if (known) {
    const owned = sum(reference.metadata.inventory, (item) => item.id === gameId);
    const allocated = quantity(Object.hasOwn(budget.physicalUsed, gameId) ? budget.physicalUsed[gameId] : 0);
    if (owned === null || allocated === null || allocated > owned)
      return unavailable('unreadable', '这份参照的真实持有或分配记录无效，请重新读取。');
    result.inventoryAvailable = true;
    result.stock = { owned, allocated, remaining: owned - allocated };
  } else {
    result.status = 'inventory-unknown';
    result.reason = '这份参照没有可核对的库存，真实持有、分配、余量与缺口保持未知。';
  }
  const rows = result.usages;
  const addClaim = (claim, fields) => {
    if (claim.id !== gameId) return;
    rows.push({
      ...fields,
      scope: 'exact',
      alternativeIds: [gameId],
      required: quantity(claim.count),
      allocated: fields.active === false ? 0 : known ? quantity(claim.allocated) : null,
      missing: fields.active === false ? 0 : known ? quantity(claim.missing) : null,
    });
  };
  for (const claim of budget.manualAllocation)
    addClaim(claim, {
      key: 'manual',
      kind: 'manual',
      ownerId: '@manual',
      title: '手动留用',
      active: true,
      status: '为你记录的用途保留',
      source: { action: 'navigate', id: 'materials', label: '调整留用' },
    });
  for (const owner of budget.owners)
    for (const claim of owner.itemAllocations || [])
      addClaim(claim, {
        key: `quest:${owner.questId}`,
        kind: 'quest',
        ownerId: owner.questId,
        title: owner.name || owner.questId,
        active: !owner.complete,
        status: owner.status || '任务进度待核对 · 继续保留',
        source: { action: 'world-quest', id: owner.questId, label: '查看任务' },
      });
  for (const craft of budget.crafts) {
    const source = craftSource(craft.id);
    for (const [index, material] of (craft.materials || []).entries()) {
      if (!material.ids?.includes(gameId)) continue;
      rows.push({
        key: `craft:${craft.id}:${index}`,
        kind: 'craft',
        ownerId: craft.id,
        title: craft.name,
        materialName: material.name,
        active: true,
        status: '直接制作材料',
        source,
        scope: material.ids.length > 1 ? 'alternative-group' : 'exact',
        alternativeIds: [...material.ids],
        required: quantity(material.count),
        allocated: known ? sum(material.allocation || [], (item) => item.id === gameId) : null,
        groupAllocated: known ? sum(material.allocation || []) : null,
        missing: known ? quantity(material.missing) : null,
      });
    }
    for (const [stageIndex, stage] of (craft.processing?.stages || []).entries()) {
      if (stage.final) continue;
      for (const [index, material] of (stage.materials || []).entries()) {
        if (!material.ids?.includes(gameId)) continue;
        const physical = (material.sources || []).filter((item) => item.source === 'inventory');
        const plannedSources = (material.sources || [])
          .filter((item) => item.source === 'planned-output')
          .map(({ id, count, recipeId }) => ({ id, count, recipeId }));
        const groupAllocated = known ? sum(physical) : null;
        const required = quantity(material.count);
        rows.push({
          key: `processing:${craft.id}:${stageIndex}:${index}`,
          kind: 'processing',
          ownerId: craft.id,
          title: craft.name,
          stageName: stage.name,
          recipeId: stage.id,
          materialName: material.name,
          active: true,
          status: '前序加工步骤',
          source,
          scope: material.ids.length > 1 ? 'alternative-group' : 'exact',
          alternativeIds: [...material.ids],
          required,
          allocated: known ? sum(physical, (item) => item.id === gameId) : null,
          groupAllocated,
          unallocatedPhysical:
            required !== null && groupAllocated !== null ? required - groupAllocated : null,
          plannedSources,
          plannedAllocated: known ? sum(plannedSources, (item) => item.id === gameId) : null,
          groupPlannedAllocated: known ? sum(plannedSources) : null,
          endpointMissing: known ? quantity(material.missing) : null,
          missing: known ? quantity(material.missing) : null,
        });
      }
    }
  }
  for (const gift of budget.gifts) {
    if (gift.itemId !== itemId) continue;
    const person = gameIndex?.entries?.find((entry) => entry.id === gift.npcId);
    addClaim(
      { id: gameId, count: gift.quantity, allocated: gift.allocated, missing: gift.missing },
      {
        key: `gift:${gift.id}`,
        kind: 'gift',
        ownerId: '@gift:' + gift.id,
        title: '赠予' + (person?.name || gift.npcId),
        active: true,
        status: '已记录赠礼',
        note: gift.note || '',
        source: { action: 'journey-gift-edit', id: gift.id, label: '查看赠礼安排' },
      },
    );
  }
  return result;
}
