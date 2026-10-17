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
  const variants = identical > 1 ? entries.filter((row) => identityKey(row) === identityKey(entry)) : [];
  return identical > 1
    ? `${base} · ${entry.kind === '人物' && entry.identityHint ? entry.identityHint : `同名 ${variants.findIndex((row) => row.id === entry.id) + 1}/${identical}`}`
    : base;
}
export function hasNoGiftEntry(person) {
  return Array.isArray(person?.functions) && !person.functions.includes('Gift');
}
export function giftChoices(index, kind, view = {}) {
  const entries = index.entries || [];
  const counts = new Map();
  for (const entry of entries) counts.set(identityKey(entry), (counts.get(identityKey(entry)) || 0) + 1);
  const allCandidates = entries.filter((entry) =>
    kind === 'person' ? entry.kind === '人物' : entry.kind === '物品' && entry.giftable,
  );
  const terms = String(view.query || '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .filter(Boolean);
  const selected = allCandidates.find((entry) => entry.id === view.selectedId);
  const candidates = allCandidates.filter((entry) => kind !== 'person' || !hasNoGiftEntry(entry));
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
  const excludedMatch =
    kind === 'person' &&
    terms.length > 0 &&
    allCandidates.some(
      (entry) =>
        hasNoGiftEntry(entry) &&
        terms.every((term) => (entry.name + ' ' + entry.id).toLocaleLowerCase('zh-CN').includes(term)),
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
    excludedMatch,
    rows: shown,
    total: rows.length,
    pages,
    page,
    selected,
    pinned: selected && !shown.some((entry) => entry.id === selected.id) ? selected : null,
  };
}
export function createGiftPicker({ esc, act, picture, qualityText }) {
  const target = (kind) => (kind === 'person' ? 'journey-person' : 'journey-item');
  const noun = (kind) => (kind === 'person' ? '人物' : '物品');
  function filterLabels(kind, view) {
    if (kind !== 'item') return [];
    return [
      view.quality && view.quality !== 'all' ? view.quality + '色品质' : '',
      view.preferredOnly ? '符合偏好' : '',
      view.stockOnly ? '有可用库存' : '',
    ].filter(Boolean);
  }
  function choiceSummary(kind, view, selected) {
    const filters = filterLabels(kind, view);
    return `${selected ? '改选' : '选择'}${noun(kind)}${view.query ? ' · “' + esc(view.query.slice(0, 32)) + (view.query.length > 32 ? '…' : '') + '”' : ''}${filters.length ? ' · ' + esc(filters.join('、')) : ''}`;
  }
  function selection(index, kind, view) {
    const result = giftChoices(index, kind, view),
      selected = result.selected;
    if (!selected) return `<p class="gift-selection-empty">尚未选择${noun(kind)}</p>`;
    const facts = [
      selected.description,
      kind === 'person' && selected.hobbies?.length ? '偏好：' + selected.hobbies.join('、') : '',
    ].filter(Boolean);
    const gift = kind === 'person' && !hasNoGiftEntry(selected) ? view.progress?.gift : null;
    const gateChecks = gift?.checks?.filter((check) => check.status !== 'met') || [];
    const primaryCheck =
      gateChecks.find((check) => check.status === (gift?.status === 'unmet' ? 'unmet' : 'unknown')) ||
      gateChecks[0];
    const condition = (check) => {
      const name = String(check.name || '').replace(/^【[^】]+】\s*/, ''),
        at = name ? check.text.indexOf(name) : -1;
      return check.entityId && at >= 0
        ? esc(check.text.slice(0, at)) +
            act(
              check.entityId.startsWith('quest-') ? 'world-quest' : 'database-detail',
              esc(name),
              'text-btn',
              check.entityId,
            ) +
            esc(check.text.slice(at + name.length))
        : esc(check.text);
    };
    const gateHint =
      kind !== 'person' || hasNoGiftEntry(selected)
        ? ''
        : gift?.status === 'unmet'
          ? '<p class="gift-condition-warning">' +
            (view.progressOrigin === 'live' ? '暂不能赠礼' : '保存时暂不能赠礼') +
            (primaryCheck ? '：' + condition(primaryCheck) : '') +
            '</p>'
          : gift?.status === 'met'
            ? '<p class="small">' + (view.progressOrigin === 'live' ? '可赠礼' : '保存时可赠礼') + '</p>'
            : '<p class="small">赠礼条件待核对' +
              (primaryCheck ? '：' + condition(primaryCheck) : '') +
              '</p>';
    const qualities = ['白', '绿', '蓝', '金', '暗金', '红'],
      minimum = qualities.indexOf(view.minimumQuality),
      quality = qualities.indexOf(selected.quality);
    const qualityHint =
      kind === 'item' && minimum >= 0 && quality >= 0 && quality < minimum
        ? `<p class="gift-condition-warning">礼物需要至少${esc(view.minimumQuality)}色品质。</p>`
        : '';
    const moreChecks = gateChecks
      .filter((check) => check !== primaryCheck)
      .map((check) => '<p class="small">' + condition(check) + '</p>')
      .join('');
    const stock =
      kind === 'item'
        ? view.stock?.known
          ? `<p class="gift-stock" role="status" title="保存于 ${esc(new Date(view.stock.modifiedAt).toLocaleString('zh-CN'))}">保存时持有 ${view.stock.counts[selected.gameId] || 0} · 其他安排 ${Math.max(0, (view.stock.used[selected.gameId] || 0) - (view.stock.own[selected.gameId] || 0))} · 这份可用 ${view.stock.available[selected.gameId] || 0}</p>`
          : '<p class="gift-stock" role="status">库存暂未读取，可先规划赠礼。</p>'
        : '';
    return `<div class="gift-selected">${act('database-detail', esc(giftChoiceLabel(selected, index.entries)), 'text-btn gift-selected-link', selected.id)}${stock}${gateHint}${qualityHint}${facts.length || moreChecks ? `<details class="gift-selected-facts"><summary>详情</summary>${moreChecks}${facts.map((text) => '<p class="small">' + esc(text) + '</p>').join('')}</details>` : ''}</div>${kind === 'person' && hasNoGiftEntry(selected) ? '<p class="notice">此人物暂无赠礼入口，请改选人物。已有安排仍保留。</p>' : ''}`;
  }
  function options(index, kind, view) {
    const result = giftChoices(index, kind, view),
      id = target(kind);
    const rows = result.pinned ? [result.pinned, ...result.rows] : result.rows;
    return `<select id="${id}" class="gift-exact-select" required tabindex="-1" aria-hidden="true" aria-label="${kind === 'person' ? '送给谁' : '准备赠送的物品'}"><option value=""${!result.selected ? ' selected' : ''}>请选择${noun(kind)}</option>${rows.map((entry) => `<option value="${esc(entry.id)}"${entry.id === result.selected?.id ? ' selected' : ''}${kind === 'person' && hasNoGiftEntry(entry) ? ' disabled' : ''}>${esc(giftChoiceLabel(entry, index.entries))}${entry.id === result.pinned?.id ? ' · 当前已选' : ''}</option>`).join('')}</select><div class="gift-choice-grid" aria-label="${noun(kind)}候选">${result.rows.map((entry) => `<button type="button" class="gift-choice-card${entry.id === result.selected?.id ? ' selected' : ''}" data-action="journey-gift-select" data-id="${kind}:${esc(entry.id)}" aria-label="选择${esc(giftChoiceLabel(entry, index.entries))}" aria-pressed="${entry.id === result.selected?.id}">${picture(entry.id)}<span>${qualityText.name(entry.id, giftChoiceLabel(entry, index.entries))}</span></button>`).join('')}</div><div class="row between gift-choice-pagination"><span class="small" role="status">${result.total ? `${result.total} 项 · ${result.page}/${result.pages}` : result.excludedMatch ? '匹配的人物暂无赠礼入口。' : '没有匹配结果'}</span><span>${result.page > 1 ? act('journey-gift-page', '上一页', 'text-btn', kind + ':' + (result.page - 1)) : ''}${result.page < result.pages ? act('journey-gift-page', '下一页', 'text-btn', kind + ':' + (result.page + 1)) : ''}</span></div>`;
  }
  function field(index, kind, view) {
    const id = target(kind),
      selected = giftChoices(index, kind, view).selected,
      filters = filterLabels(kind, view);
    return `<section class="field gift-field" data-gift-field="${kind}"><h3>${kind === 'person' ? '送给谁' : '赠送物品'}</h3><div id="${id}-selection">${selection(index, kind, view)}</div><details class="gift-choice-editor" id="${id}-picker"${selected ? '' : ' open'}><summary>${choiceSummary(kind, view, selected)}</summary><label for="${id}-search" class="visually-hidden">查找赠礼${noun(kind)}</label><input id="${id}-search" type="search" maxlength="100" value="${esc(view.query || '')}" placeholder="${kind === 'person' ? '搜索人物姓名' : '搜索物品、品质或类别'}" aria-label="查找赠礼${noun(kind)}">${kind === 'item' ? `<details class="gift-choice-filters"><summary>筛选${filters.length ? ' · ' + esc(filters.join('、')) : ''}</summary><label class="small" for="journey-item-quality">物品品质</label><select id="journey-item-quality"><option value="all">全部品质</option>${['白', '绿', '蓝', '金', '暗金', '红'].map((q) => `<option value="${q}"${view.quality === q ? ' selected' : ''}>${q}色品质</option>`).join('')}</select><label><input id="journey-item-preferred" type="checkbox"${view.preferredOnly ? ' checked' : ''}> 符合人物偏好</label><label><input id="journey-item-stock" type="checkbox"${view.stockOnly ? ' checked' : ''}${view.stock?.known ? '' : ' disabled'}> 有可用库存</label>${act('journey-gift-filter-clear', '清除筛选', 'text-btn', 'item')}</details>` : ''}<div id="${id}-options">${options(index, kind, view)}</div></details></section>`;
  }
  return { field, options, selection, choiceSummary };
}
