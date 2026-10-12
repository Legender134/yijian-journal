export function createNpcFactViews({ esc, act }) {
  const link = (index, id) => {
    const entry = index.entries.find((row) => row.id === id);
    return entry ? act('database-detail', esc(entry.name), 'text-btn', id) : esc(id);
  };
  function fixedItems(facts) {
    const totals = new Map();
    for (const item of facts.fixedItems) totals.set(item.id, (totals.get(item.id) || 0) + item.count);
    return [...totals].map(([id, count]) => ({ id, count }));
  }
  function person(index, entry) {
    const facts = entry.npcFacts;
    if (!facts) return '';
    const fixed = fixedItems(facts);
    const random = facts.randomItems.map((pool) => index.npcFacts.pools[pool.poolId] || []);
    return `<section class="detail-block" data-npc-template><h3>静态等级 ${esc(facts.level)}</h3><p class="save-note">人物初始模板，当前实力请在游戏中观察；剧情、难度和培养可能改变实际表现。</p><details data-npc-private-items><summary>初始固定私物线索 · ${fixed.length} 种</summary><div class="related-items mt">${fixed.map((item) => `<span>${link(index, 'item-' + item.id)} <small>资料 ×${esc(item.count)}</small></span>`).join('') || '<p class="small muted">这份初始表没有固定私物记录。</p>'}</div><p class="save-note">数量为初始表记录的合计，实际持有请先观察。切磋需满足当前剧情、好感与境界等条件；胜利后的具体所得由游戏决定。</p></details>${random.length ? `<details data-npc-random-items><summary>随机初始私物候选 · ${random.length} 组</summary>${random.map((items, position) => `<div class="detail-block"><h3>候选 ${position + 1} · ${items.length} 种</h3><div class="related-items">${items.map((id) => link(index, 'item-' + id)).join('')}</div></div>`).join('')}<p class="save-note">候选用于识别可能出现的私物，不保证同时持有或获得；当前结果请在观察界面核对。</p></details>` : ''}</section>`;
  }
  function holders(index, item) {
    const rows = index.entries
      .filter((e) => e.kind === '人物' && e.npcFacts)
      .flatMap((entry) => {
        const fixed = fixedItems(entry.npcFacts).find((row) => row.id === item.gameId);
        const random = entry.npcFacts.randomItems.some((pool) =>
          index.npcFacts.pools[pool.poolId]?.includes(item.gameId),
        );
        return fixed || random ? [{ entry, fixed, random }] : [];
      });
    if (!rows.length) return '';
    const row = ({ entry, fixed, random }) =>
      `<div class="seller-line"><strong>${link(index, entry.id)}</strong><p class="small muted">静态等级 ${esc(entry.npcFacts.level)} · ${fixed ? `初始固定私物记录 ×${esc(fixed.count)}` : '随机初始私物候选'}${fixed && random ? ' · 另列于随机候选' : ''}</p></div>`;
    return `<details class="detail-block item-private-holders" data-item-private-holders><summary>初始私物中的人物线索 · ${rows.length} 位</summary><p class="save-note">来自人物初始模板，先观察当前私物并核对能否切磋。随机候选可能未出现，胜利不保证取得此物；剧情、难度和当前状态也可能改变结果。</p>${rows.slice(0, 8).map(row).join('')}${rows.length > 8 ? `<details><summary>其余 ${rows.length - 8} 位人物</summary>${rows.slice(8).map(row).join('')}</details>` : ''}</details>`;
  }
  return { person, holders };
}
