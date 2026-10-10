import { compileSearch } from './search-query.js';
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
}) {
  const byId = (index, id) => index.entries.find((e) => e.id === id);
  const glyph = (kind) => ({ 物品: 'bag', 武学: 'sword', 人物: 'person', 配方: 'scroll' })[kind] || 'book';
  const typeName = (e) => (e.kind === '配方' ? `${e.type} · ${e.level} 级` : e.type);
  function recordedQuestRoots(quests) {
    const ids = new Set(quests.map((q) => q.id));
    return quests.filter((q) => !q.parentId || !ids.has(q.parentId));
  }
  function page(index, query, kind, type, pageNumber) {
    const categories = ['全部', '物品', '武学', '人物', '配方'];
    const all = index.entries.filter((e) => kind === '全部' || e.kind === kind);
    const types = [...new Set(all.map((e) => e.type))];
    const q = query.trim();
    let match,
      searchError = '';
    try {
      match = compileSearch(query);
    } catch (e) {
      searchError = e.message;
      match = () => false;
    }
    const filtered = all.filter(
      (e) =>
        (type === '全部' || e.type === type) &&
        match({ ...e, quality: qualityText?.quality(e) || e.quality }),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / 24)),
      current = Math.min(pageNumber, pages - 1);
    const list = filtered.slice(current * 24, current * 24 + 24);
    return `<div class="page-header"><div><div class="eyebrow">THE THINGS WE SEEK</div><h1 class="serif">百物图鉴</h1><p>查一件物品，备一份材料，了解一位侠客的喜好。</p></div>${pill('离线资料 · 本机游戏提取', 'green')}</div>${searchError ? notice(searchError, true) : ''}
      <div class="database-tabs">${categories.map((k) => `<button class="database-tab ${kind === k ? 'active' : ''}" data-action="database-kind" data-id="${k}">${icon(glyph(k))}<strong>${k}</strong><span>${k === '全部' ? index.entries.length : index.entries.filter((e) => e.kind === k).length}</span></button>`).join('')}</div>
      <div class="toolbar"><label class="search-input database-search">${icon('search')}<input id="list-search" data-persist="list-search" value="${esc(query)}" placeholder="${kind === '人物' ? '输入名字或赠礼类别，如：字画' : '输入名称、材料或效果，如：铁矿石'}" aria-label="搜索百物图鉴" maxlength="100"></label><select id="database-type" aria-label="图鉴分类"><option value="全部">全部分类</option>${types.map((t) => `<option value="${esc(t)}" ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${q || type !== '全部' ? act('database-reset', '清除筛选', 'btn', '', 'refresh') : ''}<span class="spacer"></span>${pill(`${filtered.length} 项结果`)}</div>
      ${list.length ? `<div class="database-grid">${list.map((e) => `<button class="database-card" data-action="database-detail" data-id="${e.id}"><div class="row between">${picture(e.id, 'card')}${qualityText.label(e) || pill(e.kind)}</div><h3>${qualityText.name(e, e.name)}</h3><p>${esc(e.kind === '人物' ? (e.hobbies.length ? `偏好：${e.hobbies.join('、')}` : '查看相关任务、武学或售卖线索') : e.kind === '配方' ? e.materials.map((m) => `${m.name} ×${m.count}`).join('、') : e.description || '查看本机资料详情')}</p><div class="database-card-foot">${esc(typeName(e))}${e.kind === '人物' ? ` · #${e.gameId}` : ''}${icon('chevron')}</div></button>`).join('')}</div><div class="pagination">${act('database-page', '上一页', 'btn', String(Math.max(0, current - 1)))}<span>第 ${current + 1} / ${pages} 页</span>${act('database-page', '下一页', 'btn', String(Math.min(pages - 1, current + 1)))}</div>` : empty('没有找到匹配的资料', '换个名称、效果词，或切换上方分类。')}
      <p class="save-note">资料来自本机游戏 Build ${esc(index.build)}。名称可能包含尚未遇到的内容；数据表中的条目不代表当前周目一定可获得。当前已收录锻造、制衣、炼丹与烹饪配方。</p>`;
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
  ) {
    const e = byId(index, id);
    if (!e) return '';
    const itemLink = (id, name) =>
      byId(index, `item-${id}`) ? act('database-detail', esc(name), 'text-btn', `item-${id}`) : esc(name);
    const saveChoices = `<option value="@latest" ${follow ? 'selected' : ''}>跟随最新已保存进度</option>${referenceName && !saveOptions.some((f) => f.name === referenceName) ? `<option selected value="${esc(referenceName)}">${esc(referenceName)} · 当前不可读</option>` : ''}${saveOptions.map((f) => `<option value="${esc(f.name)}" ${!follow && f.name === referenceName ? 'selected' : ''}>${esc(f.name)} · ${esc(f.metadata.mapName)} · ${when(f.modifiedAt)}</option>`).join('')}`;
    let extra = '';
    const fresh =
      '<p class="small muted reference-freshness">参照内容会随新存档同步；游戏中未保存的变化不会计入。</p>';
    const reserved = Object.values(allocationTotals).reduce((a, b) => a + b, 0);
    if (e.kind === '物品')
      extra = `<div class="detail-stat-grid"><div><small>买入参考价</small><strong>${e.buyPrice.toLocaleString()} 文</strong></div><div><small>卖出参考价</small><strong>${e.sellPrice.toLocaleString()} 文</strong></div><div><small>赠礼</small><strong>${e.giftable ? '可以赠送' : '不可赠送'}</strong></div>${e.useLimit ? `<div><small>使用次数上限</small><strong>${e.useLimit} 次</strong></div>` : ''}</div><p class="save-note">价格为资料表基础值，实际商店结算可能受游戏状态影响。</p>`;
    if (e.kind === '武学')
      extra = `${e.special ? `<div class="detail-block"><h3>特殊效果</h3><p class="preserve-text">${esc(e.special)}</p></div>` : ''}<p class="save-note">招式文本来自当前游戏资料，显示效果可能取决于等级、装备与修炼条件。</p>`;
    if (e.kind === '人物') {
      const inventory = Array.isArray(reference?.metadata.inventory)
        ? new Map(reference.metadata.inventory.map((i) => [i.id, i.count]))
        : null;
      const gifts = index.entries
        .filter((x) => x.kind === '物品' && x.giftable && e.hobbyKeys.includes(x.typeKey))
        .filter((x) => !inventory || inventory.get(x.gameId) > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.gameId - b.gameId);
      const pages = Math.max(1, Math.ceil(gifts.length / 24));
      giftPage = Math.min(giftPage, pages - 1);
      extra = `${
        e.hobbies.length
          ? `<div class="detail-block"><h3>赠礼偏好</h3><div class="tag-row">${e.hobbies.map((h) => pill(h, 'green')).join('')}</div><p class="save-note">具体好感增量与可否赠送，以游戏内当前状态为准。</p></div><div class="recipe-reference"><label for="person-save">用哪份存档找礼物</label><select id="person-save" aria-label="人物礼物对照存档"><option value="">只看偏好物品示例</option>${saveChoices}</select><p>${reference ? `对照 ${esc(reference.name)} · ${when(reference.modifiedAt)}${inventory ? ' · 已读取背包' : ' · 背包未能读取，以下仅为物品示例'}` : '选择存档后显示背包里符合偏好的物品。'}</p></div><div class="detail-block person-gifts"><h3>${inventory ? '背包中符合偏好的礼物' : '符合偏好的物品示例'}</h3><div class="related-items">${
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
                    ) + act('journey-gift-dialog', '规划赠礼', 'text-btn', e.id + ':' + g.id, 'plus'),
                )
                .join('') || '<p class="small muted">这份存档没有记录符合偏好的可赠送物品。</p>'
            }</div>${gifts.length > 24 ? `<div class="history-pagination"><button class="btn" data-action="gift-page" data-id="${giftPage - 1}" ${giftPage === 0 ? 'disabled' : ''}>上一页</button><span>共 ${gifts.length} 种 · 第 ${giftPage + 1} / ${pages} 页</span><button class="btn" data-action="gift-page" data-id="${giftPage + 1}" ${giftPage + 1 >= pages ? 'disabled' : ''}>下一页</button></div>` : `<p class="small muted">共 ${gifts.length} 种</p>`}${reserved ? `<p class="save-note">${inventory ? '已扣除本周目预留数量，仅列可用库存。' : '本周目已设置预留；当前未读取库存，以下仅为物品示例，尚未核对可用数量。'}</p>` : ''}${fresh}<p class="save-note">礼物也可能用于任务或制作；请按需要留足用量。这里只核对已保存库存，不估算未验证的好感增量。</p></div>`
          : ''
      }${e.lifeSkills?.length ? `<details class="detail-block"><summary>资料中的生活技能</summary><div class="tag-row mt">${e.lifeSkills.map((s) => pill(`${s.name} ${s.level} 级`)).join('')}</div><p class="save-note">这是人物初始资料，并非当前培养后的等级。能否请教以游戏内观察界面为准。</p></details>` : ''}${e.skills?.length ? `<details class="detail-block"><summary>资料中的武学</summary><div class="related-items mt">${e.skills.map((s) => act('database-detail', esc(byId(index, s.id)?.name || s.id) + ` · 资料等级 ${s.level}`, 'btn', s.id)).join('')}</div></details>` : ''}${e.friendshipLocks?.length && index.renderRequirements ? `<details class="detail-block"><summary>好感解锁的任务线索</summary>${e.friendshipLocks.map((l) => `<h3 class="mt">资料中的 ${l.at} 好感节点</h3>${index.renderRequirements(l.requirements, index, { reference })}`).join('')}<p class="save-note">这是资料中的解锁条件，不是对当前好感度或已解锁状态的判断。</p></details>` : ''}${e.joinRequirements?.length && index.renderRequirements ? `<details class="detail-block"><summary>资料中的入队条件</summary>${index.renderRequirements(e.joinRequirements, index, { reference })}</details>` : ''}${act('world-person', '查这个人物的相关任务', 'btn', e.id, 'scroll')}`;
      const shop = index.merchants?.find((m) => m.id === e.gameId);
      if (shop)
        extra += `<details class="detail-block shop-stock"><summary>资料中的售卖清单 · ${shop.items.length} 种</summary><div class="related-items mt">${shop.items.map((id) => itemLink(id, byId(index, `item-${id}`)?.name || `物品 #${id}`)).join('')}</div><p class="save-note">售卖清单来自人物初始资料；剧情、阶段和库存变化可能影响当前可购买的商品。</p></details>`;
    }
    if (e.kind === '配方')
      extra = `<div class="recipe-reference"><label for="recipe-save">用哪份存档核对库存</label><select id="recipe-save" aria-label="对照库存的存档"><option value="">仅看配方，不核对库存</option>${saveChoices}</select>${reference ? `<p>${Array.isArray(reference.metadata.inventory) ? '已读取这份存档的物品数量' : '这份存档暂不支持库存读取'} · ${when(reference.modifiedAt)}<br>游戏内还未保存的变化不会计入。</p>` : '<p>可连接本机存档，自动核对已有材料和缺口。</p>'}</div><div class="recipe-box"><div class="row between"><h3>备料计算</h3><label class="quantity-label">制作次数 <input id="recipe-quantity" data-id="${e.id}" type="number" min="1" max="999" step="1" value="${quantity}" aria-label="制作次数"></label></div><p class="small muted">基础要求：${esc(e.craft || e.type)} ${e.level} 级 · 按每次配方的材料用量计算</p><div id="recipe-materials">${recipeMaterials(e, quantity, index, reference)}</div>${reserved ? '<p class="small muted">可用库存已扣除本周目预留数量。</p>' : ''}${fresh}</div><div class="detail-block"><h3>每次产出参考</h3>${e.results.map((r) => `<div class="material-row"><span>${itemLink(r.id, r.name)}</span><span>× ${r.count}</span></div>`).join('')}<p class="save-note">不同品质或随机结果可能由游戏中的制作等级、材料与词条决定。</p></div>`;
    if (e.kind === '配方')
      extra += `<div class="detail-block">${act('craft-add', '把这些制作次数加入备料清单', 'btn', e.id, 'plus')} ${act('craft-open', '查看备料清单', 'text-btn')}<p class="save-note">与其他配方一起核对，合并共享材料并分配同一份库存。</p></div>`;
    if (e.kind === '配方' && reference) {
      const learned =
        reference.metadata[
          { fusion: 'fusionRecipes', alchemy: 'alchemyRecipes', cooking: 'cookingRecipes' }[e.recipeType]
        ];
      if (Array.isArray(learned))
        extra =
          notice(
            learned.includes(e.gameId)
              ? '这份存档已记录此配方。能否制作还取决于游戏内等级与当前状态。'
              : '这份存档的已学配方列表中还没有此配方，可以先把它记为目标。',
            true,
          ) + extra;
    }
    if (e.kind === '配方' && e.learningItems?.length)
      extra += `<div class="detail-block recipe-learning"><h3>学习这份配方的图纸</h3><div class="related-items">${e.learningItems.map((id) => itemLink(id, byId(index, `item-${id}`)?.name || `物品 #${id}`)).join('')}</div><p class="save-note">这些物品在游戏资料中可用于学习此配方。点击查看物品与售卖线索。</p></div>`;
    if (e.kind === '物品') {
      extra += `<div class="recipe-reference"><label for="item-save">用哪份已保存进度核对用途</label><select id="item-save" aria-label="物品用途参照存档"><option value="" ${!referenceName && !follow ? 'selected' : ''}>仅查资料 · 库存待核对</option>${saveChoices}</select>${fresh}</div>${itemUsage}`;
      extra += `<section class="detail-block reservation-editor"><h3>${icon('shield')} 为任务或其他用途留一些</h3><p class="small muted">此周目预留的数量会从赠礼与备料可用库存中扣除。由你设定用途，手札不会猜测任务还需要多少。</p><div class="row"><label class="quantity-label">保留<input id="reserve-count" type="number" min="0" max="999999" step="1" value="${reservations[e.gameId] || 0}" aria-label="保留物品数量"></label>${act('reserve-save', '保存预留数量', 'btn', e.id, 'shield')}</div><p class="save-note">0 表示不预留；修改手札规划，不修改游戏物品。</p></section>`;
      const produced = index.entries.filter(
        (r) => r.kind === '配方' && r.results.some((x) => x.id === e.gameId),
      );
      if (produced.length)
        extra += `<div class="detail-block item-produced"><h3>可通过这些配方制作</h3><div class="related-items">${produced.map((r) => act('database-detail', esc(r.name), 'btn', r.id)).join('')}</div><p class="save-note">这里只列配方中的产出；是否可制作及最终品质，以游戏内为准。</p></div>`;
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
        extra += `<details class="detail-block item-sellers"><summary>资料中的售卖人物 · ${sellers.length} 条线索</summary><p class="save-note">这是资料表记录的售卖者，并非实时库存。同名人物可能位于不同地点；剧情或阶段可能改变商品。未列出不代表无法获得。</p>${sellers.map((m) => `<div class="seller-line"><strong>${byId(index, `npc-${m.id}`) ? act('database-detail', esc(m.name), 'text-btn', `npc-${m.id}`) : esc(m.name)}</strong>${m.description ? `<p class="small muted">${esc(m.description)}</p>` : ''}</div>`).join('')}</details>`;
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
    return `<section class="drawer" role="dialog" aria-modal="true" aria-label="${esc(e.name)}资料"><div class="drawer-head"><span class="small muted">百物图鉴 / ${e.kind}</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="tag-row">${pill(e.kind, 'green')}${pill(typeName(e))}${qualityText.label(e)}</div><div class="game-detail-title">${picture(e.id, 'detail')}<div><h1>${qualityText.name(e, e.name)}</h1>${e.kind === '配方' ? '<p class="small muted">产物图标 · 制作次数与材料见下方</p>' : ''}</div></div>${e.description ? `<p class="intro preserve-text">${esc(e.description)}</p>` : ''}${extra}${guides.length ? `<div class="detail-block"><h3>手札里的相关线索</h3>${guides.map((g) => act('detail', esc(g.title), 'btn mb', g.id, 'arrow')).join(' ')}</div>` : ''}<div class="detail-block"><p class="small muted">来源：${esc(index.source)} · Build ${esc(index.build)}<br>条目编号 ${e.gameId} · 非官方个人查询工具</p></div></div><div class="drawer-actions">${act(e.kind === '配方' ? 'recipe-goal' : 'database-goal', e.kind === '配方' ? '把备料单加入待办' : '记为我的目标', 'btn primary', e.id, 'plus')}${e.kind === '人物' ? act('database-gifts', '查符合偏好的物品', 'btn', e.id, 'search') + act('journey-gift-dialog', '规划赠礼', 'btn', e.id, 'plus') : e.kind === '物品' && e.giftable ? act('journey-gift-dialog', '规划赠礼', 'btn', ':' + e.id, 'plus') : ''}</div></section>`;
  }
  function recipeMaterials(e, quantity, index, reference = null) {
    const inventory = reference?.metadata.inventory,
      owned = new Map((inventory || []).map((i) => [i.id, i.count]));
    return `${e.materials
      .map((m) => {
        const have = (m.alternatives || [m.id]).reduce((sum, id) => sum + (owned.get(id) || 0), 0),
          need = m.count * quantity,
          missing = Math.max(0, need - have);
        return `<div class="material-row"><div class="spacer">${byId(index, `item-${m.id}`) ? act('database-detail', esc(m.name), 'text-btn', `item-${m.id}`) : esc(m.name)}${
          m.alternatives
            ? `<details class="ingredient-options"><summary>可替代食材</summary><p>${esc(m.description)}</p>${m.alternatives
                .map((id) => {
                  const item = byId(index, `item-${id}`);
                  return item ? act('database-detail', esc(item.name), 'text-btn', item.id) : '';
                })
                .join('、')}</details>`
            : ''
        }${inventory ? `<small class="material-owned">已有 ${have.toLocaleString()} · ${missing ? `还缺 ${missing.toLocaleString()}` : '已备齐'}</small>` : ''}</div><strong>需 ${need.toLocaleString()}</strong>${inventory ? pill(missing ? `缺 ${missing}` : '足够', missing ? 'orange' : 'green') : ''}</div>`;
      })
      .join(
        '',
      )}<div class="material-row total"><span>所需铜钱${reference?.metadata.money !== undefined ? `<small class="material-owned">存档中 ${reference.metadata.money.toLocaleString()} 文</small>` : ''}</span><strong>${(e.money * quantity).toLocaleString()} 文</strong></div>`;
  }
  function saveDetail(file, index) {
    const m = file.metadata;
    const recipes = [
      ...(m.fusionRecipes || []).map((id) => byId(index, `fusion-${id}`)),
      ...(m.alchemyRecipes || []).map((id) => byId(index, `alchemy-${id}`)),
      ...(m.cookingRecipes || []).map((id) => byId(index, `cooking-${id}`)),
    ].filter(Boolean);
    return `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="${esc(file.name)}存档回顾"><div class="drawer-head"><span class="small muted">存档匣 / 只读回顾</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="tag-row">${pill(file.name)}${pill('只读读取', 'green')}${act('save-compare', '与另一存档比较', 'text-btn', file.name, 'search')}</div><h1>${esc(m.mapName)}</h1><p class="small muted">${when(file.modifiedAt)} · ${bytes(file.bytes)}</p>${m.thumbnail ? `<div class="save-thumbnail"><img src="${m.thumbnail}" alt="这份存档自带的场景缩略图"><span>存档内的场景缩略图</span></div>` : ''}<div class="detail-stat-grid"><div><small>累计游玩</small><strong>${hours(m.playSeconds)}</strong></div>${m.money !== undefined ? `<div><small>铜钱</small><strong>${m.money.toLocaleString()} 文</strong></div>` : ''}${m.difficultyName ? `<div><small>难度</small><strong>${esc(m.difficultyName)}</strong></div>` : ''}<div><small>队伍人数</small><strong>${m.team?.length || 0} 人</strong></div></div><div class="detail-block"><h3>同行的伙伴</h3><div class="tag-row">${(m.team || []).map((n) => (byId(index, `npc-${n.id}`) ? act('database-detail', esc(n.name), 'btn', `npc-${n.id}`) : `<span class="pictured-label">${picture(`npc-${n.id}`)}${pill(n.name, 'green')}</span>`)).join('')}</div></div>${
      m.mainQuest || m.quest
        ? `<details class="save-quests"><summary>查看当时追踪的任务</summary>${[m.mainQuest, m.quest]
            .filter(Boolean)
            .map(
              (q) =>
                `<div class="detail-block"><h3>${esc(q.name)}</h3><p class="preserve-text">${esc(q.description)}</p></div>`,
            )
            .join('')}</details>`
        : ''
    }${Array.isArray(m.quests) ? `<details class="save-quests save-recorded-quests"><summary>这份存档的任务记录 · ${recordedQuestRoots(m.quests).length} 项</summary><div id="save-quest-results">${questList(m.quests, 'active', m.inventory, index)}</div><p class="save-note">只展示游戏资料中可见的任务及其存档状态。未出现在列表中，不等于错过或未完成；失败原因与后续分支需在游戏内确认。</p></details>` : ''}<details class="save-quests"><summary>已记录的制作配方 · ${recipes.length} 条</summary><div class="learned-recipes">${recipes.map((r) => `<button data-action="database-detail" data-id="${r.id}">${picture(r.id)}<span class="spacer">${qualityText.name(r.id, r.name)}</span>${icon('chevron')}</button>`).join('') || '<p class="small muted">这份存档暂未识别到可展示的配方。</p>'}</div></details>${Array.isArray(m.inventory) ? `<details class="save-quests"><summary>物品记录 · ${m.inventory.length} 种</summary><label class="search-input inventory-search">${icon('search')}<input id="save-inventory-search" placeholder="查找这份存档里的物品" aria-label="搜索存档物品" maxlength="100"></label><div id="save-inventory-results">${inventoryList(m.inventory, '', index)}</div></details>` : ''}<p class="save-note">来自磁盘上这份存档，不代表当前游戏内尚未保存的状态。读取与浏览不会改变游戏存档。名称映射资料 Build ${esc(index.build)}。</p></div><div class="drawer-actions">${act('backup', '备份当前整个存档目录', 'btn primary', '', 'archive')}${act('save-recap-goal', '记下这次出发', 'btn', file.name, 'feather')}</div></section>`;
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
                `<article class="saved-quest" data-quest-id="${q.id}"><div class="row between"><h3>${esc(q.name)}</h3>${pill(q.status, q.step === 1 ? 'green' : q.step === 2 ? 'orange' : '')}</div>${q.parentId && !byQuestId.has(q.parentId) ? '<p class="save-note">这份存档未记录上级任务，仅按当前已记录的步骤核对。</p>' : ''}<details><summary>查看任务文字与步骤</summary><p>${esc(q.description)}</p>${questMaterials(q, inventory, index)}${quests
                  .filter((child) => child.parentId === q.id)
                  .map(
                    (c) =>
                      `<div class="quest-step"><span>${esc(c.name)}</span><small>${esc(c.status)}</small></div>${c.step === 1 ? `<p>${esc(c.description)}</p>${questMaterials(c, inventory, index)}` : ''}`,
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
