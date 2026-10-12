import { entityCatalog, questStatus } from './entity-catalog.js';
import { itemNumericSummary } from './item-stat-views.js';

export function createEntityReferences({ index, esc, picture, icon, qualityText }) {
  const catalog = () => index() && entityCatalog(index());
  const rows = (id) => catalog()?.resolve(id) || [];
  const artwork = (id, size = 'tiny') => {
    const choices = rows(id);
    if (choices.length === 1) return picture(choices[0].id, size);
    const files = new Set(choices.map((e) => index().images?.[e.id] || ''));
    if (files.size === 1 && !files.has('')) return picture(choices[0].id, size);
    const kind = choices[0]?.kind;
    return `<span class="game-picture game-picture-${size} image-unavailable" aria-hidden="true"><span class="image-fallback">${icon(kind === '人物' ? 'person' : kind === '任务' ? 'scroll' : 'bag')}</span></span>`;
  };
  function button(action, label, cls, id, glyph = '', accessibleLabel = '') {
    const entity =
      ['database-detail', 'world-quest', 'flow-quest', 'entity-choice'].includes(action) && rows(id).length;
    return `<button type="button" class="${cls}${entity ? ' pictured-link entity-link' : ''}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}${entity ? ` data-entity-id="${esc(id)}"` : ''}${accessibleLabel ? ` aria-label="${esc(accessibleLabel)}"` : ''}>${entity ? artwork(id) + '<span class="entity-link-label">' + (action === 'database-detail' ? qualityText.html(id, label) : label) + '</span>' : (glyph ? icon(glyph) : '') + label}</button>`;
  }
  function text(value, taskAction = 'world-quest') {
    const source = String(value ?? ''),
      data = catalog();
    if (!data) return esc(source);
    let html = '',
      at = 0;
    data.pattern.lastIndex = 0;
    for (const match of source.matchAll(data.pattern)) {
      html += esc(source.slice(at, match.index));
      const choices = data.names.get(match[0]) || [];
      const e = choices[0];
      html +=
        choices.length === 1
          ? button(
              e.kind === '任务' ? taskAction : 'database-detail',
              esc(match[0]),
              'text-btn entity-inline',
              e.id,
            )
          : button('entity-choice', esc(match[0]), 'text-btn entity-inline', 'name:' + match[0]);
      at = match.index + match[0].length;
    }
    return html + esc(source.slice(at));
  }
  function preview(id, context = {}) {
    const choices = rows(id),
      e = choices[0];
    if (!e) return '';
    const name = choices.length > 1 ? id.slice(5) : e.name;
    let lines = [],
      note = '';
    if (choices.length > 1) {
      lines = [
        `${choices.length} 条同名资料，点击后选择具体人物、品质或步骤。`,
        ...choices
          .slice(0, 3)
          .map((row) => `${row.kind}${row.quality ? ' · ' + row.quality + '色' : ''} · #${row.gameId}`),
      ];
      note = '同名不等于同一身份或同一件装备。';
    } else if (e.kind === '人物') {
      if (e.npcFacts)
        lines.push(
          `静态等级 ${e.npcFacts.level} · 可查 ${new Set(e.npcFacts.fixedItems.map((item) => item.id)).size} 种初始固定私物`,
        );
      if (e.hobbies?.length) lines.push('赠礼偏好：' + e.hobbies.join('、'));
      const place = index().world?.maps?.find((m) => m.key === e.walkMap);
      if (place) lines.push('资料中的行走场景：' + place.name);
      const related = catalog().personRelations(e);
      lines.push(
        '相关任务：' +
          (related.quests
            .slice(0, 2)
            .map((row) => row.entity.name.replace(/^【[^】]+】/, ''))
            .join('、') || '暂无具名关联'),
      );
      note = '静态人物资料；当前地点、好感与能否交互需游戏内核对。';
    } else if (e.kind === '任务') {
      const state = context.statuses?.get(e.id) || questStatus(e.gameId, context.reference);
      lines.push((context.name || context.reference?.name || '仅查资料') + ' · ' + state);
      const relation = catalog().taskRelations(e);
      const people = relation.people.filter((row) =>
        row.roles.some((role) => ['接取人物', '完成人物'].includes(role)),
      );
      if (people.length)
        lines.push(
          '交互人物：' +
            people
              .slice(0, 3)
              .map((row) => row.entity.name)
              .join('、'),
        );
      if (relation.items.length)
        lines.push(
          '涉及材料：' +
            relation.items
              .slice(0, 3)
              .map((row) => row.entity.name)
              .join('、'),
        );
      if (relation.group.length > 1)
        lines.push('含 ' + (relation.group.length - 1) + ' 个相关步骤，点击查看状态与关联。');
      note = '依据已保存记录；未出现不代表错过，相关步骤不保证执行顺序。';
    } else if (e.kind === '物品') {
      const numeric = itemNumericSummary(e, index());
      lines.push(numeric || (e.stats ? '主要用于材料、学习或剧情；详细用途见图鉴。' : '数值资料尚未收录。'));
      if (typeof e.buyPrice === 'number')
        lines.push(
          '资料买价：' +
            e.buyPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) +
            ' 文' +
            (e.giftable ? ' · 可赠礼' : ''),
        );
      const inventory = context.reference?.metadata?.inventory;
      if (Array.isArray(inventory))
        lines.push(
          (context.reference.name || '已保存参照') +
            ' · 库存 ' +
            inventory.reduce(
              (sum, row) =>
                sum +
                (row.id === e.gameId && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0),
              0,
            ),
        );
      note = '模板基础资料；随机词条、角色加成和当前库存以游戏内为准。';
    } else if (e.kind === '配方') {
      lines.push(
        `${e.craft || e.type} ${e.level} 级`,
        '材料：' +
          (e.materials || [])
            .slice(0, 3)
            .map((m) => `${m.name} ×${m.count}`)
            .join('、'),
      );
      note = '制作等级、已学状态和库存请在详情对照。';
    } else note = '资料效果可能取决于修炼等级和游戏状态。';
    const description =
      choices.length === 1 && e.kind !== '任务' ? String(e.description || '').slice(0, 100) : '';
    return `<div class="entity-preview-heading">${artwork(id, 'card')}<div><small>${esc(choices.length > 1 ? '同名资料' : e.kind)}${choices.length === 1 && e.quality ? ' · ' + esc(e.quality) + '色' : ''}</small><strong>${esc(name)}</strong></div></div>${description ? `<p class="entity-preview-description">${esc(description)}</p>` : ''}${lines
      .slice(0, 4)
      .map((line) => `<p>${esc(line)}</p>`)
      .join(
        '',
      )}<p class="entity-preview-note">${esc(note)}</p><small class="entity-preview-hint">点击名称查看完整图鉴 · Esc 收起</small>`;
  }
  return { button, text, preview, artwork, choices: rows };
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
    dismissed = null;
  const eligible = (node) =>
    node?.closest?.(
      '[data-entity-id], [data-action="database-detail"][data-id], [data-action="world-quest"][data-id], [data-action="flow-quest"][data-id]',
    );
  const close = (dismissCurrent = false) => {
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
      rect = panel.getBoundingClientRect(),
      margin = 10;
    const width = document.documentElement.clientWidth,
      height = window.innerHeight;
    panel.style.left = Math.max(margin, Math.min(bounds.left, width - rect.width - margin)) + 'px';
    const below = bounds.bottom + 4;
    panel.style.top =
      Math.max(
        margin,
        Math.min(
          below + rect.height <= height - margin ? below : bounds.top - rect.height - 4,
          height - rect.height - margin,
        ),
      ) + 'px';
  };
  const show = (node, immediate = false) => {
    clearTimeout(hideTimer);
    if (!node || node === dismissed || node === trigger || node === pending || node.disabled) return;
    close();
    pending = node;
    timer = setTimeout(
      async () => {
        if (!node.isConnected || node.disabled) return close();
        let details;
        try {
          details = await context(node);
        } catch {
          details = {};
        }
        if (pending !== node || !node.isConnected || node.closest('[inert]')) return;
        const html = references.preview(node.dataset.entityId || node.dataset.id, details);
        if (!html) return close();
        trigger = node;
        pending = null;
        panel.innerHTML = html;
        panel.hidden = false;
        node.setAttribute('aria-describedby', panel.id);
        position();
      },
      immediate ? 0 : 240,
    );
  };
  const leave = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (panel.matches(':hover') || trigger?.matches(':hover') || document.activeElement === trigger) return;
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
      if (pending === node) close();
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
  return { close };
}
