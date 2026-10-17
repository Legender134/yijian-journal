import { placeEntityId } from './entity-catalog.js';

export function createComparisonViews({
  esc,
  act,
  iconButton,
  pill,
  notice,
  when,
  hours,
  icon,
  picture,
  getIndex = () => null,
}) {
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
    const unavailable = !files.some((f) => f.name === view.left) || !files.some((f) => f.name === view.right);
    const options = (selected) =>
      (files.some((f) => f.name === selected)
        ? ''
        : `<option value="${esc(selected || '')}" selected disabled>${selected ? esc(selected) + ' · 暂不可读' : '请选择存档'}</option>`) +
      files
        .map(
          (f) =>
            `<option value="${esc(f.name)}" ${f.name === selected ? 'selected' : ''}>${esc(f.name)} · ${esc(f.metadata.mapName)} · ${hours(f.metadata.playSeconds)}</option>`,
        )
        .join('');
    return `<section class="drawer comparison-drawer" role="dialog" aria-modal="true" aria-label="两份存档对比"><div class="drawer-head"><span>进度比较</span>${iconButton('close-overlay', 'close', '关闭存档对比')}</div><div class="drawer-body"><p class="small muted">左侧 → 右侧 · 已保存进度</p><details class="compare-source-selection"${view.result ? '' : ' open'}><summary>${view.result ? esc(view.result.left.name) + ' → ' + esc(view.result.right.name) : '选择比较进度'}</summary><div class="compare-selectors"><div class="field"><label for="compare-left">左侧存档</label><select id="compare-left">${options(view.left)}</select></div>${iconButton('compare-swap', 'refresh', '交换左右存档')}<div class="field"><label for="compare-right">右侧存档</label><select id="compare-right">${options(view.right)}</select></div></div><div class="row compare-controls">${act('compare-run', '比较记录', 'btn primary', '', 'search')}${act('compare-refresh', '刷新槽位', 'btn', '', 'refresh')}</div></details><span id="compare-status" class="small muted" role="status"></span><div id="comparison-result" role="region" aria-label="进度变化">${view.result ? result(view.result, view) : '<div class="compare-empty">' + icon('scroll') + '<p>' + (unavailable ? '所选进度暂不可读，请刷新或重新选择。' : '选好左右槽位，点击「比较记录」。') + '</p></div>'}</div></div></section>`;
  }
  function recap(file, side) {
    const index = getIndex(),
      maps = index?.world?.maps || [];
    const matches = file.mapKey ? maps.filter((place) => place.key === file.mapKey) : [];
    const location =
      matches.length === 1
        ? act('world-place', esc(file.mapName), 'text-btn', placeEntityId(matches[0], maps))
        : esc(file.mapName);
    const quest = (id, name) =>
      (index?.world?.quests || []).some((row) => row.id === id)
        ? act('world-quest', esc(name || '查看任务'), 'text-btn', id)
        : esc(name || '未记录');
    return `<div class="compare-recap"><small>${side} · ${esc(file.name)}</small><h3>${location}</h3><p>${when(file.modifiedAt)} · ${hours(file.playSeconds)}</p><p>铜钱 ${file.money === null ? '未读取' : file.money.toLocaleString() + ' 文'} · ${esc(file.difficultyName || '难度未读取')}</p><p class="compare-tracked">主线：${quest(file.mainQuestId, file.mainQuest)}<br>支线：${quest(file.sideQuestId, file.sideQuest)}</p></div>`;
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
      rows = diff.quests.changes.filter((i) => !q || i.name.toLowerCase().includes(q)),
      known = new Set((getIndex()?.world?.quests || []).map((quest) => quest.id));
    return `${
      rows
        .slice(0, 60)
        .map(
          (i) =>
            `<div class="compare-quest"><h3>${known.has(`quest-${i.id}`) ? act('world-quest', esc(i.name), 'text-btn', `quest-${i.id}`) : esc(i.name)}</h3><div class="row">${pill(i.left)}${icon('arrow')}${pill(i.right, i.rightStep === 4 ? 'green' : '')}${i.parentId ? '<small class="muted">任务步骤</small>' : ''}</div></div>`,
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
    const changed = diff.recipes.filter((family) =>
      !family.available || family.leftOnly.length || family.rightOnly.length,
    );
    const unchanged = diff.recipes.filter((family) => !changed.includes(family));
    const render = (family) => {
      if (!family.available)
        return '<div class="compare-recipe-family"><h3>' + esc(family.name) + '</h3><p class="save-note">至少一份存档未读取到此类配方。</p></div>';
      const sides = [['仅在左侧', family.leftOnly], ['仅在右侧', family.rightOnly]]
        .filter(([, rows]) => rows.length);
      return '<div class="compare-recipe-family"><h3>' + esc(family.name) + '</h3><div class="compare-member-grid">' +
        sides.map(([label, rows]) => '<div class="compare-member-column"><small>' + label + '</small>' +
          rows.map((row) => row.known
            ? act('database-detail', esc(row.name), 'text-btn', row.id)
            : '<span class="small">' + esc(row.name) + '</span>').join('') + '</div>').join('') +
        '</div></div>';
    };
    if (!changed.length)
      return '<p class="small muted">' + unchanged.map((family) => esc(family.name)).join('、') + '配方无变化。</p>';
    return changed.map(render).join('') +
      (unchanged.length ? '<details class="compare-recipe-unchanged"><summary>其他配方 · 无变化</summary><p class="small muted">' +
        unchanged.map((family) => esc(family.name)).join('、') + '</p></details>' : '');
  }

  function changeSummary(diff) {
    const metrics = [],
      unknown = [];
    const measure = (label, known, value) => {
      if (!known) unknown.push(label);
      else if (value) metrics.push({ label, value });
    };
    const count = (group) => (group.available ? group.leftOnly.length + group.rightOnly.length : 0);
    const teamCount = count(diff.team) + count(diff.fightTeam);
    const recipeCount = diff.recipes.reduce((sum, family) => sum + count(family), 0);
    measure('铜钱', diff.moneyDelta !== null, diff.moneyDelta ? signed(diff.moneyDelta) + ' 文' : '');
    measure(
      '累计时长',
      diff.playSecondsDelta !== null,
      diff.playSecondsDelta ? timeDelta(diff.playSecondsDelta) : '',
    );
    measure(
      '背包',
      diff.inventory.available,
      diff.inventory.changes.length ? diff.inventory.changes.length + ' 种变化' : '',
    );
    measure(
      '任务',
      diff.quests.available,
      diff.quests.changes.length ? diff.quests.changes.length + ' 条变化' : '',
    );
    measure('同行队伍', diff.team.available, count(diff.team) ? count(diff.team) + ' 位变化' : '');
    measure(
      '出战队伍',
      diff.fightTeam.available,
      count(diff.fightTeam) ? count(diff.fightTeam) + ' 位变化' : '',
    );
    for (const family of diff.recipes)
      measure(family.name + '配方', family.available, count(family) ? count(family) + ' 项变化' : '');
    const groups = {
      inventory: { count: diff.inventory.changes.length, unknown: !diff.inventory.available },
      quests: { count: diff.quests.changes.length, unknown: !diff.quests.available },
      team: { count: teamCount, unknown: !diff.team.available || !diff.fightTeam.available },
      recipes: { count: recipeCount, unknown: diff.recipes.some((f) => !f.available) },
    };
    const first =
      Object.keys(groups).find((key) => groups[key].count > 0) ||
      Object.keys(groups).find((key) => groups[key].unknown);
    const groupLabel = (total, missing, unit) =>
      [total ? total + unit : '', ...missing].filter(Boolean).join(' · ') || '0' + unit;
    const teamLabel = groupLabel(
      teamCount,
      [!diff.team.available ? '同行未读取' : '', !diff.fightTeam.available ? '出战未读取' : ''].filter(
        Boolean,
      ),
      ' 位',
    );
    const recipeLabel = groupLabel(
      recipeCount,
      diff.recipes.filter((f) => !f.available).map((f) => f.name + '未读取'),
      ' 项',
    );
    const html =
      (metrics.length
        ? '<div class="compare-summary compare-change-summary">' +
          metrics
            .map((m) => '<div><small>' + esc(m.label) + '</small><strong>' + esc(m.value) + '</strong></div>')
            .join('') +
          '</div>'
        : '') +
      (unknown.length
        ? '<details class="compare-unknown"><summary>未读取的记录 · ' +
          unknown.length +
          ' 项</summary><p class="save-note">' +
          unknown.map(esc).join('、') +
          '</p></details>'
        : !metrics.length
          ? '<p class="save-note compare-unchanged-message">已比较的铜钱、时长、队伍、任务、物品与配方无变化。</p>'
          : '');
    return { html, groups, first, teamLabel, recipeLabel };
  }
  function result(diff, view) {
    const summary = changeSummary(diff),
      open = (key) => (summary.first === key ? ' open' : '');
    const inventoryBlock = `<details class="save-quests compare-inventory"${open('inventory')}><summary>背包数量差异 · ${diff.inventory.available ? diff.inventory.changes.length + ' 种' : '未读取'}</summary>${
      diff.inventory.available
        ? '<div class="compare-filter-row">' +
          [
            ['all', '全部'],
            ['more', '右侧更多'],
            ['less', '右侧更少'],
          ]
            .map(
              ([id, label]) =>
                '<button class="chip ' +
                (view.filter === id ? 'active' : '') +
                '" data-action="compare-filter" data-id="' +
                id +
                '">' +
                label +
                '</button>',
            )
            .join('') +
          '</div><label class="search-input inventory-search">' +
          icon('search') +
          '<input id="compare-inventory-search" value="' +
          esc(view.query || '') +
          '" aria-label="搜索对比物品" placeholder="搜索物品名称或类别" maxlength="100"></label>'
        : ''
    }<div id="compare-inventory-results"></div></details>`;
    const questBlock = `<details class="save-quests compare-quests"${open('quests')}><summary>任务状态差异 · ${diff.quests.available ? diff.quests.changes.length + ' 条' : '未读取'}</summary>${diff.quests.available ? '<label class="search-input inventory-search">' + icon('search') + '<input id="compare-quest-search" value="' + esc(view.questQuery || '') + '" aria-label="搜索对比任务" placeholder="搜索任务名称" maxlength="100"></label>' : ''}<div id="compare-quest-results">${quests(diff, view.questQuery)}</div></details>`;
    const teamBlock = `<details class="save-quests compare-team"${open('team')}><summary>队伍成员差异 · ${esc(summary.teamLabel)}</summary><h3 class="mt">同行队伍</h3><div id="compare-team-results"></div><h3 class="mt">出战队伍</h3><div id="compare-fight-results"></div></details>`;
    const recipeBlock = `<details class="save-quests compare-recipes"${open('recipes')}><summary>已学配方差异 · ${esc(summary.recipeLabel)}</summary>${recipes(diff)}</details>`;
    const blocks = { inventory: inventoryBlock, quests: questBlock, team: teamBlock, recipes: recipeBlock };
    const active = Object.keys(blocks).filter(
      (key) => summary.groups[key].count > 0 || summary.groups[key].unknown,
    );
    const unchanged = Object.keys(blocks).filter((key) => !active.includes(key));
    return (
      `<p class="compare-direction">${esc(diff.left.name)} → ${esc(diff.right.name)}</p>` +
      summary.html +
      active.map((key) => blocks[key]).join('') +
      (unchanged.length
        ? '<details class="compare-unchanged"><summary>其他已比较内容 · 无变化</summary>' +
          unchanged.map((key) => blocks[key]).join('') +
          '</details>'
        : '') +
      `<details class="compare-snapshots"><summary>两份进度的详细记录</summary><div class="compare-recaps">${recap(diff.left, '左侧')}${recap(diff.right, '右侧')}</div><p class="small muted">比较于 ${when(diff.comparedAt)}。新保存后请重新比较；槽位可以来自不同周目。</p></details>`
    );
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
