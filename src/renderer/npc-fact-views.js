export function createNpcFactViews({ esc, act }) {
  // These requests can change private inventory; none proves a current item.
  const storyPrivate = [
    { npcId: 17005, itemId: 10353, questId: 11425 },
    { npcId: 10309, itemId: 100314 },
    { npcId: 10309, itemId: 100303 },
  ];
  const link = (index, id) => {
    const quest = id.startsWith('quest-') && index.world?.quests?.find((row) => row.id === id);
    const entry = quest || index.entries.find((row) => row.id === id);
    return entry ? act(quest ? 'world-quest' : 'database-detail', esc(entry.name), 'text-btn', id) : esc(id);
  };
  function fixedItems(facts, npcId) {
    const totals = new Map();
    for (const item of facts.fixedItems) totals.set(item.id, (totals.get(item.id) || 0) + item.count);
    // This non-stackable template row records Value=2, but the native creation
    // path does not use that value as quantity. The final count is unconfirmed.
    const wangTiancongMace = npcId === 16301
      ? facts.fixedItems.filter((item) => item.id === 3014)
      : [];
    return [...totals].map(([id, count]) => ({
      id,
      count: id === 3014 && wangTiancongMace.length === 1 && wangTiancongMace[0].count === 2 ? null : count,
    }));
  }
  function person(index, entry) {
    const facts = entry.npcFacts;
    if (!facts) return '';
    const fixed = fixedItems(facts, entry.gameId);
    const random = facts.randomItems.map((pool) => ({
      count: pool.count,
      items: index.npcFacts.pools[pool.poolId] || [],
    }));
    const story = storyPrivate.filter((row) => row.npcId === entry.gameId);
    return `<section class="detail-block" data-npc-template><h3>初始等级 ${esc(facts.level)}</h3><details data-npc-private-items><summary>初始私物 · ${fixed.length} 种</summary><div class="related-items mt">${fixed.map((item) => `<span>${link(index, 'item-' + item.id)} <small>${item.count === null ? '数量待确认' : `×${esc(item.count)}`}</small></span>`).join('') || '<p class="small muted">这份初始表没有固定私物记录。</p>'}</div></details>${random.length ? `<details data-npc-random-items><summary>随机私物 · ${random.length} 组</summary>${random.map(({ items, count }, position) => `<div class="detail-block"><h3>候选 ${position + 1} · ${items.length} 种${Number.isInteger(count) && count > 0 ? ` · 初始抽取 ${esc(count)} 次（可重复）` : ''}</h3><div class="related-items">${items.map((id) => link(index, 'item-' + id)).join('')}</div></div>`).join('')}</details>` : ''}${story.length ? `<details><summary>其他私物线索</summary>${story.map((row) => `<p>${row.questId ? `${link(index, 'quest-' + row.questId)}后可能持有` : '特定进度下可能补入'} ${link(index, 'item-' + row.itemId)}，实际私物请在游戏中查看。</p>`).join('')}</details>` : ''}</section>`;
  }
  function holders(index, item, progress = null) {
    const story = storyPrivate.filter((row) => row.itemId === item.gameId);
    const storyBlock = story.length
      ? `<details class="detail-block"><summary>其他私物线索</summary>${story.map((row) => `<p>${row.questId ? `${link(index, 'quest-' + row.questId)}后，` : '特定进度下，'}${link(index, 'npc-' + row.npcId)}可能${row.questId ? '持有' : '补入此物'}；实际私物请在游戏中查看。</p>`).join('')}</details>`
      : '';
    const rows = index.entries
      .filter((e) => e.kind === '人物' && e.npcFacts)
      .flatMap((entry) => {
        const fixed = fixedItems(entry.npcFacts, entry.gameId).find((row) => row.id === item.gameId);
        const random = entry.npcFacts.randomItems.some((pool) =>
          index.npcFacts.pools[pool.poolId]?.includes(item.gameId),
        );
        return fixed || random ? [{ entry, fixed, random }] : [];
      });
    const row = ({ entry, fixed, random }) =>
      `<div class="seller-line"><strong>${link(index, entry.id)}</strong><p class="small muted">初始等级 ${esc(entry.npcFacts.level)} · ${fixed ? `初始固定私物记录${fixed.count === null ? ' · 数量待确认' : ` ×${esc(fixed.count)}`}` : '随机私物'}${fixed && random ? ' · 另列于随机候选' : ''}</p></div>`;
    const list = (items, render) =>
      items.slice(0, 8).map(render).join('') +
      (items.length > 8
        ? `<details><summary>其余 ${items.length - 8} 位人物</summary>${items.slice(8).map(render).join('')}</details>`
        : '');
    if (!progress?.available) {
      if (!rows.length) return storyBlock;
      return `<details class="detail-block item-private-holders" data-item-private-holders><summary>初始线索 · 可能持有的侠客 · ${rows.length} 位</summary>${list(rows, row)}</details>${storyBlock}`;
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
    const protectedHolders = progress.people.flatMap((person) => {
      const recorded = (person.protectedItems || []).some((owned) => owned.id === item.gameId);
      const entry = people.get(person.npcId);
      return recorded && entry ? [{ entry }] : [];
    });
    const pending = progress.people.flatMap((person) => {
      const matches = (person.unknownItems || []).filter((remaining) => remaining.id === item.gameId);
      const count = matches.reduce((total, remaining) => total + remaining.count, 0);
      const hasZeroCount = matches.some((remaining) => remaining.hasZeroCount);
      const hasUncertainStackCount = matches.some((remaining) => remaining.hasUncertainStackCount);
      const entry = people.get(person.npcId);
      return (count > 0 || hasZeroCount || hasUncertainStackCount) && entry ? [{ entry, count, hasZeroCount, hasUncertainStackCount }] : [];
    });
    const unknown = rows.filter(({ entry }) => !observed.has(entry.gameId));
    if (!current.length && !rows.length && !pending.length && !protectedHolders.length) return storyBlock;
    const protectedRows = list(protectedHolders, ({ entry }) => `<p>${link(index, entry.id)} · 按原资料普通比武不可抽取</p>`);
    const protectedBlock = protectedHolders.length && current.length
      ? `<details><summary>受保护私物 · ${protectedHolders.length} 位</summary>${protectedRows}</details>`
      : protectedRows;
    const pendingBlock = pending.length
      ? `<details><summary>取物资格待确认 · ${pending.length} 位</summary>${list(pending, ({ entry, count, hasZeroCount, hasUncertainStackCount }) => `<p>${link(index, entry.id)}${count > 0 ? ` · 持有 ×${esc(count)}` : ''}${hasZeroCount ? ' · 零数量记录，取物待确认' : ''}${hasUncertainStackCount ? ' · 数量待确认' : ''}</p>`)}</details>`
      : '';
    const currentRow = ({ person, entry, count }) => {
      const check =
        person.compare?.checks.find((check) => check.status === 'unmet') ||
        person.compare?.checks.find((check) => check.status === 'unknown');
      const hint =
        (person.privateSelection?.status !== 'met' && person.privateSelection?.text) ||
        check?.text || (person.compare?.status === 'met' ? '比武条件已满足，仍需判断战力' : '比武条件待核对');
      const place = person.place
        ? act('world-place', esc(person.place.name), 'text-btn', person.place.id)
        : '位置待确认';
      return `<div class="seller-line"><strong>${link(index, entry.id)}</strong><p>剩余 ×${esc(count)} · ${place}</p><p class="small muted">${esc(hint)}</p></div>`;
    };
    if (!current.length)
      return `<details class="detail-block item-private-holders" data-item-private-holders><summary>${progress.origin === 'live' ? '现场' : '保存时'}${protectedHolders.length ? `受保护私物 ${protectedHolders.length} 位` : pending.length ? '普通比武取物待确认' : '未发现普通比武候选'}${unknown.length ? ` · 未核对线索 ${unknown.length}` : ''}</summary>${protectedBlock}${pendingBlock}${unknown.length ? `<div data-item-private-candidates>${list(unknown, row)}</div>` : ''}</details>${storyBlock}`;
    return `<section class="detail-block item-private-holders" data-item-private-holders><h3>${progress.origin === 'live' ? '现场仍持有' : '保存时仍持有'} · ${current.length} 位</h3>${list(current, currentRow)}${protectedBlock}${pendingBlock}${unknown.length ? `<details data-item-private-candidates><summary>未核对人物的初始线索 · ${unknown.length} 位</summary>${list(unknown, row)}</details>` : ''}</section>${storyBlock}`;
  }
  return { person, holders };
}
