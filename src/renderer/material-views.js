export function createMaterialViews({ esc, act, icon, iconButton, pill, notice, empty, when }) {
  function page(index, profile, view, files) {
    const list = profile.craftList || [],
      byId = (id) => index.entries.find((e) => e.id === id);
    const query = view.query.trim().toLowerCase();
    const found = index.entries
      .filter(
        (e) =>
          e.kind === '配方' &&
          (!query ||
            `${e.name} ${e.craft} ${e.type} ${e.materials.map((m) => m.name).join(' ')}`
              .toLowerCase()
              .includes(query)),
      )
      .slice(0, 8);
    const picker = `<section class="card craft-picker"><div class="card-header"><h2>添加配方</h2>${pill(`${list.length} / 40 种`)}</div><label class="search-input"><input id="craft-search" data-persist="craft-search" value="${esc(view.query)}" maxlength="100" aria-label="搜索要制作的配方" placeholder="输入配方或材料名称"></label><div class="craft-suggestions">${found.map((e) => `<div><span class="spacer"><strong>${act('database-detail', esc(e.name), 'text-btn', e.id)}</strong><small>${esc(e.craft || e.type)} ${e.level} 级</small></span>${iconButton('craft-add', 'plus', '加入备料清单', e.id)}</div>`).join('') || '<p class="small muted">换个名称试试，也可以从百物图鉴加入。</p>'}</div></section>`;
    const lines = list
      .map((line) => {
        const e = byId(line.id);
        return `<div class="craft-line"><div class="spacer"><h3>${act('database-detail', esc(e.name), 'text-btn', line.id)}</h3><small>${esc(e.craft || e.type)} ${e.level} 级 · 按制作次数备料</small></div><label class="quantity-label">次数<input id="craft-qty-${line.id}" class="craft-count" data-id="${line.id}" type="number" min="1" max="999" step="1" value="${line.quantity}" aria-label="${esc(e.name)}制作次数"></label>${iconButton('craft-remove', 'trash', '移出备料清单', line.id)}</div>`;
      })
      .join('');
    const ready =
      view.result &&
      view.profileId === profile.id &&
      JSON.stringify(view.resultList) === JSON.stringify(list);
    const result = ready
      ? summary(view.result, index, view)
      : view.loading
        ? notice('正在合并材料并重新读取库存…', true)
        : view.error
          ? notice(view.error)
          : notice('清单有变化时，请重新核对。每件库存只会分配一次，可替代材料一起计算。', true);
    const name = view.referenceName || '';
    return `<div class="page-header"><div><div class="eyebrow">PACK FOR THE JOURNEY</div><h1 class="serif">备料清单</h1><p>几件装备，几份丹药，一次核对所有材料。</p></div>${list.length ? act('craft-review', '核对这份清单', 'btn primary', '', 'refresh') : pill('按周目保存', 'green')}</div><div class="craft-layout"><div>${picker}<section class="card mt"><div class="card-header"><h2>这一程想制作</h2>${pill(`${list.length} 种配方`)}</div>${lines || empty('先选一份配方', '从上面搜索添加，或在图鉴配方详情中加入。')}</section><section class="card mt"><h3>${icon('shield')} 本周目预留物品</h3><p class="save-note">在物品详情中设置保留数量。备料和赠礼只使用扣除后的库存。</p>${
      Object.entries(profile.reservations || {})
        .map(
          ([id, count]) =>
            `<div class="world-rule">${act('database-detail', esc(byId('item-' + id)?.name || id), 'text-btn', 'item-' + id)}<span>保留 ${count} 件</span></div>`,
        )
        .join('') || '<p class="small muted">尚未预留物品</p>'
    }</section></div><section class="card craft-result-card"><div class="field"><label for="craft-save">用哪份存档分配库存</label><select id="craft-save"><option value="" ${!name && !view.follow ? 'selected' : ''}>仅合并材料，不核对库存</option><option value="@latest" ${view.follow ? 'selected' : ''}>跟随最新已保存进度</option>${name && !files.some((f) => f.name === name) ? `<option selected value="${esc(name)}">${esc(name)} · 当前不可读</option>` : ''}${files.map((f) => `<option value="${esc(f.name)}" ${!view.follow && name === f.name ? 'selected' : ''}>${esc(f.name)} · ${esc(f.metadata.mapName)} · ${when(f.modifiedAt)}</option>`).join('')}</select></div><div class="row mb">${act('craft-calculate', '合并并核对', 'btn primary', '', 'refresh')}<span class="small muted" role="status">${view.loading ? '正在核对…' : ready ? '核对完成' : ''}</span></div>${list.length ? result : '<p class="save-note">加入配方后，完整清单会保存在当前周目。这里只核对已有库存，不提前计入尚未制作的产物。</p>'}</section></div>`;
  }
  function summary(plan, index, view) {
    const byId = (id) => index.entries.find((e) => e.id === id);
    const filtered = plan.materials.filter(
      (m) => !view.onlyMissing || !plan.inventoryAvailable || m.missing > 0,
    );
    const materialLink = (id) =>
      act('database-detail', esc(byId(`item-${id}`)?.name || `物品 #${id}`), 'text-btn', `item-${id}`);
    return `<div class="craft-totals"><div><small>基础制作费</small><strong>${plan.money.toLocaleString()} 文</strong></div><div><small>材料分组</small><strong>${plan.materials.length} 组</strong></div><div><small>按库存还缺</small><strong>${plan.missing === null ? '未核对' : `${plan.missing.toLocaleString()} 件`}</strong></div></div><p class="save-note">${plan.reference ? `对照 ${esc(plan.reference.name)} · ${esc(plan.reference.mapName)} · ${when(plan.reference.modifiedAt)}。` : '当前仅合并需求，库存未知。'}${plan.copperMissing === null ? '' : `存档铜钱 ${plan.copper.toLocaleString()} 文，${plan.copperMissing ? `制作费还差 ${plan.copperMissing.toLocaleString()} 文` : '足够支付基础制作费'}。`}费用不含购买材料。</p>${!plan.inventoryAvailable && plan.reference ? notice('这份存档的背包未能读取，材料缺口不会按零库存计算。', true) : ''}<details class="craft-learning"><summary>配方学习与制作等级</summary>${plan.recipes.map((r) => `<div class="world-rule"><span>${act('database-detail', esc(r.name), 'text-btn', r.id)}</span><small>${esc(r.craft)} ${r.level} 级 · ${r.learned === null ? '学习记录未核对' : r.learned ? '存档中已学' : '存档中未记录已学'}</small></div>`).join('')}<p class="save-note">制作等级为资料要求，不是角色当前等级；能否制作以游戏内界面为准。</p></details>${plan.inventoryAvailable ? `<button class="chip ${view.onlyMissing ? 'active' : ''}" data-action="craft-missing">${view.onlyMissing ? '正在只看缺少的材料' : '只看缺少的材料'}</button>` : ''}<div class="craft-materials">${filtered.map((m) => `<div class="craft-material"><div class="row between"><h3>${m.ids.length === 1 ? materialLink(m.ids[0]) : esc(m.name)}</h3>${pill(`共需 ${m.count.toLocaleString()}`)}</div><p class="small muted">${m.allocated === null ? '库存未核对' : `已分配 ${m.allocated.toLocaleString()} · 还缺 ${m.missing.toLocaleString()}`}</p>${m.ids.length > 1 ? `<details><summary>可替代物品</summary><div class="related-items">${m.ids.map(materialLink).join('')}</div></details>` : ''}${m.allocation.length ? `<details><summary>已分配哪些库存</summary>${m.allocation.map((a) => `<p class="small">${materialLink(a.id)}${a.quality ? ` · ${esc(a.quality)}色` : ''} × ${a.count}</p>`).join('')}</details>` : ''}<details><summary>用于哪些配方</summary>${m.recipes.map((r) => `<p class="small">${act('database-detail', esc(r.name), 'text-btn', r.id)} · 需要 ${r.count}</p>`).join('')}</details></div>`).join('') || '<p class="save-note">这些材料已经备齐。</p>'}</div><p class="save-note">库存已扣除你设置的预留数量。同一物品可能满足多个材料组；上面的“已分配”会共同分摊库存。可替代材料缺少的数量表示这一组总量不足，不要求购买每种替代品。游戏未保存的变化请保存后重新核对。</p>${sources(plan, index)}${act('craft-goal', '把这次备料摘要加入待办', 'btn', '', 'plus')}`;
  }
  function sources(plan, index) {
    const missing = plan.materials.filter((m) => m.missing > 0);
    if (!missing.length) return '';
    return (
      '<section class="material-sources"><h3>' +
      icon('map') +
      ' 缺料后，去哪里找线索</h3><p class="save-note">来自游戏资料表，商店和剧情可能随阶段变化；这些是获取线索，不代表当前一定有货。替代材料只需补足组内总缺口。</p>' +
      missing
        .map(
          (m) =>
            '<details><summary>' +
            esc(m.name) +
            ' · 还缺 ' +
            m.missing +
            '</summary>' +
            m.ids
              .map((id) => {
                const item = index.entries.find((e) => e.id === 'item-' + id);
                const sellers = [
                  ...new Map(
                    (index.merchants || [])
                      .filter((s) => s.items.includes(id))
                      .map((s) => [s.name + '\n' + s.description, s]),
                  ).values(),
                ];
                return (
                  '<div class="detail-block">' +
                  act('database-detail', esc(item?.name || id), 'text-btn', 'item-' + id) +
                  (item?.description ? '<p class="small muted">' + esc(item.description) + '</p>' : '') +
                  sellers
                    .map(
                      (s) =>
                        '<div class="seller-line">' +
                        act('database-detail', esc(s.name), 'text-btn', 'npc-' + s.id) +
                        '<p class="small muted">' +
                        esc(s.description || '地点未核实，可点开查看关联任务') +
                        '</p></div>',
                    )
                    .join('') +
                  (!sellers.length
                    ? '<p class="small muted">没有已核实的售卖人物；可在物品详情查制作、任务等关联。</p>'
                    : '') +
                  '</div>'
                );
              })
              .join('') +
            '</details>',
        )
        .join('') +
      '</section>'
    );
  }
  return { page };
}
