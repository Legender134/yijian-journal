'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const { validateCraftList } = require('./material-plan.cjs');
const { validateCraftPlans } = require('./craft-plans.cjs');
const { validateJourneyState, applyJourneyCommand, emptyJourneyState } = require('./journey-state.cjs');
const { validateReservations } = require('./reservations.cjs');
const { validateAllocations } = require('./resource-allocations.cjs');
const { recipeGoalList } = require('./resource-budget.cjs');
const { validateResourcePriority } = require('./resource-priority.cjs');
const { validateCraftChoices } = require('./crafting-stages.cjs');
const {
  validateEntries,
  validateDrafts,
  applyDraftCommand,
  applyEntryCommand,
  appendSystemEvent,
  detachLinks,
} = require('./event-journal.cjs');
const {
  validateTrash,
  moveEntriesToTrash,
  applyTrashCommand,
  detachTrashLinks,
} = require('./event-journal-trash.cjs');
const { validateIntentDrafts, applyIntentDraftCommand } = require('./intent-drafts.cjs');
const {
  validateRevisions,
  retainEditedRevisions,
  assertFreshEntryIds,
  applyRevisionCommand,
  detachRevisionLinks,
} = require('./journal-revisions.cjs');
const { validateJourneyTrash, applyJourneyTrashCommand } = require('./journey-trash.cjs');
const { validateNoteRevisions, retainNote } = require('./note-revisions.cjs');
const world = require('../data/world-index.json');
const questIds = new Set(world.quests.map((q) => q.id));
const placeIds = new Set(world.maps.map((p) => p.id));
const databaseKinds = new Map(require('../data/game-index.json').entries.map((e) => [e.id, e.kind]));

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
function text(value, max = 1000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`文本长度须在 ${max} 字以内`);
  return value.trim();
}
function createProfile(name = '我的江湖') {
  return {
    id: crypto.randomUUID(),
    name,
    stage: 0,
    stageConfirmed: false,
    checks: {},
    favorites: [],
    goals: [],
    notes: '',
    saveSlot: '',
    createdAt: now(),
    updatedAt: now(),
  };
}
function defaults() {
  const profile = createProfile();
  profile.referenceMode = 'latest';
  return {
    schema: 1,
    activeProfileId: profile.id,
    profiles: [profile],
    settings: {
      spoiler: 'hints',
      autoBackup: true,
      savePath: '',
      steamPath: '',
      companionEnabled: true,
      companionPosition: 'top-right',
      saveFeedback: false,
      offerAutoSaveOnStart: true,
      compactOpacity: 0.96,
    },
    updatedAt: now(),
  };
}
function validateGoalSource(source, ids, plans = []) {
  if (source === undefined) return;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('待办资料引用无效');
  if (Object.keys(source).some((key) => !['type', 'id', 'quantity'].includes(key)))
    throw new Error('待办资料引用包含未知字段');
  if (source.type === 'guide') {
    if (!ids.has(source.id) || source.quantity !== undefined) throw new Error('待办线索不存在');
  } else if (source.type === 'database') {
    if (typeof source.id !== 'string' || !/^(item|skill|npc|fusion|alchemy|cooking)-\d{1,9}$/.test(source.id))
      throw new Error('待办图鉴引用无效');
    if (
      source.quantity !== undefined &&
      (!Number.isSafeInteger(source.quantity) || source.quantity < 1 || source.quantity > 999)
    )
      throw new Error('待办制作次数无效');
  } else if (source.type === 'quest') {
    if (!questIds.has(source.id) || source.quantity !== undefined) throw new Error('待办任务引用无效');
  } else if (source.type === 'planner') {
    if ((source.id !== 'current' && !plans.some((p) => p.id === source.id)) || source.quantity !== undefined)
      throw new Error('待办备料引用无效');
  } else throw new Error('待办资料类型无效');
}
function validateState(s, ids) {
  if (!s || s.schema !== 1 || !Array.isArray(s.profiles) || s.profiles.length < 1 || s.profiles.length > 30)
    throw new Error('不是有效的逸剑手札数据文件');
  const seen = new Set();
  for (const p of s.profiles) {
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id) || seen.has(p.id))
      throw new Error('周目编号无效');
    seen.add(p.id);
    text(p.name, 40);
    if (!p.name.trim()) throw new Error('周目名称不能为空');
    if (!Number.isInteger(p.stage) || p.stage < 0 || p.stage > 6) throw new Error('阶段无效');
    if (
      !p.checks ||
      typeof p.checks !== 'object' ||
      Array.isArray(p.checks) ||
      Object.keys(p.checks).length > 1000
    )
      throw new Error('清单无效');
    for (const [id, value] of Object.entries(p.checks))
      if (!ids.has(id) || !['done', 'skip'].includes(value)) throw new Error('清单包含未知条目');
    if (!Array.isArray(p.favorites) || p.favorites.length > 1000 || p.favorites.some((id) => !ids.has(id)))
      throw new Error('收藏无效');
    text(p.notes, 20000);
    if (p.noteRevisions !== undefined) validateNoteRevisions(p.noteRevisions);
    if (p.craftList !== undefined) validateCraftList(p.craftList);
    if (p.previousCraftList !== undefined) validateCraftList(p.previousCraftList);
    if (p.previousCraftChoices !== undefined) validateCraftChoices(p.previousCraftChoices);
    if (p.craftPlans !== undefined) validateCraftPlans(p.craftPlans);
    if (p.craftChoices !== undefined) validateCraftChoices(p.craftChoices);
    if (p.journey !== undefined) validateJourneyState(p.journey);
    if (p.resourcePriority !== undefined) validateResourcePriority(p.resourcePriority);
    if (p.journalEntries !== undefined) validateEntries(p.journalEntries, { profile: p, guideIds: ids });
    if (p.journalDrafts !== undefined) validateDrafts(p.journalDrafts, { profile: p, guideIds: ids });
    if (p.journalTrash !== undefined)
      validateTrash(p.journalTrash, { profile: p, guideIds: ids }, p.journalEntries || []);
    if (p.journalRevisions !== undefined)
      validateRevisions(p.journalRevisions, { profile: p, guideIds: ids });
    if (p.intentDrafts !== undefined) validateIntentDrafts(p.intentDrafts);
    if (p.journeyTrash !== undefined) validateJourneyTrash(p.journeyTrash);
    if (p.activeCraftPlanId !== undefined && !p.craftPlans?.some((x) => x.id === p.activeCraftPlanId))
      throw Error('当前编辑计划引用无效');
    if (p.previousCraftContext !== undefined) {
      const context = p.previousCraftContext;
      if (
        !context ||
        typeof context !== 'object' ||
        Array.isArray(context) ||
        Object.keys(context).some((k) => !['activeCraftPlanId', 'reserveCraftDraft'].includes(k)) ||
        typeof context.reserveCraftDraft !== 'boolean' ||
        (context.activeCraftPlanId !== undefined &&
          !p.craftPlans?.some((x) => x.id === context.activeCraftPlanId))
      )
        throw Error('上次编辑清单的计划与物资保留记录无效');
    }
    if (p.reserveCraftDraft !== undefined && typeof p.reserveCraftDraft !== 'boolean')
      throw Error('编辑清单物资保留设置无效');
    for (const key of ['recentSearches', 'savedSearches']) {
      if (
        p[key] !== undefined &&
        (!Array.isArray(p[key]) ||
          p[key].length > 20 ||
          new Set(p[key]).size !== p[key].length ||
          p[key].some((q) => typeof q !== 'string' || !q.trim() || q.length > 200))
      )
        throw Error('搜索记录无效');
    }
    if (p.reservations !== undefined) validateReservations(p.reservations);
    validateAllocations(p.allocations, p.reservations);
    if (p.stageConfirmed !== undefined && typeof p.stageConfirmed !== 'boolean') throw Error('阶段确认无效');
    if (p.referenceMode !== undefined && !['latest', 'slot', 'none'].includes(p.referenceMode))
      throw Error('存档参照方式无效');
    if (p.referenceMode === 'slot' && !p.saveSlot) throw Error('固定参照须选择存档');
    if (
      p.saveSlot !== undefined &&
      (typeof p.saveSlot !== 'string' || (p.saveSlot !== '' && !/^\d{1,12}\.sav$/i.test(p.saveSlot)))
    )
      throw new Error('默认回顾存档无效');
    if (!Array.isArray(p.goals) || p.goals.length > 300) throw new Error('待办数量已达上限');
    const goalIds = new Set();
    for (const g of p.goals) {
      if (typeof g.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(g.id) || goalIds.has(g.id))
        throw new Error('待办编号无效');
      goalIds.add(g.id);
      text(g.title, 200);
      text(g.detail, 2000);
      if (!g.title.trim() || typeof g.done !== 'boolean') throw new Error('待办无效');
      if (g.pinned !== undefined && typeof g.pinned !== 'boolean') throw Error('目标置顶无效');
      if (g.placeId !== undefined && (typeof g.placeId !== 'string' || !placeIds.has(g.placeId)))
        throw Error('目标地点无效，请明确选择资料中的场景');
      if (
        g.placeId !== undefined &&
        (['quest', 'planner'].includes(g.source?.type) ||
          (g.source?.type === 'database' && ['物品', '配方'].includes(databaseKinds.get(g.source.id))))
      )
        throw Error('这类资料目标沿用原资料的行程地点');
      if (
        g.progressMode !== undefined &&
        (!['auto', 'manual'].includes(g.progressMode) || g.source?.type !== 'quest')
      )
        throw Error('任务目标跟踪方式无效');
      validateGoalSource(g.source, ids, p.craftPlans);
    }
  }
  if (!seen.has(s.activeProfileId)) throw new Error('当前周目不存在');
  if (
    !s.settings ||
    !['hints', 'details'].includes(s.settings.spoiler) ||
    typeof s.settings.autoBackup !== 'boolean'
  )
    throw new Error('设置无效');
  text(s.settings.savePath, 1000);
  text(s.settings.steamPath, 1000);
  if (s.settings.shortcuts !== undefined) require('./shortcuts.cjs').validate(s.settings.shortcuts);
  if (s.settings.saveFeedback !== undefined && typeof s.settings.saveFeedback !== 'boolean')
    throw Error('保存反馈设置无效');
  if (s.settings.offerAutoSaveOnStart !== undefined && typeof s.settings.offerAutoSaveOnStart !== 'boolean')
    throw Error('开始游戏偏好无效');
  if (s.settings.companionEnabled !== undefined && typeof s.settings.companionEnabled !== 'boolean')
    throw Error('随行提示设置无效');
  if (
    s.settings.companionPosition !== undefined &&
    !['top-right', 'bottom-right', 'top-left', 'bottom-left'].includes(s.settings.companionPosition)
  )
    throw Error('随行提示位置无效');
  if (
    s.settings.compactOpacity !== undefined &&
    (!Number.isFinite(s.settings.compactOpacity) ||
      s.settings.compactOpacity < 0.65 ||
      s.settings.compactOpacity > 1)
  )
    throw Error('随行提示透明度无效');
  // Use the same byte ceiling for stored state, exports and imports. Otherwise
  // a valid multi-profile journal could export a file that cannot be imported.
  if (Buffer.byteLength(JSON.stringify(s, null, 2), 'utf8') > MAX_JOURNAL_BYTES)
    throw new Error('全部周目的手札记录已超过 32 MB，请先导出并精简记录后重试');
  return s;
}
function atomicWrite(file, value, preservePrevious = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!preservePrevious && fs.existsSync(file)) fs.copyFileSync(file, `${file}.previous`);
  // Windows handles can briefly deny replacement. Retry the same atomic move,
  // keeping both the old file and its previous copy intact until it succeeds.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      break;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 6)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
class JournalRecoveryRequired extends Error {
  constructor(dir) {
    super('手札数据无法读取，需要选择已导出的备份恢复；当前文件和上一份记录均原样保留。');
    this.code = 'JOURNAL_RECOVERY_REQUIRED';
    this.directory = dir;
  }
}
class Store {
  constructor(dir, catalog) {
    this.dir = dir;
    this.file = path.join(dir, 'journal.json');
    this.ids = new Set(catalog.entries.map((e) => e.id));
    this.catalog = catalog;
    this.warning = '';
    const resolved = path.resolve(dir),
      parsed = path.parse(resolved);
    let ancestor = parsed.root;
    for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      let stat;
      try {
        stat = fs.lstatSync(ancestor);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('手札目录不能使用链接或外部重定向，原件已保留');
    }
    fs.mkdirSync(dir, { recursive: true });
    // Recovery must never follow a linked journal into an external write.
    for (const file of [this.file, `${this.file}.previous`]) {
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('手札数据不能使用链接文件或目录，原件已保留');
    }
    if (fs.existsSync(this.file) || fs.existsSync(`${this.file}.previous`)) {
      try {
        this.state = validateState(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.ids);
      } catch {
        try {
          this.state = validateState(JSON.parse(fs.readFileSync(`${this.file}.previous`, 'utf8')), this.ids);
          this.warning = '上次数据文件异常，已恢复上一份记录；异常原文件已保留。';
        } catch {
          // Startup recovery owns the explicit replacement. In particular, no
          // defaults or extra damaged copies are written merely by opening it.
          throw new JournalRecoveryRequired(dir);
        }
        if (fs.existsSync(this.file)) {
          const retained = path.join(dir, `journal-damaged-${Date.now()}-${crypto.randomUUID()}.json`);
          fs.copyFileSync(this.file, retained, fs.constants.COPYFILE_EXCL);
        }
      }
    } else this.state = defaults();
    atomicWrite(this.file, this.state, !!this.warning);
  }
  get() {
    return clone(this.state);
  }
  commit(next) {
    validateState(next, this.ids);
    next.updatedAt = now();
    atomicWrite(this.file, next);
    this.state = next;
    return this.get();
  }
  mutate(command, trustedContext = {}) {
    if (!command || typeof command.type !== 'string') throw new Error('操作无效');
    const s = this.get(),
      p = s.profiles.find((x) => x.id === (command.profileId || s.activeProfileId));
    if (!p) throw new Error('目标周目不存在');
    let consumedIntentDrafts;
    if (command.type === 'intent-draft-commit') {
      const { profileId, ...draftCommand } = command;
      const result = applyIntentDraftCommand(p, draftCommand);
      consumedIntentDrafts = result.drafts;
      command = { ...result.intent, profileId: p.id };
    }
    const previousStates = {
      goal: new Map(p.goals.map((g) => [g.id, g.done])),
      todo: new Map((p.journey?.todos || []).map((t) => [t.id, t.done])),
      gift: new Map((p.journey?.gifts || []).map((g) => [g.id, g.done])),
      'craft-plan': new Map((p.craftPlans || []).map((plan) => [plan.id, plan.done === true])),
    };
    switch (command.type) {
      case 'intent-draft-put':
      case 'intent-draft-remove':
      case 'intent-draft-rebase': {
        const { profileId, ...draftCommand } = command;
        p.intentDrafts = applyIntentDraftCommand(p, draftCommand).drafts;
        break;
      }
      case 'stage':
        if (!Number.isInteger(command.value) || command.value < 0 || command.value > 6)
          throw new Error('阶段无效');
        p.stage = command.value;
        p.stageConfirmed = true;
        break;
      case 'check':
        if (!this.ids.has(command.id) || !['done', 'skip', 'todo'].includes(command.value))
          throw new Error('清单操作无效');
        if (command.value === 'todo') delete p.checks[command.id];
        else p.checks[command.id] = command.value;
        break;
      case 'favorite':
        if (!this.ids.has(command.id)) throw new Error('条目不存在');
        p.favorites = p.favorites.includes(command.id)
          ? p.favorites.filter((x) => x !== command.id)
          : [...p.favorites, command.id];
        break;
      case 'journal-draft-put':
      case 'journal-draft-remove':
      case 'journal-draft-commit': {
        const { profileId, ...intent } = command;
        const before = p.journalEntries || [];
        const result = applyDraftCommand(p.journalDrafts || [], p.journalEntries || [], intent, {
          profile: p,
          catalog: this.catalog,
          guideIds: this.ids,
          selectedReference: trustedContext.selectedReference,
        });
        assertFreshEntryIds(before, result.entries, p.journalRevisions || [], p.journalTrash || []);
        p.journalRevisions = retainEditedRevisions(before, result.entries, p.journalRevisions || [], {
          profile: p,
          catalog: this.catalog,
          guideIds: this.ids,
        });
        p.journalDrafts = result.drafts;
        p.journalEntries = result.entries;
        break;
      }
      case 'journal-entry-put':
      case 'journal-entry-update': {
        const { profileId, ...intent } = command;
        const before = p.journalEntries || [];
        p.journalEntries = applyEntryCommand(p.journalEntries || [], intent, {
          profile: p,
          catalog: this.catalog,
          guideIds: this.ids,
          selectedReference: trustedContext.selectedReference,
        });
        assertFreshEntryIds(before, p.journalEntries, p.journalRevisions || [], p.journalTrash || []);
        p.journalRevisions = retainEditedRevisions(before, p.journalEntries, p.journalRevisions || [], {
          profile: p,
          catalog: this.catalog,
          guideIds: this.ids,
        });
        break;
      }
      case 'journal-revision-restore':
      case 'journal-revision-purge': {
        if (command.profileId !== p.id || p.id !== s.activeProfileId)
          throw Error('周目已变化，请重新核对旧版本；当前资料已保留');
        const { profileId, ...intent } = command;
        const result = applyRevisionCommand(p.journalEntries || [], p.journalRevisions || [], intent, {
          profile: p,
          catalog: this.catalog,
          guideIds: this.ids,
        });
        p.journalEntries = result.entries;
        p.journalRevisions = result.revisions;
        break;
      }
      case 'journal-entry-remove':
      case 'journal-entries-remove':
      case 'journal-trash-restore':
      case 'journal-trash-purge': {
        const { profileId, ...intent } = command;
        const result = (command.type.startsWith('journal-trash-') ? applyTrashCommand : moveEntriesToTrash)(
          p.journalEntries || [],
          p.journalTrash || [],
          intent,
          {
            profile: p,
            catalog: this.catalog,
            guideIds: this.ids,
            selectedReference: trustedContext.selectedReference,
          },
        );
        p.journalEntries = result.entries;
        p.journalTrash = result.trash;
        break;
      }
      case 'note':
        text(command.value, 20000);
        if (p.notes !== command.value && p.notes.trim())
          p.noteRevisions = retainNote(p.notes, command.value, p.noteRevisions);
        p.notes = command.value;
        break;
      case 'note-restore': {
        const row = p.noteRevisions?.find((row) => row.id === command.id);
        if (!row || command.expectedValue !== p.notes)
          throw Error('随手记或旧内容已变化，请重新预览；当前文字与旧内容仍保留');
        p.noteRevisions = retainNote(p.notes, row.body, p.noteRevisions, { force: true });
        p.notes = row.body;
        break;
      }
      case 'save-slot':
        p.saveSlot = text(command.value, 20);
        p.referenceMode = command.mode || (p.saveSlot ? 'slot' : 'latest');
        break;
      case 'reserve-set': {
        const next = { ...(p.reservations || {}) };
        if (!Number.isSafeInteger(command.count) || command.count < 0 || command.count > 999999)
          throw Error('保留数量须为 0 至 999999 的整数');
        if (command.count === 0) delete next[command.id];
        else next[command.id] = command.count;
        validateReservations(next);
        p.reservations = next;
        break;
      }
      case 'craft-set': {
        const list = p.craftList || [];
        const existing = list.find((line) => line.id === command.id);
        if (existing) existing.quantity = command.quantity;
        else list.push({ id: command.id, quantity: command.quantity });
        validateCraftList(list);
        p.craftList = list;
        break;
      }
      case 'task-reserve': {
        const quest = world.quests.find((q) => q.id === command.questId);
        const material = quest?.materials?.find((m) => String(m.id) === command.itemId);
        if (!material || !Number.isSafeInteger(material.count) || material.count < 1)
          throw Error('任务用料资料不存在');
        const allocations = p.allocations || [];
        let owner = allocations.find((a) => a.questId === quest.id);
        if (!owner) {
          owner = { questId: quest.id, items: {} };
          allocations.push(owner);
        }
        owner.items[command.itemId] = material.count;
        validateAllocations(allocations, p.reservations);
        p.allocations = allocations;
        break;
      }
      case 'task-reserve-edit': {
        const owner = p.allocations?.find((a) => a.questId === command.questId);
        if (!owner || !(command.itemId in owner.items)) throw Error('任务预留不存在');
        if (!Number.isSafeInteger(command.count) || command.count < 0 || command.count > 999999)
          throw Error('保留数量须为 0 至 999999 的整数');
        if (command.count === 0) delete owner.items[command.itemId];
        else owner.items[command.itemId] = command.count;
        p.allocations = p.allocations.filter((a) => Object.keys(a.items).length);
        break;
      }
      case 'task-reserve-remove':
        p.allocations = (p.allocations || []).filter((a) => a.questId !== command.questId);
        break;
      case 'craft-remove':
        if ((p.craftList || []).some((line) => line.id === command.id)) {
          p.previousCraftList = clone(p.craftList);
          p.previousCraftChoices = clone(p.craftChoices || {});
          p.previousCraftContext = {
            reserveCraftDraft: p.reserveCraftDraft !== false,
            ...(p.activeCraftPlanId ? { activeCraftPlanId: p.activeCraftPlanId } : {}),
          };
          p.craftList = p.craftList.filter((line) => line.id !== command.id);
        }
        break;
      case 'resource-priority-set': {
        validateResourcePriority(command.order);
        if (
          !command.order ||
          typeof command.fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(command.fingerprint) ||
          trustedContext.resourcePriorityFingerprint !== command.fingerprint
        )
          throw Error('物资顺序预览已变化，请重新核对后保存');
        p.resourcePriority = [...command.order];
        break;
      }
      case 'journey-place-remove':
      case 'journey-todo-remove':
      case 'journey-gift-remove':
      case 'goal-remove':
      case 'craft-plan-remove':
      case 'journey-itinerary-remove':
      case 'journey-itinerary-clear':
      case 'journey-trash-restore':
      case 'journey-trash-copy-goal':
      case 'journey-trash-purge': {
        if (
          ['journey-itinerary-remove', 'journey-itinerary-clear'].includes(command.type) ||
          (command.type === 'journey-trash-restore' && command.expectedTrash?.kind === 'itinerary')
        ) {
          if (command.profileId !== p.id || p.id !== s.activeProfileId)
            throw Error('周目已变化，请重新核对本次行程；当前资料与完整副本均已保留');
        }
        const { profileId, ...intent } = command;
        const result = applyJourneyTrashCommand(p, intent);
        if (command.type === 'craft-plan-remove') {
          if (!p.craftPlans?.some((x) => x.id === command.id)) throw Error('制作计划不存在');
          if (p.goals.some((g) => g.source?.type === 'planner' && g.source.id === command.id))
            throw Error('这份计划仍在行囊目标中，请先移除对应目标；计划和完整内容均已保留');
          if (p.activeCraftPlanId === command.id) delete p.activeCraftPlanId;
          if (p.previousCraftContext?.activeCraftPlanId === command.id)
            delete p.previousCraftContext.activeCraftPlanId;
        }
        if (command.type === 'journey-trash-restore' && command.expectedTrash.kind === 'goal') {
          try {
            validateGoalSource(command.expectedTrash.record.source, this.ids, p.craftPlans);
          } catch (error) {
            throw Error('原目标关联的资料或备料计划已变化，暂时无法找回；完整目标仍保留。' + error.message);
          }
        }
        p.journey = result.journey;
        p.journeyTrash = result.trash;
        if (result.goals) p.goals = result.goals;
        if (result.craftPlans) p.craftPlans = result.craftPlans;
        break;
      }
      case 'journey-place-put':
      case 'journey-todo-put':
      case 'journey-gift-put':
      case 'journey-action-handle':
      case 'journey-itinerary-add':
      case 'journey-itinerary-move':
      case 'journey-itinerary-place':
      case 'journey-itinerary-continue':
      case 'journey-itinerary-name':
      case 'journey-itinerary-status':
      case 'journey-itinerary-skip': {
        const { profileId, actionIds, ...intent } = command;
        p.journey = applyJourneyCommand(p.journey || emptyJourneyState(), intent, {
          actionIds,
          actions: trustedContext.journeyActions || [],
          itinerarySteps: trustedContext.journeyItinerarySteps || [],
        });
        break;
      }
      case 'craft-goals-merge':
        p.craftList = recipeGoalList(p, p.craftList || []);
        validateCraftList(p.craftList);
        break;
      case 'craft-choice': {
        const choices = { ...(p.craftChoices || {}) };
        if (command.recipeId === '') delete choices[command.itemId];
        else choices[command.itemId] = command.recipeId;
        validateCraftChoices(choices);
        p.craftChoices = choices;
        break;
      }
      case 'craft-plan-save': {
        const name = text(command.name, 80);
        const list = clone(command.list);
        const choices = clone(command.choices ?? p.craftChoices ?? {});
        validateCraftChoices(choices);
        validateCraftList(list);
        const plans = p.craftPlans || [];
        let plan = command.id ? plans.find((x) => x.id === command.id) : null;
        if (command.id && !plan) throw Error('制作计划不存在于当前周目');
        if (command.addGoal !== undefined && typeof command.addGoal !== 'boolean')
          throw Error('制作计划目标设置无效');
        if (command.reserved !== undefined && typeof command.reserved !== 'boolean')
          throw Error('制作计划物资保留设置无效');
        if (
          plan?.done &&
          (JSON.stringify(list) !== JSON.stringify(plan.list) ||
            JSON.stringify(choices) !== JSON.stringify(plan.choices || {}))
        )
          throw Error('这份计划已制作完成，请先重新打开计划，再更新配方或次数');
        if (plan)
          Object.assign(plan, {
            name,
            list,
            choices,
            updatedAt: now(),
            ...(command.reserved !== undefined ? { reserved: command.reserved } : {}),
          });
        else {
          plan = {
            id: crypto.randomUUID(),
            name,
            list,
            choices,
            reserved: command.reserved ?? !!command.addGoal,
            createdAt: now(),
            updatedAt: now(),
          };
          plans.unshift(plan);
        }
        validateCraftPlans(plans);
        p.craftPlans = plans;
        if (trustedContext.discoveryEditingPlanId === plan.id && p.activeCraftPlanId === plan.id) {
          p.craftList = clone(list);
          p.craftChoices = clone(choices);
        }
        if (
          (!trustedContext.discoveryPlanId || p.activeCraftPlanId === plan.id) &&
          JSON.stringify(list) === JSON.stringify(p.craftList || []) &&
          JSON.stringify(choices) === JSON.stringify(p.craftChoices || {})
        ) {
          if (!p.activeCraftPlanId && p.resourcePriority?.includes('@draft'))
            p.resourcePriority = p.resourcePriority
              .map((id) => (id === '@draft' ? plan.id : id))
              .filter((id, i, all) => all.indexOf(id) === i);
          p.activeCraftPlanId = plan.id;
        }
        if (command.addGoal && !p.goals.some((g) => g.source?.type === 'planner' && g.source.id === plan.id))
          p.goals.unshift({
            id: crypto.randomUUID(),
            title: name,
            detail: '',
            done: false,
            source: { type: 'planner', id: plan.id },
            createdAt: now(),
          });
        break;
      }
      case 'craft-plan-open': {
        const plan = p.craftPlans?.find((x) => x.id === command.id);
        if (!plan) throw Error('制作计划不存在于当前周目');
        if (
          JSON.stringify([
            p.craftList || [],
            p.craftChoices || {},
            p.activeCraftPlanId,
            p.reserveCraftDraft !== false,
          ]) !== JSON.stringify([plan.list, plan.choices || {}, plan.id, plan.reserved !== false])
        ) {
          p.previousCraftList = clone(p.craftList || []);
          p.previousCraftChoices = clone(p.craftChoices || {});
          p.previousCraftContext = {
            reserveCraftDraft: p.reserveCraftDraft !== false,
            ...(p.activeCraftPlanId ? { activeCraftPlanId: p.activeCraftPlanId } : {}),
          };
          p.craftList = clone(plan.list);
        }
        p.activeCraftPlanId = plan.id;
        p.craftChoices = clone(plan.choices || {});
        p.reserveCraftDraft = plan.reserved !== false;
        break;
      }
      case 'craft-draft-restore': {
        if (!p.previousCraftList) throw Error('尚无可找回的编辑清单');
        const previous = p.previousCraftList;
        const previousChoices = p.previousCraftChoices || {};
        const previousContext = p.previousCraftContext || { reserveCraftDraft: true };
        p.previousCraftList = clone(p.craftList || []);
        p.previousCraftChoices = clone(p.craftChoices || {});
        p.previousCraftContext = {
          reserveCraftDraft: p.reserveCraftDraft !== false,
          ...(p.activeCraftPlanId ? { activeCraftPlanId: p.activeCraftPlanId } : {}),
        };
        p.craftList = clone(previous);
        p.craftChoices = clone(previousChoices);
        p.reserveCraftDraft = previousContext.reserveCraftDraft;
        if (previousContext.activeCraftPlanId) p.activeCraftPlanId = previousContext.activeCraftPlanId;
        else delete p.activeCraftPlanId;
        break;
      }
      case 'craft-plan-complete': {
        const plan = p.craftPlans?.find((x) => x.id === command.id);
        if (!plan || typeof command.value !== 'boolean') throw Error('制作计划完成设置无效');
        if (JSON.stringify(command.expectedPlan) !== JSON.stringify(plan))
          throw Error('计划内容或完成状态已变化，请重新查看后确认');
        if (
          command.value &&
          p.activeCraftPlanId === plan.id &&
          (JSON.stringify(p.craftList || []) !== JSON.stringify(plan.list) ||
            JSON.stringify(p.craftChoices || {}) !== JSON.stringify(plan.choices || {}))
        )
          throw Error('这份计划有未保存的编辑，请先更新计划或另存，再标为整份制作完成');
        // This is explicit personal intent. Preserve the recipes, reservation
        // preference and every goal's independent manual completion for undo.
        plan.done = command.value;
        plan.updatedAt = now();
        break;
      }
      case 'craft-plan-reserve': {
        const plan = p.craftPlans?.find((x) => x.id === command.id);
        if (!plan || typeof command.value !== 'boolean') throw Error('制作计划保留设置无效');
        plan.reserved = command.value;
        if (p.activeCraftPlanId === plan.id) p.reserveCraftDraft = command.value;
        break;
      }
      case 'craft-draft-reserve': {
        if (typeof command.value !== 'boolean') throw Error('编辑清单保留设置无效');
        p.reserveCraftDraft = command.value;
        const plan = p.craftPlans?.find((x) => x.id === p.activeCraftPlanId);
        if (plan) plan.reserved = command.value;
        break;
      }
      case 'goal-add': {
        if (Object.hasOwn(command, 'placeId') && typeof command.placeId !== 'string')
          throw Error('目标地点须明确选择，或以地点未定移除');
        const title = text(command.title, 200);
        if (!title) throw new Error('请填写目标');
        validateGoalSource(command.source, this.ids, p.craftPlans);
        p.goals.unshift({
          id: crypto.randomUUID(),
          title,
          detail: text(command.detail || '', 2000),
          done: false,
          createdAt: now(),
          ...(command.source ? { source: clone(command.source) } : {}),
          ...(Object.hasOwn(command, 'placeId') && command.placeId !== ''
            ? { placeId: command.placeId }
            : {}),
        });
        break;
      }
      case 'search-remember': {
        const query = text(command.query, 200);
        if (!query) throw Error('搜索内容不能为空');
        p.recentSearches = [query, ...(p.recentSearches || []).filter((q) => q !== query)].slice(0, 20);
        break;
      }
      case 'search-save': {
        const query = text(command.query, 200);
        if (!query) throw Error('搜索内容不能为空');
        p.savedSearches = [query, ...(p.savedSearches || []).filter((q) => q !== query)].slice(0, 20);
        break;
      }
      case 'search-forget':
        p.savedSearches = (p.savedSearches || []).filter((q) => q !== command.query);
        break;
      case 'search-history-clear':
        p.recentSearches = [];
        break;
      case 'goal-toggle': {
        const g = p.goals.find((x) => x.id === command.id);
        if (!g) throw new Error('待办不存在');
        g.done = !g.done;
        break;
      }
      case 'goal-tracking': {
        const g = p.goals.find((x) => x.id === command.id);
        if (!g || g.source?.type !== 'quest') throw Error('任务目标不存在');
        if (!['auto', 'manual'].includes(command.mode)) throw Error('任务目标跟踪方式无效');
        if (command.reopen !== undefined && typeof command.reopen !== 'boolean')
          throw Error('目标完成状态无效');
        g.progressMode = command.mode;
        if (command.reopen === true) g.done = false;
        break;
      }
      case 'goal-pin': {
        const g = p.goals.find((x) => x.id === command.id);
        if (!g) throw Error('待办不存在');
        g.pinned = !g.pinned;
        break;
      }
      case 'goal-edit': {
        if (Object.hasOwn(command, 'placeId') && typeof command.placeId !== 'string')
          throw Error('目标地点须明确选择，或以地点未定移除');
        const g = p.goals.find((x) => x.id === command.id);
        if (!g) throw new Error('待办不存在');
        g.title = text(command.title, 200);
        g.detail = text(command.detail || '', 2000);
        if (Object.hasOwn(command, 'placeId')) {
          if (command.placeId === '') delete g.placeId;
          else g.placeId = command.placeId;
        }
        break;
      }
      case 'profile-add': {
        const name = text(command.name, 40);
        if (!name) throw new Error('请填写周目名称');
        const profile = createProfile(name);
        profile.saveSlot = text(command.saveSlot || '', 20);
        profile.referenceMode = command.mode || 'none';
        s.profiles.push(profile);
        s.activeProfileId = profile.id;
        break;
      }
      case 'profile-rename':
        p.name = text(command.name, 40);
        break;
      case 'profile-switch':
        if (!s.profiles.some((x) => x.id === command.id)) throw new Error('周目不存在');
        s.activeProfileId = command.id;
        break;
      case 'settings': {
        const values = command.value;
        if (!values || typeof values !== 'object') throw new Error('设置无效');
        for (const key of Object.keys(values)) {
          if (
            ![
              'spoiler',
              'autoBackup',
              'saveFeedback',
              'offerAutoSaveOnStart',
              'companionEnabled',
              'companionPosition',
              'compactOpacity',
            ].includes(key)
          )
            throw new Error('不支持的设置');
          s.settings[key] = values[key];
        }
        break;
      }
      default:
        throw new Error('不支持的操作');
    }
    const currentRows = {
      goal: p.goals,
      todo: p.journey?.todos || [],
      gift: p.journey?.gifts || [],
      'craft-plan': p.craftPlans || [],
    };
    for (const [type, before] of Object.entries(previousStates)) {
      const rows = currentRows[type],
        ids = new Set(rows.map((row) => row.id));
      for (const id of before.keys()) {
        if (ids.has(id)) continue;
        if (p.journalEntries) p.journalEntries = detachLinks(p.journalEntries, type, id);
        if (p.journalDrafts) p.journalDrafts = detachLinks(p.journalDrafts, type, id);
        if (p.journalTrash) p.journalTrash = detachTrashLinks(p.journalTrash, type, id);
        if (p.journalRevisions) p.journalRevisions = detachRevisionLinks(p.journalRevisions, type, id);
      }
    }
    for (const type of ['goal', 'todo', 'gift', 'craft-plan']) {
      const before = previousStates[type];
      for (const row of currentRows[type]) {
        const afterDone = row.done === true;
        if (before.has(row.id) && before.get(row.id) !== afterDone)
          p.journalEntries = appendSystemEvent(
            p.journalEntries || [],
            { type, id: row.id, beforeDone: before.get(row.id), afterDone },
            { profile: p, catalog: this.catalog, guideIds: this.ids },
          );
      }
    }
    if (consumedIntentDrafts) p.intentDrafts = consumedIntentDrafts;
    p.updatedAt = now();
    return this.commit(s);
  }
  setPath(key, value) {
    if (!['savePath', 'steamPath'].includes(key)) throw new Error('路径类型无效');
    const s = this.get();
    if (key === 'savePath' && s.settings.savePath !== value)
      for (const profile of s.profiles) {
        profile.saveSlot = '';
        if (profile.referenceMode !== 'none') profile.referenceMode = 'latest';
      }
    s.settings[key] = text(value, 1000);
    return this.commit(s);
  }
  setShortcuts(value) {
    const s = this.get();
    s.settings.shortcuts = require('./shortcuts.cjs').validate(value);
    return this.commit(s);
  }
  importData(data) {
    const incoming = validateState(clone(data), this.ids);
    // Import journal contents only. Machine-specific paths and auto-backup settings stay local.
    incoming.settings = this.get().settings;
    for (const profile of incoming.profiles) {
      profile.saveSlot = '';
      if (profile.referenceMode !== 'none') profile.referenceMode = 'latest';
    }
    const backup = path.join(this.dir, `journal-before-import-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify(this.state, null, 2), { encoding: 'utf8', flag: 'wx' });
    return this.commit(incoming);
  }
}
module.exports = {
  Store,
  JournalRecoveryRequired,
  defaults,
  validateState,
  atomicWrite,
  text,
  MAX_JOURNAL_BYTES,
};
