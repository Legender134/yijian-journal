'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const { validateCraftList } = require('./material-plan.cjs');
const { validateReservations } = require('./reservations.cjs');
const world = require('../data/world-index.json');
const questIds = new Set(world.quests.map((q) => q.id));

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
  return {
    schema: 1,
    activeProfileId: profile.id,
    profiles: [profile],
    settings: { spoiler: 'hints', autoBackup: false, savePath: '', steamPath: '', compactOpacity: 0.96 },
    updatedAt: now(),
  };
}
function validateGoalSource(source, ids) {
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
    if (source.id !== 'current' || source.quantity !== undefined) throw new Error('待办备料引用无效');
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
    if (p.craftList !== undefined) validateCraftList(p.craftList);
    if (p.reservations !== undefined) validateReservations(p.reservations);
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
      validateGoalSource(g.source, ids);
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
  fs.renameSync(temp, file);
}
class Store {
  constructor(dir, catalog) {
    this.dir = dir;
    this.file = path.join(dir, 'journal.json');
    this.ids = new Set(catalog.entries.map((e) => e.id));
    this.warning = '';
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.state = validateState(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.ids);
      } catch {
        const retained = path.join(dir, `journal-damaged-${Date.now()}.json`);
        fs.copyFileSync(this.file, retained);
        try {
          this.state = validateState(JSON.parse(fs.readFileSync(`${this.file}.previous`, 'utf8')), this.ids);
          this.warning = '上次数据文件异常，已恢复上一份记录；异常原文件已保留。';
        } catch {
          throw new Error(`手札数据无法读取，已保留原文件：${retained}。请从导出的备份恢复，或联系开发者。`);
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
  mutate(command) {
    if (!command || typeof command.type !== 'string') throw new Error('操作无效');
    const s = this.get(),
      p = s.profiles.find((x) => x.id === (command.profileId || s.activeProfileId));
    if (!p) throw new Error('目标周目不存在');
    switch (command.type) {
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
      case 'note':
        text(command.value, 20000);
        p.notes = command.value;
        break;
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
      case 'craft-remove':
        p.craftList = (p.craftList || []).filter((line) => line.id !== command.id);
        break;
      case 'goal-add': {
        const title = text(command.title, 200);
        if (!title) throw new Error('请填写目标');
        validateGoalSource(command.source, this.ids);
        p.goals.unshift({
          id: crypto.randomUUID(),
          title,
          detail: text(command.detail || '', 2000),
          done: false,
          createdAt: now(),
          ...(command.source ? { source: clone(command.source) } : {}),
        });
        break;
      }
      case 'goal-toggle': {
        const g = p.goals.find((x) => x.id === command.id);
        if (!g) throw new Error('待办不存在');
        g.done = !g.done;
        break;
      }
      case 'goal-pin': {
        const g = p.goals.find((x) => x.id === command.id);
        if (!g) throw Error('待办不存在');
        g.pinned = !g.pinned;
        break;
      }
      case 'goal-edit': {
        const g = p.goals.find((x) => x.id === command.id);
        if (!g) throw new Error('待办不存在');
        g.title = text(command.title, 200);
        g.detail = text(command.detail || '', 2000);
        break;
      }
      case 'goal-remove':
        p.goals = p.goals.filter((x) => x.id !== command.id);
        break;
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
          if (!['spoiler', 'autoBackup', 'saveFeedback'].includes(key)) throw new Error('不支持的设置');
          s.settings[key] = values[key];
        }
        break;
      }
      default:
        throw new Error('不支持的操作');
    }
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
module.exports = { Store, defaults, validateState, atomicWrite, text, MAX_JOURNAL_BYTES };
