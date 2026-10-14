// Partial personal arrangements remain separate from saved plans and inventory.
export const INTENT_KIND_LABELS = Object.freeze({
  'journey-place': '地点打算',
  'journey-todo': '个人待办',
  'journey-gift': '赠礼意图',
  goal: '行囊目标',
  'craft-plan': '制作计划',
  'itinerary-name': '行程名称',
  'itinerary-choice': '行程场景选择',
});
const fields = {
  'journey-place': [
    ['note', 'journey-note'],
    ['favorite', 'journey-favorite', true],
    ['done', 'journey-done', true],
  ],
  'journey-todo': [
    ['title', 'journey-title'],
    ['detail', 'journey-note'],
    ['placeId', 'journey-place'],
    ['done', 'journey-done', true],
    ['placeQuery', 'journey-place-search'],
  ],
  'journey-gift': [
    ['npcId', 'journey-person'],
    ['itemId', 'journey-item'],
    ['quantity', 'journey-quantity'],
    ['placeId', 'journey-place'],
    ['note', 'journey-note'],
    ['done', 'journey-done', true],
    ['personQuery', 'journey-person-search'],
    ['itemQuery', 'journey-item-search'],
    ['itemQuality', 'journey-item-quality'],
    ['preferredOnly', 'journey-item-preferred', true],
    ['stockOnly', 'journey-item-stock', true],
    ['placeQuery', 'journey-place-search'],
  ],
  goal: [
    ['title', 'goal-title'],
    ['detail', 'goal-detail'],
    ['quantity', 'goal-quantity'],
    ['placeId', 'journey-place'],
    ['placeQuery', 'journey-place-search'],
  ],
  'craft-plan': [
    ['name', 'craft-plan-name'],
    ['addGoal', 'craft-plan-goal', true],
    ['reserved', 'craft-plan-reserved', true],
  ],
  'itinerary-name': [['name', 'journey-itinerary-name']],
  'itinerary-choice': [['placeId', null]],
};
export function readIntentValues(kind, scope) {
  return Object.fromEntries(
    fields[kind]
      .filter(
        ([name, id]) =>
          kind !== 'goal' ||
          !['placeId', 'placeQuery', 'quantity'].includes(name) ||
          scope.querySelector('#' + id),
      )
      .map(([name, id, checked]) => {
        const field = id ? scope.querySelector('#' + id) : scope.querySelector('[data-itinerary-place]');
        return [name, checked ? !!field?.checked : field?.value || ''];
      }),
  );
}
export function writeIntentValues(kind, values, scope) {
  for (const [name, id, checked] of fields[kind]) {
    if (!Object.hasOwn(values, name)) continue;
    const field = id ? scope.querySelector('#' + id) : scope.querySelector('[data-itinerary-place]');
    if (field) {
      if (checked) field.checked = values[name];
      else {
        const value = values[name] ?? '';
        if (
          field.tagName === 'SELECT' &&
          value &&
          ![...field.options].some((option) => option.value === value)
        ) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = '原选择需重新核对';
          field.append(option);
        }
        field.value = value;
      }
    }
  }
}
// Identical target projection is validated again by the main-process draft core.
export function intentTarget(profile, kind, targetId, context = {}) {
  const journey = profile.journey || {};
  if (kind === 'journey-place') return journey.places?.find((row) => row.placeId === targetId) || null;
  if (kind === 'journey-todo') return journey.todos?.find((row) => row.id === targetId) || null;
  if (kind === 'journey-gift') return journey.gifts?.find((row) => row.id === targetId) || null;
  if (kind === 'goal') return profile.goals?.find((row) => row.id === targetId) || null;
  if (kind === 'craft-plan') return profile.craftPlans?.find((row) => row.id === targetId) || null;
  if (kind === 'itinerary-name') return journey.itinerary || null;
  if (kind === 'itinerary-choice')
    return {
      status: journey.itinerary?.status || 'draft',
      step: journey.itinerary?.steps.find((row) => row.actionId === targetId) || null,
    };
  throw Error('未识别的个人安排草稿');
}
export function createIntentDraftViews({ esc, act, when, placeLabel = (place) => place.name }) {
  const sourceRows = (index, id, kind) =>
    (kind === 'place' ? index.world?.maps : kind === 'quest' ? index.world?.quests : index.entries)?.filter(
      (item) => item.id === id,
    ) || [];
  const sourceName = (index, id, kind) => {
    const rows = sourceRows(index, id, kind);
    if (kind === 'place' && rows.length > 1) return '原地点（场景待核对）';
    const row = rows.length === 1 ? rows[0] : null;
    return row
      ? kind === 'place'
        ? placeLabel(row, index.world.maps)
        : row.name + (kind === 'item' && row.quality ? ' · ' + row.quality : '')
      : id
        ? '原选择需重新核对'
        : '尚未选择';
  };
  const sourceLink = (index, id, kind) => {
    const label = esc(sourceName(index, id, kind));
    return sourceRows(index, id, kind).length === 1 ? act('archive-entity', label, 'text-btn', id) : label;
  };
  function sourceDetail(source, index) {
    if (source?.type === 'database') return sourceLink(index, source.id, 'database');
    if (source?.type === 'quest') return sourceLink(index, source.id, 'quest');
    return '';
  }
  function title(row, index = {}) {
    const value = row.values;
    if (row.kind === 'journey-place') return sourceName(index, row.targetId, 'place');
    if (row.kind === 'journey-gift')
      return sourceName(index, value.npcId, 'person') + ' · ' + sourceName(index, value.itemId, 'item');
    if (row.kind === 'itinerary-choice') return row.context.label || '还未提交的场景选择';
    return value.title || value.name || '还未填写名称';
  }
  function titleHtml(row, index) {
    if (row.kind === 'journey-place') return sourceLink(index, row.targetId, 'place');
    if (row.kind === 'journey-gift')
      return (
        sourceLink(index, row.values.npcId, 'person') + ' · ' + sourceLink(index, row.values.itemId, 'item')
      );
    return esc(title(row, index));
  }
  function detail(row, index = {}, original = null, sourceLabel = '当前目标资料') {
    const value = row.values;
    const status =
      row.kind === 'journey-place'
        ? `<p>${value.favorite ? '拟设为关注地点' : '拟取消地点关注'} · ${value.done ? '拟标为已完成' : '拟保留为未完成'}</p>`
        : row.kind === 'journey-todo'
          ? `<p>${value.done ? '拟标为已完成' : '拟保留为未完成'}</p>`
          : '';
    const originalSource = row.kind === 'goal' ? sourceDetail(original?.source, index) : '';
    return `<div class="detail-block"><h3>${titleHtml(row, index)}</h3><p class="small muted">${esc(INTENT_KIND_LABELS[row.kind])} · ${when(row.updatedAt || row.createdAt)}</p>${status}${value.placeId ? `<p>${sourceLink(index, value.placeId, 'place')}</p>` : ''}${originalSource ? `<p class="small muted">${esc(sourceLabel)}：${originalSource}</p>` : ''}${row.kind === 'goal' && Object.hasOwn(value, 'quantity') ? `<p>收集数量：${esc(value.quantity || '尚未填写')} 件 · 正式保存后更新原目标</p>` : ''}${row.kind === 'journey-gift' ? `<p>件数：${esc(value.quantity || '尚未填写')} · ${value.done ? '拟标为已完成' : '拟保留为未完成'}</p>` : ''}${
      row.kind === 'craft-plan'
        ? `<p>${value.addGoal ? '拟加入行囊目标' : '拟仅保存计划'} · ${value.reserved ? '正式保存后保留材料' : '正式保存后暂不保留材料'}</p>${row.context.list.map((line) => `<p class="small">${sourceLink(index, line.id, 'recipe')} × ${esc(line.quantity)}</p>`).join('')}${Object.entries(
            row.context.choices,
          )
            .map(
              ([id, recipeId]) =>
                `<p class="small">加工 ${sourceLink(index, 'item-' + id, 'item')}：${sourceLink(index, recipeId, 'recipe')}</p>`,
            )
            .join('')}`
        : ''
    }<p class="preserve-text">${esc(value.note || value.detail || '')}</p><p class="save-note">这是尚未提交的编辑；没有改变当前安排、物资预留或游戏进度。</p></div>`;
  }
  function panel(rows, index = {}, readOnly = false, profileId = '', originalProfile = null) {
    if (!rows.length) return '';
    return `<details class="card mt intent-draft-panel" data-persist-detail="intent-drafts" open><summary>继续未完成的安排 · ${rows.length} 份草稿</summary><p class="save-note">${readOnly ? '以前暂存的个人编辑，只读回顾。' : '输入会自动暂存，正式保存后才加入安排；关闭或重启后仍可继续。'}</p>${rows
      .map((row) => {
        const source =
          row.kind === 'goal'
            ? sourceDetail(originalProfile?.goals?.find((goal) => goal.id === row.targetId)?.source, index)
            : '';
        return `<article class="detail-block" data-intent-draft-id="${esc(row.id)}"><span class="small muted">${esc(INTENT_KIND_LABELS[row.kind])}${row.pending ? ' · 尚未成功暂存' : ''}</span><h3>${titleHtml(row, index)}</h3>${row.values.placeId ? `<p class="small">${sourceLink(index, row.values.placeId, 'place')}</p>` : ''}${source ? `<p class="small muted">${readOnly ? '档案中的目标资料' : '当前目标资料'}：${source}</p>` : ''}<p class="preserve-text">${esc((row.values.note || row.values.detail || '').slice(0, 160))}</p><div class="row wrap">${readOnly ? act('historical-intent-draft-open', '查看暂存内容', 'btn', profileId + '|' + row.id) : act('intent-draft-resume', '继续编辑', 'btn primary', row.id) + act('intent-draft-recheck', '重新核对原安排…', 'text-btn', row.id) + act('intent-draft-discard', '放弃这份草稿…', 'text-btn', row.id)}</div></article>`;
      })
      .join('')}</details>`;
  }
  return { panel, title, detail };
}
