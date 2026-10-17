const countText = (value) => Number(value).toLocaleString('zh-CN');
const questLabels = ['尚未开始', '进行中', '已失败', '尚未接取', '已完成'];

// Only evaluate fields supplied by this reading. Missing native counters,
// contribution and effective friendship never become fabricated zeroes.
export function completionChecks(requirements = [], reading = {}) {
  const inventory = Array.isArray(reading.inventory) ? new Map() : null;
  for (const item of inventory ? reading.inventory : [])
    if (Number.isSafeInteger(item.count) && item.count >= 0)
      inventory.set(item.id, (inventory.get(item.id) || 0) + item.count);
  const quests = Array.isArray(reading.questStates || reading.quests)
    ? new Map((reading.questStates || reading.quests).map((row) => [row.id, row.step]))
    : null;
  const live = reading.questsComplete === true;
  return requirements.map((requirement) => {
    const { type, id, value, name } = requirement;
    let text = name || '剧情要求',
      status = 'unknown',
      hint = '',
      partyName = '';
    if (type === 'Item') {
      text = `${name} × ${countText(value)}`;
      if (inventory) status = (inventory.get(id) || 0) >= value ? 'met' : 'unmet';
    } else if (type === 'Money') {
      const minimum = requirement.comparison === 'gt' ? Math.floor(value) + 1 : value;
      text = `铜钱至少 ${countText(minimum)} 文`;
      if (Number.isFinite(reading.money)) status = reading.money >= minimum ? 'met' : 'unmet';
      hint =
        status === 'unmet' ? `还需 ${countText(minimum - reading.money)} 文` : `需 ${countText(minimum)} 文`;
    } else if (type === 'TeamMember') {
      text = `需${name}在队`;
      if (Array.isArray(reading.teamIds))
        status = (requirement.ids || [id]).some((npcId) => reading.teamIds.includes(npcId)) ? 'met' : 'unmet';
      partyName = name;
    } else if (type === 'PreQuest') {
      const step = quests?.get(id) ?? (live && quests ? 0 : undefined);
      text = `${name}：需${questLabels[value] || '对应剧情状态'}`;
      if (step !== undefined) status = step === value ? 'met' : 'unmet';
    } else if (type === 'NoQuest') {
      text = `${name}：尚未触发`;
      if (quests?.has(id)) status = 'unmet';
      else if (live && quests) status = 'met';
    } else if (type === 'AggregationItem') {
      text = `${name}：任选一种 × ${countText(value)}`;
      // All currently published aggregation hand-ins require one item. Larger
      // custom quantities need separately verified aggregate-count semantics.
      if (inventory && value === 1 && requirement.alternatives?.length)
        status = requirement.alternatives.some((item) => (inventory.get(item.id) || 0) >= 1)
          ? 'met'
          : 'unmet';
      hint = status === 'unmet' ? `先准备${name}中的任一种` : text;
    } else if (type === 'GuildHonor') text = `${name}至少 ${countText(value)}`;
    else if (type === 'KillMonster' || type === 'KillMonsterAggre')
      text = `击败${name} × ${countText(value)}`;
    else if (type === 'Friendliness') text = `${name}好感至少 ${countText(value)}`;
    return {
      ...requirement,
      text,
      status,
      hint: hint || text,
      ...(partyName ? { partyName } : {}),
      ...(requirement.alternatives
        ? {
            alternatives: requirement.alternatives.map((item) => ({
              ...item,
              owned: inventory ? inventory.get(item.id) || 0 : null,
            })),
          }
        : {}),
    };
  });
}
