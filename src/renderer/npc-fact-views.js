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
    return `<section class="detail-block" data-npc-template><h3>初始等级 ${esc(facts.level)}</h3><details data-npc-private-items><summary>初始私物 · ${fixed.length} 种</summary><div class="related-items mt">${fixed.map((item) => `<span>${link(index, 'item-' + item.id)} <small>×${esc(item.count)}</small></span>`).join('') || '<p class="small muted">这份初始表没有固定私物记录。</p>'}</div></details>${random.length ? `<details data-npc-random-items><summary>随机私物 · ${random.length} 组</summary>${random.map((items, position) => `<div class="detail-block"><h3>候选 ${position + 1} · ${items.length} 种</h3><div class="related-items">${items.map((id) => link(index, 'item-' + id)).join('')}</div></div>`).join('')}</details>` : ''}</section>`;
  }
  function holders(index, item, progress = null) {
    const rows = index.entries
      .filter((e) => e.kind === '人物' && e.npcFacts)
      .flatMap((entry) => {
        const fixed = fixedItems(entry.npcFacts).find((row) => row.id === item.gameId);
        const random = entry.npcFacts.randomItems.some((pool) =>
          index.npcFacts.pools[pool.poolId]?.includes(item.gameId),
        );
        return fixed || random ? [{ entry, fixed, random }] : [];
      });
    const row = ({ entry, fixed, random }) =>
      `<div class="seller-line"><strong>${link(index, entry.id)}</strong><p class="small muted">初始等级 ${esc(entry.npcFacts.level)} · ${fixed ? `初始固定私物记录 ×${esc(fixed.count)}` : '随机私物'}${fixed && random ? ' · 另列于随机候选' : ''}</p></div>`;
    const list = (items, render) =>
      items.slice(0, 8).map(render).join('') +
      (items.length > 8
        ? `<details><summary>其余 ${items.length - 8} 位人物</summary>${items.slice(8).map(render).join('')}</details>`
        : '');
    if (!progress?.available) {
      if (!rows.length) return '';
      return `<details class="detail-block item-private-holders" data-item-private-holders><summary>初始线索 · 可能持有的侠客 · ${rows.length} 位</summary>${list(rows, row)}</details>`;
    }
    const observed = new Map(progress.people.map((person) => [person.npcId, person]));
    const people = new Map(
      index.entries.filter((entry) => entry.kind === '人物').map((entry) => [entry.gameId, entry]),
    );
    const current = progress.people.flatMap((person) => {
      const count = person.remainingItems
        .filter((remaining) => remaining.id === item.gameId)
        .reduce((total, remaining) => total + remaining.count, 0);
      const entry = people.get(person.npcId);
      return count > 0 && entry ? [{ person, entry, count }] : [];
    });
    const unknown = rows.filter(({ entry }) => !observed.has(entry.gameId));
    if (!current.length && !rows.length) return '';
    const currentRow = ({ person, entry, count }) => {
      const check =
        person.compare?.checks.find((check) => check.status === 'unmet') ||
        person.compare?.checks.find((check) => check.status === 'unknown');
      const hint =
        check?.text || (person.compare?.status === 'met' ? '比武条件已满足，仍需判断战力' : '比武条件待核对');
      const place = person.place
        ? act('world-place', esc(person.place.name), 'text-btn', person.place.id)
        : '位置待确认';
      return `<div class="seller-line"><strong>${link(index, entry.id)}</strong><p>剩余 ×${esc(count)} · ${place}</p><p class="small muted">${esc(hint)}</p></div>`;
    };
    if (!current.length)
      return `<details class="detail-block item-private-holders" data-item-private-holders><summary>${progress.origin === 'live' ? '现场' : '保存时'}未发现持有者${unknown.length ? ` · 未核对线索 ${unknown.length}` : ''}</summary><p class="small muted">已读取的人物中暂未发现此私物。</p>${unknown.length ? `<div data-item-private-candidates>${list(unknown, row)}</div>` : ''}</details>`;
    return `<section class="detail-block item-private-holders" data-item-private-holders><h3>${progress.origin === 'live' ? '现场仍持有' : '保存时仍持有'} · ${current.length} 位</h3>${current.length ? list(current, currentRow) : '<p class="small muted">已读取的人物中暂未发现此私物。</p>'}${unknown.length ? `<details data-item-private-candidates><summary>未核对人物的初始线索 · ${unknown.length} 位</summary>${list(unknown, row)}</details>` : ''}</section>`;
  }
  return { person, holders };
}
