export function createTimelineViews({ esc, icon, act, pill, notice, hours, bytes, iconButton, qualityText }) {
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
            `<div class="backup-row history-row"><div class="backup-symbol">${icon(r.kind === 'before-load' ? 'shield' : bookmarked(r) ? 'star' : 'clock')}</div><div class="spacer"><h3>${esc(r.label || kind(r) + ' · ' + r.mapName)}</h3><p>${time(r.at)} · ${hours(r.playSeconds)} · ${esc(r.mapName)}${r.note ? `<br><span class="history-note">${esc(r.note)}</span>` : ''}</p></div>${pill(kind(r), bookmarked(r) ? 'green' : '')}${act('timeline-preview', '查看与读档', 'btn', r.id, 'eye')}</div>`,
        )
        .join('') || '<p class="muted history-empty">没有匹配的留存节点。</p>'
    }<div class="history-pagination"><button class="btn" data-action="timeline-page" data-id="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span class="small muted">第 ${page + 1} / ${totalPages} 页</span><button class="btn" data-action="timeline-page" data-id="${page + 1}" ${page + 1 >= totalPages ? 'disabled' : ''}>下一页</button></div></section>`;
  }
  function page(t, view = {}) {
    if (!t) return '';
    const duplicate = new Map();
    for (const n of t.nodes) if (n.record) duplicate.set(n.record.id, (duplicate.get(n.record.id) || 0) + 1);
    const selected = view.target || 60;
    const canAct = t.ready && !t.busy && !t.pending && !t.quiescing;
    const node = (n) =>
      `<article class="timeline-node ${n.record ? '' : 'unavailable'}"><div class="row between"><h3>${label(n.seconds)}</h3>${icon('clock')}</div>${n.record ? `<p class="timeline-location">${esc(n.record.mapName)}</p><time>${time(n.record.at)}</time><p class="small muted">实际距今 ${ago(n.record.ageSeconds)}<br>比目标早 ${ago(n.record.gapSeconds)}${duplicate.get(n.record.id) > 1 ? '<br>与其他档位共用此记录' : ''}</p>${act('timeline-preview', '查看与读档', 'btn', n.record.id, 'refresh')}` : `<p class="muted">${esc(n.reason || '尚未积累到这个时间')}</p><span class="small muted">允许偏差 ≤ ${ago(n.toleranceSeconds)}${n.nearestAt ? '<br>可从全部留存节点查看更早进度' : '<br>可保存时继续积累'}</span>`}</article>`;
    return `<section class="card timeline-card mb" aria-label="时间线自动存档"><div class="card-header"><div><div class="eyebrow">每一程，都有退路</div><h2>${icon('clock')} 时间线自动存档</h2></div>${pill(status(t), t.enabled && t.ready ? 'green' : '')}</div><p class="timeline-status" role="status">${esc(t.reason)}</p>${t.error ? notice(t.error) : ''}${t.pending && !t.busy ? `<div class="timeline-interrupted">${notice('上次存读档未完成。已暂停自动保存，请等待请求过期后核对保护副本。')}${act('timeline-recover', '核对中断记录', 'btn', '', 'shield')}</div>` : ''}<div class="timeline-controls"><label>尝试保存间隔 <select id="timeline-interval" class="input" aria-label="自动存档间隔">${[10, 20, 30, 60, 120, 300].map((s) => `<option value="${s}" ${s === t.interval ? 'selected' : ''}>${s >= 60 ? s / 60 + ' 分钟' : s + ' 秒'}</option>`).join('')}</select></label><button class="switch ${t.enabled ? 'on' : ''}" role="switch" aria-label="时间线自动存档" aria-checked="${t.enabled}" data-action="timeline-toggle" ${t.busy || t.pending || t.quiescing ? 'disabled' : ''}></button><span class="small">${t.enabled ? '已开启' : '开启自动保存'}</span><span class="spacer"></span><button class="btn primary" data-action="timeline-save" data-save-ready ${canAct ? '' : 'disabled'}>${icon('download')}立即保存</button>${act('folder', '历史目录', 'btn', 'timeline', 'folder')}</div>${t.latest ? `<div class="timeline-return latest-reliable"><div>${icon('shield')}<strong>最近可靠记录</strong><p class="small muted">${time(t.latest.at)} · ${esc(t.latest.mapName)} · 实际距今 ${ago(Math.max(0, Math.floor((Date.now() - t.latest.at) / 1000)))}</p></div>${act('timeline-preview', '查看最近进度', 'btn primary', t.latest.id, 'eye')}</div>` : ''}<div class="timeline-latest">${t.latest ? `最近成功保存 <strong>${time(t.latest.at)}</strong> · ${hours(t.latest.playSeconds)} · ${t.count} 个节点 · ${bytes(t.bytes)}` : '开启后，会通过游戏接口生成真正的新存档。'}<br><span class="small muted">自动候选 ${t.automaticCount || 0} / ${t.maxAutomaticRecords} · 收藏和最近一次读档前保护另存；正在预览的节点临时保护。</span></div>${t.returnRecord ? `<div class="timeline-return"><div>${icon('shield')}<strong>最近一次读档前的进度</strong><p class="small muted">${time(t.returnRecord.at)} · ${hours(t.returnRecord.playSeconds)}</p></div>${act('timeline-preview', '返回读档前进度', 'btn', t.returnRecord.id, 'refresh')}</div>` : ''}<div class="target-picker" aria-label="选择回退时间">${[
      ...t.nodes,
    ]
      .reverse()
      .map(
        (n) =>
          `<button class="chip ${n.seconds === selected ? 'active' : ''} ${n.record ? '' : 'unavailable'}" data-action="timeline-target" data-id="${n.seconds}" aria-pressed="${n.seconds === selected}" title="${esc(n.record ? '可查看历史进度' : n.reason || '尚未积累')}">${label(n.seconds)}${n.record ? '' : ' · 暂无'}</button>`,
      )
      .join('')}</div><div class="timeline-grid compact-target">${t.nodes
      .filter((n) => n.seconds === selected)
      .map(node)
      .join(
        '',
      )}</div><p class="save-note">暂停较久时，近处目标可能暂无记录；可直接查看最近可靠记录。返回入口保存的是最近一次读档前进度，每次读档会更新。想多次尝试同一选择，请先收藏尝试起点。</p><button class="btn" data-action="timeline-save" data-id="attempt" data-save-ready ${canAct ? '' : 'disabled'}>${icon('star')}留住本次尝试起点</button><p class="save-note">静默保存，不弹成功提示、不打开菜单。提供 11 个目标时间点，为持续接近这些时间，最多轮换 ${t.maxAutomaticRecords} 份自动候选，不保留每次保存。只使用目标时间之前的记录，偏差超限即不可用。10–50 秒档位允许偏差 15 秒；1/2/5/10/30/60 分钟分别允许 20/45/90/90/240/300 秒。推荐 10 秒间隔，调大间隔后较近档位可能不可用。</p><p class="save-note">游戏、手札需同时运行，菜单、战斗、对话及过场中暂停。专用 29 号手动槽请勿手动覆盖。仅能保存游戏允许保存的进度，不能从战斗中的任意一帧回退。</p>${history(t, view)}<details class="timeline-component"><summary>游戏接入组件</summary><div class="row between"><p class="small muted">${t.installed ? '官方 UE4SS 组件已接入' : '安装后请重新启动游戏'} · 已验证 Build 21798996</p><div class="row">${act('bridge-install', t.installed ? '更新组件' : '安装组件', 'btn', '', 'shield')}${act('bridge-disable', '停用接入', 'text-btn', '', 'close')}</div></div></details></section>`;
  }
  function differences(result) {
    const c = result.comparison;
    if (!c) return notice('暂时无法比较最近留存：' + (result.comparisonError || '记录不可用'), true);
    const names = (items) => items.map((n) => esc(n.name)).join('、') || '无';
    const table = (changes, row, limit = 8) =>
      changes.length
        ? `<ul class="timeline-diff-list">${changes.slice(0, limit).map(row).join('')}</ul>${changes.length > limit ? `<details><summary>其余 ${changes.length - limit} 项变化</summary><ul class="timeline-diff-list">${changes.slice(limit).map(row).join('')}</ul></details>` : ''}`
        : '<p class="small muted">没有变化</p>';
    return `<section class="detail-block timeline-differences"><h3>${icon('refresh')} 读回后会有什么变化</h3><p class="small muted">比较基准：最近留存 ${time(result.basis.at)}。以下方向为“最近留存 → 此节点”，不含尚未保存的游戏进度。</p>${result.basis.id === result.record.id ? '<p class="small muted">此节点就是最近留存。</p>' : ''}<div class="comparison-grid"><div><strong>${c.moneyDelta === null ? '—' : signed(c.moneyDelta)}</strong><span>铜钱变化</span></div><div><strong>${c.inventory.available ? c.inventory.changes.length : '—'}</strong><span>种物品数量变化</span></div></div><h4>队伍</h4>${c.team.available ? `<p class="small">加入：${names(c.team.rightOnly)}<br>离队：${names(c.team.leftOnly)}</p>` : '<p class="small muted">队伍数据无法比较</p>'}<h4>任务状态</h4>${c.quests.available ? table(c.quests.changes, (q) => `<li><strong>${esc(q.name)}</strong><span>${esc(q.left)} → ${esc(q.right)}</span></li>`) : '<p class="small muted">任务数据无法比较</p>'}<h4>物品数量</h4>${c.inventory.available ? table(c.inventory.changes, (i) => `<li><strong>${qualityText ? qualityText.name('item-' + i.id, i.name) : esc(i.name)}</strong><span>${i.left} → ${i.right} <b class="${i.delta < 0 ? 'delta-less' : 'delta-more'}">(${signed(i.delta)})</b></span></li>`) : '<p class="small muted">库存数据无法比较</p>'}</section>`;
  }
  function preview(result) {
    const r = result.record,
      m = result.metadata,
      favorite = bookmarked(r),
      draft = result.draft,
      ready = result.readiness,
      canLoad = ready?.ready && !ready.busy && !ready.pending && !ready.quiescing;
    return `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="时间线节点预览"><div class="drawer-head"><span class="small muted">存档匣 / 时间线</span>${iconButton('close-overlay', 'close', '关闭预览')}</div><div class="drawer-body"><div class="tag-row">${pill('副本校验通过', 'green')}${pill(kind(r))}</div><h1>${esc(r.label || m.mapName)}</h1><p class="intro">${time(r.at)} · ${esc(m.mapName)}</p><div class="timeline-node-editor"><div class="row between"><h3>${icon('star')} 留住重要进度</h3>${act('timeline-bookmark', favorite ? '取消收藏' : '收藏此节点', favorite ? 'btn soft' : 'btn', r.id, 'star')}</div><p class="small muted">收藏会单独保留。取消收藏后参与自动轮换；备注不会自动收藏。</p><label for="timeline-label">节点名称</label><input id="timeline-label" class="input" maxlength="80" placeholder="例如：品剑大会前" value="${esc(draft?.label ?? r.label ?? '')}"><label for="timeline-note">备注</label><textarea id="timeline-note" class="input" maxlength="500" rows="2" placeholder="记下当时的选择或目标">${esc(draft?.note ?? r.note ?? '')}</textarea><p id="node-draft-status" class="small muted" role="status">${draft ? '已恢复本机草稿；正式保存后才会更新节点。' : '编辑时自动保留草稿；关闭预览后可继续。草稿不会自动收藏节点。'}</p><div class="row wrap">${act('timeline-edit-save', '保存名称与备注', 'btn', r.id, 'check')}<button class="btn soft" data-action="timeline-edit-save" data-id="${r.id}" data-retain="true">${icon('star')}保存并长期留住</button>${act('timeline-draft-discard', '放弃草稿', 'text-btn', r.id)}</div></div><div class="comparison-grid"><div><strong>${hours(m.playSeconds)}</strong><span>游戏记录的游玩时长</span></div><div><strong>${m.money === undefined ? '—' : Number(m.money).toLocaleString('zh-CN')}</strong><span>铜钱</span></div></div>${m.thumbnail ? `<div class="save-thumbnail"><img src="${esc(m.thumbnail)}" alt="历史存档画面"><span>存档内的场景画面</span></div>` : ''}<div class="detail-block"><h3>队伍</h3><p>${(m.team || []).map((n) => esc(n.name)).join('、') || '存档未记录'}</p></div>${differences(result)}<p id="timeline-load-readiness" class="small muted" role="status">${canLoad ? '游戏当前可保存，可保护进度后读档。' : '暂不可读档：' + esc(ready?.reason || '请等待游戏连接并回到可保存状态')}</p>${notice('读档前会先保存当前游戏进度，再建立完整保护副本。游戏需要处于正常可保存的状态。', true)}<p class="small muted">历史副本按文件内容校验，原始字节保留。</p></div><div class="drawer-actions"><button id="timeline-load-button" class="btn primary" data-action="timeline-load" data-id="${r.id}" ${canLoad ? '' : 'disabled'}>${icon('refresh')}保护当前进度并读档</button>${act('close-overlay', '先不读档', 'btn')}</div></section>`;
  }
  return { page, preview, chip, status };
}
