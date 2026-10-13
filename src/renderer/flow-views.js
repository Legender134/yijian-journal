export function createFlowViews({ esc, act, icon, pill, when, richText = esc }) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const text = (value) => esc(String(value ?? ''));
  const prose = (value) => richText(String(value ?? ''));
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
    if (typeof value === 'string') return prose(value);
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
  function choiceMaterials(row) {
    return materials(row.recommendation?.materials, [], row.recommendation?.materialLabel || '推荐路线备料');
  }
  function recommendation(row) {
    const value = row.recommendation;
    if (!value?.action || !value.reason) return '';
    return `<div class="flow-recommendation"><p class="flow-recommended-action"><strong>推荐做法：</strong>${prose(value.action)}</p><p><strong>为什么：</strong>${prose(value.reason)}</p>${value.goal ? `<p class="small muted">适合：${text(value.goal)}</p>` : ''}${value.tradeoff ? `<p class="small"><strong>取舍：</strong>${prose(value.tradeoff)}</p>` : ''}${choiceMaterials(row)}</div>`;
  }
  function delivery(row) {
    const options = list(row.deliveryOptions);
    return options.length
      ? `<section class="flow-delivery" data-flow-delivery><h4>这一类的交付项</h4><p class="small save-note">按当前路线选一项核对，不合计替代物品；持有数量不证明其他交付条件已满足。</p><ul>${options.map((option) => `<li>${button('database-detail', option.name, option.id)}<p class="small">资料需 ${text(option.required)} 件 · ${option.owned === null ? '保存持有待核对' : `保存持有 ${text(option.owned)} 件${option.owned < option.required ? ` · 数量还缺 ${text(option.required - option.owned)} 件` : ' · 数量已齐'}`}</p>${questButton(option.questId, '查看交付步骤')}</li>`).join('')}</ul></section>`
      : '';
  }
  function advancement(row) {
    const affected = list(row.affectedTasks);
    if (!affected.length) return '';
    return `<div class="flow-affected" data-flow-affected><h4>推进后受影响的任务</h4><p class="small">触发：${text(row.deadlineLabel || row.triggerName || '见下列条件')}</p><ul>${affected.map((task) => `<li><strong>${questButton(task.questId, task.name) || text(task.name)}</strong>：${prose(task.effect)}${task.evidence ? `<p class="small save-note">${text(task.evidence)}</p>` : ''}</li>`).join('')}</ul></div>`;
  }
  function rule(row, warning = false) {
    const stage = row.kind === 'stage';
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
        ? `<div class="flow-pickup">${location || person ? `<p>${location ? `<span class="small muted">${stage ? '行动地点' : '接取地点'} </span>${location}` : ''}${location && person ? ' · ' : ''}${person ? `<span class="small muted">人物 </span>${person}` : ''}</p>` : ''}${pickup.action ? `<p><span class="small muted">${stage ? '接下来' : '怎么接'} </span>${prose(pickup.action)}</p>` : ''}${pickup.executionPlace ? `<p class="small"><span class="muted">接取后的目的地线索 </span>${text(pickup.executionPlace)}</p>` : ''}</div>`
        : '';
    return persist(
      `<article class="flow-rule${warning ? ' flow-risk' : ''}" data-flow-rule="${text(row.id || '')}"${warning ? ` data-flow-warning="${text(row.id || row.questId || '')}"` : ''}><div class="row between"><h3>${text(row.name || row.title || '任务线索')}</h3>${stateLabel ? pill(stateLabel, row.state === 'done' ? 'green' : row.state === 'failed' ? 'orange' : '') : ''}</div>${row.done || row.failed ? `<p class="small save-note">存档已记录${row.done ? '完成' : '失败'}；以下攻略供回顾，不表示全部分支均已经历。</p>` : ''}${message ? `<p class="flow-warning-message">${text(message)}</p>` : ''}${advancement(row)}${recommendation(row)}${delivery(row)}${row.deadlineReached && !row.done && !row.failed ? '<p class="small flow-warning-message">已到资料提示的推进边界，请先核对任务状态与来源。</p>' : ''}${warning ? '' : pickupBody + conditions(conditionRows) + questButton(row.questId || row.id)}${hasDetails ? `<details class="flow-rule-details"><summary>${warning ? (stage ? '行动地点、选择影响与来源' : '接取位置、选择影响与来源') : '查看步骤、选择影响与来源'}</summary>${warning ? pickupBody + conditions(conditionRows) + questButton(row.questId || row.id) : ''}${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${steps.length ? `<ol class="flow-guide-steps">${steps.map((step) => `<li>${prose(step)}</li>`).join('')}</ol>` : ''}${choices.length ? `<div class="flow-choices"><h4>选择与各自影响 · 涉及剧情</h4><dl>${choices.map((choice) => `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响尚待核对')}</dd>`).join('')}</dl></div>` : ''}${sources(row.sources)}</details>` : ''}</article>`,
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
  function stepPeople(row) {
    const people = list(row.people);
    return people.length
      ? `<div class="flow-people">${people.map((person) => `<span>${person.role ? `<span class="small muted">${text(person.role)} </span>` : ''}${target(person, 'database-detail', 'npc')}</span>`).join(' · ')}</div>`
      : '';
  }
  function stepPlaces(row) {
    const places = list(row.places);
    return places.length
      ? `<div class="flow-places">${places.map((place) => `<p><span class="small muted">地点线索 </span>${target(place, 'world-place', 'place')}${place.evidence ? `<span class="small muted"> · ${text(placeEvidence(place.evidence))}</span>` : ''}</p>`).join('')}</div>`
      : '';
  }
  function materials(rows, sharedMaterials = [], heading = '这一步需要的材料') {
    const routeLinks = (route) =>
      `${route.personId ? button('database-detail', '查看商人资料', route.personId) : ''}${route.placeId ? button('world-place', '查看地点资料', route.placeId) : ''}`;
    const routeEvidence = (route) =>
      `<p class="small muted">${text(route.efficiency || '效率尚待核实')}</p>${sources(route.sources)}`;
    const routeList = (routes) =>
      routes.length
        ? `<ul>${routes.map((route) => `<li><strong>${text(routeName(route))}</strong>${route.detail ? `<p>${text(route.detail)}</p>` : ''}${routeLinks(route)}${routeEvidence(route)}</li>`).join('')}</ul>`
        : '';
    const items = list(rows);
    return items.length
      ? `<div class="flow-materials"><h4>${icon('bag')} ${text(heading)}</h4>${items
          .map((material) => {
            const required =
              Number.isFinite(material.required) && material.required >= 0 ? material.required : null;
            const owned = Number.isFinite(material.owned) && material.owned >= 0 ? material.owned : null;
            const missing =
              required !== null &&
              owned !== null &&
              Number.isFinite(material.missing) &&
              material.missing >= 0
                ? material.missing
                : null;
            const shared = list(sharedMaterials).find((row) => row.id === material.id);
            const sharedMissing =
              shared && Number.isFinite(shared.missing) && shared.missing >= 0 ? shared.missing : null;
            const stockStatus = shared
              ? sharedMissing === null
                ? '共用缺口待核对'
                : sharedMissing > 0
                  ? `多任务合计缺 ${text(sharedMissing)}`
                  : '合计持有量已足'
              : '持有量已足';
            const routes = list(material.routes);
            const primary = routes.filter((route) => !route.alternative);
            const alternatives = routes.filter((route) => route.alternative);
            const first = primary[0];
            const preview = first
              ? `<div class="flow-material-source"><p class="small"><span class="muted">主要来源 </span><strong>${text(routeName(first))}</strong>${first.detail ? `：${text(first.detail)}` : ''}</p>${routeLinks(first)}</div>`
              : '<p class="small muted">暂无已知主要来源，可打开物品资料继续查找。</p>';
            return `<div class="flow-material"><div class="row between">${/^item-\d+$/.test(String(material.id || '')) ? button('database-detail', material.name, material.id) : text(material.name)}<span>${required === null ? '需求数量待核对' : `需 ${text(required)}`}${owned === null ? ' · 库存待核对' : ` · 持有 ${text(owned)}`}${missing === null ? ' · 缺口待核对' : missing > 0 ? ` · 缺 ${text(missing)}` : ` · ${stockStatus}`}</span></div>${preview}${routes.length ? `<details><summary>效率、来源依据与其他获取路线</summary>${first ? routeEvidence(first) : ''}${routeList(primary.slice(1))}${alternatives.length ? `<details class="flow-material-alternatives"><summary>其他商人线索 · ${alternatives.length} 处 · 可达与库存待核对</summary>${routeList(alternatives)}</details>` : ''}</details>` : ''}</div>`;
          })
          .join(
            '',
          )}<p class="small save-note">持有量来自已保存进度；交付前仍需核对其他任务的留用数量。来源线索不保证当前可达或有货。</p></div>`
      : '';
  }
  function sharedMaterialSummary(rows) {
    const shared = list(rows);
    return shared.length
      ? `<aside class="flow-shared-materials"><h3>这些步骤会共用材料</h3><p class="small save-note">若都要交付，请按合计量预留；未纳入未接任务和未显示的后续步骤。</p>${shared
          .map(
            (material) =>
              `<p>${button('database-detail', material.name, material.id)} · 合计需 ${text(material.required)}${material.owned === null ? ' · 库存待核对' : ` · 持有 ${text(material.owned)} · 还差 ${text(material.missing)}`}</p><details data-persist-detail="shared-material-${text(material.id)}-${text(
                list(material.steps)
                  .map((row) => row.id)
                  .sort()
                  .join('-'),
              )}"><summary>哪些步骤会用到</summary><ul>${list(material.steps)
                .map(
                  (row) =>
                    `<li>${questButton(row.id, row.taskName + ' · ' + row.name)} · ${text(row.required)}</li>`,
                )
                .join('')}</ul></details>`,
          )
          .join('')}</aside>`
      : '';
  }
  function compactStepTargets(row) {
    const people = list(row.people).map((person) => target(person, 'database-detail', 'npc'));
    const places = list(row.places).map((place) => target(place, 'world-place', 'place'));
    return people.length || places.length
      ? `<p class="flow-targets">${people.join('、')}${people.length && places.length ? ' · ' : ''}${places.length ? `${places.join('、')} <span class="small muted">地点线索</span>` : ''}</p>`
      : '';
  }
  function compactMaterials(
    rows,
    sharedMaterials = [],
    { details = true, sources = {}, scope = 'current' } = {},
  ) {
    const items = list(rows);
    return items.length
      ? `<div class="flow-material-brief">${items
          .map((material) => {
            const required =
              Number.isFinite(material.required) && material.required >= 0 ? material.required : null;
            const owned = Number.isFinite(material.owned) && material.owned >= 0 ? material.owned : null;
            const shared = list(sharedMaterials).find((row) => row.id === material.id);
            const missing =
              required !== null &&
              owned !== null &&
              Number.isFinite(material.missing) &&
              material.missing >= 0
                ? material.missing
                : null;
            const status =
              missing === null
                ? '缺口待核对'
                : shared
                  ? !Number.isFinite(shared.missing) || shared.missing < 0
                    ? '共用缺口待核对'
                    : shared.missing > 0
                      ? `多任务合计缺 ${shared.missing}`
                      : '合计持有量已足'
                  : missing > 0
                    ? `缺 ${missing}`
                    : '持有量已足';
            const route = list(material.routes).find((row) => !row.alternative);
            return persist(
              `<div class="flow-material"><div class="row between">${button('database-detail', material.name, material.id)}<span class="flow-stock">${required === null ? '需求数量待核对' : `需 ${required}`} · ${owned === null ? '库存待核对' : `持有 ${owned}`} · ${text(status)}</span></div><p class="flow-source-brief">${sources[material.id] ? prose(sources[material.id]) : route ? prose(route.detail || routeName(route)) : '来源待核对'}</p>${details ? `<details class="flow-material-details"><summary>数量与获取详情</summary>${materials([material], sharedMaterials)}</details>` : ''}</div>`,
              `compact-material-${scope}-${material.id}`,
            );
          })
          .join('')}</div>`
      : '';
  }
  function taskMaterials(flow, { compact = false } = {}) {
    const active = list(flow?.active);
    const recommended = list(flow?.decisions).filter((row) => list(row.recommendation?.materials).length);
    const needs = active.flatMap((task) =>
      list(task.steps)
        .filter((row) => list(row.materials).length)
        .map((row) => ({ task, row })),
    );
    const body = !flow?.available
      ? `<p class="small save-note">${text(flow?.reason || '尚无可读保存进度，当前任务与持有数量待核对。')}</p>`
      : needs.length
        ? needs
            .map(
              ({ task, row }) =>
                `<article data-flow-quest="${text(task.id)}"><h3>${questButton(task.id, task.name) || text(task.name)}</h3>${!compact && row.id !== task.id && row.name !== task.name ? `<p class="small">${questButton(row.id, row.name) || text(row.name)}</p>` : ''}${compact ? compactMaterials(row.materials, flow.sharedMaterials, { scope: `${task.id}-${row.id}` }) : materials(row.materials, flow.sharedMaterials)}</article>`,
            )
            .join('')
        : recommended.length
          ? ''
          : `<p class="small muted">${active.length ? '当前已识别的进行中步骤暂无可展示的材料需求。' : '暂无可识别进行中步骤的材料需求，请核对游戏任务栏。'}</p>`;
    return persist(
      `<section class="flow-task-materials" data-flow-task-materials><h2>当前任务备料</h2>${flow?.available ? (compact && list(flow.sharedMaterials).length ? `<details data-persist-detail="task-shared-materials"><summary>共用材料 · 按合计量预留</summary>${sharedMaterialSummary(flow.sharedMaterials)}</details>` : sharedMaterialSummary(flow.sharedMaterials)) : ''}${body}${recommended.map((row) => `<article data-flow-rule="${text(row.id)}"><h3>${questButton(row.questId, row.name)}</h3>${compact ? `<p class="small">${text(row.recommendation.materialLabel)}</p>${compactMaterials(row.recommendation.materials, [], { scope: row.id })}` : choiceMaterials(row)}</article>`).join('')}</section>`,
      'task-materials',
    );
  }
  function step(row, rootId, { summaryInLead = false, sharedMaterials = [] } = {}) {
    const upcoming = list(row.upcoming);
    return persist(
      `<div class="flow-step">${summaryInLead || row.id === rootId || row.name === row.nextAction ? '' : `<h4>${text(row.name || '当前步骤')}</h4>`}${summaryInLead ? '' : `<p class="flow-next-action"><span class="small muted">当前行动 </span>${prose(row.nextAction || row.description || '请打开任务资料，核对当前要求。')}</p>`}${row.description && row.description !== row.nextAction ? `<details><summary>任务说明 · 可能涉及剧情</summary><p class="preserve-text">${prose(row.description)}</p></details>` : ''}${summaryInLead ? '' : stepPeople(row) + stepPlaces(row)}${conditions(row.requirements)}${summaryInLead ? '' : materials(row.materials, sharedMaterials)}${upcoming.length ? `<details class="flow-upcoming"><summary>后续相关步骤与分支 · 涉及剧情</summary><ul>${upcoming.map((next) => `<li>${questButton(next.id, next.name) || text(next.name)}${next.reason ? `<p class="small muted">${text(next.reason)}</p>` : ''}</li>`).join('')}</ul><p class="small save-note">相关步骤只作核对线索，不代表已解锁或确定执行顺序。</p></details>` : ''}${row.id === rootId ? '' : questButton(row.id)}</div>`,
      'step-' + row.id,
    );
  }
  function decision(row) {
    return persist(
      `<aside class="flow-decision" data-flow-decision="${text(row.id)}"><h4>当前步骤有关键选择 · ${text(row.name)}</h4>${recommendation(row)}<p>${prose(row.warning || row.name)}</p><dl class="flow-choices">${list(
        row.choices,
      )
        .map((choice) => `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响待核对')}</dd>`)
        .join(
          '',
        )}</dl><details><summary>参考版本、来源与待核对之处</summary>${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${sources(row.sources)}</details></aside>`,
      'decision-' + row.id,
    );
  }
  function activeTask(task, { summaryInLead = false, sharedMaterials = [] } = {}) {
    const steps = list(task.steps);
    const progress = list(task.progress);
    const counts = ['进行中', '已完成', '已失败', '尚未开始', '尚未接取']
      .map((status) => ({ status, count: progress.filter((row) => row.status === status).length }))
      .filter((row) => row.count)
      .map((row) => `${row.status} ${row.count}`)
      .join(' · ');
    return persist(
      `<article class="flow-task" data-flow-quest="${text(task.id || '')}">${summaryInLead ? '' : `<div class="row between"><h3>${questButton(task.id, task.name) || text(task.name)}</h3>${pill(task.kind === 'Primary' ? '主线' : '支线', task.kind === 'Primary' ? 'green' : '')}</div>`}${steps.length ? steps.map((row, index) => step(row, task.id, { summaryInLead: summaryInLead && index === 0, sharedMaterials })).join('') : '<p class="small muted">这份存档只有任务记录，尚无可展示的当前步骤；请核对任务资料。</p>'}${progress.length ? `<details class="flow-task-progress"><summary>已记录的步骤 · ${text(counts)}</summary><ul class="flow-progress-list">${progress.map((row) => `<li>${questButton(row.id, row.name)}${pill(row.status, row.status === '已完成' ? 'green' : row.status === '已失败' ? 'orange' : '')}</li>`).join('')}</ul><p class="small save-note">只列本次已保存的步骤记录；列表不代表时间顺序或全部分支，未出现的步骤仍待核对。</p></details>` : ''}${summaryInLead ? '' : questButton(task.id)}</article>`,
      'task-' + task.id,
    );
  }
  function chapter(flow) {
    const current = flow.chapter;
    const changes = list(flow.changes);
    if (!current && !changes.length) return '';
    return `<section class="flow-chapter"><h2>主线节点与阶段变化</h2>${current ? `<h3>${text(current.name || '当前主线')}</h3>${current.mainName ? `<p>${text(current.mainName)}</p>` : ''}${questButton(current.questId)}${current.basis ? `<p class="small save-note">${text(current.basis)}</p>` : ''}${current.next ? `<p><span class="small muted">推进前核对的节点 </span>${questButton(current.next.questId, current.next.title) || text(current.next.title)}</p>` : ''}${current.nextMilestone ? `<p><span class="small muted">下一主线关键节点 </span>${questButton(current.nextMilestone.questId, current.nextMilestone.title) || text(current.nextMilestone.title)}</p><p class="small save-note">${text(current.nextMilestone.note)}</p>${sources(current.nextMilestone.sources)}` : ''}` : ''}${changes.length ? `<ul class="flow-changes">${changes.map((change) => `<li><strong>${text(change.title || '任务变化')}</strong>${change.triggerName ? `<p><span class="small muted">推进关联 </span>${text(change.triggerName)}</p>` : ''}${change.consequence ? `<p>${prose(change.consequence)}</p>` : ''}${advancement(change)}</li>`).join('')}</ul>` : ''}</section>`;
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
      persist(
        `<article class="flow-suggestion" data-flow-suggestion="${text(row.id)}"><p>${prose(row.recommendation?.hint || row.recommendation?.action || row.pickup?.action || row.warning)}</p><details><summary>做法与理由</summary>${rule(row)}</details></article>`,
        `compact-advice-${row.id}`,
      );
    const compactDecision = (row) => {
      const value = row.recommendation;
      return persist(
        `<aside class="flow-decision" data-flow-decision="${text(row.id)}"><p class="flow-recommended-action">${prose(value?.summary || value?.hint || value?.compact?.action || value?.action || row.warning)}</p>${value?.caution ? `<p class="flow-caution">${prose(value.caution)}</p>` : ''}${compactMaterials(value?.materials, [], { details: false, sources: value?.materialSources })}<details class="flow-choice-details" data-persist-detail="flow-choice-${text(row.id)}"><summary>为什么这样选 · 各选项影响</summary><h3>${text(row.name)}</h3>${recommendation(row)}${row.pickup?.place || row.pickup?.person ? `<p class="flow-choice-location">${target(row.pickup.place, 'world-place', 'place')}${row.pickup.person ? ` · ${target(row.pickup.person, 'database-detail', 'npc')}` : ''}</p>` : ''}<p>${prose(row.warning)}</p>${conditions(row.conditions)}<dl class="flow-choices">${list(
          row.choices,
        )
          .map((choice) => `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响待核对')}</dd>`)
          .join(
            '',
          )}</dl>${row.uncertainty ? `<p class="small save-note">${text(row.uncertainty)}</p>` : ''}${sources(row.sources)}</details></aside>`,
        `compact-choice-${row.id}`,
      );
    };
    const first = active[0];
    const firstStep = first?.steps?.[0];
    const lead = first
      ? `<section class="flow-now flow-active" data-flow-now data-flow-quest="${text(first.id)}"><h3>${questButton(first.id, first.name)}</h3><p class="flow-next-action">${prose(firstStep?.nextAction || firstStep?.description || '请核对游戏任务栏中的当前要求。')}</p>${firstStep ? compactStepTargets(firstStep) + compactMaterials(firstStep.materials, flow.sharedMaterials, { scope: `${first.id}-${firstStep.id}` }) : ''}<details class="flow-now-details" data-persist-detail="flow-now-${text(first.id)}-${text(firstStep?.id)}"><summary>条件与完整步骤</summary>${firstStep ? stepPeople(firstStep) + stepPlaces(firstStep) : ''}${activeTask(first, { summaryInLead: true, sharedMaterials: flow.sharedMaterials })}</details></section>`
      : `<div class="flow-empty"><p>${text(flow.reason || (flow.available ? '当前步骤待核对，可展开下方流程线索。' : '尚无可读存档，可先查询攻略。'))}</p>${flow.referenceNeedsSelection ? button('save-slot', '选择流程参照', '', 'btn soft') : ''}</div>`;
    const riskGroups = new Map();
    for (const row of warnings) {
      const deadline = row.compactDeadline || row.deadlineLabel || row.triggerName;
      const key = deadline || row;
      if (!riskGroups.has(key)) riskGroups.set(key, { deadline, rows: [] });
      riskGroups.get(key).rows.push(row);
    }
    const groups = [...riskGroups.values()];
    const riskPreview = (row) =>
      row.deadlineReached
        ? `${row.name || '任务'}：窗口已推进，能否继续须核对`
        : row.compactWarning ||
          row.message ||
          row.warning ||
          list(row.affectedTasks)
            .map((task) => `${task.name}：${task.effect}`)
            .join('；') ||
          row.name;
    const urgent = warnings.length
      ? `<section class="flow-risks"><details class="flow-compact-risks" data-persist-detail="flow-risk-summary-${text(
          warnings
            .map((row) => row.id)
            .sort()
            .join('-'),
        )}" open><summary><strong>推进前核对 · ${warnings.length} 项</strong></summary>${groups.map(({ deadline, rows }) => `<details class="flow-risk-window" data-persist-detail="flow-risk-window-${text(rows[0].id)}"><summary>${rows.map((row) => `<span class="flow-risk-preview">${text(riskPreview(row))}</span>`).join('')}</summary><p class="small flow-risk-deadline">${prose(deadline || rows[0].name || '推进提醒')}</p>${rows.map((row) => `<div data-flow-impact="${text(row.id)}">${rule(row, true)}</div>`).join('')}</details>`).join('')}</details></section>`
      : '';
    const current = decisions.length
      ? `<details class="flow-task-peek" data-persist-detail="flow-task-peek-${text(first?.id)}"><summary>当前任务 · ${text(first?.name || '步骤待核对')}</summary>${lead}</details>`
      : lead;
    return persist(
      `<section class="flow-panel flow-compact" data-flow><div class="flow-compact-reference"><span class="flow-reference" title="${reference ? text(when(reference.modifiedAt)) + '的已保存进度；未保存对话无法识别' : '尚无可读存档'}">${reference ? `${flow.referenceMode === 'slot' ? '固定' : '存档'} ${text(reference.name)} · 已保存进度` : '离线攻略'}</span><span class="row">${button('save-slot', '参照', '')}${button('companion-display', '显示', '')}</span></div>${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${compactDecision(decisions[0])}${decisions.length > 1 ? `<details data-persist-detail="compact-more-choices"><summary>其他关键选择 · ${decisions.length - 1}</summary>${decisions.slice(1).map(compactDecision).join('')}</details>` : ''}</section>` : ''}${urgent}${decisions.length ? '' : current}${visibleSections.has('advice') && advice.length ? `<section class="flow-advice"><h2>顺路可做</h2>${compactAdvice(advice[0])}${advice.length > 1 ? `<details data-persist-detail="compact-more-advice"><summary>更多建议 · ${advice.length - 1}</summary>${advice.slice(1).map(compactAdvice).join('')}</details>` : ''}</section>` : ''}${decisions.length ? current : ''}${
        active.length > 1
          ? `<details data-persist-detail="compact-other-active" class="flow-all-active"><summary>其他进行中任务 · ${active.length - 1}</summary>${active
              .slice(1)
              .map((task) => activeTask(task, { sharedMaterials: flow.sharedMaterials }))
              .join('')}</details>`
          : ''
      }${list(flow.unindexedActive).length ? `<details data-persist-detail="compact-unindexed" class="flow-unindexed" data-flow-unindexed><summary>另有 ${flow.unindexedActive.length} 条进行中记录待识别</summary><p class="small save-note">请核对游戏任务栏；资料尚不能确定这些记录的名称与下一步。</p><p>${flow.unindexedActive.map((row) => '#' + text(row.id)).join('、')}</p></details>` : ''}${visibleSections.has('opportunities') ? `<details data-persist-detail="compact-opportunities" class="flow-opportunities"><summary>未接任务线索 · ${opportunities.length}</summary><p class="small save-note">按已保存记录和整理资料匹配；隐藏条件仍需在游戏确认。</p>${opportunities.map((row) => rule(row)).join('') || '<p class="small muted">暂未匹配到接取线索。</p>'}</details>` : ''}${visibleSections.has('milestones') ? `<details data-persist-detail="compact-stage" class="flow-stage-details"><summary>下一节点与阶段变化</summary>${chapter(flow) || '<p class="small muted">当前主线节点待核对。</p>'}${flow.stageUncertainty ? `<p class="small save-note" data-flow-stage-uncertain>${text(flow.stageUncertainty)}</p>` : ''}</details>` : ''}<details data-persist-detail="compact-reference" class="flow-reference-details"><summary>保存时间与攻略范围</summary><p class="small">${reference ? `${text(reference.name)} · ${text(when(reference.modifiedAt))}的已保存进度` : '尚无可读存档参照'}</p><p class="small save-note flow-choice-freshness">随行自动对照保存进度。选项前请先保存并核对参照；未保存的对话无法识别。</p><p class="flow-coverage small save-note">已整理 ${text(flow.coverage?.curatedRules ?? list(flow.guide).length)} 条关键攻略规则，不能保证全任务防漏。</p>${offlineIndex(flow)}</details></section>`,
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
    const activeCard = (task) => activeTask(task, { sharedMaterials: flow.sharedMaterials });
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
        ? `<details class="flow-compact-risks" data-persist-detail="flow-risk-summary"><summary>${warnings.length} 项推进提醒 · ${text(warnings[0].name || warnings[0].title)}</summary>${riskBody}</details>`
        : riskBody;
    const summaryMore = summary && (warnings.length > 3 || active.length > 3 || opportunities.length > 3);
    return persist(
      `<section class="flow-panel${compact ? ' flow-compact' : ''}${summary ? ' flow-summary' : ''}${warnings.length ? ' flow-has-risks' : ''}" data-flow><div class="flow-heading"><div class="eyebrow">江湖流程</div><h2>这一阶段，先做什么</h2><p class="small flow-reference">${reference ? `${text(reference.mapName || '场景待核对')} · ${text(reference.name)} · ${text(when(reference.modifiedAt))}的已保存进度` : '离线攻略仍可查看'}</p>${flow.stageUncertainty ? `<p class="small save-note" data-flow-stage-uncertain>${text(flow.stageUncertainty)}</p>` : ''}${!flow.available ? `<div class="notice flow-empty"><strong>尚未对照可读存档</strong><p>${text(flow.reason || '选择本周目的存档参照后，可对照当前任务；现在也能浏览攻略与主线索引。')}</p>${flow.referenceNeedsSelection ? button('save-slot', '检查并选择流程参照', '') : ''}</div>` : flow.reason ? `<p class="small save-note">${text(flow.reason)}</p>` : ''}</div>${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${decisions.map(decision).join('')}<p class="small save-note flow-choice-freshness">依据已保存的步骤；选项前先保存并核对这份参照。随行自动对照新存档，未保存的对话无法识别。</p></section>` : ''}<section class="flow-risks"><h2>${icon('pin')} 推进前请确认</h2>${riskContent}</section><section class="flow-active"><h2>当前任务与下一行动${active.length ? ` · ${active.length} 项` : ''}</h2>${sharedMaterialSummary(
        shared,
      )}${unindexed.length ? `<aside class="flow-unindexed" data-flow-unindexed><details><summary>另有 ${unindexed.length} 条进行中记录待识别</summary><p class="small save-note">这些记录尚未收录在任务资料中，可能是隐藏剧情或版本新增任务。请核对游戏任务栏中额外进行中的任务；这里暂不能判断名称与下一步。</p><p class="small">${unindexed.map((record) => `#${text(record.id)}${record.tracked ? '（当前追踪）' : ''}`).join('、')}</p></details></aside>` : ''}${activeBody || `<p class="small muted">${flow.available ? '这份存档暂无可展示的已识别进行中步骤；可在下方查找任务线索。' : '读取存档后在这里显示当前行动，无需先安排个人行程。'}</p>`}</section>${advice.length ? `<details class="flow-advice"><summary>任务选择、材料留用与额外收益 · ${advice.length} 项</summary>${advice.map((row) => rule(row)).join('')}</details>` : ''}<section class="flow-opportunities"><h2>未接取任务与接取线索${opportunities.length ? ` · ${opportunities.length} 项` : ''}</h2><p class="small save-note">按存档记录、已核对的前置与已整理阶段攻略列出；部分条件仍待核对，不保证当前可接。</p>${
        opportunities.length
          ? take(opportunities)
              .map((entry) => rule(entry))
              .join('')
          : '<p class="small muted">当前已整理的规则没有更多匹配线索，可继续浏览全部攻略。</p>'
      }</section>${chapter(flow)}<p class="flow-coverage small save-note">已索引 ${text(coverage.tasks ?? '—')} 条任务与步骤、${text(coverage.mainRoots ?? '—')} 条主线根任务；整理了 ${text(coverage.curatedRules ?? list(flow.guide).length)} 条关键攻略规则。精选规则不保证全任务防漏，未保存的变化不会计入。</p>${summary ? `<div class="flow-more">${summaryMore ? '<p class="small muted">这里展示前 3 项；完整流程保留全部任务和提醒。</p>' : ''}${button('navigate', '查看完整流程、攻略与主线索引', 'checklist', 'btn soft')}</div>` : offlineIndex(flow)}</section>`,
      'panel',
    );
  }
  return { panel, taskMaterials };
}
