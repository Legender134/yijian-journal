import { placeEntityId, entityCatalog } from './entity-catalog.js';
import { createCodexDetailViews } from './codex-detail-views.js';
import { compileSearch, compareSearchTitles } from './search-query.js';
import { createItemStatViews, itemNumericSummary } from './item-stat-views.js';
import { createNpcFactViews } from './npc-fact-views.js';
import { createNpcProgressViews } from './npc-progress-views.js';
export const CODEX_PAGE_SIZE = 96;
export function codexEntries(index, statuses = new Map()) {
  const kinds = new Map((index.world?.quests || []).map((q) => [q.id, q.kind]));
  return [...entityCatalog(index).entries.values()].map((e) =>
    e.kind === '任务'
      ? {
          ...e,
          type: e.parentId ? '任务步骤' : kinds.get(e.id) === 'Primary' ? '主线' : '支线',
          status: statuses.get(e.gameId) || '待核对',
        }
      : e.kind === '地点'
        ? { ...e, type: e.cave ? '洞窟' : '地点' }
        : e,
  );
}

// Rendering helpers for the local game index. All game strings remain plain text.
export function createGameViews({
  esc,
  icon,
  act,
  pill,
  empty,
  notice,
  bytes,
  when,
  hours,
  iconButton,
  picture,
  qualityText,
  richText = esc,
  variantSummary = () => '',
  personRelations = () => '',
  placeMap = () => '',
}) {
  const itemStats = createItemStatViews({ esc, act });
  const codexDetails = createCodexDetailViews({ esc, act, richText });
  const npcFacts = createNpcFactViews({ esc, act });
  const npcProgress = createNpcProgressViews({ esc, act, richText });
  const byId = (index, id) => index.entries.find((e) => e.id === id);
  const glyph = (kind) => ({ 物品: 'bag', 武学: 'sword', 人物: 'person', 配方: 'scroll' })[kind] || 'book';
  const typeName = (e) => (e.kind === '配方' ? `${e.type} · ${e.level} 级` : e.type);
  function recordedQuestRoots(quests) {
    const ids = new Set(quests.map((q) => q.id));
    return quests.filter((q) => !q.parentId || !ids.has(q.parentId));
  }
  function page(index, query, kind, type, pageNumber, statuses = new Map()) {
    const categories = ['全部', '任务', '人物', '物品', '武学', '配方', '地点'];
    const entities = codexEntries(index, statuses);
    const all = entities.filter(
      (e) =>
        (kind === '全部' || e.kind === kind) &&
        (query.trim() || type === '任务步骤' || e.kind !== '任务' || !e.parentId),
    );
    const types = [
      ...new Set(entities.filter((e) => kind === '全部' || e.kind === kind).map((e) => e.type)),
    ].filter(Boolean);
    let match,
      compareTitles = () => 0,
      searchError = '';
    try {
      match = compileSearch(query);
      compareTitles = compareSearchTitles(query);
    } catch (e) {
      searchError = e.message;
      match = () => false;
    }
    const filtered = all
      .map((e) => ({ ...e, quality: qualityText?.quality(e) || e.quality }))
      .filter((e) => (type === '全部' || e.type === type) && match(e))
      .sort(compareTitles);
    const pages = Math.max(1, Math.ceil(filtered.length / CODEX_PAGE_SIZE));
    const current = Math.max(0, Math.min(pageNumber, pages - 1));
    const categoryIcon = (k) => ({ 任务: 'scroll', 地点: 'map', 全部: 'book' })[k] || glyph(k);
    const row = (e) => {
      const action =
        e.kind === '任务' ? 'world-quest' : e.kind === '地点' ? 'world-place' : 'database-detail';
      const name = e.kind === '任务' ? e.name.replace(/^【[^】]+】\s*/, '') : e.name;
      const numeric = itemNumericSummary(e, index);
      const summary =
        e.kind === '人物'
          ? variantSummary(e.id) || (e.hobbies?.length ? e.hobbies.join('、') : '')
          : e.kind === '地点'
            ? variantSummary(e.id)
            : numeric ||
              (e.kind === '配方'
                ? e.materials.map((m) => `${m.name} ×${m.count}`).join('、')
                : e.description || '');
      const category = e.kind === '人物' ? '人物' : typeName(e);
      const showCategory = category && category !== kind && category !== type;
      return `<button class="database-card codex-result" data-action="${action}" data-id="${esc(e.id)}">${picture(e.id, 'card')}<span class="codex-result-copy"><span class="codex-result-heading"><strong>${qualityText.name(e, name)}</strong>${showCategory ? `<small>${esc(category)}</small>` : ''}</span>${summary ? `<span class="codex-result-summary${numeric ? ' database-numeric' : ''}">${esc(summary)}</span>` : ''}</span></button>`;
    };
    return `<section class="codex-browser"><div class="page-header"><h1 class="serif">图鉴</h1></div>
      <div class="database-tabs" role="group" aria-label="图鉴种类">${categories.map((k) => `<button class="database-tab ${kind === k ? 'active' : ''}" data-action="database-kind" data-id="${k}" aria-pressed="${kind === k}">${icon(categoryIcon(k))}<strong>${k}</strong></button>`).join('')}</div>
      <div class="toolbar database-toolbar"><div class="search-input database-search">
        ${icon('search')}<input id="list-search" data-persist="list-search" value="${esc(query)}" placeholder="名称、人物、任务或效果" aria-label="搜索百物图鉴" maxlength="100">
        ${query || type !== '全部' ? iconButton('database-reset', 'close', '清除筛选') : ''}
      </div><select id="database-kind-picker" class="database-kind-picker" aria-label="图鉴种类">${categories.map((k) => `<option value="${esc(k)}"${kind === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select><select id="database-type" aria-label="图鉴分类"><option value="全部">全部分类</option>${types.map((t) => `<option value="${esc(t)}" ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      ${searchError ? notice(searchError, true) : ''}${kind === '地点' && !query.trim() ? placeMap(index, '', { scope: 'world' }) : ''}
      <div class="codex-result-count" role="status">${filtered.length} 项</div>${
        filtered.length
          ? `<div class="database-grid codex-results">${filtered
              .slice(current * CODEX_PAGE_SIZE, (current + 1) * CODEX_PAGE_SIZE)
              .map(row)
              .join(
                '',
              )}</div>${pages > 1 ? `<div class="pagination"><button class="btn" data-action="database-page" data-id="${current - 1}" ${current === 0 ? 'disabled' : ''}>上一页</button><span>${current + 1} / ${pages}</span><button class="btn" data-action="database-page" data-id="${current + 1}" ${current + 1 === pages ? 'disabled' : ''}>下一页</button></div>` : ''}`
          : empty('没有找到匹配的资料', '换个关键词或分类。')
      }</section>`;
  }
  function detail(
    index,
    id,
    quantity = 1,
    reference = null,
    saveOptions = [],
    referenceName = '',
    follow = false,
    reservations = {},
    giftPage = 0,
    allocationTotals = reservations,
    itemUsage = '',
    liveNpcProgress = null,
    liveReference = null,
    stateNotice = '',
  ) {
    const e = byId(index, id);
    if (!e) return '';
    const itemLink = (id, name) =>
      byId(index, `item-${id}`) ? act('database-detail', esc(name), 'text-btn', `item-${id}`) : esc(name);
    let extra = '';
    const reserved = Object.values(allocationTotals).reduce((a, b) => a + b, 0);
    if (e.kind === '物品')
      extra = `${itemStats.detail(index, e)}${e.useLimit ? `<p class="item-use-limit">使用次数上限 ${esc(e.useLimit)} 次</p>` : ''}<details class="detail-block item-trade-details" data-persist-detail="item-trade-${esc(e.id)}"><summary>价格与赠礼</summary><div class="detail-stat-grid"><div><small>买入基础价</small><strong>${e.buyPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 文</strong></div><div><small>卖出基础价</small><strong>${e.sellPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 文</strong></div><div><small>赠礼</small><strong>${e.giftable ? '可以赠送' : '不可赠送'}</strong></div></div></details>`;
    if (e.kind === '武学')
      extra = `${stateNotice ? `<p class="notice info flow-state-notice" role="status">${esc(stateNotice)}</p>` : ''}${e.special ? `<div class="detail-block"><h3>特殊效果</h3><p class="preserve-text">${richText(e.special)}</p></div>` : ''}${codexDetails.skill(index, e, liveNpcProgress || reference?.metadata?.npcProgress, liveReference ? 'live' : 'saved')}`;
    if (e.kind === '人物') {
      const statusReference = liveReference || reference;
      const personProgress = (liveNpcProgress || reference?.metadata?.npcProgress)?.people.find(
        (row) => row.npcId === e.gameId,
      );
      const giftGate = personProgress?.gift;
      const initialFacts = npcFacts.person(index, e);
      const missingOperations =
        !personProgress && Array.isArray(e.functions)
          ? [
              ['Gift', '赠礼'],
              ['Compare', '比武'],
              ['Consult', '请教'],
            ]
              .filter(([key]) => !e.functions.includes(key))
              .map(([, label]) => label)
          : [];
      const unavailableOperations = missingOperations.length
        ? `<p class="npc-unavailable-entry">${missingOperations.map(esc).join('、')}：暂无入口</p>`
        : '';
      const qualities = ['白', '绿', '蓝', '金', '暗金', '红'];
      const minimumQuality = qualities.indexOf(giftGate?.minimumQuality);
      const inventory = Array.isArray(statusReference?.metadata.inventory) ? new Map() : null;
      for (const item of inventory ? statusReference.metadata.inventory : [])
        inventory.set(item.id, (inventory.get(item.id) || 0) + item.count);
      const gifts = index.entries
        .filter((x) => x.kind === '物品' && x.giftable && e.hobbyKeys.includes(x.typeKey))
        .filter((x) => minimumQuality < 0 || qualities.indexOf(x.quality) >= minimumQuality)
        .filter((x) => !inventory || inventory.get(x.gameId) > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.gameId - b.gameId);
      const pages = Math.max(1, Math.ceil(gifts.length / 24));
      giftPage = Math.min(giftPage, pages - 1);
      extra = `${stateNotice ? `<p class="notice info flow-state-notice" role="status">${esc(stateNotice)}</p>` : ''}${personProgress?.place ? `<p class="codex-person-place">${act('world-place', esc(personProgress.place.name), 'text-btn', personProgress.place.id)}</p>` : ''}${npcProgress.person(
        personProgress,
        false,
        liveReference ? 'live' : 'saved',
      )}${unavailableOperations}${initialFacts ? (personProgress ? `<details class="detail-block" data-persist-detail="npc-template-${esc(e.id)}"><summary>初始资料</summary>${initialFacts}</details>` : initialFacts) : ''}${personRelations(index, e, statusReference)}${
        e.hobbies.length
          ? Array.isArray(e.functions) && !e.functions.includes('Gift')
            ? `<details class="detail-block" data-persist-detail="person-hobbies-${esc(e.id)}"><summary>初始偏好</summary><div class="tag-row">${e.hobbies.map((h) => pill(h, 'green')).join('')}</div></details>`
            : `<details class="detail-block person-gifts" data-persist-detail="person-gifts-${esc(e.id)}"><summary>赠礼偏好 · ${e.hobbies.map(esc).join('、')}</summary><p>${inventory ? '背包中的偏好物品' : '符合偏好的物品'} · ${gifts.length} 种${minimumQuality >= 0 ? ` · ${esc(giftGate.minimumQuality)}色起` : ''}</p><div class="related-items">${
                gifts
                  .slice(giftPage * 24, giftPage * 24 + 24)
                  .map(
                    (g) =>
                      act(
                        'database-detail',
                        esc(g.name) +
                          (g.quality ? ` · ${esc(g.quality)}色` : '') +
                          (inventory ? ` · ${inventory.get(g.gameId)} 件` : ''),
                        'btn',
                        g.id,
                      ) +
                      (giftGate?.status === 'unmet'
                        ? ''
                        : iconButton('journey-gift-dialog', 'plus', '规划赠送' + g.name, e.id + ':' + g.id)),
                  )
                  .join('') ||
                `<p class="small muted">${inventory ? '背包中暂无符合条件的物品' : '暂无符合条件的物品'}</p>`
              }</div>${gifts.length > 24 ? `<div class="history-pagination"><button class="btn" data-action="gift-page" data-id="${giftPage - 1}" ${giftPage === 0 ? 'disabled' : ''}>上一页</button><span>共 ${gifts.length} 种 · 第 ${giftPage + 1} / ${pages} 页</span><button class="btn" data-action="gift-page" data-id="${giftPage + 1}" ${giftPage + 1 >= pages ? 'disabled' : ''}>下一页</button></div>` : ''}${reserved ? `<p class="save-note">${inventory ? '已扣除预留数量' : '库存未读取'}</p>` : ''}</details>`
          : ''
      }${e.lifeSkills?.length ? `<details class="detail-block"><summary>初始生活技能</summary><div class="tag-row mt">${e.lifeSkills.map((s) => pill(`${s.name} ${s.level} 级`)).join('')}</div></details>` : ''}${e.skills?.length ? `<details class="detail-block"><summary>初始武学</summary><div class="related-items mt">${e.skills.map((s) => act('database-detail', esc(byId(index, s.id)?.name || s.id) + ` · ${s.level}`, 'btn', s.id)).join('')}</div></details>` : ''}${e.friendshipLocks?.length && index.renderRequirements ? `<details class="detail-block"><summary>好感解锁条件</summary>${e.friendshipLocks.map((l) => `<h3 class="mt">${l.at} 好感</h3>${index.renderRequirements(l.requirements, index, { reference: statusReference })}`).join('')}</details>` : ''}${e.joinRequirements?.length && index.renderRequirements ? `<details class="detail-block"><summary>入队条件</summary>${index.renderRequirements(e.joinRequirements, index, { reference: statusReference })}</details>` : ''}${act('world-person', '全部相关任务', 'btn', e.id, 'scroll')}`;
      const shop = index.merchants?.find((m) => m.id === e.gameId);
      if (shop)
        extra += `<details class="detail-block shop-stock"><summary>售卖清单 · ${shop.items.length} 种</summary><div class="related-items mt">${shop.items.map((id) => itemLink(id, byId(index, `item-${id}`)?.name || `物品 #${id}`)).join('')}</div></details>`;
    }
    if (e.kind === '配方')
      extra = `<div class="recipe-box"><div class="row between"><h3>备料计算</h3><label class="quantity-label">制作次数 <input id="recipe-quantity" data-id="${e.id}" type="number" min="1" max="999" step="1" value="${quantity}" aria-label="制作次数"></label></div><p class="small muted">基础要求：${esc(e.craft || e.type)} ${e.level} 级</p><div id="recipe-materials">${recipeMaterials(e, quantity, index, reference)}</div>${reserved ? '<p class="small muted">可用库存已扣除本周目预留数量。</p>' : ''}</div><div class="detail-block"><h3>每次产出</h3>${e.results.map((r) => `<div class="material-row"><span>${itemLink(r.id, r.name)}</span><span>× ${r.count}</span></div>`).join('')}</div>`;
    if (e.kind === '配方')
      extra += `<div class="detail-block">${act('craft-add', '加入备料清单', 'btn', e.id, 'plus')} ${act('craft-open', '查看备料清单', 'text-btn')}</div>`;
    if (e.kind === '配方' && reference) {
      const learned =
        reference.metadata[
          { fusion: 'fusionRecipes', alchemy: 'alchemyRecipes', cooking: 'cookingRecipes' }[e.recipeType]
        ];
      if (Array.isArray(learned))
        extra = notice(learned.includes(e.gameId) ? '已学会' : '尚未学会', true) + extra;
    }
    if (e.kind === '配方' && e.learningItems?.length)
      extra += `<div class="detail-block recipe-learning"><h3>学习这份配方的图纸</h3><div class="related-items">${e.learningItems.map((id) => itemLink(id, byId(index, `item-${id}`)?.name || `物品 #${id}`)).join('')}</div></div>`;
    if (e.kind === '物品') {
      if (e.acquisitionRoutes?.length)
        extra += `<section class="detail-block item-acquisition-routes"><h3>阶段获取线索</h3>${e.acquisitionRoutes.map((route) => `<h4>${esc(route.title)}</h4><p>${richText(route.detail)}</p>${act('world-quest', '查看对应任务步骤', 'text-btn', 'quest-' + route.questId)}<details><summary>资料来源</summary>${route.uncertainty ? `<p class="small">${esc(route.uncertainty)}</p>` : ''}${route.sources.map((source) => `<p>${act('source', esc(source.title), 'text-btn', source.id)}<span class="small muted"> · ${esc(source.date)} · ${esc(source.version)}</span></p>`).join('')}</details>`).join('')}</section>`;
      extra += codexDetails.item(index, e);
      const holderProgress =
        liveReference?.origin === 'live'
          ? liveNpcProgress?.origin === 'live'
            ? liveNpcProgress
            : null
          : reference?.origin !== 'live' && reference?.metadata?.npcProgress?.origin !== 'live'
            ? reference?.metadata?.npcProgress
            : null;
      extra += npcFacts.holders(index, e, holderProgress);
      extra += `${itemUsage}`;
      extra += `<details class="detail-block reservation-editor"><summary>预留物品</summary><div class="row"><label class="quantity-label">保留<input id="reserve-count" type="number" min="0" max="999999" step="1" value="${reservations[e.gameId] || 0}" aria-label="保留物品数量"></label>${act('reserve-save', '保存预留数量', 'btn', e.id, 'shield')}</div></details>`;
      const produced = index.entries.filter(
        (r) => r.kind === '配方' && r.results.some((x) => x.id === e.gameId),
      );
      if (produced.length)
        extra += `<div class="detail-block item-produced"><h3>可通过这些配方制作</h3><div class="related-items">${produced.map((r) => act('database-detail', esc(r.name), 'btn', r.id)).join('')}</div></div>`;
      if (e.teachesRecipes?.length)
        extra += `<div class="detail-block item-teaches"><h3>使用后可学习</h3><div class="related-items">${e.teachesRecipes.map((id) => act('database-detail', esc(byId(index, id)?.name || id), 'btn', id)).join('')}</div></div>`;
      const sellers = [
        ...new Map(
          (index.merchants || [])
            .filter((m) => m.items.includes(e.gameId))
            .map((m) => [m.name + '\n' + m.description, m]),
        ).values(),
      ];
      if (sellers.length)
        extra += `<details class="detail-block item-sellers"><summary>售卖人物 · ${sellers.length} 条线索</summary>${sellers.map((m) => `<div class="seller-line"><strong>${byId(index, `npc-${m.id}`) ? act('database-detail', esc(m.name), 'text-btn', `npc-${m.id}`) : esc(m.name)}</strong>${m.description ? `<p class="small muted">${richText(m.description)}</p>` : ''}</div>`).join('')}</details>`;
      const uses = index.entries.filter(
        (r) =>
          r.kind === '配方' &&
          r.materials.some((m) => m.id === e.gameId || m.alternatives?.includes(e.gameId)),
      );
      if (uses.length)
        extra += `<div class="detail-block"><h3>用于这些配方 · ${uses.length} 种</h3><div class="related-items">${uses
          .slice(0, 8)
          .map((r) => act('database-detail', esc(r.name), 'btn', r.id))
          .join(
            '',
          )}</div>${uses.length > 8 ? act('database-uses', '查看全部相关配方', 'text-btn', e.id, 'arrow') : ''}</div>`;
    }
    const guides =
      index.guideEntries?.filter((g) => g.title.includes(e.name) || e.name.includes(g.title)) || [];
    return `<section class="drawer" role="dialog" aria-modal="true" aria-label="${esc(e.name)}资料"><div class="drawer-head"><span class="small muted">图鉴 / ${e.kind}</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="game-detail-title">${picture(e.id, 'detail')}<div><h1>${qualityText.name(e, e.name)}</h1><div class="game-detail-meta">${e.kind === '人物' ? '' : esc(typeName(e))}${e.quality ? ' · ' + esc(e.quality) + '色' : ''}</div></div></div>${e.description && e.kind !== '人物' ? `<p class="intro preserve-text">${richText(e.description)}</p>` : ''}${extra}${e.description && e.kind === '人物' ? `<details class="detail-block"><summary>人物经历</summary><p class="preserve-text">${richText(e.description)}</p></details>` : ''}${guides.length ? `<div class="detail-block"><h3>手札里的相关线索</h3>${guides.map((g) => '<div class="row wrap mb"><span>' + richText(g.title) + '</span>' + act('detail', '查看线索', 'text-btn', g.id, 'arrow') + '</div>').join('')}</div>` : ''}</div><div class="drawer-actions">${act(e.kind === '配方' ? 'recipe-goal' : 'database-goal', e.kind === '配方' ? '把备料单加入待办' : '设为目标', 'btn primary', e.id, 'plus')}${e.kind === '人物' && (!Array.isArray(e.functions) || e.functions.includes('Gift')) ? (e.hobbies.length ? act('database-gifts', '偏好物品', 'btn', e.id, 'search') : '') + act('journey-gift-dialog', '规划赠礼', 'btn', e.id, 'plus') : e.kind === '物品' && e.giftable ? act('journey-gift-dialog', '规划赠礼', 'btn', ':' + e.id, 'plus') : ''}</div></section>`;
  }
  function recipeMaterials(e, quantity, index, reference = null) {
    const inventory = reference?.metadata.inventory,
      owned = new Map((inventory || []).map((i) => [i.id, i.count]));
    const outputs = e.outputReference || [];
    const totalOutputs = `<div class="detail-block" data-recipe-total-outputs><h3>制作 ${quantity} 次的预计总产物</h3>${
      outputs.length
        ? outputs
            .map((output) => {
              const scale = (count) => {
                const total = count * quantity;
                return Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(total) ? total : null;
              };
              const lower = scale(output.minimumCount),
                upper = scale(output.maximumCount),
                minimum = output.guaranteedItem ? lower : 0;
              const count =
                lower === null || upper === null || lower > upper
                  ? ' · 数量待游戏内确认'
                  : ` × ${minimum.toLocaleString()}${minimum !== upper ? '–' + upper.toLocaleString() : ''}`;
              const name = byId(index, 'item-' + output.id)
                ? act('database-detail', esc(output.name), 'text-btn', 'item-' + output.id)
                : esc(output.name);
              return `<p class="small" data-recipe-output-id="${esc(output.id)}"><strong>${output.guaranteedItem ? '预计产物' : '可能产物'}：${name}${output.quality ? ' · ' + esc(output.quality) + '色' : ''}${count}</strong></p>`;
            })
            .join('')
        : '<p class="save-note">资料未提供可计算产物数量，请在游戏内确认。</p>'
    }${outputs.some((output) => !output.guaranteedItem) ? '<p class="save-note">随机产出，各候选不会全部同时获得。</p>' : ''}</div>`;
    return `${totalOutputs}${e.materials
      .map((m) => {
        const have = (m.alternatives || [m.id]).reduce((sum, id) => sum + (owned.get(id) || 0), 0),
          need = m.count * quantity,
          missing = Math.max(0, need - have);
        return `<div class="material-row"><div class="spacer">${byId(index, `item-${m.id}`) ? act('database-detail', esc(m.name), 'text-btn', `item-${m.id}`) : esc(m.name)}${
          m.alternatives
            ? `<details class="ingredient-options"><summary>可替代食材</summary><p>${richText(m.description)}</p>${m.alternatives
                .map((id) => {
                  const item = byId(index, `item-${id}`);
                  return item ? act('database-detail', esc(item.name), 'text-btn', item.id) : '';
                })
                .join('、')}</details>`
            : ''
        }${inventory ? `<small class="material-owned">已有 ${have.toLocaleString()}</small>` : ''}</div><strong>需 ${need.toLocaleString()}</strong>${inventory ? pill(missing ? `缺 ${missing}` : '足够', missing ? 'orange' : 'green') : ''}</div>`;
      })
      .join(
        '',
      )}<div class="material-row total"><span>所需铜钱${reference?.metadata.money !== undefined ? `<small class="material-owned">存档中 ${reference.metadata.money.toLocaleString()} 文</small>` : ''}</span><strong>${(e.money * quantity).toLocaleString()} 文</strong></div>`;
  }
  function saveDetail(file, index) {
    const trackedName = (quest, id) =>
      index.world?.quests?.some((entry) => entry.id === 'quest-' + id)
        ? act('world-quest', esc(quest.name), 'text-btn', 'quest-' + id)
        : esc(quest.name);
    const m = file.metadata;
    const maps = index.world?.maps || [];
    const places = maps.filter((place) => place.key === m.map);
    const location =
      places.length === 1
        ? act('world-place', esc(m.mapName), 'text-btn', placeEntityId(places[0], maps))
        : esc(m.mapName);
    const recipes = [
      ...(m.fusionRecipes || []).map((id) => byId(index, `fusion-${id}`)),
      ...(m.alchemyRecipes || []).map((id) => byId(index, `alchemy-${id}`)),
      ...(m.cookingRecipes || []).map((id) => byId(index, `cooking-${id}`)),
    ].filter(Boolean);
    return `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="${esc(file.name)}存档回顾"><div class="drawer-head"><span>存档回顾</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="tag-row">${pill(file.name)}${act('save-compare', '比较进度', 'text-btn', file.name, 'search')}</div><h1>${location}</h1><p class="small muted">${when(file.modifiedAt)} · 累计游玩 ${hours(m.playSeconds)}</p>${m.money !== undefined ? `<p>铜钱 ${m.money.toLocaleString()} 文</p>` : ''}${m.team?.length ? `<div class="detail-block"><h3>同行伙伴</h3><div class="tag-row">${m.team.map((n) => (byId(index, `npc-${n.id}`) ? act('database-detail', esc(n.name), 'btn', `npc-${n.id}`) : `<span class="pictured-label">${picture(`npc-${n.id}`)}${pill(n.name, 'green')}</span>`)).join('')}</div></div>` : ''}${
      m.mainQuest || m.quest
        ? `<details class="save-quests"><summary>追踪任务 · ${[
            [m.mainQuest, m.trackingMainQuest],
            [m.quest, m.trackingQuest],
          ]
            .filter(([quest]) => quest)
            .map(([quest, id]) => trackedName(quest, id))
            .join('、')}</summary>${[
            [m.mainQuest, m.trackingMainQuest],
            [m.quest, m.trackingQuest],
          ]
            .filter(([quest]) => quest)
            .map(
              ([q, id]) =>
                `<div class="detail-block"><h3>${index.world?.quests?.some((entry) => entry.id === `quest-${id}`) ? act('world-quest', esc(q.name), 'text-btn', `quest-${id}`) : esc(q.name)}</h3><p class="preserve-text">${richText(q.description)}</p></div>`,
            )
            .join('')}</details>`
        : ''
    }${Array.isArray(m.quests) ? `<details class="save-quests save-recorded-quests"><summary>这份存档的任务记录 · ${recordedQuestRoots(m.quests).length} 项</summary><div id="save-quest-results">${questList(m.quests, 'active', m.inventory, index)}</div><p class="save-note">只展示游戏资料中可见的任务及其存档状态。未出现在列表中，不等于错过或未完成；失败原因与后续分支需在游戏内确认。</p></details>` : ''}<details class="save-quests"><summary>已记录的制作配方 · ${recipes.length} 条</summary><div class="learned-recipes">${recipes.map((r) => `<button data-action="database-detail" data-id="${r.id}">${picture(r.id)}<span class="spacer">${qualityText.name(r.id, r.name)}</span>${icon('chevron')}</button>`).join('') || '<p class="small muted">这份存档暂未识别到可展示的配方。</p>'}</div></details>${Array.isArray(m.inventory) ? `<details class="save-quests"><summary>物品记录 · ${m.inventory.length} 种</summary><label class="search-input inventory-search">${icon('search')}<input id="save-inventory-search" placeholder="查找这份存档里的物品" aria-label="搜索存档物品" maxlength="100"></label><div id="save-inventory-results">${inventoryList(m.inventory, '', index)}</div></details>` : ''}${m.thumbnail || m.difficultyName ? `<details class="save-quests"><summary>当时画面与难度</summary>${m.thumbnail ? `<div class="save-thumbnail"><img src="${m.thumbnail}" alt="这份存档自带的场景缩略图"></div>` : ''}${m.difficultyName ? `<p>难度：${esc(m.difficultyName)}</p>` : ''}</details>` : ''}</div><div class="drawer-actions">${act('backup', '备份当前整个存档目录', 'btn primary', '', 'archive')}${act('save-recap-goal', '记下这次出发', 'btn', file.name, 'feather')}</div></section>`;
  }
  function questList(quests, filter, inventory = null, index = null) {
    const byQuestId = new Map(quests.map((q) => [q.id, q])),
      activeFamilyIds = new Set();
    for (const q of quests.filter((q) => q.step === 1)) {
      let at = q;
      const seen = new Set();
      while (at && !seen.has(at.id)) {
        seen.add(at.id);
        activeFamilyIds.add(at.id);
        at = byQuestId.get(at.parentId);
      }
    }
    const roots = recordedQuestRoots(quests),
      active = roots.filter((q) => activeFamilyIds.has(q.id)),
      done = roots.filter((q) => q.step === 4),
      other = roots.filter((q) => q.step !== 1 && q.step !== 4),
      list = { active, done, other }[filter] || active;
    return `<div class="quest-tabs">${[
      ['active', `进行中 ${active.length}`],
      ['done', `已完成 ${done.length}`],
      ['other', `其他 ${other.length}`],
    ]
      .map(
        ([id, label]) =>
          `<button class="chip ${filter === id ? 'active' : ''}" data-action="save-quest-filter" data-id="${id}">${label}</button>`,
      )
      .join('')}</div>${
      list.length
        ? list
            .map(
              (q) =>
                `<article class="saved-quest" data-quest-id="${q.id}"><div class="row between"><h3>${act('world-quest', esc(q.name), 'text-btn', `quest-${q.id}`)}</h3>${pill(q.status, q.step === 1 ? 'green' : q.step === 2 ? 'orange' : '')}</div>${q.parentId && !byQuestId.has(q.parentId) ? '<p class="save-note">这份存档未记录上级任务，仅按当前已记录的步骤核对。</p>' : ''}<details><summary>查看任务文字与步骤</summary><p>${richText(q.description)}</p>${questMaterials(q, inventory, index)}${quests
                  .filter((child) => child.parentId === q.id)
                  .map(
                    (c) =>
                      `<div class="quest-step"><span>${act('world-quest', esc(c.name), 'text-btn', `quest-${c.id}`)}</span><small>${esc(c.status)}</small></div>${c.step === 1 ? `<p>${richText(c.description)}</p>${questMaterials(c, inventory, index)}` : ''}`,
                  )
                  .join(
                    '',
                  )}</details>${act('world-quest', '查看任务关联资料', 'text-btn', `quest-${q.id}`, 'arrow')}${q.step === 1 ? act('save-quest-goal', '放入我的待办', 'text-btn', String(q.id), 'plus') : ''}</article>`,
            )
            .join('')
        : empty('这个分类下没有记录', '可切换到其他任务状态。')
    }`;
  }
  function questMaterials(q, inventory, index) {
    if (!q.materials?.length) return '';
    const owned = new Map((inventory || []).map((i) => [i.id, i.count]));
    return `<div class="quest-materials"><small>任务资料中的材料要求</small>${q.materials.map((m) => `<div class="material-row"><span>${index && byId(index, `item-${m.id}`) ? act('database-detail', esc(m.name), 'text-btn', `item-${m.id}`) : esc(m.name)}</span><span>需 ${m.count}${inventory ? ` · 已有 ${owned.get(m.id) || 0}` : ''}</span></div>`).join('')}<p>其他对话或剧情条件，请按任务文字核对。</p></div>`;
  }
  function inventoryList(inventory, query, index) {
    const q = query.trim().toLowerCase(),
      filtered = inventory.filter((i) => !q || [i.name, i.type].join(' ').toLowerCase().includes(q));
    return `${
      filtered
        .slice(0, 60)
        .map(
          (i) =>
            `<div class="material-row"><span class="spacer">${byId(index, `item-${i.id}`) ? act('database-detail', esc(i.name), 'text-btn', `item-${i.id}`) : esc(i.name)}<small class="material-owned">${esc(i.type)}</small></span><strong>× ${i.count.toLocaleString()}</strong></div>`,
        )
        .join('') || '<p class="save-note">这份存档中没有匹配的物品记录。</p>'
    }${filtered.length > 60 ? `<p class="save-note">还有 ${filtered.length - 60} 项，请输入名称缩小范围。</p>` : ''}`;
  }
  return { page, detail, recipeMaterials, saveDetail, questList, inventoryList, byId };
}
