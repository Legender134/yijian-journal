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
    if (!stats || !data) return '<p class="save-note">数值暂缺</p>';
    const equipment = equipmentTypes.has(entry.typeKey);
    // Materials with no direct effects need no empty statistics panel.
    if (!equipment && !stats.effects.length && !stats.requirements.length && !stats.random.length) return '';
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
        return `<div class="item-effect-buff"><strong>${text(buff?.name || '附加效果')}</strong>${description ? `<p class="small">${text(description)}</p>` : ''}</div>`;
      }
      if (action.type === 'CItem')
        return `<div class="item-effect-row"><span>${action.value < 0 ? '消耗物品' : '获得物品'}：${link('item-' + action.id, '未收录物品')}</span><strong>× ${text(numberText(Math.abs(action.value)))}</strong></div>`;
      if (action.type === 'AUpgradeExclusiveWeapon')
        return `<p class="small">专属武器强化：${link('item-' + action.id, '待核对武器')} → ${link('item-' + action.value, '强化结果待核对')}</p>`;
      if (action.type === 'ASkill')
        return `<div class="item-effect-buff"><p>学习武学：${link('skill-' + action.id, '未收录武学')}</p></div>`;
      return '';
    };
    const fixed = stats.effects
      .map((action) => row(action))
      .filter(Boolean)
      .join('');
    const unresolved = stats.effects.filter((action) => !row(action));
    const randomGroups = stats.random.filter((group) => group.poolIds.length);
    const random = randomGroups.length
      ? `<details class="item-random-stats"><summary>随机词条</summary><p class="save-note">每件装备随机获得其中部分词条。</p>${randomGroups
          .map((group) =>
            group.poolIds
              .map((id) => {
                const pool = data.pools[id];
                return `<div class="item-random-pool">${pool?.unresolved || !pool ? '<p class="save-note">此随机池在当前原始资料中缺失，无法列出候选。</p>' : pool.candidates.map((action) => `<div class="item-random-candidate">${row(action, true) || '<p class="small">其他附加效果，尚未核定展示方式。</p>'}</div>`).join('')}</div>`;
              })
              .join(''),
          )
          .join('')}</details>`
      : '';
    const people = (rows) => {
      const ids = [...new Set(rows.map((r) => 'npc-' + r.id))];
      const known = ids.filter((id) => byId.has(id));
      const missing = ids.length - known.length;
      return [
        ...known.map((id) => link(id)),
        ...(missing ? [missing === 1 ? '未收录人物' : `${missing} 位人物资料未收录`] : []),
      ].join('、');
    };
    const only = stats.requirements.filter((r) => r.type === 'OnlyDesignatedNPC');
    const excluded = stats.requirements.filter((r) => r.type === 'ExcludeNPC');
    const simpleTypes = ['OnlyHero', 'OnlyDesignatedNPC', 'ExcludeNPC', 'bBuyDLC2'];
    const simpleRestrictions = [
      stats.requirements.some((r) => r.type === 'OnlyHero') ? '仅主角可用' : '',
      only.length ? '仅限：' + people(only) : '',
      stats.requirements.some((r) => r.type === 'bBuyDLC2') ? '需要相应扩展内容' : '',
    ].filter(Boolean);
    const items = stats.requirements.filter((r) => r.type === 'Item');
    const requirement = (r) => {
      const parameter = text(numberText(r.value));
      if (r.type === 'WeaponRequirement')
        return `兵器类型条件：${text(weaponTypes[r.value] || '未识别类型')}`;
      if (r.type === 'CurrentSkillLv')
        return `武学等级条件：${link('skill-' + r.id, '未收录武学')} · 判定条件待确认`;
      if (r.type === 'CheckNeiGong') return `内功条件待确认`;
      if (['PreQuest', 'NoQuest'].includes(r.type)) {
        const quest = index.world?.quests?.find((q) => q.gameId === r.id);
        const target = quest
          ? act('world-quest', text(quest.name), 'text-btn', quest.id)
          : text('未收录任务');
        return `${r.type === 'PreQuest' ? '前置任务条件' : '任务排除条件'}：${target} · 所需状态待确认`;
      }
      return `其他使用条件待确认`;
    };
    const restrictions = [
      ...simpleRestrictions.map((r) => `<p>${r}。</p>`),
      ...(excluded.length
        ? [
            `<details class="item-excluded-people"><summary>不适用人物 · ${new Set(excluded.map((r) => r.id)).size} 位</summary><p>${people(excluded)}</p></details>`,
          ]
        : []),
      ...(items.length
        ? [
            `<p>物品条件${items.length > 1 ? '（需同时满足）' : ''}：</p><ul>${items.map((r) => `<li>${link('item-' + r.id, '未收录物品')} × ${text(numberText(r.value))}</li>`).join('')}</ul>`,
          ]
        : []),
      ...stats.requirements
        .filter((r) => !simpleTypes.includes(r.type) && r.type !== 'Item')
        .map((r) => `<p>${requirement(r)}。</p>`),
    ].join('');
    const referenceDetails = unresolved.length && fixed ? '<p class="save-note">另有学习或剧情效果</p>' : '';
    return `<section class="detail-block item-statistics" data-item-statistics><h3>${equipment ? '装备基础数值' : '使用效果与数值'}</h3>${fixed || `<p class="small">${stats.effects.length ? '学习或剧情物品' : equipment ? '无固定属性' : '无直接属性加成'}</p>`}${restrictions ? `<div class="item-stat-restrictions"><h4>使用条件</h4>${restrictions}</div>` : ''}${random}${referenceDetails}</section>`;
  }
  return { detail };
}
