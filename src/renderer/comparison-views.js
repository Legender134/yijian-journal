export function createComparisonViews({ esc, act, iconButton, pill, notice, when, hours, icon, picture }) {
  const signed = (value) => `${value > 0 ? '+' : ''}${value.toLocaleString()}`;
  const timeDelta = (value) => {
    const seconds = Math.abs(value),
      sign = value < 0 ? '−' : value > 0 ? '+' : '';
    return (
      sign +
      (seconds < 60 ? `${seconds} 秒` : `${hours(seconds)}${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`)
    );
  };
  function shell(files, view) {
    const options = (selected) =>
      files
        .map(
          (f) =>
            `<option value="${esc(f.name)}" ${f.name === selected ? 'selected' : ''}>${esc(f.name)} · ${esc(f.metadata.mapName)} · ${hours(f.metadata.playSeconds)}</option>`,
        )
        .join('');
    return `<section class="drawer comparison-drawer" role="dialog" aria-modal="true" aria-label="两份存档对比"><div class="drawer-head"><span class="small muted">存档匣 / 只读对比</span>${iconButton('close-overlay', 'close', '关闭存档对比')}</div><div class="drawer-body"><h1>两份存档，哪里不同？</h1><p class="save-note">差值为右侧减左侧。所选槽位可以来自不同周目；这里比较的是已保存的记录。</p><div class="compare-selectors"><div class="field"><label for="compare-left">左侧存档</label><select id="compare-left">${options(view.left)}</select></div>${iconButton('compare-swap', 'refresh', '交换左右存档')}<div class="field"><label for="compare-right">右侧存档</label><select id="compare-right">${options(view.right)}</select></div></div><div class="row compare-controls">${act('compare-run', '比较记录', 'btn primary', '', 'search')}${act('compare-refresh', '刷新槽位', 'btn', '', 'refresh')}<span id="compare-status" class="small muted" role="status"></span></div><div id="comparison-result">${view.result ? result(view.result, view) : '<div class="compare-empty">' + icon('scroll') + '<p>选好左右槽位，点击「比较记录」。</p></div>'}</div></div></section>`;
  }
  function recap(file, side) {
    return `<div class="compare-recap"><small>${side} · ${esc(file.name)}</small><h3>${esc(file.mapName)}</h3><p>${when(file.modifiedAt)} · ${hours(file.playSeconds)}</p><p>铜钱 ${file.money === null ? '未读取' : file.money.toLocaleString() + ' 文'} · ${esc(file.difficultyName || '难度未读取')}</p><p class="compare-tracked">主线：${esc(file.mainQuest || '未记录')}<br>支线：${esc(file.sideQuest || '未记录')}</p></div>`;
  }
  function inventory(diff, index, query = '', filter = 'all') {
    if (!diff.inventory.available) return notice('至少一份存档的背包未能读取，暂不计算物品数量差异。', true);
    const q = query.trim().toLowerCase(),
      rows = diff.inventory.changes.filter(
        (i) =>
          (filter === 'all' || (filter === 'more' ? i.delta > 0 : i.delta < 0)) &&
          (!q || `${i.name} ${i.type} ${i.quality || ''}色品质`.toLowerCase().includes(q)),
      );
    return `<div class="compare-list-head"><span>物品 / 左侧 → 右侧</span><span>数量差值</span></div>${
      rows
        .slice(0, 60)
        .map(
          (i) =>
            `<div class="compare-item"><div class="spacer">${index.entries.some((e) => e.id === `item-${i.id}`) ? act('database-detail', esc(i.name), 'text-btn', `item-${i.id}`) : esc(i.name)}<small>${esc(i.type)}${i.quality ? ` · ${esc(i.quality)}色品质` : ''} · ${i.left.toLocaleString()} → ${i.right.toLocaleString()}</small></div><strong class="${i.delta > 0 ? 'delta-more' : 'delta-less'}">${signed(i.delta)}</strong></div>`,
        )
        .join('') || '<p class="save-note">这个筛选下没有物品数量差异。</p>'
    }${rows.length > 60 ? `<p class="save-note">还有 ${rows.length - 60} 项，请输入名称缩小范围。</p>` : ''}`;
  }
  function quests(diff, query = '') {
    if (!diff.quests.available) return notice('至少一份存档的任务记录未能读取，暂不比较任务状态。', true);
    const q = query.trim().toLowerCase(),
      rows = diff.quests.changes.filter((i) => !q || i.name.toLowerCase().includes(q));
    return `${
      rows
        .slice(0, 60)
        .map(
          (i) =>
            `<div class="compare-quest"><h3>${esc(i.name)}</h3><div class="row">${pill(i.left)}${icon('arrow')}${pill(i.right, i.rightStep === 4 ? 'green' : '')}${i.parentId ? '<small class="muted">任务步骤</small>' : ''}</div></div>`,
        )
        .join('') || '<p class="save-note">没有匹配的任务状态差异。</p>'
    }${rows.length > 60 ? `<p class="save-note">还有 ${rows.length - 60} 项，请搜索任务名缩小范围。</p>` : ''}<p class="save-note">未出现在某份记录中，只表示该槽位没有这条可见记录。任务文字可在各自的存档回顾中查看。</p>`;
  }
  function members(group, index, kind) {
    if (!group.available) return '<p class="save-note">至少一份存档未读取到这组记录。</p>';
    const list = (items, side) =>
      `<div class="compare-member-column"><small>${side}</small><div class="tag-row">${items.map((i) => (index.entries.some((e) => e.id === `${kind}-${i.id}`) ? act('database-detail', esc(i.name), 'btn', `${kind}-${i.id}`) : `<span class="pictured-label">${picture(`${kind}-${i.id}`)}${pill(i.name)}</span>`)).join('') || '<span class="small muted">无</span>'}</div></div>`;
    return `<div class="compare-member-grid">${list(group.leftOnly, '仅在左侧')}${list(group.rightOnly, '仅在右侧')}</div>`;
  }
  function recipes(diff) {
    return diff.recipes
      .map(
        (f) =>
          `<div class="compare-recipe-family"><h3>${esc(f.name)}</h3>${
            f.available
              ? `<div class="compare-member-grid">${[
                  ['仅在左侧', f.leftOnly],
                  ['仅在右侧', f.rightOnly],
                ]
                  .map(
                    ([label, list]) =>
                      `<div class="compare-member-column"><small>${label}</small>${list.map((r) => (r.known ? act('database-detail', esc(r.name), 'text-btn', r.id) : `<span class="small">${esc(r.name)}</span>`)).join('') || '<p class="small muted">无</p>'}</div>`,
                  )
                  .join('')}</div>`
              : '<p class="save-note">至少一份存档未读取到此类配方。</p>'
          }</div>`,
      )
      .join('');
  }
  function result(diff, view) {
    return `<div class="compare-recaps">${recap(diff.left, '左侧')}${recap(diff.right, '右侧')}</div><div class="compare-summary"><div><small>铜钱差值</small><strong>${diff.moneyDelta === null ? '未读取' : signed(diff.moneyDelta) + ' 文'}</strong></div><div><small>累计时长差值</small><strong>${diff.playSecondsDelta === null ? '未读取' : timeDelta(diff.playSecondsDelta)}</strong></div><div><small>物品数量不同</small><strong>${diff.inventory.available ? diff.inventory.changes.length + ' 种' : '未读取'}</strong></div><div><small>任务状态不同</small><strong>${diff.quests.available ? diff.quests.changes.length + ' 条' : '未读取'}</strong></div></div><p class="save-note">比较于 ${when(diff.comparedAt)} · 新保存后请再次点击「比较记录」。</p><details class="save-quests compare-inventory" open><summary>背包数量差异</summary>${
      diff.inventory.available
        ? `<div class="compare-filter-row">${[
            ['all', '全部'],
            ['more', '右侧更多'],
            ['less', '右侧更少'],
          ]
            .map(
              ([id, label]) =>
                `<button class="chip ${view.filter === id ? 'active' : ''}" data-action="compare-filter" data-id="${id}">${label}</button>`,
            )
            .join(
              '',
            )}</div><label class="search-input inventory-search">${icon('search')}<input id="compare-inventory-search" value="${esc(view.query || '')}" aria-label="搜索对比物品" placeholder="搜索物品名称或类别" maxlength="100"></label>`
        : ''
    }<div id="compare-inventory-results"></div></details><details class="save-quests compare-quests"><summary>任务状态差异 · ${diff.quests.available ? diff.quests.changes.length : '未读取'}</summary>${diff.quests.available ? `<label class="search-input inventory-search">${icon('search')}<input id="compare-quest-search" value="${esc(view.questQuery || '')}" aria-label="搜索对比任务" placeholder="搜索任务名称" maxlength="100"></label>` : ''}<div id="compare-quest-results">${quests(diff, view.questQuery)}</div></details><details class="save-quests"><summary>队伍成员差异</summary><h3 class="mt">同行队伍</h3><div id="compare-team-results"></div><h3 class="mt">出战队伍</h3><div id="compare-fight-results"></div></details><details class="save-quests"><summary>已学配方差异</summary>${recipes(diff)}</details>`;
  }
  function populate(diff, index, view) {
    const set = (id, html) => {
      const node = document.querySelector(id);
      if (node) node.innerHTML = html;
    };
    set('#compare-inventory-results', inventory(diff, index, view.query, view.filter));
    set('#compare-team-results', members(diff.team, index, 'npc'));
    set('#compare-fight-results', members(diff.fightTeam, index, 'npc'));
  }
  return { shell, result, inventory, quests, populate };
}
