'use strict';
const { goalProgress, selectedReference } = require('./goal-progress.cjs');
const { resourceBudget, recipeGoalList, materialReport } = require('./resource-budget.cjs');
const { journeyPlan } = require('./journey-plan.cjs');
function companionSnapshot(state, catalog, reference, error = '') {
  const profile = state.profiles.find((p) => p.id === state.activeProfileId);
  reference = selectedReference(profile, reference, error);
  const progress = goalProgress(profile, reference, error);
  const allocations = resourceBudget(profile, reference, { error });
  const journey = journeyPlan(profile, reference, allocations);
  const allPendingActions = journey.actions.filter(
    (a) => !a.gameComplete && !a.userDone && !a.handled && !a.prepared,
  );
  const itinerary = journey.itinerary;
  const nextActions =
    itinerary?.status === 'active'
      ? itinerary.steps
          .filter((s) => s.pending)
          .map((s) => ({
            ...(s.action || { id: s.actionId, title: s.title, kind: 'review', unknowns: [s.reason] }),
            places: s.selectedPlace ? [{ name: s.selectedPlace.name }] : [],
          }))
      : allPendingActions;
  const goals = [...profile.goals]
    .filter((g) => !progress[g.id].done)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const recipeGoals = goals.filter(
    (g) => g.source?.type === 'database' && /^(fusion|alchemy|cooking)-/.test(g.source.id),
  );
  const goalRecipes = new Map();
  for (const goal of recipeGoals)
    goalRecipes.set(goal.source.id, (goalRecipes.get(goal.source.id) || 0) + (goal.source.quantity || 1));
  const namedGoal = goals.find((g) => g.source?.type === 'planner' && g.source.id !== 'current');
  const namedPlan = profile.craftPlans?.find((p) => p.id === namedGoal?.source.id);
  const selectedList = namedPlan
    ? namedPlan.list
    : profile.craftList?.length
      ? profile.craftList
      : [...goalRecipes].map(([id, quantity]) => ({ id, quantity }));
  const selectedPlan =
    namedPlan ||
    (profile.craftList?.length && profile.craftPlans?.find((p) => p.id === profile.activeCraftPlanId));
  const materialsCompleted = selectedPlan?.done === true;
  const list = materialsCompleted ? selectedList : recipeGoalList(profile, selectedList);
  let materials = null;
  try {
    if (list.length) {
      materials = materialReport(profile, reference, list, {
        error,
        aggregate: true,
        planId: namedPlan?.id || profile.activeCraftPlanId,
        excludeRecipeGoals: true,
      });
    }
  } catch (e) {
    error = e.message;
  }
  const hints = [];
  if (itinerary?.status === 'active' && itinerary.next)
    hints.push({
      type: 'journey',
      id: itinerary.next.actionId,
      title: `${itinerary.next.needsReview ? '需核对：' : '下一项：'}${itinerary.next.title}${itinerary.next.placePending ? ' · ' + itinerary.next.placeLabel : itinerary.next.selectedPlace ? ' · ' + itinerary.next.selectedPlace.name : ''}`,
      label: itinerary.name,
    });
  if (goals[0] && hints.length < 2)
    hints.push({
      type: 'goal',
      id: goals[0].id,
      title: goals[0].title,
      source: goals[0].source || null,
      label: '我的目标',
    });
  if (materials && !materialsCompleted && hints.length < 2) {
    const shortages = materials.materials.filter((m) => m.missing > 0).sort((a, b) => b.missing - a.missing);
    const first = shortages[0];
    const processingReady =
      materials.stages?.hasAllBaseIngredients === true && materials.stages.workRemaining.processing > 0;
    hints.push({
      type: 'material',
      id: first?.ids?.length === 1 ? `item-${first.ids[0]}` : null,
      title: !materials.inventoryAvailable
        ? '材料待核对 · 尚无可用背包参照'
        : processingReady
          ? `原料已齐 · 先加工 ${materials.stages.workRemaining.processing} 次，再制作成品${allocations.baseMaterialMissingTotal > 0 ? ' · 其他用途原料还缺 ' + allocations.baseMaterialMissingTotal + ' 件' : ''} · 核对配方与制作费`
          : first
            ? `${first.name}还缺 ${first.missing}${shortages.length > 1 ? ` · 另 ${shortages.length - 1} 类` : ''}`
            : materials.copperMissing > 0
              ? `铜钱还差 ${materials.copperMissing}`
              : allocations.baseMaterialMissingTotal > 0
                ? `当前清单材料已齐 · 全部计划原料仍缺 ${allocations.baseMaterialMissingTotal} 件`
                : materials.stages?.workRemaining.processing > 0
                  ? `原料已齐 · 还需加工 ${materials.stages.workRemaining.processing} 次，再制作成品`
                  : '当前清单材料已齐 · 制作等级与配方需另核对',
      label: selectedPlan ? '备料追踪 · ' + selectedPlan.name : '备料追踪',
    });
    if (allocations.moneySummary?.shortMessage)
      hints[hints.length - 1].title += ' · ' + allocations.moneySummary.shortMessage;
  }
  const personalAction = nextActions.find((a) => ['todo', 'gift', 'place'].includes(a.kind));
  if (hints.length < 2 && personalAction)
    hints.push({
      type: 'journey',
      id: personalAction.id,
      title: personalAction.title,
      label: '这一程的个人打算',
    });
  if (hints.length < 2 && profile.stageConfirmed === true) {
    const next = catalog.entries
      .filter((e) => e.checklist && !profile.checks[e.id] && e.stage <= profile.stage)
      .sort((a, b) => Number(!!b.checkpoint) - Number(!!a.checkpoint))[0];
    if (next) hints.push({ type: 'guide', id: next.id, title: next.title, label: '手动阶段清单' });
  }
  const metadata = reference?.metadata;
  const stepPriority = (id) =>
    id > 0 ? (id === metadata?.trackingQuest ? 0 : id === metadata?.trackingMainQuest ? 1 : 2) : 2;
  const includesTracked = (q, id) =>
    Number.isSafeInteger(id) &&
    id > 0 &&
    (q.id === id || (q.activeSteps || []).some((step) => step.id === id));
  const questPriority = (q) =>
    includesTracked(q, metadata?.trackingQuest) ? 0 : includesTracked(q, metadata?.trackingMainQuest) ? 1 : 2;
  const quests =
    !error && profile.referenceMode !== 'none'
      ? [...(metadata?.activeQuestFamilies || [])]
          .sort((a, b) => questPriority(a) - questPriority(b))
          .map((q) => ({
            id: q.id,
            name: q.name,
            steps: [...(q.activeSteps || [])]
              .sort((a, b) => stepPriority(a.id) - stepPriority(b.id))
              .map((step) => step.name),
          }))
      : [];
  for (const quest of quests) {
    if (hints.length >= 2) break;
    hints.push({
      type: 'quest',
      id: `quest-${quest.id}`,
      title: quest.steps[0] || quest.name,
      label: '存档中的进行中任务',
    });
  }
  if (!hints.length)
    hints.push({ type: 'help', title: '按 Ctrl＋Alt＋J 查人物、物品与任务', label: '随行查询' });
  return {
    profileId: profile.id,
    profileName: profile.name,
    goalProgress: progress,
    allocations,
    hints: hints.slice(0, 2),
    quests,
    materials,
    materialsLabel: selectedPlan ? selectedPlan.name : '当前制作清单与制作目标',
    materialsCompleted,
    nextActions: nextActions.slice(0, 6).map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      places: a.places.map((p) => p.name),
      unknowns: a.unknowns.length,
      material: a.material,
      gift: a.gift,
    })),
    journeySummary: journey.summary,
    itinerary,
    reference: reference
      ? {
          name: reference.name,
          modifiedAt: reference.modifiedAt,
          hash: reference.hash,
          mapName: reference.metadata.mapName,
        }
      : null,
    referenceMode: profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest'),
    referenceLabel:
      profile.referenceMode === 'none'
        ? '不读取游戏进度'
        : profile.saveSlot
          ? `固定参照 ${profile.saveSlot}`
          : '跟随最新有效存档',
    error,
  };
}
module.exports = { companionSnapshot };
