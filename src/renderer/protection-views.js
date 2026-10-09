export function createProtectionViews({
  backupViews,
  journalPage,
  draftHistory = () => '',
  journeyTrashHistory = () => '',
  historyBackupView,
  esc,
  act,
  pill,
  iconButton,
  notice,
  empty,
  when,
  bytes,
  hours,
  name,
}) {
  const label = (id) => {
    const title = name(id) || id;
    const suffix = ' · 场景 #' + String(id).slice(6);
    return esc(String(id).startsWith('place-') && !String(title).endsWith(suffix) ? title + suffix : title);
  };
  function exportResult(result) {
    if (!result) return '';
    const complete = result.status === 'success';
    const guidance =
      result.code === 'PROTECTION_EXPORT_TARGET_EXISTS'
        ? '目标已有文件已保留，未被覆盖。请再次选择「导出全部保护资料」，另选新文件名后重试。'
        : `当前手札、游戏存档和副本原件仍保留。请核对异常副本或磁盘状态，再从完好的来源恢复资料并重新导出。${result.published ? '已有保护包生成，请核对目标文件；结果记录写入未完成。' : '请勿把上次成功结果当成本次已经完成。'}`;
    const recording = result.recordNotSaved
      ? '<p class="notice">本次结果未能写入磁盘，退出后无法凭这条记录追溯；请先保留诊断并核对目标文件。之前成功导出的记录不代表这次操作完成。</p>'
      : '';
    return `<section class="card mb" aria-label="最近一次完整导出"><div class="card-header"><h2>${complete ? '最近一次完整导出已完成' : '最近一次完整导出未确认完成'}</h2>${pill(complete ? '已校验' : '需核对', complete ? 'green' : '')}</div>${recording}<p${complete ? '' : ' class="notice" role="alert"'}>${esc(result.message)}</p>${result.at ? `<p class="small muted">${when(result.at)}</p>` : ''}${result.file ? `<p class="small mono">目标：${esc(result.file)}</p>` : ''}${result.backupId ? `<p>受影响副本：<span class="mono">${esc(result.backupId)}</span></p>${act('backup-folder', '打开受影响副本目录', 'btn', result.backupId, 'folder')}` : ''}${!complete ? `<p class="save-note">${guidance}</p>` : ''}${result.omittedArchives?.length ? `<p class="notice">本次经确认未包含 ${result.omittedArchives.length} 份异常历史档案，它们仍在本机；换机前请另外保留这些原件。</p>` : ''}${result.diagnostic || result.recordError ? `<details><summary>查看诊断详情</summary><p class="preserve-text small">${esc([result.code, result.reasonCode, result.diagnostic, result.recordError].filter(Boolean).join('\n'))}</p></details>` : ''}</section>`;
  }
  function itineraryHistory(journey) {
    const itinerary = journey?.itinerary;
    if (!itinerary) return '';
    const handled = new Set(journey.handledActionIds || []);
    return `<details class="detail-block historical-itinerary"><summary>已保存的本次行程 · ${esc(itinerary.name)} · ${itinerary.steps.length} 项</summary><p>保存时的状态：${{ draft: '尚未开始', active: '进行中', ended: '已结束' }[itinerary.status] || '待核对'}</p><p class="save-note">以下保留当时的顺序、确切场景和个人标记，只供回顾。任务进度与背包不使用当前存档重新推断，也不会改变当前行程。</p>${
      itinerary.steps
        .map(
          (step, index) =>
            `<div class="detail-block"><h4>${index + 1}. ${esc(step.title)}</h4><div class="tag-row">${pill(step.skipped ? '仅本次跳过' : '本次未跳过')}${pill(handled.has(step.actionId) ? '个人已处理' : '未标记个人处理')}${pill(step.progressMode === 'save' ? '任务按保存的参照核对' : '个人安排')}</div><p>选定场景：${step.placeId ? `${label(step.placeId)} <span class="mono">${esc(step.placeId)}</span>` : '未选择场景'}</p><details><summary>当时选择的来源</summary>${step.sources.map((source) => `<p class="small">${label(source.id)} <span class="mono">${esc(source.type)} · ${esc(source.id)} · ${esc(source.field)}</span></p>`).join('')}${step.continuationId ? `<p class="small mono">已选接续：${esc(step.continuationId)}</p>` : ''}</details></div>`,
        )
        .join('') || '<p class="small muted">这份行程没有选定行动</p>'
    }</details>`;
  }
  function historicalGoalQuantity(goal) {
    const source = goal.source;
    if (source?.type !== 'database') return '';
    if (/^item-/.test(source.id)) return `<br>收集数量：${esc(source.quantity || 1)} 件`;
    if (/^(fusion|alchemy|cooking)-/.test(source.id)) return `<br>配方次数：${esc(source.quantity || 1)} 次`;
    return '';
  }
  function profileHistory(p) {
    const journey = p.journey;
    return `<details class="detail-block"><summary>${esc(p.name)} · ${p.goals.length} 件目标 · ${p.craftPlans?.length || 0} 份制作计划</summary>${draftHistory(p)}${journeyTrashHistory(p)}${p.journalEntries?.length || p.journalDrafts?.length || p.journalTrash?.length || p.journalRevisions?.length ? act('protection-journal-profile', '浏览逐条江湖记录 · ' + (p.journalEntries?.length || 0) + ' 条' + (p.journalDrafts?.length ? ' · ' + p.journalDrafts.length + ' 份草稿' : '') + (p.journalTrash?.length ? ' · ' + p.journalTrash.length + ' 条已删除记录' : '') + (p.journalRevisions?.length ? ' · ' + p.journalRevisions.length + ' 份旧版本' : ''), 'btn', p.id, 'book') : ''}${p.noteRevisions?.length ? `<details data-historical-note-revisions><summary>随手记旧内容 · ${p.noteRevisions.length} 份 · 只读</summary>${p.noteRevisions.map((row) => `<details class="detail-block"><summary>${when(row.replacedAt)} · ${esc(row.body.slice(0, 80))}</summary><p class="preserve-text">${esc(row.body)}</p></details>`).join('')}</details>` : ''}${p.notes ? `<h3>随手记</h3><p class="preserve-text">${esc(p.notes)}</p>` : '<p class="small muted">没有笔记</p>'}<details><summary>目标记录</summary>${p.goals.map((g) => `<p class="small">${g.done ? '✓' : '○'} ${esc(g.title)}${g.placeId ? ' · ' + label(g.placeId) : ''}${historicalGoalQuantity(g)}${g.detail ? '<br>' + esc(g.detail) : ''}</p>`).join('') || '<p class="small muted">没有目标</p>'}</details>${(
      p.craftPlans || []
    )
      .map(
        (plan) =>
          `<details><summary>${esc(plan.name)} · ${plan.list.length} 种配方</summary>${plan.list.map((line) => `<p class="small">${label(line.id)} × ${line.quantity}</p>`).join('')}${Object.entries(
            plan.choices || {},
          )
            .map(([id, recipeId]) => `<p class="small">加工 ${label('item-' + id)}：${label(recipeId)}</p>`)
            .join('')}</details>`,
      )
      .join(
        '',
      )}${journey ? `<details><summary>个人行程 · ${journey.todos.length} 件待办 · ${journey.gifts.length} 份赠礼 · ${journey.places.length} 个地点</summary>${journey.todos.map((t) => `<p class="preserve-text small">${t.done ? '✓' : '○'} ${esc(t.title)}${t.placeId ? ' · ' + label(t.placeId) : ''}${t.detail ? '<br>' + esc(t.detail) : ''}</p>`).join('')}${journey.gifts.map((g) => `<p class="preserve-text small">${g.done ? '✓' : '○'} 赠予 ${label(g.npcId)}：${label(g.itemId)} × ${g.quantity}${g.placeId ? ' · ' + label(g.placeId) : ''}${g.note ? '<br>' + esc(g.note) : ''}</p>`).join('')}${journey.places.map((place) => `<p class="preserve-text small">${place.done ? '✓' : '○'} ${place.favorite ? '★ ' : ''}${label(place.placeId)}${place.note ? '<br>' + esc(place.note) : ''}</p>`).join('')}${itineraryHistory(journey)}<p class="small muted">另有 ${journey.handledActionIds.length} 项已处理行动记录，使用历史手札后可继续管理。</p></details>` : ''}${p.savedSearches?.length ? `<details><summary>保存的查询 · ${p.savedSearches.length} 份</summary>${p.savedSearches.map((q) => `<p class="small mono">${esc(q)}</p>`).join('')}</details>` : ''}</details>`;
  }
  function controls(view) {
    const failed = view.importFailure;
    const importError = failed
      ? `<section class="card mb" aria-label="保护资料导入未完成"><h3>导入未完成</h3><p role="alert">${esc(failed.message)}</p><p class="save-note">当前手札和游戏存档保留。请重新复制完好的原包；使用分卷时带齐整个目录后再试。空间不足或文件被占用时，请先处理详情中的原因。</p><details><summary>查看校验详情</summary><p class="small mono preserve-text">${esc(failed.diagnostic)}</p></details><div class="row">${act(failed.mode === 'directory' ? 'protection-import-volumes' : 'protection-import', '重新选择并导入', 'btn primary', '', 'upload')}${act('protection-import-error-dismiss', '关闭这条提示', 'text-btn')}</div></section>`
      : '';
    const omitted = view.omittedArchives || [];
    const warning = omitted.length
      ? `<section class="card mb"><h3>上次导出未包含 ${omitted.length} 份异常历史档案</h3><p class="save-note">原件仍在本机。这份导出包只含本次已校验资料；换机前请另外保留原始数据目录，并从完好的原保护包恢复异常档案。</p><details><summary>查看未包含的档案</summary>${omitted.map((archive) => `<div class="detail-block"><strong>${esc(archive.label)}</strong><p class="small">${esc(archive.reason)}</p><small class="mono">${esc(archive.id)}</small></div>`).join('')}</details></section>`
      : '';
    return (
      importError +
      warning +
      `<section class="card mb"><div class="card-header"><h2>离线保护与换机</h2><div class="row wrap">${act('protection-export', '导出全部保护资料', 'btn', '', 'download')}${act('protection-import', '导入保护包', 'btn', '', 'upload')}${act('protection-import-volumes', '导入分卷目录', 'btn', '', 'folder')}${act('protection-open', '浏览离线档案', 'text-btn', '', 'archive')}</div></div><p class="save-note">一次带走本机全部周目的手札、完整备份、时间线与书签说明，以及以前导入的每份历史档案。数据较多时自动生成分卷目录，请完整复制后用「导入分卷目录」。导入后先作为只读档案保存，确认后才能使用手札或恢复完整备份；重复档案经完整校验后沿用原件。已有文件不会覆盖。</p>${view.retainedUnverifiedArchives?.length ? notice(`本次保留了 ${view.retainedUnverifiedArchives.length} 份未通过校验的旧档案及原始字节；已从完好保护包另存可用档案。可继续浏览本次已校验的记录。`, true) : ''}${view.busy ? notice(view.label + '… 文件较多时需要一些时间，请等待校验完成。', true) : ''}</section>`
    );
  }
  function page(view) {
    const h = view.history;
    const count = Math.ceil(view.archives.length / 20);
    const listPage = Math.max(0, Math.min(view.archivePage || 0, count - 1));
    const list = view.archives.slice(listPage * 20, listPage * 20 + 20);
    return `<div class="page-header"><div><div class="eyebrow">BRING YOUR JOURNEY WITH YOU</div><h1 class="serif">离线档案</h1><p>带走手札与保护记录，换机后继续查阅。</p></div>${act('navigate', '返回存档匣', 'btn', 'saves', 'arrow')}</div>${controls(view)}${view.error ? notice(view.error) : ''}${h ? history(h, view) : `<section class="card"><div class="card-header"><h2>已保存的离线档案 · ${view.loaded ? view.archives.length + ' 份' : '数量待核对'}</h2>${act('protection-open', '刷新', 'text-btn', '', 'refresh')}</div>${!view.loaded ? `<p role="status">${view.error ? '档案列表暂时无法读取，请点击“刷新”重试；本机已有档案仍保留。' : '正在读取档案列表…'}</p>` : list.map((a) => `<div class="backup-row"><div class="spacer"><h3>${esc(a.label)}</h3><p>${a.createdAt ? when(a.createdAt) : '创建时间待核对'} · ${a.profiles ?? '?'} 个周目 · ${a.backups ?? '?'} 份完整备份 · ${a.nodes ?? '?'} 个节点</p><small>${esc(a.error || '打开时重新校验全部字节')}</small></div>${act('protection-history', '打开并校验', 'btn', a.id, 'book')}</div>`).join('') || empty('尚未导入离线档案', '从旧机器导出保护包，在这里导入并核对。')}${count > 1 ? `<div class="pagination">${act('protection-archive-page', '上一页', 'btn', String(Math.max(0, listPage - 1)))}<span>第 ${listPage + 1} / ${count} 页</span>${act('protection-archive-page', '下一页', 'btn', String(Math.min(count - 1, listPage + 1)))}</div>` : ''}</section>`}`;
  }
  function history(h, view) {
    const selected = h.backups.find((b) => b.id === view.backupId);
    const nodes = h.timeline.records,
      page = Math.min(view.nodePage || 0, Math.max(0, Math.ceil(nodes.length / 20) - 1));
    return `<section class="card mb"><div class="card-header"><h2>${esc(h.journal.profiles.map((p) => p.name).join('、'))}</h2>${act('protection-open', '返回档案列表', 'text-btn', '', 'arrow')}</div><div class="tag-row">${pill('全部字节已校验', 'green')}${pill('只读历史 · 未绑定本机')}</div><p class="save-note">创建于 ${when(h.createdAt)}。旧路径、账户与自动存读档权限未启用；时间线节点供只读回顾，不能直接原生读档。</p>${act('protection-history-export', '导出这份完整历史保护包', 'btn', h.id, 'download')}${h.compatible ? act('protection-use-journal', '使用这份历史手札…', 'btn', h.id, 'book') : notice('历史手札资料不兼容，仍可保留并浏览保护记录：' + h.compatibilityError, true)}</section><section class="card mb"><h2>历史周目与笔记</h2>${h.journal.profiles.map(profileHistory).join('')}</section>${
      h.journal.profiles.find((p) => p.id === view.journalProfileId)
        ? `<section class="card mb historical-journal">${journalPage(
            h.journal.profiles.find((p) => p.id === view.journalProfileId),
            view,
          )}</section>`
        : ''
    }<section class="card mb"><h2>完整保护备份 · ${h.backups.length} 份</h2><p class="save-note">先查看备份中的文件，再选择是否恢复到当前连接的本机账户。恢复前会保护当前完整进度，其他槽位继续保留。</p>${backupViews.page(h.backups, { ...historyBackupView, backupId: view.backupId }, true)}${selected ? `<section class="detail-block"><h3>${esc(selected.label)}的文件</h3>${selected.files.map((f) => `<div class="world-rule"><span>${esc(f.name)} <small>${bytes(f.bytes)}</small></span>${/\.sav$/i.test(f.name) ? act('protection-backup-inspect', '只读回顾', 'text-btn', f.name, 'book') : '<span class="small muted">原始附件已保留</span>'}</div>`).join('')}${act('protection-restore', '恢复这份完整备份…', 'btn danger', selected.id, 'refresh')}</section>` : ''}</section><section class="card"><h2>历史时间线 · ${nodes.length} 个节点</h2>${
      nodes
        .slice(page * 20, page * 20 + 20)
        .map(
          (n) =>
            `<div class="backup-row"><div class="spacer"><h3>${esc(n.label || n.map || '历史节点')}${n.bookmarked ? ' · 书签' : ''}</h3><p>${when(n.at)} · ${hours(n.playSeconds)}</p>${n.note ? `<p class="preserve-text small">${esc(n.note)}</p>` : ''}</div>${act('protection-node-inspect', '只读回顾', 'btn', n.id, 'book')}</div>`,
        )
        .join('') || '<p class="small muted">此保护包没有时间线记录</p>'
    }${nodes.length > 20 ? `<div class="pagination">${act('protection-node-page', '上一页', 'btn', String(Math.max(0, page - 1)))}<span>第 ${page + 1} / ${Math.ceil(nodes.length / 20)} 页</span>${act('protection-node-page', '下一页', 'btn', String(Math.min(Math.ceil(nodes.length / 20) - 1, page + 1)))}</div>` : ''}</section>`;
  }
  function preview(file) {
    const m = file.metadata;
    return `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="历史存档只读回顾"><div class="drawer-head"><span class="small muted">离线档案 / 当时的进度</span>${iconButton('close-overlay', 'close', '关闭回顾')}</div><div class="drawer-body"><div class="tag-row">${pill('只读历史', 'green')}${pill('未绑定本机')}</div><h1>${esc(file.name)}</h1><p>${when(file.modifiedAt)} · ${bytes(file.bytes)}</p>${m ? `${m.thumbnail ? `<div class="save-thumbnail"><img src="${m.thumbnail}" alt="历史存档自带的场景缩略图"></div>` : ''}<div class="detail-stat-grid"><div><small>场景</small><strong>${esc(m.mapName || m.map || '未知')}</strong></div><div><small>累计游玩</small><strong>${hours(m.playSeconds)}</strong></div><div><small>铜钱</small><strong>${m.money ?? '未读取'}</strong></div></div><h3>当时的任务记录</h3>${(m.quests || []).map((q) => `<div class="world-rule"><span>${esc(q.name || '任务 #' + q.id)}</span><span>${{ 0: '未开始', 1: '进行中', 2: '失败', 3: '未接受', 4: '已完成' }[q.step] || '状态未知'}</span></div>`).join('') || '<p class="small muted">没有可读取的任务记录</p>'}<details><summary>当时的背包 · ${m.inventory?.length ?? '未读取'} 条记录</summary>${(m.inventory || []).map((i) => `<p class="small">${esc(i.name || '物品 #' + i.id)} × ${i.count}</p>`).join('')}</details>` : notice('当前版本无法解析这份历史存档，原始字节已校验并保留。', true)}<p class="save-note">这些信息来自历史存档，不参与当前库存、任务完成判定或原生槽位授权。</p></div></section>`;
  }
  return { controls, page, preview, exportResult };
}
