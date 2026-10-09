'use strict';

// User history only. No save writes, native capability, filesystem path or telemetry.
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const gameIndex = require('../data/game-index.json');
const worldIndex = require('../data/world-index.json');
const { giftItemLabel, giftPersonLabel } = require('./gift-labels.cjs');
const MAX_ENTRIES = 5000;
const MAX_DRAFTS = 20;
const LINK_TYPES = Object.freeze([
  'database',
  'quest',
  'place',
  'guide',
  'goal',
  'craft-plan',
  'todo',
  'gift',
]);
const SYSTEM_KINDS = Object.freeze([
  'goal-completed',
  'goal-reopened',
  'todo-completed',
  'todo-reopened',
  'gift-completed',
  'gift-reopened',
  'craft-plan-completed',
  'craft-plan-reopened',
]);
const KINDS = Object.freeze(['manual', ...SYSTEM_KINDS]);
const localId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const linkedId = /^[A-Za-z0-9][A-Za-z0-9_:@.-]{0,159}$/;
const clone = (value) => structuredClone(value);

function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw Error(`${label}包含未知字段或格式无效`);
}
function text(value, max, label, blank = true) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!blank && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw Error(`${label}无效，最多 ${max} 字`);
}
function id(value) {
  if (typeof value !== 'string' || !localId.test(value)) throw Error('记录 ID 无效');
}
function iso(value, label = '时间') {
  // Date.parse alone silently accepts impossible dates such as February 30.
  const match =
    typeof value === 'string' &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw Error(`${label}须为带时区的 ISO 时间`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = match[8] === 'Z' ? [0, 0] : match[8].slice(1).split(':').map(Number);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offset[0] > 23 ||
    offset[1] > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error(`${label}不是有效日期`);
  return new Date(value).toISOString();
}
function currentContext(context) {
  if (!context?.profile || !localId.test(context.profile.id || '')) throw Error('记录须关联有效周目');
  const profile = context.profile;
  const game = context.game || gameIndex;
  const world = context.world || worldIndex;
  const guideRows = context.catalog?.entries || context.guides || [];
  const guides = new Map(guideRows.map((row) => [row.id, row]));
  // guideIds is the Store catalog's actual ID set, not an ID pattern.
  for (const guideId of context.guideIds || [])
    if (!guides.has(guideId)) guides.set(guideId, { id: guideId, title: guideId });
  const map = (rows = []) => new Map(rows.map((row) => [row.id, row]));
  return {
    profile,
    world,
    game,
    tables: {
      database: map([...(world.people || []), ...(game.entries || [])]),
      quest: map(world.quests),
      place: map(world.maps),
      guide: guides,
      goal: map(profile.goals),
      'craft-plan': map(profile.craftPlans),
      todo: map(profile.journey?.todos),
      gift: map(profile.journey?.gifts),
    },
  };
}
function labelFor(type, row, context) {
  if (type === 'database') {
    const name = String(row.name || row.title || row.id);
    const prefix = row.kind ? `${row.kind} · ` : '';
    let suffix = '';
    if (row.kind === '物品' || row.kind === '武学') suffix = giftItemLabel({ ...row, name: '' });
    if (row.kind === '物品' && (row.typeKey === 'Recipe' || row.teachesRecipes?.length))
      suffix += ' · 学习图纸';
    if (row.kind === '人物')
      suffix = giftPersonLabel(row, [...context.tables.database.values()]).slice(row.name.length);
    return prefix + name.slice(0, 160 - prefix.length - suffix.length) + suffix;
  }
  if (type === 'place') {
    const suffix = ` · 场景 #${row.gameId ?? String(row.id).slice(6)}`;
    return String(row.name || row.title || row.id).slice(0, 160 - suffix.length) + suffix;
  }
  if (type === 'gift') {
    const person =
      context.tables.database.get(row.npcId) || context.world.people?.find((p) => p.id === row.npcId);
    const item = context.tables.database.get(row.itemId);
    return `${giftPersonLabel(person, context.game.entries || []) || row.npcId} · ${giftItemLabel(item) || row.itemId} × ${row.quantity}`.slice(
      0,
      160,
    );
  }
  return String(row.name || row.title || row.id).slice(0, 160);
}
function linkIdentity(link) {
  if (!LINK_TYPES.includes(link.type) || typeof link.id !== 'string' || !linkedId.test(link.id))
    throw Error('记录关联类型或 ID 无效');
  return `${link.type}:${link.id}`;
}
function validateLinks(links, context) {
  if (!Array.isArray(links) || links.length > 8) throw Error('每条记录最多关联 8 项');
  const seen = new Set();
  for (const link of links) {
    exact(link, ['type', 'id', 'label', 'detached'], '记录关联');
    const key = linkIdentity(link);
    text(link.label, 160, '关联名称', false);
    if (link.detached !== undefined && link.detached !== true) throw Error('历史关联标记无效');
    if (!link.detached && !context.tables[link.type].has(link.id))
      throw Error('关联不存在于本机资料或当前周目');
    if (seen.has(key)) throw Error('记录关联重复');
    seen.add(key);
  }
}
function validateSnapshot(snapshot) {
  exact(snapshot, ['name', 'hash', 'modifiedAt', 'mapName', 'playSeconds'], '存档参照摘要');
  text(snapshot.name, 128, '存档名称', false);
  if (/[\\/:]/.test(snapshot.name) || !/\.sav$/i.test(snapshot.name) || snapshot.name.startsWith('.'))
    throw Error('存档名称须为文件名');
  if (typeof snapshot.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(snapshot.hash))
    throw Error('存档摘要 SHA-256 无效');
  iso(snapshot.modifiedAt, '存档修改时间');
  if (snapshot.mapName !== undefined) {
    text(snapshot.mapName, 160, '参照地点', false);
    if (/[\\/:]/.test(snapshot.mapName)) throw Error('参照地点不得包含路径');
  }
  if (
    snapshot.playSeconds !== undefined &&
    (!Number.isFinite(snapshot.playSeconds) || snapshot.playSeconds < 0 || snapshot.playSeconds > 1e10)
  )
    throw Error('参照游玩时间无效');
}
function selectedSnapshot(reference) {
  if (!reference) throw Error('当前没有可附加的已选存档参照');
  const snapshot = {
    name: reference.name,
    hash: reference.hash,
    modifiedAt: iso(reference.modifiedAt, '存档修改时间'),
  };
  if (reference.metadata?.mapName !== undefined) snapshot.mapName = reference.metadata.mapName;
  if (reference.metadata?.playSeconds !== undefined) snapshot.playSeconds = reference.metadata.playSeconds;
  validateSnapshot(snapshot);
  return snapshot;
}
function validateEntry(entry, context) {
  exact(
    entry,
    ['id', 'kind', 'title', 'body', 'occurredAt', 'createdAt', 'updatedAt', 'tags', 'links', 'snapshot'],
    '江湖记录',
  );
  id(entry.id);
  if (!KINDS.includes(entry.kind)) throw Error('记录类型无效');
  text(entry.title, 160, '记录标题', false);
  text(entry.body, 4000, '记录正文');
  iso(entry.occurredAt, '事件时间');
  iso(entry.createdAt, '创建时间');
  iso(entry.updatedAt, '更新时间');
  if (Date.parse(entry.updatedAt) < Date.parse(entry.createdAt)) throw Error('更新时间早于创建时间');
  if (!Array.isArray(entry.tags) || entry.tags.length > 10) throw Error('每条记录最多 10 个标签');
  const tags = new Set();
  for (const tag of entry.tags) {
    text(tag, 30, '记录标签', false);
    if (tag !== tag.trim() || tags.has(tag.toLocaleLowerCase('zh-CN'))) throw Error('标签含空白或重复');
    tags.add(tag.toLocaleLowerCase('zh-CN'));
  }
  validateLinks(entry.links, context);
  if (
    entry.kind !== 'manual' &&
    !entry.links.some((link) => link.type === entry.kind.replace(/-(?:completed|reopened)$/, ''))
  )
    throw Error('用户状态事件缺少原对象关联');
  if (entry.snapshot !== undefined) validateSnapshot(entry.snapshot);
}
function validateEntries(entries, context) {
  const resolved = currentContext(context);
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
    throw Error(`每个周目最多 ${MAX_ENTRIES} 条江湖记录`);
  const seen = new Set();
  for (const entry of entries) {
    validateEntry(entry, resolved);
    if (seen.has(entry.id)) throw Error('江湖记录 ID 重复');
    seen.add(entry.id);
  }
  return entries;
}
function clock(options = {}, withId = false) {
  const evaluate = (value, fallback) =>
    typeof value === 'function' ? value() : value === undefined ? fallback() : value;
  const time = iso(
    evaluate(options.now, () => new Date().toISOString()),
    '服务器时间',
  );
  const value = { time };
  if (withId) {
    value.id = evaluate(options.id, randomUUID);
    id(value.id);
  }
  return value;
}
function inputLinks(links, context, previous) {
  if (!Array.isArray(links) || links.length > 8) throw Error('每条记录最多关联 8 项');
  return links.map((link) => {
    exact(link, ['type', 'id'], '记录关联命令');
    linkIdentity(link);
    const historical = previous?.links.find(
      (old) =>
        old.type === link.type &&
        old.id === link.id &&
        (old.detached || ['database', 'gift'].includes(link.type)),
    );
    if (historical) return clone(historical);
    const row = context.tables[link.type].get(link.id);
    if (!row) throw Error('关联不存在于本机资料或当前周目');
    return { type: link.type, id: link.id, label: labelFor(link.type, row, context) };
  });
}
function applyEntryCommand(entries, command, context, options = {}) {
  validateEntries(entries, context);
  const fields = ['type', 'title', 'body', 'occurredAt', 'tags', 'links', 'snapshotMode'];
  const schemas = {
    'journal-entry-put': fields,
    'journal-entry-update': [...fields, 'id', 'expectedEntry'],
    'journal-entry-remove': ['type', 'id', 'expectedEntry'],
    'journal-entries-remove': ['type', 'ids', 'expectedEntries'],
  };
  if (!Object.hasOwn(schemas, command?.type)) throw Error('未知记录命令');
  exact(command, schemas[command.type], '记录命令');
  if (command.type === 'journal-entries-remove') {
    if (!Array.isArray(command.ids) || command.ids.length < 1 || command.ids.length > MAX_ENTRIES)
      throw Error(`须明确选择 1 至 ${MAX_ENTRIES} 条历史记录`);
    const available = new Set(entries.map((entry) => entry.id));
    const selected = new Set();
    for (const targetId of command.ids) {
      id(targetId);
      if (selected.has(targetId)) throw Error('待删除的历史记录 ID 重复');
      if (!available.has(targetId)) throw Error('待删除的历史记录不存在于当前周目');
      selected.add(targetId);
    }
    if (!Array.isArray(command.expectedEntries) || command.expectedEntries.length !== selected.size)
      throw Error('请重新核对所选记录后再确认移除');
    const expected = new Map();
    for (const entry of command.expectedEntries) {
      if (!entry || !selected.has(entry.id) || expected.has(entry.id))
        throw Error('已核对的记录范围无效，请重新核对');
      expected.set(entry.id, entry);
    }
    if (
      entries.some(
        (entry) => selected.has(entry.id) && JSON.stringify(entry) !== JSON.stringify(expected.get(entry.id)),
      )
    )
      throw Error('所选记录已变化，请重新核对；当前记录已保留');
    return clone(entries.filter((entry) => !selected.has(entry.id)));
  }
  const creating = command.type === 'journal-entry-put';
  const previous = creating ? null : entries.find((entry) => entry.id === command.id);
  if (!creating) {
    id(command.id);
    if (!previous) throw Error('记录不存在');
    if (command.type === 'journal-entry-update' && previous.kind !== 'manual')
      throw Error('用户状态事件不能作为手写记录修改');
    if (command.type === 'journal-entry-update' && !isDeepStrictEqual(previous, command.expectedEntry))
      throw Error('原记录已变化或尚未完整核对；原记录与草稿仍保留，请重新打开');
  }
  if (command.type === 'journal-entry-remove') {
    if (!command.expectedEntry || JSON.stringify(previous) !== JSON.stringify(command.expectedEntry))
      throw Error('这条记录已变化或尚未核对，请重新核对；当前记录已保留');
    return clone(entries.filter((entry) => entry.id !== command.id));
  }
  text(command.title, 160, '记录标题', false);
  text(command.body, 4000, '记录正文');
  if (!Array.isArray(command.tags) || command.tags.length > 10) throw Error('每条记录最多 10 个标签');
  const stamps = clock(options, creating);
  const mode = command.snapshotMode ?? (creating ? 'none' : 'keep');
  if (!['none', 'selected', 'keep'].includes(mode) || (creating && mode === 'keep'))
    throw Error('存档参照选择无效');
  // Editing drafts use this stamp as their original-version guard. Every
  // committed edit must advance it, even within one clock tick or after rollback.
  const updatedAt =
    previous && Date.parse(stamps.time) <= Date.parse(previous.updatedAt)
      ? new Date(Date.parse(previous.updatedAt) + 1).toISOString()
      : stamps.time;
  const entry = {
    id: creating ? stamps.id : previous.id,
    kind: 'manual',
    title: command.title.trim(),
    body: command.body,
    occurredAt: iso(command.occurredAt, '事件时间'),
    createdAt: previous?.createdAt || stamps.time,
    updatedAt,
    tags: command.tags.map((tag) => {
      text(tag, 30, '记录标签', false);
      return tag.trim();
    }),
    links: inputLinks(command.links, currentContext(context), previous || options.draft),
  };
  if (mode === 'selected') entry.snapshot = selectedSnapshot(context.selectedReference);
  else if (mode === 'keep' && previous?.snapshot) entry.snapshot = clone(previous.snapshot);
  const next = creating
    ? [...clone(entries), entry]
    : entries.map((old) => (old.id === entry.id ? entry : clone(old)));
  validateEntries(next, context);
  return next;
}
function appendSystemEvent(entries, event, context, options = {}) {
  validateEntries(entries, context);
  exact(event, ['type', 'id', 'beforeDone', 'afterDone'], '用户状态事件');
  if (
    !['goal', 'todo', 'gift', 'craft-plan'].includes(event.type) ||
    typeof event.beforeDone !== 'boolean' ||
    typeof event.afterDone !== 'boolean'
  )
    throw Error('用户状态变化无效');
  id(event.id);
  const resolved = currentContext(context);
  const entity = resolved.tables[event.type].get(event.id);
  if (!entity || entity.done !== event.afterDone) throw Error('用户状态事件与当前周目对象不一致');
  if (options.snapshot !== undefined && typeof options.snapshot !== 'boolean')
    throw Error('附加存档参照设置无效');
  if (event.beforeDone === event.afterDone) return entries;
  const stamps = clock(options, true);
  const action = event.afterDone ? '标为完成' : '重新打开';
  const noun = { goal: '目标', todo: '待办', gift: '赠礼意图', 'craft-plan': '制作计划' }[event.type];
  const label = labelFor(event.type, entity, resolved);
  const linkSpecs = [{ type: event.type, id: event.id }];
  const add = (type, value) => {
    if (
      value &&
      resolved.tables[type]?.has(value) &&
      !linkSpecs.some((link) => link.type === type && link.id === value)
    )
      linkSpecs.push({ type, id: value });
  };
  if (entity.source)
    add(entity.source.type === 'planner' ? 'craft-plan' : entity.source.type, entity.source.id);
  if (event.type === 'gift') {
    add('database', entity.npcId);
    add('database', entity.itemId);
  }
  add('place', entity.placeId);
  const entry = {
    id: stamps.id,
    kind: `${event.type}-${event.afterDone ? 'completed' : 'reopened'}`,
    title: `你${action}${noun}：${label}`.slice(0, 160),
    body: `你在手札中将${noun}「${label}」${action}。这是你的操作记录，游戏中的实际状态仍需在存档或游戏内核对。`,
    occurredAt: stamps.time,
    createdAt: stamps.time,
    updatedAt: stamps.time,
    tags: [],
    links: inputLinks(linkSpecs, resolved),
  };
  if (options.snapshot === true) entry.snapshot = selectedSnapshot(context.selectedReference);
  const next = [...clone(entries), entry];
  validateEntries(next, context);
  return next;
}
// Partial editor input is durable user content, not a committed event. Invalid
// dates and unparsed tags remain recoverable until the user explicitly saves.
function validateDrafts(drafts, context) {
  const resolved = currentContext(context);
  if (!Array.isArray(drafts) || drafts.length > MAX_DRAFTS)
    throw Error(`每个周目最多保留 ${MAX_DRAFTS} 份记录草稿，请继续写或明确放弃已有草稿`);
  const seen = new Set();
  for (const draft of drafts) {
    exact(
      draft,
      [
        'id',
        'revision',
        'entryId',
        'entryUpdatedAt',
        'entrySnapshot',
        'title',
        'body',
        'localTime',
        'tags',
        'links',
        'snapshotMode',
        'createdAt',
        'updatedAt',
      ],
      '记录草稿',
    );
    id(draft.id);
    if (seen.has(draft.id)) throw Error('记录草稿 ID 重复');
    seen.add(draft.id);
    if (!Number.isSafeInteger(draft.revision) || draft.revision < 1) throw Error('草稿版本无效');
    if (draft.entryId !== undefined) {
      id(draft.entryId);
      iso(draft.entryUpdatedAt, '原记录更新时间');
      if (draft.entrySnapshot !== undefined) {
        validateEntries([draft.entrySnapshot], context);
        if (
          draft.entrySnapshot.kind !== 'manual' ||
          draft.entrySnapshot.id !== draft.entryId ||
          draft.entrySnapshot.updatedAt !== draft.entryUpdatedAt
        )
          throw Error('草稿完整原记录快照无效');
      }
    } else if (draft.entryUpdatedAt !== undefined) throw Error('草稿原记录无效');
    else if (draft.entrySnapshot !== undefined) throw Error('草稿原记录快照无效');
    text(draft.title, 160, '草稿标题');
    text(draft.body, 4000, '草稿正文');
    text(draft.localTime, 32, '草稿事件时间');
    text(draft.tags, 310, '草稿标签');
    if (
      !['none', 'keep', 'selected'].includes(draft.snapshotMode) ||
      (!draft.entryId && draft.snapshotMode === 'keep')
    )
      throw Error('草稿存档参照选择无效');
    validateLinks(draft.links, resolved);
    iso(draft.createdAt, '草稿创建时间');
    iso(draft.updatedAt, '草稿更新时间');
    if (Date.parse(draft.updatedAt) < Date.parse(draft.createdAt)) throw Error('草稿更新时间早于创建时间');
  }
  return drafts;
}
function applyDraftCommand(drafts, entries, command, context, options = {}) {
  validateDrafts(drafts, context);
  validateEntries(entries, context);
  const content = ['title', 'body', 'localTime', 'tags', 'links', 'snapshotMode'];
  const schemas = {
    'journal-draft-put': [
      'type',
      'id',
      'revision',
      'entryId',
      'entryUpdatedAt',
      'entrySnapshot',
      'sourceId',
      ...content,
    ],
    'journal-draft-remove': ['type', 'id', 'revision'],
    'journal-draft-commit': ['type', 'id', 'revision', 'occurredAt'],
  };
  if (!Object.hasOwn(schemas, command?.type)) throw Error('未知草稿命令');
  exact(command, schemas[command.type], '草稿命令');
  id(command.id);
  if (!Number.isSafeInteger(command.revision) || command.revision < 0) throw Error('草稿版本无效');
  const previous = drafts.find((draft) => draft.id === command.id);
  if ((previous?.revision || 0) !== command.revision)
    throw Error('这份草稿已在另一个窗口变化。当前编辑仍保留，请另存一份草稿后核对');
  if (command.type !== 'journal-draft-put' && !previous) throw Error('草稿已不存在，请重新打开');
  if (command.type === 'journal-draft-remove')
    return { drafts: clone(drafts.filter((draft) => draft.id !== command.id)), entries: clone(entries) };
  if (command.type === 'journal-draft-commit') {
    const original = previous.entryId && entries.find((entry) => entry.id === previous.entryId);
    if (previous.entryId && (!original || original.updatedAt !== previous.entryUpdatedAt))
      throw Error('原记录已被修改或删除，草稿仍保留。请另存为新记录后核对');
    if (previous.entryId && !isDeepStrictEqual(original, previous.entrySnapshot))
      throw Error('原记录已被修改或缺少完整核对快照，草稿仍保留。请另存为新记录后核对');
    if (!original && entries.some((entry) => entry.id === previous.id))
      throw Error('记录编号已存在，请另存草稿');
    const next = applyEntryCommand(
      entries,
      {
        type: original ? 'journal-entry-update' : 'journal-entry-put',
        ...(original ? { id: original.id, expectedEntry: previous.entrySnapshot } : {}),
        title: previous.title,
        body: previous.body,
        occurredAt: command.occurredAt,
        tags: previous.tags
          .split(/[,，\r\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        links: previous.links.map(({ type, id }) => ({ type, id })),
        snapshotMode: previous.snapshotMode,
      },
      context,
      { ...options, id: previous.id, draft: previous },
    );
    return { drafts: clone(drafts.filter((draft) => draft.id !== previous.id)), entries: next };
  }
  if (
    previous &&
    (previous.entryId !== command.entryId ||
      previous.entryUpdatedAt !== command.entryUpdatedAt ||
      !isDeepStrictEqual(previous.entrySnapshot, command.entrySnapshot))
  )
    throw Error('草稿原记录关联不能更换，请另存一份');
  const original = command.entryId && entries.find((entry) => entry.id === command.entryId);
  const source = command.sourceId && drafts.find((draft) => draft.id === command.sourceId);
  if (command.sourceId !== undefined && (previous || command.entryId || !source))
    throw Error('另存草稿来源无效');
  if (!previous && command.entryId && (!original || original.kind !== 'manual'))
    throw Error('原手写记录已不存在');
  if (!previous && command.entryId && !isDeepStrictEqual(original, command.entrySnapshot))
    throw Error('原记录已变化或尚未完整核对；原记录与草稿仍保留，请重新打开');
  if (!command.entryId && command.entrySnapshot !== undefined) throw Error('草稿原记录快照无效');
  const stamps = clock(options);
  const draft = {
    id: command.id,
    revision: command.revision + 1,
    ...(command.entryId === undefined
      ? {}
      : {
          entryId: command.entryId,
          entryUpdatedAt: command.entryUpdatedAt,
          ...(command.entrySnapshot === undefined ? {} : { entrySnapshot: clone(command.entrySnapshot) }),
        }),
    title: command.title,
    body: command.body,
    localTime: command.localTime,
    tags: command.tags,
    links: inputLinks(command.links, currentContext(context), previous || original || source),
    snapshotMode: command.snapshotMode,
    createdAt: previous?.createdAt || stamps.time,
    updatedAt: stamps.time,
  };
  const next = previous
    ? drafts.map((old) => (old.id === draft.id ? draft : clone(old)))
    : [...clone(drafts), draft];
  validateDrafts(next, context);
  return { drafts: next, entries: clone(entries) };
}
// Call in the same atomic transaction BEFORE validating the profile after an
// entity is removed. Identity and the label at recording time remain readable.
function detachLinks(entries, type, targetId) {
  linkIdentity({ type, id: targetId });
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw Error('江湖记录数组无效');
  return entries.map((entry) => ({
    ...clone(entry),
    ...(entry.entrySnapshot ? { entrySnapshot: detachLinks([entry.entrySnapshot], type, targetId)[0] } : {}),
    links: entry.links.map((link) =>
      link.type === type && link.id === targetId ? { ...clone(link), detached: true } : clone(link),
    ),
  }));
}

module.exports = {
  MAX_ENTRIES,
  MAX_DRAFTS,
  LINK_TYPES,
  KINDS,
  SYSTEM_KINDS,
  validateEntries,
  validateDrafts,
  applyDraftCommand,
  applyEntryCommand,
  appendSystemEvent,
  detachLinks,
  validateISOTime: iso,
};
