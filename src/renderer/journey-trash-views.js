// Deleted personal arrangements are distinct from the journal of past events.
export function createJourneyTrashViews({ esc, act, when }) {
  const kinds = {
    place: '地点打算',
    todo: '个人待办',
    gift: '赠礼意图',
    goal: '行囊目标',
    'craft-plan': '制作计划',
    itinerary: '本次行程完整副本',
  };
  function sourceName(index, id) {
    const place = index.world?.maps.find((row) => row.id === id);
    if (place) return place.name + ' · 场景 #' + place.gameId;
    const entry = index.entries?.find((row) => row.id === id);
    return entry
      ? entry.name + (entry.quality ? ' · ' + entry.quality + '色品质' : '')
      : '原引用需要重新核对';
  }
  function goalSourceName(source, index) {
    if (source.type === 'planner') return source.id === 'current' ? '当时的编辑清单' : '已保存的独立备料计划';
    if (source.type === 'guide')
      return index.guides?.find((row) => row.id === source.id)?.title || '原线索需要重新核对';
    if (source.type === 'quest')
      return index.world?.quests.find((row) => row.id === source.id)?.name || '原任务需要重新核对';
    return sourceName(index, source.id);
  }
  function title(row, index) {
    const record = row.record;
    if (['craft-plan', 'itinerary'].includes(row.kind)) return record.name;
    return ['todo', 'goal'].includes(row.kind)
      ? record.title
      : row.kind === 'place'
        ? sourceName(index, record.placeId)
        : '赠予 ' + sourceName(index, record.npcId) + '：' + sourceName(index, record.itemId);
  }
  function craftContent(record, index) {
    return [
      ...record.list.map(
        (line) => `配方：${sourceName(index, line.id)} · ${line.id} · 制作次数 ${line.quantity}`,
      ),
      ...Object.entries(record.choices || {}).map(
        ([itemId, recipeId]) =>
          `加工选择：${sourceName(index, 'item-' + itemId)} · item-${itemId} → ${sourceName(index, recipeId)} · ${recipeId}`,
      ),
      !Object.keys(record.choices || {}).length ? '未指定加工选择，核对时按当前配方规则计算' : '',
      record.reserved === false ? '原预留偏好：不保留材料' : '原预留偏好：保留材料',
      record.done ? '原计划为整份已制作完成 · 用料已释放' : '原计划为尚未完成',
      `创建于 ${when(record.createdAt)} · 更新于 ${when(record.updatedAt)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  function content(row, index) {
    return row.kind === 'itinerary'
      ? itineraryContent(row.record, index)
      : row.kind === 'craft-plan'
        ? craftContent(row.record, index)
        : row.record.detail || row.record.note || '';
  }
  const statuses = { draft: '尚未出发', active: '正在进行', ended: '已结束' };
  function itinerarySource(source, index) {
    const kind = { user: '个人安排', quest: '任务', database: '图鉴' }[source.type];
    const label = source.type === 'user' ? '' : goalSourceName(source, index) + ' · ';
    return `${kind}：${label}${source.id} · ${source.field}`;
  }
  function itineraryContent(record, index) {
    return [
      `行程名称：${record.name} · ${statuses[record.status]} · ${record.steps.length} 项选择`,
      ...record.steps.flatMap((step, at) => [
        `${at + 1}. ${step.title}`,
        step.placeId
          ? `确切资料场景：${sourceName(index, step.placeId)} · ${step.placeId}`
          : '未选择资料场景',
        step.skipped ? '仅本次跳过' : '本次未跳过',
        step.progressMode === 'save' ? '按当前存档参照核对进度' : '个人手动处理',
        `原行动：${step.actionId}`,
        ...(step.continuationId ? [`原接续行动：${step.continuationId}`] : []),
        ...step.sources.map((source) => itinerarySource(source, index)),
      ]),
    ].join('\n');
  }
  function itineraryDetail(record, index, { heading = '完整行程' } = {}) {
    if (!record)
      return `<section class="detail-block itinerary-recovery-detail"><h3>${esc(heading)}</h3><p>当前尚无本次行程选择。</p></section>`;
    return `<section class="detail-block itinerary-recovery-detail"><h3>${esc(heading)}</h3><p class="preserve-text">行程名称：${esc(record.name)} · ${statuses[record.status]} · ${record.steps.length} 项选择</p>${record.steps
      .map((step, at) => {
        const sourceDetails = [
          `原行动：${step.actionId}`,
          ...(step.continuationId ? [`原接续行动：${step.continuationId}`] : []),
          ...step.sources.map((source) => itinerarySource(source, index)),
        ].join('\n');
        return `<div class="mb"><h4 class="preserve-text">${at + 1}. ${esc(step.title)}</h4><p class="small">${step.placeId ? '确切资料场景：' + esc(sourceName(index, step.placeId)) + ' · ' + esc(step.placeId) : '未选择资料场景'}<br>${step.skipped ? '仅本次跳过' : '本次未跳过'} · ${step.progressMode === 'save' ? '按当前存档参照核对进度' : '个人手动处理'}</p><details><summary>来源与接续</summary><p class="preserve-text small">${esc(sourceDetails)}</p></details></div>`;
      })
      .join('')}</section>`;
  }
  function detail(row, index, { preview = false } = {}) {
    const record = row.record;
    if (row.kind === 'itinerary')
      return `${itineraryDetail(record, index, { heading: record.name })}<p class="small muted">本次行程完整副本 · ${preview ? '准备保留，尚未确认' : '保留于 ' + when(row.deletedAt)}</p><p class="save-note">找回时仅替换本次行程的名称、状态、顺序、确切场景与本次跳过选择；当前行程先留作可找回副本。后来保存的待办、赠礼、目标、手记继续保留；个人已处理按当前状态保留，游戏进度按当前参照重新核对。</p>`;
    if (row.kind === 'craft-plan')
      return `<section class="detail-block"><h3 class="preserve-text">${esc(record.name)}</h3><p class="small muted">制作计划 · ${preview ? '准备移除，尚未确认' : '移除于 ' + when(row.deletedAt)}</p><p class="preserve-text">${esc(craftContent(record, index))}</p><p class="save-note">找回为独立保存的计划，不自动打开或改变当前编辑清单及其加工选择、预留设置；按当前参照重新核对共享用料，不重放完成事件或重新关联历史记录。</p></section>`;
    const goalSource =
      row.kind === 'goal' && record.source
        ? `<p class="small muted">原资料：${esc({ guide: '线索', quest: '任务', database: '图鉴', planner: '备料计划' }[record.source.type])} · ${esc(goalSourceName(record.source, index))}${record.source.quantity ? ' · 制作次数 ' + record.source.quantity : ''}</p>`
        : '';
    const goalState =
      row.kind === 'goal'
        ? `<p class="small muted">${record.pinned ? '原目标已置顶' : '原目标未置顶'}${record.progressMode ? ' · ' + (record.progressMode === 'auto' ? '按存档自动跟踪' : '手动管理进度') : ''}${record.createdAt ? ' · 创建于 ' + when(record.createdAt) : ''}</p>`
        : '';
    return `<section class="detail-block"><h3>${esc(title(row, index))}</h3><p class="small muted">${esc(kinds[row.kind])} · ${preview ? '准备移除，尚未确认' : '移除于 ' + when(row.deletedAt)}</p>${row.kind === 'gift' ? `<p>精确品质物品 × ${record.quantity}</p>` : ''}${row.kind !== 'place' && record.placeId ? `<p>${esc(sourceName(index, record.placeId))}</p>` : ''}<p>${record.done ? '原记录为个人已完成' : '原记录为尚未完成'}${row.kind === 'place' ? ' · ' + (record.favorite ? '原记录优先显示此地点' : '原记录未优先显示') : ''}</p>${goalState}${goalSource}<p class="preserve-text">${esc(record.detail || record.note || '')}</p><p class="save-note">恢复后以当前参照重新核对物资用途；不恢复游戏状态或重放完成事件。</p></section>`;
  }
  function entry(p) {
    return p.journeyTrash?.length
      ? `<div class="notice mb">${act('journey-trash-open', `找回已移除的个人安排 · ${p.journeyTrash.length} 项`, 'text-btn')}</div>`
      : '';
  }
  function panel(p, index, view = {}, readOnly = false) {
    const prefix = readOnly ? 'historical-journey-trash' : 'journey-trash',
      query = view.query || '';
    const rows = (p.journeyTrash || [])
      .filter((row) => `${title(row, index)} ${kinds[row.kind]} ${content(row, index)}`.includes(query))
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    const pages = Math.max(1, Math.ceil(rows.length / 20)),
      page = Math.max(1, Math.min(view.page || 1, pages));
    return `<section class="card mb journey-trash-panel"><div class="row between"><h2>${readOnly ? '历史已移除安排 · 只读' : '找回已移除的个人安排'}</h2>${readOnly ? '' : act('journey-trash-close', '回到当前行程', 'text-btn')}</div><p class="save-note">${readOnly ? '这里只回顾以前移除的完整内容，当前手札保持。' : '仅恢复所选内容，后来写的内容保留；完整行程会替换本次选择，并先保留当前行程副本。其他同一事项已被重新创建时，会先阻止覆盖。'}</p><label class="field"><span>搜索名称与完整说明</span><input class="input" id="${prefix}-query${readOnly ? '-' + esc(p.id) : ''}" data-journey-trash-query="${readOnly ? 'history' : 'current'}" data-profile-id="${esc(p.id)}" data-persist="journey-trash-query" maxlength="100" value="${esc(query)}"></label><p class="small muted">${rows.length} 项 · 第 ${page} / ${pages} 页</p>${
      rows
        .slice((page - 1) * 20, page * 20)
        .map(
          (row) =>
            `<article class="detail-block" data-journey-trash-id="${esc(row.id)}"><h3>${esc(title(row, index))}</h3><p class="small muted">${esc(kinds[row.kind])} · ${when(row.deletedAt)}</p><p class="preserve-text small">${esc(content(row, index).slice(0, 140))}</p><div class="row wrap">${act(prefix + '-detail', '查看完整内容', 'btn', (readOnly ? p.id + '|' : '') + row.id)}${readOnly ? '' : act('journey-trash-restore-preview', row.kind === 'itinerary' ? '找回这一程…' : '找回这项安排…', 'btn primary', row.id) + (row.kind === 'goal' ? act('journey-trash-copy-goal-preview', '按原文字另存为独立目标…', 'btn', row.id) : '') + act('journey-trash-purge-preview', '永久清除…', 'text-btn', row.id)}</div></article>`,
        )
        .join('') || '<p class="small muted">没有匹配的已移除安排。</p>'
    }<div class="row wrap">${page > 1 ? act(prefix + '-page', '上一页', 'btn', (readOnly ? p.id + '|' : '') + (page - 1)) : ''}${page < pages ? act(prefix + '-page', '下一页', 'btn', (readOnly ? p.id + '|' : '') + (page + 1)) : ''}</div></section>`;
  }
  return { title, detail, itineraryDetail, entry, panel };
}
