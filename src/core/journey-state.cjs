'use strict';

// JSON-only user intent. Save-derived facts never enter this persisted state.
const world = require('../data/world-index.json');
const game = require('../data/game-index.json');
const MAX = { places: 244, todos: 300, gifts: 100, handledActionIds: 2000 };
const localId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const actionId = /^journey:[a-z-]+:[a-f0-9]{32}$/;
const MAX_ITINERARY_STEPS = 100;
const sourceFields = {
  user: ['journey', 'goals', 'craftPlans'],
  quest: ['description', 'placements', 'requirements'],
  database: ['description', 'materials', 'hobbies', 'level', 'merchants.items'],
};
const clone = (v) => structuredClone(v);
const emptyJourneyState = () => ({ schema: 1, places: [], todos: [], gifts: [], handledActionIds: [] });

function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw Error(`${label}格式无效`);
}
function text(value, max, label, blank = true) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!blank && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw Error(`${label}无效`);
}
function bool(value, label) {
  if (typeof value !== 'boolean') throw Error(`${label}须为布尔值`);
}
function unique(list, key, label) {
  const seen = new Set();
  for (const row of list) {
    const id = key(row);
    if (seen.has(id)) throw Error(`${label}含重复标识`);
    seen.add(id);
  }
}

// Portable intent validation deliberately permits historical source pointers.
// Existence is checked against current main-process actions when adding a step.
function validateItinerary(value, { placeExists = (v) => /^place-\d{1,9}$/.test(v) } = {}) {
  // Lazy import avoids the intent-drafts -> journey-state module dependency.
  // Reject non-JSON descriptors before reading any itinerary or source field.
  require('./intent-drafts.cjs').intentFingerprint(value);
  exact(value, ['name', 'status', 'steps'], '本次行程');
  text(value.name, 80, '行程名称', false);
  if (!['draft', 'active', 'ended'].includes(value.status)) throw Error('行程状态无效');
  if (!Array.isArray(value.steps) || value.steps.length > MAX_ITINERARY_STEPS)
    throw Error('本次行程最多选择 100 项行动');
  for (const step of value.steps) {
    exact(
      step,
      ['actionId', 'title', 'placeId', 'sources', 'skipped', 'progressMode', 'continuationId'],
      '行程选择',
    );
    if (typeof step.actionId !== 'string' || !actionId.test(step.actionId)) throw Error('行动 ID 无效');
    text(step.title, 360, '选定行动名称', false);
    if (step.placeId !== undefined && (typeof step.placeId !== 'string' || !placeExists(step.placeId)))
      throw Error('行程地点 ID 无效');
    bool(step.skipped, '本次跳过状态');
    if (!['save', 'manual'].includes(step.progressMode)) throw Error('行程进度参照意图无效');
    if (
      step.continuationId !== undefined &&
      (step.progressMode !== 'save' ||
        typeof step.continuationId !== 'string' ||
        !/^journey:quest:[a-f0-9]{32}$/.test(step.continuationId))
    )
      throw Error('任务接续选择无效');
    if (!Array.isArray(step.sources) || !step.sources.length || step.sources.length > 32)
      throw Error('行动来源数量或格式无效');
    for (const source of step.sources) {
      exact(source, ['type', 'id', 'field'], '行动来源指针');
      if (!sourceFields[source.type]?.includes(source.field)) throw Error('行动来源类型或字段无效');
      if (typeof source.id !== 'string' || !/^[A-Za-z0-9@][A-Za-z0-9_:@.-]{0,159}$/.test(source.id))
        throw Error('行动来源 ID 无效');
      if (source.type === 'quest' && !/^quest-\d{1,9}$/.test(source.id)) throw Error('任务来源 ID 无效');
      if (source.type === 'database' && !/^(item|skill|npc|fusion|alchemy|cooking)-\d{1,9}$/.test(source.id))
        throw Error('图鉴来源 ID 无效');
    }
    unique(step.sources, (s) => `${s.type}:${s.id}:${s.field}`, '行动来源');
  }
  unique(value.steps, (s) => s.actionId, '本次行程');
  return value;
}

function itinerarySelection(action, placeId) {
  const sources = (action.sources || [])
    .filter((s) => sourceFields[s?.type]?.includes(s.field))
    .map(({ type, id, field }) => ({ type, id, field }));
  const distinct = [...new Map(sources.map((s) => [`${s.type}:${s.id}:${s.field}`, s])).values()];
  const generatedQuantity = ['material', 'craft', 'collection', 'gift'].includes(action.kind);
  return {
    actionId: action.id,
    // Only generated quantity labels are shortened. Multiplication signs and
    // following text in a personal title are part of the player's intent.
    title: (generatedQuantity ? action.title.replace(/\s*×\s*\d+.*$/, '') : action.title).slice(0, 360),
    ...(placeId === undefined ? {} : { placeId }),
    sources: distinct.slice(0, 32),
    skipped: false,
    progressMode: action.kind === 'quest' && action.progress?.status !== 'manual' ? 'save' : 'manual',
  };
}

function createJourneyStateTools({ world: worldIndex, game: gameIndex }) {
  const places = new Set(worldIndex.maps.map((p) => p.id));
  const people = new Set(
    [...worldIndex.people, ...gameIndex.entries.filter((e) => e.kind === '人物')].map((p) => p.id),
  );
  const items = new Map(gameIndex.entries.filter((e) => e.kind === '物品').map((e) => [e.id, e]));
  function placeId(id, optional = false) {
    if ((optional && id === undefined) || places.has(id)) return;
    throw Error('地点须为本机索引中的地点 ID');
  }
  function id(value) {
    if (typeof value !== 'string' || !localId.test(value)) throw Error('用户意图 ID 无效');
  }
  function validateJourneyState(state = emptyJourneyState()) {
    exact(state, ['schema', 'places', 'todos', 'gifts', 'handledActionIds', 'itinerary'], '行程状态');
    if (state.schema !== 1) throw Error('行程状态版本无效');
    for (const [key, max] of Object.entries(MAX))
      if (!Array.isArray(state[key]) || state[key].length > max) throw Error(`${key} 数量或格式无效`);
    for (const row of state.places) {
      exact(row, ['placeId', 'note', 'favorite', 'done'], '地点目标');
      placeId(row.placeId);
      text(row.note, 1000, '地点备注');
      bool(row.favorite, '收藏');
      bool(row.done, '地点处理状态');
    }
    for (const row of state.todos) {
      exact(row, ['id', 'title', 'detail', 'placeId', 'done'], '个人待办');
      id(row.id);
      text(row.title, 120, '待办标题', false);
      text(row.detail, 2000, '待办详情');
      placeId(row.placeId, true);
      bool(row.done, '待办完成状态');
    }
    for (const row of state.gifts) {
      exact(row, ['id', 'npcId', 'itemId', 'quantity', 'placeId', 'note', 'done'], '赠礼意图');
      id(row.id);
      if (!people.has(row.npcId)) throw Error('赠礼人物不存在');
      if (items.get(row.itemId)?.giftable !== true) throw Error('赠礼物品不存在或资料未列为可赠送');
      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 999)
        throw Error('赠礼数量须为 1 至 999');
      placeId(row.placeId, true);
      text(row.note, 1000, '赠礼备注');
      bool(row.done, '赠礼处理状态');
    }
    for (const value of state.handledActionIds)
      if (typeof value !== 'string' || !actionId.test(value)) throw Error('行动处理 ID 无效');
    unique(state.places, (r) => r.placeId, '地点目标');
    unique(state.todos, (r) => r.id, '个人待办');
    unique(state.gifts, (r) => r.id, '赠礼意图');
    unique(state.handledActionIds, (r) => r, '行动处理记录');
    if (state.itinerary !== undefined) validateItinerary(state.itinerary);
    return state;
  }
  // Returns a new state. The caller must validate the whole profile and use the
  // existing atomic store; no write, clock, random ID, or game API lives here.
  function applyJourneyCommand(state, command, { actionIds = [], actions = [], itinerarySteps = [] } = {}) {
    require('./intent-drafts.cjs').intentFingerprint(command);
    validateJourneyState(state);
    const schemas = {
      'journey-place-put': ['type', 'placeId', 'note', 'favorite', 'done'],
      'journey-place-remove': ['type', 'placeId'],
      'journey-todo-put': ['type', 'id', 'title', 'detail', 'placeId', 'done'],
      'journey-todo-remove': ['type', 'id'],
      'journey-gift-put': ['type', 'id', 'npcId', 'itemId', 'quantity', 'placeId', 'note', 'done'],
      'journey-gift-remove': ['type', 'id'],
      'journey-action-handle': ['type', 'id', 'handled'],
      'journey-itinerary-add': ['type', 'id', 'placeId'],
      'journey-itinerary-remove': ['type', 'id'],
      'journey-itinerary-move': ['type', 'id', 'direction'],
      'journey-itinerary-place': ['type', 'id', 'placeId'],
      'journey-itinerary-continue': ['type', 'id', 'targetId', 'placeId'],
      'journey-itinerary-clear': ['type'],
      'journey-itinerary-name': ['type', 'name'],
      'journey-itinerary-status': ['type', 'status'],
      'journey-itinerary-skip': ['type', 'id', 'skipped'],
    };
    exact(command, schemas[command?.type] || [], '行程命令');
    if (!schemas[command.type]) throw Error('未知行程命令');
    const next = clone(state);
    if (command.type.startsWith('journey-itinerary-')) {
      next.itinerary ||= { name: '本次行程', status: 'draft', steps: [] };
      const itinerary = next.itinerary;
      const at = itinerary.steps.findIndex((s) => s.actionId === command.id);
      if (
        ['journey-itinerary-add', 'journey-itinerary-place', 'journey-itinerary-continue'].includes(
          command.type,
        )
      ) {
        if (typeof command.id !== 'string' || !actionId.test(command.id)) throw Error('行动 ID 无效');
        const projected = itinerarySteps.find((s) => s.actionId === command.id);
        const continuing = command.type === 'journey-itinerary-continue';
        if (
          continuing &&
          (at < 0 || !projected?.continuation?.candidates.some((c) => c.actionId === command.targetId))
        )
          throw Error('接续步骤已变化，请重新核对后选择');
        const action = continuing
          ? actions.find((a) => a.id === command.targetId && a.kind === 'quest')
          : command.type === 'journey-itinerary-place'
            ? projected?.action || actions.find((a) => a.id === command.id)
            : actions.find((a) => a.id === command.id);
        if (!action) throw Error('行动不在当前清单中，请刷新后重试');
        const candidates = [...new Set(action.places.flatMap((p) => p.mapIds))];
        if (command.placeId !== undefined) {
          placeId(command.placeId);
          if (!candidates.includes(command.placeId)) throw Error('所选场景不属于这项行动的地点线索');
        } else if (candidates.length) throw Error('请选择这项行动要去的确切资料场景');
        if (command.type === 'journey-itinerary-add') {
          if (at < 0) {
            if (itinerary.steps.length >= MAX_ITINERARY_STEPS) throw Error('本次行程最多选择 100 项行动');
            itinerary.steps.push(itinerarySelection(action, command.placeId));
          }
        } else {
          if (at < 0) throw Error('行动不在本次行程中');
          if (continuing) itinerary.steps[at].continuationId = command.targetId;
          if (command.placeId === undefined) delete itinerary.steps[at].placeId;
          else itinerary.steps[at].placeId = command.placeId;
        }
      } else if (command.type === 'journey-itinerary-clear') {
        itinerary.steps = [];
        itinerary.status = 'draft';
      } else if (command.type === 'journey-itinerary-name') {
        text(command.name, 80, '行程名称', false);
        itinerary.name = command.name.trim();
      } else if (command.type === 'journey-itinerary-status') {
        if (!['draft', 'active', 'ended'].includes(command.status)) throw Error('行程状态无效');
        if (command.status === 'active' && !itinerary.steps.length) throw Error('先选择至少一项行动再出发');
        itinerary.status = command.status;
      } else {
        if (typeof command.id !== 'string' || !actionId.test(command.id)) throw Error('行动 ID 无效');
        if (at < 0) throw Error('行动不在本次行程中');
        if (command.type === 'journey-itinerary-remove') itinerary.steps.splice(at, 1);
        if (command.type === 'journey-itinerary-skip') {
          bool(command.skipped, '本次跳过状态');
          itinerary.steps[at].skipped = command.skipped;
        }
        if (command.type === 'journey-itinerary-move') {
          if (!['up', 'down'].includes(command.direction)) throw Error('行程排序方向无效');
          const to = at + (command.direction === 'up' ? -1 : 1);
          if (to >= 0 && to < itinerary.steps.length)
            [itinerary.steps[at], itinerary.steps[to]] = [itinerary.steps[to], itinerary.steps[at]];
        }
      }
    } else if (command.type === 'journey-action-handle') {
      bool(command.handled, '行动处理状态');
      if (typeof command.id !== 'string' || !actionId.test(command.id)) throw Error('行动 ID 无效');
      // Reopening an old handled action remains possible after loading an older
      // save. New marks must refer to a main-process-generated current action.
      if (command.handled && !actionIds.includes(command.id) && !actions.some((a) => a.id === command.id))
        throw Error('行动不在当前行程中，请刷新后重试');
      next.handledActionIds = next.handledActionIds.filter((x) => x !== command.id);
      if (command.handled) next.handledActionIds.push(command.id);
    } else {
      const kind = command.type.split('-')[1];
      const key = kind === 'place' ? 'placeId' : 'id';
      if (kind === 'place') placeId(command.placeId);
      else id(command.id);
      const list = kind === 'place' ? next.places : kind === 'todo' ? next.todos : next.gifts;
      const at = list.findIndex((row) => row[key] === command[key]);
      if (command.type.endsWith('-remove')) {
        if (at >= 0) list.splice(at, 1);
      } else {
        const { type, ...row } = command;
        if (at < 0) list.push(row);
        else list[at] = row;
      }
    }
    validateJourneyState(next);
    return next;
  }
  return { validateJourneyState, applyJourneyCommand };
}

module.exports = {
  ...createJourneyStateTools({ world, game }),
  createJourneyStateTools,
  emptyJourneyState,
  MAX,
  MAX_ITINERARY_STEPS,
  validateItinerary,
};
