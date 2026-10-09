export function createBackupViews({ esc, act, pill, icon, iconButton, empty, when, bytes }) {
  function anomalies(rows = []) {
    if (!rows.length) return '';
    return `<section class="card mb backup-anomalies" aria-label="异常副本目录"><h2>异常副本目录 · ${rows.length}</h2><p class="notice">这些目录的清单无法确认，原始文件仍保留。它们不计入完整备份数量，不能恢复、选择导出或清理。请保留原件，从完好的原保护包重新导入或重新备份；不要自行补写清单。</p>${rows.map((row) => `<div class="backup-row" data-abnormal-backup="${esc(row.id)}"><div class="backup-symbol">${icon('archive')}</div><div class="spacer"><h3>副本目录 · 需核对 ${pill('异常')}</h3><p><strong>${esc(row.reason)}</strong><br><span class="mono">${esc(row.id)}</span><br><span class="mono">${esc(row.directory)}</span></p>${row.diagnostic ? `<details><summary>查看诊断原因</summary><p>${esc(row.diagnostic)}</p></details>` : ''}<p class="small muted">保留该目录供核对；重新导入会建立独立副本。</p></div>${act('backup-folder', '打开此目录', 'btn', row.id, 'folder')}</div>`).join('')}</section>`;
  }
  function filtered(backups, view) {
    const query = (view.query || '').trim().toLowerCase();
    return backups
      .filter((b) => {
        const date = new Date(b.createdAt);
        const day = Number.isFinite(date.getTime())
          ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          : '';
        return (
          (!query ||
            `${b.label} ${b.kind} ${b.createdAt} ${(b.files || []).map((f) => f.name).join(' ')}`
              .toLowerCase()
              .includes(query)) &&
          (!view.lock || view.lock === 'all' || (view.lock === 'locked') === !!b.locked) &&
          (!view.kind || view.kind === 'all' || b.kind === view.kind) &&
          (!view.from || day >= view.from) &&
          (!view.to || day <= view.to)
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  function page(backups, view, historical = false) {
    const prefix = historical ? 'historical-backup' : 'backup',
      matches = filtered(backups, view);
    const pages = Math.max(1, Math.ceil(matches.length / 20));
    const current = Math.min(pages - 1, Math.max(0, view.page || 0));
    const shown = matches.slice(current * 20, current * 20 + 20);
    const available = new Map(backups.map((b) => [b.id, b]));
    const selected = new Set((view.selected || []).filter((id) => available.has(id)));
    const selectedRows = [...selected].map((id) => available.get(id)),
      lockedSelected = selectedRows.some((b) => b.locked);
    const totalBytes = backups.reduce(
      (sum, b) => sum + (b.bytes ?? b.files?.reduce((n, f) => n + f.bytes, 0) ?? 0),
      0,
    );
    const filters = `<div class="row wrap mb backup-filters"><label class="search-input"><input id="${prefix}-search" data-persist="${prefix}-search" maxlength="100" value="${esc(view.query || '')}" aria-label="查找完整备份" placeholder="查名称、日期或文件"></label><label>类型 <select id="${prefix}-kind">${[
      ['all', '全部'],
      ['auto', '自动'],
      ['manual', '手动'],
      ['safety', '恢复前保护'],
      ['imported', '已绑定历史副本'],
    ]
      .map(([id, label]) => `<option value="${id}" ${view.kind === id ? 'selected' : ''}>${label}</option>`)
      .join(
        '',
      )}</select></label>${historical ? '' : `<label>锁定 <select id="backup-lock"><option value="all">全部</option><option value="locked" ${view.lock === 'locked' ? 'selected' : ''}>已锁定</option><option value="unlocked" ${view.lock === 'unlocked' ? 'selected' : ''}>可清理</option></select></label>`}<label>从 <input id="${prefix}-from" type="date" value="${esc(view.from || '')}" aria-label="完整备份开始日期"></label><label>到 <input id="${prefix}-to" type="date" value="${esc(view.to || '')}" aria-label="完整备份结束日期"></label></div>`;
    const selection = historical
      ? ''
      : `<div class="row wrap mb">${act('backup-select-page', '选择本页', 'btn', '', 'check')}${act('backup-selection-clear', '清空选择', 'text-btn')}<span class="small muted">已选 ${selected.size} 份 · 可跨页选择</span>${selected.size ? act('backup-export-selected', '导出所选完整备份', 'btn', '', 'download') + (!lockedSelected ? act('backup-cleanup-selected', '导出并清理所选…', 'btn danger', '', 'trash') : '<span class="small muted">含已锁定副本，清理前请取消选择或逐份解锁</span>') : ''}${selected.size ? `<details class="selected-backup-summary"><summary>核对已选 ${selected.size} 份 · ${bytes(selectedRows.reduce((n, b) => n + b.bytes, 0))}</summary>${selectedRows.map((b) => `<p>${esc(b.label)} · ${when(b.createdAt)}${b.locked ? ' · 已锁定' : ''}</p>`).join('')}</details>` : ''}</div><p class="save-note">分批导出会包含全部周目的手札和所选完整备份；时间线与以前导入的档案请用上方「导出全部保护资料」。每批最多 1000 份、2 GiB，单纯导出保留原件；「导出并清理」先校验留底，再逐批确认。恢复前保护副本默认锁定，不会自动清理。</p>`;
    const rows = shown
      .map(
        (b) =>
          `<div class="backup-row">${historical ? '' : `<input type="checkbox" data-action="backup-selection" data-id="${esc(b.id)}" aria-label="选择 ${esc(b.label)}" ${selected.has(b.id) ? 'checked' : ''}>`}<div class="backup-symbol">${icon(b.kind === 'safety' ? 'shield' : 'archive')}</div><div class="spacer"><h3>${esc(b.label)} ${b.kind === 'auto' ? pill('自动') : b.kind === 'safety' ? pill('保护副本', 'green') : ''}${b.locked ? pill('已锁定', 'green') : ''}</h3><p>${when(b.createdAt)} · ${b.count ?? b.files?.length ?? 0} 个文件 · ${bytes(b.bytes ?? b.files?.reduce((n, f) => n + f.bytes, 0) ?? 0)}${b.verificationError ? `<br><strong>校验未通过 · ${esc(b.verificationError)}</strong>` : ''}</p></div>${historical ? act('protection-backup-select', view.backupId === b.id ? '已展开' : '查看文件', 'btn', b.id, 'book') : act(b.locked ? 'backup-unlock' : 'backup-lock', b.locked ? '解锁…' : '锁定', 'text-btn', b.id, 'shield') + iconButton('verify', 'shield', '校验完整性', b.id) + act('backup-preview', '查看副本', 'btn', b.id, 'eye')}</div>`,
      )
      .join('');
    return `${filters}${view.from && view.to && view.from > view.to ? '<p class="notice">开始日期不能晚于结束日期</p>' : ''}<p class="small muted" role="status">筛选到 ${matches.length} / ${backups.length} 份完整备份 · 文件占用 ${bytes(totalBytes)}</p>${selection}<div class="card">${rows || empty('没有符合条件的备份', '调整名称、类型或日期，再重新查找。')}</div>${pages > 1 ? `<div class="pagination">${act(prefix + '-page', '上一页', 'btn', String(Math.max(0, current - 1)))}<span>第 ${current + 1} / ${pages} 页</span>${act(prefix + '-page', '下一页', 'btn', String(Math.min(pages - 1, current + 1)))}</div>` : ''}`;
  }
  return { page, filtered, anomalies };
}
