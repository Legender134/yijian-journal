export function createResourcePriorityViews({ esc, act, notice, when, getIndex = () => null }) {
  function ownerName(row, index = getIndex()) {
    if (row?.kind !== 'gift' || !row.gift) return esc(row?.name || '待核对的用途');
    const gift = row.gift,
      entity = (id, name, kind) =>
        index?.entries?.some((entry) => entry.id === id && entry.kind === kind)
          ? act('database-detail', esc(name), 'text-btn', id)
          : esc(name);
    return (
      '赠予' + entity(gift.npcId, gift.npcName, '人物') + ' · ' + entity(gift.itemId, gift.itemName, '物品')
    );
  }
  function entry(summary) {
    if (!summary?.priorityOwners?.length || summary.priorityOwners.length < 2) return '';
    if (!summary.explicitPriority && !(summary.directMissingTotal > 0)) return '';
    return `<section class="card mt"><div class="card-header"><h2>这些打算怎样分配材料</h2>${act('resource-priority-open', '预览并调整顺序', 'btn', '', 'edit')}</div><ol class="resource-priority-current">${summary.priorityOwners.map((row) => `<li>${ownerName(row)}${row.description ? `<p class="small preserve-text">${esc(row.description)}</p>` : ''}</li>`).join('')}</ol></section>`;
  }
  function editor(draft, index) {
    const result = draft.preview;
    const itemLink = (id) => {
      const entry = index.entries.find((e) => e.id === 'item-' + id);
      return entry ? act('database-detail', esc(entry.name), 'text-btn', entry.id) : esc('物品 #' + id);
    };
    const changes = result?.changes || [];
    const missing = (rows) =>
      rows.some((r) => r.count === null) ? '待核对' : rows.reduce((n, r) => n + r.count, 0);
    return `<div class="resource-priority-editor"><p class="save-note">把先要办的事项上移。下面会显示分配变化；确认前不会改动现有顺序。留用与任务预留继续保留。</p><div class="resource-priority-order" aria-label="拟定的物资用途顺序">${(draft.loading
      ? draft.order
      : result?.afterOrder || draft.order
    )
      .map((id, i, all) => {
        const row = changes.find((o) => o.id === id) || draft.owners?.[id];
        const label = row?.name || draft.labels?.[id] || '待核对的用途';
        const fullLabel = row?.description ? label + ' · ' + row.description : label;
        return `<div class="backup-row"><div class="spacer">${i + 1}. ${row ? ownerName(row, index) : esc(label)}${row?.description ? `<p class="small preserve-text">${esc(row.description)}</p>` : ''}</div><button class="btn" data-action="resource-priority-move" data-id="${esc(id)}" data-direction="up" aria-label="上移 ${esc(fullLabel)}" ${i === 0 || draft.loading || !result ? 'disabled' : ''}>上移</button><button class="btn" data-action="resource-priority-move" data-id="${esc(id)}" data-direction="down" aria-label="下移 ${esc(fullLabel)}" ${i === all.length - 1 || draft.loading || !result ? 'disabled' : ''}>下移</button></div>`;
      })
      .join(
        '',
      )}</div><div class="row wrap">${act('resource-priority-reset', '预览恢复默认顺序', 'text-btn')}${act('resource-priority-refresh', '重新核对这份顺序', 'text-btn')}${draft.loading ? '<span role="status">正在重新核对…</span>' : ''}</div>${draft.error ? notice(draft.error) : ''}${
      result
        ? `<div class="resource-priority-changes" aria-label="确认前的材料分配变化">${!result.inventoryAvailable ? notice('库存未读取', true) : ''}${changes
            .map(
              (row) =>
                `<details class="detail-block" open><summary>${ownerName(row, index)} · 直接材料缺口 ${missing(row.beforeMissing)} → ${missing(row.afterMissing)}</summary>${row.description ? `<p class="small preserve-text">${esc(row.description)}</p>` : ''}${result.inventoryAvailable ? row.items.map((item) => `<p class="small">${itemLink(item.id)} · 直接分配 ${item.beforeDirect} → ${item.afterDirect}${item.beforeProcessing || item.afterProcessing ? ` · 加工另占 ${item.beforeProcessing} → ${item.afterProcessing}` : ''}</p>`).join('') || '<p class="small muted">未分配实际库存</p>' : '<p class="small muted">实际分配待核对</p>'}${row.kind === 'craft' ? `<p class="small muted">加工后原料缺口 ${row.beforeRawMissing ?? '待核对'} → ${row.afterRawMissing ?? '待核对'}</p>` : ''}${row.afterMissing
                  .filter((m) => m.count > 0)
                  .map(
                    (m) =>
                      `<p class="small">${m.ids.map(itemLink).join(' / ') || esc(m.name)}还缺 ${m.count}${m.ids.length > 1 ? ' · 可替代材料组总缺量' : ''}</p>`,
                  )
                  .join('')}</details>`,
            )
            .join(
              '',
            )}</div><p class="save-note">预计加工产物仍须在游戏内制作。存档或计划变化后，旧预览需要重新核对。</p>`
        : '<p class="save-note">已保留你拟定的顺序；材料分配待重新核对。用途若已修改或移除，重新核对时会一并提示。</p>'
    }</div>`;
  }
  return { entry, editor };
}
