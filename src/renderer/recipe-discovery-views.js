export function createRecipeDiscoveryViews({ esc, act, pill, notice, empty, when }) {
  const format = (number) => (Number.isSafeInteger(number) ? number.toLocaleString() : '未知');
  function entry() {
    return `<section class="card mb recipe-discovery-entry"><div class="row between wrap"><div><h2>看看余料能支持什么</h2><p class="save-note">用本周目的存档参照，找出已学配方中材料够一份或只差少量的选择。</p></div>${act('recipe-discovery-open', '用现有材料找配方', 'btn', '', 'search')}</div></section>`;
  }
  function candidate(row, projection, view, index, profile) {
    const itemName = (id) =>
      index?.entries?.find((entry) => entry.id === 'item-' + id)?.name || '物品 #' + id;
    const learned =
      row.learned === true ? '已学配方' : row.learned === false ? '存档未记录已学' : '学习记录未知';
    const materials =
      row.materialStatus === 'supported'
        ? `直接材料支持 ${row.requestedQuantity} 次`
        : row.materialStatus === 'missing'
          ? `按 ${row.requestedQuantity} 次还缺 ${format(row.missingTotal)} 件`
          : '直接材料未知';
    const target = profile?.craftPlans?.find((plan) => plan.id === view.targetPlanId);
    const disabled = view.busy || !!view.error || !projection.scopeToken || target?.done === true;
    const missing = row.missingItems
      .map(
        (material) =>
          `<div class="material-row"><span class="spacer">${esc(material.name)}${material.ids.length > 1 ? '<small class="material-owned">同组替代材料共享用量</small>' : ''}</span><span>需 ${format(material.needed)} · ${material.missing === null ? '缺口未知' : '缺 ' + format(material.missing)}</span></div><div class="related-items">${material.ids.map((id) => act('database-detail', esc(itemName(id)), 'text-btn', 'item-' + id)).join('、')}</div>`,
      )
      .join('');
    return `<article class="card recipe-discovery-card" data-recipe-discovery-id="${esc(row.recipeId)}"><div class="row between wrap"><h2>${act('database-detail', esc(row.name), 'text-btn', row.recipeId)}</h2>${pill(learned, row.learned === true ? 'green' : '')}</div><div class="tag-row">${pill(materials, row.materialStatus === 'supported' ? 'green' : row.materialStatus === 'missing' ? 'orange' : '')}${pill(row.craft + ' · 资料要求 ' + row.requirementLevel + ' 级')}</div><p class="small">基础制作费 ${format(row.money)} 文 · ${row.moneyStatus === 'supported' ? '扣除既有制作预算后铜钱支持' : row.moneyStatus === 'missing' ? '剩余铜钱仍缺 ' + format(row.copperMissing) + ' 文' : '铜钱支持情况未知'}</p><p class="save-note">当前生活技能等级未知，请在游戏内核对是否满足 ${esc(row.craft)} ${row.requirementLevel} 级与制作状态。</p>${row.requestedQuantity !== 1 ? `<p class="small muted">筛选按一份核对：${row.supportsOne === null ? '材料支持未知' : row.supportsOne ? '支持一份' : '一份还缺 ' + format(row.oneMissingTotal) + ' 件'}；本卡数量另行计算。</p>` : ''}${missing ? `<details class="detail-block" ${row.materialStatus === 'missing' ? 'open' : ''}><summary>材料缺口与资料</summary>${missing}</details>` : ''}<div class="row wrap"><label class="quantity-label">加入次数 <input type="number" min="1" max="999" step="1" value="${row.requestedQuantity}" data-recipe-discovery-quantity="${esc(row.recipeId)}" aria-label="${esc(row.name)}加入次数"></label><button class="btn ${disabled ? '' : 'primary'}" data-action="recipe-discovery-add" data-id="${esc(row.recipeId)}" data-discovery-scope="${esc(projection.scopeToken || '')}" ${disabled ? 'disabled' : ''}>${target?.done ? '所选计划已完成，请先重新打开' : target ? '加入所选计划' : '加入当前清单'}</button>${act('database-detail', '查看配方资料', 'text-btn', row.recipeId)}</div>${row.learningItemIds.length ? `<details class="detail-block"><summary>学习图纸与获取资料</summary><div class="related-items">${row.learningItemIds.map((id) => act('database-detail', esc(itemName(id)), 'btn', 'item-' + id)).join('')}</div></details>` : ''}${row.blockingUnknowns.length ? `<details class="detail-block"><summary>尚待核对的信息 · ${row.blockingUnknowns.length}</summary>${row.blockingUnknowns.map((reason) => `<p class="save-note">${esc(reason)}</p>`).join('')}</details>` : ''}</article>`;
  }
  function page(projection, view = {}, index = {}, profile = {}) {
    const options = projection?.filters || { query: '', craft: '', learned: 'learned', view: 'supported' };
    const header = `<div class="page-header"><div><div class="eyebrow">MAKE THE MOST OF WHAT YOU HAVE</div><h1 class="serif">用现有材料找配方</h1><p>先扣除已有打算，再从余料中挑选下一份备料计划。</p></div><div class="row wrap">${act('recipe-discovery-refresh', '重新核对', 'btn', '', 'refresh')}${act('navigate', '回到备料页', 'btn', 'materials')}</div></div>`;
    const filters = `<section class="card mb"><div class="toolbar wrap"><label class="search-input"><input id="recipe-discovery-search" value="${esc(options.query)}" maxlength="100" placeholder="按配方名或说明搜索" aria-label="搜索余料配方"></label><label>工种 <select id="recipe-discovery-craft" aria-label="配方工种">${[
      ['', '全部工种'],
      ['fusion', '锻造'],
      ['alchemy', '炼丹'],
      ['cooking', '烹饪'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${options.craft === value ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select></label><label>学习记录 <select id="recipe-discovery-learned" aria-label="配方学习筛选">${[
      ['learned', '已学及学习未知'],
      ['all', '全部配方'],
      ['unlearned', '存档未记录已学'],
      ['unknown', '学习记录未知'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${options.learned === value ? 'selected' : ''}>${label}</option>`,
      )
      .join('')}</select></label></div><div class="tag-row mt">${[
      ['supported', '材料支持一份'],
      ['near', '只差少量'],
      ['all', '全部材料状态'],
    ]
      .map(([value, label]) =>
        act('recipe-discovery-view', label, 'chip ' + (options.view === value ? 'active' : ''), value),
      )
      .join(
        '',
      )}</div><p class="save-note">「只差少量」按一份缺 1–2 件、最多 2 组材料筛选；库存未知时会保留未知结果。列表中的每项各自使用同一份余料，不表示可以同时制作。</p><div class="toolbar wrap"><label>加入到 <select id="recipe-discovery-target-plan" aria-label="反查配方加入目标"><option value="">当前编辑清单</option>${(profile.craftPlans || []).map((plan) => `<option value="${esc(plan.id)}" ${view.targetPlanId === plan.id ? 'selected' : ''}>${esc(plan.name)}${plan.done ? ' · 已完成' : ''}</option>`).join('')}</select></label><span class="save-note">数量 1–999；加入后重新核对整个预算与余料。</span></div></section>`;
    if (!projection)
      return header + filters + notice(view.error || '正在读取本周目的参照并核对全部物资用途…', true);
    const source = projection.referenceIdentity;
    const provenance = `<section class="card mb recipe-discovery-source"><strong>本次核对来源</strong>${source ? `<p class="small">存档 ${esc(source.name)} · ${when(source.modifiedAt)}</p><p class="small mono">SHA-256 ${esc(source.hash)}</p>` : '<p class="save-note">尚无可确认的存档参照。</p>'}${projection.status !== 'ready' && projection.notices[0] ? notice(projection.notices[0], true) : ''}<details><summary>预算扣除与资料版本说明</summary><p class="save-note">资料 Build ${esc(projection.catalogBuild)} · 存档中已保存的进度；不同游戏版本仍需在游戏内核对。</p>${projection.notices.map((message) => `<p class="save-note">${esc(message)}</p>`).join('')}</details>${view.busy ? notice('正在重新核对；完成前暂不能加入计划。', true) : ''}${view.error ? notice(view.error, true) : ''}</section>`;
    const { page: current, pageCount, total } = projection.pagination;
    const pagination = `<div class="row between wrap recipe-discovery-pagination"><p class="small muted">${total} 条结果 · 第 ${current} / ${pageCount} 页</p><div class="row">${current > 1 ? act('recipe-discovery-page', '上一页', 'btn', String(current - 1)) : ''}${current < pageCount ? act('recipe-discovery-page', '下一页', 'btn', String(current + 1)) : ''}</div></div>`;
    return (
      header +
      filters +
      provenance +
      pagination +
      `<section class="stack recipe-discovery-results">${projection.rows.map((row) => candidate(row, projection, view, index, profile)).join('') || empty('当前条件下没有配方', '可以切换全部配方或全部材料状态，或查看配方学习图纸。')}</section>` +
      pagination
    );
  }
  return { entry, page };
}
