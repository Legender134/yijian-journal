export function createSearchHelpViews({ esc, fields }) {
  function help(values = {}) {
    return `<div class="search-filter-help"><p class="small muted">直接输入关键词即可搜索。需要缩小范围时，选择一种筛选；输入冒号后会提示可选值。</p>${fields
      .map(
        (field) =>
          `<div class="search-filter-row"><div><button class="text-btn" data-action="search-filter-insert" data-id="${esc(field.name + ':')}">${esc(field.name)}:</button><span class="small muted">${esc(field.aliases.join(' / '))} · ${esc(field.description)}</span></div><div class="row wrap">${(values[
            field.key
          ]?.length
            ? values[field.key]
            : field.examples
          )
            .slice(0, field.key === 'quality' || field.key === 'status' || field.key === 'kind' ? 20 : 6)
            .map(
              (value) =>
                `<button class="chip" data-action="search-filter-insert" data-id="${esc(field.name + ':' + (/\s|[():："'\\]/.test(value) ? JSON.stringify(value) : value))}">${esc(value)}</button>`,
            )
            .join(
              '',
            )}</div>${['type', 'name', 'location', 'tags'].includes(field.key) ? '<p class="small muted">可以填写任意文字，以上仅为示例。</p>' : ''}</div>`,
      )
      .join(
        '',
      )}<p class="small muted">空格组合条件：种类:物品 品质:蓝。or / 或表示满足其中一种；- 排除，例如 -品质:白。括号组合条件；引号保留整句，例如 名称:"小二-王宸"。英文冒号与中文冒号都可使用。</p></div>`;
  }
  function suggestions(rows, active) {
    if (!rows.length) return '';
    return `<div class="search-suggestions-heading small muted">筛选补全 · ↑↓ 选择，Tab 或 Enter 填入</div><div role="listbox" id="search-filter-options" aria-label="可用的筛选内容">${rows.map((row, index) => `<button class="search-filter-suggestion" role="option" id="search-filter-option-${index}" aria-selected="${index === active}" data-action="search-filter-suggestion" data-id="${index}"><strong>${esc(row.label)}</strong><small>${esc(row.description)}</small></button>`).join('')}</div>`;
  }
  return { help, suggestions };
}
