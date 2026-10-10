// Sandboxed ES module: user records, bounded queries and form parsing only.
export const JOURNAL_PAGE_SIZE = 20;
export const JOURNAL_KIND_LABELS = Object.freeze({
  manual: '手写记录',
  'goal-completed': '目标 · 你标为完成',
  'goal-reopened': '目标 · 你重新打开',
  'todo-completed': '待办 · 你标为完成',
  'todo-reopened': '待办 · 你重新打开',
  'gift-completed': '赠礼 · 你标为完成',
  'gift-reopened': '赠礼 · 你重新打开',
  'craft-plan-completed': '制作计划 · 你标为完成',
  'craft-plan-reopened': '制作计划 · 你重新打开',
});
const LINK_LABELS = Object.freeze({
  database: '图鉴',
  quest: '任务',
  place: '地点',
  guide: '线索',
  goal: '目标',
  'craft-plan': '制作计划',
  todo: '待办',
  gift: '赠礼意图',
});
const lower = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
const byId = (rows, id) => (rows || []).find((row) => row.id === id);
const placeLabel = (label, id) => {
  const suffix = ' · 场景 #' + id.slice(6);
  return String(label).endsWith(suffix) ? label : label + suffix;
};
// Mirror the core gift-labels convention without Node access in this sandbox.
const giftItemLabel = (item) =>
  item ? (item.quality ? `${item.name}（${item.quality}色品质）` : item.name) : '';
const giftPersonLabel = (person, entries) => {
  if (!person) return '';
  const sameName = entries.filter((row) => row.kind === '人物' && row.name === person.name);
  return sameName.length > 1 ? `${person.name}（资料编号 ${person.gameId ?? person.id}）` : person.name;
};

function tables(profile, index = {}) {
  return {
    database: [
      ...new Map(
        [...(index.world?.people || []), ...(index.entries || index.game?.entries || [])].map((row) => [
          row.id,
          row,
        ]),
      ).values(),
    ],
    quest: index.world?.quests || index.quests || [],
    place: index.world?.maps || index.maps || [],
    guide: index.guides || index.catalog?.entries || [],
    goal: profile.goals || [],
    'craft-plan': profile.craftPlans || [],
    todo: profile.journey?.todos || [],
    gift: profile.journey?.gifts || [],
  };
}
function rowLabel(type, row, profile, index, sources = tables(profile, index)) {
  if (type === 'database') {
    const name = String(row.name || row.title || row.id);
    const prefix = row.kind ? `${row.kind} · ` : '';
    let suffix = '';
    if (row.kind === '物品' || row.kind === '武学') suffix = giftItemLabel({ ...row, name: '' });
    if (row.kind === '物品' && (row.typeKey === 'Recipe' || row.teachesRecipes?.length))
      suffix += ' · 学习图纸';
    if (row.kind === '人物') suffix = giftPersonLabel(row, sources.database).slice(row.name.length);
    return prefix + name.slice(0, 160 - prefix.length - suffix.length) + suffix;
  }
  if (type === 'place')
    return `${row.name || row.title || row.id} · 场景 #${row.gameId ?? String(row.id).slice(6)}`;
  if (type === 'quest')
    return `${row.title || row.name || row.id} · 任务 #${row.gameId ?? String(row.id).replace(/^quest-/, '')}`;
  if (type === 'goal' && row.placeId) {
    const place = byId(sources.place, row.placeId) || { id: row.placeId };
    return `${row.title || row.name || row.id} · ${rowLabel('place', place, profile, index, sources)}`;
  }
  if (type === 'gift') {
    const entries = index.entries || index.game?.entries || [];
    return `${giftPersonLabel(byId(sources.database, row.npcId), entries) || row.npcId} · ${giftItemLabel(byId(sources.database, row.itemId)) || row.itemId} × ${row.quantity}`.slice(
      0,
      160,
    );
  }
  return row.title || row.name || row.id;
}
function referenceLabel(link, profile, index, sources = tables(profile, index)) {
  if (link.type === 'place') return placeLabel(link.label, link.id);
  const current = link.detached ? null : byId(sources[link.type], link.id);
  if (current && ['database', 'gift', 'goal', 'quest'].includes(link.type)) {
    const identity = rowLabel(link.type, current, profile, index, sources);
    const suffix = ` · 当前资料：${identity}`;
    if (link.label !== identity && !link.label.endsWith(suffix)) return link.label + suffix;
  }
  return link.label;
}
function matchingJournalReferences(profile, index, query) {
  const tokens = lower(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const candidates = [];
  const sources = tables(profile, index);
  for (const [type, rows] of Object.entries(sources)) {
    for (const row of rows) {
      const label = rowLabel(type, row, profile, index, sources);
      const detail = ['goal', 'todo', 'gift', 'craft-plan'].includes(type)
        ? row.detail || row.note || ''
        : '';
      const haystack = lower(`${LINK_LABELS[type]} ${row.id} ${label} ${detail}`);
      if (tokens.every((token) => haystack.includes(token)))
        candidates.push({ type, id: row.id, label, detail });
    }
  }
  return candidates.sort(
    (a, b) =>
      a.label.localeCompare(b.label, 'zh-CN') || `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`, 'en'),
  );
}
export function journalReferenceChoices(profile, index, query = '', limit = 20) {
  return matchingJournalReferences(profile, index, query)
    .slice(0, Math.max(0, Math.min(20, limit)))
    .map(({ type, id, label }) => ({ type, id, label }));
}
function dateBound(value, end = false) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw Error('日期范围无效');
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (year < 1 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    throw Error('日期范围无效');
  if (end) {
    date.setDate(date.getDate() + 1);
    return date.getTime() - 1;
  }
  return date.getTime();
}
// Dates use the same local calendar as when() and the date controls. The ID
// tie-breaker is code-point order, independent of locale and insertion order.
export function queryJournalEntries(profile, view = {}, index = {}) {
  let from, to;
  try {
    from = dateBound(view.from);
    to = dateBound(view.to, true);
  } catch (error) {
    return {
      entries: [],
      matchedIds: [],
      total: 0,
      page: 1,
      pages: 1,
      pageSize: JOURNAL_PAGE_SIZE,
      error: error.message,
    };
  }
  if (from !== null && to !== null && from > to)
    return {
      entries: [],
      matchedIds: [],
      total: 0,
      page: 1,
      pages: 1,
      pageSize: JOURNAL_PAGE_SIZE,
      error: '开始日期不能晚于结束日期',
    };
  const tokens = lower(String(view.query || '').slice(0, 200))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const sources = tables(profile, index);
  const resolved = Object.fromEntries(
    Object.entries(sources).map(([type, rows]) => [type, new Map(rows.map((row) => [row.id, row]))]),
  );
  const matchingIds = Array.isArray(view.ids) ? new Set(view.ids) : null;
  const rows = (profile.journalEntries || [])
    .filter((entry) => {
      if (matchingIds && !matchingIds.has(entry.id)) return false;
      const time = Date.parse(entry.occurredAt);
      if (
        (view.kind && view.kind !== entry.kind) ||
        (view.tag && !entry.tags.some((tag) => lower(tag) === lower(view.tag))) ||
        (from !== null && time < from) ||
        (to !== null && time > to)
      )
        return false;
      const names = entry.links.map((link) => {
        const current = link.detached ? null : resolved[link.type]?.get(link.id);
        return `${link.type} ${link.id} ${link.label} ${current ? rowLabel(link.type, current, profile, index, sources) : ''}`;
      });
      const haystack = lower(
        [
          entry.title,
          entry.body,
          ...entry.tags,
          ...names,
          entry.snapshot?.mapName,
          entry.snapshot?.name,
        ].join(' '),
      );
      return tokens.every((token) => haystack.includes(token));
    })
    .sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const pages = Math.max(1, Math.ceil(rows.length / JOURNAL_PAGE_SIZE));
  const requested = Number(view.page);
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  return {
    entries: rows.slice((page - 1) * JOURNAL_PAGE_SIZE, page * JOURNAL_PAGE_SIZE),
    matchedIds: rows.map((entry) => entry.id),
    total: rows.length,
    page,
    pages,
    pageSize: JOURNAL_PAGE_SIZE,
    error: '',
  };
}
export function journalLocalTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
export function journalTimeFromLocal(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))
    throw Error('请填写有效的事件时间');
  const date = new Date(value);
  const canonical =
    value.length === 16 ? value + ':00.000' : value.length === 19 ? value + '.000' : value.padEnd(23, '0');
  if (!Number.isFinite(date.getTime()) || journalLocalTime(date) !== canonical)
    throw Error('事件时间不存在，请重新选择');
  return date.toISOString();
}
export function readJournalForm(form) {
  const values = new FormData(form);
  const get = (name) => String(values.get(name) || '');
  const links = get('journal-links')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      if (at < 1) throw Error('关联资料无效，请移除后重新选择');
      return { type: line.slice(0, at), id: line.slice(at + 1) };
    });
  const entryId = form.dataset.entryId;
  return {
    type: entryId ? 'journal-entry-update' : 'journal-entry-put',
    ...(entryId
      ? {
          id: entryId,
          ...(form.dataset.entrySnapshot ? { expectedEntry: JSON.parse(form.dataset.entrySnapshot) } : {}),
        }
      : {}),
    title: get('journal-title'),
    body: get('journal-body'),
    occurredAt: journalTimeFromLocal(get('journal-time')),
    tags: get('journal-tags')
      .split(/[,，\r\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    links,
    snapshotMode: get('journal-snapshot') || (entryId ? 'keep' : 'none'),
  };
}
export function readJournalDraft(form) {
  const values = new FormData(form);
  const get = (name) => String(values.get(name) || '');
  return {
    type: 'journal-draft-put',
    id: form.dataset.draftId,
    revision: Number(form.dataset.draftRevision),
    profileId: form.dataset.profileId,
    ...(form.dataset.entryId
      ? {
          entryId: form.dataset.entryId,
          entryUpdatedAt: form.dataset.entryUpdatedAt,
          ...(form.dataset.entrySnapshot ? { entrySnapshot: JSON.parse(form.dataset.entrySnapshot) } : {}),
        }
      : {}),
    title: get('journal-title'),
    body: get('journal-body'),
    localTime: get('journal-time'),
    tags: get('journal-tags'),
    links: get('journal-links')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(':');
        return { type: line.slice(0, at), id: line.slice(at + 1) };
      }),
    snapshotMode: get('journal-snapshot') || (form.dataset.entryId ? 'keep' : 'none'),
  };
}

export function createEventJournalViews({
  esc,
  act,
  icon,
  pill,
  notice,
  empty,
  when,
  getIndex = () => ({}),
}) {
  function link(link, readOnly, profile, index, sources) {
    const title = referenceLabel(link, profile, index, sources);
    if (readOnly) return `<span class="pill">${esc(title)}${link.detached ? ' · 原关联已移除' : ''}</span>`;
    return link.detached
      ? `<span class="pill" title="原对象已移除，保留记录时的名称与编号">${esc(title)} · 原关联已移除</span>`
      : act('journal-link', esc(title), 'text-btn', `${link.type}:${link.id}`, 'arrow');
  }
  function snapshot(entry, complete = false) {
    const ref = entry.snapshot;
    if (!ref) return '';
    return `<details><summary>记录时附加的只读存档参照</summary><p class="small">${esc(ref.name)} · ${when(ref.modifiedAt)}${ref.mapName ? ' · ' + esc(ref.mapName) : ''}${ref.playSeconds !== undefined ? ' · 游玩 ' + Math.floor(ref.playSeconds / 3600) + ' 时 ' + Math.floor((ref.playSeconds % 3600) / 60) + ' 分' : ''}</p><p class="small mono">SHA-256 ${esc(ref.hash)}</p>${complete ? `<p class="small mono">摘要原修改时间 ${esc(ref.modifiedAt)}${ref.playSeconds !== undefined ? `<br>原游玩秒数 ${esc(ref.playSeconds)}` : ''}</p>` : ''}<p class="save-note">这份摘要用于回顾当时的已保存进度；没有存读档操作。</p></details>`;
  }
  function card(entry, readOnly, profile, index, sources) {
    const action = (name) => (readOnly ? 'historical-' : '') + name;
    return `<article class="card mb" id="journal-entry-${esc(entry.id)}" data-journal-id="${esc(entry.id)}"><div class="row between"><div>${pill(JOURNAL_KIND_LABELS[entry.kind] || '记录')}<h2>${act(action('journal-entry-open'), esc(entry.title), 'text-btn', entry.id, 'book')}</h2></div><time datetime="${esc(entry.occurredAt)}">${when(entry.occurredAt)}</time></div><p class="preserve-text">${esc(entry.body.length > 240 ? entry.body.slice(0, 240) + '…' : entry.body)}</p><div class="tag-row">${entry.tags.map((tag) => act(action('journal-tag-filter'), esc(tag), 'chip', tag)).join('')}${entry.links.map((item) => link(item, readOnly, profile, index, sources)).join('')}</div>${act(action('journal-entry-open'), '打开原记录', 'text-btn', entry.id, 'arrow')}</article>`;
  }
  function page(profile, view = {}, index = {}) {
    const readOnly = view.readOnly === true,
      prefix = readOnly ? 'historical-' : '';
    const action = (name) => prefix + name;
    const result = queryJournalEntries(profile, view, index);
    const sources = tables(profile, index);
    const tags = [...new Set((profile.journalEntries || []).flatMap((entry) => entry.tags))].sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
    const tagOptions = tags
      .map((tag) => `<option value="${esc(tag)}" ${view.tag === tag ? 'selected' : ''}>${esc(tag)}</option>`)
      .join('');
    const kinds = Object.entries(JOURNAL_KIND_LABELS)
      .map(
        ([value, label]) =>
          `<option value="${value}" ${view.kind === value ? 'selected' : ''}>${esc(label)}</option>`,
      )
      .join('');
    const controls = `<section class="card mb"><form id="${prefix}journal-filter-form" class="stack"><label>找记录、人物、地点或标签<input id="${prefix}journal-search" name="journal-query" data-persist="${prefix}journal-search" maxlength="200" value="${esc(view.query || '')}" placeholder="例如：上官虹 梧桐村" type="search"></label><div class="row wrap"><label>开始日期<input id="${prefix}journal-from" name="journal-from" type="date" value="${esc(view.from || '')}"></label><label>结束日期<input id="${prefix}journal-to" name="journal-to" type="date" value="${esc(view.to || '')}"></label><label>记录类型<select id="${prefix}journal-kind" name="journal-kind"><option value="">全部类型</option>${kinds}</select></label><label>标签<select id="${prefix}journal-tag" name="journal-tag"><option value="">全部标签</option>${tagOptions}</select></label>${act(action('journal-filter'), '查找记录', 'btn', '', 'search')}${act(action('journal-filter-clear'), '清除筛选', 'text-btn')}</div></form><p class="save-note">事件时间按本机时间显示与筛选；按事件发生时间倒序排列。完成记录表示你在手札中的操作，游戏状态需另行核对。</p></section>`;
    const pager = `<nav class="row between" aria-label="记录分页"><span class="small muted">找到 ${result.total} 条 · 第 ${result.page} / ${result.pages} 页 · 每页 ${JOURNAL_PAGE_SIZE} 条</span><div class="row">${result.page > 1 ? act(action('journal-page'), '上一页', 'btn', String(result.page - 1), 'arrow') : ''}${result.page < result.pages ? act(action('journal-page'), '下一页', 'btn', String(result.page + 1), 'arrow') : ''}</div></nav>`;
    return `<div class="page-header"><div><div class="eyebrow">ONE EVENT, ONE RECORD</div><h1 class="serif">${readOnly ? '历史江湖记录' : '江湖记录'}</h1><p>${readOnly ? esc(profile.name) + ' · 只读回顾，当前手札保持原样。' : '记下这一程遇到的人、走过的地方和自己的决定。'}</p></div><div class="row wrap">${readOnly ? pill('只读历史', 'green') : act('journal-export', '导出手札备份', 'btn', '', 'download') + act('journal-entry-new', '写一条记录', 'btn primary', '', 'plus')}</div></div>${view.globalQuery ? `<section class="card mb">${notice('来自全局查询：' + view.globalQuery, true)}${act(action('journal-filter-clear'), '清除全局查询，查看全部记录', 'text-btn')}</section>` : ''}${act(action('journal-trash-open'), '已删除记录 · ' + (profile.journalTrash?.length || 0), 'btn mb', '', 'archive')}${act(action('journal-revisions-open'), '记录旧版本 · ' + (profile.journalRevisions?.length || 0), 'btn mb', '', 'archive')}${controls}${!readOnly && result.total > 0 && !result.error ? `<section class="card mb"><div class="row between"><p class="save-note">选中的记录会移入已删除记录，可以逐条恢复；目标、待办与赠礼处理状态保留。</p>${act('journal-remove-filtered', '删除筛选出的记录…', 'btn danger', '', 'trash')}</div></section>` : ''}${result.error ? notice(result.error, true) : pager + (result.entries.map((entry) => card(entry, readOnly, profile, index, sources)).join('') || empty('没有找到记录', '写下第一件事，或调整筛选条件。')) + pager}${!readOnly && profile.noteRevisions?.length ? act('note-history', '找回随手记旧内容 · ' + profile.noteRevisions.length, 'btn mt', '', 'archive') : ''}${readOnly && profile.noteRevisions?.length ? `<details class="card mt" data-historical-note-revisions><summary>随手记旧内容 · ${profile.noteRevisions.length} 份 · 只读</summary>${profile.noteRevisions.map((row) => `<details class="detail-block"><summary>${when(row.replacedAt)} · ${esc(row.body.slice(0, 80))}</summary><p class="preserve-text">${esc(row.body)}</p></details>`).join('')}</details>` : ''}${profile.notes ? `<details class="card mt"><summary>整段江湖随手记</summary><p class="save-note">原笔记保留在这里，不会自动拆分成事件。</p><p class="preserve-text">${esc(profile.notes)}</p></details>` : ''}`;
  }
  function trash(profile, view = {}, index = {}) {
    const readOnly = view.readOnly === true,
      prefix = readOnly ? 'historical-' : '';
    const rows = profile.journalTrash || [];
    const matched = new Set(
      queryJournalEntries(
        { ...profile, journalEntries: rows.map((row) => row.entry) },
        { query: view.trashQuery || '' },
        index,
      ).matchedIds,
    );
    const filtered = rows
      .filter((row) => matched.has(row.entry.id))
      .slice()
      .sort(
        (a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || a.entry.id.localeCompare(b.entry.id),
      );
    const pages = Math.max(1, Math.ceil(filtered.length / JOURNAL_PAGE_SIZE)),
      requested = Number(view.trashPage),
      page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
    const selected = filtered.slice((page - 1) * JOURNAL_PAGE_SIZE, page * JOURNAL_PAGE_SIZE);
    const pager = `<nav class="row wrap mb" aria-label="已删除记录分页"><span class="small muted">${filtered.length} 条 · 第 ${page} / ${pages} 页</span>${page > 1 ? act(prefix + 'journal-trash-page', '上一页', 'btn', String(page - 1)) : ''}${page < pages ? act(prefix + 'journal-trash-page', '下一页', 'btn', String(page + 1)) : ''}</nav>`;
    return `<div class="page-header"><div><h1 class="serif">${readOnly ? '历史已删除记录' : '已删除记录'}</h1><p>${readOnly ? '保护包中的只读记录，当前手札保持原样。' : '误删的记录保留在这里，可以逐条恢复。不会自动过期或清空。'}</p></div>${act(prefix + 'journal-trash-close', '返回江湖记录', 'btn')}</div><section class="card mb"><label>查找已删除记录<input id="${prefix}journal-trash-query" data-persist="${prefix}journal-trash-query" class="input" type="search" maxlength="200" value="${esc(view.trashQuery || '')}" placeholder="标题、正文、人物、地点或标签"></label><p class="save-note">按移除时间排列。恢复只找回原记录，不撤回目标完成或更改行程、物品、游戏存档。${readOnly ? '' : '最多保留 5000 条；永久清除需另行确认。'}</p></section>${pager}${selected.map((row) => `<article class="card mb" data-journal-trash-id="${esc(row.entry.id)}"><div class="row between"><h2>${act(prefix + 'journal-trash-detail', esc(row.entry.title), 'text-btn', row.entry.id, 'book')}</h2>${pill(JOURNAL_KIND_LABELS[row.entry.kind])}</div><p class="preserve-text">${esc(row.entry.body.length > 240 ? row.entry.body.slice(0, 240) + '…' : row.entry.body)}</p><p class="small muted">移除 ${when(row.deletedAt)} · 事件 ${when(row.entry.occurredAt)}</p><div class="tag-row">${row.entry.tags.map((tag) => pill(tag)).join('')}</div><div class="row wrap">${act(prefix + 'journal-trash-detail', '查看完整记录', 'btn', row.entry.id)}${readOnly ? '' : act('journal-trash-restore-preview', '恢复这条记录', 'btn soft', row.entry.id, 'refresh') + act('journal-trash-purge-preview', '永久清除…', 'text-btn', row.entry.id, 'trash')}</div></article>`).join('') || empty(rows.length ? '没有匹配的已删除记录' : '没有已删除记录', rows.length ? '调整关键词即可查看其他记录。' : '以后误删的记录会保留在这里。')}${pager}`;
  }
  function detail(profile, entryId, view = {}, index = getIndex()) {
    const readOnly = view.readOnly === true;
    const deleted = view.trash ? profile.journalTrash?.find((row) => row.entry.id === entryId) : null;
    const entry = view.trash
      ? deleted?.entry
      : (profile.journalEntries || []).find((row) => row.id === entryId);
    if (!entry) return notice('这条记录已不存在，请返回列表刷新。', true);
    const sources = tables(profile, index);
    return `<section class="drawer" role="dialog" aria-modal="true" aria-label="${esc(entry.title)}"><div class="drawer-head"><span class="small muted">江湖记录 / ${view.trash ? '已删除记录' : '原记录'}</span>${act('close-overlay', '关闭详情', 'text-btn')}</div><div class="drawer-body" data-journal-id="${esc(entry.id)}">${pill(JOURNAL_KIND_LABELS[entry.kind])}<h1>${esc(entry.title)}</h1>${deleted ? `<p class="small muted">移除 ${when(deleted.deletedAt)}</p>` : ''}<p class="small">事件时间 ${when(entry.occurredAt)}</p><p class="preserve-text">${esc(entry.body)}</p><div class="tag-row">${entry.tags.map((tag) => pill(tag)).join('')}${entry.links.map((item) => link(item, readOnly, profile, index, sources)).join('')}</div>${snapshot(entry)}<p class="small muted">写入 ${when(entry.createdAt)} · 更新 ${when(entry.updatedAt)}</p><p class="small mono">记录编号 ${esc(entry.id)}</p>${entry.kind !== 'manual' ? notice('这是你在手札中的完成或重开操作记录；游戏任务、物品和赠礼状态仍需另行核对。', true) : ''}${view.trash ? '<p class="save-note">这是已删除记录，完整正文与关联保留。</p>' : readOnly ? '<p class="save-note">来自离线档案的只读记录；个人关联保留当时名称，当前周目不受影响。</p>' : '<p class="save-note">移入已删除记录后可逐条恢复；原目标、待办与赠礼处理状态保留。</p>'}</div><div class="drawer-actions">${!readOnly && entry.kind === 'manual' ? act('journal-entry-edit', '编辑记录', 'btn primary', entry.id, 'edit') : ''}${entry.kind === 'manual' ? act((view.historical || (readOnly && !view.trash) ? 'historical-' : '') + 'journal-revisions-entry', '查看这条记录的旧版本 · ' + (profile.journalRevisions || []).filter((row) => row.entry.id === entry.id && row.entry.createdAt === entry.createdAt).length, 'btn', entry.id, 'archive') : ''}${readOnly ? '' : act('journal-entry-remove', '删除这条历史记录', 'btn danger', entry.id, 'trash')}</div></section>`;
  }
  function revisionContent(row) {
    const entry = row.entry;
    return `<div data-journal-revision-id="${esc(row.id)}">${pill('手写记录旧版本')}<h2>${esc(entry.title)}</h2><p class="preserve-text">${esc(entry.body)}</p><div class="tag-row">${entry.tags.map((tag) => pill(tag)).join('')}</div><div class="stack">${entry.links.map((item) => `<p class="small">${esc(LINK_LABELS[item.type])} · ${esc(item.label)} · ${esc(item.id)}${item.detached ? ' · 原关联已移除' : ''}</p>`).join('')}</div>${snapshot(entry, true)}<p class="small">事件时间 ${when(entry.occurredAt)} <span class="mono">${esc(entry.occurredAt)}</span></p><p class="small muted">原创建 ${when(entry.createdAt)} · 原更新 ${when(entry.updatedAt)} · 保留旧版 ${when(row.replacedAt)}</p><p class="small mono">原创建 ${esc(entry.createdAt)}<br>原更新 ${esc(entry.updatedAt)}<br>保留旧版 ${esc(row.replacedAt)}<br>原记录编号 ${esc(entry.id)}<br>旧版本编号 ${esc(row.id)}</p></div>`;
  }
  function revisions(profile, view = {}) {
    const readOnly = view.readOnly === true,
      prefix = readOnly ? 'historical-' : '';
    const tokens = lower(view.revisionQuery || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const rows = (profile.journalRevisions || [])
      .filter(
        (row) =>
          (!view.revisionEntryId || row.entry.id === view.revisionEntryId) &&
          tokens.every((token) =>
            lower(
              [
                row.entry.title,
                row.entry.body,
                ...row.entry.tags,
                ...row.entry.links.map((link) => link.label + ' ' + link.id),
                row.entry.snapshot?.name,
                row.entry.snapshot?.mapName,
              ].join(' '),
            ).includes(token),
          ),
      )
      .slice()
      .sort((a, b) => Date.parse(b.replacedAt) - Date.parse(a.replacedAt) || a.id.localeCompare(b.id));
    const pages = Math.max(1, Math.ceil(rows.length / JOURNAL_PAGE_SIZE));
    const requested = Number(view.revisionPage);
    const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
    const pager = `<nav class="row wrap mb" aria-label="记录旧版本分页"><span class="small muted">${rows.length} 份 · 第 ${page} / ${pages} 页</span>${page > 1 ? act(prefix + 'journal-revisions-page', '上一页', 'btn', String(page - 1)) : ''}${page < pages ? act(prefix + 'journal-revisions-page', '下一页', 'btn', String(page + 1)) : ''}</nav>`;
    return `<div class="page-header"><div><h1 class="serif">${readOnly ? '历史记录旧版本' : '记录旧版本'}</h1><p>${readOnly ? '保护包中的完整旧正文，只读回顾。' : '编辑正式手写记录前，会完整保留原版本。可选择旧版本另存为一条新记录。'}</p></div>${act(prefix + 'journal-revisions-close', '返回江湖记录', 'btn')}</div><section class="card mb"><label class="field"><span>查找旧版本</span><input class="input" id="${prefix}journal-revision-query" data-persist="${prefix}journal-revision-query" type="search" maxlength="200" value="${esc(view.revisionQuery || '')}" placeholder="标题、正文、标签或关联"></label>${view.revisionEntryId ? act(prefix + 'journal-revisions-open', '查看全部记录的旧版本', 'text-btn') : ''}<p class="save-note">${readOnly ? '当前记录与游戏存档保持原样。' : '不会自动过期。每个周目最多 5000 份或 8 MiB，满时保留原记录和草稿并拒绝编辑。永久清除需另行确认。'}</p></section>${pager}${
      rows
        .slice((page - 1) * JOURNAL_PAGE_SIZE, page * JOURNAL_PAGE_SIZE)
        .map(
          (row) =>
            `<article class="card mb" data-journal-revision-row="${esc(row.id)}"><h2>${esc(row.entry.title)}</h2><p class="preserve-text">${esc(row.entry.body.length > 240 ? row.entry.body.slice(0, 240) + '…' : row.entry.body)}</p><p class="small muted">保留旧版 ${when(row.replacedAt)} · 原更新 ${when(row.entry.updatedAt)}</p><div class="row wrap">${act(prefix + 'journal-revision-detail', '查看完整旧版本', 'btn', row.id)}${readOnly ? '' : act('journal-revision-restore-preview', '另存为新记录…', 'btn soft', row.id, 'plus') + act('journal-revision-purge-preview', '永久清除旧版本…', 'text-btn', row.id, 'trash')}</div></article>`,
        )
        .join('') ||
      empty(
        '没有匹配的旧版本',
        view.revisionEntryId
          ? '这条手写记录尚无保留的编辑前版本。'
          : '编辑正式手写记录后，旧版本会保留在这里。',
      )
    }${pager}`;
  }
  function revisionDetail(profile, id, readOnly = false) {
    const row = profile.journalRevisions?.find((item) => item.id === id);
    if (!row) return notice('旧版本已不存在，请重新打开。', true);
    return `<section class="drawer" role="dialog" aria-modal="true" aria-label="记录旧版本完整预览"><div class="drawer-head"><h2>记录旧版本 · 只读预览</h2>${act('close-overlay', '关闭预览', 'text-btn')}</div><div class="drawer-body">${revisionContent(row)}<p class="save-note">原记录、后来的内容与游戏存档保留。</p></div><div class="drawer-actions">${readOnly ? pill('只读历史') : act('journal-revision-restore-preview', '另存为新记录…', 'btn primary', row.id, 'plus')}</div></section>`;
  }
  function referenceResults(profile, index, query, requestedPage = 1) {
    const choices = matchingJournalReferences(profile, index, query);
    if (!choices.length)
      return `<p class="small muted">${query.trim() ? '没有匹配的资料，请换个名称或备忘内容再找。' : '输入人物、地点、任务或个人目标的名称或备忘内容，选择要关联的资料。'}</p>`;
    const pages = Math.ceil(choices.length / JOURNAL_PAGE_SIZE);
    const page = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(requestedPage, pages)) : 1;
    return (
      `<nav class="row wrap" aria-label="关联资料分页"><span class="small muted" tabindex="-1" data-reference-page-heading>找到 ${choices.length} 项 · 第 ${page} / ${pages} 页 · 每页 ${JOURNAL_PAGE_SIZE} 项</span>${page > 1 ? act('journal-reference-page', '上一页', 'text-btn', String(page - 1)) : ''}${page < pages ? act('journal-reference-page', '下一页', 'text-btn', String(page + 1)) : ''}</nav>` +
      choices
        .slice((page - 1) * JOURNAL_PAGE_SIZE, page * JOURNAL_PAGE_SIZE)
        .map(
          (choice) =>
            `<div class="row between journal-reference-choice"><span class="spacer">${esc(LINK_LABELS[choice.type])} · ${esc(choice.label)}${choice.detail ? `<small class="preserve-text muted">${esc(choice.detail)}</small>` : ''}</span><button type="button" class="text-btn" data-action="journal-reference-add" data-id="${esc(choice.type + ':' + choice.id)}" aria-label="${esc('关联 ' + LINK_LABELS[choice.type] + ' · ' + choice.label + (choice.detail ? ' · ' + choice.detail : ''))}">${icon('plus')}关联</button></div>`,
        )
        .join('')
    );
  }
  function selectedReferences(profile, index, ids, entry) {
    const sources = tables(profile, index);
    return (
      ids
        .map((key) => {
          const at = key.indexOf(':'),
            type = key.slice(0, at),
            id = key.slice(at + 1);
          const original = entry?.links?.find((link) => link.type === type && link.id === id);
          const current = original?.detached ? null : byId(sources[type], id);
          const rawTitle =
            original?.label || (current ? rowLabel(type, current, profile, index, sources) : '原关联资料');
          const title = referenceLabel(
            { type, id, label: rawTitle, detached: original?.detached },
            profile,
            index,
            sources,
          );
          const memo =
            current && ['goal', 'todo', 'gift', 'craft-plan'].includes(type)
              ? current.detail || current.note || ''
              : '';
          const context = memo ? '当前备忘：' + memo : '';
          return `<div class="row between journal-reference-chip"><span><small>${esc(LINK_LABELS[type] || '资料')}</small> · ${esc(title)}${original?.detached ? ' · 原关联已移除' : ''}${context ? `<small class="preserve-text muted">${esc(context)}</small>` : ''}</span><button type="button" class="text-btn" data-action="journal-reference-remove" data-id="${esc(key)}" aria-label="${esc('移除 ' + (LINK_LABELS[type] || '资料') + ' · ' + title + (original?.detached ? ' · 原关联已移除' : '') + (context ? ' · ' + context : ''))}">移除</button></div>`;
        })
        .join('') || '<p class="small muted">尚未关联资料</p>'
    );
  }
  function editor(profile, entry, index = {}, view = {}) {
    if (entry && entry.kind !== 'manual') return notice('用户状态事件不能作为手写记录编辑。', true);
    const draft = view.draft;
    const originalId = draft?.entryId || entry?.id;
    const value = draft || entry || {};
    const links = value.links || [];
    const mode = draft?.snapshotMode || (originalId ? 'keep' : 'none');
    const time = draft
      ? draft.localTime
      : journalLocalTime(entry?.occurredAt || view.now || new Date().toISOString());
    return `<form id="journal-entry-form" class="stack" data-profile-id="${esc(profile.id)}" data-draft-id="${esc(draft?.id || view.draftId || '')}" data-draft-revision="${draft?.revision || 0}" ${draft && !draft.pending ? 'data-draft-persisted="true"' : ''} ${originalId ? `data-entry-id="${esc(originalId)}" data-entry-updated-at="${esc(draft?.entryUpdatedAt || entry.updatedAt)}" ${draft && !draft.entrySnapshot ? '' : `data-entry-snapshot="${esc(JSON.stringify(draft?.entrySnapshot || entry))}"`}` : ''}><p id="journal-draft-status" class="save-note" role="status">${draft?.pending ? '这份草稿尚未成功保存，当前窗口仍保留编辑。' : draft ? '已找回本机草稿，可以继续写。' : '输入后会自动暂存到本机；点击保存记录后才成为正式记录。'}</p><label>标题<input name="journal-title" id="journal-title" maxlength="160" required value="${esc(value.title || '')}"></label><label>事件发生时间<input name="journal-time" id="journal-time" type="datetime-local" step="0.001" required value="${esc(time)}"></label><label>记录正文<textarea name="journal-body" id="journal-body" maxlength="4000" rows="7">\n${esc(value.body || '')}</textarea></label><label>标签<input name="journal-tags" id="journal-tags" maxlength="310" value="${esc(draft ? draft.tags : (entry?.tags || []).join('，'))}" placeholder="最多 10 个，以逗号分隔，每个最多 30 字"></label><div class="detail-block"><label>查找要关联的资料<input id="journal-reference-query" type="search" maxlength="100" value="${esc(view.referenceQuery || '')}" placeholder="例如：卫霍、梧桐村、我的锻造目标"></label><div id="journal-reference-results">${referenceResults(profile, index, view.referenceQuery || '')}</div><div class="journal-selected"><span class="small muted">已关联资料</span><div id="journal-selected-references">${selectedReferences(
      profile,
      index,
      links.map((link) => link.type + ':' + link.id),
      value,
    )}</div></div><textarea id="journal-links" name="journal-links" hidden>${esc(links.map((link) => link.type + ':' + link.id).join('\n'))}</textarea><p class="save-note">最多关联 8 项，记录中保留当时的名称。使用右侧移除按钮可以调整关联。</p></div><label>存档参照<select id="journal-snapshot" name="journal-snapshot">${originalId ? `<option value="keep"${mode === 'keep' ? ' selected' : ''}>保留原来的参照</option>` : ''}<option value="none"${mode === 'none' ? ' selected' : ''}>不附加存档摘要</option><option value="selected"${mode === 'selected' ? ' selected' : ''}>保存记录时附加当前已选存档的只读摘要</option></select></label><p class="save-note">附加摘要便于以后回顾当时的已保存进度，不会改变游戏存档。</p></form>`;
  }
  function editDialog(profile, entry, index = {}, view = {}) {
    return `<section class="drawer" role="dialog" aria-modal="true" aria-label="${entry || view.draft?.entryId ? '编辑江湖记录' : '写一条江湖记录'}"><div class="drawer-head"><h2>${view.draft ? '继续写记录草稿' : entry ? '编辑江湖记录' : '写一条江湖记录'}</h2>${act('close-overlay', '暂存并关闭', 'text-btn')}</div><div class="drawer-body">${editor(profile, entry, index, view)}</div><div class="drawer-actions">${act('journal-entry-save', '保存记录', 'btn primary', entry?.id || '', 'check')}${act('journal-draft-copy', '另存为新草稿', 'btn')}${act('journal-draft-discard', '放弃草稿…', 'text-btn', view.draft?.id || view.draftId || '')}</div></section>`;
  }
  return {
    page,
    detail,
    editor,
    editDialog,
    referenceResults,
    selectedReferences,
    readForm: readJournalForm,
    readDraft: readJournalDraft,
    drafts: (rows, readOnly = false) =>
      rows.length
        ? `<section class="card mb" aria-label="未完成的记录草稿"><h2>继续写记录 · ${rows.length} 份草稿</h2><p class="save-note">草稿单独保留，不计入正式记录。关闭窗口或查资料后仍可回来继续写。</p>${rows.map((draft) => `<article class="detail-block" data-journal-draft-id="${esc(draft.id)}"><h3>${esc(draft.title || '未命名草稿')}${draft.entryId ? ' · 原记录的编辑草稿' : ''}</h3><p class="preserve-text">${esc((draft.body || '').slice(0, 160))}</p><p class="small muted">${draft.pending ? '尚未成功保存，当前窗口仍保留编辑' : '已暂存在本机 · ' + when(draft.updatedAt)}</p>${readOnly ? '<span class="small muted">历史草稿，只读</span>' : act('journal-draft-resume', '继续写', 'btn primary', draft.id, 'edit') + act('journal-draft-discard', '放弃这份草稿…', 'text-btn', draft.id)}</article>`).join('')}</section>`
        : '',
    query: queryJournalEntries,
    trash,
    revisions,
    revisionDetail,
    revisionContent,
  };
}
