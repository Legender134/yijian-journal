import { compileSearch } from './search-query.js';
import { taskMentions } from './task-mentions.js';
export function createWorldViews({ esc, act, pill, notice, icon, iconButton, when, empty, picture }) {
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
  const status = (q, view) =>
    !Array.isArray(view.reference?.metadata.quests)
      ? '未核对存档'
      : labels[records(view).get(q.gameId)?.step] || '未出现在记录';
  const npc = (id, index) => {
    const name = people.get(id)?.name || index.world.npcNames?.[id] || `角色 #${id}`;
    return people.has(id)
      ? act('database-detail', esc(name), 'text-btn', `npc-${id}`)
      : `<span class="pictured-label">${picture(`npc-${id}`)}<span>${esc(name)}</span></span>`;
  };
  const questLink = (q, cls = 'text-btn') => act('world-quest', esc(q.name), cls, q.id);
  const mapLink = (key) =>
    maps.has(key) ? act('world-place', esc(maps.get(key).name), 'text-btn', maps.get(key).id) : esc(key);
  function referenceControls(view, files) {
    const name = view.referenceName || '';
    return `<div class="world-reference"><div class="field"><label for="world-save">用哪份存档核对任务</label><select id="world-save"><option value="" ${!name && !view.follow ? 'selected' : ''}>仅查资料</option><option value="@latest" ${view.follow ? 'selected' : ''}>跟随最新已保存进度</option>${name && !files.some((f) => f.name === name) ? `<option selected value="${esc(name)}">${esc(name)} · 当前不可读</option>` : ''}${files.map((f) => `<option value="${esc(f.name)}" ${!view.follow && name === f.name ? 'selected' : ''}>${esc(f.name)} · ${esc(f.metadata.mapName)} · ${when(f.modifiedAt)}</option>`).join('')}</select></div>${act('world-refresh', '重新读取', 'btn', '', 'refresh')}<p class="small muted">${view.loading ? '正在读取…' : view.error ? esc(view.error) : view.reference ? `已读取 ${esc(view.reference.name)} · ${when(view.reference.modifiedAt)}。游戏中未保存的变化不会计入。` : '选择存档后对照已保存记录；没有记录不等于错过任务。'}</p></div>`;
  }
  function page(index, view, files) {
    prepare(index);
    const q = view.query.trim().toLowerCase(),
      saved = records(view);
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
      if (view.status === 'active') return group.some((c) => saved.get(c.gameId)?.step === 1);
      if (view.status === 'completed') return saved.get(t.gameId)?.step === 4;
      if (view.status === 'recorded') return group.some((c) => saved.has(c.gameId));
      return group.every((c) => !saved.has(c.gameId));
    });
    const pages = Math.max(1, Math.ceil(filtered.length / 24)),
      current = Math.min(view.page, pages - 1);
    const cards = filtered
      .slice(current * 24, current * 24 + 24)
      .map((t) => {
        if (view.kind === 'places') {
          const related = index.world.quests.filter((q) => q.placements.some((p) => p.mapKey === t.key));
          return `<button class="database-card world-place-card" data-action="world-place" data-id="${t.id}"><span class="database-symbol">${icon('folder')}</span><h3>${esc(t.name)}</h3><p>${related.length ? `${related.length} 条任务场景线索` : '查看此地点的资料关联'}${t.cave ? ' · 洞穴场景' : ''}</p><div class="database-card-foot">场景 #${t.gameId}${icon('chevron')}</div></button>`;
        }
        const active = family(t).filter((c) => c !== t && saved.get(c.gameId)?.step === 1);
        return `<button class="database-card world-quest-card" data-action="world-quest" data-id="${t.id}"><div class="row between"><span class="database-symbol">${icon('scroll')}</span>${pill(status(t, view), saved.get(t.gameId)?.step === 4 ? 'green' : '')}</div><h3>${esc(t.name)}</h3><p>${
          active.length
            ? `进行中的步骤：${active
                .slice(0, 2)
                .map((c) => esc(c.name))
                .join('、')}`
            : esc(t.parentId ? '任务步骤 · 查看所属任务与关联资料' : '查看步骤、交互人物与所需物品')
        }</p><div class="database-card-foot">${t.kind === 'Primary' ? '主线' : '支线'}${t.parentId ? '步骤' : '任务'} · #${t.gameId}${icon('chevron')}</div></button>`;
      })
      .join('');
    return `<div class="page-header"><div><div class="eyebrow">FOLLOW THE THREAD</div><h1 class="serif">任务与地点</h1><p>沿着任务找线索，沿着线索找人物与物品。</p></div>${pill('本机游戏资料', 'green')}</div><div class="segmented world-tabs">${[
      ['quests', '任务手册'],
      ['places', '地点线索'],
    ]
      .map(
        ([id, label]) =>
          `<button data-action="world-kind" data-id="${id}" class="${view.kind === id ? 'active' : ''}">${label}</button>`,
      )
      .join(
        '',
      )}</div>${referenceControls(view, files)}<div class="toolbar"><label class="search-input"><input id="world-search" data-persist="world-search" value="${esc(view.query)}" maxlength="100" aria-label="搜索任务与地点"${searchError ? ' aria-invalid="true" aria-describedby="world-search-error"' : ''} placeholder="${view.kind === 'places' ? '搜索地点名称' : '搜索任务、人物或描述'}"></label>${
      view.kind === 'quests'
        ? `<select id="world-status" aria-label="任务记录筛选">${[
            ['all', '所有资料'],
            ['active', '含进行中的记录'],
            ['completed', '任务记录已完成'],
            ['recorded', '存档中有记录'],
            ['unrecorded', '未出现在记录'],
          ]
            .map(
              ([id, label]) =>
                `<option value="${id}" ${view.status === id ? 'selected' : ''}>${label}</option>`,
            )
            .join(
              '',
            )}</select><select id="world-scope" aria-label="任务显示范围"><option value="roots" ${view.roots ? 'selected' : ''}>主任务</option><option value="all" ${!view.roots ? 'selected' : ''}>任务与步骤</option></select>`
        : ''
    }${pill(searchError ? '搜索条件待修改' : `${filtered.length} 项`)}</div>${searchError ? `<div id="world-search-error" role="alert">${notice(searchError, true)}</div>` : cards ? `<div class="database-grid">${cards}</div><div class="pagination">${act('world-page', '上一页', 'btn', String(Math.max(0, current - 1)))}<span>第 ${current + 1} / ${pages} 页</span>${act('world-page', '下一页', 'btn', String(Math.min(pages - 1, current + 1)))}</div>` : empty('没有匹配的线索', view.status !== 'all' && !view.reference ? '先选择可读存档，或切换为所有资料。' : '调整搜索、记录筛选或显示范围。')}<p class="save-note">资料来自本机游戏 Build ${esc(index.build)}。同名地点、人物或任务可能对应不同剧情阶段。这里只展示可核对的资料关联，不能据此断定可接取、已错过或当前位置。</p>`;
  }
  function requirementRows(list, index, view) {
    prepare(index);
    const saved = records(view);
    return (
      list
        .map((r) => {
          const q = quests.get(r.id),
            person = people.get(r.id);
          const link =
            r.type === 'PreQuest' || r.type === 'NoQuest'
              ? q
                ? questLink(q)
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
          return `<div class="world-rule"><span class="small muted">${label}</span><span>${link}${value ? ` · ${esc(value)}` : ''}</span>${q && saved.has(q.gameId) ? pill(`存档：${labels[saved.get(q.gameId).step]}`) : ''}</div>`;
        })
        .join('') || '<p class="small muted">这部分资料没有列出条件。</p>'
    );
  }
  function questDetail(index, id, view, showText, reservations = {}) {
    prepare(index);
    const q = index.world.quests.find((q) => q.id === id);
    if (!q) return '';
    const saved = records(view),
      group = family(q),
      parent = quests.get(q.parentId);
    const inventory = Array.isArray(view.reference?.metadata.inventory)
      ? new Map(view.reference.metadata.inventory.map((i) => [i.id, i.count]))
      : null;
    const targetNames = (ids) => ids.map((id) => npc(id, index)).join('、') || '资料未列出';
    const text = `<p class="preserve-text">${esc(q.description || '资料没有提供任务说明。')}</p>`;
    return `<section class="drawer world-drawer" role="dialog" aria-modal="true" aria-label="任务资料"><div class="drawer-head"><span class="small muted">任务手册 / 资料与存档对照</span>${iconButton('close-overlay', 'close', '关闭任务资料')}</div><div class="drawer-body"><div class="tag-row">${pill(q.parentId ? '任务步骤' : '主任务')}${pill(status(q, view))}${pill(`资料编号 ${q.gameId}`)}</div><h1>${esc(q.name)}</h1><p class="save-note">${view.reference ? `对照 ${esc(view.reference.name)} · ${when(view.reference.modifiedAt)}` : '当前仅查资料，尚未核对存档。'}</p>${view.error ? notice(view.error) : ''}${parent ? `<div class="detail-block"><h3>所属任务</h3>${questLink(parent)}</div>` : ''}<details class="detail-block" ${showText ? 'open' : ''}><summary>任务说明 · 可能涉及剧情</summary>${text}</details><div class="detail-block"><h3>交互人物</h3><p>接取：${targetNames(q.requestNPCs)}</p><p>完成：${targetNames(q.finishNPCs)}</p></div>${mentionLinks(index, q, showText)}${q.materials?.length ? `<div class="detail-block"><h3>任务所需物品</h3>${q.materials.map((m) => `<div class="material-row"><span>${act('database-detail', esc(m.name), 'text-btn', `item-${m.id}`)}</span><strong>需 ${m.count}</strong>${inventory ? pill(`库存 ${inventory.get(m.id) || 0} · 缺 ${Math.max(0, m.count - (inventory.get(m.id) || 0))}`, (inventory.get(m.id) || 0) >= m.count ? 'green' : 'orange') : pill('库存未读取')}${act('world-reserve-material', (reservations[m.id] || 0) >= m.count ? `已预留 ${reservations[m.id]} 件` : `为任务预留 ${m.count} 件`, 'btn', `${q.id}:${m.id}`)}</div>`).join('')}<p class="save-note">预留归属于这项任务，与其他任务及手动保留数量相加。存档确认任务完成时暂停扣除；进度待核对时继续保留。可在备料清单调整或释放，不修改游戏库存。</p></div>` : ''}${q.requirements.length ? `<details class="detail-block"><summary>资料中的接取条件</summary>${requirementRows(q.requirements, index, view)}<p class="save-note">条件只是资料线索；尚未读取的隐藏记录和游戏当前状态也可能影响接取。</p></details>` : ''}${q.placements.length ? `<details class="detail-block"><summary>关联场景线索</summary>${q.placements.map((p) => `<div class="world-rule"><span>${mapLink(p.mapKey)}</span><span>${npc(p.npcId, index)}${p.inHouse ? ' · 室内' : ''}</span><small class="muted">${p.interactionTarget ? '对应交互人物' : '任务事件中的场景布置'}</small></div>`).join('')}<p class="save-note">场景布置也会包含其他剧情人物，不能把每条位置当成任务目标的当前所在地。</p></details>` : ''}${
      group.length > 1
        ? `<details class="detail-block" open><summary>相关步骤 · ${group.length - 1}</summary><div class="world-steps">${group
            .filter((c) => c !== q)
            .map(
              (c) =>
                `<div class="world-step">${questLink(c)}${pill(status(c, view), saved.get(c.gameId)?.step === 4 ? 'green' : '')}</div>`,
            )
            .join('')}</div></details>`
        : ''
    }<p class="save-note">来源：本机游戏资料表 · Build ${esc(index.build)}。未出现在记录仅表示这份存档没有可展示的条目，不代表失败或错过。</p></div><div class="drawer-actions">${act('world-quest-goal', '把任务记入待办', 'btn primary', q.id, 'plus')}${act('world-back-to-list', '回任务手册', 'btn', q.id)}</div></section>`;
  }
  function mentionLinks(index, task, showText) {
    const mentions = taskMentions(index, task);
    const places = [...mentions.places, ...mentions.aliases];
    if (!mentions.people.length && !places.length) return '';
    return `<details class="detail-block task-mentions" ${showText ? 'open' : ''}><summary>说明中提到的人物与地点${showText ? '' : ' · 可能涉及剧情'}</summary><p class="save-note">从任务说明中的名字匹配资料，方便继续查询；不代表当前所在地，也不确认接取条件已满足。</p><div class="row">${mentions.people.map((p) => act('database-detail', esc(p.name), 'text-btn', p.id, 'person')).join('')}</div>${places.map((group) => `<details><summary>${esc(group.mention)}${group.mention !== group.name ? ' · 相关资料名称：' + esc(group.name) : ''}${group.choices.length > 1 ? ' · ' + group.choices.length + ' 个场景' : ''}</summary>${group.choices.map((place) => act('world-place', esc(place.name) + ' · #' + place.gameId, 'text-btn', place.id, 'folder')).join('')}</details>`).join('')}</details>`;
  }
  function placeDetail(index, id, view) {
    prepare(index);
    const place = index.world.maps.find((m) => m.id === id);
    if (!place) return '';
    const related = index.world.quests.filter((q) => q.placements.some((p) => p.mapKey === place.key));
    const npcIds = [
      ...new Set(
        related.flatMap((q) => q.placements.filter((p) => p.mapKey === place.key).map((p) => p.npcId)),
      ),
    ];
    return `<section class="drawer world-drawer" role="dialog" aria-modal="true" aria-label="地点资料"><div class="drawer-head"><span class="small muted">地点线索 / 关联场景</span>${iconButton('close-overlay', 'close', '关闭地点资料')}</div><div class="drawer-body"><h1>${esc(place.name)}</h1>${act('journey-place-dialog', '记为地点目标', 'btn', place.id, 'pin')}<p class="save-note">资料场景编号 ${place.gameId} · ${place.cave ? '洞穴场景' : '游戏场景'}</p><div class="detail-block"><h3>任务相关人物</h3><div class="related-items">${npcIds.map((id) => `<span>${npc(id, index)}</span>`).join('') || '<p class="small muted">当前索引没有列出关联人物。</p>'}</div></div><div class="detail-block"><h3>关联任务与步骤</h3><div class="world-steps">${related.map((q) => `<div class="world-step">${questLink(q)}${pill(status(q, view))}</div>`).join('') || '<p class="small muted">当前索引没有对应场景记录，可按任务或人物名继续查找。</p>'}</div></div><p class="save-note">来源：本机游戏资料表 · Build ${esc(index.build)}。这里只收录任务表中的场景关联，不是全地图收集清单，也不表示人物现在仍在此处。</p></div></section>`;
  }
  return { page, questDetail, placeDetail, requirementRows };
}
