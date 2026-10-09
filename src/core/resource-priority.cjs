'use strict';
const { createHash } = require('node:crypto');
const MAX_PRIORITY = 142;
const ownerId = /^(?:@draft|@recipe-goals|@gift:[A-Za-z0-9][A-Za-z0-9_-]{0,79}|[A-Za-z0-9-]{1,80})$/;
function validateResourcePriority(order = []) {
  if (
    !Array.isArray(order) ||
    order.length > MAX_PRIORITY ||
    new Set(order).size !== order.length ||
    order.some((id) => typeof id !== 'string' || !ownerId.test(id))
  )
    throw Error('制作与赠礼的物资顺序无效');
  return order;
}
function orderedOwnerIds(order, available) {
  validateResourcePriority(order);
  return [...order.filter((id) => available.includes(id)), ...available.filter((id) => !order.includes(id))];
}
function priorityReferenceProfile(profile, referenceName) {
  if (referenceName === undefined) return profile;
  if (
    typeof referenceName !== 'string' ||
    referenceName.length > 80 ||
    (referenceName !== '' && referenceName !== '@latest' && !/^\d+\.sav$/i.test(referenceName))
  )
    throw Error('请选择有效的物资核对存档');
  return {
    ...profile,
    referenceMode: referenceName === '' ? 'none' : referenceName === '@latest' ? 'latest' : 'slot',
    saveSlot: referenceName === '' || referenceName === '@latest' ? '' : referenceName,
  };
}
function priorityFingerprint(profile, reference) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        profileId: profile.id,
        referenceMode: profile.referenceMode,
        saveSlot: profile.saveSlot,
        reference: reference
          ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt }
          : null,
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
      }),
    )
    .digest('hex');
}
function resourcePriorityPreview(profile, reference, order) {
  validateResourcePriority(order);
  // Lazy import avoids a cycle: the budget uses the small order validator.
  const { resourceBudget } = require('./resource-budget.cjs');
  const before = resourceBudget(profile, reference),
    available = before.priorityOwners.map((o) => o.id);
  if (order.length && (order.length !== available.length || order.some((id) => !available.includes(id))))
    throw Error('物资用途已变化，请重新核对顺序');
  const after = resourceBudget({ ...profile, resourcePriority: order }, reference);
  const flatten = (budget) => {
    const owners = new Map(budget.priorityOwners.map((o) => [o.id, { ...o, items: new Map(), missing: [] }]));
    const put = (id, item, count, kind) => {
      const row = owners.get(id),
        old = row.items.get(item) || { direct: 0, processing: 0 };
      old[kind] += count;
      row.items.set(item, old);
    };
    for (const craft of budget.crafts) {
      for (const material of craft.materials) {
        for (const item of material.allocation) put(craft.id, item.id, item.count, 'direct');
        owners
          .get(craft.id)
          .missing.push({ name: material.name, ids: material.ids, count: material.missing });
      }
      for (const item of craft.processingAllocation) put(craft.id, item.id, item.count, 'processing');
      owners.get(craft.id).rawMissing = craft.processing.rawMissingTotal;
    }
    for (const gift of budget.gifts) {
      if (gift.allocated !== null)
        put('@gift:' + gift.id, Number(gift.itemId.slice(5)), gift.allocated, 'direct');
      owners
        .get('@gift:' + gift.id)
        .missing.push({ name: gift.itemId, ids: [Number(gift.itemId.slice(5))], count: gift.missing });
    }
    return owners;
  };
  const first = flatten(before),
    last = flatten(after),
    changes = [];
  for (const row of after.priorityOwners) {
    const a = first.get(row.id),
      b = last.get(row.id);
    const items = [...new Set([...a.items.keys(), ...b.items.keys()])]
      .sort((x, y) => x - y)
      .map((id) => ({
        id,
        beforeDirect: a.items.get(id)?.direct || 0,
        afterDirect: b.items.get(id)?.direct || 0,
        beforeProcessing: a.items.get(id)?.processing || 0,
        afterProcessing: b.items.get(id)?.processing || 0,
      }));
    changes.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      items,
      beforeMissing: a.missing,
      afterMissing: b.missing,
      beforeRawMissing: a.rawMissing ?? null,
      afterRawMissing: b.rawMissing ?? null,
    });
  }
  return {
    profileId: profile.id,
    referenceIdentity: before.referenceIdentity,
    fingerprint: priorityFingerprint(profile, reference),
    order: [...order],
    beforeOrder: before.priorityOwners.map((o) => o.id),
    afterOrder: after.priorityOwners.map((o) => o.id),
    inventoryAvailable: before.inventoryAvailable,
    changes,
    beforePhysicalUsed: before.physicalUsed,
    afterPhysicalUsed: after.physicalUsed,
    beforeMissingTotal: before.baseMaterialMissingTotal,
    afterMissingTotal: after.baseMaterialMissingTotal,
  };
}
module.exports = {
  validateResourcePriority,
  orderedOwnerIds,
  priorityFingerprint,
  resourcePriorityPreview,
  priorityReferenceProfile,
};
