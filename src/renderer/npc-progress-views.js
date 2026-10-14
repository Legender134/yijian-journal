export function createNpcProgressViews({ esc, act, richText = esc }) {
  const text = (value) => esc(String(value ?? ''));
  const link = (row) =>
    row.entityId ? act('database-detail', text(row.name), 'text-btn', row.entityId) : text(row.name);
  const unmet = (checks = []) => checks.filter((row) => row.status !== 'met');
  const orderedLearning = (row) =>
    [...row.learning].sort(
      (a, b) =>
        (({ met: 0, unknown: 1, unmet: 2 })[a.status] ?? 1) -
        ({ met: 0, unknown: 1, unmet: 2 }[b.status] ?? 1),
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
    [...new Map(unmet(checks).map((check) => [checkKey(check), check])).values()]
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
    const excluded = new Set([...sharedChecks(row), ...unmet(row.consult.checks)].map(checkKey));
    return orderedLearning(row)
      .map(
        (item) =>
          `<li>${link(item)}${item.kind === 'life' ? ` · ${text(item.playerLevel)} → ${text(item.teacherLevel)} 级` : ''}${reason(item.checks, excluded) ? `<p class="small">${reason(item.checks, excluded)}</p>` : ''}</li>`,
      )
      .join('');
  }
  function gates(row) {
    const friend = row.friendship;
    const power =
      row.power && row.ownPower
        ? `<p>战力参考：你 ${Math.round(row.ownPower.value)}，对方 ${Math.round(row.power.value)} · ${text(row.power.title)}${row.power.value > row.ownPower.value ? '。建议先检查主修武学与配装。' : ''}</p>`
        : '';
    const giftQuality = row.gift.checks.find((check) => check.text.startsWith('礼物至少'))?.text;
    const common = sharedChecks(row);
    const excluded = new Set(common.map(checkKey));
    const operation = (label, gate) => {
      const detail = reason(gate.checks, excluded).replace(new RegExp(`^${label}[：:]?`), '');
      return detail ? `<p>${label}：${detail}</p>` : '';
    };
    return `<p>好感 ${friend.value === null ? '待确认' : text(friend.value)}${friend.cap !== null && friend.cap < 100 ? ` · 暂时上限 ${text(friend.cap)}` : ''}</p>${power}${common.length ? `<p>${reason(common)}</p>` : ''}${operation('赠礼', row.gift)}${giftQuality ? `<p>${text(giftQuality)}</p>` : ''}${operation('比武', row.compare)}${operation('请教', row.consult)}`;
  }
  function person(row, embedded = false, origin = 'saved') {
    if (!row)
      return `<section class="detail-block" data-npc-progress><h3>比武与请教</h3><p>还没有此人物的状态，${origin === 'live' ? '遇见后再查看' : '遇见并保存后再查看'}。</p></section>`;
    const heading = embedded
      ? ''
      : `<h3>比武与请教</h3><p>${row.remainingItems.length ? `私物还剩 ${row.remainingItems.length} 种${row.importantCount ? ` · 重点 ${row.importantCount} 种` : ''}` : '私物已清空'}${row.learning.length ? ` · 还有 ${row.learning.length} 项可提升` : ''}</p>`;
    return `<section class="${embedded ? '' : 'detail-block '}npc-progress-detail" data-npc-progress="${text(row.npcId)}">${heading}${gates(row)}${row.remainingItems.length ? `<details data-persist-detail="npc-private-${text(row.npcId)}"><summary>剩余私物 · ${row.remainingItems.length} 种</summary><div class="related-items mt">${items(row)}</div></details>` : ''}${row.learning.length ? `<details data-persist-detail="npc-learning-${text(row.npcId)}"><summary>可提升技艺与未学功法 · ${row.learning.length} 项</summary><ul>${learning(row)}</ul></details>` : ''}${embedded ? '' : `<details><summary>${origin === 'live' ? '现场更新' : '保存后更新'}</summary><p>${origin === 'live' ? '人物状态与相关任务来自同次现场读取。' : '按最近读取的保存记录整理。'}</p></details>`}</section>`;
  }
  function card(row, tab, scope) {
    const learning = orderedLearning(row);
    const ready = learning.filter((item) => item.status === 'met');
    const preview =
      tab === 'learning'
        ? (ready.length ? ready : learning)
            .slice(0, 2)
            .map(
              (item) =>
                `${link(item)}${item.kind === 'life' ? ` ${text(item.playerLevel)}→${text(item.teacherLevel)}级` : ''}`,
            )
            .join(' · ')
        : row.remainingItems.slice(0, 2).map(link).join(' · ');
    const blocker =
      tab === 'learning'
        ? ready.length
          ? ''
          : reason(learning[0]?.checks)
        : tab === 'locked'
          ? reason(
              [row.compare, row.gift, row.consult, ...row.learning].find((gate) => gate.status !== 'met')
                ?.checks,
            )
          : reason(row.compare.checks);
    return `<details class="npc-progress-card" data-npc-progress-card="${text(row.npcId)}" data-persist-detail="npc-progress-${text(scope)}-${text(row.npcId)}"><summary><span class="row between"><strong>${act('database-detail', text(row.name), 'text-btn', row.id)}</strong><small>${row.place ? act('world-place', text(row.place.name), 'text-btn', row.place.id) : '位置待确认'}</small></span><span>${row.collection === 'cleared' && tab !== 'learning' ? '私物已清空' : preview}${row.importantCount && tab !== 'learning' ? ` · 重点 ${row.importantCount} 种` : ''}</span>${blocker ? `<span class="npc-progress-blocker">${blocker}</span>` : ''}</summary><div class="npc-progress-body">${person(row, true)}</div></details>`;
  }
  function page(data, { tab = 'remaining', query = '', page = 0, scope = '' } = {}) {
    if (!data?.available) return '';
    const tabs = [
      ['remaining', '待比武'],
      ['learning', '待请教'],
      ['locked', '受限'],
      ['cleared', '已清空'],
    ];
    if (!tabs.some(([id]) => id === tab)) tab = 'remaining';
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    const rows = data[tab].filter(
      (row) =>
        !needle ||
        [
          row.name,
          row.place?.name,
          ...row.remainingItems.map((item) => item.name),
          ...row.learning.map((item) => item.name),
        ]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle)),
    );
    const pages = Math.max(1, Math.ceil(rows.length / 12));
    page = Math.max(0, Math.min(page, pages - 1));
    return `<section class="npc-progress-page duel-page" data-npc-progress-page><h2>比武与请教</h2><div class="npc-progress-tabs" role="group" aria-label="比武与请教筛选">${tabs.map(([id, label]) => `<button class="btn${tab === id ? ' soft' : ''}" data-action="npc-progress-tab" data-id="${id}" aria-pressed="${tab === id}">${label} ${data[id].length}</button>`).join('')}</div><label class="search-input"><input id="npc-progress-search" value="${text(query)}" maxlength="100" placeholder="人物、地点、私物或功法" aria-label="搜索比武与请教"></label><div class="npc-progress-list">${
      rows
        .slice(page * 12, page * 12 + 12)
        .map((row) => card(row, tab, scope))
        .join('') || '<p class="small">没有匹配的人物。</p>'
    }</div>${pages > 1 ? `<div class="pagination">${act('npc-progress-page', '上一页', 'btn', String(Math.max(0, page - 1)))}<span>${page + 1} / ${pages}</span>${act('npc-progress-page', '下一页', 'btn', String(Math.min(pages - 1, page + 1)))}</div>` : ''}<details data-persist-detail="npc-progress-basis-${text(scope)}"><summary>${data.origin === 'live' ? '现场更新' : '保存后更新'}</summary><p>${data.origin === 'live' ? '当前清单来自同次现场读取；读档、切换场景或连接中断时撤回现场结果。' : '游戏保存后更新清单；接入现场读取后，无需等待保存。'}私物按人物实际剩余物品统计。</p><p>请教列出更高生活技艺和未学功法；已持有同类物品仍保留剩余收集机会。未记录人物不算完成。</p></details></section>`;
  }
  return { person, page };
}
