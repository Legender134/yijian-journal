export function createItemUsageViews({ esc, act, when }) {
  const count = (value) => (value === null || value === undefined ? '—' : value.toLocaleString());
  function usage(row) {
    const title =
      row.kind === 'gift' && row.titleEntity
        ? '赠予' + act('database-detail', esc(row.titleEntity.name), 'text-btn', row.titleEntity.id)
        : row.kind === 'quest' && row.source?.action === 'world-quest'
          ? act('world-quest', esc(row.title), 'text-btn', row.source.id)
          : esc(row.title);
    const stage = row.recipeId
      ? act('database-detail', esc(row.stageName), 'text-btn', row.recipeId)
      : esc(row.stageName);
    const group = row.scope === 'alternative-group';
    const required = `${group ? '材料组共需' : row.kind === 'processing' ? '本步骤需' : row.kind === 'quest' ? '记录预留' : row.kind === 'manual' ? '留用' : '需'} ${count(row.required)}`;
    let amounts =
      row.active === false
        ? `${required} · 已完成 · 不占用`
        : `${required} · ${group ? '本物品分配' : '已分配'} ${count(row.allocated)}`;
    if (row.active !== false) {
      if (group) amounts += ` · 该组已分配 ${count(row.groupAllocated)}`;
      if (row.kind === 'processing') {
        amounts += ` · 待补材料 ${count(row.unallocatedPhysical)}`;
        amounts += ` · 前序加工预计产出 ${count(group ? row.groupPlannedAllocated : row.plannedAllocated)}`;
        amounts += ` · 原料缺口 ${count(row.endpointMissing)}`;
      } else
        amounts += ` · ${group ? '该组缺口' : row.kind === 'quest' ? '预留尚缺' : '还缺'} ${count(row.missing)}`;
    }
    return `<article class="detail-block item-usage-row" data-item-usage="${esc(row.key)}"><div class="row between"><h4>${title}</h4>${row.source ? act(row.source.action, esc(row.source.label), 'text-btn', row.source.id, 'arrow') : ''}</div><p class="small muted">${esc(row.status)}${row.stageName ? ' · ' + stage : ''}</p><p class="small">${amounts}</p>${group ? `<p class="save-note">${esc(row.materialName)} · 组内物品可替代</p>` : ''}${row.note ? `<p class="small preserve-text">${esc(row.note)}</p>` : ''}</article>`;
  }
  function detail(result) {
    if (!result) return '';

    const hasUsages = result.usages.length > 0;
    const issue = {
      'invalid-item': '物品不可用',
      unreadable: '读取失败，请重新打开物品详情。',
      'no-reference': '库存未读取',
      'inventory-unknown': '库存未读取',
      'budget-unavailable': '用途数据未就绪，请重新打开物品详情。',
      'profile-mismatch': '周目已变化，请重新打开物品详情。',
      'reference-mismatch': '进度已变化，请重新打开物品详情。',
    }[result.status];
    return `<section class="detail-block item-usage" aria-label="物品用途"><h3>物品用途</h3>${issue ? `<p class="small muted" role="status">${esc(issue)}</p>` : ''}<div class="detail-stat-grid"><div><small>持有</small><strong>${count(result.stock.owned)}</strong></div><div><small>已分配</small><strong>${count(result.stock.allocated)}</strong></div><div><small>可安排</small><strong>${count(result.stock.remaining)}</strong></div></div>${hasUsages ? result.usages.map(usage).join('') : `<p class="small muted">${['ready', 'inventory-unknown'].includes(result.status) ? '暂无预留用途' : '用途待更新'}</p>`}<div class="row wrap">${act('navigate', '调整用途', 'text-btn', 'materials', 'shield')}</div></section>`;
  }
  return { detail };
}
