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
    const labels = { met: '已满足', unmet: '未满足', unknown: '未确认' };
    return pill(labels[status] || '待核对', status === 'met' ? 'green' : status === 'unmet' ? 'orange' : '');
  };
  function conditions(rows) {
    const items = list(rows);
    return items.length
      ? `<ul class="flow-conditions">${items
          .map((row) => `<li><span>${prose(row.text)}</span>${statusPill(row.status)}</li>`)
          .join('')}</ul>`
      : '';
  }
  function target(value, action, prefix) {
    if (!value) return '';
    if (typeof value === 'string') return prose(value);
    const name = value.name || value.label || '';
    return new RegExp(`^${prefix}-\\d+$`).test(String(value.id || ''))
      ? button(action, name, value.id)
      : prose(name);
  }
  function sources(rows) {
    const items = list(rows);
    return items.length
      ? `<details class="flow-sources"><summary>资料来源</summary>${items
          .map(
            (source) =>
              `<p>${typeof source.id === 'string' && source.id ? button('source', source.title || '查看来源', source.id) : text(source.title || '来源待核对')}${source.date || source.version ? `<span class="small muted"> · ${[source.date, source.version].filter(Boolean).map(text).join(' · ')}</span>` : ''}</p>`,
          )
          .join('')}</details>`
      : '';
  }
  function choiceMaterials(row) {
    return materials(row.recommendation?.materials, [], row.recommendation?.materialLabel || '推荐路线备料');
  }
  function recommendation(row, { actionShown = false, materialsShown = false } = {}) {
    const value = row.recommendation;
    if (!value?.action || !value.reason) return '';
    return `<div class="flow-recommendation">${actionShown ? '' : `<p class="flow-recommended-action"><strong>推荐做法：</strong>${prose(value.action)}</p>`}<p><strong>为什么：</strong>${prose(value.reason)}</p>${value.goal ? `<p class="small muted">适合：${text(value.goal)}</p>` : ''}${value.tradeoff && value.tradeoff !== value.caution ? `<p class="small"><strong>取舍：</strong>${prose(value.tradeoff)}</p>` : ''}${materialsShown ? '' : choiceMaterials(row)}</div>`;
  }
  function delivery(row) {
    const options = list(row.deliveryOptions);
    return options.length
      ? `<section class="flow-delivery" data-flow-delivery><h4>可交付物品</h4><p class="small save-note">选择其中一种交付。</p><ul>${options.map((option) => `<li>${button('database-detail', option.name, option.id)}<p class="small">需 ${text(option.required)} 件 · ${option.owned === null ? '持有量未知' : `持有 ${text(option.owned)} 件${option.owned < option.required ? ` · 数量还缺 ${text(option.required - option.owned)} 件` : ' · 数量已齐'}`}</p>${questButton(option.questId, '查看交付步骤')}</li>`).join('')}</ul></section>`
      : '';
  }
  function advancement(row) {
    const affected = list(row.affectedTasks);
    if (!affected.length) return '';
    return `<div class="flow-affected" data-flow-affected><h4>推进后影响</h4><ul>${affected.map((task) => `<li>${questButton(task.questId, task.name) || prose(task.name)}：${prose(task.effect)}</li>`).join('')}</ul></div>`;
  }
  function rule(row, warning = false, scope = 'rule', previewShown = false) {
    const stage = row.kind === 'stage';
    const choices = list(row.choices);
    const steps = list(row.steps);
    const conditionRows = list(row.conditions);
    const stateLabel = { done: '已完成', failed: '已失败', active: '进行中' }[row.state];
    const pickup = row.pickup || {};
    const location = target(pickup.place, 'world-place', 'place');
    const person = target(pickup.person, 'database-detail', 'npc');
    const message =
      row.deadlineReached && !row.done && !row.failed
        ? '已越过提示节点，请确认任务是否仍可继续。'
        : row.compactWarning || row.message || row.warning || pickup.action;
    const fullWarning =
      row.warning && row.warning !== message
        ? `<p class="flow-warning-detail">${prose(row.warning)}</p>`
        : '';
    const pickupBody =
      location || person || pickup.action
        ? `<div class="flow-pickup">${location || person ? `<p>${location}${location && person ? ' · ' : ''}${person}</p>` : ''}${pickup.action ? `<p>${prose(pickup.action)}</p>` : ''}${pickup.executionPlace ? `<p class="small">前往 ${prose(pickup.executionPlace)}</p>` : ''}</div>`
        : '';
    const affected = list(row.affectedTasks);
    const body = `${fullWarning}${pickupBody}${!previewShown && (row.deadlineLabel || row.triggerName) ? `<p>截止：${prose(row.deadlineLabel || row.triggerName)}</p>` : ''}${affected.length ? advancement(row) : ''}${recommendation(row, { actionShown: previewShown && !warning && (row.recommendation?.hint || row.recommendation?.action) === row.recommendation?.action })}${delivery(row)}${conditions(conditionRows)}${steps.length ? `<ol class="flow-guide-steps">${steps.map((step) => `<li>${prose(step)}</li>`).join('')}</ol>` : ''}${choices.length ? `<div class="flow-choices"><h4>选择与影响</h4><dl>${choices.map((choice) => `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响未知')}</dd>`).join('')}</dl></div>` : ''}${affected.some((task) => questId(task.questId) === questId(row.questId || row.id)) ? '' : questButton(row.questId || row.id)}${row.uncertainty ? `<details><summary>资料说明</summary><p class="small">${text(row.uncertainty)}</p></details>` : ''}${sources(row.sources)}`;
    return persist(
      `<article class="flow-rule${warning ? ' flow-risk' : ''}" data-flow-rule="${text(row.id || '')}"${warning ? ` data-flow-warning="${text(row.id || row.questId || '')}"` : ''}>${previewShown ? `<div class="flow-rule-details">${body}</div>` : `${warning ? '' : `<div class="row between"><h3>${prose(row.name || row.title || '任务线索')}</h3>${stateLabel ? pill(stateLabel, row.state === 'done' ? 'green' : row.state === 'failed' ? 'orange' : '') : ''}</div>`}${message ? `<p class="flow-warning-message">${prose(message)}</p>` : ''}<details class="flow-rule-details"><summary>做法与影响</summary>${body}</details>`}</article>`,
      'rule-' + scope + '-' + row.id,
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
  function routeHeading(route) {
    const method = {
      buy: '购买',
      shop: '购买',
      merchant: '购买',
      gather: '采集',
      gathering: '采集',
      drop: '掉落',
    }[route.kind];
    const place = route.placeName || route.place;
    const person = route.personName;
    if (route.kind === 'quest') return '获取方式见任务步骤';
    if (method && (place || person))
      return `${person ? (route.personId ? button('database-detail', person, route.personId) : prose(person)) : ''}${person && place ? ' · ' : ''}${place ? (route.placeId ? button('world-place', place, route.placeId) : prose(place)) : ''} ${method}`;
    const label = ['物品资料来源', '采集来源', '本步骤的获取说明'].includes(route.label)
      ? route.detail || routeName(route)
      : route.label || route.detail || routeName(route);
    if (route.placeId) return button('world-place', label, route.placeId);
    if (route.personId) return button('database-detail', label, route.personId);
    return prose(label);
  }
  function routeDetail(route) {
    const detail = route.detail || '';
    // The location and method already convey these table descriptions.
    if (/^物品资料列.*(?:具体点位|单次数量)/.test(detail)) return '';
    if (/^(?:公开商店资料列售|资料标价)/.test(detail)) {
      const price = detail.match(/(?:配置单价|资料标价)\s*([\d.]+)\s*(?:铜钱|文)/);
      return price ? `参考价 ${price[1]} 文/件` : '';
    }
    if (/^2023-10-07社区区域表列/.test(detail)) return '';
    return !route.label || detail === route.label ? '' : detail;
  }
  function materialRows(
    rows,
    sharedMaterials,
    { details = true, bodyOnly = false, sources: briefs = {}, scope = 'current' } = {},
  ) {
    return list(rows)
      .map((material) => {
        const required =
          Number.isFinite(material.required) && material.required >= 0 ? material.required : null;
        const owned = Number.isFinite(material.owned) && material.owned >= 0 ? material.owned : null;
        const missing =
          required !== null && owned !== null && Number.isFinite(material.missing) && material.missing >= 0
            ? material.missing
            : null;
        const shared = list(sharedMaterials).find((row) => row.id === material.id);
        const sharedMissing = Number.isFinite(shared?.missing) && shared.missing >= 0 ? shared.missing : null;
        const stock = [
          required === null ? '需求未读取' : `需 ${required}`,
          owned === null ? '库存未读取' : `持有 ${owned}`,
        ];
        if (missing !== null && missing > 0 && !shared) stock.push(`缺 ${missing}`);
        if (sharedMissing !== null && sharedMissing > 0) stock.push(`多任务合计缺 ${sharedMissing}`);
        if (missing === null && required !== null && owned !== null) stock.push('缺口未读取');
        const routes = list(material.routes);
        const primary = routes.filter((route) => !route.alternative && route.kind !== 'unknown');
        const alternatives = routes.filter((route) => route.alternative);
        const first = primary[0];
        const brief = briefs[material.id]
          ? prose(briefs[material.id])
          : first
            ? routeHeading(first)
            : '暂无获取地点';
        const evidence = (route) => {
          const efficiency = route.efficiency || '';
          return `${efficiency && !/^(?:效率待核对|暂无效率数据)[。.]*$/.test(efficiency) ? `<p class="small">${prose(efficiency)}</p>` : ''}${sources(route.sources)}`;
        };
        const routeRow = (route, isFirst = false) =>
          `${isFirst ? '' : `<h4>${routeHeading(route)}</h4>`}${routeDetail(route) ? `<p>${prose(routeDetail(route))}</p>` : ''}${evidence(route)}`;
        const body = `${first ? routeRow(first, !briefs[material.id]) : ''}${primary
          .slice(1)
          .map((route) => routeRow(route))
          .join(
            '',
          )}${alternatives.length ? `<details class="flow-material-alternatives"><summary>其他获取路线 · ${alternatives.length}</summary>${alternatives.map((route) => routeRow(route)).join('')}</details>` : ''}`;
        if (bodyOnly)
          return body
            ? persist(
                `${list(rows).length > 1 ? `<h4>${button('database-detail', material.name, material.id)}</h4>` : ''}${body}`,
                `material-${scope}-${material.id}`,
              )
            : '';
        return persist(
          `<div class="flow-material"><div class="row between">${button('database-detail', material.name, material.id)}<span class="flow-stock">${stock.map(text).join(' · ')}</span></div>${brief ? `<p class="flow-source-brief">${brief}</p>` : ''}${details && body ? `<details class="flow-material-details"><summary>获取详情</summary>${body}</details>` : ''}</div>`,
          `material-${scope}-${material.id}`,
        );
      })
      .join('');
  }
  function materials(rows, sharedMaterials = [], heading = '这一步需要的材料', scope = heading) {
    return list(rows).length
      ? `<div class="flow-materials">${heading ? `<h4>${icon('bag')} ${text(heading)}</h4>` : ''}${materialRows(rows, sharedMaterials, { scope })}</div>`
      : '';
  }
  function sharedMaterialSummary(rows) {
    const shared = list(rows);
    return shared.length
      ? `<aside class="flow-shared-materials"><h3>多任务共用材料</h3>${shared
          .map(
            (material) =>
              `<p>${button('database-detail', material.name, material.id)} · 合计需 ${text(material.required)}${material.owned === null ? ' · 库存待核对' : ` · 持有 ${text(material.owned)} · 还差 ${text(material.missing)}`}</p><details data-persist-detail="shared-material-${text(material.id)}-${text(
                list(material.steps)
                  .map((row) => row.id)
                  .sort()
                  .join('-'),
              )}"><summary>哪些步骤会用到</summary><p class="small save-note">按下列步骤的合计量预留，不包含其他未接任务与后续步骤。</p><ul>${list(
                material.steps,
              )
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
    const action = prose(row.nextAction || row.description);
    const materialPlaces = new Set(
      list(row.materials).flatMap((material) =>
        list(material.routes)
          .filter((route) => !route.alternative)
          .map((route) => route.placeId),
      ),
    );
    // Keep an exact target when prose only resolves to a namesake chooser.
    const unlinked = (entry) => !entry.id || !action.includes(`data-entity-id="${text(entry.id)}"`);
    const people = list(row.people)
      .filter(unlinked)
      .map((person) => target(person, 'database-detail', 'npc'));
    const places = list(row.places)
      .filter(
        (place) =>
          !['description-mention', 'literal-mention', '当前任务文字提及'].includes(place.evidence) ||
          !materialPlaces.has(place.id),
      )
      .filter(unlinked)
      .map((place) => target(place, 'world-place', 'place'));
    return people.length || places.length
      ? `<p class="flow-targets">${people.join('、')}${people.length && places.length ? ' · ' : ''}${places.join('、')}</p>`
      : '';
  }
  function compactMaterials(rows, sharedMaterials = [], options = {}) {
    return list(rows).length
      ? `<div class="flow-material-brief">${materialRows(rows, sharedMaterials, options)}</div>`
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
                `<article data-flow-quest="${text(task.id)}"><h3>${questButton(task.id, task.name) || text(task.name)}</h3>${!compact && row.id !== task.id && row.name !== task.name ? `<p class="small">${questButton(row.id, row.name) || text(row.name)}</p>` : ''}${compact ? compactMaterials(row.materials, flow.sharedMaterials, { scope: `${task.id}-${row.id}` }) : materials(row.materials, flow.sharedMaterials, '', `${task.id}-${row.id}`)}</article>`,
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
      `<div class="flow-step">${summaryInLead || row.id === rootId || row.name === row.nextAction ? '' : `<h4>${questButton(row.id, row.name || '当前步骤') || prose(row.name || '当前步骤')}</h4>`}${summaryInLead ? '' : `<p class="flow-next-action"><span class="small muted">当前行动 </span>${prose(row.nextAction || row.description || '请打开任务资料，核对当前要求。')}</p>`}${row.description && row.description !== row.nextAction ? `<details><summary>任务说明 · 可能涉及剧情</summary><p class="preserve-text">${prose(row.description)}</p></details>` : ''}${summaryInLead ? '' : stepPeople(row) + stepPlaces(row)}${conditions(row.requirements)}${summaryInLead ? '' : materials(row.materials, sharedMaterials)}${upcoming.length ? `<details class="flow-upcoming"><summary>后续相关步骤与分支 · 涉及剧情</summary><ul>${upcoming.map((next) => `<li>${questButton(next.id, next.name) || text(next.name)}${next.reason ? `<p class="small muted">${text(next.reason)}</p>` : ''}</li>`).join('')}</ul></details>` : ''}</div>`,
      'step-' + row.id,
    );
  }
  function decision(row, { compact = false } = {}) {
    const value = row.recommendation;
    const action = value?.summary || value?.hint || value?.compact?.action || value?.action || row.warning;
    const caution = value?.caution || row.compactWarning;
    const materialLabel = String(value?.materialLabel || '').split(/[；;]/);
    const acquisition = materialRows(value?.materials, [], {
      bodyOnly: true,
      sources: value?.materialSources,
      scope: 'choice-' + row.id,
    });
    return persist(
      `<aside class="flow-decision" data-flow-decision="${text(row.id)}"><p class="flow-recommended-action">${prose(action)}</p>${caution && caution !== action ? `<p class="flow-caution">${prose(caution)}</p>` : ''}${list(value?.materials).length && value.materialLabel ? `<p class="small flow-choice-material-label">${text(materialLabel[0])}</p>` : ''}${compactMaterials(value?.materials, [], { details: false, sources: value?.materialSources, scope: row.id })}<details class="flow-choice-details" data-persist-detail="flow-choice-${text(row.id)}${row.live ? `-${text(row.liveSequence)}` : ''}"><summary>为什么这样选 · 各选项影响</summary><h3>${questButton(row.questId, row.name) || prose(row.name)}</h3>${recommendation(row, { actionShown: action === value?.action, materialsShown: true })}${materialLabel.length > 1 ? `<p class="small">${text(materialLabel.slice(1).join('；'))}</p>` : ''}${acquisition ? `<section data-flow-choice-acquisition><h4>材料获取详情</h4>${acquisition}</section>` : ''}${row.pickup?.place || row.pickup?.person ? `<p class="flow-choice-location">${target(row.pickup.place, 'world-place', 'place')}${row.pickup.person ? ` · ${target(row.pickup.person, 'database-detail', 'npc')}` : ''}</p>` : ''}<p>${prose(row.warning)}</p>${conditions(row.conditions)}<dl class="flow-choices">${list(
        row.choices,
      )
        .map((choice) => `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响待核对')}</dd>`)
        .join(
          '',
        )}</dl>${row.uncertainty ? `<details><summary>资料说明</summary><p class="small save-note">${text(row.uncertainty)}</p></details>` : ''}${sources(row.sources)}</details></aside>`,
      (compact ? 'compact-choice-' : 'decision-') + row.id,
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
      `<article class="flow-task"${summaryInLead ? '' : ` data-flow-quest="${text(task.id || '')}"`}>${summaryInLead ? '' : `<div class="row between"><h3>${questButton(task.id, task.name) || text(task.name)}</h3>${pill(task.kind === 'Primary' ? '主线' : '支线', task.kind === 'Primary' ? 'green' : '')}</div>`}${steps.length ? steps.map((row, index) => step(row, task.id, { summaryInLead: summaryInLead && index === 0, sharedMaterials })).join('') : '<p class="small muted">这份存档只有任务记录，尚无可展示的当前步骤；请核对任务资料。</p>'}${progress.length ? `<details class="flow-task-progress"><summary>已记录的步骤 · ${text(counts)}</summary><ul class="flow-progress-list">${progress.map((row) => `<li>${questButton(row.id, row.name)}${pill(row.status, row.status === '已完成' ? 'green' : row.status === '已失败' ? 'orange' : '')}</li>`).join('')}</ul></details>` : ''}</article>`,
      'task-' + task.id,
    );
  }
  function chapter(flow) {
    const current = flow.chapter;
    const changes = list(flow.changes);
    if (!current && !changes.length) return '';
    return `<section class="flow-chapter"><h2>主线节点与阶段变化</h2>${current ? `<h3>${prose(current.name || '当前主线')}</h3>${current.mainName ? `<p>${prose(current.mainName)}</p>` : ''}${questButton(current.questId)}${current.next ? `<p><span class="small muted">推进前核对的节点 </span>${questButton(current.next.questId, current.next.title) || text(current.next.title)}</p>` : ''}${current.nextMilestone ? `<p><span class="small muted">下一主线关键节点 </span>${questButton(current.nextMilestone.questId, current.nextMilestone.title) || text(current.nextMilestone.title)}</p><p class="small save-note">${text(current.nextMilestone.note)}</p>${sources(current.nextMilestone.sources)}` : ''}` : ''}${changes.length ? `<ul class="flow-changes">${changes.map((change) => `<li><strong>${prose(change.title || '任务变化')}</strong>${change.triggerName ? `<p><span class="small muted">推进关联 </span>${prose(change.triggerName)}</p>` : ''}${change.consequence ? `<p>${prose(change.consequence)}</p>` : ''}${advancement(change)}</li>`).join('')}</ul>` : ''}</section>`;
  }
  function offlineIndex(flow) {
    const guide = list(flow.guide);
    const chapters = list(flow.chapters);
    return persist(
      `${guide.length ? `<details class="flow-guide"><summary>全部关键攻略条目 · ${guide.length} 项</summary>${guide.map((entry) => rule(entry, false, 'offline')).join('')}</details>` : ''}${
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
              .join('')}</details>`
          : ''
      }`,
      'offline',
    );
  }
  const compactAdvice = (row) =>
    persist(
      `<article class="flow-suggestion" data-flow-suggestion="${text(row.id)}"><p>${prose(row.recommendation?.hint || row.recommendation?.action || row.pickup?.action || row.warning)}</p><details><summary>做法与理由</summary>${rule(row, false, 'advice', true)}</details></article>`,
      `compact-advice-${row.id}`,
    );
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
    const compactDecision = (row) => decision(row, { compact: true });
    const first = active[0];
    const firstStep = first?.steps?.[0];
    const lead = first
      ? `<section class="flow-now flow-active" data-flow-now data-flow-quest="${text(first.id)}"><h3>${questButton(first.id, first.name)}</h3><p class="flow-next-action">${prose(firstStep?.nextAction || firstStep?.description || '请核对游戏任务栏中的当前要求。')}</p>${firstStep ? compactStepTargets(firstStep) + compactMaterials(firstStep.materials, flow.sharedMaterials, { scope: `${first.id}-${firstStep.id}` }) : ''}<details class="flow-now-details" data-persist-detail="flow-now-${text(first.id)}-${text(firstStep?.id)}"><summary>条件与完整步骤</summary>${firstStep ? stepPeople(firstStep) + stepPlaces(firstStep) : ''}${activeTask(first, { summaryInLead: true, sharedMaterials: flow.sharedMaterials })}</details></section>`
      : `<div class="flow-empty"><p>${text(flow.reason || (flow.available ? '当前步骤待核对，可展开下方流程线索。' : '尚无可读存档，可先查询攻略。'))}</p>${flow.referenceNeedsSelection ? button('navigate', '检查游戏连接', 'settings', 'btn soft') : ''}</div>`;
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
        )}" open><summary><strong>推进前确认 · ${warnings.length} 项</strong></summary>${groups.map(({ deadline, rows }) => `<details class="flow-risk-window" data-persist-detail="flow-risk-window-${text(rows[0].id)}"><summary>${deadline && rows.some((row) => !row.compactWarning && !String(riskPreview(row)).includes(deadline.replace(/(?:之前|前)$/, ''))) ? `<span class="flow-risk-deadline">${prose(deadline)}</span>` : ''}${rows.map((row) => `<span class="flow-risk-preview">${prose(riskPreview(row))}</span>`).join('')}</summary>${rows.map((row) => `<div data-flow-impact="${text(row.id)}">${rule(row, true, 'risk', true)}</div>`).join('')}</details>`).join('')}</details></section>`
      : '';
    const current = decisions.length
      ? `<details class="flow-task-peek" data-persist-detail="flow-task-peek-${text(first?.id)}"><summary>当前任务 · ${prose(first?.name || '步骤待核对')}</summary>${lead}</details>`
      : lead;
    return persist(
      `<section class="flow-panel flow-compact" data-flow>${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${compactDecision(decisions[0])}${decisions.length > 1 ? `<details data-persist-detail="compact-more-choices"><summary>其他关键选择 · ${decisions.length - 1}</summary>${decisions.slice(1).map(compactDecision).join('')}</details>` : ''}</section>` : ''}${urgent}${decisions.length ? '' : current}${visibleSections.has('advice') && advice.length ? `<section class="flow-advice"><h2>顺路可做</h2>${compactAdvice(advice[0])}${advice.length > 1 ? `<details data-persist-detail="compact-more-advice"><summary>更多建议 · ${advice.length - 1}</summary>${advice.slice(1).map(compactAdvice).join('')}</details>` : ''}</section>` : ''}${decisions.length ? current : ''}${
        active.length > 1
          ? `<details data-persist-detail="compact-other-active" class="flow-all-active"><summary>其他进行中任务 · ${active.length - 1}</summary>${active
              .slice(1)
              .map((task) => activeTask(task, { sharedMaterials: flow.sharedMaterials }))
              .join('')}</details>`
          : ''
      }${list(flow.unindexedActive).length ? `<details data-persist-detail="compact-unindexed" class="flow-unindexed" data-flow-unindexed><summary>另有 ${flow.unindexedActive.length} 条进行中记录待识别</summary><p class="small save-note">请核对游戏任务栏；资料尚不能确定这些记录的名称与下一步。</p></details>` : ''}${visibleSections.has('opportunities') ? `<details data-persist-detail="compact-opportunities" class="flow-opportunities"><summary>未接任务线索 · ${opportunities.length}</summary>${opportunities.map((row) => rule(row, false, 'opportunity')).join('') || '<p class="small muted">暂未匹配到接取线索。</p>'}</details>` : ''}${visibleSections.has('milestones') ? `<details data-persist-detail="compact-stage" class="flow-stage-details"><summary>下一节点与阶段变化</summary>${chapter(flow) || '<p class="small muted">当前主线节点待核对。</p>'}${flow.stageUncertainty ? `<p class="small save-note" data-flow-stage-uncertain>${text(flow.stageUncertainty)}</p>` : ''}</details>` : ''}${list(flow.guide).length || list(flow.chapters).length ? `<details class="flow-offline-details" data-persist-detail="compact-offline"><summary>全部流程资料</summary>${offlineIndex(flow)}</details>` : ''}</section>`,
      'compact-panel',
    );
  }
  function panel(flow, { compact = false, summary = false, sections } = {}) {
    if (!flow) flow = { available: false, reason: '正在核对流程资料。' };
    if (compact) return compactPanel(flow, sections);
    if (flow.available === false && !list(flow.decisions).some((row) => row.live)) {
      const updating = /^(正在核对|存档正在更新)/.test(flow.reason || '');
      const offline = flow.referenceMode === 'none';
      return persist(
        `<section class="flow-panel${summary ? ' flow-summary' : ''}" data-flow><div class="flow-heading"><p${updating ? ' role="status"' : ''}>${updating ? '正在更新进度…' : offline ? '查询流程资料' : '暂无可读进度'}</p>${!updating && !offline ? button('navigate', '检查游戏连接', 'settings') : ''}</div>${summary ? `<div class="flow-more">${button('navigate', '查看完整流程、攻略与主线索引', 'checklist', 'btn soft')}</div>` : offlineIndex(flow)}</section>`,
        'panel',
      );
    }
    const decisions = list(flow.decisions);
    const decisionIds = new Set(decisions.map((row) => row.id));
    const warnings = list(flow.warnings).filter((row) => !decisionIds.has(row.id));
    const advice = list(flow.advice).filter(
      (row) => (row.activeRule || row.kind === 'stage') && !decisionIds.has(row.id),
    );
    const active = list(flow.active);
    const activeCard = (task) => {
      const next = list(task.steps)[0];
      return `<article class="flow-task flow-task-summary" data-flow-quest="${text(task.id)}"><div class="row between"><h3>${questButton(task.id, task.name)}</h3>${pill(task.kind === 'Primary' ? '主线' : '支线')}</div>${next ? `<p class="flow-next-action">${prose(next.nextAction || next.description)}</p>${compactStepTargets(next)}${compactMaterials(next.materials, flow.sharedMaterials, { scope: 'main-' + task.id })}` : ''}<details data-persist-detail="main-task-${text(task.id)}"><summary>完整步骤</summary>${activeTask(task, { summaryInLead: true, sharedMaterials: flow.sharedMaterials })}</details></article>`;
    };
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
    const riskContent = warnings.map((warning) => rule(warning, true, 'risk')).join('');
    return persist(
      `<section class="flow-panel${compact ? ' flow-compact' : ''}${summary ? ' flow-summary' : ''}${warnings.length ? ' flow-has-risks' : ''}" data-flow>${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${decisions.map(decision).join('')}</section>` : ''}${warnings.length ? `<section class="flow-risks"><h2>${icon('pin')} 推进前确认</h2>${riskContent}</section>` : ''}<section class="flow-active"><h2>当前任务与下一行动${active.length ? ` · ${active.length} 项` : ''}</h2>${sharedMaterialSummary(
        shared,
      )}${unindexed.length ? `<aside class="flow-unindexed" data-flow-unindexed><details><summary>另有 ${unindexed.length} 条进行中记录待识别</summary><p class="small save-note">这些记录尚未收录在任务资料中，可能是隐藏剧情或版本新增任务。请核对游戏任务栏中额外进行中的任务；这里暂不能判断名称与下一步。</p></details></aside>` : ''}${activeBody || `<p class="small muted">${flow.available ? '暂无进行中步骤，可在下方查找任务。' : '连接游戏进度后显示当前行动。'}</p>`}</section>${
        advice.length
          ? `<section class="flow-advice"><h2>推荐做法</h2>${compactAdvice(advice[0])}${
              advice.length > 1
                ? `<details data-persist-detail="main-more-advice"><summary>更多建议 · ${advice.length - 1}</summary>${advice
                    .slice(1)
                    .map((row) => rule(row, false, 'advice'))
                    .join('')}</details>`
                : ''
            }</section>`
          : ''
      }<section class="flow-opportunities"><h2>未接取任务与接取线索${opportunities.length ? ` · ${opportunities.length} 项` : ''}</h2>${
        opportunities.length
          ? rule(opportunities[0], false, 'opportunity') +
            (opportunities.length > 1
              ? `<details data-persist-detail="main-more-opportunities"><summary>更多未接任务 · ${opportunities.length - 1}</summary>${opportunities
                  .slice(1)
                  .map((entry) => rule(entry, false, 'opportunity'))
                  .join('')}</details>`
              : '')
          : '<p class="small muted">当前已整理的规则没有更多匹配线索，可继续浏览全部攻略。</p>'
      }</section>${chapter(flow)}${summary ? `<div class="flow-more">${button('navigate', '查看完整流程、攻略与主线索引', 'checklist', 'btn soft')}</div>` : offlineIndex(flow)}</section>`,
      'panel',
    );
  }
  return { panel, taskMaterials, choice: decision };
}
