const PAGE_SIZE = 12;
export function giftStock(reference, profileId, giftId = '') {
  const planning = reference?.planning,
    identity = planning?.referenceIdentity;
  if (
    !planning?.inventoryAvailable ||
    planning.profileId !== profileId ||
    !identity ||
    identity.name !== reference.name ||
    identity.hash !== reference.hash ||
    identity.modifiedAt !== reference.modifiedAt ||
    !Array.isArray(reference.metadata?.inventory)
  )
    return null;
  const counts = {},
    used = {},
    own = {},
    available = {};
  for (const row of reference.metadata.inventory) {
    if (!Number.isSafeInteger(row.id) || row.id < 0 || !Number.isSafeInteger(row.count) || row.count < 0)
      return null;
    const count = (counts[row.id] || 0) + row.count;
    if (!Number.isSafeInteger(count)) return null;
    counts[row.id] = count;
  }
  for (const [id, count] of Object.entries(planning.physicalUsed || {})) {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(count) || count < 0 || count > (counts[id] || 0))
      return null;
    used[id] = count;
  }
  const rows = (planning.gifts || []).filter((row) => giftId && row.id === giftId);
  if (rows.length === 1 && rows[0].inventoryAvailable) {
    const row = rows[0],
      id = /^item-(\d+)$/.exec(row.itemId)?.[1];
    if (!id || !Number.isSafeInteger(row.allocated) || row.allocated < 0 || row.allocated > (used[id] || 0))
      return null;
    own[id] = row.allocated;
  }
  for (const [id, count] of Object.entries(counts))
    available[id] = Math.max(0, count - (used[id] || 0) + (own[id] || 0));
  return {
    known: true,
    counts,
    used,
    own,
    available,
    name: reference.name,
    hash: reference.hash,
    modifiedAt: reference.modifiedAt,
  };
}
const identityKey = (entry) =>
  JSON.stringify([
    entry.kind,
    entry.name,
    entry.kind === '物品' ? entry.quality : '',
    entry.kind === '物品' ? entry.type : '',
  ]);
export function giftChoiceLabel(entry, entries, counts) {
  const base =
    entry.kind === '物品'
      ? `${entry.name} · ${entry.quality ? entry.quality + '色品质' : '品质未标注'} · ${entry.type || '物品'}`
      : entry.name;
  const identical = counts
    ? counts.get(identityKey(entry))
    : entries.filter(
        (row) =>
          row.kind === entry.kind &&
          row.name === entry.name &&
          (entry.kind !== '物品' || (row.quality === entry.quality && row.type === entry.type)),
      ).length;
  return identical > 1 ? `${base} · 资料编号 ${entry.gameId ?? entry.id}` : base;
}
export function giftChoices(index, kind, view = {}) {
  const entries = index.entries || [];
  const counts = new Map();
  for (const entry of entries) counts.set(identityKey(entry), (counts.get(identityKey(entry)) || 0) + 1);
  const candidates = entries.filter((entry) =>
    kind === 'person' ? entry.kind === '人物' : entry.kind === '物品' && entry.giftable,
  );
  const terms = String(view.query || '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .filter(Boolean);
  const selected = candidates.find((entry) => entry.id === view.selectedId);
  const labels = new Map(candidates.map((entry) => [entry.id, giftChoiceLabel(entry, entries, counts)]));
  const person = entries.find((entry) => entry.id === view.personId && entry.kind === '人物');
  const rows = candidates.filter(
    (entry) =>
      (kind !== 'item' || !view.preferredOnly || (person?.hobbyKeys || []).includes(entry.typeKey)) &&
      (kind !== 'item' || !view.stockOnly || (view.stock?.known && view.stock.available[entry.gameId] > 0)) &&
      (!view.quality || view.quality === 'all' || entry.quality === view.quality) &&
      terms.every((term) =>
        `${labels.get(entry.id)} ${entry.description || ''} ${entry.id}`
          .toLocaleLowerCase('zh-CN')
          .includes(term),
      ),
  );
  const query = terms.join(' ');
  rows.sort(
    (a, b) =>
      Number(b.name.toLocaleLowerCase('zh-CN') === query) -
        Number(a.name.toLocaleLowerCase('zh-CN') === query) ||
      a.name.localeCompare(b.name, 'zh-CN') ||
      (a.gameId || 0) - (b.gameId || 0) ||
      a.id.localeCompare(b.id),
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
    page = Math.min(pages, Math.max(1, Number(view.page) || 1));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return {
    labels,
    rows: shown,
    total: rows.length,
    pages,
    page,
    selected,
    pinned: selected && !shown.some((entry) => entry.id === selected.id) ? selected : null,
  };
}
export function createGiftPicker({ esc, act, picture, qualityText }) {
  function options(index, kind, view) {
    const result = giftChoices(index, kind, view);
    const target = kind === 'person' ? 'journey-person' : 'journey-item';
    const rows = result.pinned ? [result.pinned, ...result.rows] : result.rows;
    const stock =
      kind === 'item' && result.selected && view.stock?.known
        ? `<p class="small">存档持有 ${view.stock.counts[result.selected.gameId] || 0} 件 · 其他计划已分配 ${Math.max(0, (view.stock.used[result.selected.gameId] || 0) - (view.stock.own[result.selected.gameId] || 0))} 件 · 可用于这份赠礼 ${view.stock.available[result.selected.gameId] || 0} 件</p>`
        : '';
    const preview = result.selected
      ? `<div class="detail-block row">${picture(result.selected.id)}<div><strong>${qualityText.name(result.selected.id, giftChoiceLabel(result.selected, index.entries))}</strong><p class="small muted">${esc(result.selected.description || '')}</p>${kind === 'person' && (result.selected.hobbies || []).length ? '<p class="small">偏好：' + esc(result.selected.hobbies.join('、')) + '</p>' : ''}</div></div>`
      : '<p class="save-note">尚未选择，请按名称查找后明确选择。</p>';
    return `<select id="${target}" required aria-label="${kind === 'person' ? '送给谁' : '准备赠送的物品'}"><option value=""${!result.selected ? ' selected' : ''}>请选择${kind === 'person' ? '人物' : '物品'}</option>${rows.map((entry) => `<option value="${esc(entry.id)}"${entry.id === result.selected?.id ? ' selected' : ''}>${esc(giftChoiceLabel(entry, index.entries))}${result.pinned?.id === entry.id ? ' · 当前已选' : ''}</option>`).join('')}</select><div class="row between small"><span role="status">${result.total} 项匹配 · 第 ${result.page} / ${result.pages} 页${result.pinned ? ' · 当前选择另外保留' : ''}</span><span>${result.page > 1 ? act('journey-gift-page', '上一页', 'text-btn', kind + ':' + (result.page - 1)) : ''}${result.page < result.pages ? act('journey-gift-page', '下一页', 'text-btn', kind + ':' + (result.page + 1)) : ''}</span></div>${preview}${stock}${kind === 'item' ? `<p class="save-note">${view.stock?.known ? `对照 ${esc(view.stock.name)} · ${esc(new Date(view.stock.modifiedAt).toLocaleString('zh-CN'))}；只核对已保存进度，当前赠礼原有分配可继续使用。` : '尚未取得匹配的可读存档库存；全部礼物仍可规划，数量待核对。'}偏好仅是资料线索，可否接受须在游戏内确认。</p>` : ''}${kind === 'person' && result.selected && index.entries.filter((entry) => entry.kind === '人物' && entry.name === result.selected.name).length > 1 ? '<p class="save-note">资料中有同名人物，编号用于区分原始条目；请先在图鉴核对，手札不会合并不同人物。</p>' : ''}`;
  }
  function field(index, kind, view) {
    const target = kind === 'person' ? 'journey-person' : 'journey-item';
    return `<div class="field"><label for="${target}-search">${kind === 'person' ? '送给谁' : '准备赠送的物品'}</label><input id="${target}-search" type="search" maxlength="100" value="${esc(view.query || '')}" placeholder="${kind === 'person' ? '按人物姓名查找' : '按物品名、品质或类别查找'}" aria-label="${kind === 'person' ? '查找赠礼人物' : '查找赠礼物品'}">${kind === 'item' ? `<label class="small" for="journey-item-quality">物品品质</label><select id="journey-item-quality"><option value="all">全部品质</option>${['白', '绿', '蓝', '金', '暗金', '红'].map((q) => `<option value="${q}"${view.quality === q ? ' selected' : ''}>${q}色品质</option>`).join('')}</select><div class="row wrap small"><label><input id="journey-item-preferred" type="checkbox"${view.preferredOnly ? ' checked' : ''}> 只看符合人物偏好的资料</label><label><input id="journey-item-stock" type="checkbox"${view.stockOnly ? ' checked' : ''}${view.stock?.known ? '' : ' disabled'}> 只看可用于这份赠礼的库存</label></div>` : ''}<div id="${target}-options">${options(index, kind, view)}</div></div>`;
  }
  return { field, options };
}
