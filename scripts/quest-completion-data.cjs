'use strict';
const clean = (value) =>
  String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/^【[^】]+】\s*/, '')
    .trim();

// Keep this projection separate from pickup requirements. Raw table IDs remain
// the identity even when a hidden flag needs its named parent for navigation.
function projectCompletionRequirements(
  rows,
  { quests, npcNames, items, itemGroups, npcGroups, guilds, published },
) {
  return (rows || []).flatMap((raw) => {
    const type = String(raw.type || raw.Type || '')
        .split('::')
        .pop(),
      id = raw.id ?? raw.Id,
      value = Number(raw.value ?? raw.Num);
    if (!type || type === 'None' || !Number.isSafeInteger(id) || !Number.isFinite(value)) return [];
    const result = { type, id, value };
    if (type === 'PreQuest' || type === 'NoQuest') {
      let quest = quests.get(id);
      const seen = new Set();
      while (quest && !seen.has(quest.QuestId)) {
        seen.add(quest.QuestId);
        if (published.has(quest.QuestId)) {
          result.name = clean(quest.Name) || '相关剧情';
          if (quest.QuestId !== id) {
            result.name += '相关进度';
            result.relatedQuestId = quest.QuestId;
          }
          result.entityId = `quest-${quest.QuestId}`;
          break;
        }
        quest = quests.get(quest.OwnerQuestId);
      }
      result.name ||= '相关剧情进度';
    } else if (type === 'Item') result.name = items.get(id)?.name || '任务物品';
    else if (type === 'AggregationItem') {
      const group = itemGroups.get(id);
      result.name = clean(group?.GroupName) || '指定谢礼';
      result.alternatives = (group?.ItemList || []).map((itemId) => ({
        id: itemId,
        name: items.get(itemId)?.name || '任务物品',
        ...(items.get(itemId)?.quality ? { quality: items.get(itemId).quality } : {}),
      }));
    } else if (type === 'KillMonsterAggre') {
      const group = npcGroups.get(id);
      result.name = clean(group?.GroupName) || '任务指定敌人';
      result.targetIds = group?.NPCList || [];
    } else if (type === 'GuildHonor') result.name = (clean(guilds.get(id)?.Name) || '门派') + '贡献';
    else if (type === 'Money') {
      result.name = '铜钱';
      // The pinned QuestManager finishing predicate uses a strict comparison.
      result.comparison = 'gt';
    } else result.name = npcNames.get(id) || '任务指定人物';
    return [result];
  });
}
module.exports = { projectCompletionRequirements };
