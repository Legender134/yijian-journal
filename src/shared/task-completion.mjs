const countText = (value) => Number(value).toLocaleString('zh-CN');
const questLabels = ['尚未开始', '进行中', '已失败', '尚未接取', '已完成'];

// Build 21798996 JumpStep dispatches EJumpQuestStepType handler events,
// not saved EQuestStep values. Dispatch alone does not prove completion.
export function questJumpEventText(value) {
  return Number.isInteger(value)
    ? ['发起接取', '确认接取', '拒绝接取', '触发推进', '触发结算'][value] || ''
    : '';
}

// Only evaluate fields supplied by this reading. Missing native counters,
// contribution and effective friendship never become fabricated zeroes.
export function completionChecks(requirements = [], reading = {}, questId) {
  const inventory = Array.isArray(reading.inventory) ? new Map() : null;
  for (const item of inventory ? reading.inventory : [])
    if (Number.isSafeInteger(item.count) && item.count >= 0)
      inventory.set(item.id, (inventory.get(item.id) || 0) + item.count);
  const quests = Array.isArray(reading.questStates || reading.quests)
    ? new Map((reading.questStates || reading.quests).map((row) => [row.id, row.step]))
    : null;
  const live = reading.questsComplete === true;
  let honors = null;
  if (Array.isArray(reading.guildHonors) && reading.guildHonors.length <= 10000) {
    const keys = new Set();
    if (
      reading.guildHonors.every(
        (row) =>
          row &&
          Number.isSafeInteger(row.id) &&
          row.id >= 0 &&
          row.id <= 1000000 &&
          Number.isSafeInteger(row.value) &&
          row.value >= -2147483648 &&
          row.value <= 2147483647 &&
          !keys.has(row.id) &&
          keys.add(row.id),
      )
    )
      honors = new Map(reading.guildHonors.map((row) => [row.id, row.value]));
  }
  const quest = (reading.questStates || reading.quests)?.find?.((row) => row.id === questId);
  return requirements.map((requirement) => {
    const { type, id, value, name } = requirement;
    let text = name || '剧情要求',
      status = 'unknown',
      hint = '',
      partyName = '',
      progress = null;
    if (type === 'Item') {
      text = `${name} × ${countText(value)}`;
      if (inventory) status = (inventory.get(id) || 0) >= value ? 'met' : 'unmet';
    } else if (type === 'ItemMax') {
      // Build 21798996: native enum 15 uses the same inventory sum as Item,
      // but returns true for count < Num, not count <= Num.
      text = value === 1 ? `${name}：未持有` : `${name}：数量少于 ${countText(value)}`;
      if (inventory) status = (inventory.get(id) || 0) < value ? 'met' : 'unmet';
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
    } else if (type === 'GuildHonor') {
      text = `${name}至少 ${countText(value)}`;
      if (honors && Number.isFinite(value) && value >= 0) {
        const current = honors.get(id) || 0;
        status = current >= value ? 'met' : 'unmet';
        progress = { current, total: value, remaining: Math.max(0, value - current) };
        text = name;
        hint = status === 'met' ? `${name}已达标` : `${name}还差 ${countText(progress.remaining)}`;
      }
    } else if (type === 'KillMonster' || type === 'KillMonsterAggre') {
      text = `击败${name} × ${countText(value)}`;
      // The pinned quest completion predicate matches BOTH requirement type
      // and Id inside THIS quest's tracked array, then compares Num >= target.
      // Absence is unknown, never zero; group IDs are not member NPC IDs.
      const enumType = type === 'KillMonster' ? 22 : 25;
      const matches =
        quest?.step === 1 && Array.isArray(quest.progress)
          ? quest.progress.filter((row) => row.type === enumType && row.id === id)
          : [];
      if (
        matches.length === 1 &&
        Number.isSafeInteger(matches[0].value) &&
        matches[0].value >= 0 &&
        matches[0].value <= 100000000 &&
        Number.isSafeInteger(value) &&
        value > 0
      ) {
        const current = matches[0].value;
        status = current >= value ? 'met' : 'unmet';
        text = `击败${name}`;
        progress = { current, total: value, remaining: Math.max(0, value - current) };
        hint = `击败${name}（${countText(current)}/${countText(value)}）`;
      }
    } else if (type === 'Friendliness') text = `${name}好感至少 ${countText(value)}`;
    return {
      ...requirement,
      text,
      status,
      hint: hint || text,
      ...(progress ? { progress } : {}),
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
