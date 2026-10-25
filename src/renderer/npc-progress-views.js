import { martialConsultationHint } from '../shared/martial-consultation.mjs';

export function npcLearningSummary(learning = []) {
  if (!learning.length) return '';
  const eligible = learning.filter((item) => item.status === 'met');
  const battle = eligible.filter((item) => item.consultation?.method === 'battle').length;
  const ready = eligible.length - battle;
  const blocked = learning.filter((item) => item.status === 'unmet').length;
  const unknown = learning.length - eligible.length - blocked;
  return [
    ready ? `可请教 ${ready} 项` : '',
    battle ? `需比试 ${battle} 项` : '',
    unknown ? `待确认 ${unknown} 项` : '',
    blocked ? (eligible.length || unknown ? `受限 ${blocked} 项` : '请教受限') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function createNpcProgressViews({ esc, act, richText = esc }) {
  const text = (value) => esc(String(value ?? ''));
  const link = (row) =>
    row.entityId ? act('database-detail', text(row.name), 'text-btn', row.entityId) : text(row.name);
  const unmet = (checks = []) => checks.filter((row) => row.status !== 'met');
  const missingEntry = (gate) =>
    unmet(gate.checks).find((check) => /^暂无常规(?:赠礼|比武|请教)入口$/.test(check.text));
  const orderedLearning = (row) =>
    [...row.learning].sort(
      (a, b) =>
        (({ met: 0, unknown: 1, unmet: 2 })[a.status] ?? 1) -
          ({ met: 0, unknown: 1, unmet: 2 }[b.status] ?? 1) ||
        Number(b.kind === 'martial') - Number(a.kind === 'martial'),
    );
  const checkText = (check) => {
    const name = String(check.name || '').replace(/^【[^】]+】\s*/, '');
    if (!check.entityId || !name || !check.text.startsWith(name)) return richText(check.text);
    return (
      act(
        check.entityId.startsWith('quest-') ? 'world-quest' : 'database-detail',
        text(name),
        'text-btn',
        check.entityId,
      ) + text(check.text.slice(name.length))
    );
  };
  const checkKey = (check) => JSON.stringify([check.text, check.entityId, check.status]);
  const reason = (checks, excluded = new Set()) =>
    [
      ...new Map(
        checks
          .filter((check) => check.status !== 'met' || check.showWhenMet)
          .map((check) => [checkKey(check), check]),
      ).values(),
    ]
      .filter((check) => !excluded.has(checkKey(check)))
      .filter((row) => row.text)
      .map(checkText)
      .filter(Boolean)
      .join('；');
  function items(row) {
    return row.remainingItems
      .map(
        (item) =>
          `<span class="npc-progress-item${item.important ? ' npc-key-item' : ''}">${link(item)} ×${text(item.count)}${item.owned > 0 ? `<small> · 已持有 ${text(item.owned)}</small>` : ''}</span>`,
      )
      .join('');
  }
  function sharedChecks(row) {
    const operations = [row.gift, row.compare, row.consult];
    return [
      ...new Map(
        [
          ...unmet(row.friendship.checks),
          ...unmet(row.compare.checks).filter((check) =>
            operations.every((operation) =>
              unmet(operation.checks).some((other) => checkKey(other) === checkKey(check)),
            ),
          ),
        ].map((check) => [checkKey(check), check]),
      ).values(),
    ];
  }
  function learning(row) {
    const excluded = new Set([...sharedChecks(row), ...row.consult.checks].map(checkKey));
    const state = (item) => {
      const hint = martialConsultationHint(item.consultation);
      if (item.status === 'met' && item.consultation?.method === 'battle') return hint;
      return [{ met: '可请教', unmet: '受限', unknown: '待确认' }[item.status] || '待确认', hint]
        .filter(Boolean)
        .join(' · ');
    };
    return orderedLearning(row)
      .map(
        (item) =>
          `<li><div class="npc-learning-heading"><span>${link(item)}${item.kind === 'life' ? ` · 你 ${text(item.playerLevel)} 级 · 对方 ${text(item.teacherLevel)} 级` : Number.isFinite(item.teacherLevel) && item.teacherLevel > 0 ? ` · 对方 ${text(item.teacherLevel)} 级` : ''}</span><small class="npc-learning-state" data-learning-status="${text(item.status)}">${state(item)}</small></div>${reason(item.checks, excluded) ? `<p class="small">${reason(item.checks, excluded)}</p>` : ''}</li>`,
      )
      .join('');
  }
  function learningNote(row) {
    const martial = row.learning.filter((item) => item.consultation);
    if (!martial.length) return '';
    return `<p class="small">武学初学 ${text(martial[0].consultation.initialLevel)} 级${martial.some((item) => ['battle', 'conditional'].includes(item.consultation.method)) ? '；比试获胜才扣请教消耗' : ''}。</p>`;
  }
  function gates(row, showPower = true) {
    const friend = row.friendship;
    const power =
      showPower && row.power && row.ownPower
        ? `<p>战力参考：你 ${Math.round(row.ownPower.value)}，对方 ${Math.round(row.power.value)} · ${text(row.power.title)}${row.power.value > row.ownPower.value ? '。建议先检查主修武学与配装。' : ''}</p>`
        : '';
    const giftQuality = missingEntry(row.gift)
      ? ''
      : row.gift.checks.find((check) => check.text.startsWith('礼物至少'))?.text;
    const common = sharedChecks(row);
    const excluded = new Set(common.map(checkKey));
    const operation = (label, gate) => {
      if (missingEntry(gate)) return `<p>${label}：暂无入口</p>`;
      const detail = reason(
        gate.checks.filter((check) => check.status !== 'met'),
        excluded,
      ).replace(new RegExp(`^${label}[：:]?`), '');
      const parts = [
        detail,
        label === '赠礼' && giftQuality && !detail.includes(giftQuality) ? text(giftQuality) : '',
      ].filter(Boolean);
      return parts.length ? `<p>${label}：${parts.join('；')}</p>` : '';
    };
    const fulfilled = [
      ['赠礼', row.gift],
      ['比武', row.compare],
      ['请教', row.consult],
    ]
      .map(([label, gate]) => {
        const checks = gate.checks.filter((check) => check.status === 'met' && check.showWhenMet);
        const detail = reason(checks, excluded);
        return detail ? `<p>${label}：${detail}</p>` : '';
      })
      .join('');
    return `<p>好感 ${friend.value === null ? '待确认' : text(friend.value)}${friend.cap !== null && friend.cap < 100 ? ` · 暂时上限 ${text(friend.cap)}` : ''}</p>${power}${common.length ? `<p>${reason(common)}</p>` : ''}${operation('赠礼', row.gift)}${operation('比武', row.compare)}${operation('请教', row.consult)}${fulfilled ? `<details class="npc-met-checks" data-persist-detail="npc-met-${text(row.npcId)}"><summary>已满足条件</summary>${fulfilled}</details>` : ''}`;
  }
  function person(row, embedded = false, origin = 'saved', previewedItems = []) {
    if (!row)
      return `<section class="detail-block" data-npc-progress><h3>比武与请教</h3><p>还没有此人物的状态，${origin === 'live' ? '遇见后再查看' : '遇见并保存后再查看'}。</p></section>`;
    const heading = embedded
      ? ''
      : `<h3>比武与请教${origin === 'live' ? '' : ' <span class="pill" data-npc-progress-origin="saved">保存时</span>'}</h3><p>${row.remainingItems.length ? `私物还剩 ${row.remainingItems.length} 种${row.importantCount && row.importantCount < row.remainingItems.length ? ` · 重点 ${row.importantCount} 种` : ''}` : '私物已清空'}${row.learning.length ? ' · ' + text(npcLearningSummary(row.learning)) : ''}</p>`;
    const orderedItems = [...row.remainingItems].sort((a, b) => Number(b.important) - Number(a.important));
    const remainingItems = row.remainingItems.filter(
      (item) =>
        !previewedItems.some(
          (preview) =>
            preview.entityId === item.entityId && preview.name === item.name && preview.count === item.count,
        ),
    );
    const visibleItems = items({ remainingItems: orderedItems.slice(0, 3) });
    const privatePreview = visibleItems
      ? '<div class="related-items npc-private-preview">' +
        visibleItems +
        '</div>' +
        (orderedItems.length > 3
          ? '<details data-persist-detail="npc-private-' +
            text(row.npcId) +
            '"><summary>其余私物 · ' +
            (orderedItems.length - 3) +
            ' 种</summary><div class="related-items mt">' +
            items({ remainingItems: orderedItems.slice(3) }) +
            '</div></details>'
          : '')
      : '';
    return `<section class="${embedded ? '' : 'detail-block '}npc-progress-detail" data-npc-progress="${text(row.npcId)}">${heading}${embedded ? '' : privatePreview}${gates(row, !embedded)}${embedded && remainingItems.length ? `<details data-persist-detail="npc-private-${text(row.npcId)}"><summary>${previewedItems.length ? '其余私物' : '剩余私物'} · ${remainingItems.length} 种</summary><div class="related-items mt">${items({ remainingItems })}</div></details>` : ''}${row.learning.length ? `<details data-persist-detail="npc-learning-${text(row.npcId)}"><summary>请教内容 · ${row.learning.length} 项</summary><ul>${learning(row)}</ul>${learningNote(row)}</details>` : ''}</section>`;
  }
  function card(row, tab, scope, filters) {
    const learning = orderedLearning(row);
    const ready = learning.filter((item) => item.status === 'met');
    const allReadyBattle = ready.length > 0 && ready.every((item) => item.consultation?.method === 'battle');
    const missingOnly = filters.includes('missing');
    const loot = missingOnly
      ? row.remainingItems.filter((item) => item.important && item.owned === 0)
      : row.remainingItems;
    const preview =
      tab === 'learning'
        ? (ready.length ? ready : learning)
            .slice(0, 2)
            .map(
              (item) =>
                `${link(item)}${item.kind === 'life' ? ` 你${text(item.playerLevel)} · 对方${text(item.teacherLevel)}级` : !allReadyBattle && martialConsultationHint(item.consultation) ? `（${martialConsultationHint(item.consultation)}）` : ''}`,
            )
            .join(' · ')
        : loot
            .slice(0, 2)
            .map((item) => `${link(item)} ×${text(item.count)}`)
            .join(' · ');
    const [operation, gate] =
      tab === 'learning'
        ? ['请教', ready[0] || learning[0]]
        : tab === 'locked'
          ? [row.restriction?.operation, row.restriction]
          : ['比武', row.compare];
    const firstBlocker = gate?.checks.find((check) => check.status === 'unmet') || unmet(gate?.checks)[0];
    const blockerLabel = firstBlocker?.text.startsWith(operation) ? '' : text(operation || '条件') + '：';
    const status =
      tab === 'cleared'
        ? ''
        : gate?.status === 'met'
          ? `<span class="npc-progress-status">${tab === 'learning' ? npcLearningSummary(ready) : '可比武'}</span>`
          : `<span class="npc-progress-blocker">${blockerLabel}${firstBlocker ? checkText(firstBlocker) : '待确认'}</span>`;
    const power =
      row.power && row.ownPower
        ? `<small class="npc-power-reference">战力：你 ${Math.round(row.ownPower.value)} / 对方 ${Math.round(row.power.value)}</small>`
        : '';
    const giftPreparation = missingEntry(row.gift)
      ? ''
      : `<div class="row mt">${act('journey-gift-dialog', '准备赠礼', 'btn', row.id, 'plus')}</div>`;
    return `<details class="npc-progress-card" data-npc-progress-card="${text(row.npcId)}" data-persist-detail="npc-progress-${text(scope)}-${text(row.npcId)}"><summary><span class="row between"><strong>${act('database-detail', text(row.name), 'text-btn', row.id)}${gate?.status === 'met' ? status : ''}</strong><small>${row.place ? act('world-place', text(row.place.name), 'text-btn', row.place.id) : '位置待确认'}</small></span><span>${row.collection === 'cleared' && tab !== 'learning' ? '私物已清空' : preview}${tab === 'learning' ? '' : missingOnly ? `<small class="npc-preview-count">缺少 ${loot.length} 种</small>` : row.importantCount > 2 ? `<small class="npc-preview-count">重点 ${row.importantCount} 种</small>` : ''}</span>${(gate?.status !== 'met' && status) || power ? `<span class="npc-progress-action">${gate?.status === 'met' ? '' : status}${power}</span>` : ''}</summary><div class="npc-progress-body">${person(row, true, 'saved', tab === 'learning' ? [] : loot.slice(0, 2))}${giftPreparation}</div></details>`;
  }
  function page(data, { tab = 'remaining', query = '', page = 0, filters = [], scope = '' } = {}) {
    if (!data?.available) return '';
    const tabs = [
      ['remaining', '待比武'],
      ['learning', '待请教'],
      ['locked', '受限'],
      ['cleared', '已清空'],
    ];
    if (!tabs.some(([id]) => id === tab)) tab = 'remaining';
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    const matches = (row) =>
      !needle ||
      [
        row.name,
        row.place?.name,
        ...row.remainingItems.map((item) => item.name),
        ...row.learning.map((item) => item.name),
      ]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle));
    const matching = Object.fromEntries(tabs.map(([id]) => [id, data[id].filter(matches)]));
    const live = data.origin === 'live';
    const filterOptions = [
      ...(['remaining', 'learning'].includes(tab)
        ? [
            [
              'ready',
              (live ? '' : '保存时') + (tab === 'learning' ? '可请教' : '可比武'),
              (row) =>
                tab === 'learning'
                  ? row.learning.some((item) => item.status === 'met')
                  : row.compare.status === 'met',
            ],
          ]
        : []),
      ['nearby', live ? '当前场景' : '保存时的场景', (row) => row.samePlace],
      ...(['remaining', 'locked'].includes(tab)
        ? [
            [
              'missing',
              live ? '未持有重点私物' : '保存时未持有重点',
              (row) => row.remainingItems.some((item) => item.important && item.owned === 0),
            ],
          ]
        : []),
    ];
    const selected = filterOptions.filter(([id]) => Array.isArray(filters) && filters.includes(id));
    filters = selected.map(([id]) => id);
    const rows = matching[tab].filter((row) => selected.every(([, , matches]) => matches(row)));
    const otherMatches = tabs.filter(([id]) => id !== tab && matching[id].length);
    const empty =
      filters.length && (matching[tab].length || !needle)
        ? `<p class="small">${filters.includes('missing') && data.inventoryKnown === false ? '背包状态未读取，暂时无法筛选未持有物品。' : filters.includes('nearby') && data.placeKnown === false ? '场景未读取。' : '没有符合筛选的人物。'}</p>${act('npc-progress-filter', '清除筛选', 'btn', 'all')}`
        : needle && otherMatches.length
          ? `<p>当前分类没有匹配。</p><div class="tag-row">${otherMatches.map(([id, label]) => act('npc-progress-tab', `${label} · ${matching[id].length}`, 'btn', id)).join('')}</div>`
          : '<p class="small">没有匹配的人物。</p>';
    const pages = Math.max(1, Math.ceil(rows.length / 12));
    page = Math.max(0, Math.min(page, pages - 1));
    return `<section class="npc-progress-page duel-page" data-npc-progress-page><div class="npc-progress-header"><div class="npc-progress-tabs" role="group" aria-label="比武与请教筛选">${tabs.map(([id, label]) => `<button class="btn${tab === id ? ' soft' : ''}" data-action="npc-progress-tab" data-id="${id}" aria-pressed="${tab === id}">${label} ${matching[id].length}</button>`).join('')}</div>${live ? '' : '<span class="pill" data-npc-progress-origin="saved">保存时</span>'}</div><div class="npc-progress-tools"><label class="search-input"><input id="npc-progress-search" value="${text(query)}" maxlength="100" placeholder="人物、地点、私物或功法" aria-label="搜索比武与请教"></label><details id="npc-progress-filters" class="npc-progress-filters" data-persist-detail="npc-filters-${text(scope)}"><summary aria-label="人物筛选">筛选${filters.length ? ' ' + filters.length : ''}</summary><div class="npc-progress-options">${filterOptions.map(([id, label, matchesFilter]) => `<label><input id="npc-progress-filter-${id}" type="checkbox" data-npc-progress-filter="${id}"${filters.includes(id) ? ' checked' : ''}><span>${label}</span><small>${matching[tab].filter((row) => matchesFilter(row) && selected.every(([otherId, , matches]) => otherId === id || matches(row))).length}</small></label>`).join('')}${filters.length ? act('npc-progress-filter', '清除筛选', 'text-btn', 'all') : ''}</div></details></div><div class="npc-progress-list">${
      rows
        .slice(page * 12, page * 12 + 12)
        .map((row) => card(row, tab, scope, filters))
        .join('') || empty
    }</div>${pages > 1 ? `<div class="pagination">${act('npc-progress-page', '上一页', 'btn', String(Math.max(0, page - 1)))}<span>${page + 1} / ${pages}</span>${act('npc-progress-page', '下一页', 'btn', String(Math.min(pages - 1, page + 1)))}</div>` : ''}<details data-persist-detail="npc-progress-basis-${text(scope)}"><summary>${data.origin === 'live' ? '现场更新' : '保存后更新'}</summary><p>${data.origin === 'live' ? '当前清单来自同次现场读取；读档、切换场景或连接中断时撤回现场结果。' : '游戏保存后更新清单；接入现场读取后，无需等待保存。'}私物按人物实际剩余物品统计。</p><p>请教列出可练习的生活技艺和未学功法；已持有同类物品仍保留剩余收集机会。未记录人物不算完成。</p></details></section>`;
  }
  return { person, page };
}
