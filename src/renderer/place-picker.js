const PAGE_SIZE = 12;
export function placeChoiceLabel(place, maps) {
  return maps.some((row) => row.id !== place.id && row.name === place.name)
    ? `${place.name} · 资料场景 #${place.gameId}`
    : place.name;
}
export function placeChoices(index, view = {}) {
  const maps = index.world.maps;
  const terms = String(view.query || '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .filter(Boolean);
  const labels = new Map(maps.map((place) => [place.id, placeChoiceLabel(place, maps)]));
  const rows = maps
    .filter((place) => {
      const aliases = (index.world.placeAliases || [])
        .filter((entry) => entry.name === place.name)
        .flatMap((entry) => entry.mentions || []);
      const text = [labels.get(place.id), place.description || '', place.id, ...aliases]
        .join(' ')
        .toLocaleLowerCase('zh-CN');
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.gameId - b.gameId || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(view.page) || 1));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = maps.find((place) => place.id === view.selectedId);
  return {
    rows: shown,
    labels,
    total: rows.length,
    pages,
    page,
    selected,
    pinned: selected && !shown.some((place) => place.id === selected.id) ? selected : null,
  };
}
export function createPlacePicker({ esc, act }) {
  function options(index, view) {
    const result = placeChoices(index, view);
    const rows = result.pinned ? [result.pinned, ...result.rows] : result.rows;
    return `<select id="journey-place" aria-label="想去的地点"><option value=""${!result.selected ? ' selected' : ''}>地点未定</option>${rows.map((place) => `<option value="${esc(place.id)}"${place.id === result.selected?.id ? ' selected' : ''}>${esc(result.labels.get(place.id))}${place.id === result.pinned?.id ? ' · 当前已选' : ''}</option>`).join('')}</select><div class="row between small"><span role="status">${result.total} 项匹配 · 第 ${result.page} / ${result.pages} 页${result.pinned ? ' · 当前选择另外保留' : ''}</span><span>${result.page > 1 ? act('journey-place-page', '上一页', 'text-btn', String(result.page - 1)) : ''}${result.page < result.pages ? act('journey-place-page', '下一页', 'text-btn', String(result.page + 1)) : ''}</span></div>${result.selected ? `<p class="save-note">当前地点：${esc(result.labels.get(result.selected.id))}${result.selected.description ? ' · ' + esc(result.selected.description) : ''}</p>` : '<p class="save-note">可暂不指定地点。搜索和翻页不会替你改选。</p>'}`;
  }
  function field(index, view, label = '想去的地点') {
    return `<div class="field"><label for="journey-place-search">${esc(label)}</label><input id="journey-place-search" type="search" maxlength="100" value="${esc(view.query || '')}" placeholder="输入地点名，例如：武当山" aria-label="查找行程地点"><div id="journey-place-options">${options(index, view)}</div></div>`;
  }
  return { options, field };
}
