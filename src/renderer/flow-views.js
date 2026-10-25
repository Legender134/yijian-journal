import { createQuestEffectViews } from './quest-effect-views.js';

export function createFlowViews({ esc, act, icon, pill, when, richText = esc, index = null }) {
  const effects = createQuestEffectViews({ esc, act });
  const currentIndex = typeof index === 'function' ? index : () => index;
  const list = (value) => (Array.isArray(value) ? value : []);
  const text = (value) => esc(String(value ?? ''));
  const roleText = (role) =>
    !role || ['交互配置', '任务文字提及', '交互'].includes(role) ? '' : text(role) + ' ';
  const prose = (value, targets) => richText(String(value ?? ''), targets);
  const stepAction = (row) => richText(String(row.nextAction || row.description || ''), row.targets);
  const stateNotice = (flow) =>
    flow?.stateNotice
      ? `<p class="notice info flow-state-notice" role="status">${text(flow.stateNotice)}</p>`
      : '';
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
          .map(
            (row) =>
              `<li><span>${row.entityId && row.text?.startsWith(row.name) ? questButton(row.entityId, row.name) + text(row.text.slice(row.name.length)) : prose(row.text)}</span>${row.progress ? pill(`${row.progress.current} / ${row.progress.total}`, row.status === 'met' ? 'green' : 'orange') : statusPill(row.status)}${list(row.alternatives).length ? `<div class="related-items">${row.alternatives.map((item) => `${button('database-detail', item.name + (item.quality ? ' · ' + item.quality : ''), 'item-' + item.id)}${item.owned === null ? '' : pill('持有 ' + item.owned)}`).join('')}</div>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  }
  function target(value, action, prefix) {
    if (!value) return '';
    if (typeof value === 'string') return prose(value);
    const name = value.name || value.label || '';
    return new RegExp(`^${prefix}-\\d+${prefix === 'place' ? '(?::[A-Za-z0-9_]+)?' : ''}$`).test(
      String(value.id || ''),
    )
      ? button(action, name, value.id)
      : richText(name, prefix === 'place' ? { places: [value] } : undefined);
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
  function collectionStops(row) {
    const stops = list(row.collectionStops);
    return stops.length
      ? `<ol class="flow-guide-steps flow-collection-stops" data-flow-collection-stops>${stops.map((stop) => `<li data-gather-id="${text(stop.gatherId)}"><strong>${prose(stop.label, stop.targets)}</strong>${stop.effect ? `<p>${prose(stop.effect, stop.targets)}</p>` : ''}</li>`).join('')}</ol>`
      : '';
  }
  function recommendation(row, { actionShown = false, materialsShown = false } = {}) {
    const value = row.recommendation;
    if (!value?.action || !value.reason) return '';
    return `<div class="flow-recommendation">${actionShown ? '' : `<p class="flow-recommended-action"><strong>推荐做法：</strong>${prose(value.action, value.targets)}</p>`}<p><strong>为什么：</strong>${prose(value.reason, value.targets)}</p>${value.goal ? `<p class="small muted">适合：${text(value.goal)}</p>` : ''}${value.tradeoff && value.tradeoff !== value.caution ? `<p class="small"><strong>取舍：</strong>${prose(value.tradeoff, value.targets)}</p>` : ''}${materialsShown ? '' : choiceMaterials(row)}</div>`;
  }
  function reasonBrief(row, tag = 'p') {
    const value = row.recommendation;
    return value?.reasonBrief
      ? `<${tag} class="small flow-reason-brief">${prose(value.reasonBrief, value.targets)}</${tag}>`
      : '';
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
    const closedWindow = row.deadlineReached && row.closedWindowMessage;
    const heading = closedWindow
      ? affected.every((task) => task.scope === 'departure')
        ? '出发条件'
        : '接取条件'
      : '推进后影响';
    return `<div class="flow-affected" data-flow-affected><h4>${heading}</h4><ul>${affected.map((task) => `<li>${questButton(task.questId, task.name) || prose(task.name)}：${prose(closedWindow ? task.closedEffect || task.effect : task.effect)}</li>`).join('')}</ul></div>`;
  }
  function rule(
    row,
    warning = false,
    scope = 'rule',
    previewShown = false,
    { actionShown = previewShown, previewText } = {},
  ) {
    const stage = row.kind === 'stage';
    const choices = list(row.choices);
    const steps = list(row.steps);
    const conditionRows = list(row.conditions);
    const stateLabel = { done: '已完成', failed: '已失败', active: '进行中' }[row.state];
    const pickup = row.pickup || {};
    const location = target(pickup.place, 'world-place', 'place');
    const person = target(pickup.person, 'database-detail', 'npc');
    const closedWindow =
      row.deadlineReached &&
      !row.done &&
      !row.failed &&
      (!row.activeRule || row.activeWindowBlocked) &&
      row.closedWindowMessage;
    const message =
      (closedWindow ? row.closedWindowSummary || closedWindow : '') ||
      (row.deadlineReached && !row.done && !row.failed
        ? '已越过提示节点，请确认任务是否仍可继续。'
        : row.compactWarning || row.message || row.warning || pickup.action);
    const fullWarning =
      !closedWindow && row.warning && row.warning !== (previewText ?? message)
        ? `<p class="flow-warning-detail">${prose(row.warning)}</p>`
        : '';
    const pickupBody =
      !closedWindow && (location || person || pickup.action)
        ? `<div class="flow-pickup">${location || person ? `<p>${location}${location && person ? ' · ' : ''}${person}</p>` : ''}${pickup.action ? `<p>${prose(pickup.action)}</p>` : ''}${pickup.executionPlace ? `<p class="small">前往 ${prose(pickup.executionPlace)}</p>` : ''}</div>`
        : '';
    const affected = list(row.affectedTasks);
    const routeBody = `${recommendation(row, { actionShown: actionShown && !warning && (row.recommendation?.hint || row.recommendation?.action) === row.recommendation?.action })}${delivery(row)}${collectionStops(row)}${steps.length ? `<ol class="flow-guide-steps">${steps.map((step) => `<li>${prose(step)}</li>`).join('')}</ol>` : ''}${choices.length ? `<div class="flow-choices"><h4>选择与影响</h4><dl>${choices.map((choice) => `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响未知', choice.targets)}</dd>`).join('')}</dl></div>` : ''}`;
    const routeDetails =
      closedWindow && routeBody
        ? `<details class="flow-previous-route"><summary>此前做法与分支</summary>${routeBody}</details>`
        : routeBody;
    const body = `${fullWarning}${pickupBody}${!closedWindow && !previewShown && (row.deadlineLabel || row.triggerName) ? `<p>截止：${prose(row.deadlineLabel || row.triggerName)}</p>` : ''}${affected.length ? advancement(row) : ''}${conditions(conditionRows)}${routeDetails}${affected.some((task) => questId(task.questId) === questId(row.questId || row.id)) ? '' : questButton(row.questId || row.id)}${row.uncertainty ? `<details><summary>资料说明</summary><p class="small">${text(row.uncertainty)}</p></details>` : ''}${sources(row.sources)}`;
    return persist(
      `<article class="flow-rule${warning ? ' flow-risk' : ''}" data-flow-rule="${text(row.id || '')}"${warning ? ` data-flow-warning="${text(row.id || row.questId || '')}"` : ''}>${previewShown ? `<div class="flow-rule-details">${body}</div>` : `${warning ? '' : `<div class="row between"><h3>${prose(row.name || row.title || '任务线索')}</h3>${stateLabel ? pill(stateLabel, row.state === 'done' ? 'green' : row.state === 'failed' ? 'orange' : '') : ''}</div>`}${message ? `<p class="flow-warning-message">${prose(message)}</p>` : ''}${warning && !row.deadlineReached ? reasonBrief(row) : ''}<details class="flow-rule-details"><summary>做法与影响</summary>${body}</details>`}</article>`,
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
      'description-mention': '',
      'literal-mention': '',
      'scene-placement': '',
      'interaction-target': '',
      当前任务文字提及: '',
    })[value] ??
    (typeof value === 'string' && /[\u3400-\u9fff]/.test(value) ? value : '资料线索，当前位置待核对');
  function stepPeople(row) {
    const people = list(row.people);
    return people.length
      ? `<div class="flow-people">${people.map((person) => `<span>${roleText(person.role)}${target(person, 'database-detail', 'npc')}</span>`).join(' · ')}</div>`
      : '';
  }
  function stepPlaces(row) {
    const places = list(row.places);
    return places.length
      ? `<div class="flow-places">${places.map((place) => `<p><span class="small muted">地点线索 </span>${target(place, 'world-place', 'place')}${place.evidence && placeEvidence(place.evidence) ? `<span class="small muted"> · ${text(placeEvidence(place.evidence))}</span>` : ''}</p>`).join('')}</div>`
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
    { details = true, bodyOnly = false, sources: briefs = {}, scope = 'current', instruction = '' } = {},
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
        const brief =
          (instruction && missing === 0 && !(sharedMissing > 0)) ||
          (instruction && first?.instruction === instruction)
            ? ''
            : briefs[material.id]
              ? prose(briefs[material.id])
              : first
                ? routeHeading(first)
                : '暂无获取地点';
        const evidence = (route) => {
          const efficiency = route.efficiency || '';
          return `${efficiency && !/^(?:效率待核对|暂无效率数据)[。.]*$/.test(efficiency) ? `<p class="small">${prose(efficiency)}</p>` : ''}${sources(route.sources)}`;
        };
        const routeRow = (route, isFirst = false) => {
          const heading = routeHeading(route);
          const detail = prose(routeDetail(route));
          return `${isFirst ? '' : `<h4>${heading}</h4>`}${detail && (detail !== heading || (bodyOnly && isFirst)) ? `<p>${detail}</p>` : ''}${evidence(route)}`;
        };
        const body = `${first ? routeRow(first, !!brief && !briefs[material.id]) : ''}${primary
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
          `<div class="flow-material"><div class="row between">${button('database-detail', material.name, material.id)}<span class="flow-stock">${stock.map(text).join(' · ')}</span></div>${details && body ? `<details class="flow-material-details"><summary>${brief || '获取方式'}</summary>${body}</details>` : brief ? `<p class="flow-source-brief">${brief}</p>` : ''}</div>`,
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
                    `<li>${questButton(row.detailId || row.id, row.taskName + ' · ' + row.name)} · ${text(row.required)}</li>`,
                )
                .join('')}</ul></details>`,
          )
          .join('')}</aside>`
      : '';
  }
  function compactStepTargets(row) {
    if (row.blockedWindow) return '';
    const action = stepAction(row);
    // Keep an exact target when prose only resolves to a namesake chooser.
    const unlinked = (entry) =>
      entry.id
        ? !action.includes(`data-entity-id="${text(entry.id)}"`)
        : !(entry.mentions || [entry.name]).some((name) =>
            ['name:', 'place-name:'].some((prefix) =>
              action.includes(`data-entity-id="${prefix}${text(name)}"`),
            ),
          );
    const people = list(row.targets?.people)
      .filter(unlinked)
      .map((person) => `${roleText(person.role)}${target(person, 'database-detail', 'npc')}`);
    const places = list(row.targets?.places)
      .filter(
        (place) =>
          place.purpose !== 'material-source' ||
          !list(row.materials).some((material) =>
            list(material.routes).some(
              (route) => route.place === place.name || route.placeName === place.name,
            ),
          ),
      )
      .filter(unlinked)
      .map((place) => ({ ...place, link: target(place, 'world-place', 'place') }));
    const placeLabel = (purpose, action) =>
      ({
        'turn-in': action === '交谈' ? '交谈地点 ' : '交付地点 ',
        'conditional-turn-in': action === '交谈' ? '备齐后交谈 ' : '集齐后交付 ',
        'material-source': '获取地点 ',
        departure: '离开 ',
      })[purpose] || '前往 ';
    const samePurpose = places.every(
      (place) => (place.purpose || row.targets.purpose) === (places[0]?.purpose || row.targets.purpose),
    );
    const placeText = samePurpose
      ? placeLabel(places[0]?.purpose || row.targets?.purpose, places[0]?.action) +
        places.map((place) => place.link).join(places[0]?.purpose === 'material-source' ? '、' : ' → ')
      : places.map((place) => placeLabel(place.purpose, place.action) + place.link).join(' → ');
    return people.length || places.length
      ? `<p class="flow-targets">${people.join('、')}${people.length && places.length ? ' · ' : ''}${places.length ? placeText : ''}</p>`
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
                `<article data-flow-quest="${text(task.id)}"><h3>${questButton(task.id, task.name) || text(task.name)}</h3>${!compact && row.id !== task.id && row.name !== task.name ? `<p class="small">${questButton(row.detailId || row.id, row.name) || text(row.name)}</p>` : ''}${compact ? compactMaterials(row.materials, flow.sharedMaterials, { scope: `${task.id}-${row.id}` }) : materials(row.materials, flow.sharedMaterials, '', `${task.id}-${row.id}`)}</article>`,
            )
            .join('')
        : recommended.length
          ? ''
          : `<p class="small muted">${active.length ? '当前已识别的进行中步骤暂无可展示的材料需求。' : '暂无可识别进行中步骤的材料需求，请核对游戏任务栏。'}</p>`;
    if (flow?.available && !needs.length && !recommended.length && !list(flow.sharedMaterials).length)
      return persist(
        `<details class="flow-task-materials" data-flow-task-materials data-persist-detail="empty-task-materials"><summary>任务备料 · 暂无已知需求</summary>${body}</details>`,
        'task-materials',
      );
    return persist(
      `<section class="flow-task-materials" data-flow-task-materials><h2>当前任务备料</h2>${flow?.available ? (compact && list(flow.sharedMaterials).length ? `<details data-persist-detail="task-shared-materials"><summary>共用材料 · 按合计量预留</summary>${sharedMaterialSummary(flow.sharedMaterials)}</details>` : sharedMaterialSummary(flow.sharedMaterials)) : ''}${body}${recommended.map((row) => `<article data-flow-rule="${text(row.id)}"><h3>${questButton(row.questId, row.name)}</h3>${compact ? `<p class="small">${text(row.recommendation.materialLabel)}</p>${compactMaterials(row.recommendation.materials, [], { scope: row.id })}` : choiceMaterials(row)}</article>`).join('')}</section>`,
      'task-materials',
    );
  }
  function choiceChanges(row, flow, { label = false } = {}) {
    const id = row.choiceStepId;
    if (!flow?.available || !Number.isSafeInteger(id)) return '';
    // Curated advice wins only for the exact covered step. Generic labels such
    // as 答应/拒绝 can occur repeatedly within one quest family.
    if (
      list(flow.decisions).some(
        (decision) =>
          list(decision.decisionSteps).includes(id) ||
          list(decision.coveredChoiceSteps).includes(id) ||
          (decision.live && flow.liveDialogue?.questId === id),
      )
    )
      return '';
    const data = currentIndex();
    if (!data?.codex) return '';
    const published = list(data.world?.quests).find((quest) => quest.gameId === id);
    const hidden = data.codex.hiddenSteps?.[id];
    const quest = published || (hidden && { gameId: id, parentId: hidden.ownerId });
    if (!quest?.parentId) return '';
    const detail = published ? data.codex.quests?.[id] : hidden;
    const choices = effects.choiceRows(data, detail, quest);
    if (!choices.length) return '';
    const consequences = choices
      .filter((choice) => choice.important.length)
      .map(
        (choice) =>
          `<p class="small flow-caution" data-flow-choice-consequence>选择「${text(choice.text)}」：${choice.important.join('；')}</p>`,
      )
      .join('');
    const rows = choices
      .map(
        (choice) =>
          `<dt>${text(choice.text)}${list(choice.requirements).length ? '（有出现条件）' : ''}</dt><dd>${choice.shown.length ? choice.shown.join('；') : '后续变化待核对'}</dd>`,
      )
      .join('');
    const conditionSource = choices.some((choice) => list(choice.requirements).length)
      ? questButton(published?.id || hidden?.relatedQuestId, '查看选项出现条件')
      : '';
    return `<section class="flow-step-choices" data-flow-native-choice="${text(id)}">${consequences}<details class="flow-choice-details" data-persist-detail="flow-native-choice-${text(id)}"><summary>选项变化${label ? ` · ${text(row.name)}` : ''}</summary><dl class="flow-choices">${rows}</dl>${conditionSource ? `<p>${conditionSource}</p>` : ''}<details><summary>资料来源</summary><p>游戏任务表 · 原始步骤 ${text(id)}</p></details></details></section>`;
  }
  function taskChoiceEntries(task, flow) {
    const data = currentIndex();
    const published = new Map(list(data?.world?.quests).map((quest) => [quest.gameId, quest]));
    const belongsToTask = (id) => {
      const seen = new Set();
      let quest = published.get(id);
      while (quest?.parentId && !seen.has(quest.gameId)) {
        seen.add(quest.gameId);
        quest = published.get(quest.parentId);
      }
      return quest?.gameId === task.gameId;
    };
    // Unknown records become option facts only with an actual tracked state-1
    // row, a canonical owner path and an explicitly active saved/live root.
    const tracked =
      task.rootState === 1
        ? list(flow.unindexedActive).flatMap((record) => {
            const hidden = data?.codex?.hiddenSteps?.[record.id];
            return record.tracked &&
              hidden &&
              hidden?.ownerPath?.[0] === hidden.ownerId &&
              hidden.ownerPath.includes(hidden.relatedQuestId) &&
              belongsToTask(hidden.relatedQuestId)
              ? [{ choiceStepId: record.id, name: '当前追踪步骤' }]
              : [];
          })
        : [];
    const rows = [...list(task.steps), ...tracked];
    return rows
      .map((row) => ({ id: row.choiceStepId, html: choiceChanges(row, flow, { label: rows.length > 1 }) }))
      .filter((row) => row.html);
  }
  const taskChoiceChanges = (task, flow) =>
    taskChoiceEntries(task, flow)
      .map((row) => row.html)
      .join('');
  const criticalChoiceKey = (tasks, flow) =>
    tasks
      .flatMap((task) => taskChoiceEntries(task, flow))
      .filter((row) => row.html.includes('data-flow-choice-consequence'))
      .map((row) => row.id)
      .sort((a, b) => a - b)
      .join('-');
  function unresolvedRecords(flow) {
    const shown = new Set(
      list(flow.active)
        .flatMap((task) => taskChoiceEntries(task, flow))
        .map((row) => row.id),
    );
    const covered = new Set(list(flow.decisions).flatMap((row) => list(row.coveredChoiceSteps)));
    return list(flow.unindexedActive).filter((row) => !shown.has(row.id) && !covered.has(row.id));
  }
  function step(row, rootId, { summaryInLead = false, sharedMaterials = [] } = {}) {
    const upcoming = list(row.upcoming);
    const completing = list(row.completionRequirements);
    return persist(
      `<div class="flow-step">${(summaryInLead && !row.targets?.materialState) || row.id === rootId || row.name === row.nextAction ? '' : `<h4>${questButton(row.detailId || row.id, row.name || '当前步骤') || prose(row.name || '当前步骤')}</h4>`}${summaryInLead ? '' : `<p class="flow-next-action"><span class="small muted">当前行动 </span>${stepAction(row) || prose('请打开任务资料，核对当前要求。')}</p>`}${row.description && row.description !== row.nextAction ? `<details><summary>任务说明 · 可能涉及剧情</summary><p class="preserve-text">${prose(row.description)}</p></details>` : ''}${summaryInLead ? '' : stepPeople(row) + stepPlaces(row)}${conditions(row.requirements)}${completing.length ? `<h4>完成条件</h4>${conditions(completing)}` : ''}${summaryInLead ? '' : materials(row.materials, sharedMaterials)}${upcoming.length ? `<details class="flow-upcoming"><summary>后续相关步骤与分支 · 涉及剧情</summary><ul>${upcoming.map((next) => `<li>${questButton(next.detailId || next.id, next.name) || text(next.name)}${next.reason ? `<p class="small muted">${text(next.reason)}</p>` : ''}</li>`).join('')}</ul></details>` : ''}</div>`,
      'step-' + row.id,
    );
  }
  function decision(row, { compact = false, cautionShown = false } = {}) {
    const value = row.recommendation;
    const isCollection = list(row.collectionStops).length > 0;
    const action = value?.summary || value?.hint || value?.compact?.action || value?.action || row.warning;
    const caution = value?.caution || row.compactWarning;
    const materialLabel = String(value?.materialLabel || '').split(/[；;]/);
    const acquisition = materialRows(value?.materials, [], {
      bodyOnly: true,
      sources: value?.materialSources,
      scope: 'choice-' + row.id,
    });
    return persist(
      `<aside class="flow-decision" data-flow-decision="${text(row.id)}"><p class="flow-recommended-action">${prose(action, value?.targets)}</p>${!cautionShown && caution && caution !== action ? `<p class="flow-caution">${prose(caution, value?.targets)}</p>` : ''}${reasonBrief(row)}${list(value?.materials).length && value.materialLabel ? `<p class="small flow-choice-material-label">${text(materialLabel[0])}</p>` : ''}${compactMaterials(value?.materials, [], { details: false, sources: value?.materialSources, scope: row.id })}<details class="flow-choice-details" data-persist-detail="flow-choice-${text(row.id)}${row.live ? `-${text(row.liveSequence)}` : ''}"><summary>${text(row.detailLabel || '为什么这样选 · 各选项影响')}</summary>${isCollection ? collectionStops(row) + '<details class="flow-collection-route"><summary>路线与资料</summary>' : ''}<h3>${questButton(row.questId, row.name) || prose(row.name)}</h3>${recommendation(row, { actionShown: action === value?.action, materialsShown: true })}${materialLabel.length > 1 ? `<p class="small">${text(materialLabel.slice(1).join('；'))}</p>` : ''}${acquisition ? `<section data-flow-choice-acquisition><h4>材料获取详情</h4>${acquisition}</section>` : ''}${row.pickup?.place || row.pickup?.person ? `<p class="flow-choice-location">${target(row.pickup.place, 'world-place', 'place')}${row.pickup.person ? ` · ${target(row.pickup.person, 'database-detail', 'npc')}` : ''}</p>` : ''}<p>${prose(row.warning)}</p>${conditions(row.conditions)}<dl class="flow-choices">${list(
        row.choices,
      )
        .map(
          (choice) =>
            `<dt>${prose(choice.label)}</dt><dd>${prose(choice.effect || '影响待核对', choice.targets)}</dd>`,
        )
        .join(
          '',
        )}</dl>${row.uncertainty ? `<details><summary>资料说明</summary><p class="small save-note">${text(row.uncertainty)}</p></details>` : ''}${sources(row.sources)}${isCollection ? '</details>' : ''}</details></aside>`,
      (compact ? 'compact-choice-' : 'decision-') + row.id,
    );
  }
  function activeTask(
    task,
    { summaryInLead = false, sharedMaterials = [], choicesInLead = false, flow } = {},
  ) {
    const steps = list(task.steps);
    const progress = list(task.progress);
    const counts = ['进行中', '已完成', '已失败', '尚未开始', '尚未接取']
      .map((status) => ({ status, count: progress.filter((row) => row.status === status).length }))
      .filter((row) => row.count)
      .map((row) => `${row.status} ${row.count}`)
      .join(' · ');
    return persist(
      `<article class="flow-task"${summaryInLead ? '' : ` data-flow-quest="${text(task.id || '')}"`}>${summaryInLead ? '' : `<div class="row between"><h3>${questButton(task.id, task.name) || text(task.name)}</h3>${pill(task.kind === 'Primary' ? '主线' : '支线', task.kind === 'Primary' ? 'green' : '')}</div>`}${choicesInLead ? '' : taskChoiceChanges(task, flow)}${steps.length ? steps.map((row, index) => step(row, task.id, { summaryInLead: summaryInLead && index === 0, sharedMaterials })).join('') : '<p class="small muted">这份存档只有任务记录，尚无可展示的当前步骤；请核对任务资料。</p>'}${progress.length ? `<details class="flow-task-progress"><summary>已记录的步骤 · ${text(counts)}</summary><ul class="flow-progress-list">${progress.map((row) => `<li>${questButton(row.detailId || row.id, row.name)}${pill(row.status, row.status === '已完成' ? 'green' : row.status === '已失败' ? 'orange' : '')}</li>`).join('')}</ul></details>` : ''}</article>`,
      'task-' + task.id,
    );
  }
  function chapter(flow) {
    const current = flow.chapter;
    const changes = list(flow.changes);
    if (!current && !changes.length) return '';
    const milestone = current?.nextMilestone;
    return `<section class="flow-chapter"><h2>主线进度</h2>${current ? `<p>${current.name && current.name !== current.mainName ? `<span class="small muted">${text(current.name)} · </span>` : ''}${questButton(current.questId, current.mainName || current.name || '当前主线') || prose(current.mainName || current.name)}</p>${milestone ? `<p><span class="small muted">下一主线关键节点 </span>${questButton(milestone.questId, milestone.title) || text(milestone.title)}</p>${milestone.questId ? `<details data-persist-detail="main-milestone-source"><summary>节点资料</summary>${milestone.note ? `<p class="small save-note">${text(milestone.note)}</p>` : ''}${sources(milestone.sources)}</details>` : `<p class="small save-note">${text(milestone.note)}</p>`}` : ''}` : ''}${changes.length || current?.next ? `<details data-persist-detail="flow-chapter-changes"><summary>阶段变化${changes.length ? ` · ${changes.length}` : ''}</summary>${current?.next ? `<p><span class="small muted">推进前 </span>${questButton(current.next.questId, current.next.title) || text(current.next.title)}</p>` : ''}${changes.length ? `<ul class="flow-changes">${changes.map((change) => `<li><strong>${prose(change.title || '任务变化')}</strong>${change.triggerName ? `<p><span class="small muted">推进关联 </span>${prose(change.triggerName)}</p>` : ''}${change.consequence ? `<p>${prose(change.consequence)}</p>` : ''}${advancement(change)}</li>`).join('')}</ul>` : ''}</details>` : ''}</section>`;
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
  const compactAdvice = (row, alreadyActive = false) => {
    const lead = alreadyActive
      ? row.recommendation?.hint || row.warning
      : row.recommendation?.hint || row.recommendation?.action || row.pickup?.action || row.warning;
    return persist(
      `<article class="flow-suggestion" data-flow-suggestion="${text(row.id)}">${lead ? `<p>${prose(lead)}</p>` : ''}<details><summary>做法与理由</summary>${rule(row, false, 'advice', true, { actionShown: !!lead && lead === row.recommendation?.action, previewText: lead || '' })}</details></article>`,
      `compact-advice-${row.id}`,
    );
  };
  function compactPanel(flow, sections = ['advice', 'opportunities', 'milestones']) {
    const decisions = list(flow.decisions);
    const decisionIds = new Set(decisions.map((row) => row.id));
    const warnings = list(flow.warnings).filter((row) => !decisionIds.has(row.id));
    const active = list(flow.active);
    const unindexed = unresolvedRecords(flow);
    const advice = list(flow.advice).filter((row) => !decisionIds.has(row.id));
    const adviceActive = (row) => row.questId != null && active.some((task) => task.gameId === row.questId);
    const adviceView = (row) => compactAdvice(row, adviceActive(row));
    const warningIds = new Set([...warnings, ...decisions].map((row) => row.id));
    const opportunities = list(flow.opportunities).filter((row) => !warningIds.has(row.id));
    const reference = flow.reference;
    const visibleSections = new Set(sections);
    const compactDecision = (row) => decision(row, { compact: true });
    const first = active[0];
    const leadCritical = criticalChoiceKey(active.slice(0, 2), flow);
    const otherCritical = criticalChoiceKey(active.slice(2), flow);
    const currentTask = (task, primary = false) => {
      const next = task.steps?.[0];
      const unresolved = !next || next.nextAction === '下一步未识别，请查看游戏任务栏。';
      return `<section class="flow-now flow-active${unresolved ? ' flow-step-unknown' : ''}"${primary ? ' data-flow-now' : ''} data-flow-quest="${text(task.id)}"><h3>${questButton(task.id, task.name)}${unresolved ? '<small class="flow-step-status">步骤待确认</small>' : ''}</h3>${unresolved ? '' : `<p class="flow-next-action">${stepAction(next)}</p>`}${taskChoiceChanges(task, flow)}${next ? compactStepTargets(next) + compactMaterials(next.materials, flow.sharedMaterials, { scope: `${task.id}-${next.id}`, instruction: next.nextAction }) : ''}<details class="flow-now-details" data-persist-detail="flow-now-${text(task.id)}-${text(next?.id)}"><summary>任务详情</summary>${next ? stepPeople(next) + stepPlaces(next) : ''}${activeTask(task, { summaryInLead: true, sharedMaterials: flow.sharedMaterials, choicesInLead: true, flow })}</details></section>`;
    };
    const lead = first
      ? active
          .slice(0, 2)
          .map((task, i) => currentTask(task, i === 0))
          .join('')
      : `<div class="flow-empty"><p>${text(flow.reason || (flow.available ? '当前步骤待核对' : '尚无可读存档，可先查询攻略。'))}</p>${flow.referenceNeedsSelection ? button('navigate', '检查游戏连接', 'settings', 'btn soft') : ''}</div>`;
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
        ? row.closedWindowSummary || `${row.name || '任务'}：窗口已推进，能否继续须核对`
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
        )}" open><summary><strong>${warnings.every((row) => row.deadlineReached) ? '流程提醒' : '推进前确认'} · ${warnings.length} 项</strong></summary>${groups.map(({ deadline, rows }) => `<details class="flow-risk-window" data-persist-detail="flow-risk-window-${text(rows[0].id)}"><summary>${deadline && rows.some((row) => !row.compactWarning && !String(riskPreview(row)).includes(deadline.replace(/(?:之前|前)$/, ''))) ? `<span class="flow-risk-deadline">${prose(deadline)}</span>` : ''}${rows.map((row) => `<span class="flow-risk-preview">${prose(riskPreview(row))}</span>${!row.deadlineReached ? reasonBrief(row, 'span') : ''}`).join('')}</summary>${rows.map((row) => `<div data-flow-impact="${text(row.id)}">${rule(row, true, 'risk', true)}</div>`).join('')}</details>`).join('')}</details></section>`
      : '';
    const current = decisions.length
      ? first
        ? `<details class="flow-task-peek" data-persist-detail="flow-task-peek-${text(first.id)}${leadCritical ? '-' + leadCritical : ''}"${leadCritical ? ' open' : ''}><summary>进行中任务 · ${Math.min(active.length, 2)}</summary>${lead}</details>`
        : ''
      : lead;
    return persist(
      `<section class="flow-panel flow-compact" data-flow>${stateNotice(flow)}${
        decisions.length
          ? `<section class="flow-current-decisions" aria-label="当前关键选择">${compactDecision(decisions[0])}${
              decisions.length > 1
                ? `<details data-persist-detail="compact-more-choices"><summary>其他关键选择 · ${decisions.length - 1}${decisions
                    .slice(1)
                    .map(
                      (row) =>
                        `<span class="flow-risk-preview" data-flow-secondary-decision="${text(row.id)}">${questButton(row.questId, row.name) || prose(row.name)}：${prose(row.recommendation?.caution || row.compactWarning || row.recommendation?.summary || row.recommendation?.hint || row.warning)}</span>`,
                    )
                    .join('')}</summary>${decisions
                    .slice(1)
                    .map((row) => decision(row, { compact: true, cautionShown: true }))
                    .join('')}</details>`
                : ''
            }</section>`
          : ''
      }${urgent}${decisions.length ? '' : current}${visibleSections.has('advice') && advice.length ? `<section class="flow-advice"><h2>${adviceActive(advice[0]) ? '任务提醒' : '顺路可做'}</h2>${adviceView(advice[0])}${advice.length > 1 ? `<details data-persist-detail="compact-more-advice"><summary>更多建议 · ${advice.length - 1}</summary>${advice.slice(1).map(adviceView).join('')}</details>` : ''}</section>` : ''}${decisions.length ? current : ''}${
        active.length > 2
          ? `<details data-persist-detail="compact-other-active${otherCritical ? '-' + otherCritical : ''}" class="flow-all-active"${otherCritical ? ' open' : ''}><summary>其他进行中任务 · ${active.length - 2}</summary>${active
              .slice(2)
              .map((task) => activeTask(task, { sharedMaterials: flow.sharedMaterials, flow }))
              .join('')}</details>`
          : ''
      }${unindexed.length ? `<details data-persist-detail="compact-unindexed" class="flow-unindexed" data-flow-unindexed><summary>另有 ${unindexed.length} 条进行中记录待识别</summary><p class="small save-note">请核对游戏任务栏；资料尚不能确定这些记录的名称与下一步。</p></details>` : ''}${visibleSections.has('opportunities') && opportunities.length ? `<details data-persist-detail="compact-opportunities" class="flow-opportunities"><summary>未接任务线索 · ${opportunities.length}</summary>${opportunities.map((row) => rule(row, false, 'opportunity')).join('') || '<p class="small muted">暂未匹配到接取线索。</p>'}</details>` : ''}${(visibleSections.has('milestones') && (flow.chapter || list(flow.changes).length || flow.stageUncertainty)) || list(flow.guide).length || list(flow.chapters).length ? `<details class="flow-offline-details" data-persist-detail="compact-offline"><summary>主线与攻略</summary>${visibleSections.has('milestones') ? `<section class="flow-stage-details">${chapter(flow)}${flow.stageUncertainty ? `<p class="small save-note" data-flow-stage-uncertain>${text(flow.stageUncertainty)}</p>` : ''}</section>` : ''}${offlineIndex(flow)}</details>` : ''}</section>`,
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
        `<section class="flow-panel${summary ? ' flow-summary' : ''}" data-flow>${stateNotice(flow)}<div class="flow-heading"><p${updating ? ' role="status"' : ''}>${updating ? '正在更新进度…' : offline ? '查询流程资料' : '暂无可读进度'}</p>${!updating && !offline ? button('navigate', '检查游戏连接', 'settings') : ''}</div>${summary ? `<div class="flow-more">${button('navigate', '全部流程', 'checklist', 'btn soft')}</div>` : offlineIndex(flow)}</section>`,
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
    const belongsTo = (row, task) => row.questId != null && row.questId === task.gameId;
    const adviceFor = (task) => advice.filter((row) => belongsTo(row, task));
    const separateAdvice = advice.filter((row) => !active.some((task) => belongsTo(row, task)));
    const activeCard = (task) => {
      const next = list(task.steps)[0];
      return `<article class="flow-task flow-task-summary" data-flow-quest="${text(task.id)}"><div class="row between"><h3>${questButton(task.id, task.name)}</h3>${pill(task.kind === 'Primary' ? '主线' : '支线')}</div>${next ? `<p class="flow-next-action">${stepAction(next)}</p>` : ''}${taskChoiceChanges(task, flow)}${next ? `${compactStepTargets(next)}${compactMaterials(next.materials, flow.sharedMaterials, { scope: 'main-' + task.id, instruction: next.nextAction })}` : ''}<details data-persist-detail="main-task-${text(task.id)}"><summary>完整步骤</summary>${next ? stepPeople(next) + stepPlaces(next) : ''}${activeTask(task, { summaryInLead: true, sharedMaterials: flow.sharedMaterials, choicesInLead: true, flow })}</details>${adviceFor(
        task,
      )
        .map((row) => compactAdvice(row, true))
        .join('')}</article>`;
    };
    const unindexed = unresolvedRecords(flow);
    const shared = list(flow.sharedMaterials);
    const warningIds = new Set([...warnings, ...decisions].map((row) => row.id).filter(Boolean));
    const opportunities = list(flow.opportunities).filter((row) => !row.id || !warningIds.has(row.id));
    const coverage = flow.coverage || {};
    const reference = flow.reference;
    const remaining = Math.max(0, active.length - 3);
    const extraCritical = criticalChoiceKey(active.slice(3), flow);
    const activeBody = `${active.slice(0, 3).map(activeCard).join('')}${remaining ? `<details class="flow-all-active" data-persist-detail="main-other-active${extraCritical ? '-' + extraCritical : ''}"${extraCritical ? ' open' : ''}><summary>其余 ${remaining} 项进行中任务</summary>${active.slice(3).map(activeCard).join('')}</details>` : ''}`;
    const riskContent = warnings.map((warning) => rule(warning, true, 'risk')).join('');
    const opportunitiesBody = opportunities.length
      ? `<section class="flow-opportunities"><h2>未接任务线索 · ${opportunities.length} 项</h2>${rule(opportunities[0], false, 'opportunity')}${
          opportunities.length > 1
            ? `<details data-persist-detail="main-more-opportunities"><summary>更多未接任务 · ${opportunities.length - 1}</summary>${opportunities
                .slice(1)
                .map((entry) => rule(entry, false, 'opportunity'))
                .join('')}</details>`
            : ''
        }</section>`
      : '';
    return persist(
      `<section class="flow-panel${compact ? ' flow-compact' : ''}${summary ? ' flow-summary' : ''}${warnings.length ? ' flow-has-risks' : ''}" data-flow>${stateNotice(flow)}${decisions.length ? `<section class="flow-current-decisions" aria-label="当前关键选择">${decisions.map(decision).join('')}</section>` : ''}${warnings.length ? `<section class="flow-risks"><h2>${icon('pin')} ${warnings.every((row) => row.deadlineReached) ? '流程提醒' : '推进前确认'}</h2>${riskContent}</section>` : ''}<section class="flow-active"><h2>进行中${active.length ? ` · ${active.length} 项` : ''}</h2>${sharedMaterialSummary(
        shared,
      )}${unindexed.length ? `<aside class="flow-unindexed" data-flow-unindexed><details><summary>另有 ${unindexed.length} 条进行中记录待识别</summary><p class="small save-note">这些记录尚未收录在任务资料中，可能是隐藏剧情或版本新增任务。请核对游戏任务栏中额外进行中的任务；这里暂不能判断名称与下一步。</p></details></aside>` : ''}${activeBody || `<p class="small muted">${flow.available ? '暂无进行中步骤，可在下方查找任务。' : '连接游戏进度后显示当前行动。'}</p>`}</section>${
        separateAdvice.length
          ? `<section class="flow-advice"><h2>推荐做法</h2>${compactAdvice(separateAdvice[0])}${
              separateAdvice.length > 1
                ? `<details data-persist-detail="main-more-advice"><summary>更多建议 · ${separateAdvice.length - 1}</summary>${separateAdvice
                    .slice(1)
                    .map((row) => rule(row, false, 'advice'))
                    .join('')}</details>`
                : ''
            }</section>`
          : ''
      }${opportunitiesBody}${chapter(flow)}${summary ? `<div class="flow-more">${button('navigate', '全部流程', 'checklist', 'btn soft')}</div>` : offlineIndex(flow)}</section>`,
      'panel',
    );
  }
  return { panel, taskMaterials, choice: decision, stateNotice };
}
