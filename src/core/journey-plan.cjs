'use strict';
const { createHash } = require('node:crypto');
const world = require('../data/world-index.json');
const game = require('../data/game-index.json');
const placeAliases = require('../data/world-place-aliases.json');
const { createJourneyStateTools, emptyJourneyState } = require('./journey-state.cjs');
const { giftItemLabel, giftPersonLabel } = require('./gift-labels.cjs');

const safeCount = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000000000000;
const stableId = (kind, parts) =>
  `journey:${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
const statusLabels = {
  unknown: '任务进度待核对',
  'not-started': '存档中尚未开始',
  active: '存档中进行中',
  failed: '存档中已失败',
  'not-accepted': '存档中尚未接取',
  complete: '存档中已完成',
  manual: '用户手动管理',
};
const stepStatus = (record) =>
  Number.isInteger(record?.step)
    ? { 0: 'not-started', 1: 'active', 2: 'failed', 3: 'not-accepted', 4: 'complete' }[record.step] ||
      'unknown'
    : 'unknown';
const nav = (action, id) => ({ action, id });
const uncertainty = (code, message) => ({ code, message });
const identity = (reference) =>
  reference ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt } : null;
function sameIdentity(a, b) {
  return (
    a &&
    b &&
    ['name', 'hash', 'modifiedAt'].every((key) => typeof a[key] === 'string' && a[key] && a[key] === b[key])
  );
}

function createJourneyPlanner({ world: worldIndex, game: gameIndex }) {
  const quests = new Map(worldIndex.quests.map((q) => [q.id, q]));
  const byGameId = new Map(worldIndex.quests.map((q) => [q.gameId, q]));
  const entries = new Map(gameIndex.entries.map((e) => [e.id, e]));
  function craftTitle(recipe, quantity) {
    const ids = [...new Set((recipe.results || []).map((row) => row.id))];
    const item = ids.length === 1 && entries.get('item-' + ids[0]);
    return item
      ? `核对并制作：${item.name}${item.quality ? '（' + item.quality + '色品质）' : ''} × ${quantity} 次配方`
      : `核对并执行配方：${recipe.name} × ${quantity} 次`;
  }
  const maps = new Map(worldIndex.maps.map((p) => [p.id, p]));
  const byKey = new Map(worldIndex.maps.map((p) => [p.key, p]));
  const placeNames = new Map();
  const children = new Map();
  for (const p of maps.values()) {
    if (!placeNames.has(p.name)) placeNames.set(p.name, []);
    placeNames.get(p.name).push(p);
  }
  for (const q of quests.values()) {
    if (!children.has(q.parentId)) children.set(q.parentId, []);
    children.get(q.parentId).push(q);
  }
  const stateTools = createJourneyStateTools({ world: worldIndex, game: gameIndex });
  const dataSource = (type, id, field, excerpt = '') => ({
    type,
    id,
    field,
    excerpt,
    build: type === 'database' ? gameIndex.build : worldIndex.build,
  });
  function descendants(q) {
    const result = [],
      seen = new Set(),
      queue = [q];
    for (let at = 0; at < queue.length; at++) {
      const next = queue[at];
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      result.push(next);
      queue.push(...(children.get(next.gameId) || []));
    }
    return result;
  }
  function completedAncestor(q, records) {
    const seen = new Set();
    while (q.parentId && !seen.has(q.parentId)) {
      seen.add(q.parentId);
      q = byGameId.get(q.parentId);
      if (!q) return null;
      if (stepStatus(records.get(q.gameId)) === 'complete') return q;
    }
    return null;
  }
  function rootQuest(q) {
    const seen = new Set();
    while (q.parentId && !seen.has(q.parentId)) {
      seen.add(q.parentId);
      const parent = byGameId.get(q.parentId);
      if (!parent) break;
      q = parent;
    }
    return q;
  }
  function followsQuest(q, previous) {
    const seen = new Set(),
      queue = [q];
    for (let at = 0; at < queue.length; at++) {
      const next = queue[at];
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      for (const requirement of next.requirements || []) {
        if (requirement.type !== 'PreQuest') continue;
        if (requirement.id === previous.gameId) return true;
        const ancestor = byGameId.get(requirement.id);
        if (ancestor && rootQuest(ancestor).id === rootQuest(previous).id) queue.push(ancestor);
      }
    }
    return false;
  }
  function blockedQuest(q, records) {
    const seen = new Set();
    while (q && !seen.has(q.gameId)) {
      seen.add(q.gameId);
      const status = stepStatus(records.get(q.gameId));
      if (['failed', 'not-accepted'].includes(status)) return { quest: q, status };
      q = byGameId.get(q.parentId);
    }
    return null;
  }
  function mentionPlaces(text, source) {
    const found = [];
    for (const [name, variants] of placeNames)
      if (name.length >= 2 && text.includes(name))
        found.push({
          name,
          mapIds: variants.map((p) => p.id),
          evidence: 'literal-mention',
          source,
          navigation: variants.map((p) => nav('world-place', p.id)),
        });
    // Curated aliases are shared with task details. Keep the literal phrase
    // and phase ambiguity; these are text associations, not live locations.
    for (const alias of placeAliases) {
      const mention = alias.mentions.find((phrase) => text.includes(phrase));
      if (!mention || found.some((p) => p.name === alias.name) || !placeNames.has(alias.name)) continue;
      found.push({
        name: alias.name,
        mention,
        mapIds: placeNames.get(alias.name).map((p) => p.id),
        evidence: 'text-alias',
        source,
        navigation: placeNames.get(alias.name).map((p) => nav('world-place', p.id)),
      });
    }
    return found;
  }
  function explicitPlace(placeId, source) {
    const p = maps.get(placeId);
    return p
      ? [
          {
            name: p.name,
            mapIds: [p.id],
            evidence: 'user-target',
            source,
            navigation: [nav('world-place', p.id)],
          },
        ]
      : [];
  }
  function questPlaces(q) {
    const source = dataSource('quest', q.id, 'description', q.description || q.name);
    const locations = mentionPlaces(`${q.name}\n${q.description || ''}`, source);
    for (const p of q.placements || []) {
      const place = byKey.get(p.mapKey);
      if (place)
        locations.push({
          name: place.name,
          mapIds: [place.id],
          evidence: 'scene-placement',
          phase: p.phase,
          npcId: p.npcId,
          interactionTarget: p.interactionTarget === true,
          source: dataSource('quest', q.id, 'placements', JSON.stringify(p)),
          navigation: [nav('world-place', place.id)],
        });
    }
    return locations;
  }
  function requirements(q, records) {
    return (q.requirements || []).map((raw) => {
      const related = ['PreQuest', 'NoQuest'].includes(raw.type) ? byGameId.get(raw.id) : null;
      const target = related
        ? nav('world-quest', related.id)
        : raw.type === 'Item' && entries.has(`item-${raw.id}`)
          ? nav('database-detail', `item-${raw.id}`)
          : entries.get(`npc-${raw.id}`)?.kind === '人物'
            ? nav('database-detail', `npc-${raw.id}`)
            : null;
      return {
        raw: structuredClone(raw),
        source: dataSource('quest', q.id, 'requirements', JSON.stringify(raw)),
        navigation: target,
        observedProgress: related ? stepStatus(records.get(related.gameId)) : null,
        satisfied: null,
        semantics: 'uninterpreted',
        label: `${raw.type} · ${raw.name || raw.id} · 原始值 ${String(raw.value)}`,
      };
    });
  }
  function itemHints(ids) {
    return ids.flatMap((id) => {
      const item = entries.get(`item-${id}`);
      if (!item) return [];
      const source = dataSource('database', item.id, 'description', item.description || '');
      const vendors = (gameIndex.merchants || []).filter((m) => m.items.includes(id));
      return [
        {
          itemId: item.id,
          name: item.name,
          description: item.description || '',
          source,
          places: mentionPlaces(item.description || '', source),
          navigation: nav('database-detail', item.id),
          merchants: vendors.map((m) => ({
            npcId: `npc-${m.id}`,
            name: m.name,
            navigation: entries.has(`npc-${m.id}`) ? nav('database-detail', `npc-${m.id}`) : null,
            source: dataSource('database', `npc-${m.id}`, 'merchants.items', `item-${id}`),
            currentStock: null,
            currentLocation: null,
          })),
        },
      ];
    });
  }

  function journeyPlan(profile, reference, budget) {
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string') throw Error('周目无效');
    const state = profile.journey === undefined ? emptyJourneyState() : profile.journey;
    stateTools.validateJourneyState(state);
    const mode = profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest');
    const matching =
      mode !== 'none' &&
      reference &&
      !reference.error &&
      (mode !== 'slot' || reference.name === profile.saveSlot);
    const selected = matching ? reference : null;
    const recordsKnown = Array.isArray(selected?.metadata?.quests);
    const records = new Map(
      (recordsKnown ? selected.metadata.quests : [])
        .filter((r) => Number.isSafeInteger(r?.id))
        .map((r) => [r.id, r]),
    );
    const inventory = new Map();
    let inventoryKnown = Array.isArray(selected?.metadata?.inventory);
    for (const item of inventoryKnown ? selected.metadata.inventory : []) {
      if (
        !Number.isSafeInteger(item?.id) ||
        item.id < 0 ||
        !safeCount(item.count) ||
        !safeCount((inventory.get(item.id) || 0) + item.count)
      ) {
        inventoryKnown = false;
        inventory.clear();
        break;
      }
      inventory.set(item.id, (inventory.get(item.id) || 0) + item.count);
    }
    const budgetBound = !!(
      matching &&
      inventoryKnown &&
      budget?.profileId === profile.id &&
      sameIdentity(budget.referenceIdentity, identity(selected)) &&
      budget.inventoryAvailable === true &&
      budget.totals &&
      typeof budget.totals === 'object' &&
      !Array.isArray(budget.totals) &&
      Object.entries(budget.totals).every(([id, count]) => /^\d+$/.test(id) && safeCount(count))
    );
    const snapshot = identity(selected);
    const saveSource = snapshot ? { type: 'save', ...snapshot } : null;
    const warnings = [];
    if (!recordsKnown)
      warnings.push(
        uncertainty('quest-records-unknown', '当前没有匹配的可读任务记录；未记录不代表未接取、失败或错过。'),
      );
    if (!budgetBound)
      warnings.push(
        uncertainty('budget-unknown', '尚无与此周目和存档指纹匹配的资源预算；缺料与可用库存待核对。'),
      );
    if (selected?.metadata?.build && String(selected.metadata.build) !== String(worldIndex.build))
      warnings.push(uncertainty('build-mismatch', '存档版本与本机资料版本不同，资料线索须在游戏内核对。'));
    const actions = [],
      goalProgress = [],
      handled = new Set(state.handledActionIds),
      chosen = new Map();
    const sourceForUser = (id, field = 'journey') => ({ type: 'user', id, field, excerpt: '' });
    function addAction(kind, key, row) {
      const id = stableId(kind, key);
      const existing = actions.find((a) => a.id === id);
      if (existing) {
        existing.goalIds = [...new Set([...existing.goalIds, ...(row.goalIds || [])])];
        return existing;
      }
      const action = {
        id,
        kind,
        goalIds: [],
        prerequisites: [],
        unknowns: [],
        places: [],
        sources: [],
        navigation: [],
        gameComplete: false,
        userDone: false,
        handled: handled.has(id),
        ...row,
      };
      action.prepared = !!(
        kind === 'material' &&
        action.material?.allocationKnown &&
        action.material.missing === 0
      );
      actions.push(action);
      return action;
    }
    const choose = (q, goal) => {
      if (!chosen.has(q.id)) chosen.set(q.id, { q, goals: [] });
      if (goal && !chosen.get(q.id).goals.some((g) => g.id === goal.id)) chosen.get(q.id).goals.push(goal);
    };
    for (const goal of profile.goals || []) {
      if (goal.source?.type !== 'quest') continue;
      const q = quests.get(goal.source.id);
      const savedStatus = q ? stepStatus(records.get(q.gameId)) : 'unknown';
      const manual = goal.progressMode === 'manual';
      const progress = {
        goalId: goal.id,
        questId: goal.source.id,
        status: manual ? 'manual' : savedStatus,
        label: statusLabels[manual ? 'manual' : savedStatus],
        manualDone: goal.done === true,
        gameComplete: !manual && savedStatus === 'complete',
        source: q && savedStatus !== 'unknown' ? saveSource : null,
      };
      goalProgress.push(progress);
      if (!q) {
        warnings.push(uncertainty('unknown-goal-source', `目标 ${goal.id} 的任务不在本机资料中。`));
        continue;
      }
      if (progress.manualDone || progress.gameComplete) {
        addAction('quest', [q.id], {
          title: goal.title || q.name,
          detail: q.description || '',
          questId: q.id,
          goalIds: [goal.id],
          progress,
          gameComplete: progress.gameComplete,
          userDone: progress.manualDone,
          sources: [
            dataSource('quest', q.id, 'description', q.description || ''),
            ...(progress.source ? [progress.source] : []),
          ],
          navigation: [nav('world-quest', q.id)],
        });
        continue;
      }
      const active = descendants(q).filter(
        (step) => step !== q && stepStatus(records.get(step.gameId)) === 'active',
      );
      if (active.length && !manual) for (const step of active) choose(step, goal);
      else choose(q, goal);
    }
    for (const record of records.values()) {
      const q = byGameId.get(record.id);
      if (
        q &&
        stepStatus(record) === 'active' &&
        !(children.get(q.gameId) || []).some((child) => stepStatus(records.get(child.gameId)) === 'active')
      )
        choose(q);
    }
    for (const allocation of profile.allocations || []) {
      const q = quests.get(allocation.questId);
      if (q && stepStatus(records.get(q.gameId)) !== 'complete') choose(q);
    }
    for (const { q, goals } of chosen.values()) {
      const manual = goals.length > 0 && goals.every((g) => g.progressMode === 'manual');
      const existing = actions.find((a) => a.questId === q.id && (a.userDone || a.gameComplete));
      if (existing && !manual) continue;
      if (existing && manual) {
        actions.splice(actions.indexOf(existing), 1);
        // Completed automatic owners remain visible in goalProgress. The action
        // remains open for an explicit uncompleted manual owner of the same task.
      }
      const ancestor = manual ? null : completedAncestor(q, records);
      if (ancestor) {
        warnings.push(
          uncertainty(
            'conflicting-quest-records',
            `${q.name} 仍有进行中记录，但所属任务 ${ancestor.name} 已完成；先核对任务记录。`,
          ),
        );
        continue;
      }
      const savedStatus = stepStatus(records.get(q.gameId));
      const status = manual ? 'manual' : savedStatus;
      const links = descendants(q)
        .filter((c) => c !== q)
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: stepStatus(records.get(c.gameId)),
          navigation: nav('world-quest', c.id),
        }));
      const reqs = requirements(q, records);
      const owner = budgetBound && budget.owners?.find((o) => o.questId === q.id && !o.complete);
      const materials = (q.materials || []).map((m) => {
        const assigned = owner?.itemAllocations?.find((a) => a.id === m.id && safeCount(a.allocated));
        return {
          ...structuredClone(m),
          onHand: inventoryKnown ? inventory.get(m.id) || 0 : null,
          reserved: assigned?.count ?? null,
          allocated: assigned?.allocated ?? null,
          missing: assigned ? Math.max(0, m.count - assigned.allocated) : null,
          allocationKnown: !!assigned,
          hints: itemHints([m.id]),
        };
      });
      addAction('quest', [q.id], {
        title: savedStatus === 'active' && !manual ? q.name : `核对任务：${q.name}`,
        detail: q.description || '资料未提供说明。',
        questId: q.id,
        goalIds: goals.map((g) => g.id),
        progress: {
          status,
          savedStatus,
          label: statusLabels[status],
          source: savedStatus !== 'unknown' ? saveSource : null,
        },
        prerequisites: reqs,
        materials,
        relatedSteps: links,
        places: [...questPlaces(q), ...materials.flatMap((m) => m.hints.flatMap((h) => h.places))],
        sources: [
          dataSource('quest', q.id, 'description', q.description || ''),
          ...(saveSource && savedStatus !== 'unknown' ? [saveSource] : []),
          ...goals.map((g) => ({ type: 'user', id: g.id, field: 'goals', excerpt: g.title || '' })),
        ],
        navigation: [
          nav('world-quest', q.id),
          ...(q.parentId && byGameId.has(q.parentId)
            ? [nav('world-quest', byGameId.get(q.parentId).id)]
            : []),
        ],
        unknowns: [
          uncertainty('acceptance-unknown', '任务可接取与执行条件须在游戏中核对，资料关联不证明已解锁。'),
          uncertainty('npc-location-unknown', '人物当前所在位置与剧情阶段未知，场景布置仅是资料线索。'),
          ...(reqs.length
            ? [
                uncertainty(
                  'requirement-semantics-unknown',
                  'requirements.value 保留原始值；这里未将它解释为存档 step 或解锁条件。',
                ),
              ]
            : []),
          ...(materials.length
            ? [
                uncertainty(
                  'quest-allocation-unknown',
                  '存档持有量不是此任务可用量；请在任务物资页核对预留与缺料。',
                ),
              ]
            : []),
        ],
      });
    }

    // Budget quantities are authoritative only when produced from the exact
    // selected read. Without it, derive requirements but leave deficits null.
    let craftPlans = budgetBound && Array.isArray(budget.crafts) ? budget.crafts : null;
    if (!craftPlans) {
      const selectedPlan = (profile.craftPlans || []).find((p) => p.id === profile.activeCraftPlanId);
      craftPlans = [];
      const active = (p) => {
        const linked = (profile.goals || []).filter(
          (g) => g.source?.type === 'planner' && g.source.id === p.id,
        );
        return p.done !== true && p.reserved !== false && (!linked.length || linked.some((g) => !g.done));
      };
      if (
        profile.reserveCraftDraft !== false &&
        (profile.craftList || []).length &&
        (!selectedPlan || active(selectedPlan))
      )
        craftPlans.push({
          id: selectedPlan?.id || '@draft',
          name: selectedPlan?.name || '当前制作清单',
          list: profile.craftList,
        });
      for (const p of profile.craftPlans || [])
        if (p.id !== selectedPlan?.id && active(p)) craftPlans.push(p);
      const requested = new Map();
      for (const g of profile.goals || [])
        if (!g.done && g.source?.type === 'database' && entries.get(g.source.id)?.kind === '配方')
          requested.set(g.source.id, (requested.get(g.source.id) || 0) + (g.source.quantity || 1));
      const draft = new Map(
        (profile.reserveCraftDraft !== false && (!selectedPlan || active(selectedPlan))
          ? profile.craftList || []
          : []
        ).map((line) => [line.id, line.quantity]),
      );
      const goalList = [...requested]
        .map(([id, quantity]) => ({ id, quantity: Math.max(0, quantity - (draft.get(id) || 0)) }))
        .filter((line) => line.quantity > 0);
      if (goalList.length) craftPlans.push({ id: '@recipe-goals', name: '制作目标', list: goalList });
    }
    function knownProcessing(plan) {
      const processing = budgetBound && plan.processing;
      return processing &&
        processing.inventoryAvailable === true &&
        Array.isArray(processing.stages) &&
        Array.isArray(processing.rawMaterials) &&
        Array.isArray(processing.decisions)
        ? processing
        : null;
    }
    function processingActions(plan, materialActionIds) {
      const processing = knownProcessing(plan);
      if (!processing) return;
      const provenance = {
        type: 'budget',
        id: plan.id,
        field: 'crafts.processing',
        excerpt: '',
        ...snapshot,
      };
      for (const raw of processing.rawMaterials) {
        if (!entries.has('item-' + raw.id) || !safeCount(raw.missing) || raw.missing === 0) continue;
        const hints = itemHints([raw.id]);
        const row = addAction('material', [plan.id, 'processing-raw', raw.id], {
          title: `补充加工原料：${raw.name} × ${raw.missing}`,
          detail: `为${plan.name}补齐这份原料，再按加工顺序制作。数量已经合并这份计划的原料需求。`,
          ownerId: plan.id,
          ownerName: plan.name,
          material: {
            name: raw.name,
            ids: [raw.id],
            count: raw.missing,
            missing: raw.missing,
            allocationKnown: true,
            allocation: [],
            scope: 'processing-raw',
            alternatives: false,
            hints,
            onHand: inventory.get(raw.id) || 0,
          },
          progress: { status: 'materials-missing', label: '按加工安排的原料缺口', source: saveSource },
          places: hints.flatMap((h) => h.places),
          sources: [
            saveSource,
            provenance,
            sourceForUser(plan.id, 'craftPlans'),
            ...raw.sources.map((s) => dataSource('database', s.recipeId, 'materials', raw.name)),
          ],
          navigation: hints.map((h) => h.navigation),
          unknowns: [
            uncertainty(
              'processing-route-conditional',
              '按已确定的配方与保守产量展开；待选配方、循环与随机产出仍须在备料页核对。',
            ),
            uncertainty('acquisition-current-unknown', '获取地点是资料线索，当前可达性、刷新和库存未知。'),
          ],
        });
        materialActionIds.push(row.id);
      }
      const alternatives = new Map();
      for (const decision of processing.decisions) {
        if (!Array.isArray(decision.alternatives) || !safeCount(decision.count) || !decision.count) continue;
        const ids = [...new Set(decision.alternatives)].sort((a, b) => a - b);
        if (!ids.length || ids.some((id) => !entries.has('item-' + id))) continue;
        const key = ids.join(',');
        const group = alternatives.get(key) || { ids, name: decision.name, count: 0 };
        group.count += decision.count;
        alternatives.set(key, group);
      }
      for (const group of alternatives.values()) {
        if (!safeCount(group.count)) continue;
        const hints = itemHints(group.ids);
        const row = addAction('material', [plan.id, 'processing-alternatives', group.ids], {
          title: `补充 ${group.count} 份${group.name}`,
          detail: `为${plan.name}补足组内总量即可，可组合使用这些材料。`,
          ownerId: plan.id,
          ownerName: plan.name,
          material: {
            ...group,
            missing: group.count,
            allocationKnown: true,
            allocation: [],
            scope: 'processing-raw',
            alternatives: true,
            hints,
            onHand: group.ids.reduce((sum, id) => sum + (inventory.get(id) || 0), 0),
          },
          progress: { status: 'materials-missing', label: '加工安排中的可替代材料缺口', source: saveSource },
          places: hints.flatMap((h) => h.places),
          sources: [saveSource, provenance, sourceForUser(plan.id, 'craftPlans')],
          navigation: hints.map((h) => h.navigation),
          unknowns: [
            uncertainty('alternatives', '补足这一组的总量即可，不需要每种都收集。'),
            uncertainty('acquisition-current-unknown', '获取地点是资料线索，当前可达性、刷新和库存未知。'),
          ],
        });
        materialActionIds.push(row.id);
      }
      processing.stages.forEach((step, index) => {
        if (step.final || !entries.has(step.id) || !safeCount(step.quantity) || step.quantity === 0) return;
        addAction('craft', [plan.id, 'processing', step.id, index], {
          title: `先加工 ${index + 1}：${step.name} × ${step.quantity}`,
          detail: `${plan.name}的加工顺序。先补齐原料，再完成前面的加工；计划产物不是当前库存。`,
          ownerId: plan.id,
          ownerName: plan.name,
          recipeId: step.id,
          materialActionIds: [...materialActionIds],
          processingStep: structuredClone(step),
          recipe: {
            name: step.name,
            quantity: step.quantity,
            level: step.level,
            money: step.money,
            learned: step.learned,
            results: structuredClone(entries.get(step.id).results || []),
            learningItems: [],
          },
          progress: {
            status: 'planned',
            label: step.materialsAvailableNow ? '已分配真实原料 · 待制作' : '还需前序加工或补料',
            source: saveSource,
          },
          prerequisites: [
            {
              label: '配方学习记录',
              observed: step.learned,
              satisfied: step.learned,
              source: step.learned === null ? null : saveSource,
            },
            {
              label: '制作等级、制作地点与当前交互须游戏内核对',
              satisfied: null,
              source: dataSource('database', step.id, 'level', String(step.level)),
            },
          ],
          sources: [
            saveSource,
            provenance,
            dataSource('database', step.id, 'materials', step.name),
            sourceForUser(plan.id, 'craftPlans'),
          ],
          navigation: [nav('database-detail', step.id)],
          unknowns: [
            uncertainty(
              'processing-execution-unknown',
              '此行动只是安排加工，不会替你完成游戏制作或增加背包数量；学习、等级及材料须在游戏内确认。',
            ),
          ],
        });
      });
    }
    for (const plan of craftPlans) {
      const recipes = (plan.list || []).flatMap((line) => {
        const recipe = entries.get(line.id);
        return recipe?.kind === '配方' &&
          Number.isSafeInteger(line.quantity) &&
          line.quantity > 0 &&
          line.quantity <= 300000
          ? [{ recipe, quantity: line.quantity }]
          : [];
      });
      const groups = new Map();
      for (const { recipe, quantity } of recipes)
        for (const material of recipe.materials || []) {
          const ids = [...new Set(material.alternatives || [material.id])].sort((a, b) => a - b),
            key = ids.join(',');
          if (
            !ids.length ||
            ids.some((id) => !entries.has(`item-${id}`)) ||
            !safeCount(material.count * quantity)
          )
            continue;
          if (!groups.has(key))
            groups.set(key, { ids, name: material.name, count: 0, descriptions: [], recipes: [] });
          const group = groups.get(key);
          group.count += material.count * quantity;
          if (material.description) group.descriptions.push(material.description);
          group.recipes.push({
            id: recipe.id,
            name: recipe.name,
            quantity,
            count: material.count * quantity,
          });
        }
      const materialActionIds = [];
      for (const group of groups.values()) {
        const granted =
          budgetBound &&
          (plan.materials || []).find(
            (m) => Array.isArray(m.ids) && [...m.ids].sort((a, b) => a - b).join(',') === group.ids.join(','),
          );
        const allocationKnown = !!(
          granted &&
          granted.count === group.count &&
          safeCount(granted.missing) &&
          granted.missing <= group.count &&
          Array.isArray(granted.allocation) &&
          granted.allocation.every((a) => group.ids.includes(a.id) && safeCount(a.count)) &&
          granted.allocation.reduce((sum, a) => sum + a.count, 0) === group.count - granted.missing
        );
        const missing = allocationKnown ? granted.missing : null;
        // The expanded route supplies the procurement endpoints once. Direct
        // shortages may be produced by earlier stages and must not become a
        // second purchase request. Keep prepared and unknown rows inspectable.
        if (missing > 0 && knownProcessing(plan)) continue;
        const hints = itemHints(group.ids);
        const row = addAction('material', [plan.id, group.ids], {
          title:
            missing === null
              ? `核对备料：${group.name}`
              : missing === 0
                ? `备料已齐：${group.name}`
                : `补充 ${missing} 份${group.name}`,
          detail: group.descriptions.join('；') || `为${plan.name || '制作计划'}准备材料。`,
          ownerId: plan.id,
          ownerName: plan.name,
          material: {
            ...group,
            missing,
            allocationKnown,
            allocation: allocationKnown ? structuredClone(granted.allocation) : [],
            onHand: inventoryKnown ? group.ids.reduce((sum, id) => sum + (inventory.get(id) || 0), 0) : null,
            alternatives: group.ids.length > 1,
            hints,
          },
          progress: {
            status: missing === null ? 'unknown' : missing === 0 ? 'materials-ready' : 'materials-missing',
            label: missing === null ? '可用库存待核对' : missing === 0 ? '预算已分配足量材料' : '预算有缺料',
            source: allocationKnown ? saveSource : null,
          },
          places: hints.flatMap((h) => h.places),
          sources: [
            ...group.recipes.map((r) => dataSource('database', r.id, 'materials', group.name)),
            ...(allocationKnown
              ? [
                  saveSource,
                  { type: 'budget', id: plan.id, field: 'crafts.materials', excerpt: '', ...snapshot },
                ]
              : []),
            { type: 'user', id: plan.id, field: 'craftPlans', excerpt: plan.name || '' },
          ],
          navigation: [
            ...group.recipes.map((r) => nav('database-detail', r.id)),
            ...hints.map((h) => h.navigation),
          ],
          unknowns: [
            uncertainty(
              'acquisition-current-unknown',
              '获取地点来自物品说明；当前资源刷新、可达性和商店库存未知。',
            ),
            ...(group.ids.length > 1
              ? [uncertainty('alternatives', '这些物品可共同满足一个材料组，不需要每种都收集。')]
              : []),
            ...(!allocationKnown
              ? [uncertainty('material-budget-unknown', '该材料组没有可验证的当前分配，不能宣称缺料数量。')]
              : []),
          ],
        });
        materialActionIds.push(row.id);
      }
      processingActions(plan, materialActionIds);
      for (const { recipe, quantity } of recipes) {
        const learnedField = {
          fusion: 'fusionRecipes',
          alchemy: 'alchemyRecipes',
          cooking: 'cookingRecipes',
        }[recipe.recipeType];
        const learned = Array.isArray(selected?.metadata?.[learnedField])
          ? selected.metadata[learnedField].includes(recipe.gameId)
          : null;
        addAction('craft', [plan.id, recipe.id], {
          title: craftTitle(recipe, quantity),
          detail: recipe.description || '',
          ownerId: plan.id,
          ownerName: plan.name,
          recipeId: recipe.id,
          craftPlanId: profile.craftPlans?.some((saved) => saved.id === plan.id) ? plan.id : null,
          materialActionIds,
          recipe: {
            name: recipe.name,
            quantity,
            level: recipe.level,
            money: recipe.money * quantity,
            learned,
            results: structuredClone(recipe.results || []),
            learningItems: (recipe.learningItems || []).map((id) => nav('database-detail', `item-${id}`)),
          },
          progress: { status: 'planned', label: '用户制作计划', source: null },
          prerequisites: [
            {
              label: '配方学习记录',
              observed: learned,
              satisfied: learned,
              source: learned === null ? null : saveSource,
            },
            {
              label: `${recipe.craft || recipe.type}资料等级 ${recipe.level}；当前技能与制作地点须游戏内核对`,
              satisfied: null,
              source: dataSource('database', recipe.id, 'level', String(recipe.level)),
            },
          ],
          sources: [
            dataSource('database', recipe.id, 'materials', recipe.name),
            sourceForUser(plan.id, 'craftPlans'),
          ],
          navigation: [nav('database-detail', recipe.id)],
          unknowns: [
            uncertainty(
              'craft-execution-unknown',
              '材料齐备不代表能够制作；配方学习、生活技能、铜钱和制作交互须在游戏内确认。',
            ),
          ],
        });
      }
    }
    for (const goal of profile.goals || [])
      if (!goal.done && goal.source?.type === 'database' && entries.get(goal.source.id)?.kind === '物品') {
        const item = entries.get(goal.source.id),
          count = goal.source.quantity || 1,
          hints = itemHints([item.gameId]);
        addAction('collection', [goal.id, item.id], {
          title: `收集目标：${item.name} × ${count}`,
          detail: goal.detail || item.description || '',
          goalIds: [goal.id],
          progress: { status: 'manual', label: '用户收集目标', source: null },
          material: {
            ids: [item.gameId],
            count,
            onHand: inventoryKnown ? inventory.get(item.gameId) || 0 : null,
            missing: null,
            hints,
          },
          places: hints.flatMap((h) => h.places),
          navigation: [nav('database-detail', item.id)],
          sources: [
            sourceForUser(goal.id),
            dataSource('database', item.id, 'description', item.description || ''),
          ],
          unknowns: [
            uncertainty(
              'collection-availability-unknown',
              '资料获取线索不证明当前可获得；库存与其他计划的用量须另行核对。',
            ),
          ],
        });
      }
    for (const goal of profile.goals || [])
      if (
        !goal.source ||
        !['quest', 'planner', 'database'].includes(goal.source.type) ||
        (goal.source.type === 'database' && !['物品', '配方'].includes(entries.get(goal.source.id)?.kind))
      )
        addAction('goal', [goal.id], {
          title: goal.title,
          detail: goal.detail || '',
          goalIds: [goal.id],
          userDone: goal.done === true,
          progress: { status: 'manual', label: '个人目标', source: null },
          sources: [sourceForUser(goal.id)],
          navigation: [{ action: 'journey-goal', id: goal.id }],
          unknowns: [
            uncertainty('personal-goal-location-unknown', '个人目标尚未绑定地点，可创建带地点的个人待办。'),
          ],
        });
    for (const p of state.places)
      addAction('place', [p.placeId], {
        title: `地点目标：${maps.get(p.placeId).name}`,
        detail: p.note,
        userDone: p.done,
        favorite: p.favorite,
        progress: { status: 'manual', label: '用户地点目标', source: null },
        sources: [sourceForUser(p.placeId)],
        places: explicitPlace(p.placeId, sourceForUser(p.placeId)),
        navigation: [nav('world-place', p.placeId)],
      });
    for (const t of state.todos)
      addAction('todo', [t.id], {
        title: t.title,
        detail: t.detail,
        userDone: t.done,
        progress: { status: 'manual', label: '个人待办', source: null },
        sources: [sourceForUser(t.id)],
        places: explicitPlace(t.placeId, sourceForUser(t.id)),
        navigation: [{ action: 'journey-todo', id: t.id }],
      });
    for (const g of [...state.gifts].sort((a, b) => a.id.localeCompare(b.id))) {
      const item = entries.get(g.itemId),
        person = entries.get(g.npcId) || worldIndex.people.find((p) => p.id === g.npcId);
      const matchingRows =
        budgetBound && Array.isArray(budget.gifts) ? budget.gifts.filter((row) => row.id === g.id) : [];
      const granted = matchingRows.length === 1 ? matchingRows[0] : null;
      const allocationKnown = !!(
        granted &&
        granted.npcId === g.npcId &&
        granted.itemId === g.itemId &&
        granted.quantity === g.quantity &&
        granted.inventoryAvailable === true &&
        safeCount(granted.allocated) &&
        safeCount(granted.missing) &&
        granted.allocated + granted.missing === g.quantity
      );
      const allocated = allocationKnown ? granted.allocated : null;
      addAction('gift', [g.id], {
        title: `赠礼意图：${giftPersonLabel(person, gameIndex.entries)} · ${giftItemLabel(item)} × ${g.quantity}`,
        detail: g.note,
        userDone: g.done,
        gift: {
          npcId: g.npcId,
          itemId: g.itemId,
          quantity: g.quantity,
          available: allocated,
          allocated,
          missing: allocationKnown ? granted.missing : null,
          allocationKnown,
          enough: allocated === null ? null : allocated >= g.quantity,
        },
        progress: { status: 'manual', label: '用户赠礼意图', source: allocationKnown ? saveSource : null },
        sources: [
          sourceForUser(g.id),
          dataSource('database', g.npcId, 'hobbies', (person.hobbies || []).join('、')),
          ...(allocationKnown
            ? [saveSource, { type: 'budget', id: g.id, field: 'gifts', excerpt: '', ...snapshot }]
            : []),
        ],
        places: explicitPlace(g.placeId, sourceForUser(g.id)),
        navigation: [nav('database-detail', g.npcId), nav('database-detail', g.itemId)],
        unknowns: [
          uncertainty(
            'gift-execution-unknown',
            '赠礼只是一项用户意图；当前人物位置、可赠礼与实际好感变化须游戏内确认。',
          ),
          uncertainty(
            'gift-execution-not-consumed',
            '这是统一资源预算为此意图分配的物品，不代表已经赠送或消费游戏库存。',
          ),
          ...(!allocationKnown
            ? [
                uncertainty(
                  'gift-budget-unknown',
                  '当前统一预算没有此赠礼意图的可核对分配；可用量与缺量未知。',
                ),
              ]
            : []),
        ],
      });
    }
    // An action may appear in multiple location groups. They are alternative
    // evidence views of the same stable action, not repeated collection orders.
    const pending = (a) => !a.handled && !a.userDone && !a.gameComplete && !a.prepared;
    const routes = new Map();
    for (const a of actions)
      for (const p of a.places) {
        if (!routes.has(p.name))
          routes.set(p.name, {
            id: stableId('route', [p.name]),
            name: p.name,
            mapIds: [],
            actionIds: [],
            favorite: state.places.some((r) => r.favorite && maps.get(r.placeId).name === p.name),
            sources: [],
            navigation: [],
          });
        const r = routes.get(p.name);
        for (const id of p.mapIds)
          if (!r.mapIds.includes(id)) {
            r.mapIds.push(id);
            r.navigation.push(nav('world-place', id));
          }
        if (!r.actionIds.includes(a.id)) r.actionIds.push(a.id);
        if (!r.sources.some((s) => JSON.stringify(s) === JSON.stringify(p.source))) r.sources.push(p.source);
      }
    const grouped = [...routes.values()]
      .map((r) => ({
        ...r,
        ambiguous: r.mapIds.length > 1,
        pendingCount: r.actionIds.filter((id) => pending(actions.find((a) => a.id === id))).length,
        label: r.mapIds.length > 1 ? '同名场景候选，需核对剧情阶段' : '按资料线索或用户地点组织',
        ordering: 'unordered',
        availability: 'unknown',
      }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, 'zh-CN'));
    let itinerary = null;
    if (state.itinerary) {
      const current = new Map(actions.map((a) => [a.id, a]));
      const steps = state.itinerary.steps.map((choice, position) => {
        let action = current.get(choice.actionId);
        let status = 'pending',
          reason = '依你的顺序继续这项行动。',
          completionSource = null;
        // Some quest actions leave the all-actions view once a parent closes.
        // Only explicit selected-save records support automatic advancement.
        const historicalQuest = choice.actionId.startsWith('journey:quest:')
          ? choice.sources.find((s) => s.type === 'quest' && choice.actionId === stableId('quest', [s.id]))
          : null;
        const sourceQuest = historicalQuest && quests.get(historicalQuest.id);
        const q = sourceQuest && choice.actionId === stableId('quest', [sourceQuest.id]) ? sourceQuest : null;
        let completedQuest =
          q &&
          choice.progressMode === 'save' &&
          recordsKnown &&
          (stepStatus(records.get(q.gameId)) === 'complete' ? q : completedAncestor(q, records));
        const ownerPointers = choice.sources.filter((s) => s.type === 'user' && s.field === 'goals');
        const owners = ownerPointers.flatMap((s) => {
          const goal = (profile.goals || []).find((g) => g.id === s.id && g.source?.type === 'quest');
          const root = goal && quests.get(goal.source.id);
          return root && q && descendants(root).some((step) => step.id === q.id) ? [goal] : [];
        });
        const ownerRemoved = ownerPointers.length > 0 && !owners.length;
        const ownerDone = owners.length > 0 && owners.every((g) => g.done === true);
        let continuation = null;
        let progressConflict =
          q &&
          choice.progressMode === 'save' &&
          recordsKnown &&
          !completedQuest &&
          !owners.some((g) => g.progressMode === 'manual')
            ? blockedQuest(q, records)
            : null;
        const conflictMessage = (conflict) =>
          `此参照记录「${conflict.quest.name}」${conflict.status === 'failed' ? '已失败' : '尚未接取'}；原选择与顺序保留，暂不接续其他步骤，请在游戏中核对任务。`;
        const warnConflict = (conflict) => {
          const message = conflictMessage(conflict);
          if (!warnings.some((w) => w.code === 'conflicting-quest-records' && w.message === message))
            warnings.push(uncertainty('conflicting-quest-records', message));
        };
        if (progressConflict) {
          action = null;
          warnConflict(progressConflict);
        }
        if (
          q &&
          choice.progressMode === 'save' &&
          recordsKnown &&
          !ownerRemoved &&
          !ownerDone &&
          !progressConflict &&
          !completedAncestor(q, records) &&
          stepStatus(records.get(rootQuest(q).gameId)) !== 'complete' &&
          !owners.some((g) => g.progressMode === 'manual')
        ) {
          const family = descendants(rootQuest(q));
          const activeCandidates = actions.filter(
            (a) =>
              a.kind === 'quest' &&
              a.questId !== q.id &&
              !a.userDone &&
              !a.gameComplete &&
              a.progress?.status === 'active' &&
              family.some((step) => step.id === a.questId) &&
              !descendants(quests.get(a.questId)).some(
                (step) => step.id !== a.questId && stepStatus(records.get(step.gameId)) === 'active',
              ),
          );
          const conflicts = activeCandidates.flatMap((a) => {
            const conflict = blockedQuest(quests.get(a.questId), records);
            return conflict ? [{ id: a.id, conflict }] : [];
          });
          const candidates = activeCandidates.filter((a) => !conflicts.some((c) => c.id === a.id));
          for (const { conflict } of conflicts) warnConflict(conflict);
          if (conflicts.length && !candidates.length) {
            progressConflict = conflicts[0].conflict;
            action = null;
          }
          // A persisted parent is an intention, not a frozen execution step.
          // Sibling steps require explicit choice unless PreQuest establishes
          // a known successor. Multiple active branches are never auto-picked.
          const descendantIds = new Set(
            descendants(q)
              .slice(1)
              .map((step) => step.id),
          );
          const samePlace = (a) =>
            choice.placeId === undefined
              ? !a.places.length
              : a.places.some((p) => p.mapIds.includes(choice.placeId));
          const confirmed = candidates.find((a) => a.id === choice.continuationId);
          const previousChoice = family.find(
            (step) => stableId('quest', [step.id]) === choice.continuationId,
          );
          const only = activeCandidates.length === 1 && candidates.length === 1 ? candidates[0] : null;
          const automatic =
            only &&
            samePlace(only) &&
            (descendantIds.has(only.questId) || followsQuest(quests.get(only.questId), q)) &&
            (!previousChoice ||
              descendants(previousChoice).some((step) => step.id === only.questId) ||
              followsQuest(quests.get(only.questId), previousChoice));
          if (
            candidates.length &&
            (!action ||
              candidates.some((a) => descendantIds.has(a.questId)) ||
              action.gameComplete ||
              confirmed)
          ) {
            const nextAction =
              confirmed && (choice.placeId === undefined || samePlace(confirmed))
                ? confirmed
                : automatic
                  ? only
                  : null;
            continuation = {
              kind: nextAction ? (confirmed ? 'selected' : 'automatic') : 'choice-required',
              originQuestId: q.id,
              currentQuestId: nextAction?.questId || null,
              candidates: candidates.map((a) => ({
                actionId: a.id,
                title: a.title,
                placeIds: [...new Set(a.places.flatMap((p) => p.mapIds))],
              })),
            };
            action = nextAction || null;
            completedQuest = null;
            if (nextAction) {
              reason = `接续同一任务的当前步骤「${nextAction.title}」；保留原选择、顺序与场景，未记为游戏完成。`;
            }
          }
        }
        const completedPlan =
          !action &&
          profile.craftPlans?.find(
            (plan) =>
              plan.done === true &&
              choice.sources.some(
                (source) =>
                  source.type === 'user' &&
                  source.id === plan.id &&
                  (source.field === 'craftPlans' ||
                    (source.field === 'journey' &&
                      plan.list.some((line) => choice.actionId === stableId('craft', [plan.id, line.id])))),
              ),
          );
        const candidates = action ? [...new Set(action.places.flatMap((p) => p.mapIds))] : [];
        const handledActionId = action?.id || (continuation ? null : choice.actionId);
        const place = maps.get(choice.placeId);
        const placePending = choice.placeId === undefined && candidates.length > 0;
        const placeLabel =
          choice.placeId !== undefined
            ? `${place?.name || '原场景 ' + choice.placeId} · 场景 #${choice.placeId.slice(6)}`
            : placePending
              ? `${[...new Set(action.places.map((p) => p.name))].join('、')} · 场景待核定`
              : '未分组事项';
        const placeChanged = !!action && choice.placeId !== undefined && !candidates.includes(choice.placeId);
        if (choice.skipped) {
          status = 'skipped';
          reason = '你只跳过了本次行程中的这一项；全部行动的待处理状态不变，可撤回。';
        } else if (action?.gameComplete || completedQuest) {
          status = 'game-complete';
          reason =
            completedQuest && completedQuest.id !== q.id
              ? `此参照已记录上级任务「${completedQuest.name}」完成；原行动保留，打开旧档会重新核对。`
              : '此存档参照已记录游戏任务完成；原选择保留，打开旧档会重新核对。';
          completionSource = saveSource;
        } else if (action?.userDone || completedPlan || ownerDone) {
          status = 'user-done';
          reason = completedPlan
            ? '你已将关联的整份制作计划记为完成，已释放它的用料；重新打开计划可恢复。未推断游戏已制作。'
            : '你已将关联的个人目标或待办记为完成；在原记录中撤回后会恢复。';
        } else if (handled.has(handledActionId)) {
          status = 'handled';
          reason = '你已将这项行动记为个人已处理；这不是游戏完成，可撤回。';
        } else if (progressConflict) {
          status = 'unavailable';
          reason = conflictMessage(progressConflict);
        } else if (action?.prepared) {
          status = 'prepared';
          reason = '同一存档参照的统一预算已分配足量材料；不表示已制作或已消耗。';
        } else if (continuation?.kind === 'choice-required') {
          status = 'unavailable';
          reason =
            continuation.candidates.length > 1
              ? '同一任务有多个进行中的步骤；原顺序与场景保留，请明确选择这次要接着办的步骤。'
              : '同一任务已进入新步骤，但原场景不再匹配或接续关系需确认；请选择步骤与本次场景。';
        } else if (!action) {
          status = 'unavailable';
          reason =
            '原行动已不在当前清单中，可能是目标、资料或材料需求变化；未推断为游戏完成。请核对来源，或仅本次跳过。';
        } else if (placeChanged || (choice.placeId !== undefined && !place)) {
          status = 'unavailable';
          reason = '原先选择的场景已不在这项行动的当前地点线索中；仍保留你的选择，请核对或更换场景。';
        }
        if (placePending && status === 'pending')
          reason += ' 地点线索已保留，具体场景可稍后核定；未替你猜选编号。';
        return {
          actionId: choice.actionId,
          position,
          selectedTitle: choice.title,
          title: action?.title || choice.title,
          status,
          reason,
          skipped: choice.skipped,
          handled: handled.has(handledActionId),
          handledActionId: action?.id || choice.actionId,
          placePending,
          placeLabel,
          selectedPlace:
            choice.placeId === undefined
              ? null
              : {
                  id: choice.placeId,
                  name: place?.name || `原场景 ${choice.placeId}`,
                  key: place?.key || '',
                },
          sources: action ? structuredClone(action.sources) : structuredClone(choice.sources),
          selectionSources: structuredClone(choice.sources),
          completionSource,
          action: action || null,
          continuation,
          craftPlanId: action?.craftPlanId || completedPlan?.id || null,
          needsReview: status === 'unavailable',
          pending: ['pending', 'unavailable'].includes(status),
        };
      });
      const remaining = steps.filter((s) => s.pending);
      const summary = { total: steps.length, remaining: remaining.length };
      for (const status of [
        'pending',
        'unavailable',
        'skipped',
        'game-complete',
        'user-done',
        'handled',
        'prepared',
      ])
        summary[status] = steps.filter((s) => s.status === status).length;
      itinerary = {
        name: state.itinerary.name,
        status: state.itinerary.status,
        steps,
        next: remaining[0] || null,
        upcoming: remaining.slice(1),
        summary,
        reference: snapshot,
        notice: '按你选择的行动与场景顺序续接，不代表最优路线、当前所在地或场景可达性。',
      };
    }
    return {
      schema: 1,
      profileId: profile.id,
      build: worldIndex.build,
      reference: snapshot,
      recordsKnown,
      inventoryKnown,
      budgetBound,
      goalProgress,
      actions,
      routes: grouped,
      itinerary,
      unplacedActionIds: actions.filter((a) => !a.places.length).map((a) => a.id),
      warnings,
      summary: {
        total: actions.length,
        pending: actions.filter(pending).length,
        prepared: actions.filter((a) => a.prepared).length,
        gameComplete: actions.filter((a) => a.gameComplete).length,
        userDone: actions.filter((a) => a.userDone).length,
        handled: actions.filter((a) => a.handled).length,
      },
      notice:
        '这是存档进度与本机资料线索组成的行动计划；地点分组不表示最佳路线、人物当前所在地、可接取、可达或商店现货。',
    };
  }
  return { journeyPlan };
}

module.exports = { ...createJourneyPlanner({ world, game }), createJourneyPlanner, stableId };
