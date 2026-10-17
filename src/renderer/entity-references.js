import { npcLearningSummary } from './npc-progress-views.js';
import { entityCatalog, questStatus } from './entity-catalog.js';
import { itemNumericSummary } from './item-stat-views.js';
import { sharedEntityArtwork } from './game-images.js';
import { createPlaceMapViews } from './place-map-views.js';
import {
  allObjectivePlaces,
  resolveTaskObjectives,
  isGenericPlaceName,
  placeMentionIsQualifier,
} from '../shared/task-objectives.mjs';

export function createEntityReferences({ index, esc, picture, icon, qualityText }) {
  const placeMaps = createPlaceMapViews({ esc, icon });
  const catalog = () => index() && entityCatalog(index());
  const rows = (id) => catalog()?.resolve(id) || [];
  const currentAt = (quest, key, reference) =>
    catalog().isCurrentQuestStep(quest, (q) => questStatus(q.gameId, reference)) &&
    resolveTaskObjectives(index().world?.objectives?.[quest.id], reference?.metadata)?.places.some((target) =>
      target.mapKeys.includes(key),
    );
  function choiceSummary(entry, choices, reference = null) {
    const sameName = choices.filter((row) => row.name === entry.name && row.kind === entry.kind);
    const position = sameName.findIndex((row) => row.id === entry.id) + 1;
    const facts = [];
    if (sameName.length > 1)
      facts.push(`${entry.kind === '地点' ? '场景' : '资料'} ${position}/${sameName.length}`);
    if (entry.kind === '地点') {
      if (reference?.metadata?.map === entry.key) facts.push('当前地点');
      const related =
        index().world?.quests?.filter(
          (quest) =>
            (quest.placements || []).some((placement) => placement.mapKey === entry.key) ||
            allObjectivePlaces(index().world?.objectives?.[quest.id]).some((target) =>
              target.mapKeys.includes(entry.key),
            ),
        ) || [];
      related.sort(
        (a, b) => Number(currentAt(b, entry.key, reference)) - Number(currentAt(a, entry.key, reference)),
      );
      const tasks = [...new Set(related.map((quest) => quest.name.replace(/^【[^】]+】/, '')))];
      if (tasks.length) facts.push('任务：' + tasks.slice(0, 2).join('、'));
      else if (sameName.length > 1) facts.push('暂无关联任务');
      if (
        related.some((quest) =>
          index().world?.objectives?.[quest.id]?.places.some(
            (target) => target.mapKeys.length > 1 && target.mapKeys.includes(entry.key),
          ),
        )
      )
        facts.push('场景待确认');
    } else if (entry.kind === '人物') {
      if (Number.isFinite(entry.npcFacts?.level)) facts.push('初始等级 ' + entry.npcFacts.level);
      const place = index().world?.maps?.find((row) => row.key === entry.walkMap);
      if (place) facts.push(place.name);
      // Only exact NPC bindings can distinguish same-name characters. Prose
      // mentions alone apply to every namesake and would invent a distinction.
      const related =
        index().world?.quests?.filter(
          (quest) =>
            (quest.requestNPCs || []).includes(entry.gameId) ||
            (quest.finishNPCs || []).includes(entry.gameId) ||
            (quest.placements || []).some((placement) => placement.npcId === entry.gameId),
        ) || [];
      const tasks = [
        ...new Set(
          related.map((quest) =>
            catalog()
              .root(quest)
              .name.replace(/^【[^】]+】/, ''),
          ),
        ),
      ];
      if (tasks.length) facts.push('任务：' + tasks.slice(0, 2).join('、'));
    } else if (entry.kind === '任务' && entry.parentId) {
      facts.push(
        catalog()
          .root(entry)
          .name.replace(/^【[^】]+】/, ''),
      );
    } else if (entry.quality) facts.push(entry.quality + '色品质');
    return facts.join(' · ');
  }
  function variantSummary(id, reference = null) {
    const entry = rows(id);
    if (entry.length !== 1) return '';
    const choices = (catalog().names.get(entry[0].name) || []).filter((row) => row.kind === entry[0].kind);
    return choices.length > 1 ? choiceSummary(entry[0], choices, reference) : '';
  }
  const artwork = (id, size = 'tiny') => {
    const choices = rows(id);
    if (choices.length === 1) return picture(choices[0].id, size);
    const shared = sharedEntityArtwork(index(), choices);
    if (shared) return picture(shared, size);
    const kind = choices[0]?.kind;
    const glyph =
      { 人物: 'person', 任务: 'scroll', 地点: 'pin', 配方: 'scroll', 武学: 'sword' }[kind] || 'bag';
    return `<span class="game-picture game-picture-${size} image-unavailable" aria-hidden="true"><span class="image-fallback">${icon(glyph)}</span></span>`;
  };
  function button(action, label, cls, id, glyph = '', accessibleLabel = '') {
    const journal = action === 'journal-link' && /^(database|quest|place):(.+)$/.exec(id || '');
    const entityId = journal ? journal[2] : id;
    const entity =
      (journal ||
        [
          'database-detail',
          'archive-entity',
          'world-quest',
          'flow-quest',
          'world-place',
          'entity-choice',
        ].includes(action)) &&
      rows(entityId).length;
    return `<button type="button" class="${cls}${entity ? ' pictured-link entity-link' : ''}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}${entity ? ` data-entity-id="${esc(entityId)}"` : ''}${accessibleLabel ? ` aria-label="${esc(accessibleLabel)}"` : ''}>${entity ? artwork(entityId) + '<span class="entity-link-label">' + (action === 'database-detail' || action === 'archive-entity' || journal?.[1] === 'database' ? qualityText.html(entityId, label) : label) + '</span>' : (glyph ? icon(glyph) : '') + label}</button>`;
  }
  function text(value, taskAction = 'world-quest', targets = {}) {
    const source = String(value ?? ''),
      data = catalog();
    if (!data) return esc(source);
    // Quoted task titles are deliberate references, including titles that are
    // ordinary instructions when used without a title marker.
    if (!Array.isArray(targets?.places))
      for (const quoted of source.matchAll(/「([^」\r\n]+)」|“([^”\r\n]+)”|《([^》\r\n]+)》/gu)) {
        const label = quoted[1] || quoted[2] || quoted[3];
        const choices = data.names.get(label) || [];
        if (!choices.length || !choices.every((entry) => entry.kind === '任务')) continue;
        const link =
          choices.length === 1
            ? button(taskAction, esc(label), 'text-btn entity-inline', choices[0].id)
            : button('entity-choice', esc(label), 'text-btn entity-inline', 'name:' + label);
        return (
          text(source.slice(0, quoted.index), taskAction, targets) +
          esc(quoted[0][0]) +
          link +
          esc(quoted[0].at(-1)) +
          text(source.slice(quoted.index + quoted[0].length), taskAction, targets)
        );
      }
    let html = '',
      at = 0;
    const pattern = Array.isArray(targets?.places) ? data.objectivePattern : data.pattern;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      html += esc(source.slice(at, match.index));
      // A root task can itself be named “返回五仙教”. Its prose match must not
      // swallow a destination already identified by the current objective.
      const interiorPlace =
        /^(?:殿|堂|阁|室|峰|楼|厅|院|塔|窟)/.test(source.slice(match.index + match[0].length)) &&
        match[0].endsWith('主') &&
        data.names.get(match[0].slice(0, -1))?.some((entry) => entry.kind === '地点')
          ? match[0].slice(0, -1)
          : '';
      const nestedMention =
        [...(targets?.people || []), ...(targets?.places || [])]
          .filter((entry) => data.entries.has(entry.id) || entry.mapKeys?.length)
          .flatMap((entry) => [...new Set([entry.name, ...(entry.mentions || [])])])
          .filter((name) => name?.length > 1 && name !== match[0] && match[0].includes(name))
          .sort((a, b) => b.length - a.length)[0] || interiorPlace;
      const globalChoices = data.names.get(match[0]) || [];
      if (nestedMention && globalChoices.length && globalChoices.every((entry) => entry.kind === '任务')) {
        const offset = match[0].indexOf(nestedMention);
        html +=
          text(match[0].slice(0, offset), taskAction, targets) +
          text(nestedMention, taskAction, targets) +
          text(match[0].slice(offset + nestedMention.length), taskAction, targets);
        at = match.index + match[0].length;
        continue;
      }
      // A local building name must not become an unrelated shorter quest.
      // Explicit quoted titles have already been handled above.
      if (
        /^(?:殿|堂|阁|室|峰|楼|厅|院|塔|窟)/.test(source.slice(match.index + match[0].length)) &&
        globalChoices.length &&
        globalChoices.every((entry) => entry.kind === '任务')
      ) {
        html += esc(match[0]);
        at = match.index + match[0].length;
        continue;
      }
      const preferred = [...(targets?.people || []), ...(targets?.places || [])].filter(
        (entry) => entry.id && (entry.name === match[0] || entry.mentions?.includes(match[0])),
      );
      const ids = [...new Set(preferred.map((entry) => entry.id))];
      const exact = ids.length === 1 ? data.entries.get(ids[0]) : null;
      const placeTarget = (targets?.places || []).find(
        (entry) => entry.mapKeys?.length && (entry.name === match[0] || entry.mentions?.includes(match[0])),
      );
      const choiceId = (placeTarget ? 'place-name:' : 'name:') + match[0];
      const choices = exact ? [exact] : data.resolve(choiceId);
      const e = choices[0];
      // Keep landmarks and acquisition clues linkable. Only reject a place
      // interpretation contradicted by the phrase or its known local context.
      const blockedPlace =
        Array.isArray(targets?.places) &&
        choices.length &&
        choices.every(
          (entry) =>
            entry.kind === '地点' &&
            (targets.nonDestinationPlaces?.includes(match[0]) ||
              targets.nonDestinationPlaces?.includes(entry.name) ||
              placeMentionIsQualifier(entry.name, source.slice(match.index + match[0].length)) ||
              (isGenericPlaceName(entry.name) &&
                targets.places.some((place) => !isGenericPlaceName(place.name)) &&
                !targets.places.some((place) => place.mapKeys?.includes(entry.key)))),
        );
      html +=
        !choices.length || blockedPlace
          ? esc(match[0])
          : choices.length === 1
            ? button(
                e.kind === '任务' ? taskAction : e.kind === '地点' ? 'world-place' : 'database-detail',
                esc(match[0]),
                'text-btn entity-inline',
                e.id,
              )
            : button('entity-choice', esc(match[0]), 'text-btn entity-inline', choiceId);
      at = match.index + match[0].length;
    }
    return html + esc(source.slice(at));
  }
  function preview(id, context = {}) {
    const choices = rows(id),
      e = choices[0];
    if (!e) return '';
    const name =
      choices.length > 1
        ? /^(?:place-)?name:/.test(id)
          ? id.slice(id.indexOf(':') + 1)
          : [...new Set(choices.map((row) => row.name))].join(' / ')
        : e.name;
    const groupLabel = new Set(choices.map((row) => row.name)).size > 1 ? '资料选择' : '同名资料';
    let lines = [];
    if (choices.length > 1) {
      lines = [
        `${choices.length} 条${groupLabel}，点击选择。`,
        ...choices
          .slice(0, 3)
          .map((row) => `${row.name} · ${choiceSummary(row, choices, context.reference) || row.kind}`),
      ];
    } else if (e.kind === '人物') {
      const variant = variantSummary(id, context.reference);
      const current = (context.npcProgress || context.reference?.metadata?.npcProgress)?.people.find(
        (row) => row.npcId === e.gameId,
      );
      if (current) {
        lines.push(
          [
            current.remainingItems.length ? `私物还剩 ${current.remainingItems.length} 种` : '私物已清空',
            npcLearningSummary(current.learning),
          ]
            .filter(Boolean)
            .join(' · '),
        );
        if (current.place) lines.push(current.place.name);
        const operations = [
          ['比武', current.compare],
          ['赠礼', current.gift],
          ['请教', current.consult],
        ];
        const missing = operations.filter(([, gate]) =>
          gate?.checks?.some(
            (check) => check.status !== 'met' && /^暂无常规(?:比武|赠礼|请教)入口$/.test(check.text),
          ),
        );
        if (missing.length) lines.push(missing.map(([label]) => label).join('、') + '：暂无入口');
        const blocked = operations.find(
          (operation) =>
            !missing.includes(operation) && operation[1]?.checks?.some((check) => check.status !== 'met'),
        );
        if (blocked)
          lines.push(blocked[0] + '：' + blocked[1].checks.find((check) => check.status !== 'met').text);
      } else {
        if (variant) lines.push(variant);
        else if (e.npcFacts)
          lines.push(
            `初始等级 ${e.npcFacts.level} · ${new Set((e.npcFacts.fixedItems || []).map((item) => item.id)).size} 种固定私物`,
          );
        const missing = Array.isArray(e.functions)
          ? [
              ['比武', 'Compare'],
              ['赠礼', 'Gift'],
              ['请教', 'Consult'],
            ]
              .filter(([, key]) => !e.functions.includes(key))
              .map(([label]) => label)
          : [];
        if (missing.length) lines.push(missing.join('、') + '：暂无入口');
        if (e.hobbies?.length) lines.push('初始偏好：' + e.hobbies.join('、'));
        const place = index().world?.maps?.find((m) => m.key === e.walkMap);
        if (place && !variant) lines.push('行走场景：' + place.name);
      }
    } else if (e.kind === '任务') {
      const status = (task) => context.statuses?.get(task.id) || questStatus(task.gameId, context.reference);
      lines.push(status(e));
      const relation = catalog().taskRelations(e);
      const activeSteps = relation.group.filter(
        (step) => step.id !== e.id && catalog().isCurrentQuestStep(step, status),
      );
      const recordOrder = new Map((context.reference?.metadata?.quests || []).map((q, i) => [q.id, i]));
      activeSteps.sort(
        (a, b) =>
          Number(b.kind === 'Primary') - Number(a.kind === 'Primary') ||
          (recordOrder.get(a.gameId) ?? Infinity) - (recordOrder.get(b.gameId) ?? Infinity),
      );
      const active =
        activeSteps.find((step) => step.id === context.currentSteps?.get(e.id)) ||
        activeSteps.find((step) => step.gameId === context.reference?.metadata?.trackingQuest) ||
        activeSteps.find((step) => step.gameId === context.reference?.metadata?.trackingMainQuest) ||
        activeSteps[0];
      const selected = active || (catalog().isCurrentQuestStep(e, status) ? e : null);
      const targets = selected
        ? resolveTaskObjectives(index().world?.objectives?.[selected.id], context.reference?.metadata)
        : null;
      const nextStep = context.nextSteps?.get(e.id) || context.nextStep || targets?.nextAction;
      if (nextStep || active) lines.push('下一步：' + (nextStep || active.name));
      else if (e.parentId && e.description) lines.push(String(e.description).slice(0, 100));
      const people = selected
        ? targets?.people || []
        : (e.requestNPCs || []).flatMap((id) => {
            const person = catalog().entries.get('npc-' + id);
            return person ? [{ name: person.name, role: '接取' }] : [];
          });
      if (people.length)
        lines.push(
          people
            .slice(0, 3)
            .map((person) => `${person.role || '交互'}：${person.name}`)
            .join('；'),
        );
      const conditions = (e.requirements || []).filter((condition) => condition.name).slice(0, 2);
      if (conditions.length) lines.push('条件：' + conditions.map((condition) => condition.name).join('、'));
    } else if (e.kind === '物品') {
      const numeric = itemNumericSummary(e, index());
      if (numeric) lines.push(numeric);
      const inventory = context.reference?.metadata?.inventory;
      if (Array.isArray(inventory))
        lines.push(
          '保存持有 ' +
            inventory.reduce(
              (sum, row) =>
                sum +
                (row.id === e.gameId && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0),
              0,
            ),
        );
      else lines.push('持有量未核对');
      const sellers = [
        ...new Set(
          (index().merchants || [])
            .filter((seller) => seller.items.includes(e.gameId))
            .map((seller) => seller.name),
        ),
      ];
      if (sellers.length)
        lines.push('售卖线索：' + sellers.slice(0, 2).join('、') + (sellers.length > 2 ? '等' : ''));
      else {
        const recipe = index().entries.find(
          (entry) => entry.kind === '配方' && entry.results?.some((result) => result.id === e.gameId),
        );
        if (recipe) lines.push('制作：' + recipe.name);
        else if (!numeric && typeof e.buyPrice === 'number')
          lines.push('参考买价：' + e.buyPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 文');
      }
    } else if (e.kind === '配方') {
      lines.push(
        `${e.craft || e.type} ${e.level} 级`,
        '材料：' +
          (e.materials || [])
            .slice(0, 3)
            .map((m) => `${m.name} ×${m.count}`)
            .join('、'),
      );
    } else if (e.kind === '地点') {
      const variant = variantSummary(id, context.reference);
      lines.push(variant || (e.cave ? '洞穴场景' : '游戏场景'));
      if (!variant && context.reference?.metadata?.map === e.key)
        lines.push(context.reference?.origin === 'live' ? '当前地点' : '当前保存地点');
      const related =
        index().world?.quests?.filter(
          (quest) =>
            (quest.placements || []).some((placement) => placement.mapKey === e.key) ||
            allObjectivePlaces(index().world?.objectives?.[quest.id]).some((target) =>
              target.mapKeys.includes(e.key),
            ),
        ) || [];
      const roots = [
        ...new Map(
          related.map((quest) => {
            const root = catalog().root(catalog().entries.get(quest.id));
            return [root.id, root];
          }),
        ).values(),
      ].sort(
        (a, b) =>
          Number(
            related.some(
              (q) =>
                catalog().root(catalog().entries.get(q.id))?.id === b.id &&
                currentAt(q, e.key, context.reference),
            ),
          ) -
          Number(
            related.some(
              (q) =>
                catalog().root(catalog().entries.get(q.id))?.id === a.id &&
                currentAt(q, e.key, context.reference),
            ),
          ),
      );
      if (roots.length && !variant)
        lines.push(
          '相关任务：' +
            roots
              .slice(0, 2)
              .map((quest) => quest.name.replace(/^【[^】]+】/, ''))
              .join('、'),
        );
    }
    const description =
      choices.length === 1 && !lines.length ? String(e.description || '').slice(0, 100) : '';
    const placeKeys = choices
      .filter((row) => row.kind === '地点')
      .map((row) => index().world?.mapAtlas?.locations?.[row.key]?.markerKey);
    const placePositions = placeKeys.map((key) => {
      const point = index().world?.mapAtlas?.markers.find((row) => row.key === key);
      return point ? `${point.x}:${point.y}` : null;
    });
    const map =
      e.kind === '地点' &&
      (choices.length === 1 || (placePositions.every(Boolean) && new Set(placePositions).size === 1))
        ? placeMaps.render(index(), e.id, { compact: true, interactive: false })
        : '';
    return `<div class="entity-preview-heading">${artwork(id, 'card')}<div><small>${esc(choices.length > 1 ? groupLabel : e.kind)}${choices.length === 1 && e.quality ? ' · ' + esc(e.quality) + '色' : ''}</small><strong>${esc(name)}</strong></div></div>${description ? `<p class="entity-preview-description">${esc(description)}</p>` : ''}${lines
      .map((line) => `<p>${esc(line)}</p>`)
      .join('')}${map}<small class="entity-preview-hint">点击查看详情 · Esc 收起</small>`;
  }
  return { button, text, preview, artwork, choices: rows, choiceSummary, variantSummary };
}

// Event delegation survives renderer refreshes. The preview contains no controls.
export function installEntityPreviews({ document, window, references, context }) {
  const panel = document.createElement('aside');
  panel.id = 'entity-preview';
  panel.className = 'entity-preview';
  panel.setAttribute('role', 'tooltip');
  panel.hidden = true;
  document.body.append(panel);
  let trigger = null,
    pending = null,
    timer,
    hideTimer,
    request = 0,
    dismissed = null;
  const selector =
    '[data-entity-id], [data-action="database-detail"][data-id], [data-action="world-quest"][data-id], [data-action="flow-quest"][data-id], [data-action="world-place"][data-id]';
  const eligible = (node) => {
    const entry = node?.closest?.(selector);
    // Expanded choices already include their summaries. Another popup would
    // cover neighbouring choices in the narrow companion window.
    return entry?.closest('[data-entity-choice-list]') ? null : entry;
  };
  const focusSelector = selector + ', button[data-action], summary';
  const identity = (node) =>
    JSON.stringify([
      node.tagName || '',
      node.dataset.entityId || node.dataset.id,
      node.dataset.action || '',
      node.dataset.qualityId || '',
      !node.dataset.entityId &&
      !node.dataset.id &&
      !node.dataset.action &&
      !['id', 'data-persist-detail', 'data-compact-detail'].some((name) =>
        node.parentElement?.getAttribute(name),
      )
        ? node.textContent
        : '',
      !node.dataset.entityId && !node.dataset.id ? node.getAttribute('aria-label') || '' : '',
      !eligible(node) ? Object.entries(node.dataset).sort(([a], [b]) => a.localeCompare(b)) : null,
      !eligible(node) ? node.getAttribute('aria-label') || '' : '',
    ]);
  const anchors = [
    'id',
    'data-persist-detail',
    'data-compact-detail',
    'data-flow-decision',
    'data-flow-rule',
    'data-flow-now',
    'data-flow-quest',
    'data-duel',
    'data-task-relations',
    'data-person-relations',
    'data-flow-suggestion',
    'data-flow-impact',
    'data-community-pickup',
  ];
  const locationKey = (scope, node) => {
    const path = [];
    for (let parent = node.parentElement; parent && parent !== scope; parent = parent.parentElement) {
      const keys = anchors
        .map((name) => [name, parent.getAttribute(name)])
        .filter(([, value]) => value !== null);
      if (keys.length) path.unshift(keys);
    }
    return JSON.stringify([identity(node), path]);
  };
  const candidates = (scope, key) =>
    [...scope.querySelectorAll(focusSelector)].filter((node) => locationKey(scope, node) === key);
  const locate = (scope, node) => {
    const key = locationKey(scope, node);
    return { key, occurrence: candidates(scope, key).indexOf(node) };
  };
  const close = (dismissCurrent = false) => {
    ++request;
    if (dismissCurrent === true) dismissed = trigger || pending || eligible(document.activeElement);
    clearTimeout(timer);
    clearTimeout(hideTimer);
    trigger?.removeAttribute('aria-describedby');
    trigger = pending = null;
    panel.hidden = true;
  };
  const position = () => {
    if (!trigger?.isConnected) return close();
    const bounds = trigger.getBoundingClientRect(),
      margin = 10,
      gap = 4;
    const width = document.documentElement.clientWidth,
      height = window.innerHeight;
    panel.style.maxHeight = '';
    const natural = panel.getBoundingClientRect();
    const below = Math.max(0, height - margin - Math.max(margin, bounds.bottom + gap));
    const above = Math.max(0, Math.min(height - margin, bounds.top - gap) - margin);
    const useBelow = natural.height <= below || (natural.height > above && below >= above);
    const available = useBelow ? below : above;
    // If a whole card occupies the viewport, it already carries its summary.
    // Preserve the original click target rather than cover it with a tiny popup.
    if (available < 48) return close();
    panel.style.maxHeight = available + 'px';
    const rect = panel.getBoundingClientRect();
    panel.style.left = Math.max(margin, Math.min(bounds.left, width - rect.width - margin)) + 'px';
    panel.style.top =
      (useBelow
        ? Math.max(margin, bounds.bottom + gap)
        : Math.min(height - margin, bounds.top - gap) - rect.height) + 'px';
  };
  const readContext = (node, delay = 0) => {
    const current = ++request;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (current !== request) return;
      if (!node.isConnected || node.disabled) return close();
      let details;
      try {
        details = await context(node);
      } catch {
        details = {};
      }
      if (
        current !== request ||
        (pending !== node && trigger !== node) ||
        !node.isConnected ||
        node.closest('[inert]')
      )
        return;
      const html = references.preview(node.dataset.entityId || node.dataset.id, details);
      if (!html) return close();
      trigger = node;
      pending = null;
      if (panel.innerHTML !== html) panel.innerHTML = html;
      panel.hidden = false;
      node.setAttribute('aria-describedby', panel.id);
      position();
    }, delay);
  };
  const show = (node, immediate = false) => {
    clearTimeout(hideTimer);
    if (!node || node === dismissed || node === trigger || node === pending || node.disabled) return;
    close();
    pending = node;
    readContext(node, immediate ? 0 : 240);
  };
  const leave = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const node = trigger || pending;
      if (panel.matches(':hover') || node?.matches(':hover') || document.activeElement === node) return;
      close();
    }, 160);
  };
  document.addEventListener('pointerover', (event) => {
    if (panel.contains(event.target)) return clearTimeout(hideTimer);
    const node = eligible(event.target);
    if (node) {
      if (dismissed === node && !node.contains(event.relatedTarget)) dismissed = null;
      show(node);
    }
  });
  document.addEventListener('pointerout', (event) => {
    const node = eligible(event.target);
    if (node && !node.contains(event.relatedTarget)) {
      if (dismissed === node) dismissed = null;
      if (pending === node && document.activeElement !== node) close();
      leave();
    }
    if (panel.contains(event.target) && !panel.contains(event.relatedTarget)) leave();
  });
  document.addEventListener('focusin', (event) => {
    dismissed = null;
    show(eligible(event.target), true);
  });
  document.addEventListener('focusout', (event) => {
    if (dismissed === event.target) dismissed = null;
    leave();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && (trigger || pending)) {
        dismissed = trigger || pending;
        close();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener('click', close, true);
  document.addEventListener(
    'scroll',
    (event) => {
      if (panel.contains(event.target)) return;
      const node = pending || trigger;
      close();
      // Pointer and keyboard navigation can scroll an entry into view after
      // its preview starts. Keep that entry available at its new position.
      if (node?.isConnected && (node.matches(':hover') || document.activeElement === node))
        show(node, document.activeElement === node);
    },
    true,
  );
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  const observer = new MutationObserver(() => {
    if (
      (trigger && (!trigger.isConnected || trigger.closest('[inert]'))) ||
      (pending && !pending.isConnected)
    )
      close();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['inert'],
  });
  return {
    close,
    captureFocusWithin(scope) {
      const active = document.activeElement;
      const node =
        eligible(active) ||
        (active?.matches?.('button[data-action], summary') &&
        !active.dataset.action?.startsWith('journey-itinerary-')
          ? active
          : null);
      return node && scope.contains(node) ? locate(scope, node) : null;
    },
    restoreFocusWithin(scope, saved) {
      if (!saved || scope.closest('[inert]')) return;
      const node = candidates(scope, saved.key)[saved.occurrence];
      if (!node || node.disabled || node.closest('[inert]')) return;
      node.focus({ preventScroll: true });
      close(true);
    },
    refreshOutside(scope) {
      const node = trigger || pending;
      if (!node || scope.contains(node)) return;
      if (
        !node.isConnected ||
        node.disabled ||
        node.closest('[inert]') ||
        (!node.matches(':hover') && !panel.matches(':hover') && document.activeElement !== node)
      )
        return close();
      readContext(node);
    },
    captureWithin(scope) {
      const node = trigger || pending;
      if (!node || !scope.contains(node)) return null;
      const focused = document.activeElement === node;
      const panelHovered = panel.matches(':hover');
      if (!focused && !node.matches(':hover') && !panelHovered) return null;
      return {
        ...locate(scope, node),
        focused,
        panelHovered,
      };
    },
    restoreWithin(scope, saved) {
      if (!saved || scope.closest('[inert]')) return;
      const matches = candidates(scope, saved.key);
      const node =
        saved.focused || saved.panelHovered
          ? matches[saved.occurrence]
          : matches.find((entry) => entry.matches(':hover'));
      if (!node || node.disabled || node.closest('[inert]')) return;
      if (saved.focused && document.activeElement !== node) return;
      dismissed = null;
      // Resolve fresh context on the replacement; never reuse old inventory or tooltip HTML.
      show(node, true);
    },
    closeWithin(scope) {
      if (scope.contains(trigger || pending)) close();
    },
  };
}
