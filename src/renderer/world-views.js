import { placeChoiceLabel } from './place-picker.js';
import { createCodexDetailViews } from './codex-detail-views.js';
import { entityCatalog, placeEntityId } from './entity-catalog.js';
import { compileSearch } from './search-query.js';
import { taskMentions } from './task-mentions.js';
import { allObjectivePlaces, resolveTaskObjectives } from '../shared/task-objectives.mjs';
import { completionChecks } from '../shared/task-completion.mjs';
export function createWorldViews({
  esc,
  act,
  pill,
  notice,
  icon,
  iconButton,
  when,
  empty,
  picture,
  richText = esc,
  objectiveText = (value) => richText(value),
  variantSummary = () => '',
  taskRelations = () => '',
  placeMap = () => '',
}) {
  const codexDetails = createCodexDetailViews({ esc, act, richText });
  let cached, quests, people, maps, children, families;
  const labels = ['未开始', '进行中', '已失败', '未接取', '已完成'];
  function prepare(index) {
    if (cached === index) return;
    cached = index;
    quests = new Map(index.world.quests.map((q) => [q.gameId, q]));
    people = new Map(index.entries.filter((e) => e.kind === '人物').map((e) => [e.gameId, e]));
    maps = new Map(index.world.maps.map((m) => [m.key, m]));
    children = new Map();
    families = new Map();
    for (const q of quests.values()) {
      if (!children.has(q.parentId)) children.set(q.parentId, []);
      children.get(q.parentId).push(q);
    }
  }
  function family(q) {
    if (families.has(q.gameId)) return families.get(q.gameId);
    const result = [],
      seen = new Set(),
      queue = [q];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i];
      if (seen.has(next.gameId)) continue;
      seen.add(next.gameId);
      result.push(next);
      queue.push(...(children.get(next.gameId) || []));
    }
    families.set(q.gameId, result);
    return result;
  }
  const records = (view) => new Map((view.reference?.metadata.quests || []).map((q) => [q.id, q]));
  const isActiveQuest = (q, saved) =>
    entityCatalog(cached).isActiveQuest(q, (task) => labels[saved.get(task.gameId)?.step]);
  const status = (q, view) =>
    !Array.isArray(view.reference?.metadata.quests)
      ? '进度未知'
      : labels[records(view).get(q.gameId)?.step] || '未记录';
  const npc = (id, index) => {
    const name = people.get(id)?.name || index.world.npcNames?.[id] || '未收录人物';
    return people.has(id)
      ? act('database-detail', esc(name), 'text-btn', `npc-${id}`)
      : `<span class="pictured-label">${picture(`npc-${id}`)}<span>${esc(name)}</span></span>`;
  };
  const questLink = (q, cls = 'text-btn', label = q.name) =>
    act('world-quest', esc(label), cls, q.id, '', label === q.name ? '' : `${label} · ${q.name}`);
  const mapLink = (key) =>
    maps.has(key)
      ? act(
          'world-place',
          esc(maps.get(key).name),
          'text-btn',
          placeEntityId(maps.get(key), [...maps.values()]),
        )
      : esc(key);
  function referenceControls(view, files) {
    return view.loading ? '<p role="status">正在更新…</p>' : view.error ? notice(view.error) : '';
  }
  function page(index, view, files) {
    prepare(index);
    const q = view.query.trim().toLowerCase(),
      saved = records(view);
    const namedPlaces = index.world.maps.filter((p) => p.name === view.reference?.metadata?.mapName);
    const currentPlace =
      maps.get(view.reference?.metadata?.map) || (namedPlaces.length === 1 ? namedPlaces[0] : null);
    let match,
      searchError = '';
    try {
      match = compileSearch(q);
    } catch (error) {
      searchError = error.message;
      match = () => false;
    }
    const all =
      view.kind === 'places'
        ? index.world.maps
        : index.world.quests.filter((t) => !view.roots || !t.parentId);
    const filtered = all.filter((t) => {
      if (view.kind === 'places') return match({ ...t, kind: '地点' });
      const group = family(t);
      if (
        !group.some((c) =>
          match({
            ...c,
            kind: '任务',
            status: labels[saved.get(c.gameId)?.step] || '待核对',
            description:
              c.description +
              ' ' +
              [...c.requestNPCs, ...c.finishNPCs].map((id) => people.get(id)?.name || '').join(' '),
          }),
        )
      )
        return false;
      if (view.status === 'all') return true;
      if (!Array.isArray(view.reference?.metadata.quests)) return false;
      if (view.status === 'active') return group.some((c) => isActiveQuest(c, saved));
      if (view.status === 'completed') return saved.get(t.gameId)?.step === 4;
      if (view.status === 'recorded') return group.some((c) => saved.has(c.gameId));
      return group.every((c) => !saved.has(c.gameId));
    });
    const pageSize = 96;
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize)),
      current = Math.min(view.page, pages - 1);
    const cards = filtered
      .slice(current * pageSize, current * pageSize + pageSize)
      .map((t) => {
        if (view.kind === 'places') {
          const related = index.world.quests.filter((q) => q.placements.some((p) => p.mapKey === t.key));
          const detail = variantSummary(placeEntityId(t, index.world.maps), view.reference);
          return `<button class="database-card world-place-card" data-action="world-place" data-id="${esc(placeEntityId(t, index.world.maps))}"><span class="world-result-title">${icon('map')}<h3>${esc(t.name)}</h3>${t.cave ? pill('洞穴') : ''}</span>${detail || related.length ? `<p>${esc(detail || `${related.length} 条关联任务`)}</p>` : ''}</button>`;
        }
        const active = family(t).filter((c) => c !== t && isActiveQuest(c, saved));
        const state = status(t, view);
        return `<button class="database-card world-quest-card" data-action="world-quest" data-id="${t.id}" aria-label="${esc(t.name)}"><span class="world-result-title">${icon('scroll')}<h3>${esc(t.name.replace(/^【(?:主线|支线)】\s*/, ''))}</h3>${state === '未记录' ? '' : pill(state, saved.get(t.gameId)?.step === 4 ? 'green' : '')}</span><span class="small muted">${t.parentId ? '步骤' : t.kind === 'Primary' ? '主线' : '支线'}</span>${
          active.length
            ? `<p>进行中的步骤：${active
                .slice(0, 2)
                .map((c) => esc(c.name))
                .join('、')}</p>`
            : ''
        }</button>`;
      })
      .join('');
    return `<div class="segmented world-tabs">${[
      ['quests', '任务手册'],
      ['places', '地点地图'],
    ]
      .map(
        ([id, label]) =>
          `<button data-action="world-kind" data-id="${id}" class="${view.kind === id ? 'active' : ''}">${label}</button>`,
      )
      .join('')}</div>${referenceControls(view, files)}${
      view.kind === 'places' && !q
        ? placeMap(index, currentPlace ? placeEntityId(currentPlace, index.world.maps) : '', {
            scope: 'world',
            allowScopeChange: false,
          })
        : ''
    }<div class="toolbar"><label class="search-input"><input id="world-search" data-persist="world-search" value="${esc(view.query)}" maxlength="100" aria-label="搜索任务与地点"${searchError ? ' aria-invalid="true" aria-describedby="world-search-error"' : ''} placeholder="${view.kind === 'places' ? '搜索地点名称' : '搜索任务、人物或描述'}"></label>${
      view.kind === 'quests'
        ? `<select id="world-status" aria-label="任务记录筛选">${[
            ['all', '所有资料'],
            ['active', '含进行中的记录'],
            ['completed', '任务记录已完成'],
            ['recorded', '存档中有记录'],
            ['unrecorded', '未记录'],
          ]
            .map(
              ([id, label]) =>
                `<option value="${id}" ${view.status === id ? 'selected' : ''}>${label}</option>`,
            )
            .join(
              '',
            )}</select><select id="world-scope" aria-label="任务显示范围"><option value="roots" ${view.roots ? 'selected' : ''}>主任务</option><option value="all" ${!view.roots ? 'selected' : ''}>任务与步骤</option></select>`
        : ''
    }${pill(searchError ? '搜索条件待修改' : `${filtered.length} 项`)}</div>${searchError ? `<div id="world-search-error" role="alert">${notice(searchError, true)}</div>` : cards ? `${view.kind === 'places' && !view.query.trim() ? `<details data-persist-detail="world-places-list"><summary>地点列表 · ${filtered.length}</summary>` : ''}<div class="database-grid world-result-grid">${cards}</div>${pages > 1 ? `<div class="pagination">${current > 0 ? act('world-page', '上一页', 'btn', String(current - 1)) : ''}<span>${current + 1} / ${pages}</span>${current < pages - 1 ? act('world-page', '下一页', 'btn', String(current + 1)) : ''}</div>` : ''}${view.kind === 'places' && !view.query.trim() ? '</details>' : ''}` : empty('没有匹配的线索', view.status !== 'all' && !view.reference ? '先选择可读存档，或切换为所有资料。' : '调整搜索、记录筛选或显示范围。')}`;
  }
  function requirementRows(list, index, view) {
    prepare(index);
    const saved = records(view);
    return (
      list
        .map((r) => {
          if (r.type === 'ItemMax') {
            const item = index.entries.find((entry) => entry.id === `item-${r.id}`);
            const target = item
              ? act('database-detail', esc(item.name), 'text-btn', item.id)
              : esc(r.name || '未收录物品');
            const check = completionChecks(
              [{ ...r, name: item?.name || r.name || '未收录物品' }],
              view.reference?.metadata,
            )[0];
            const quantity = r.value === 1 ? '未持有' : `数量少于 ${Number(r.value).toLocaleString('zh-CN')}`;
            return `<div class="world-rule"><span class="small muted">物品要求</span><span>${target} · ${esc(quantity)}</span>${view.reference ? pill(check.status === 'met' ? '已满足' : check.status === 'unmet' ? '未满足' : '未确认', check.status === 'met' ? 'green' : check.status === 'unmet' ? 'orange' : '') : ''}</div>`;
          }
          if (r.type === 'Money' || r.type === 'TeamMember') {
            const check = completionChecks(
              [{ ...r, ...(r.type === 'Money' ? { comparison: 'gt' } : {}) }],
              view.reference?.metadata,
            )[0];
            return `<div class="world-rule"><span>${richText(check.text)}</span>${view.reference ? pill(check.status === 'met' ? '已满足' : check.status === 'unmet' ? '未满足' : '未确认', check.status === 'met' ? 'green' : check.status === 'unmet' ? 'orange' : '') : ''}</div>`;
          }
          const q = quests.get(r.id),
            relatedQuest = q || quests.get(r.relatedQuestId),
            person = people.get(r.id);
          const link =
            r.type === 'PreQuest' || r.type === 'NoQuest'
              ? relatedQuest
                ? questLink(relatedQuest, 'text-btn', q ? relatedQuest.name : r.name)
                : esc(r.name)
              : r.type === 'Item'
                ? act('database-detail', esc(r.name), 'text-btn', `item-${r.id}`)
                : person
                  ? npc(r.id, index)
                  : esc(r.name);
          const label =
            {
              PreQuest: '前置任务',
              NoQuest: '任务排除条件',
              Money: '铜钱要求',
              Friendliness: '好感要求',
              FriendlinessUp: '好感条件（Up）',
              TeamMember: '队伍条件',
              Item: '物品要求',
            }[r.type] || '资料条件';
          const value =
            r.type === 'PreQuest'
              ? labels[r.value] || String(r.value)
              : r.type === 'NoQuest'
                ? ''
                : String(r.value);
          return `<div class="world-rule"><span class="small muted">${label}</span><span>${link}${value ? ` · ${esc(value)}` : ''}</span>${q && (saved.has(q.gameId) || view.reference?.origin === 'live') ? pill(`${view.reference?.origin === 'live' ? '现场' : '存档'}：${labels[saved.get(q.gameId)?.step ?? 0]}`) : ''}</div>`;
        })
        .join('') || '<p class="small muted">未收录条件</p>'
    );
  }
  function completionDetails(index, task, view, saved) {
    const checks = (
      resolveTaskObjectives(index.world.objectives?.[task.id], view.reference?.metadata)?.completionChecks ||
      []
    ).filter((row) => row.type !== 'Item');
    if (!checks.length) return '';
    const current = saved.get(task.gameId)?.step === 1 && isActiveQuest(task, saved);
    return `<details class="detail-block" data-quest-completion data-persist-detail="quest-completion-${esc(task.id)}"><summary>完成条件</summary>${checks
      .map((row) => {
        const related = row.entityId && index.world.quests.find((quest) => quest.id === row.entityId);
        const label =
          related && row.text.startsWith(row.name)
            ? questLink(related, 'text-btn', row.name) + esc(row.text.slice(row.name.length))
            : richText(row.text);
        return `<div class="row between mt"><span>${label}</span>${current ? pill(row.progress ? `${row.progress.current} / ${row.progress.total}` : row.status === 'met' ? '已满足' : row.status === 'unmet' ? '未满足' : '未确认', row.status === 'met' ? 'green' : row.status === 'unmet' ? 'orange' : '') : ''}</div>${row.alternatives?.length ? `<div class="related-items mt">${row.alternatives.map((item) => act('database-detail', esc(item.name + (item.quality ? ' · ' + item.quality : '')), 'text-btn', 'item-' + item.id) + (current && item.owned !== null ? pill('持有 ' + item.owned) : '')).join('')}</div>` : ''}`;
      })
      .join('')}</details>`;
  }
  function questDetail(index, id, view, showText, reservations = {}) {
    prepare(index);
    const q = index.world.quests.find((q) => q.id === id);
    if (!q) return '';
    const saved = records(view),
      group = family(q),
      parent = quests.get(q.parentId),
      active = group.filter((c) => c.gameId !== q.gameId && isActiveQuest(c, saved));
    const inventory = Array.isArray(view.reference?.metadata.inventory)
      ? new Map(view.reference.metadata.inventory.map((i) => [i.id, i.count]))
      : null;
    const targetNames = (ids) => ids.map((id) => npc(id, index)).join('、');
    const text = `<p class="preserve-text">${richText(q.description || '资料没有提供任务说明。')}</p>`;
    return `<section class="drawer world-drawer" role="dialog" aria-modal="true" aria-label="任务资料"><div class="drawer-head"><span class="small muted">任务手册</span>${iconButton('close-overlay', 'close', '关闭任务资料')}</div><div class="drawer-body"><div class="tag-row">${pill(q.parentId ? '任务步骤' : q.kind === 'Primary' ? '主线' : '支线')}${pill(status(q, view))}</div><div class="game-detail-title">${picture(q.id, 'detail')}<h1>${esc(q.name.replace(/^【[^】]+】\s*/, ''))}</h1></div>${view.error ? notice(view.error) : ''}${
      active.length
        ? `<section class="detail-block codex-active-steps"><h3>当前步骤</h3>${active
            .map((c) => `<p>${questLink(c)}</p>`)
            .join('')}</section>`
        : ''
    }${completionDetails(index, q, view, saved)}${parent ? `<div class="detail-block"><h3>所属任务</h3>${questLink(parent)}</div>` : ''}<details class="detail-block" ${showText ? 'open' : ''}><summary>任务说明 · 可能涉及剧情</summary>${text}</details>${q.requestNPCs?.length || q.finishNPCs?.length ? `<div class="detail-block"><h3>交互人物</h3>${q.requestNPCs?.length ? `<p>接取：${targetNames(q.requestNPCs)}</p>` : ''}${q.finishNPCs?.length ? `<p>完成：${targetNames(q.finishNPCs)}</p>` : ''}</div>` : ''}${codexDetails.quest(index, q, view.reference)}${taskRelations(index, q, view.reference)}${mentionLinks(index, q, showText)}${q.materials?.length ? `<div class="detail-block"><h3>任务所需物品</h3>${q.materials.map((m) => `<div class="material-row"><span>${act('database-detail', esc(m.name), 'text-btn', `item-${m.id}`)}</span><strong>需 ${m.count}</strong>${inventory ? pill(`库存 ${inventory.get(m.id) || 0} · 缺 ${Math.max(0, m.count - (inventory.get(m.id) || 0))}`, (inventory.get(m.id) || 0) >= m.count ? 'green' : 'orange') : pill('库存未读取')}${act('world-reserve-material', (reservations[m.id] || 0) >= m.count ? `已预留 ${reservations[m.id]} 件` : `为任务预留 ${m.count} 件`, 'btn', `${q.id}:${m.id}`)}</div>`).join('')}<p class="save-note">任务完成后自动释放预留。</p></div>` : ''}${q.requirements.length ? `<details class="detail-block"><summary>接取条件</summary>${requirementRows(q.requirements, index, view)}</details>` : ''}${q.placements.length ? `<details class="detail-block"><summary>关联地点</summary>${q.placements.map((p) => `<div class="world-rule"><span>${mapLink(p.mapKey)}</span><span>${npc(p.npcId, index)}${p.inHouse ? ' · 室内' : ''}</span><small class="muted">${p.interactionTarget ? '对应交互人物' : '任务事件中的场景布置'}</small></div>`).join('')}</details>` : ''}${
      group.length > 1
        ? `<details class="detail-block" data-persist-detail="quest-steps-${esc(q.id)}"><summary>相关步骤 · ${group.length - 1}</summary><div class="world-steps">${group
            .filter((c) => c !== q)
            .map(
              (c) =>
                `<div class="world-step">${questLink(c)}${pill(status(c, view), saved.get(c.gameId)?.step === 4 ? 'green' : '')}</div>`,
            )
            .join('')}</div></details>`
        : ''
    }</div><div class="drawer-actions">${act('world-quest-goal', '把任务记入待办', 'btn primary', q.id, 'plus')}${act('world-back-to-list', '回任务手册', 'btn', q.id)}</div></section>`;
  }
  function mentionLinks(index, task, showText) {
    const mentions = taskMentions(index, task);
    const places = [...mentions.places, ...mentions.aliases];
    if (!mentions.people.length && !places.length) return '';
    return `<details class="detail-block task-mentions" ${showText ? 'open' : ''}><summary>相关人物与地点${showText ? '' : ' · 可能涉及剧情'}</summary><p class="save-note">从任务说明中的名字匹配资料，方便继续查询；不代表当前所在地，也不确认接取条件已满足。</p><div class="row">${[
      ...new Set(mentions.people.map((p) => p.name)),
    ]
      .map((name) => {
        const rows = mentions.people.filter((p) => p.name === name);
        return rows.length > 1
          ? act('entity-choice', esc(name), 'text-btn', 'name:' + name, 'person')
          : act('database-detail', esc(name), 'text-btn', rows[0].id, 'person');
      })
      .join(
        '',
      )}</div>${places.map((group) => `<details><summary>${esc(group.mention)}${group.mention !== group.name ? ' · 相关资料名称：' + esc(group.name) : ''}${group.choices.length > 1 ? ' · ' + group.choices.length + ' 个场景' : ''}</summary>${group.choices.map((place) => act('world-place', esc(placeChoiceLabel(place, index.world.maps)), 'text-btn', placeEntityId(place, index.world.maps), 'map')).join('')}</details>`).join('')}</details>`;
  }
  function placeDetail(index, id, view) {
    prepare(index);
    const candidates = index.world.maps.filter((m) => placeEntityId(m, index.world.maps) === id);
    const place = candidates.length === 1 ? candidates[0] : null;
    if (!place) return '';
    const objectives = index.world.quests.filter((q) =>
      allObjectivePlaces(index.world.objectives?.[q.id]).some((target) => target.mapKeys.includes(place.key)),
    );
    const related = index.world.quests.filter(
      (q) => q.placements.some((p) => p.mapKey === place.key) || objectives.includes(q),
    );
    const saved = records(view);
    const currentObjectives = new Map(
      objectives.map((q) => [
        q.id,
        resolveTaskObjectives(index.world.objectives[q.id], view.reference?.metadata),
      ]),
    );
    const active = objectives.filter(
      (q) =>
        entityCatalog(index).isCurrentQuestStep(q, (task) => labels[saved.get(task.gameId)?.step]) &&
        currentObjectives.get(q.id).places.some((target) => target.mapKeys.includes(place.key)),
    );
    const current = active.length
      ? `<section class="detail-block place-current-tasks" data-place-current-tasks><h2>进行中的任务</h2>${active
          .map((q) => {
            const objective = currentObjectives.get(q.id);
            const target = objective.places.find((target) => target.mapKeys.includes(place.key));
            let action = target.hint
              ? `<p>${objectiveText(target.hint, objective)}${target.conditionHint && !target.hint.includes(target.conditionHint) ? '；' + richText(target.conditionHint) : ''}</p>`
              : target.conditionHint && !q.name.includes(target.conditionHint)
                ? `<p>${richText(target.conditionHint)}</p>`
                : target.purpose === 'material-source'
                  ? `<p>备料线索：${(q.materials || [])
                      .filter((m) => target.materialIds.includes(m.id))
                      .map((m) => act('database-detail', esc(m.name), 'text-btn', 'item-' + m.id))
                      .join('、')}</p>`
                  : target.purpose === 'conditional-turn-in'
                    ? `<p>${target.conditionHint ? richText(target.conditionHint) : target.action === '交谈' ? '备齐材料后交谈' : '集齐材料后交付'}${target.mapKeys.length === 1 && target.personIds.length ? '：' + target.personIds.map((id) => npc(id, index)).join('、') : ''}</p>`
                    : target.mapKeys.length === 1 && target.personIds.length
                      ? `<p>${target.action || (target.purpose === 'turn-in' ? '交付' : '交互')}：${target.personIds.map((id) => npc(id, index)).join('、')}</p>`
                      : '';
            const nextAction = objective.nextAction || objective.instruction;
            if (
              !target.hint &&
              target.purpose !== 'material-source' &&
              target.purpose !== 'conditional-turn-in' &&
              nextAction
            ) {
              const missingActors =
                target.mapKeys.length === 1
                  ? target.personIds.filter((id) => {
                      const name = people.get(id)?.name || index.world.npcNames?.[id] || '';
                      return !name.split(/[-·]/).some((part) => part.length > 1 && nextAction.includes(part));
                    })
                  : [];
              const actors = missingActors.map((id) => npc(id, index)).join('、');
              const text = objectiveText(nextAction, objective);
              action = `<p>${actors && /^(?:交付|交还|上交)/.test(nextAction) ? '向' + actors + text : text + (actors ? ' · ' + actors : '')}</p>`;
            }
            const heading = action ? entityCatalog(index).root(q) : q;
            if (
              heading.name === nextAction &&
              !target.hint &&
              !target.personIds.length &&
              !target.conditionHint &&
              target.purpose === 'objective'
            )
              action = '';
            return `<div class="world-step" data-current-step="${esc(q.id)}">${questLink(q, 'text-btn', heading.name)}${action}${target.mapKeys.length > 1 ? '<span class="small muted">场景待确认</span>' : ''}</div>`;
          })
          .join('')}</section>`
      : '';
    const npcIds = [
      ...new Set(
        related
          .flatMap((q) => [
            ...q.placements.filter((p) => p.mapKey === place.key).map((p) => p.npcId),
            ...(objectives.includes(q)
              ? index.world.objectives[q.id].places
                  .filter((target) => target.mapKeys.length === 1 && target.mapKeys[0] === place.key)
                  .flatMap((target) => target.personIds)
              : []),
          ])
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ];
    return `<section class="drawer world-drawer" role="dialog" aria-modal="true" aria-label="地点资料"><div class="drawer-head"><span class="small muted">地点图鉴</span>${iconButton('close-overlay', 'close', '关闭地点资料')}</div><div class="drawer-body"><h1>${esc(place.name)}</h1>${current}${placeMap(index, id)}${placeEntityId(place, index.world.maps) === place.id ? act('journey-place-dialog', '记为地点目标', 'btn', place.id, 'pin') : ''}<details class="detail-block"><summary>任务相关人物 · ${npcIds.length}</summary><div class="related-items">${npcIds.map((id) => `<span>${npc(id, index)}</span>`).join('') || '<p class="small muted">暂无关联人物。</p>'}</div></details><details class="detail-block"><summary>关联任务与步骤 · ${related.length}</summary><div class="world-steps">${related.map((q) => `<div class="world-step">${questLink(q)}${pill(status(q, view))}</div>`).join('') || '<p class="small muted">暂无关联任务。</p>'}</div></details></div></section>`;
  }
  return { page, questDetail, placeDetail, requirementRows };
}
