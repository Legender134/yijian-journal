export function createJourneyViews({
  esc,
  act,
  pill,
  icon,
  notice,
  empty,
  when,
  draftValue = (id, fallback) => fallback,
}) {
  const navigation = (n, label) =>
    ['world-quest', 'world-place', 'database-detail', 'journey-goal', 'journey-todo'].includes(n.action)
      ? act(n.action, esc(label || '查看资料'), 'text-btn', n.id, 'arrow')
      : '';
  const statuses = {
    pending: '待处理',
    unavailable: '需要核对',
    skipped: '仅本次跳过',
    'game-complete': '参照中游戏已完成',
    'user-done': '个人已完成',
    handled: '个人已处理',
    prepared: '参照中材料已齐',
  };
  function home(plan) {
    const trip = plan.itinerary;
    const header = `<div class="card-header"><h2>${icon('map')} 这一程做什么</h2>${act('navigate', '查看行动与地点', 'text-btn', 'journey', 'arrow')}</div>`;
    if (trip?.steps.length) {
      const next = trip.next;
      const status =
        trip.status === 'active' ? '进行中' : trip.status === 'ended' ? '已结束' : '已选好，待开始';
      const body =
        trip.status === 'ended'
          ? `<p class="small muted">这一程已结束。个人已处理 ${trip.summary.handled} 项 · 个人已完成 ${trip.summary['user-done']} 项 · 本次跳过 ${trip.summary.skipped} 项 · 仍待处理或核对 ${trip.summary.remaining} 项。</p>${act('navigate', '查看这一程回顾', 'btn soft', 'journey', 'book')}`
          : next
            ? `<div class="detail-block" data-home-itinerary-next="${esc(next.actionId)}"><div class="row between"><h3>${trip.status === 'active' ? '下一项' : '选定的第一项'} · ${esc(next.title)}</h3>${pill(statuses[next.status], next.needsReview ? '' : 'green')}</div><p class="small muted">${next.selectedPlace ? esc(next.selectedPlace.name) + ' · 场景 #' + esc(next.selectedPlace.id.slice(6)) : '未分组事项'} · ${esc(next.reason)}</p><div class="row wrap">${next.action ? act('journey-focus', '查看步骤与来源', 'text-btn', next.actionId, 'arrow') : act('navigate', '核对原选择', 'btn soft', 'journey', 'arrow')}${trip.status === 'active' && next.status === 'pending' ? act('journey-itinerary-handle', next.action?.craftPlanId ? '仅个人已处理 · 不释放用料' : '标为个人已处理', 'btn soft', next.actionId, 'check') : ''}${trip.status === 'active' ? act('journey-itinerary-skip', '仅本次跳过', 'text-btn', next.actionId) : ''}</div></div>`
            : `<p class="small muted">本次已无待处理项，可以结束回顾；原选择仍保留供撤回与核对。</p>${act('journey-itinerary-status', '结束并回顾', 'btn soft', 'ended')}`;
      return `<section class="card mb home-journey" data-home-itinerary>${header}<div class="row between wrap"><h3>${esc(trip.name)}</h3>${pill(status)}</div><p class="small muted">依你选定的顺序 · 还剩 ${trip.summary.remaining} 项</p>${body}${trip.status === 'draft' ? act('journey-itinerary-status', '开始这一程', 'btn primary', 'active') : ''}</section>`;
    }
    const actions = plan.actions
      .filter((a) => !a.gameComplete && !a.userDone && !a.handled && !a.prepared)
      .slice(0, 3);
    return `<section class="card mb home-journey">${header}${actions.length ? actions.map((a) => `<div class="world-rule"><span>${act('journey-focus', esc(a.title), 'text-btn', a.id)}</span><small>${esc(a.progress?.label || '待处理')}</small></div>`).join('') : '<p class="small muted">当前没有待处理行动。图鉴中的目标、备料清单和个人打算会汇集在这里。</p>'}</section>`;
  }
  const planCompletion = (step) => {
    const id = step.action?.craftPlanId || step.craftPlanId;
    return id
      ? act(
          'craft-plan-complete',
          step.status === 'user-done' ? '重新打开制作计划' : '完成整份制作计划…',
          'btn soft',
          id,
          'check',
        )
      : '';
  };
  function placeChoice(a, index, selected, mode, owner = '') {
    const places = [...new Set(a.places.flatMap((p) => p.mapIds))];
    if (!places.length) return '<span class="small muted">尚无地点线索，作为未分组事项保留</span>';
    const maps = index.world?.maps || index.maps || [];
    const label = (id) =>
      `${maps.find((p) => p.id === id)?.name || a.places.find((p) => p.mapIds.includes(id))?.name || '资料场景'} · 场景 #${id.slice(6)}`;
    const fieldId = 'itinerary-' + mode + '-' + (owner ? owner + '-' : '') + a.id;
    selected = draftValue(fieldId, selected);
    return `<label class="small" for="${esc(fieldId)}">${mode === 'add' ? '本次去的场景' : '选定场景'}</label><select class="input" id="${esc(fieldId)}" data-itinerary-place data-itinerary-draft aria-label="${esc(a.title)}的本次场景">${places.length > 1 && !selected ? '<option value="">请选择确切场景</option>' : ''}${selected && !places.includes(selected) ? `<option value="${esc(selected)}" selected>原选择 · ${esc(label(selected))}，需重新核对</option>` : ''}${places.map((id) => `<option value="${esc(id)}"${(selected || (places.length === 1 ? places[0] : '')) === id ? ' selected' : ''}>${esc(label(id))}</option>`).join('')}</select>`;
  }
  function itinerary(plan, index) {
    const trip = plan.itinerary;
    if (!trip?.steps.length)
      return `<section class="card mb" data-itinerary><h2>挑选本次要做的事</h2><p class="small muted">从下面的全部行动选几项，再按你的顺序开始。小窗会接着显示下一项，关窗重启仍能继续。</p></section>`;
    const current = trip.next;
    const continuationChoice = (step) =>
      step.continuation?.kind === 'choice-required'
        ? `<details open data-persist-detail="itinerary-continue-${esc(step.actionId)}"><summary>选择当前步骤与本次场景</summary>${step.continuation.candidates
            .map((candidate) => {
              const action = plan.actions.find((a) => a.id === candidate.actionId);
              return action
                ? `<div class="detail-block" data-itinerary-choice data-itinerary-continuation><strong>${esc(action.title)}</strong><p class="small muted">同一任务的进行中步骤 · 原选择「${esc(step.selectedTitle)}」与顺序保留</p>${placeChoice(action, index, candidate.placeIds.includes(step.selectedPlace?.id) ? step.selectedPlace.id : '', 'continue', step.actionId)}<button class="btn soft" data-action="journey-itinerary-continue" data-id="${esc(step.actionId)}" data-target-id="${esc(candidate.actionId)}">接着办这个步骤</button>${navigation({ action: 'world-quest', id: action.questId }, '先看任务资料')}</div>`
                : '';
            })
            .join('')}</details>`
        : '';
    const next = current
      ? `<div class="detail-block" data-itinerary-next="${esc(current.actionId)}"><div class="row between"><h3>下一项 · ${esc(current.title)}</h3>${pill(statuses[current.status], current.needsReview ? '' : 'green')}</div><p class="small">${current.selectedPlace ? esc(current.selectedPlace.name) + ' · 场景 #' + esc(current.selectedPlace.id.slice(6)) : '未分组事项'}</p><p class="small muted">${esc(current.reason)}</p><div class="row wrap">${current.action ? act('journey-focus', '查看步骤与来源', 'text-btn', current.actionId, 'arrow') : ''}${planCompletion(current)}${current.status === 'pending' ? act('journey-itinerary-handle', current.action?.craftPlanId ? '仅个人已处理 · 不释放用料' : '标为个人已处理', 'btn soft', current.actionId, 'check') : ''}${act('journey-itinerary-skip', '仅本次跳过', 'text-btn', current.actionId)}</div></div>`
      : '<p class="small muted">本次已无待处理项，可以结束回顾；原选择仍保留供撤回与核对。</p>';
    const row = (step) =>
      `<article class="detail-block" data-itinerary-step="${esc(step.actionId)}"><div class="row between"><strong>${step.position + 1}. ${esc(step.title)}</strong>${pill(statuses[step.status], step.pending ? '' : 'green')}</div><p class="small muted">${step.selectedPlace ? esc(step.selectedPlace.name) + ' · 场景 #' + esc(step.selectedPlace.id.slice(6)) : '未分组事项'} · ${esc(step.reason)}</p><div class="row wrap">${step.action ? act('journey-focus', '步骤与来源', 'text-btn', step.actionId) : ''}${step.position > 0 ? `<button class="text-btn" data-action="journey-itinerary-move" data-id="${esc(step.actionId)}" data-direction="up" aria-label="上移 ${esc(step.title)}">上移</button>` : ''}${step.position < trip.steps.length - 1 ? `<button class="text-btn" data-action="journey-itinerary-move" data-id="${esc(step.actionId)}" data-direction="down" aria-label="下移 ${esc(step.title)}">下移</button>` : ''}${act('journey-itinerary-remove', '移出本次', 'text-btn', step.actionId)}${planCompletion(step)}${step.handled ? act('journey-itinerary-handle', '撤回个人已处理', 'text-btn', step.actionId, 'refresh') : ''}${act('journey-itinerary-skip', step.skipped ? '撤回本次跳过' : '仅本次跳过', 'text-btn', step.actionId)}</div>${continuationChoice(step)}${step.action?.places.length ? `<details data-persist-detail="itinerary-place-${esc(step.actionId)}"><summary>更换本次场景</summary><div class="row wrap" data-itinerary-choice>${placeChoice(step.action, index, step.selectedPlace?.id, 'change')}${act('journey-itinerary-place', '保存场景', 'btn soft', step.actionId)}</div></details>` : ''}${!step.action ? `<details><summary>原选择的来源指针</summary>${step.selectionSources.map((s) => `<p class="small">${esc(s.type === 'user' ? '个人记录' : s.type === 'quest' ? '任务资料' : '图鉴资料')} · ${esc(s.id)} · ${esc(s.field)}${s.type === 'quest' ? navigation({ action: 'world-quest', id: s.id }, '查看原任务') : s.type === 'database' ? navigation({ action: 'database-detail', id: s.id }, '查看原资料') : ''}</p>`).join('')}</details>` : ''}</article>`;
    return `<section class="card mb" data-itinerary><div class="row between"><h2>${esc(trip.name)}</h2>${pill(trip.status === 'active' ? '进行中' : trip.status === 'ended' ? '已结束' : '已选好')}</div><p class="small muted">${esc(trip.notice)}</p><div class="row wrap">${act('journey-itinerary-status', trip.status === 'active' ? '暂存，下次继续' : trip.status === 'ended' ? '继续这一程' : '开始这一程', 'btn primary', trip.status === 'active' ? 'draft' : 'active')}${trip.status !== 'ended' ? act('journey-itinerary-status', '结束并回顾', 'btn', 'ended') : ''}${act('journey-itinerary-clear', '清空本次选择', 'text-btn')}</div>${next}${trip.status === 'ended' ? `<div class="detail-block" data-itinerary-recap><h3>这一程回顾</h3><p class="small">选定 ${trip.summary.total} 项 · 个人已处理 ${trip.summary.handled} 项 · 个人已完成 ${trip.summary['user-done']} 项 · 本次跳过 ${trip.summary.skipped} 项 · 仍待处理或核对 ${trip.summary.remaining} 项</p><p class="small muted">当前参照另有 ${trip.summary['game-complete']} 项游戏任务已完成、${trip.summary.prepared} 组材料已齐。统计随参照更新，不作为这一程新增的游戏进度。</p>${act('journey-itinerary-journal', '写入江湖记录', 'btn soft', '', 'feather')}</div>` : ''}<details data-persist-detail="itinerary-name"><summary>调整名称</summary><div class="row wrap"><input class="input" id="journey-itinerary-name" data-itinerary-draft maxlength="80" value="${esc(draftValue('journey-itinerary-name', trip.name))}" aria-label="本次行程名称">${act('journey-itinerary-name', '保存名称', 'btn soft')}</div></details><details open><summary>选定顺序与后续队列 · ${trip.steps.length} 项</summary>${trip.steps.map(row).join('')}</details></section>`;
  }
  function page(plan, view, index) {
    if (!plan) return notice('正在核对当前周目的行动与地点…', true);
    const pending = (a) => !a.gameComplete && !a.userDone && !a.handled && !a.prepared;
    const selected = view.place ? plan.routes.find((r) => r.id === view.place) : null;
    const actions = plan.actions.filter(
      (a) =>
        (view.completed || pending(a)) &&
        (!selected || selected.actionIds.includes(a.id)) &&
        (!view.query || `${a.title} ${a.detail}`.includes(view.query)),
    );
    const locations = `<section class="card journey-locations"><h2>按地点一起办</h2><p class="save-note">同一行动可能有多个地点线索，挑选适合当前剧情的一处即可；数量不会重复累加。</p>${act('journey-place-filter', '全部行动 · ' + plan.summary.pending + ' 件待处理', 'chip ' + (!selected ? 'active' : ''))}${
      plan.routes
        .filter((r) => view.completed || r.pendingCount > 0 || r.favorite)
        .map(
          (r) =>
            `<div class="journey-location"><button class="chip ${selected?.id === r.id ? 'active' : ''}" data-action="journey-place-filter" data-id="${esc(r.id)}">${r.favorite ? '★ ' : ''}${esc(r.name)} · ${r.pendingCount}</button><small>${r.ambiguous ? '多个资料场景，需核对阶段' : '资料线索或你的地点目标'}</small>${r.mapIds.length === 1 ? act('journey-place-dialog', r.favorite ? '编辑地点目标' : '记下这个地点', 'text-btn', r.mapIds[0], 'pin') : `<details><summary>选择资料场景</summary>${r.mapIds.map((id) => `<div>${navigation({ action: 'world-place', id }, '查看 ' + r.name + ' · #' + id.slice(6))}${act('journey-place-dialog', '记为地点目标', 'text-btn', id, 'pin')}</div>`).join('')}</details>`}</div>`,
        )
        .join('') || '<p class="small muted">有明确地点的任务、材料说明和个人待办会在这里合并。</p>'
    }</section>`;
    return `<div class="page-header"><div><div class="eyebrow">MAKE THE NEXT STEP CLEAR</div><h1 class="serif">这一程做什么</h1><p>把当前任务、备料和个人打算放在同一张行动清单里。</p></div><div class="row wrap">${act('journey-refresh', '重新核对', 'btn', '', 'refresh')}${act('journey-todo-dialog', '添加个人待办', 'btn primary', '', 'plus')}</div></div>${itinerary(plan, index)}<section class="card mb"><div class="journey-summary"><span><strong>${plan.summary.pending}</strong> 待处理</span><span>${plan.summary.gameComplete} 项游戏已完成</span><span>${plan.summary.userDone} 项个人已完成</span><span>${plan.summary.handled} 项手动处理</span><span>${plan.summary.prepared || 0} 组材料已备齐</span></div><p class="save-note">${plan.reference ? `对照 ${esc(plan.reference.name)} · ${when(plan.reference.modifiedAt)} · 已保存的进度` : '尚无匹配的存档参照，个人待办与资料线索仍可使用。'}</p>${plan.warnings.map((w) => notice(w.message, true)).join('')}<details><summary>这张清单怎样使用</summary><p class="save-note">${esc(plan.notice)}「标为已处理」只记你的行动，不把游戏任务改为完成，也不会消耗游戏物品。切换到旧档会重新核对游戏状态；手动处理可随时撤回。</p></details></section><div class="journey-layout">${locations}<section class="stack"><div class="toolbar"><label class="search-input"><input id="journey-search" data-persist="journey-search" value="${esc(view.query)}" maxlength="100" placeholder="找一项任务或打算" aria-label="筛选行动"></label><button class="chip ${view.completed ? 'active' : ''}" data-action="journey-show-completed">${view.completed ? '正在包含已完成、已处理与备齐项' : '包含已完成与已处理'}</button></div>${selected ? `<div class="row between"><h2>${esc(selected.name)} · ${actions.length} 项</h2>${act('journey-place-filter', '回到全部行动', 'text-btn')}</div>` : ''}${actions.map((a) => action(a, index, plan)).join('') || empty(selected ? '这个地点没有待处理行动' : '目前没有待处理行动', '可以添加个人待办、记下地点，或把图鉴和任务里的目标加入行囊。')}</section></div>`;
  }
  function processingInfo(action, index) {
    const step = action.processingStep;
    if (!step) return '';
    const itemName = (id) => index.entries.find((e) => e.id === 'item-' + id)?.name || '物品 #' + id;
    const recipeName = (id) => index.entries.find((e) => e.id === id)?.name || id;
    return `<details open><summary>加工这一步需要什么</summary>${step.materials.map((m) => `<div class="detail-block"><strong>${esc(m.name)} × ${m.count}</strong>${m.sources.map((s) => `<p class="small">${esc(itemName(s.id))} × ${s.count} · ${s.source === 'inventory' ? '已分配真实库存' : '预计来自先前加工 ' + esc(recipeName(s.recipeId))}</p>`).join('')}<p class="small muted">${m.missing === null ? '库存未核对' : '仍需补充的端点材料 ' + m.missing}</p></div>`).join('')}<p class="save-note">计划产物尚未制作。完成游戏制作并保存后，重新核对会改用实际背包记录。</p></details>`;
  }
  function recipeInfo(action, index) {
    const recipe = action.recipe;
    if (!recipe) return '';
    const groups = new Map();
    for (const result of recipe.results || []) {
      if (!groups.has(result.id)) groups.set(result.id, []);
      groups.get(result.id).push(result);
    }
    const outputs = [...groups]
      .map(([id, results]) => {
        const item = index.entries.find((entry) => entry.id === 'item-' + id);
        const counts = results.map((row) => row.count * recipe.quantity);
        const known =
          results.every((row) => Number.isSafeInteger(row.count) && row.count > 0) &&
          counts.every((count) => Number.isSafeInteger(count) && count > 0);
        const low = known ? Math.min(...counts) : null,
          high = known ? Math.max(...counts) : null;
        return `<p class="small" data-journey-craft-output="${esc(id)}">${groups.size === 1 ? '预计产物' : '可能产物'}：${navigation({ action: 'database-detail', id: 'item-' + id }, item?.name || results[0].name || '产物资料待核对')}${item?.quality ? ' · ' + esc(item.quality) + '色品质' : ''}${known ? ' × ' + low + (low === high ? '' : '–' + high) : ' · 数量待核对'}</p>`;
      })
      .join('');
    return `<section class="detail-block journey-craft-results"><p class="small">执行配方：${esc(recipe.name || index.entries.find((entry) => entry.id === action.recipeId)?.name || '原配方待核对')} · ${recipe.quantity} 次 · 资料等级 ${recipe.level} · 基础费 ${recipe.money} 文</p>${outputs || '<p class="small muted">产物资料待核对</p>'}<p class="save-note">${groups.size > 1 ? '这些是每次制作的候选结果，不表示同时得到全部物品或品质。' : ''}计划产物尚未进入背包；实际制作并保存后，重新核对库存与用途。</p></section>`;
  }
  function action(a, index, plan) {
    const closed = a.gameComplete || a.userDone || a.handled || a.prepared;
    const userId = a.sources.find((s) => s.type === 'user')?.id;
    const status = a.gameComplete
      ? '游戏已完成'
      : a.userDone
        ? '个人已完成'
        : a.handled
          ? '手动已处理'
          : a.progress?.label || '待处理';
    const material = a.material;
    const gift = a.gift;
    const chosen = plan.itinerary?.steps.some((s) => s.actionId === a.id);
    const selection = chosen
      ? '<p class="small muted">已选入本次行程，可在上方调整顺序或移出。</p>'
      : `<div class="row wrap" data-itinerary-choice>${placeChoice(a, index, null, 'add')}${act('journey-itinerary-add', '加入本次行程', 'btn soft', a.id, 'plus')}</div>`;
    const itemLink = (id) =>
      navigation(
        { action: 'database-detail', id: 'item-' + id },
        index.entries.find((e) => e.id === 'item-' + id)?.name || '物品 #' + id,
      );
    return `<article class="card journey-action ${closed ? 'journey-handled' : ''}" data-journey-id="${esc(a.id)}"><div class="row between"><h3>${esc(a.title)}</h3>${pill(status, closed ? 'green' : '')}</div>${selection}${a.ownerName ? `<p class="small muted">用于：${esc(a.ownerName)}</p>` : ''}${material ? `<p class="small">需 ${material.count} · ${material.allocationKnown ? '已分配 ' + material.allocation.reduce((sum, x) => sum + x.count, 0) + ' · 还缺 ' + material.missing : '可用库存待核对'}${material.alternatives ? ' · 可替代材料共用总量' : ''}</p>` : ''}${gift ? `<p class="small">${gift.allocationKnown ? '为这份赠礼已分配 ' + gift.allocated + ' · 还缺 ' + gift.missing : '赠礼的可用数量待核对'}</p>` : ''}<div class="row wrap">${a.navigation.map((n) => navigation(n, n.action === 'world-quest' ? '查看任务步骤' : n.action === 'world-place' ? '查看地点' : n.action.startsWith('journey-') ? '查看个人记录' : index.entries.find((e) => e.id === n.id)?.name || '查看资料')).join('')}${planCompletion({ action: a })}${!a.gameComplete && !a.userDone ? act('journey-handle', a.handled ? '恢复待处理' : a.craftPlanId ? '仅个人已处理 · 不释放用料' : '标为已处理', 'btn soft', a.id, a.handled ? 'refresh' : 'check') : ''}${a.kind === 'gift' && userId ? act('journey-gift-edit', '编辑赠礼意图', 'text-btn', userId, 'edit') : ''}${a.kind === 'todo' && userId ? act('journey-todo-dialog', '编辑待办', 'text-btn', userId, 'edit') : ''}</div><details class="journey-evidence"><summary>展开步骤、条件与来源${a.unknowns.length ? ' · 有待核对的信息' : ''}</summary>${a.detail ? `<p class="preserve-text">${esc(a.detail)}</p>` : ''}${(a.materials || []).map((m) => `<div class="world-rule"><span>${itemLink(m.id)} × ${m.count}</span><span>${m.allocationKnown ? '为本任务预留 ' + m.reserved + ' · 已分配 ' + m.allocated + ' · 需求还缺 ' + m.missing : m.onHand === null ? '持有量未知' : '存档持有 ' + m.onHand + ' · 可用量另核对'}</span></div>`).join('')}${a.questId && a.materials?.length ? act('navigate', '核对任务物资预留', 'btn', 'materials', 'shield') : ''}${recipeInfo(a, index)}${processingInfo(a, index)}${a.prerequisites.map((r) => `<div class="detail-block"><strong>${esc(r.label)}</strong>${r.observedProgress ? '<p class="small">关联任务在存档中：' + esc(r.observedProgress) + '</p>' : ''}${r.navigation ? navigation(r.navigation, '查看关联资料') : ''}<p class="save-note">${r.semantics === 'uninterpreted' ? '条件值为原始资料，尚未解释为当前解锁或执行条件。' : r.satisfied === null ? '当前是否满足待核对。' : r.satisfied ? '选定存档已记录。' : '选定存档尚未记录。'}</p></div>`).join('')}${material?.hints?.map((h) => `<div class="detail-block"><h4>${esc(h.name)}的获取线索</h4><p class="preserve-text small">${esc(h.description || '资料尚未列出获取说明')}</p>${(h.merchants || []).map((m) => (m.navigation ? navigation(m.navigation, '售卖资料：' + m.name) : '')).join('')}</div>`).join('') || ''}${a.unknowns.map((u) => `<p class="save-note">${icon('info')} ${esc(u.message)}</p>`).join('')}<details><summary>核对来源</summary>${a.sources.map((s) => (s.type === 'save' ? `<p class="small mono">存档 ${esc(s.name)} · ${when(s.modifiedAt)} · SHA ${esc(s.hash?.slice(0, 12) || '')}</p>` : `<p class="small">${s.type === 'user' ? '个人记录' : '资料 ' + esc(s.id || '')}${s.build ? ' · Build ' + esc(s.build) : ''}${s.excerpt ? '<br><span class="preserve-text">' + esc(s.excerpt) + '</span>' : ''}</p>`)).join('')}</details></details></article>`;
  }
  return { page, itinerary, home };
}
