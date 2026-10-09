export function createItemUsageViews({ esc, act, when }) {
  const count = (value) => (value === null || value === undefined ? '待核对' : value.toLocaleString());
  function usage(row) {
    const group = row.scope === 'alternative-group';
    const required = `${group ? '材料组共需' : row.kind === 'processing' ? '本步骤需' : row.kind === 'quest' ? '记录预留' : row.kind === 'manual' ? '留用' : '需'} ${count(row.required)}`;
    let amounts =
      row.active === false
        ? `${required} · 这份参照已完成 · 当前不占用`
        : `${required} · ${group ? '本物品分配' : '真实库存分配'} ${count(row.allocated)}`;
    if (row.active !== false) {
      if (group) amounts += ` · 该组真实库存分配 ${count(row.groupAllocated)}`;
      if (row.kind === 'processing') {
        amounts += ` · 尚未分配真实库存 ${count(row.unallocatedPhysical)}`;
        amounts += ` · 预计前序加工供给 ${count(group ? row.groupPlannedAllocated : row.plannedAllocated)}`;
        amounts += ` · 原料端点缺口 ${count(row.endpointMissing)}`;
      } else
        amounts += ` · ${group ? '该组缺口' : row.kind === 'quest' ? '预留尚缺' : '还缺'} ${count(row.missing)}`;
    }
    return `<article class="detail-block item-usage-row" data-item-usage="${esc(row.key)}"><div class="row between"><h4>${esc(row.title)}</h4>${row.source ? act(row.source.action, esc(row.source.label), 'text-btn', row.source.id, 'arrow') : ''}</div><p class="small muted">${esc(row.status)}${row.stageName ? ' · ' + esc(row.stageName) : ''}</p><p class="small">${amounts}</p>${group ? `<p class="save-note">${esc(row.materialName)}可使用本物品或其他替代物；材料组需求和缺口不表示每种品质各需这一数量。</p>` : ''}${row.note ? `<p class="small preserve-text">${esc(row.note)}</p>` : ''}</article>`;
  }
  function detail(result) {
    if (!result) return '';
    const reference = result.referenceIdentity;
    const hasUsages = result.usages.length > 0;
    const empty =
      result.status === 'ready'
        ? '本周目尚无这件物品的已记录用途。'
        : result.status === 'inventory-unknown'
          ? '这份预算尚无这件物品的已记录用途；库存仍待核对。'
          : '用途尚未核对，请重新读取当前周目的完整预算。';
    return `<section class="detail-block item-usage" aria-label="本周目已有用途"><h3>本周目已有用途</h3><p class="small muted">${esc(result.item.name)}${result.item.quality ? ' · ' + esc(result.item.quality) + '色品质' : ''} · 精确编号 ${esc(result.item.id)}</p>${reference ? `<p class="save-note">参照 ${esc(reference.name)}${reference.modifiedAt ? ' · ' + esc(when(reference.modifiedAt)) : ''}${reference.hash ? ' · SHA ' + esc(reference.hash.slice(0, 12)) : ''}</p>` : ''}${result.reason ? `<p class="notice" role="status">${esc(result.reason)}</p>` : ''}<div class="detail-stat-grid"><div><small>真实持有</small><strong>${count(result.stock.owned)}</strong></div><div><small>已分配真实库存</small><strong>${count(result.stock.allocated)}</strong></div><div><small>剩余可安排</small><strong>${count(result.stock.remaining)}</strong></div></div>${hasUsages ? result.usages.map(usage).join('') : `<p class="small muted">${empty}</p>`}<p class="save-note">直接材料与加工步骤分别核对；步骤数量不能相加为总占用。预计前序加工供给仍须制作，不是当前持有。</p><p class="save-note">${esc(result.notice)}</p><div class="row wrap">${act('navigate', '核对留用与用途顺序', 'text-btn', 'materials', 'shield')}</div></section>`;
  }
  return { detail };
}
