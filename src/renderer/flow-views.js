export function createFlowViews({ esc, act, icon, pill, when }) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const text = (value) => esc(String(value ?? ''));
  function persist(html, scope) {
    let index = 0;
    return html.replace(
      /<details\b(?![^>]*data-persist-detail)/g,
      () => `<details data-persist-detail="flow-${text(scope)}-${index++}"`,
    );
  }
  const button = (action, label, id, cls = 'text-btn') => act(action, text(label), cls, String(id ?? ''));
  const questId = (value) => {
    const id = typeof value === 'number' ? `quest-${value}` : String(value ?? '');
    return /^quest-\d+$/.test(id) ? id : '';
  };
  const questButton = (value, label = '查看任务资料') => {
    const id = questId(value);
    return id ? button('flow-quest', label, id) : '';
  };
  const statusPill = (status) => {
    const labels = { met: '已核对满足', unmet: '尚未满足', unknown: '待核对' };
    return pill(labels[status] || '待核对', status === 'met' ? 'green' : status === 'unmet' ? 'orange' : '');
  };
  function conditions(rows) {
    const items = list(rows);
    return items.length
      ? `<ul class="flow-conditions">${items
          .map((row) => `<li><span>${text(row.text)}</span>${statusPill(row.status)}</li>`)
          .join('')}</ul>`
      : '';
  }
  function target(value, action, prefix) {
    if (!value) return '';
    if (typeof value === 'string') return text(value);
    const name = value.name || value.label || '';
    return new RegExp(`^${prefix}-\\d+$`).test(String(value.id || ''))
      ? button(action, name, value.id)
      : text(name);
  }
  function sources(rows) {
    const items = list(rows);
    return items.length
      ? `<div class="flow-sources"><h4>来源与参考版本</h4>${items
          .map(
            (source) =>
              `<p>${typeof source.id === 'string' && source.id ? button('source', source.title || '查看来源', source.id) : text(source.title || '来源待核对')}${source.date || source.version ? `<span class="small muted"> · ${[source.date, source.version].filter(Boolean).map(text).join(' · ')}</span>` : ''}</p>`,
          )
          .join('')}</div>`
      : '';
  }
  function recommendation(row) {
    const value = row.recommendation;
    if (!value?.action || !value.reason) return '';
    return `<div class="flow-recommendation"><p class="flow-recommended-action"><strong>推荐做法：</strong>${text(value.action)}</p><p><strong>为什么：</strong>${text(value.reason)}</p>${value.goal ? `<p class="small muted">适合：${text(value.goal)}</p>` : ''}${value.tradeoff ? `<p class="small"><strong>取舍：</strong>${text(value.tradeoff)}</p>` : ''}</div>`;
  }
  function advancement(row) {
    const affected = list(row.affectedTasks);
    if (!affected.length) return '';
    return `<div class="flow-affected" data-flow-affected><h4>推进后受影响的任务</h4><p class="small">触发：${text(row.deadlineLabel || row.triggerName || '见下列条件')}</p><ul>${affected.map((task) => `<li><strong>${questButton(task.questId, task.name) || text(task.name)}</strong>：${text(task.effect)}${task.evidence ? `<p class="small save-note">${text(task.evidence)}</p>` : ''}</li>`).join('')}</ul></div>`;
  }
  function rule(row, warning = false) {
    const choices = list(row.choices);
    const steps = list(row.steps);
    const conditionRows = list(row.conditions);
    const hasDetails = choices.length || steps.length || list(row.sources).length || row.uncertainty;
    const stateLabel = {
      done: '已完成',
      failed: '已失败',
      active: '进行中',
      'not-started': '存档记录尚未开始',
      'not-accepted': '存档记录未接取',
      unrecorded: '尚待核对',
      'conditions-partial': '部分条件满足 · 仍待核对',
      'conditions-match': '已读取的条件匹配',
    }[row.state];
    const pickup = row.pickup || {};
    const location = target(pickup.place, 'world-place', 'place');
    const person = target(pickup.person, 'database-detail', 'npc');
    const message = row.message || row.warning;
    const pickupBody =
      location || person || pickup.action
        ? `<div class="flow-pickup">${location || person ? `<p>${location ? `<span class="small muted">接取地点 </span>${location}` : ''}${location && person ? ' · ' : ''}${person ? `<span class="small muted">人物 </span>${person}` : ''}</p>` : ''}${pickup.action ? `<p><span class="small muted">怎么接 </span>${text(pickup.action)}</p>` : ''}${pickup.executionPlace ? `<p class="small"><span class="muted">接取后的目的地线索 </span>${text(pickup.executionPlace)}</p>` : ''}</div>`
        : '';
    return persist(
      `<article class="flow-rule${warning ? ' flow-risk' : ''}" data-flow-rule="${text(row.id || '')}"${warning ? ` data-flow-warning="${text(row.id || row.questId || '')}"` : ''}><div class="row between"><h3>${text(row.name || row.title || '任务线索')}</h3>${stateLabel ? pill(stateLabel, row.state === 'done' ? 'green' : row.state === 'failed' ? 'orange' : '') : ''}</div>${row.done || row.failed ? `<p class="small save-note">存档已记录${row.done ? '完成' : '失败'}；以下攻略供回顾，不表示全部分支均已经历。</p>` : ''}${message ? `<p class="flow-warning-message">${text(message)}</p>` : ''}${advancement(row)}${recommendation(row)}${row.deadlineReached && !row.done && !row.failed ? '<p class="small flow-warning-message">已到资料提示的推进边界，请先核对任务状态与来源。</p>' : ''}${warning ? '' : pickupBody + conditions(conditionRows) + questButton(row.questId || row.id)}${hasDetails ? `<details class="flow-rule-details"><summary>${warning ? '接取位置、选择影响与来源' : '查看步骤、选择影响与来源'}</summary>${warning ? pickupBody + conditions(conditionRows) + questButton(row.questId || row.id) : ''}${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${steps.length ? `<ol class="flow-guide-steps">${steps.map((step) => `<li>${text(step)}</li>`).join('')}</ol>` : ''}${choices.length ? `<div class="flow-choices"><h4>选择与各自影响 · 涉及剧情</h4><dl>${choices.map((choice) => `<dt>${text(choice.label)}</dt><dd>${text(choice.effect || '影响尚待核对')}</dd>`).join('')}</dl></div>` : ''}${sources(row.sources)}</details>` : ''}</article>`,
      'rule-' + row.id,
    );
  }
  const routeName = (route) =>
    route.label ||
    {
      purchase: '购买',
      merchant: '商人购买',
      gather: '采集',
      gathering: '采集',
      drop: '掉落',
      craft: '加工制作',
      recipe: '加工制作',
    }[route.kind] ||
    '获取线索';
  const placeEvidence = (value) =>
    ({
      'description-mention': '任务说明中的地点线索',
      'literal-mention': '任务说明中的地点线索',
      'scene-placement': '场景布置线索',
      'interaction-target': '交互人物的场景线索',
    })[value] ||
    (typeof value === 'string' && /[\u3400-\u9fff]/.test(value) ? value : '资料线索，当前位置待核对');
  function materials(rows) {
    const routeList = (routes) =>
      `<ul>${routes.map((route) => `<li><strong>${text(routeName(route))}</strong>${route.detail ? `<p>${text(route.detail)}</p>` : ''}<p class="small muted">${text(route.efficiency || '效率尚待核实')}</p>${route.personId ? button('database-detail', '查看商人资料', route.personId) : ''}${route.placeId ? button('world-place', '查看地点资料', route.placeId) : ''}${sources(route.sources)}</li>`).join('')}</ul>`;
    const items = list(rows);
    return items.length
      ? `<div class="flow-materials"><h4>${icon('bag')} 这一步需要的材料</h4>${items
          .map((material) => {
            const owned = Number.isFinite(material.owned) ? material.owned : null;
            const missing = Number.isFinite(material.missing) ? material.missing : null;
            const routes = list(material.routes);
            const primary = routes.filter((route) => !route.alternative);
            const alternatives = routes.filter((route) => route.alternative);
            return `<div class="flow-material"><div class="row between">${/^item-\d+$/.test(String(material.id || '')) ? button('database-detail', material.name, material.id) : text(material.name)}<span>需 ${text(material.required)}${owned === null ? ' · 库存待核对' : ` · 持有 ${text(owned)}`}${missing === null ? '' : missing > 0 ? ` · 缺 ${text(missing)}` : ' · 持有量已足'}</span></div>${routes.length ? `<details><summary>在哪里获得、效率如何</summary>${routeList(primary)}${alternatives.length ? `<details class="flow-material-alternatives"><summary>其他商人线索 · ${alternatives.length} 处 · 可达与库存待核对</summary>${routeList(alternatives)}</details>` : ''}</details>` : '<p class="small muted">暂未整理获取路线，可打开物品资料继续查找。</p>'}</div>`;
          })
          .join(
            '',
          )}<p class="small save-note">持有量来自已保存进度；交付前仍需核对其他任务的留用数量。来源线索不保证当前可达或有货。</p></div>`
      : '';
  }
  function step(row, rootId) {
    const people = list(row.people);
    const places = list(row.places);
    const upcoming = list(row.upcoming);
    return persist(
      `<div class="flow-step">${row.id === rootId || row.name === row.nextAction ? '' : `<h4>${text(row.name || '当前步骤')}</h4>`}<p class="flow-next-action"><span class="small muted">当前行动 </span>${text(row.nextAction || row.description || '请打开任务资料，核对当前要求。')}</p>${row.description && row.description !== row.nextAction ? `<details><summary>任务说明 · 可能涉及剧情</summary><p class="preserve-text">${text(row.description)}</p></details>` : ''}${people.length ? `<div class="flow-people">${people.map((person) => `<span>${person.role ? `<span class="small muted">${text(person.role)} </span>` : ''}${target(person, 'database-detail', 'npc')}</span>`).join(' · ')}</div>` : ''}${places.length ? `<div class="flow-places">${places.map((place) => `<p><span class="small muted">地点线索 </span>${target(place, 'world-place', 'place')}${place.evidence ? `<span class="small muted"> · ${text(placeEvidence(place.evidence))}</span>` : ''}</p>`).join('')}</div>` : ''}${conditions(row.requirements)}${materials(row.materials)}${upcoming.length ? `<details class="flow-upcoming"><summary>后续相关步骤与分支 · 涉及剧情</summary><ul>${upcoming.map((next) => `<li>${questButton(next.id, next.name) || text(next.name)}${next.reason ? `<p class="small muted">${text(next.reason)}</p>` : ''}</li>`).join('')}</ul><p class="small save-note">相关步骤只作核对线索，不代表已解锁或确定执行顺序。</p></details>` : ''}${row.id === rootId ? '' : questButton(row.id)}</div>`,
      'step-' + row.id,
    );
  }
  function decision(row) {
    return persist(
      `<aside class="flow-decision" data-flow-decision="${text(row.id)}"><h4>当前步骤有关键选择 · ${text(row.name)}</h4>${recommendation(row)}<p>${text(row.warning || row.name)}</p><dl class="flow-choices">${list(
        row.choices,
      )
        .map((choice) => `<dt>${text(choice.label)}</dt><dd>${text(choice.effect || '影响待核对')}</dd>`)
        .join(
          '',
        )}</dl><details><summary>参考版本、来源与待核对之处</summary>${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${sources(row.sources)}</details></aside>`,
      'decision-' + row.id,
    );
  }
  function activeTask(task) {
    const steps = list(task.steps);
    const progress = list(task.progress);
    const counts = ['进行中', '已完成', '已失败', '尚未开始', '尚未接取']
      .map((status) => ({ status, count: progress.filter((row) => row.status === status).length }))
      .filter((row) => row.count)
      .map((row) => `${row.status} ${row.count}`)
      .join(' · ');
    return persist(
      `<article class="flow-task" data-flow-quest="${text(task.id || '')}"><div class="row between"><h3>${text(task.name)}</h3>${pill(task.kind === 'Primary' ? '主线' : '支线', task.kind === 'Primary' ? 'green' : '')}</div>${steps.length ? steps.map((row) => step(row, task.id)).join('') : '<p class="small muted">这份存档只有任务记录，尚无可展示的当前步骤；请核对任务资料。</p>'}${progress.length ? `<details class="flow-task-progress"><summary>已记录的步骤 · ${text(counts)}</summary><ul class="flow-progress-list">${progress.map((row) => `<li>${questButton(row.id, row.name)}${pill(row.status, row.status === '已完成' ? 'green' : row.status === '已失败' ? 'orange' : '')}</li>`).join('')}</ul><p class="small save-note">只列本次已保存的步骤记录；列表不代表时间顺序或全部分支，未出现的步骤仍待核对。</p></details>` : ''}${questButton(task.id)}</article>`,
      'task-' + task.id,
    );
  }
  function chapter(flow) {
    const current = flow.chapter;
    const changes = list(flow.changes);
    if (!current && !changes.length) return '';
    return `<section class="flow-chapter"><h2>主线节点与阶段变化</h2>${current ? `<h3>${text(current.name || '当前主线')}</h3>${current.mainName ? `<p>${text(current.mainName)}</p>` : ''}${questButton(current.questId)}${current.basis ? `<p class="small save-note">${text(current.basis)}</p>` : ''}${current.next ? `<p><span class="small muted">推进前核对的节点 </span>${questButton(current.next.questId, current.next.title) || text(current.next.title)}</p>` : ''}${current.nextMilestone ? `<p><span class="small muted">下一主线关键节点 </span>${questButton(current.nextMilestone.questId, current.nextMilestone.title) || text(current.nextMilestone.title)}</p><p class="small save-note">${text(current.nextMilestone.note)}</p>${sources(current.nextMilestone.sources)}` : ''}` : ''}${changes.length ? `<ul class="flow-changes">${changes.map((change) => `<li><strong>${text(change.title || '任务变化')}</strong>${change.triggerName ? `<p><span class="small muted">推进关联 </span>${text(change.triggerName)}</p>` : ''}${change.consequence ? `<p>${text(change.consequence)}</p>` : ''}${advancement(change)}</li>`).join('')}</ul>` : ''}</section>`;
  }
  function offlineIndex(flow) {
    const guide = list(flow.guide);
    const chapters = list(flow.chapters);
    return persist(
      `${guide.length ? `<details class="flow-guide"><summary>全部关键攻略条目 · ${guide.length} 项</summary><p class="small save-note">按资料浏览，不表示这些任务当前都能接取。具体条件、截止与来源请逐项核对。</p>${guide.map((entry) => rule(entry)).join('')}</details>` : ''}${
        chapters.length
          ? `<details class="flow-main-index"${flow.available ? '' : ' open'}><summary>离线主线索引</summary>${chapters
              .map(
                (item) =>
                  `<section class="flow-index-chapter"><h3>${text(item.name)}</h3><ul>${list(item.roots)
                    .map(
                      (root) =>
                        `<li>${questButton(root.id, root.name) || text(root.name)}${root.status ? pill(String(root.status), root.status === '已完成' ? 'green' : '') : ''}</li>`,
                    )
                    .join('')}</ul></section>`,
              )
              .join(
                '',
              )}<p class="small save-note">索引供查询主线资料，排列不保证当前周目的推进顺序；未出现在记录不代表未接或错过。</p></details>`
          : ''
      }`,
      'offline',
    );
  }
  function compactPanel(flow, sections = ['advice', 'opportunities', 'milestones']) {
    const decisions = list(flow.decisions);
    const decisionIds = new Set(decisions.map((row) => row.id));
    const warnings = list(flow.warnings).filter((row) => !decisionIds.has(row.id));
    const active = list(flow.active);
    const advice = list(flow.advice).filter((row) => !decisionIds.has(row.id));
    const warningIds = new Set([...warnings, ...decisions].map((row) => row.id));
    const opportunities = list(flow.opportunities).filter((row) => !warningIds.has(row.id));
    const reference = flow.reference;
    const visibleSections = new Set(sections);
    const compactAdvice = (row) =>
      `<article class="flow-suggestion" data-flow-suggestion="${text(row.id)}"><h3>${text(row.name)}</h3><p>${text(row.recommendation?.action || row.pickup?.action || row.warning)}</p>${row.recommendation?.reason ? `<p class="small"><strong>为什么：</strong>${text(row.recommendation.reason)}</p>` : ''}<details><summary>做法、收益与条件</summary>${rule(row)}</details></article>`;
    const compactDecision = (row) => {
      const value = row.recommendation;
      return `<aside class="flow-decision" data-flow-decision="${text(row.id)}"><h3>选择前 · ${text(row.name)}</h3>${value?.action ? `<div class="flow-recommendation"><p class="flow-recommended-action"><strong>推荐：</strong>${text(value.action)}</p><p><strong>为什么：</strong>${text(value.reason)}</p></div>` : `<p>${text(row.warning)}</p>`}<details class="flow-choice-details"><summary>各选项影响、条件与来源</summary>${value?.goal ? `<p>适合：${text(value.goal)}</p>` : ''}${value?.tradeoff ? `<p>取舍：${text(value.tradeoff)}</p>` : ''}<p>${text(row.warning)}</p><dl class="flow-choices">${list(
        row.choices,
      )
        .map((choice) => `<dt>${text(choice.label)}</dt><dd>${text(choice.effect)}</dd>`)
        .join(
          '',
        )}</dl>${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${sources(row.sources)}</details></aside>`;
    };
    const first = active[0];
    const firstStep = first?.steps?.[0];
    const lead = first
      ? `<section class="flow-now flow-active" data-flow-now><div class="row between"><h2>现在做什么</h2>${pill(first.kind === 'Primary' ? '主线' : '支线', 'green')}</div><h3>${questButton(first.id, first.name)}</h3><p class="flow-next-action">${text(firstStep?.nextAction || firstStep?.description || '请核对游戏任务栏中的当前要求。')}</p>${
          firstStep?.places?.length
            ? `<p class="small flow-now-place">${list(firstStep.places)
                .map((place) => target(place, 'world-place', 'place'))
                .join(' · ')}</p>`
            : ''
        }<details class="flow-now-details"><summary>人物、材料与完整步骤</summary>${activeTask(first)}</details></section>`
      : `<div class="flow-empty"><h2>${flow.available ? '当前行动待核对' : '先看攻略，也能开始'}</h2><p class="small">${text(flow.reason || '这份保存进度没有已识别的进行中步骤；可查看下方的阶段建议和任务线索。')}</p>${flow.referenceNeedsSelection ? button('save-slot', '选择流程参照', '', 'btn soft') : ''}</div>`;
    const affected = warnings.flatMap((row) => list(row.affectedTasks));
    const urgent = warnings.length
      ? `<section class="flow-risks"><h2>${icon('pin')} 推进前请确认</h2>${affected.length ? `<p class="flow-impact-summary">受影响：${[...new Set(affected.map((task) => task.name))].map(text).join('、')}</p>` : `<p class="small">${text(warnings[0].message || warnings[0].warning)}</p>`}<details class="flow-compact-risks"><summary>${warnings.length} 项推进提醒 · 查看触发条件与影响</summary>${warnings.map((row) => rule(row, true)).join('')}</details></section>`
      : '';
    return persist(
      `<section class="flow-panel flow-compact" data-flow><div class="flow-compact-reference"><span class="small flow-reference">${reference ? `${flow.referenceMode === 'slot' ? '固定 ' : ''}${text(reference.name)} · ${text(new Date(reference.modifiedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }))}保存` : '离线攻略 · 尚无可读参照'}</span><span class="row">${button('save-slot', '参照', '')}${button('companion-display', '显示', '')}</span></div>${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${compactDecision(decisions[0])}${decisions.length > 1 ? `<details><summary>另有 ${decisions.length - 1} 项关键选择</summary>${decisions.slice(1).map(compactDecision).join('')}</details>` : ''}</section>` : ''}${lead}${urgent}${visibleSections.has('advice') && advice.length ? `<section class="flow-advice"><h2>顺路建议</h2>${compactAdvice(advice[0])}${advice.length > 1 ? `<details><summary>其他阶段建议 · ${advice.length - 1} 项</summary>${advice.slice(1).map(compactAdvice).join('')}</details>` : ''}</section>` : ''}${active.length > 1 ? `<details class="flow-all-active"><summary>其他进行中任务 · ${active.length - 1} 项</summary>${active.slice(1).map(activeTask).join('')}</details>` : ''}${list(flow.unindexedActive).length ? `<details class="flow-unindexed" data-flow-unindexed><summary>另有 ${flow.unindexedActive.length} 条进行中记录待识别</summary><p class="small save-note">请核对游戏任务栏；资料尚不能确定这些记录的名称与下一步。</p><p>${flow.unindexedActive.map((row) => '#' + text(row.id)).join('、')}</p></details>` : ''}${visibleSections.has('opportunities') ? `<details class="flow-opportunities"><summary>当前可查的未接任务 · ${opportunities.length} 项</summary><p class="small save-note">按已保存记录和整理资料匹配；隐藏条件仍需在游戏确认。</p>${opportunities.map((row) => rule(row)).join('') || '<p class="small muted">暂未命中更多已整理的接取线索。</p>'}</details>` : ''}${visibleSections.has('milestones') ? `<details class="flow-stage-details"><summary>下一主线节点与阶段变化</summary>${chapter(flow) || '<p class="small muted">当前主线节点待核对。</p>'}${flow.stageUncertainty ? `<p class="small save-note" data-flow-stage-uncertain>${text(flow.stageUncertainty)}</p>` : ''}</details>` : ''}<details class="flow-reference-details"><summary>保存时间、提醒范围与全部攻略</summary><p class="small">${reference ? `${text(reference.name)} · ${text(when(reference.modifiedAt))}的已保存进度` : '尚无可读存档参照'}</p><p class="small save-note flow-choice-freshness">随行自动对照保存进度。选项前请先保存并核对参照；未保存的对话无法识别。</p><p class="flow-coverage small save-note">已整理 ${text(flow.coverage?.curatedRules ?? list(flow.guide).length)} 条关键攻略规则，不能保证全任务防漏。</p>${offlineIndex(flow)}</details></section>`,
      'compact-panel',
    );
  }
  function panel(flow, { compact = false, summary = false, sections } = {}) {
    if (!flow) flow = { available: false, reason: '正在核对流程资料。' };
    if (compact) return compactPanel(flow, sections);
    const decisions = list(flow.decisions);
    const decisionIds = new Set(decisions.map((row) => row.id));
    const warnings = list(flow.warnings).filter((row) => !decisionIds.has(row.id));
    const advice = list(flow.advice).filter(
      (row) => (row.activeRule || row.kind === 'stage') && !decisionIds.has(row.id),
    );
    const active = list(flow.active);
    const activeCard = (task) => activeTask(task);
    const unindexed = list(flow.unindexedActive);
    const shared = list(flow.sharedMaterials);
    const warningIds = new Set([...warnings, ...decisions].map((row) => row.id).filter(Boolean));
    const opportunities = list(flow.opportunities).filter((row) => !row.id || !warningIds.has(row.id));
    const coverage = flow.coverage || {};
    const reference = flow.reference;
    const take = (rows) => (summary ? rows.slice(0, 3) : rows);
    const remaining = Math.max(0, active.length - 3);
    const activeBody = summary
      ? take(active).map(activeCard).join('')
      : `${active.slice(0, 3).map(activeCard).join('')}${remaining ? `<details class="flow-all-active"><summary>其余 ${remaining} 项进行中任务</summary>${active.slice(3).map(activeCard).join('')}</details>` : ''}`;
    const riskBody = warnings.length
      ? take(warnings)
          .map((warning) => rule(warning, true))
          .join('')
      : `<p class="small muted">${decisions.length ? '当前步骤的选择建议已列在上方；其他已整理关键提醒暂未命中。' : '当前参照未命中已整理的关键提醒，覆盖范围见下方。'}</p>`;
    const riskContent =
      compact && active.length && warnings.length
        ? `<details class="flow-compact-risks"><summary>${warnings.length} 项推进提醒 · ${text(warnings[0].name || warnings[0].title)}</summary>${riskBody}</details>`
        : riskBody;
    const summaryMore = summary && (warnings.length > 3 || active.length > 3 || opportunities.length > 3);
    return persist(
      `<section class="flow-panel${compact ? ' flow-compact' : ''}${summary ? ' flow-summary' : ''}${warnings.length ? ' flow-has-risks' : ''}" data-flow><div class="flow-heading"><div class="eyebrow">江湖流程</div><h2>这一阶段，先做什么</h2><p class="small flow-reference">${reference ? `${text(reference.mapName || '场景待核对')} · ${text(reference.name)} · ${text(when(reference.modifiedAt))}的已保存进度` : '离线攻略仍可查看'}</p>${flow.stageUncertainty ? `<p class="small save-note" data-flow-stage-uncertain>${text(flow.stageUncertainty)}</p>` : ''}${!flow.available ? `<div class="notice flow-empty"><strong>尚未对照可读存档</strong><p>${text(flow.reason || '选择本周目的存档参照后，可对照当前任务；现在也能浏览攻略与主线索引。')}</p>${flow.referenceNeedsSelection ? button('save-slot', '检查并选择流程参照', '') : ''}</div>` : flow.reason ? `<p class="small save-note">${text(flow.reason)}</p>` : ''}</div>${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${decisions.map(decision).join('')}<p class="small save-note flow-choice-freshness">依据已保存的步骤；选项前先保存并核对这份参照。随行自动对照新存档，未保存的对话无法识别。</p></section>` : ''}<section class="flow-risks"><h2>${icon('pin')} 推进前请确认</h2>${riskContent}</section><section class="flow-active"><h2>当前任务与下一行动${active.length ? ` · ${active.length} 项` : ''}</h2>${
        shared.length
          ? `<aside class="flow-shared-materials"><h3>这些步骤会共用材料</h3><p class="small save-note">若都要交付，请按合计量预留；未纳入未接任务和未显示的后续步骤。</p>${shared
              .map(
                (material) =>
                  `<p>${button('database-detail', material.name, material.id)} · 合计需 ${text(material.required)}${material.owned === null ? ' · 库存待核对' : ` · 持有 ${text(material.owned)} · 还差 ${text(material.missing)}`}</p><details><summary>哪些步骤会用到</summary><ul>${list(
                    material.steps,
                  )
                    .map(
                      (row) =>
                        `<li>${questButton(row.id, row.taskName + ' · ' + row.name)} · ${text(row.required)}</li>`,
                    )
                    .join('')}</ul></details>`,
              )
              .join('')}</aside>`
          : ''
      }${unindexed.length ? `<aside class="flow-unindexed" data-flow-unindexed><details><summary>另有 ${unindexed.length} 条进行中记录待识别</summary><p class="small save-note">这些记录尚未收录在任务资料中，可能是隐藏剧情或版本新增任务。请核对游戏任务栏中额外进行中的任务；这里暂不能判断名称与下一步。</p><p class="small">${unindexed.map((record) => `#${text(record.id)}${record.tracked ? '（当前追踪）' : ''}`).join('、')}</p></details></aside>` : ''}${activeBody || `<p class="small muted">${flow.available ? '这份存档暂无可展示的已识别进行中步骤；可在下方查找任务线索。' : '读取存档后在这里显示当前行动，无需先安排个人行程。'}</p>`}</section>${advice.length ? `<details class="flow-advice"><summary>任务选择、材料留用与额外收益 · ${advice.length} 项</summary>${advice.map((row) => rule(row)).join('')}</details>` : ''}<section class="flow-opportunities"><h2>未接取任务与接取线索${opportunities.length ? ` · ${opportunities.length} 项` : ''}</h2><p class="small save-note">按存档记录、已核对的前置与已整理阶段攻略列出；部分条件仍待核对，不保证当前可接。</p>${
        opportunities.length
          ? take(opportunities)
              .map((entry) => rule(entry))
              .join('')
          : '<p class="small muted">当前已整理的规则没有更多匹配线索，可继续浏览全部攻略。</p>'
      }</section>${chapter(flow)}<p class="flow-coverage small save-note">已索引 ${text(coverage.tasks ?? '—')} 条任务与步骤、${text(coverage.mainRoots ?? '—')} 条主线根任务；整理了 ${text(coverage.curatedRules ?? list(flow.guide).length)} 条关键攻略规则。精选规则不保证全任务防漏，未保存的变化不会计入。</p>${summary ? `<div class="flow-more">${summaryMore ? '<p class="small muted">这里展示前 3 项；完整流程保留全部任务和提醒。</p>' : ''}${button('navigate', '查看完整流程、攻略与主线索引', 'checklist', 'btn soft')}</div>` : offlineIndex(flow)}</section>`,
      'panel',
    );
  }
  return { panel };
}
