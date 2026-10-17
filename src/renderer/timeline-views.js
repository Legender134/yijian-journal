import { placeEntityId } from './entity-catalog.js';

export function createTimelineViews({
  esc,
  icon,
  act,
  pill,
  notice,
  hours,
  bytes,
  iconButton,
  qualityText,
  getIndex = () => null,
}) {
  const ago = (seconds) =>
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
      : seconds >= 60
        ? `${Math.floor(seconds / 60)} 分钟 ${seconds % 60} 秒`
        : `${seconds} 秒`;
  const label = (seconds) =>
    seconds >= 3600 ? '1 小时前' : seconds >= 60 ? `${seconds / 60} 分钟前` : `${seconds} 秒前`;
  const time = (at) =>
    new Date(at).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  const bookmarked = (r) => r.bookmarked === true || (r.kind === 'manual' && r.bookmarked !== false);
  const kind = (r) => (r.kind === 'before-load' ? '读档前保护' : bookmarked(r) ? '收藏节点' : '自动节点');
  const signed = (n) => (n > 0 ? '+' : '') + n.toLocaleString('zh-CN');
  function entityName(row, kind) {
    const id = `${kind}-${row.id}`,
      index = getIndex(),
      known = kind === 'quest' ? index?.world?.quests : index?.entries;
    if (known?.some((entry) => entry.id === id))
      return act(kind === 'quest' ? 'world-quest' : 'database-detail', esc(row.name), 'text-btn', id);
    return kind === 'item' && qualityText ? qualityText.name(id, row.name) : esc(row.name);
  }
  function placeName(row) {
    const maps = getIndex()?.world?.maps || [],
      key = row.mapKey ?? row.map,
      matches = key ? maps.filter((place) => place.key === key) : [];
    return matches.length === 1
      ? act(
          'archive-entity',
          esc(row.mapName || matches[0].name),
          'text-btn',
          placeEntityId(matches[0], maps),
        )
      : esc(row.mapName);
  }
  function status(t) {
    return t?.quiescing
      ? '等待存读档结束后退出'
      : t?.error
        ? '自动保存已停止'
        : t?.busy
          ? '正在存读档'
          : !t?.enabled
            ? '自动保存已关闭'
            : !t.connected
              ? '等待游戏连接'
              : !t.ready
                ? '暂时暂停'
                : '自动保存中';
  }
  function chip(h) {
    const t = h?.timeline;
    const p = h?.protection;
    if (p) {
      const detail = p.detail + (p.at ? ' ' + time(p.at) : '');
      return `<button class="save-health ${p.warning ? 'warning' : p.ready ? 'ready' : ''}" data-action="navigate" data-id="saves" title="${esc(detail + ' · ' + p.reason)}" aria-label="保存状态：${esc(p.label)}，${esc(detail)}">${icon(p.warning ? 'info' : 'shield')}<span>${esc(p.label)}<small>${esc(detail)}</small></span></button>`;
    }
    const saved = t?.latest ? `最近保存 ${time(t.latest.at)}` : '尚无成功保存';
    return `<button class="save-health ${t?.error || t?.pending ? 'warning' : t?.enabled && t?.ready ? 'ready' : ''}" data-action="navigate" data-id="saves" title="${esc(saved + ' · ' + (t?.reason || '等待连接'))}" aria-label="保存状态：${esc(status(t))}，${esc(saved)}">${icon(t?.error || t?.pending ? 'info' : 'shield')}<span>${status(t)}<small>${esc(saved)}</small></span></button>`;
  }
  function history(t, view) {
    const query = (view.query || '').trim().toLocaleLowerCase();
    const rows = (t.history || []).filter(
      (r) =>
        (view.kind !== 'bookmarks' || bookmarked(r)) &&
        (view.kind !== 'automatic' || (!bookmarked(r) && r.kind === 'auto')) &&
        (!query ||
          [r.label, r.note, r.mapName, time(r.at), kind(r)].join(' ').toLocaleLowerCase().includes(query)),
    );
    const totalPages = Math.max(1, Math.ceil(rows.length / 20));
    const page = Math.min(Math.max(0, view.page || 0), totalPages - 1);
    return `<section class="timeline-history" aria-label="全部留存节点"><div class="row between mb"><h3>${icon('archive')} 全部留存节点 <span class="small muted">· ${rows.length} 个</span></h3><span class="small muted">收藏 ${t.bookmarkCount || 0} 个 · 自动 ${t.automaticCount || 0} 个</span></div><div class="history-toolbar"><label class="search-field">${icon('search')}<input id="timeline-search" data-persist="true" class="input" maxlength="100" placeholder="搜索名称、备注、场景或日期" aria-label="搜索历史存档" value="${esc(view.query || '')}"></label><select id="timeline-filter" class="input" aria-label="筛选历史存档">${[
      ['all', '全部节点'],
      ['bookmarks', '收藏节点'],
      ['automatic', '自动节点'],
    ]
      .map(([v, l]) => `<option value="${v}" ${v === (view.kind || 'all') ? 'selected' : ''}>${l}</option>`)
      .join('')}</select></div>${
      rows
        .slice(page * 20, page * 20 + 20)
        .map(
          (r) =>
            `<div class="backup-row history-row"><div class="backup-symbol">${icon(r.kind === 'before-load' ? 'shield' : bookmarked(r) ? 'star' : 'clock')}</div><div class="spacer"><h3>${r.label ? esc(r.label) : placeName(r)}</h3><p>${time(r.at)} · ${hours(r.playSeconds)}${r.label ? ' · ' + placeName(r) : ''}${r.note ? `<br><span class="history-note">${esc(r.note)}</span>` : ''}</p></div>${pill(kind(r), bookmarked(r) ? 'green' : '')}${act('timeline-preview', '查看与读档', 'btn', r.id, 'eye')}</div>`,
        )
        .join('') || '<p class="muted history-empty">没有匹配的留存节点。</p>'
    }<div class="history-pagination"><button class="btn" data-action="timeline-page" data-id="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span class="small muted">第 ${page + 1} / ${totalPages} 页</span><button class="btn" data-action="timeline-page" data-id="${page + 1}" ${page + 1 >= totalPages ? 'disabled' : ''}>下一页</button></div></section>`;
  }
  function page(t, view = {}) {
    if (!t) return '';
    if (t.indexError)
      return `<section class="card timeline-card mb" aria-label="时间线需要核对"><div class="card-header"><h2>${icon('clock')} 时间线需要核对</h2>${pill('自动存读档已停止')}</div>${notice(t.error)}<p class="save-note">历史数量暂时无法核对。${view.recoveryBlocked ? '还存在待核对的完整存档恢复；核对之前不能更换目录或创建新备份。资料查询和查看已有副本仍可使用。' : '仍可重新选择有效存档目录，使用资料查询、存档回顾和完整备份。'}</p><p class="save-note">请先退出游戏，并保留历史目录中的原记录、上一份记录和历史存档副本；不要删除或重建记录来绕过核对。需要帮助时提供下方诊断文字，无需发送存档文件。</p><details><summary>查看时间线诊断</summary><p class="small mono preserve-text">${esc(t.recordPath)}${t.diagnostic ? '\n' + esc(t.diagnostic) : ''}</p></details><div class="row mt">${act('folder', '打开历史目录', 'btn', 'timeline', 'folder')}</div></section>`;
    const duplicate = new Map();
    for (const n of t.nodes) if (n.record) duplicate.set(n.record.id, (duplicate.get(n.record.id) || 0) + 1);
    const selected = view.target || 60;
    const canAct = t.ready && !t.busy && !t.pending && !t.quiescing;
    const blocked = !t.ready || t.busy || t.pending || t.quiescing || t.error;
    const node = (n) =>
      `<article class="timeline-node ${n.record ? '' : 'unavailable'}">${
        n.record
          ? `<div class="row between"><p class="timeline-location">${placeName(n.record)}</p>${act('timeline-preview', '预览读档', 'btn', n.record.id, 'refresh')}</div><p class="small muted"><time>${time(n.record.at)}</time> · 实际距今 ${ago(n.record.ageSeconds)}</p><details class="timeline-target-precision"><summary>比目标早 ${ago(n.record.gapSeconds)}${duplicate.get(n.record.id) > 1 ? ' · 共用记录' : ''}</summary><p class="small">允许偏差 ≤ ${ago(n.toleranceSeconds)}${duplicate.get(n.record.id) > 1 ? '；多个目标时间匹配到同一份保存。' : ''}</p></details>`
          : `<p>${esc(n.reason || '尚未积累到这个时间')}</p><p class="small muted">${n.nearestAt ? '可在历史与收藏中查找更早的进度。' : '可保存时继续积累。'}</p><details><summary>时间范围</summary><p class="small">允许偏差 ≤ ${ago(n.toleranceSeconds)}</p></details>`
      }</article>`;
    const settings = `<details class="timeline-settings" data-persist-detail="timeline-settings"${!t.enabled && !t.count ? ' open' : ''}><summary>自动保存设置</summary><div class="timeline-controls"><label>保存间隔 <select id="timeline-interval" class="input" aria-label="自动存档间隔">${[10, 20, 30, 60, 120, 300].map((s) => `<option value="${s}"${s === t.interval ? ' selected' : ''}>${s >= 60 ? s / 60 + ' 分钟' : s + ' 秒'}</option>`).join('')}</select></label><button class="switch ${t.enabled ? 'on' : ''}" role="switch" aria-label="时间线自动存档" aria-checked="${t.enabled}" data-action="timeline-toggle"${t.busy || t.pending || t.quiescing ? ' disabled' : ''}></button><span class="small">${t.enabled ? '已开启' : '开启自动保存'}</span>${act('folder', '历史目录', 'text-btn', 'timeline', 'folder')}</div><p class="save-note">游戏和手札需同时运行；菜单、战斗、对话、过场中暂停。专用 29 号手动槽请勿手动覆盖。</p><details class="timeline-retention" data-persist-detail="timeline-retention"><summary>保留数量与时间范围</summary><p class="small">共 ${t.count || 0} 个节点 · ${bytes(t.bytes || 0)}；自动候选 ${t.automaticCount || 0} / ${t.maxAutomaticRecords}。收藏和最近一次读档前保护另存；正在预览的节点临时保护。</p><p class="save-note">只匹配目标时间之前的记录，超出允许偏差时显示暂无；不能回到战斗中的任意一帧。10–50 秒档位允许偏差 15 秒；1/2/5/10/30/60 分钟分别允许 20/45/90/90/240/300 秒。推荐 10 秒间隔；间隔增大，较近时间可能没有记录。自动保存静默进行，不打开游戏菜单。</p></details><details class="timeline-component" data-persist-detail="timeline-component"><summary>游戏接入组件</summary><div class="row between"><p class="small muted">${t.installed ? '组件已接入' : '安装后可只读提醒，请重新启动游戏'}</p><div class="row">${act('bridge-install', t.installed ? '更新组件' : '安装组件', 'btn', '', 'shield')}${act('bridge-disable', '停用接入', 'text-btn', '', 'close')}</div></div></details></details>`;
    return `<section class="card timeline-card mb" aria-label="时间线自动存档"><div class="card-header"><h2>${icon('clock')} 自动存档</h2>${pill(status(t), t.enabled && t.ready ? 'green' : '')}</div>${blocked && t.reason ? `<p class="timeline-status" role="status">${esc(t.reason)}</p>` : ''}${t.error ? notice(t.error) : ''}${t.pending && !t.busy ? `<div class="timeline-interrupted">${notice('上次存读档未完成，自动保存已暂停。请等待请求过期后核对保护副本。')}${act('timeline-recover', '核对中断记录', 'btn', '', 'shield')}</div>` : ''}<div class="timeline-primary-actions"><button class="btn primary" data-action="timeline-save" data-id="attempt" data-save-ready${canAct ? '' : ' disabled'}>${icon('star')}留住当前进度</button></div>${t.latest ? `<div class="timeline-return latest-reliable"><div><strong>最近保存</strong><p class="small muted">${placeName(t.latest)} · ${time(t.latest.at)} · 距今 ${ago(Math.max(0, Math.floor((Date.now() - t.latest.at) / 1000)))}</p></div>${act('timeline-preview', '预览', 'btn', t.latest.id, 'eye')}</div>` : ''}<label class="timeline-target-field" for="timeline-target">回退到<select id="timeline-target" class="input" aria-label="选择回退时间">${[
      ...t.nodes,
    ]
      .reverse()
      .map(
        (n) =>
          `<option value="${n.seconds}"${n.seconds === selected ? ' selected' : ''}>${label(n.seconds)}${n.record ? '' : ' · 暂无'}</option>`,
      )
      .join('')}</select></label><div class="timeline-grid compact-target">${t.nodes
      .filter((n) => n.seconds === selected)
      .map(node)
      .join(
        '',
      )}</div>${t.returnRecord ? `<div class="timeline-return"><div><strong>上次读档前</strong><p class="small muted">${time(t.returnRecord.at)} · ${hours(t.returnRecord.playSeconds)}</p></div>${act('timeline-preview', '返回此处', 'btn', t.returnRecord.id, 'refresh')}</div>` : ''}<details class="timeline-history-disclosure" data-persist-detail="timeline-history"><summary>历史与收藏 · ${t.count || 0} 个</summary><p class="small muted">读档前保护保留最近一次；反复尝试同一选择时，请收藏起点。</p>${history(t, view)}</details>${t.enabled ? '<p class="small muted timeline-slot-note">专用 29 号槽请勿手动覆盖。</p>' : ''}${settings}</section>`;
  }

  function differences(result) {
    const c = result.comparison;
    if (!c) return notice('暂时无法比较最近保存：' + (result.comparisonError || '记录不可用'), true);
    const names = (items) => items.map((n) => entityName(n, 'npc')).join('、') || '无';
    const table = (changes, row, limit = 8) =>
      `<ul class="timeline-diff-list">${changes.slice(0, limit).map(row).join('')}</ul>${changes.length > limit ? `<details><summary>其余 ${changes.length - limit} 项变化</summary><ul class="timeline-diff-list">${changes.slice(limit).map(row).join('')}</ul></details>` : ''}`;
    const changedMembers = (group) => group?.available && (group.rightOnly.length || group.leftOnly.length);
    const teamChanged = changedMembers(c.team),
      fightChanged = changedMembers(c.fightTeam);
    const taskChanged = c.quests.available && c.quests.changes.length;
    const itemsChanged = c.inventory.available && c.inventory.changes.length;
    const recipeFamilies = Array.isArray(c.recipes) ? c.recipes : [];
    const recipesKnown = recipeFamilies.length === 3 && recipeFamilies.every((family) => family.available);
    const recipesChanged = recipeFamilies.some(changedMembers);
    const timeKnown = Number.isSafeInteger(c.playSecondsDelta);
    const unchanged =
      c.moneyDelta === 0 &&
      timeKnown &&
      c.playSecondsDelta === 0 &&
      c.team.available &&
      c.fightTeam?.available &&
      c.quests.available &&
      c.inventory.available &&
      recipesKnown &&
      !teamChanged &&
      !fightChanged &&
      !taskChanged &&
      !itemsChanged &&
      !recipesChanged;
    const basis = `<p class="small muted">最近保存 ${time(result.basis.at)} → 此节点</p>`;
    const money =
      c.moneyDelta === null
        ? '<p class="small muted">铜钱数据无法比较</p>'
        : c.moneyDelta
          ? `<p>铜钱 <strong>${signed(c.moneyDelta)}</strong></p>`
          : '';
    const elapsed = !timeKnown
      ? '<p class="small muted">游玩时长无法比较</p>'
      : c.playSecondsDelta
        ? `<p>游玩时长 <strong>${c.playSecondsDelta > 0 ? '+' : '−'}${ago(Math.abs(c.playSecondsDelta))}${Math.abs(c.playSecondsDelta) >= 3600 && Math.abs(c.playSecondsDelta) % 60 ? ' ' + (Math.abs(c.playSecondsDelta) % 60) + ' 秒' : ''}</strong></p>`
        : '';
    const members = (group, heading) =>
      !group?.available
        ? `<p class="small muted">${heading}数据无法比较</p>`
        : changedMembers(group)
          ? `<h4>${heading}</h4><p class="small">加入：${names(group.rightOnly)}<br>离队：${names(group.leftOnly)}</p>`
          : '';
    const quests = !c.quests.available
      ? '<p class="small muted">任务数据无法比较</p>'
      : taskChanged
        ? `<h4>任务状态 · ${c.quests.changes.length} 项</h4>${table(c.quests.changes, (q) => `<li><strong>${entityName(q, 'quest')}</strong><span>${esc(q.left)} → ${esc(q.right)}</span></li>`)}`
        : '';
    const inventory = !c.inventory.available
      ? '<p class="small muted">库存数据无法比较</p>'
      : itemsChanged
        ? `<h4>物品数量 · ${c.inventory.changes.length} 种</h4>${table(c.inventory.changes, (i) => `<li><strong>${entityName(i, 'item')}</strong><span>${i.left} → ${i.right} <b class="${i.delta < 0 ? 'delta-less' : 'delta-more'}">(${signed(i.delta)})</b></span></li>`)}`
        : '';
    const recipeName = (row) =>
      row.known && getIndex()?.entries?.some((entry) => entry.id === row.id)
        ? act('database-detail', esc(row.name), 'text-btn', row.id)
        : esc(row.name);
    const recipes = !recipeFamilies.length
      ? '<p class="small muted">配方数据无法比较</p>'
      : recipeFamilies
          .map((family) =>
            !family.available
              ? `<p class="small muted">${esc(family.name)}配方数据无法比较</p>`
              : changedMembers(family)
                ? `<h4>${esc(family.name)}配方</h4>${table([...family.rightOnly.map((row) => ({ ...row, change: '学会' })), ...family.leftOnly.map((row) => ({ ...row, change: '未学会' }))], (row) => `<li><strong>${recipeName(row)}</strong><span>读回后${row.change}</span></li>`)}`
                : '',
          )
          .join('');
    return `<section class="detail-block timeline-differences"><h3>${icon('refresh')} 与最近保存的差别</h3>${unchanged ? '<p>已比较的铜钱、时长、队伍、任务、物品与配方无变化。</p>' : basis + money + elapsed + members(c.team, '队伍') + members(c.fightTeam, '出战队伍') + quests + inventory + recipes}<details class="timeline-comparison-basis"><summary>比较范围</summary>${unchanged ? basis : ''}<p class="small muted">方向为“最近保存 → 此节点”，比较铜钱、游玩时长、同行与出战队伍、任务状态、背包数量和已学配方，不含尚未保存的游戏进度。</p>${result.basis.id === result.record.id ? '<p class="small muted">此节点就是最近保存。</p>' : ''}</details></section>`;
  }

  function preview(result) {
    const r = result.record,
      m = result.metadata,
      favorite = bookmarked(r),
      draft = result.draft,
      ready = result.readiness,
      canLoad = ready?.ready && !ready.busy && !ready.pending && !ready.quiescing;
    const conflict = result.draftConflict
      ? `<section class="detail-block timeline-draft-conflict"><p class="notice">另一窗口已更新，未保存的输入仍保留。</p><details open><summary>保留的输入</summary><p class="preserve-text">${esc(result.draftConflict.label + '\n' + result.draftConflict.note)}</p>${act('node-pending-to-note', '转存到随手记', 'btn', r.id, 'feather')}${act('node-pending-discard', '放弃这份输入', 'text-btn', r.id)}</details></section>`
      : '';
    const editor = `<details class="timeline-node-editor"${draft ? ' open' : ''}><summary>名称与备注${draft ? ' · 有未保存草稿' : ''}</summary><label for="timeline-label">节点名称</label><input id="timeline-label" class="input" maxlength="80" placeholder="例如：品剑大会前" value="${esc(draft?.label ?? r.label ?? '')}"><label for="timeline-note">备注</label><textarea id="timeline-note" class="input" maxlength="500" rows="2" placeholder="记下当时的选择或目标">${esc(draft?.note ?? r.note ?? '')}</textarea><p id="node-draft-status" class="small muted" role="status">${draft ? '已恢复本机草稿；正式保存后更新节点。' : '草稿自动保存在本机，备注不会自动收藏节点。'}</p><div class="row wrap">${act('timeline-edit-save', '保存名称与备注', 'btn', r.id, 'check')}<button class="btn soft" data-action="timeline-edit-save" data-id="${r.id}" data-retain="true">${icon('star')}保存并收藏</button>${act('timeline-draft-discard', '放弃草稿', 'text-btn', r.id)}</div></details>`;
    return `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="时间线节点预览"><div class="drawer-head"><span>存档预览</span>${iconButton('close-overlay', 'close', '关闭预览')}</div><div class="drawer-body"><div class="tag-row">${pill(kind(r))}</div><h1>${r.label ? esc(r.label) : placeName(m)}</h1><p class="intro">${time(r.at)}${r.label ? ' · ' + placeName(m) : ''}</p><p id="timeline-load-readiness" class="${canLoad ? 'small muted' : 'notice'}" role="status">${canLoad ? '可保护当前进度后读档。' : '暂不可读档：' + esc(ready?.reason || '请等待游戏连接并回到可保存状态')}</p>${conflict}<div class="comparison-grid timeline-node-stats"><div><strong>${hours(m.playSeconds)}</strong><span>游玩时长</span></div><div><strong>${m.money === undefined ? '—' : Number(m.money).toLocaleString('zh-CN')}</strong><span>铜钱</span></div></div>${differences(result)}<div class="row wrap timeline-bookmark-action">${act('timeline-bookmark', favorite ? '取消收藏' : '收藏此节点', favorite ? 'btn soft' : 'btn', r.id, 'star')}${favorite ? '<span class="small muted">取消后参与自动轮换，可能被清理。</span>' : ''}</div>${editor}<details class="timeline-snapshot-details"><summary>当时的画面与队伍</summary>${m.thumbnail ? `<div class="save-thumbnail"><img src="${esc(m.thumbnail)}" alt="历史存档画面"></div>` : ''}<div class="detail-block"><h3>队伍</h3><p>${(m.team || []).map((n) => entityName(n, 'npc')).join('、') || '存档未记录'}</p></div></details><p class="small muted">读档前会先保存当前游戏进度，并建立完整保护副本。</p></div><div class="drawer-actions"><button id="timeline-load-button" class="btn primary" data-action="timeline-load" data-id="${r.id}"${canLoad ? '' : ' disabled'}>${icon('refresh')}保护当前进度并读档</button>${act('close-overlay', '先不读档', 'btn')}</div></section>`;
  }

  return { page, preview, chip, status };
}
