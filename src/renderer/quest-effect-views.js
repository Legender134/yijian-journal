import { entityCatalog } from './entity-catalog.js';
import { itemEffectText } from './item-stat-views.js';
import { questJumpEventText } from '../shared/task-completion.mjs';

// Source-confirmed stackable item actions using CItem(-99); actual removal is
// conditional and may remove fewer than the requested maximum.
const bulkMaterialActions = new Map([
  [5059, [10016]], [5572, [10381, 10382]], [5720, [10074]],
  [11072, [10041]], [11260, [10068]], [11847, [10392]],
  [11891, [10411]],
]);

// Only named, shipped targets are linked. An internal step never inherits its
// owner's identity for removals, failures or rewards.
export function createQuestEffectViews({ esc, act }) {
  const text = (value) => esc(String(value ?? ''));
  const link = (index, id) => {
    const catalog = entityCatalog(index);
    const entity = catalog.entries.get(id);
    const name = String(entity?.name || '').replace(/^【[^】]+】\s*/, '');
    const showQuality = entity?.kind === '物品' && entity.quality &&
      (catalog.names.get(entity.name) || []).some(
        (other) => other.kind === '物品' && other.id !== entity.id && other.quality && other.quality !== entity.quality,
      );
    return entity
      ? act(
          entity.kind === '任务' ? 'world-quest' : entity.kind === '地点' ? 'world-place' : 'database-detail',
          text(showQuality ? `${name}（${entity.quality}）` : name),
          'text-btn',
          id,
        )
      : '';
  };
  function effect(index, action, quest, { familyFinish = false } = {}) {
    if (!action || !Number.isFinite(action.value)) return '';
    const amount = `${action.value > 0 ? '+' : ''}${action.value.toLocaleString('zh-CN')}`;
    const target = (kind) => link(index, kind + '-' + action.id);
    const person = () => target('npc') || text(index.world?.npcNames?.[action.id] || '未收录人物');
    if (action.type === 'CAttr') {
      const change = itemEffectText(action, index.itemStats);
      if (change) return `${text(change.name)} <strong>${text(change.value)}</strong>`;
    }
    if (action.type === 'DAggregationItem' && Number.isSafeInteger(action.value) && action.value > 0) {
      const group = quest?.finishingRequirements?.find(
        (requirement) => requirement.type === 'AggregationItem' && requirement.id === action.id,
      );
      if (group?.name) return `可能消耗${text(group.name)} <strong>×${action.value}</strong>`;
    }
    if (action.type === 'CItem') {
      // This unnamed, non-player-facing quest item is used as a dialogue counter.
      if (action.id === 10493 && [16166, 16187].includes(quest?.gameId)) return '';
      const item = target('item');
      if (quest?.gameId === 13512 && action.id === 3060 && action.value === -1)
        return `${item || '凤鸣棍'} 扣除情况待确认`;
      if (action.value === -99 && bulkMaterialActions.get(quest?.gameId)?.includes(action.id))
        return `可能消耗${item || '未知物品'} <strong>最多99</strong>`;
      return item
        ? `${item} <strong>${action.value < 0 ? '−' : '+'}${Math.abs(action.value)}</strong>`
        : `未知物品 <strong>${text(amount)}</strong>（结果待确认）`;
    }
    if (
      ['ARandItem', 'ANormalRandItem'].includes(action.type) &&
      target('item') &&
      Number.isSafeInteger(action.value) &&
      action.value > 0
    )
      return `${target('item')} <strong>+${action.value}</strong>（${action.type === 'ARandItem' ? '随机词条' : '普通随机词条'}）`;
    if (action.type === 'CYHD') return `${person()} 好感 ${text(amount)}`;
    if (action.type === 'CMoney' && action.value > 0) return `铜钱 ${text(amount)}（基础）`;
    if (action.type === 'CMoney' && action.value < 0) return `可能扣除铜钱 ${text(Math.abs(action.value).toLocaleString('zh-CN'))}`;
    if (action.type === 'ASExp') return `武学点 ${amount}`;
    if (action.type === 'AJingMaiPoint') return `经脉点 ${amount}`;
    if (action.type === 'CGuildHonor') return `门派贡献 ${amount}`;
    if (action.type === 'ASkill' && target('skill')) return `学会 ${target('skill')}`;
    if (action.type === 'CNPCCantInviteFlag' && (action.value === 0 || action.value === 1))
      return `${person()}：${action.value === 1 ? '可能暂不能邀请' : '可能解除邀请限制'}`;
    if (action.type === 'CNPCCantLeaveFlag' && (action.value === 0 || action.value === 1))
      return `${person()}：${action.value === 1 ? '可能暂不能离队' : '可能解除离队限制'}`;
    if (['ATeam', 'RTeam'].includes(action.type))
      return `${person()} ${action.type === 'ATeam' ? '入队' : '离队'}`;
    if (action.type === 'RQuest' && target('quest')) return `${target('quest')}：从任务列表移除`;
    if (familyFinish && action.type === 'CQuestStep' && action.value === 4 && target('quest'))
      return `${target('quest')} → 就此结束`;
    if (
      action.type === 'CQuestStep' &&
      (action.value === 2 || (action.id !== quest?.gameId && action.id !== quest?.parentId)) &&
      target('quest')
    ) {
      const state = ['未开始', '进行中', '失败', '未接取', '完成'][action.value];
      return state
        ? `${target('quest')} → ${action.id === quest?.gameId && quest?.parentId ? '此步骤' : ''}${state}`
        : '';
    }
    if (action.type === 'CQuestStep' && action.value === 2 && !target('quest')) {
      const hidden = index.codex?.hiddenSteps?.[action.id];
      const path = hidden?.ownerPath;
      const related = Number.isSafeInteger(hidden?.relatedQuestId) &&
        Array.isArray(path) && path[0] === hidden.ownerId && path.includes(hidden.relatedQuestId)
        ? link(index, 'quest-' + hidden.relatedQuestId)
        : '';
      // The action targets the hidden step, not the related public root.
      if (related) return `${related}：相关步骤可能失败`;
    }
    if (action.type === 'JumpStep' && target('quest')) {
      const event = questJumpEventText(action.value);
      return event ? `${target('quest')}：${text(event)}` : '';
    }
    return '';
  }
  const effectList = (index, actions, quest) =>
    (actions || []).map((action) => effect(index, action, quest)).filter(Boolean);
  const important = (action) =>
    ['RQuest', 'RTeam', 'DAggregationItem'].includes(action.type) ||
    (action.type === 'CQuestStep' && action.value === 2) ||
    (['CAttr', 'CYHD', 'ASExp', 'AJingMaiPoint', 'CGuildHonor', 'CMoney', 'CItem'].includes(action.type) &&
      action.value < 0);
  const progression = (action) =>
    action.type === 'JumpStep' || (action.type === 'CQuestStep' && action.value !== 2);
  function choiceRows(index, detail, quest, { all = false } = {}) {
    const choices = detail?.choices || [];
    const ancestors = new Set();
    const published = new Map((index.world?.quests || []).map((row) => [row.gameId, row]));
    for (let id = quest?.parentId; id && !ancestors.has(id); id = published.get(id)?.parentId)
      ancestors.add(id);
    const alternativeFinish = (action) =>
      action.type === 'CQuestStep' &&
      action.value === 4 &&
      ancestors.has(action.id) &&
      choices.some(
        (choice) =>
          !(choice.actions || []).some(
            (other) => other.type === action.type && other.id === action.id && other.value === action.value,
          ),
      );
    const rows = choices.map((choice) => {
      const actions = choice.actions || [];
      const render = (rows) =>
        rows
          .map((action) =>
            effect(index, action, quest, {
              familyFinish: alternativeFinish(action),
            }),
          )
          .filter(Boolean);
      return {
        ...choice,
        shown: render(actions),
        changes: render(actions.filter((action) => !progression(action) || alternativeFinish(action))),
        important: render(actions.filter((action) => important(action) || alternativeFinish(action))),
      };
    });
    if (all) return rows;
    // Bare event dispatch/state progression is already covered by the current
    // action. Do not turn it into an empty choice card or infer later rewards.
    if (!rows.some((row) => row.changes.length)) return [];
    // One ordinary acknowledgement is not a decision. Keep single-option
    // losses visible, but leave routine rewards in the quest detail.
    if (rows.length === 1 && !rows[0].important.length) return [];
    const signatures = rows.map((row) => JSON.stringify([...row.changes].sort()));
    if (rows.length > 1 && signatures.every((value) => value === signatures[0])) return [];
    return rows;
  }
  return { effect, effectList, choiceRows };
}
