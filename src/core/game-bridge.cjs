'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { realDirectory, sha } = require('./saves.cjs');
const { readStable, writeBytes, safeId, SLOT } = require('./timeline.cjs');
const provenance = require('../game-bridge/provenance.json');
const resources = path.join(__dirname, '..', 'game-bridge');
const slash = (p) => p.replaceAll('\\', '/');
const same = (a, b) => slash(a).toLowerCase() === slash(b).toLowerCase();
const json = (file) => JSON.parse(readStable(file).toString('utf8'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function activeSteamId() {
  const out = execFileSync(
    'reg.exe',
    ['query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess', '/v', 'ActiveUser'],
    { encoding: 'utf8', windowsHide: true, timeout: 3000 },
  );
  const match = out.match(/ActiveUser\s+REG_DWORD\s+(0x[a-f0-9]+)/i);
  if (!match || BigInt(match[1]) === 0n) throw Error('无法确认当前 Steam 账户，请先登录 Steam');
  return String(76561197960265728n + BigInt(match[1]));
}
class GameBridge {
  constructor(
    root,
    timeline,
    {
      getGame,
      stopped,
      blocked = () => false,
      notify = () => {},
      account = activeSteamId,
      now = Date.now,
      test = false,
    } = {},
  ) {
    fs.mkdirSync(root, { recursive: true });
    this.root = realDirectory(root);
    fs.mkdirSync(path.join(this.root, 'receipts'), { recursive: true });
    realDirectory(path.join(this.root, 'receipts'));
    this.timeline = timeline;
    this.getGame = getGame;
    this.stopped = stopped;
    this.blocked = blocked;
    this.notify = notify;
    this.account = account;
    this.now = now;
    this.test = test;
    this.busy = false;
    this.loadQueued = false;
    this.error = '';
    this.nextSaveAt = 0;
    this.hashCache = new Map();
    this.disposed = false;
    this.quiescing = false;
    this.revision = sha(fs.readFileSync(path.join(resources, 'main.lua')));
    const keyFile = path.join(this.root, 'token.txt');
    if (fs.existsSync(keyFile)) this.token = readStable(keyFile).toString('utf8');
    else {
      this.token = crypto.randomBytes(32).toString('hex');
      writeBytes(keyFile, Buffer.from(this.token));
    }
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw Error('游戏接入密钥损坏，原文件已保留');
    if (timeline.data.source && !test) {
      try {
        this.connect(timeline.data.source);
      } catch (e) {
        this.error = e.message;
        try {
          timeline.stop();
        } catch {}
      }
    }
  }
  checkedHash(file) {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw Error('游戏接入文件异常');
    const stamp = [s.size, s.mtimeNs, s.ctimeNs, s.ino].join(':');
    const cached = this.hashCache.get(file);
    if (cached?.stamp === stamp) return cached.hash;
    // Native executables exceed the save-file limit; they are read only here.
    const hash = sha(fs.readFileSync(file)),
      after = fs.lstatSync(file, { bigint: true });
    if (stamp !== [after.size, after.mtimeNs, after.ctimeNs, after.ino].join(':'))
      throw Error('游戏接入文件正在变化');
    this.hashCache.set(file, { stamp, hash });
    return hash;
  }
  location() {
    if (this.test) throw Error('测试环境不接入实际游戏');
    const game = this.getGame();
    if (!game?.installed || game.build !== provenance.gameBuild)
      throw Error('原生存读档只支持已验证的游戏 Build ' + provenance.gameBuild + '；更新后请先停用接入组件');
    const bin = realDirectory(path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64'));
    if (this.checkedHash(path.join(bin, 'JH-Win64-Shipping.exe')) !== provenance.gameExeSha256)
      throw Error('游戏程序与已验证版本不一致，已停止接入');
    return bin;
  }
  heartbeat() {
    try {
      const s = json(path.join(this.root, 'state.json')),
        age = this.now() / 1000 - s.at;
      if (
        s.protocol !== 1 ||
        !Number.isSafeInteger(s.at) ||
        age < -2 ||
        age > 3 ||
        typeof s.ready !== 'boolean' ||
        !/^\d+-\d+$/.test(s.session)
      )
        return null;
      return s;
    } catch {
      return null;
    }
  }
  connected() {
    const s = this.heartbeat();
    return !!s && s.token === this.token;
  }
  canStop() {
    return !this.busy && !this.heartbeat() && this.stopped();
  }
  installation() {
    try {
      const bin = this.location(),
        marker = path.join(bin, '.yijian-component.json');
      if (!fs.existsSync(marker)) return { installed: false, reason: '尚未安装游戏接入组件' };
      const m = json(marker);
      if (
        m.schema !== 1 ||
        !['YijianJournalBridge', 'YijianSaveProbe'].includes(m.mod) ||
        !same(m.root, this.root)
      )
        throw Error('已有组件属于其他数据目录，请使用原来的手札');
      for (const [name, hash] of Object.entries(provenance.files))
        if (this.checkedHash(path.join(bin, name)) !== hash) throw Error('游戏接入组件校验失败');
      return { installed: true, mod: m.mod, bin };
    } catch (e) {
      return { installed: false, reason: e.message };
    }
  }
  install() {
    if (this.busy || !this.canStop()) throw Error('请先退出游戏，再安装或更新接入组件');
    const bin = this.location(),
      marker = path.join(bin, '.yijian-component.json');
    let mod = 'YijianJournalBridge';
    if (fs.existsSync(marker)) {
      const existing = json(marker);
      if (
        existing.schema !== 1 ||
        !same(existing.root, this.root) ||
        !['YijianJournalBridge', 'YijianSaveProbe'].includes(existing.mod)
      )
        throw Error('已有组件不属于当前手札');
      mod = existing.mod;
    } else if (
      fs.existsSync(path.join(bin, 'dwmapi.dll')) ||
      (fs.existsSync(path.join(bin, 'ue4ss')) &&
        fs.readdirSync(realDirectory(path.join(bin, 'ue4ss'))).some((name) => name !== 'YijianJournal'))
    )
      throw Error('已有其他游戏接入文件，已保留原组件；不能自动覆盖');
    for (const [name, hash] of Object.entries(provenance.files)) {
      const bytes = fs.readFileSync(path.join(resources, 'runtime', name));
      if (sha(bytes) !== hash) throw Error('内置组件校验失败');
      const target = path.join(bin, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      realDirectory(path.dirname(target));
      if (!fs.existsSync(target)) writeBytes(target, bytes);
      else if (this.checkedHash(target) !== hash) throw Error('已有组件发生了变化，已停止安装');
    }
    const ue = realDirectory(path.join(bin, 'ue4ss')),
      mods = path.join(ue, 'Mods');
    fs.mkdirSync(mods, { recursive: true });
    realDirectory(mods);
    const scripts = path.join(mods, mod, 'Scripts');
    fs.mkdirSync(scripts, { recursive: true });
    realDirectory(path.dirname(scripts));
    realDirectory(scripts);
    if (/[\r\n\x00]/.test(this.root)) throw Error('手札目录包含不支持的字符');
    const literal = JSON.stringify(slash(this.root) + '/');
    const lua = fs
      .readFileSync(path.join(resources, 'main.lua'), 'utf8')
      .replace('__JOURNAL_ROOT__', literal)
      .replace('__JOURNAL_REVISION__', JSON.stringify(this.revision));
    writeBytes(path.join(scripts, 'main.lua'), Buffer.from(lua));
    writeBytes(
      path.join(ue, 'LICENSE'),
      fs.readFileSync(path.join(resources, 'runtime', 'ue4ss', 'LICENSE')),
    );
    const control = path.join(mods, 'yijian-mods.txt');
    writeBytes(control, Buffer.from(mod + ' : 1\n'));
    let settings = fs.readFileSync(path.join(resources, 'runtime', 'ue4ss', 'UE4SS-settings.ini'), 'utf8');
    const values = {
      MajorVersion: '4',
      MinorVersion: '26',
      ConsoleEnabled: '0',
      GuiConsoleEnabled: '0',
      GuiConsoleVisible: '0',
      bUseUObjectArrayCache: 'false',
      EnableHotReloadSystem: '0',
      EnableAutoReloadingLuaMods: '0',
      ControllingModsTxt: slash(control),
    };
    for (const [key, value] of Object.entries(values)) {
      const regex = new RegExp('^' + key + '\\s*=.*$', 'm');
      if (!regex.test(settings)) throw Error('组件设置项缺失：' + key);
      settings = settings.replace(regex, key + ' = ' + value);
    }
    writeBytes(path.join(ue, 'UE4SS-settings.ini'), Buffer.from(settings));
    writeBytes(
      marker,
      Buffer.from(
        JSON.stringify(
          {
            schema: 1,
            mod,
            root: this.root,
            version: provenance.version,
            installedAt: new Date(this.now()).toISOString(),
          },
          null,
          2,
        ),
      ),
    );
    this.hashCache.clear();
    return this.installation();
  }
  disable() {
    if (this.busy || this.loadQueued || !this.canStop()) throw Error('请先退出游戏，再停用接入组件');
    // This remains available after a game update; only our verified proxy is renamed.
    const game = this.getGame(),
      bin = realDirectory(path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64'));
    const marker = json(path.join(bin, '.yijian-component.json'));
    if (!same(marker.root, this.root)) throw Error('组件不属于当前手札');
    const file = path.join(bin, 'dwmapi.dll');
    if (this.checkedHash(file) !== provenance.files['dwmapi.dll'])
      throw Error('接入组件已变化，不能自动停用');
    const destination = file + '.yijian-disabled';
    if (fs.existsSync(destination)) throw Error('已有停用副本，请先核对组件目录');
    this.timeline.stop();
    fs.renameSync(file, destination);
    return true;
  }
  connect(source) {
    const directory = realDirectory(source);
    if (
      /[\x00-\x1f]/.test(directory) ||
      !/^\d+$/.test(path.basename(path.dirname(directory))) ||
      path.basename(directory) !== 'SaveGames'
    )
      throw Error('请选择 Steam 账户下的 SaveGames 目录');
    writeBytes(path.join(this.root, 'config.txt'), Buffer.from(this.token + '\n' + slash(directory) + '\n'));
  }
  assertReady() {
    if (this.disposed || this.blocked()) throw Error('请先完成未处理的完整存档恢复');
    const installed = this.installation();
    if (!installed.installed) throw Error(installed.reason);
    const source = this.timeline.data.source;
    if (path.basename(path.dirname(source)) !== this.account())
      throw Error('存档目录与当前 Steam 账户不一致，已停止存读档');
    const s = this.heartbeat();
    if (!s || s.token !== this.token || s.revision !== this.revision) {
      const e = Error('等待游戏连接，请重启游戏并进入存档');
      e.waiting = true;
      throw e;
    }
    if (!same(s.source || '', source)) throw Error('游戏连接的存档目录与手札不一致');
    if (!s.ready) {
      const e = Error(s.reason || '游戏暂时不能保存');
      e.skipped = true;
      throw e;
    }
    return s;
  }
  async request(id, verb, expected) {
    let s;
    try {
      s = this.assertReady();
      if (expected) writeBytes(path.join(this.root, 'expected.sav'), expected);
    } catch (e) {
      // No command can have reached the game yet. In particular, an in-place
      // heartbeat refresh may briefly be unreadable between the two guards.
      e.notDispatched = true;
      throw e;
    }
    const command = `${this.token}\t${s.session}\t${id}\t${verb}\t${Math.floor(this.now() / 1000) + 8}\t${expected ? 'owned' : 'empty'}\n`;
    writeBytes(path.join(this.root, 'command.txt'), Buffer.from(command));
    const deadline = performance.now() + (verb === 'load' ? 31000 : 14000);
    while (!this.disposed && performance.now() < deadline) {
      try {
        const r = json(path.join(this.root, 'response.json'));
        if (
          r.id === id &&
          r.token === this.token &&
          r.session === s.session &&
          Number.isSafeInteger(r.at) &&
          r.at * 1000 >= this.now() - 35000 &&
          r.at * 1000 <= this.now() + 2000
        ) {
          if ((verb === 'save' && r.status === 'saved') || (verb === 'load' && r.status === 'loaded'))
            return r;
          const e = Error(r.reason || '游戏没有完成操作');
          e.native = true;
          e.skipped = r.status === 'skipped';
          e.definite = ['skipped', 'rejected'].includes(r.status);
          throw e;
        }
      } catch (e) {
        if (e.native) throw e;
      }
      await delay(150);
    }
    throw Error('游戏接入超时，已停止操作并保留副本；请核对中断记录');
  }
  async saveUnlocked(kind) {
    const started = this.now();
    try {
      this.assertReady();
    } catch (e) {
      // This first guard precedes both durable intent and native dispatch.
      // A heartbeat refresh here must wait/retry just like the request guard.
      e.notDispatched = true;
      throw e;
    }
    const id = crypto.randomUUID(),
      expected = this.timeline.beginSave(id, kind);
    try {
      await this.request(id, 'save', expected);
      const receipt = readStable(path.join(this.root, 'receipts', id + '.sav'));
      const result = this.timeline.finishSave(id, receipt);
      fs.unlinkSync(path.join(this.root, 'receipts', id + '.sav'));
      this.error = '';
      this.nextSaveAt = Math.max(started + this.timeline.data.interval * 1000, this.now());
      return result;
    } catch (e) {
      if (e.definite || e.skipped || e.notDispatched) this.timeline.cancelUnwritten(id);
      throw e;
    }
  }
  async save(kind = 'manual') {
    if (this.quiescing || this.disposed) throw Error('手札正在退出，请等待当前操作完成');
    if (this.busy || this.loadQueued) throw Error('正在完成上一次存读档');
    this.busy = true;
    try {
      return await this.saveUnlocked(kind);
    } catch (e) {
      if (!e.skipped && !(e.waiting && e.notDispatched)) this.fail(e);
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async loadConfirmed(id, protect, timeoutMs = 32000) {
    if (this.quiescing || this.disposed) throw Error('手札正在退出，请等待当前操作完成');
    if (this.loadQueued) throw Error('正在完成上一次存读档');
    const release = this.timeline.pin(id);
    this.loadQueued = true;
    const deadline = performance.now() + timeoutMs;
    try {
      while (this.busy) {
        if (this.quiescing || this.disposed) throw Error('手札正在退出，已取消等候读档');
        if (performance.now() >= deadline) throw Error('当前存读档仍未结束，请稍后重试读档');
        await delay(50);
      }
      // load performs fresh account/readiness/ownership checks and the full protection sequence.
      return await this.#loadUnlocked(id, protect);
    } finally {
      this.loadQueued = false;
      release();
    }
  }
  async load(id, protect) {
    if (this.loadQueued) throw Error('正在完成上一次存读档');
    return this.#loadUnlocked(id, protect);
  }
  async #loadUnlocked(id, protect) {
    if (this.quiescing || this.disposed) throw Error('手札正在退出，请等待当前操作完成');
    if (!safeId(id)) throw Error('历史节点编号无效');
    if (this.busy) throw Error('正在完成上一次存读档');
    const unpin = this.timeline.pin(id);
    this.busy = true;
    try {
      this.timeline.inspect(id);
      this.assertReady();
      const current = await this.saveUnlocked('before-load');
      const backup = protect();
      this.assertReady();
      const staged = this.timeline.stage(id),
        requestId = crypto.randomUUID();
      const expected = readStable(this.timeline.assertOwned());
      this.timeline.commit({
        ...this.timeline.data,
        pending: {
          type: 'load',
          id: requestId,
          beforeHash: this.timeline.data.ownerHash,
          targetHash: staged.record.hash,
          at: this.now(),
        },
      });
      await this.request(requestId, 'load', expected);
      this.timeline.commit({ ...this.timeline.data, pending: null });
      this.error = '';
      this.nextSaveAt = this.now() + this.timeline.data.interval * 1000;
      return { currentId: current.id, backupId: backup.id, record: staged.record };
    } catch (e) {
      if (!e.skipped && !(e.waiting && !this.timeline.data.pending)) this.fail(e);
      throw e;
    } finally {
      unpin();
      this.busy = false;
    }
  }
  recover() {
    if (this.busy || this.loadQueued) throw Error('存读档仍在进行');
    const p = this.timeline.data.pending;
    if (!p) throw Error('没有待核对的时间线操作');
    if (this.now() - p.at < 32000) throw Error('游戏请求尚未完全过期，请稍后再核对');
    if (p.type === 'save') {
      const file = path.join(this.root, 'receipts', p.id + '.sav');
      let receipt;
      try {
        const ack = json(path.join(this.root, 'response.json'));
        if (ack.id === p.id && ack.token === this.token && ack.status === 'saved') receipt = readStable(file);
      } catch {}
      if (receipt) {
        this.timeline.finishSave(p.id, receipt);
        fs.unlinkSync(file);
      } else this.timeline.cancelUnwritten(p.id);
    } else this.timeline.reconcileStage();
    this.timeline.stop();
    this.error = '';
    return this.summary();
  }
  fail(e) {
    this.error = e.message;
    try {
      this.timeline.stop();
    } catch {}
    this.notify({ type: 'error', text: '时间线已停止：' + e.message });
  }
  start() {
    if (!this.timer && !this.test) this.timer = setInterval(() => this.check(), 250);
  }
  async check() {
    if (
      this.busy ||
      this.loadQueued ||
      this.disposed ||
      this.quiescing ||
      !this.timeline.data.enabled ||
      this.now() < this.nextSaveAt ||
      this.timeline.data.pending
    )
      return;
    const pulse = this.heartbeat();
    if (!pulse || !pulse.ready) return;
    try {
      this.assertReady();
    } catch (e) {
      if (!e.skipped && !e.waiting) this.fail(e);
      return;
    }
    try {
      await this.save('auto');
      this.notify({ type: 'timeline', text: '' });
    } catch {}
  }
  summary() {
    const installed = this.installation(),
      s = this.heartbeat();
    let unavailable = this.disposed || this.blocked() ? '请先完成未处理的完整存档恢复' : '';
    if (installed.installed && !unavailable) {
      if (!this.statusAccount || this.now() - this.statusAccount.at >= 5000) {
        try {
          this.statusAccount = { at: this.now(), account: this.account() };
        } catch (e) {
          this.statusAccount = { at: this.now(), error: e.message };
        }
      }
      unavailable =
        this.statusAccount.error ||
        (path.basename(path.dirname(this.timeline.data.source)) !== this.statusAccount.account
          ? '存档目录与当前 Steam 账户不一致，已停止存读档'
          : '');
    }
    const connected =
      !!s &&
      s.token === this.token &&
      s.revision === this.revision &&
      same(s.source || '', this.timeline.data.source);
    return {
      ...this.timeline.summary(),
      installed: installed.installed,
      connected,
      ready: installed.installed && !unavailable && connected && !!s.ready,
      busy: this.busy || this.loadQueued,
      quiescing: this.quiescing,
      reason:
        this.error ||
        (!installed.installed
          ? installed.reason
          : unavailable
            ? unavailable
            : connected
              ? s.reason || '游戏已连接，可保存进度'
              : '等待游戏连接，请重启游戏并进入存档'),
      error: this.error || this.timeline.error,
      componentVersion: provenance.version,
    };
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }
  async quiesce(timeoutMs = 60000) {
    this.quiescing = true;
    const deadline = performance.now() + timeoutMs;
    while (this.busy || this.loadQueued) {
      if (performance.now() >= deadline) throw Error('存读档仍未结束，已取消退出；请核对当前操作');
      await delay(50);
    }
  }
}
module.exports = { GameBridge, activeSteamId };
