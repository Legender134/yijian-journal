const equipmentTypes = new Set([
  'Sword',
  'Sabre',
  'Spear',
  'Fist',
  'HiddenWeapon',
  'Hat',
  'Shoes',
  'Ornament',
  'Clothing',
]);
// EWeaponType values verified from the matching Build 21798996 static PE enum.
// The enum identifies the type; it does not prove which equipment is checked.
const weaponTypes = {
  0: '默认类型',
  1: '剑法',
  2: '刀法',
  3: '枪棍',
  4: '拳掌',
  5: '暗器',
  6: '奇门',
};
const numberText = (value) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

export function itemEffectText(action, data) {
  const attribute = data?.attributes?.[action.id];
  if (['CAttr', 'CAllAttr'].includes(action.type) && attribute) {
    const value = action.value * attribute.scale;
    const unit = attribute.unit === '%' ? '%' : attribute.unit === '点' ? ' 点' : '（原始参数）';
    const name = [1, 3, 44].includes(action.id) ? '恢复' + attribute.name : attribute.name;
    return { name, value: (value > 0 ? '+' : '') + numberText(value) + unit };
  }
  if (['CHealthAttrPercent', 'CBlueAttrPercent'].includes(action.type))
    return {
      name: action.type === 'CHealthAttrPercent' ? '气血恢复比例' : '真气恢复比例',
      value: numberText(action.value) + '%',
    };
  const points = { ASExp: '武学点', AJingMaiPoint: '经脉点' }[action.type];
  if (points)
    return { name: points, value: (action.value > 0 ? '+' : '') + numberText(action.value) + ' 点' };
  return null;
}

export function itemNumericSummary(entry, index) {
  if (entry.kind !== '物品' || !entry.stats) return '';
  return entry.stats.effects
    .map((action) => itemEffectText(action, index.itemStats))
    .filter(Boolean)
    .slice(0, 2)
    .map((row) => row.name + ' ' + row.value)
    .join(' · ');
}

export function createItemStatViews({ esc, act }) {
  const text = (value) => esc(String(value ?? ''));
  function detail(index, entry) {
    const stats = entry.stats,
      data = index.itemStats;
    if (!stats || !data) return '<p class="save-note">这件物品的数值资料尚未收录。</p>';
    const equipment = equipmentTypes.has(entry.typeKey);
    const byId = new Map(index.entries.map((row) => [row.id, row]));
    const link = (id, fallback) =>
      byId.has(id) ? act('database-detail', text(byId.get(id).name), 'text-btn', id) : text(fallback);
    const buffActions = new Set(['ABuff', 'ABattleCountBuff', 'ARealTimeBuff']);
    const row = (action, candidate = false) => {
      const numeric = itemEffectText(action, data);
      if (numeric)
        return `<div class="item-effect-row"><span>${text(numeric.name)}</span><strong>${text(numeric.value)}</strong></div>`;
      if (buffActions.has(action.type)) {
        const buff = data.buffs[action.id];
        const description = buff?.description?.replace(/\{\d+\}/g, '〔效果数值待核定〕');
        return `<div class="item-effect-buff"><strong>${text(buff?.name || '附加效果')}</strong>${description ? `<p class="small">${text(description)}</p>` : ''}<details><summary>效果数值资料</summary><p class="small save-note">${candidate ? '这是随机候选效果。' : ''}尚未核定效果等级与数值的对应关系，以下保留资料参数，不代入最终效果。</p>${buff ? `<p class="small">效果参数：${buff.modifiers.map(numberText).join(' / ')}</p>` : ''}<p class="small">${action.type === 'ABattleCountBuff' ? '战斗持续参数' : action.type === 'ARealTimeBuff' ? '时间持续参数' : '效果动作参数'}：${text(numberText(action.value))}（单位与实际持续范围待游戏内确认）</p></details></div>`;
      }
      if (action.type === 'CItem')
        return `<div class="item-effect-row"><span>${action.value < 0 ? '消耗物品' : '获得物品'}：${link('item-' + action.id, '物品 #' + action.id)}</span><strong>× ${text(numberText(Math.abs(action.value)))}</strong></div>`;
      if (action.type === 'AUpgradeExclusiveWeapon')
        return `<p class="small">专属武器强化：${link('item-' + action.id, '待核对武器')} → ${link('item-' + action.value, '强化结果待核对')}</p>`;
      if (action.type === 'ASkill')
        return `<div class="item-effect-buff"><p>学习武学：${link('skill-' + action.id, '武学 #' + action.id + '（当前图鉴未收录详情，名称请核对物品说明）')}</p><p class="small save-note">学习动作参数：${text(numberText(action.value))}；初始等级与重复使用效果尚未核定。</p></div>`;
      return '';
    };
    const fixed = stats.effects
      .map((action) => row(action))
      .filter(Boolean)
      .join('');
    const unresolved = stats.effects.filter((action) => !row(action));
    const randomGroups = stats.random.filter((group) => group.poolIds.length);
    const random = randomGroups.length
      ? `<details class="item-random-stats"><summary>随机词条候选 · 不计入上方基础数值</summary><p class="save-note">这些是可能出现的附加效果，不会全部同时获得。同名装备的实际词条与数值请查看游戏内面板。</p>${randomGroups
          .map((group) =>
            group.poolIds
              .map((id) => {
                const pool = data.pools[id];
                return `<div class="item-random-pool">${pool?.unresolved || !pool ? '<p class="save-note">此随机池在当前原始资料中缺失，无法列出候选。</p>' : pool.candidates.map((action) => `<div class="item-random-candidate">${row(action, true) || '<p class="small">其他附加效果，尚未核定展示方式。</p>'}</div>`).join('')}</div>`;
              })
              .join(''),
          )
          .join(
            '',
          )}<p class="save-note">这里只列候选效果，不表示物品掉率或最终词条概率；抽取次数与组合规则尚未核定。</p></details>`
      : '';
    const names = (ids) => ids.map((id) => byId.get('npc-' + id)?.name || '人物 #' + id).join('、');
    const only = stats.requirements.filter((r) => r.type === 'OnlyDesignatedNPC');
    const excluded = stats.requirements.filter((r) => r.type === 'ExcludeNPC');
    const simpleTypes = ['OnlyHero', 'OnlyDesignatedNPC', 'ExcludeNPC', 'bBuyDLC2'];
    const simpleRestrictions = [
      stats.requirements.some((r) => r.type === 'OnlyHero') ? '仅主角可用' : '',
      only.length ? '仅限：' + names(only.map((r) => r.id)) : '',
      excluded.length ? '不适用：' + names(excluded.map((r) => r.id)) : '',
      stats.requirements.some((r) => r.type === 'bBuyDLC2') ? '需要相应扩展内容' : '',
    ].filter(Boolean);
    const items = stats.requirements.filter((r) => r.type === 'Item');
    const requirement = (r) => {
      const parameter = text(numberText(r.value));
      if (r.type === 'WeaponRequirement')
        return `兵器类型条件：${text(weaponTypes[r.value] || '未识别类型')}（资料参数 ${parameter}；具体检查范围尚未核定）`;
      if (r.type === 'CurrentSkillLv')
        return `武学等级条件：${link('skill-' + r.id, '武学 #' + r.id)}（武学编号 ${text(r.id)}）；资料参数 ${parameter}（比较方式尚未核定）`;
      if (r.type === 'CheckNeiGong')
        return `内功检查：对象编号 ${text(r.id)}；资料参数 ${parameter}（检查范围与比较方式尚未核定）`;
      if (['PreQuest', 'NoQuest'].includes(r.type)) {
        const quest = index.world?.quests?.find((q) => q.gameId === r.id);
        const target = quest
          ? act('world-quest', text(quest.name), 'text-btn', quest.id)
          : text('任务 #' + r.id);
        return `${r.type === 'PreQuest' ? '前置任务条件' : '任务排除条件'}：${target}（任务编号 ${text(r.id)}）；资料参数 ${parameter}（对应状态尚未核定）`;
      }
      return `其他使用条件（${text(r.type)}）：对象编号 ${text(r.id)}；资料参数 ${parameter}（判定方式尚未核定）`;
    };
    const restrictions = [
      ...simpleRestrictions.map((r) => `<p>${text(r)}。</p>`),
      ...(items.length
        ? [
            `<p>物品条件${items.length > 1 ? '（需同时满足）' : ''}：</p><ul>${items.map((r) => `<li>${link('item-' + r.id, '物品 #' + r.id)} × ${text(numberText(r.value))}</li>`).join('')}</ul>`,
          ]
        : []),
      ...stats.requirements
        .filter((r) => !simpleTypes.includes(r.type) && r.type !== 'Item')
        .map((r) => `<p>${requirement(r)}。</p>`),
    ].join('');
    const referenceDetails = unresolved.length
      ? '<p class="save-note">还包含学习、解锁或剧情效果，具体用途请结合物品说明与下方相关资料核对。</p>'
      : '';
    return `<section class="detail-block item-statistics" data-item-statistics><h3>${equipment ? '装备基础数值' : '使用效果与数值'}</h3>${fixed || `<p class="small">${stats.effects.length ? '此物品用于学习、解锁或剧情互动，具体用途见物品说明与下方相关资料。' : equipment ? '资料未列固定属性，请查看随机词条与游戏内面板。' : '此物品没有直接增加战斗属性的使用效果；材料、赠礼与任务用途见下方。'}</p>`}${restrictions ? `<div class="item-stat-restrictions"><h4>使用条件</h4>${restrictions}</div>` : ''}<p class="save-note">${equipment ? '这里显示物品模板的基础值，未计入随机词条、难度与角色加成。' : '这里显示资料表的单次基础效果；实际目标、可用场合与限制以游戏内为准。'}${stats.effects.some((a) => ['CHealthAttrPercent', 'CBlueAttrPercent'].includes(a.type)) ? '恢复百分比的计算基准尚未核定。' : ''}数值最多显示两位小数。</p>${random}${referenceDetails}</section>`;
  }
  return { detail };
}
