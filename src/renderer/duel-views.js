export function createDuelViews({ esc, act, pill }) {
  const text = (value) => esc(String(value ?? ''));
  const item = (reward) =>
    reward.itemId
      ? act('database-detail', text(reward.name), 'text-btn', 'item-' + reward.itemId)
      : text(reward.name);
  function card(row, compact = false, scope = '') {
    const rewards = row.rewards || [];
    const key = text(scope + '-' + row.id);
    const header = `<div class="row between"><h3>${row.personId ? act('database-detail', text(row.name), 'text-btn', row.personId) : text(row.name)}</h3>${row.level ? pill('静态等级 ' + row.level) : ''}</div>`;
    const body = `<p class="duel-rewards"><strong>值得留意：</strong>${rewards.length ? rewards.map((reward) => `${item(reward)}<small>（${text(reward.method)}）</small>`).join(' · ') : '当前私物请先观察，具体装备收益尚未核实。'}</p>${row.conditions?.some((condition) => condition.status === 'unknown') ? '<p class="small save-note">前置记录仍待核对，不能据此认定现在可以挑战。</p>' : ''}<p class="duel-action"><strong>建议：</strong>${text(row.recommendation?.action || row.preparation)}</p><p class="small duel-preparation"><strong>准备与实力：</strong>${text(row.preparation)}</p><details data-persist-detail="duel-info-${key}"><summary>收益条件、取舍与来源</summary>${row.recommendation?.reason ? `<p>为什么：${text(row.recommendation.reason)}</p>` : ''}${row.recommendation?.tradeoff ? `<p>取舍：${text(row.recommendation.tradeoff)}</p>` : ''}${row.conditions?.length ? `<ul>${row.conditions.map((condition) => `<li>${act('flow-quest', text(condition.name), 'text-btn', condition.id)}：${condition.status === 'met' ? '存档已记录完成' : condition.status === 'unmet' ? '尚未完成' : '记录待核对'}</li>`).join('')}</ul>` : ''}${rewards.map((reward) => `<p>${item(reward)} · ${text(reward.method)}${reward.condition ? '：' + text(reward.condition) : ''}</p>${reward.probability ? `<p class="small save-note">${text(reward.probability)}</p>` : ''}`).join('')}${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${row.levelBasis ? `<p class="small save-note">${text(row.levelBasis)}</p>` : ''}<div class="duel-sources">${(row.sources || []).map((source) => `<p>${act('source', text(source.title), 'text-btn', source.id)}<span class="small muted"> · ${text(source.author || '')} · ${text(source.version || '')}</span></p>`).join('')}</div></details>`;
    if (compact)
      return `<details class="duel-card duel-compact-card" data-duel="${text(row.id)}" data-persist-detail="duel-card-${key}"><summary><span class="row between"><strong>${text(row.name)}</strong><small>${row.level ? '静态等级 ' + text(row.level) : '实力待核对'}</small></span><span class="duel-place">${text(row.place)}</span><span class="duel-reward-preview">${text(
        rewards
          .slice(0, 2)
          .map((reward) => reward.name + '（' + reward.method + '）')
          .join(' · ') || '先观察当前私物',
      )}${rewards.length > 2 ? ` 等 ${rewards.length} 项` : ''}</span></summary><div class="duel-compact-detail">${row.personId ? act('database-detail', '查看人物资料', 'text-btn', row.personId) : ''}${body}</div></details>`;
    return `<article class="duel-card" data-duel="${text(row.id)}">${header}<p class="duel-place">${text(row.place)}</p>${body}</article>`;
  }
  function page(flow, { compact = false, scope = '' } = {}) {
    const data = flow?.duels;
    const candidates = data?.candidates || [];
    const ids = new Set(candidates.map((row) => row.id));
    const others = (data?.guide || []).filter((row) => !ids.has(row.id));
    return `<section class="duel-page"><h2>${compact ? '本阶段比武' : '本阶段比武与重要收益'}</h2><p class="small save-note">${compact && data?.available ? `${text(flow.reference?.name || '当前存档')} · ${candidates.length} 条阶段线索；到场核对人物与私物。` : text(data?.reason || '正在核对比武资料。')}${data?.difficultyName ? ` 难度：${text(data.difficultyName)}。` : ''}</p><details class="duel-combat-limit" data-persist-detail="duel-combat-${text(scope)}"><summary>怎样判断现在能不能打</summary><p>${text(data?.combatLimit || '尚未读取玩家实时战斗面板，不保证能够战胜。')}</p><p>先观察人物的招式、私物和比武条件，按下方准备建议判断；首次挑战前保留可回读存档，打不过可以先继续低风险任务。</p></details><div data-duel-current>${candidates.length ? candidates.map((entry) => card(entry, compact, scope)).join('') : '<p class="small">当前未匹配已整理的比武候选，可在下方按人物查资料。</p>'}</div>${others.length ? `<details class="duel-all" data-persist-detail="duel-all-${text(scope)}"><summary>其他阶段的比武资料 · ${others.length} 人</summary><p class="small save-note">仅供查阅，不能据此判断这些人物当前在场或可挑战。</p>${others.map((entry) => card(entry, compact, scope)).join('')}</details>` : ''}<p class="small save-note">已整理 ${data?.guide?.length || 0} 位人物。切磋私物、武学请教和剧情奖励分别标注；未列人物不代表没有重要物品。</p></section>`;
  }
  return { page };
}
