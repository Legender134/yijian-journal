// Stable, typed relationships from the shipped index; never infer live state.
const catalogs = new WeakMap();
const list = (value) => (Array.isArray(value) ? value : []);
export const questStatus = (id, reference) => {
  const rows = reference?.metadata?.quests;
  if (!Array.isArray(rows)) return '未核对存档';
  return (
    ['未开始', '进行中', '已失败', '未接取', '已完成'][rows.find((q) => q.id === id)?.step] || '未出现在记录'
  );
};

export function entityCatalog(index) {
  if (catalogs.has(index.entries)) return catalogs.get(index.entries);
  const quests = list(index.world?.quests);
  const entries = new Map(index.entries.map((e) => [e.id, e]));
  for (const q of quests) entries.set(q.id, { ...q, kind: '任务' });
  const children = new Map(),
    names = new Map(),
    questByNumber = new Map();
  for (const q of quests) {
    questByNumber.set(q.gameId, entries.get(q.id));
    if (!children.has(q.parentId)) children.set(q.parentId, []);
    children.get(q.parentId).push(entries.get(q.id));
  }
  const addName = (name, e) => {
    if (name.length < 2) return;
    const rows = names.get(name) || [];
    if (!rows.some((row) => row.id === e.id)) rows.push(e);
    names.set(name, rows);
  };
  for (const e of entries.values()) {
    addName(e.name, e);
    if (e.kind === '人物' && e.name.includes('-')) addName(e.name.split('-').at(-1), e);
    if (e.kind === '任务') addName(e.name.replace(/^【[^】]+】/, ''), e);
  }
  const proseNames = [...names.keys()]
    .filter((name) =>
      names
        .get(name)
        .some(
          (e) => ['人物', '物品'].includes(e.kind) || (e.kind === '任务' && !e.parentId && name.length >= 3),
        ),
    )
    .sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-CN'));
  const pattern = new RegExp(
    proseNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)',
    'gu',
  );
  const resolve = (id) =>
    id?.startsWith('name:') ? names.get(id.slice(5)) || [] : entries.has(id) ? [entries.get(id)] : [];
  const root = (q) => {
    const seen = new Set();
    while (q.parentId && questByNumber.has(q.parentId) && !seen.has(q.gameId)) {
      seen.add(q.gameId);
      q = questByNumber.get(q.parentId);
    }
    return q;
  };
  const family = (q) => {
    const rows = [],
      seen = new Set(),
      queue = [q];
    for (let at = 0; at < queue.length; at++) {
      const next = queue[at];
      if (seen.has(next.gameId)) continue;
      seen.add(next.gameId);
      rows.push(next);
      queue.push(...(children.get(next.gameId) || []));
    }
    return rows;
  };
  const mentions = (text) => {
    const found = new Map();
    pattern.lastIndex = 0;
    for (const match of String(text || '').matchAll(pattern)) {
      for (const e of names.get(match[0]) || []) {
        if (e.kind === '人物')
          found.set(e.id, { entity: e, ambiguous: (names.get(match[0]) || []).length > 1 });
      }
    }
    return [...found.values()];
  };
  const taskPeople = new Map();
  const peopleFor = (q) => {
    if (taskPeople.has(q.gameId)) return taskPeople.get(q.gameId);
    const rows = new Map();
    const add = (id, role) => {
      const e = entries.get('npc-' + id);
      if (!e) return;
      const row = rows.get(e.id) || { entity: e, roles: [] };
      if (!row.roles.includes(role)) row.roles.push(role);
      rows.set(e.id, row);
    };
    list(q.requestNPCs).forEach((id) => add(id, '接取人物'));
    list(q.finishNPCs).forEach((id) => add(id, '完成人物'));
    list(q.requirements)
      .filter((r) => ['Friendliness', 'FriendlinessUp', 'TeamMember'].includes(r.type))
      .forEach((r) => add(r.id, '人物条件'));
    list(q.placements).forEach((p) => add(p.npcId, p.interactionTarget ? '交互场景配置' : '事件场景配置'));
    mentions(q.name + ' ' + q.description).forEach(({ entity, ambiguous }) =>
      add(entity.gameId, ambiguous ? '说明提名（同名身份待核对）' : '任务文字提及'),
    );
    const result = [...rows.values()];
    taskPeople.set(q.gameId, result);
    return result;
  };
  const taskRelations = (q) => {
    const group = family(q),
      people = new Map(),
      items = new Map(),
      requirements = new Map();
    for (const step of group) {
      for (const row of peopleFor(step)) {
        const current = people.get(row.entity.id) || { entity: row.entity, roles: [], via: [] };
        current.roles = [...new Set([...current.roles, ...row.roles])];
        current.via.push(step);
        people.set(row.entity.id, current);
      }
      for (const m of list(step.materials)) {
        const e = entries.get('item-' + m.id);
        if (!e) continue;
        const row = items.get(e.id) || { entity: e, via: [] };
        row.via.push({ quest: step, count: m.count });
        items.set(e.id, row);
      }
      for (const r of list(step.requirements)) {
        if (!['PreQuest', 'NoQuest'].includes(r.type)) continue;
        const target = questByNumber.get(r.id);
        if (!target) continue;
        const key = target.id + ':' + r.type + ':' + r.value;
        const row = requirements.get(key) || { entity: target, type: r.type, value: r.value, via: [] };
        row.via.push(step);
        requirements.set(key, row);
      }
    }
    return {
      group,
      people: [...people.values()],
      items: [...items.values()],
      requirements: [...requirements.values()],
    };
  };
  const personCache = new Map();
  const personRelations = (e) => {
    if (personCache.has(e.id)) return personCache.get(e.id);
    const roots = new Map(),
      people = new Map(),
      items = new Map();
    for (const q of quests) {
      const persons = peopleFor(q),
        own = persons.find((p) => p.entity.id === e.id);
      if (!own) continue;
      const parent = root(entries.get(q.id));
      const row = roots.get(parent.id) || { entity: parent, roles: [], via: [] };
      row.roles = [...new Set([...row.roles, ...own.roles])];
      row.via.push(entries.get(q.id));
      roots.set(parent.id, row);
      for (const other of persons.filter((p) => p.entity.id !== e.id)) {
        const row = people.get(other.entity.id) || { entity: other.entity, roles: [], via: [] };
        row.roles = [...new Set([...row.roles, ...other.roles])];
        row.via.push(entries.get(q.id));
        people.set(other.entity.id, row);
      }
      for (const m of list(q.materials)) {
        const item = entries.get('item-' + m.id);
        if (!item) continue;
        const row = items.get(item.id) || { entity: item, via: [] };
        row.via.push({ quest: entries.get(q.id), count: m.count });
        items.set(item.id, row);
      }
    }
    const result = { quests: [...roots.values()], people: [...people.values()], items: [...items.values()] };
    personCache.set(e.id, result);
    return result;
  };
  const catalog = { entries, names, pattern, resolve, root, family, taskRelations, personRelations };
  catalogs.set(index.entries, catalog);
  return catalog;
}
