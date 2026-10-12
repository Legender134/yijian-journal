export function createDuelViews({ esc, act, pill, richText = esc }) {
  const text = (value) => esc(String(value ?? ''));
  const item = (reward) =>
    reward.itemId
      ? act('database-detail', text(reward.name), 'text-btn', 'item-' + reward.itemId)
      : text(reward.name);
  function card(row, compact = false, scope = '') {
    const rewards = row.rewards || [];
    const key = text(scope + '-' + row.id);
    const ready = row.readiness;
    const opponentSkills = ready?.opponentSkills?.length
      ? `<details data-persist-detail="duel-skills-${key}"><summary>对手招式 · 静态模板</summary><p class="small save-note">来自同构建人物与武学表，不代表当前装备、生效招式或难度加成。到场观察后再判断走位与配装。</p>${ready.opponentSkills.map((skill) => `<p><strong>${act('database-detail', text(skill.name), 'text-btn', skill.id)}</strong> · 模板 ${text(skill.level)} 级</p><p class="small">${text(skill.description)}</p>${skill.special ? `<p class="small">${text(skill.special)}</p>` : ''}`).join('')}</details>`
      : '';
    const preparation = ready
      ? `<section class="duel-readiness" data-duel-readiness="${text(row.id)}"><p><strong>${text(ready.label)}：</strong>${richText(ready.action)}</p><p class="small">为什么：${text(ready.reason)}</p><details data-persist-detail="duel-readiness-${key}"><summary>核对准备与成长路径</summary><ul>${(ready.checks || []).map((check) => `<li data-readiness-check="${text(check.id)}"><strong>${text(check.label)} · ${check.optional ? '可选成长' : check.status === 'met' ? '已记录' : check.status === 'unmet' ? '需准备' : '待核对'}</strong><p>${text(check.detail)}</p>${check.status !== 'met' ? `<p class="small">下一步：${richText(check.next)}</p>` : ''}</li>`).join('')}</ul><p><strong>推荐成长：</strong>${richText(ready.growth)}</p>${opponentSkills}<p class="small save-note">${text(ready.basis)}</p></details></section>`
      : '';
    const collectionAdvice = `<p class="duel-action"><strong>${ready ? '收集路线' : '建议'}：</strong>${richText(row.recommendation?.action || row.preparation)}</p><p class="small duel-preparation"><strong>攻略参考：</strong>${text(row.preparation)}</p>`;
    const header = `<div class="row between"><h3>${row.personId ? act('database-detail', text(row.name), 'text-btn', row.personId) : text(row.name)}</h3>${row.level ? pill('静态等级 ' + row.level) : ''}</div>`;
    const body = `<p class="duel-rewards"><strong>值得留意：</strong>${rewards.length ? rewards.map((reward) => `${item(reward)}<small>（${text(reward.method)}）</small>`).join(' · ') : '当前私物请先观察，具体装备收益尚未核实。'}</p>${row.conditions?.some((condition) => condition.status === 'unknown') ? '<p class="small save-note">前置记录仍待核对，不能据此认定现在可以挑战。</p>' : ''}${ready ? '' : collectionAdvice}<details data-persist-detail="duel-info-${key}"><summary>收益条件、取舍与来源</summary>${ready ? collectionAdvice : ''}${row.recommendation?.reason ? `<p>为什么：${richText(row.recommendation.reason)}</p>` : ''}${row.recommendation?.tradeoff ? `<p>取舍：${richText(row.recommendation.tradeoff)}</p>` : ''}${row.conditions?.length ? `<ul>${row.conditions.map((condition) => `<li>${act('flow-quest', text(condition.name), 'text-btn', condition.id)}：${condition.status === 'met' ? '存档已记录完成' : condition.status === 'unmet' ? '尚未完成' : '记录待核对'}</li>`).join('')}</ul>` : ''}${rewards.map((reward) => `<p>${item(reward)} · ${text(reward.method)}${reward.condition ? '：' + text(reward.condition) : ''}</p>${reward.probability ? `<p class="small save-note">${text(reward.probability)}</p>` : ''}`).join('')}${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${row.levelBasis ? `<p class="small save-note">${text(row.levelBasis)}</p>` : ''}<div class="duel-sources">${(row.sources || []).map((source) => `<p>${act('source', text(source.title), 'text-btn', source.id)}<span class="small muted"> · ${text(source.author || '')} · ${text(source.version || '')}</span></p>`).join('')}</div></details>`;
    const fullBody = preparation + body;
    if (compact)
      return `<details class="duel-card duel-compact-card" data-duel="${text(row.id)}" data-persist-detail="duel-card-${key}"><summary><span class="row between"><strong>${row.personId ? act('database-detail', text(row.name), 'text-btn', row.personId) : text(row.name)}</strong><small>${row.level ? '静态等级 ' + text(row.level) : '实力待核对'}</small></span><span class="duel-place">${text(row.place)}</span><span class="duel-reward-preview">${
        rewards
          .slice(0, 2)
          .map((reward) => `${item(reward)}<small>（${text(reward.method)}）</small>`)
          .join(' · ') || '先观察当前私物'
      }${rewards.length > 2 ? ` 等 ${rewards.length} 项` : ''}</span>${ready ? `<span class="duel-readiness-preview">${text(ready.label)}</span>` : ''}</summary><div class="duel-compact-detail">${row.personId ? act('database-detail', '查看人物资料', 'text-btn', row.personId) : ''}${fullBody}</div></details>`;
    return `<article class="duel-card" data-duel="${text(row.id)}">${header}<p class="duel-place">${text(row.place)}</p>${fullBody}</article>`;
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
