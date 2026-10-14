export function craftMoneyNotice(budget, esc) {
  const summary = budget?.moneySummary;
  if (!summary) return '';
  return `<p data-shared-craft-money class="small ${summary.status === 'supported' ? 'muted' : 'shortage'}">${esc(summary.message)}</p>`;
}
export function createMaterialViews({
  esc,
  act,
  icon,
  iconButton,
  pill,
  notice,
  empty,
  when,
  richText = esc,
}) {
  function page(index, profile, view, files, plans = '') {
    const list = profile.craftList || [],
      byId = (id) => index.entries.find((e) => e.id === id);
    const completedPlan = profile.craftPlans?.find((p) => p.id === profile.activeCraftPlanId)?.done === true;
    const query = view.query.trim().toLowerCase();
    const matches = index.entries.filter(
      (e) =>
        e.kind === '配方' &&
        (!query ||
          `${e.name} ${e.craft} ${e.type} ${e.results?.map((r) => byId('item-' + r.id)?.name || '').join(' ')} ${e.materials.map((m) => m.name).join(' ')}`
            .toLowerCase()
            .includes(query)),
    );
    const rank = (entry) => {
      if (!query) return 0;
      const name = entry.name.toLowerCase();
      const results = (entry.results || []).map((r) => (byId('item-' + r.id)?.name || '').toLowerCase());
      return name === query
        ? 0
        : results.includes(query)
          ? 1
          : name.startsWith(query)
            ? 2
            : name.includes(query)
              ? 3
              : results.some((r) => r.includes(query))
                ? 4
                : 5;
    };
    matches.sort((a, b) => rank(a) - rank(b));
    const pages = Math.max(1, Math.ceil(matches.length / 8));
    const page = Math.min(pages - 1, Math.max(0, view.searchPage || 0));
    const found = matches.slice(page * 8, page * 8 + 8);
    const picker = `<section class="card craft-picker"><div class="card-header"><h2>添加配方</h2>${pill(`${list.length} / 40 种`)}</div><label class="search-input"><input id="craft-search" data-persist="craft-search" value="${esc(view.query)}" maxlength="100" aria-label="搜索要制作的配方" placeholder="输入成品、配方或材料名称"></label><p class="small muted">${query ? `找到 ${matches.length} 份配方 · 同名成品和生产配方优先` : `共 ${matches.length} 份配方 · 可输入想制作的物品`}</p><div class="craft-suggestions">${found.map((e) => `<div><span class="spacer"><strong>${act('database-detail', esc(e.name), 'text-btn', e.id)}</strong><small>${esc(e.craft || e.type)} ${e.level} 级${query && rank(e) === 5 ? ' · 用料或类别匹配' : ''}</small></span>${iconButton('craft-add', 'plus', '加入备料清单：' + e.name, e.id)}</div>`).join('') || '<p class="small muted">换个名称试试，也可以从百物图鉴加入。</p>'}</div>${pages > 1 ? `<div class="pagination">${act('craft-search-page', '上一页', 'btn', String(Math.max(0, page - 1)))}<span>第 ${page + 1} / ${pages} 页</span>${act('craft-search-page', '下一页', 'btn', String(Math.min(pages - 1, page + 1)))}</div>` : ''}</section>`;
    const lines = list
      .map((line) => {
        const e = byId(line.id);
        return `<div class="craft-line"><div class="spacer"><h3>${act('database-detail', esc(e.name), 'text-btn', line.id)}</h3><small>${esc(e.craft || e.type)} ${e.level} 级 · 制作</small></div><label class="quantity-label">次数<input id="craft-qty-${line.id}" class="craft-count" data-id="${line.id}" type="number" min="1" max="999" step="1" value="${line.quantity}" aria-label="${esc(e.name)}制作次数"></label>${iconButton('craft-remove', 'trash', '移出备料清单：' + e.name, line.id)}</div>`;
      })
      .join('');
    const ready =
      view.result &&
      view.profileId === profile.id &&
      JSON.stringify(view.resultList) === JSON.stringify(list) &&
      view.resultChoices === JSON.stringify(profile.craftChoices || {});
    const result = ready
      ? summary(view.result, index, { ...view, completedPlan })
      : view.loading
        ? notice('正在合并材料并重新读取库存…', true)
        : view.error
          ? notice(view.error)
          : notice('清单已变化，请重新计算。', true);
    const reservations = Object.entries(profile.reservations || {});
    const kept = reservations.length
      ? `<details class="card mt"><summary>手动留用物品 · ${reservations.length}</summary>${reservations.map(([id, count]) => `<div class="world-rule">${act('database-detail', esc(byId('item-' + id)?.name || id), 'text-btn', 'item-' + id)}<span>保留 ${count} 件</span></div>`).join('')}</details>`
      : '';
    const mergeGoals = (profile.goals || []).some(
      (g) => !g.done && g.source?.type === 'database' && byId(g.source.id)?.kind === '配方',
    )
      ? act('craft-goals-merge', '合并制作目标', 'text-btn', '', 'plus')
      : '';
    if (!list.length)
      return `<div class="page-header"><h1 class="serif">制作备料</h1>${mergeGoals}</div>${plans}${picker}${kept}${view.error ? notice(view.error) : ''}${ready ? craftMoneyNotice(view.result.sharedBudget, esc) : ''}${ready && view.result.sharedBudget?.baseMaterialMissingTotal > 0 ? notice(`共同计划还缺 ${view.result.sharedBudget.baseMaterialMissingTotal} 件物资。`, true) : ''}`;
    return `<div class="page-header"><div><h1 class="serif">备料清单</h1></div></div>${plans}<div class="craft-layout"><div>${picker}<section class="card mt"><div class="card-header"><h2>${completedPlan ? '已完成计划的配方记录' : '这一程想制作'}</h2>${mergeGoals}${pill(`${list.length} 种配方`)}</div>${lines || empty('先选一份配方', '从上面搜索添加，或在图鉴配方详情中加入。')}</section>${kept}</div><section class="card craft-result-card"><div class="row mb">${act('craft-calculate', completedPlan ? '核对重做用料' : '计算缺料', 'btn primary', '', 'refresh')}<span class="small muted" role="status">${view.loading ? '正在核对…' : ready ? '核对完成' : ''}</span></div>${list.length ? result : '<p class="save-note">先添加配方</p>'}</section></div>`;
  }
  function summary(plan, index, view) {
    const byId = (id) => index.entries.find((e) => e.id === id);
    const filtered = plan.materials.filter(
      (m) => !view.onlyMissing || !plan.inventoryAvailable || m.missing > 0,
    );
    const materialLink = (id) =>
      act('database-detail', esc(byId(`item-${id}`)?.name || `物品 #${id}`), 'text-btn', `item-${id}`);
    return `${view.completedPlan ? notice('这份计划已由你记为完成。下方保留配方与若重新制作的用料核对，不是仍待制作的事项；预计产物没有加入背包库存。', true) : ''}${craftMoneyNotice(plan.sharedBudget, esc)}${plan.sharedBudget?.baseMaterialMissingTotal > 0 ? notice(`所有任务、制作和赠礼计划共同还缺 ${plan.sharedBudget.baseMaterialMissingTotal} 件原料、赠礼或留用物资；下方核对的是当前编辑清单，其他用量可在「物资用途」查看。`, true) : ''}<div class="craft-totals"><div><small>基础制作费</small><strong>${plan.money.toLocaleString()} 文</strong></div><div><small>材料分组</small><strong>${plan.materials.length} 组</strong></div><div><small>直接材料还缺</small><strong>${plan.missing === null ? '未核对' : `${plan.missing.toLocaleString()} 件`}</strong></div></div>${!plan.inventoryAvailable && plan.reference ? notice('库存未读取', true) : ''}<details class="craft-learning"><summary>配方学习与制作等级</summary>${plan.recipes.map((r) => `<div class="world-rule"><span>${act('database-detail', esc(r.name), 'text-btn', r.id)}</span><small>${esc(r.craft)} ${r.level} 级 · ${r.learned === null ? '学习记录未核对' : r.learned ? '存档中已学' : '存档中未记录已学'}</small></div>`).join('')}</details>${plan.inventoryAvailable ? `<button class="chip ${view.onlyMissing ? 'active' : ''}" data-action="craft-missing">${view.onlyMissing ? '正在只看缺少的材料' : '只看缺少的材料'}</button>` : ''}<div class="craft-materials">${filtered.map((m) => `<div class="craft-material"><div class="row between"><h3>${m.ids.length === 1 ? materialLink(m.ids[0]) : esc(m.name)}</h3>${pill(`共需 ${m.count.toLocaleString()}`)}</div><p class="small muted">${m.allocated === null ? '库存未核对' : `已分配 ${m.allocated.toLocaleString()} · 还缺 ${m.missing.toLocaleString()}`}</p>${m.ids.length > 1 ? `<details><summary>可替代物品</summary><div class="related-items">${m.ids.map(materialLink).join('')}</div></details>` : ''}${m.allocation.length ? `<details><summary>已分配哪些库存</summary>${m.allocation.map((a) => `<p class="small">${materialLink(a.id)}${a.quality ? ` · ${esc(a.quality)}色` : ''} × ${a.count}</p>`).join('')}</details>` : ''}<details><summary>用于哪些配方</summary>${m.recipes.map((r) => `<p class="small">${act('database-detail', esc(r.name), 'text-btn', r.id)} · 需要 ${r.count}</p>`).join('')}</details></div>`).join('') || '<p class="save-note">这些材料已经备齐。</p>'}</div><p class="save-note">已扣除预留；同组替代材料补足总量即可。</p>${stages(plan.stages, index, view)}${sources(plan, index)}${act('craft-goal', '把这次备料摘要加入待办', 'btn', '', 'plus')}`;
  }
  function stages(plan, index, view = {}) {
    if (!plan?.stages.length) return '';
    const recipe = (id) => {
      const entry = index.entries.find((e) => e.id === id);
      return entry ? act('database-detail', esc(entry.name), 'text-btn', entry.id) : '配方资料待补充';
    };
    const item = (id) =>
      act(
        'database-detail',
        esc(index.entries.find((e) => e.id === 'item-' + id)?.name || '物品 #' + id),
        'text-btn',
        'item-' + id,
      );
    const fee = plan.money === null ? '资料费用待核对' : plan.money.toLocaleString() + ' 文';
    const outputs = (step) => {
      const candidates = step.outputs || [];
      return `<div data-craft-outputs>${
        candidates.length
          ? candidates
              .map((output) => {
                const count =
                  output.minimumCount === null
                    ? ' · 数量待核对'
                    : ` × ${output.minimumCount}${output.maximumCount !== output.minimumCount ? '–' + output.maximumCount : ''}`;
                return `<p class="small">${output.guaranteedItem ? '预计产物' : '可能产物'}：${item(output.id)}${output.quality ? ' · ' + esc(output.quality) + '色' : ''}${count}${!output.guaranteedItem && output.weights.length ? ' · 权重 ' + output.weights.map(esc).join(' / ') : ''}</p>`;
              })
              .join('')
          : '<p class="small muted">产物资料待核对</p>'
      }${candidates.some((o) => !o.guaranteedItem) ? '<p class="small muted">随机产出，各候选不会全部同时获得。</p>' : ''}${step.learningItems?.length ? `<details><summary>学习这份配方的物品</summary>${step.learningItems.map((id) => `<p class="small">${item(id)}</p>`).join('')}</details>` : ''}</div>`;
    };
    return `<section class="material-sources crafting-stages"><h3>${icon('leaf')} 从原料到成品</h3><p class="save-note">${esc(plan.notice)}</p>
    <div class="craft-totals"><div><small>原料还缺</small><strong>${plan.rawMissingTotal === null ? '未核对' : plan.rawMissingTotal + ' 件'}</strong></div><div><small>${view.completedPlan ? '若重做需先加工' : '还需先加工'}</small><strong>${plan.workRemaining.processing} 次</strong></div><div><small>${view.completedPlan ? '若重做目标制作' : '再制作目标'}</small><strong>${plan.workRemaining.final} 次</strong></div></div>
    <p class="save-note">${view.completedPlan ? '若重新制作，可按下面的顺序加工。' : '原料齐备后仍需按下面的顺序加工。'}步骤中的“计划产物”须先在游戏里制作，不是当前背包库存。</p>
    <ol class="craft-stage-list">${plan.stages
      .map(
        (
          step,
        ) => `<li data-craft-stage="${esc(step.id)}"><div class="row between"><strong>执行配方：${act('database-detail', esc(step.name), 'text-btn', step.id)} × ${step.quantity} 次</strong>${pill(step.final ? '目标制作' : '先加工', step.final ? 'green' : '')}</div>${outputs(step)}
      <small>${esc(step.craft)} ${step.level} 级 · ${step.learned === null ? '学习记录未核对' : step.learned ? '存档中已学' : '存档中未记录已学'}${step.minimumYield ? ' · 每次至少产出 ' + step.minimumYield : ' · 产出需在游戏内确认'}</small>
      <p class="small muted">${step.materialsAvailableNow === null ? '现有材料待核对' : step.materialsAvailableNow ? '材料已齐' : '此步骤需前面的加工产物或补充缺料'}</p>
      <details><summary>核对这一步的材料来源</summary>${step.materials.map((m) => `<div class="detail-block"><strong>${m.ids?.length === 1 ? item(m.ids[0]) : richText(m.name)} × ${m.count}</strong><p class="small">${m.missing === null ? '库存未核对 · 数量为计划需求' : '还缺 ' + m.missing}</p>${m.sources.map((s) => `<p class="small">${item(s.id)} × ${s.count} · ${s.source === 'inventory' ? '已分配真实库存' : '计划产物 · 先完成 ' + recipe(s.recipeId)}</p>`).join('')}</div>`).join('')}</details></li>`,
      )
      .join('')}</ol>
    <p class="small muted">${view.completedPlan ? '若重新制作' : '本清单'}含加工的制作费：${fee}${plan.processingMoney === null ? '' : ' · 其中加工费 ' + plan.processingMoney.toLocaleString() + ' 文'}。${view.completedPlan ? '这项重做预览未纳入共同预算。' : '与其他有效计划一起支付时，请看共同制作费。'}购买原料费用另计。</p>
    ${!plan.moneyComplete ? notice('路线或资料仍有未确定部分，实际制作费可能增加。', true) : ''}
    <details open><summary>${plan.inventoryAvailable ? '加工后仍需补充的原料' : '库存未知 · 完整原料需求'}</summary>${plan.rawMaterials.map((m) => `<div class="world-rule"><span>${item(m.id)}</span><span>${m.count} 件${m.missing === null ? ' · 计划需求' : ''}</span></div>`).join('') || `<p class="save-note">${plan.inventoryAvailable && plan.rawMissingTotal === 0 && !plan.decisions.length && !plan.warnings.length ? '原料已齐' : plan.decisions.length ? '请补足下方待选择材料' : '原料需求待核对'}</p>`}</details>
    ${plan.decisions.map((d) => `<div class="detail-block"><strong>${esc(d.name)} · ${plan.inventoryAvailable ? '还缺' : '需要'} ${d.count}</strong>${d.recipes ? `<p class="save-note">有多份加工配方，请选择实际要用的一份再展开。</p>${d.recipes.map((r) => act('craft-choice', esc(r.name) + ' · 每次至少 ' + r.minimumYield, 'btn', d.itemId + ':' + r.id)).join('')}` : `<p class="save-note">补足组内总量即可。</p><div class="related-items">${d.alternatives.map(item).join('')}</div>`}</div>`).join('')}${plan.warnings.map((w) => notice(w.message)).join('')}</section>`;
  }
  function sources(plan, index) {
    const missing = plan.materials.filter((m) => m.missing > 0);
    if (!missing.length) return '';
    return (
      '<section class="material-sources"><h3>' +
      icon('map') +
      ' 缺料后，去哪里找线索</h3>' +
      missing
        .map(
          (m) =>
            '<details><summary>' +
            esc(m.name) +
            ' · 还缺 ' +
            m.missing +
            '</summary>' +
            m.ids
              .map((id) => {
                const item = index.entries.find((e) => e.id === 'item-' + id);
                const sellers = [
                  ...new Map(
                    (index.merchants || [])
                      .filter((s) => s.items.includes(id))
                      .map((s) => [s.name + '\n' + s.description, s]),
                  ).values(),
                ];
                return (
                  '<div class="detail-block">' +
                  act('database-detail', esc(item?.name || id), 'text-btn', 'item-' + id) +
                  (item?.description ? '<p class="small muted">' + richText(item.description) + '</p>' : '') +
                  sellers
                    .map(
                      (s) =>
                        '<div class="seller-line">' +
                        act('database-detail', esc(s.name), 'text-btn', 'npc-' + s.id) +
                        '<p class="small muted">' +
                        richText(s.description || '地点未收录') +
                        '</p></div>',
                    )
                    .join('') +
                  (!sellers.length
                    ? '<p class="small muted">没有已核实的售卖人物；可在物品详情查制作、任务等关联。</p>'
                    : '') +
                  '</div>'
                );
              })
              .join('') +
            '</details>',
        )
        .join('') +
      '</section>'
    );
  }
  return { page };
}
