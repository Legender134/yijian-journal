export function createCompanionViews({ esc, icon, act, iconButton, picture, qualityText }) {
  function hintContent(h) {
    return h.id?.startsWith('item-') ? qualityText.name(h.id, h.title) : esc(h.title);
  }
  function passive(data) {
    const hints = data?.hints || [{ type: 'help', title: 'Ctrl＋Alt＋J 展开查询', label: '逸剑手札' }];
    const age = data?.reference
      ? Math.max(0, Math.floor((Date.now() - Date.parse(data.reference.modifiedAt)) / 60000))
      : null;
    const elapsed =
      age === 0
        ? '不足1分钟前'
        : age < 60
          ? `${age}分钟前`
          : age < 1440
            ? `${Math.floor(age / 60)}小时前`
            : `${Math.floor(age / 1440)}天前`;
    return `<section class="hint-shell" aria-label="随行轻提示"><div class="hint-head">${icon('leaf')}<span>逸剑手札</span><kbd>Ctrl Alt J</kbd></div>${hints
      .slice(0, 2)
      .map(
        (h) =>
          `<div class="hint-line">${h.type === 'material' && h.id ? picture(h.id) : icon(h.type === 'material' ? 'bag' : 'pin')}<span>${hintContent(h)}</span></div>`,
      )
      .join(
        '',
      )}<div class="hint-source">${data?.reference ? `${data.referenceMode === 'slot' ? '固定' : '存档'} ${esc(data.reference.name)} · ${elapsed}的背包` : '手札记录 · 背包尚未核对'}</div></section>`;
  }
  function materials(data) {
    const plan = data?.materials;
    if (!plan)
      return '<p class="small muted">将配方加入备料清单，或在图鉴中加入制作目标，这里会随有效存档更新。</p>';
    return `<section class="companion-materials"><h3>${icon('bag')} 当前备料 · ${plan.recipes.length} 项配方</h3><p class="small muted">合并相同材料，扣除留用物品；可替代食材按整份清单分配。</p>${plan.materials.map((m) => `<div class="companion-material"><span class="row">${picture(`item-${m.ids[0]}`)}<span>${m.ids.length === 1 ? qualityText.name(`item-${m.ids[0]}`, m.name) : esc(m.name)}</span></span><span class="${m.missing > 0 ? 'shortage' : 'muted'}">${m.missing === null ? `需 ${m.count} · 待核对` : m.missing ? `还缺 ${m.missing}` : '已齐'}</span></div>`).join('')}<p class="small muted">铜钱${plan.copperMissing === null ? '未核对' : plan.copperMissing ? `还差 ${plan.copperMissing}` : '足够'}；配方是否学会与制作等级请在详细备料中核对。</p>${act('navigate', '调整清单与留用数量', 'btn soft', 'materials', 'bag')}</section>`;
  }
  function frame(body, footer) {
    return `<div class="compact-shell"><div class="compact-title"><div class="row">${icon('leaf')}逸剑手札 · 随行</div>${iconButton('main', 'maximize', '打开完整手札')}${iconButton('companion-collapse', 'minus', '收起随行面板')}</div><div class="companion-tabs">${act('navigate', '追踪', 'text-btn', 'home', 'pin')}${act('search', '查询', 'text-btn', '', 'search')}${act('navigate', '备料', 'text-btn', 'materials', 'bag')}${act('navigate', '历史', 'text-btn', 'saves', 'clock')}</div><div class="compact-body">${body}</div><div class="compact-foot">${footer}<span>Esc 收起 · Ctrl K 查询</span></div></div>`;
  }
  return { passive, materials, frame };
}
