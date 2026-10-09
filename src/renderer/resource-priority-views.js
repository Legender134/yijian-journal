export function createResourcePriorityViews({ esc, act, notice, when }) {
  function entry(summary) {
    if (!summary?.priorityOwners?.length || summary.priorityOwners.length < 2) return '';
    if (!summary.explicitPriority && !(summary.directMissingTotal > 0)) return '';
    return `<section class="card mt"><div class="card-header"><h2>这些打算怎样分配材料</h2>${act('resource-priority-open', '预览并调整顺序', 'btn', '', 'edit')}</div><p class="save-note">按当前核对参照${summary.referenceIdentity ? '「' + esc(summary.referenceIdentity.name) + '」' : '（库存待核对）'}核对。留用和任务预留先保留；制作与赠礼的直接材料按用途顺序分配，再用剩余库存安排加工。${summary.explicitPriority ? '已采用你确认的顺序，打开另一份计划不会改变它。' : '目前按编辑清单及保存顺序核对；材料争用时可选择先支持哪项打算。'}顺序只分配材料；全部制作费仍需共同支付。</p><ol class="resource-priority-current">${summary.priorityOwners.map((row) => `<li>${esc(row.name)}</li>`).join('')}</ol></section>`;
  }
  function editor(draft, index) {
    const result = draft.preview;
    const name = (id) => index.entries.find((e) => e.id === 'item-' + id)?.name || '物品 #' + id;
    const changes = result?.changes || [];
    const missing = (rows) =>
      rows.some((r) => r.count === null) ? '待核对' : rows.reduce((n, r) => n + r.count, 0);
    return `<div class="resource-priority-editor"><p class="save-note">把先要办的事项上移。下面会显示分配变化；确认前不会改动现有顺序。留用与任务预留继续保留。</p><div class="resource-priority-order" aria-label="拟定的物资用途顺序">${(draft.loading
      ? draft.order
      : result?.afterOrder || draft.order
    )
      .map((id, i, all) => {
        const row = changes.find((o) => o.id === id);
        const label = row?.name || draft.labels?.[id] || '待核对的用途';
        return `<div class="backup-row"><span class="spacer">${i + 1}. ${esc(label)}</span><button class="btn" data-action="resource-priority-move" data-id="${esc(id)}" data-direction="up" aria-label="上移 ${esc(label)}" ${i === 0 || draft.loading || !result ? 'disabled' : ''}>上移</button><button class="btn" data-action="resource-priority-move" data-id="${esc(id)}" data-direction="down" aria-label="下移 ${esc(label)}" ${i === all.length - 1 || draft.loading || !result ? 'disabled' : ''}>下移</button></div>`;
      })
      .join(
        '',
      )}</div><div class="row wrap">${act('resource-priority-reset', '预览恢复默认顺序', 'text-btn')}${act('resource-priority-refresh', '重新核对这份顺序', 'text-btn')}${draft.loading ? '<span role="status">正在重新核对…</span>' : ''}</div>${draft.error ? notice(draft.error) : ''}${
      result
        ? `<p class="save-note">${result.referenceIdentity ? `对照 ${esc(result.referenceIdentity.name)} · ${when(result.referenceIdentity.modifiedAt)} · SHA ${esc(result.referenceIdentity.hash.slice(0, 12))}` : '没有可读存档参照；可以保存顺序，分配变化待核对。'}</p><div class="resource-priority-changes" aria-label="确认前的材料分配变化">${!result.inventoryAvailable ? notice('库存未知，下面不把未核对的用量写成零。', true) : ''}${changes
            .map(
              (row) =>
                `<details class="detail-block" open><summary>${esc(row.name)} · 直接材料缺口 ${missing(row.beforeMissing)} → ${missing(row.afterMissing)}</summary>${result.inventoryAvailable ? row.items.map((item) => `<p class="small">${esc(name(item.id))} · 直接分配 ${item.beforeDirect} → ${item.afterDirect}${item.beforeProcessing || item.afterProcessing ? ` · 加工另占 ${item.beforeProcessing} → ${item.afterProcessing}` : ''}</p>`).join('') || '<p class="small muted">未分配实际库存</p>' : '<p class="small muted">实际分配待核对</p>'}${row.kind === 'craft' ? `<p class="small muted">加工后原料缺口 ${row.beforeRawMissing ?? '待核对'} → ${row.afterRawMissing ?? '待核对'}</p>` : ''}${row.afterMissing
                  .filter((m) => m.count > 0)
                  .map(
                    (m) =>
                      `<p class="small">${esc(m.ids.length === 1 ? name(m.ids[0]) : m.name)}还缺 ${m.count}${m.ids.length > 1 ? ' · 可替代材料组总缺量' : ''}</p>`,
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
