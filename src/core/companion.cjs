'use strict';
const { materialPlan } = require('./material-plan.cjs');
function companionSnapshot(state, catalog, reference, error = '') {
  const profile = state.profiles.find((p) => p.id === state.activeProfileId);
  const goals = [...profile.goals]
    .filter((g) => !g.done)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const recipeGoals = goals.filter(
    (g) => g.source?.type === 'database' && /^(fusion|alchemy|cooking)-/.test(g.source.id),
  );
  const goalRecipes = new Map();
  for (const goal of recipeGoals)
    goalRecipes.set(goal.source.id, (goalRecipes.get(goal.source.id) || 0) + (goal.source.quantity || 1));
  const list = profile.craftList?.length
    ? profile.craftList
    : [...goalRecipes].map(([id, quantity]) => ({ id, quantity }));
  let materials = null;
  try {
    if (list.length) materials = materialPlan(list, reference?.metadata || null, profile.reservations || {});
  } catch (e) {
    error = e.message;
  }
  const hints = [];
  if (goals[0])
    hints.push({
      type: 'goal',
      id: goals[0].id,
      title: goals[0].title,
      source: goals[0].source || null,
      label: '我的目标',
    });
  if (materials) {
    const shortages = materials.materials.filter((m) => m.missing > 0).sort((a, b) => b.missing - a.missing);
    const first = shortages[0];
    hints.push({
      type: 'material',
      id: first?.ids?.length === 1 ? `item-${first.ids[0]}` : null,
      title: !materials.inventoryAvailable
        ? '材料待核对 · 尚无可用背包参照'
        : first
          ? `${first.name}还缺 ${first.missing}${shortages.length > 1 ? ` · 另 ${shortages.length - 1} 类` : ''}`
          : materials.copperMissing > 0
            ? `铜钱还差 ${materials.copperMissing}`
            : '所需材料已齐 · 制作等级与配方需另核对',
      label: '备料追踪',
    });
  }
  if (hints.length < 2 && profile.stageConfirmed === true) {
    const next = catalog.entries
      .filter((e) => e.checklist && !profile.checks[e.id] && e.stage <= profile.stage)
      .sort((a, b) => Number(!!b.checkpoint) - Number(!!a.checkpoint))[0];
    if (next) hints.push({ type: 'guide', id: next.id, title: next.title, label: '手动阶段清单' });
  }
  if (!hints.length)
    hints.push({ type: 'help', title: '按 Ctrl＋Alt＋J 查人物、物品与任务', label: '随行查询' });
  return {
    profileId: profile.id,
    profileName: profile.name,
    hints: hints.slice(0, 2),
    materials,
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
