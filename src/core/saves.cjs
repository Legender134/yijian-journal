'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readMetadata } = require('./save-reader.cjs');
const { enrich } = require('./game-data.cjs');
const { compareRecords } = require('./save-comparison.cjs');
const { atomicWrite } = require('./store.cjs');
const MAX_TOTAL = 256 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const normalize = (p) => path.resolve(p).toLowerCase();
const isWithin = (child, parent) =>
  normalize(child) === normalize(parent) || normalize(child).startsWith(normalize(parent) + path.sep);
const validId = (id) => typeof id === 'string' && /^[0-9T-]+_[a-f0-9-]{36}$/.test(id);
const validName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length < 256 &&
  name === path.basename(name) &&
  !/[\\/:\x00-\x1f]/.test(name) &&
  name !== '.' &&
  name !== '..' &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
function durableWrite(file, bytes) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function realDirectory(p) {
  if (!p || !fs.existsSync(p)) throw new Error('尚未找到存档目录，请在设置中选择 SaveGames 文件夹');
  const stat = fs.lstatSync(p);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择真实的存档文件夹，不支持链接目录');
  return fs.realpathSync(p);
}
function listFiles(root) {
  const names = fs.readdirSync(root).sort();
  let total = 0;
  const files = [];
  for (const name of names) {
    const file = path.join(root, name),
      stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('存档目录包含链接文件，已停止操作');
    if (!stat.isFile()) continue;
    if (name.startsWith('.yijian-')) continue;
    if (stat.size > 32 * 1024 * 1024 || (total += stat.size) > MAX_TOTAL || files.length >= 1000)
      throw new Error('存档目录大小异常，请确认选中了游戏 SaveGames 文件夹');
    files.push({ name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  if (!files.some((f) => /\.sav$/i.test(f.name))) throw new Error('所选目录没有 .sav 存档文件');
  return files;
}
class Saves {
  constructor(backupRoot) {
    fs.mkdirSync(backupRoot, { recursive: true });
    this.root = realDirectory(backupRoot);
    this.busy = false;
    this.cache = new Map();
    this.detailCache = new Map();
    this.operationFile = path.join(this.root, '.restore-operation.json');
  }
  scan(source) {
    if (!source) return { path: '', files: [], total: 0, error: '' };
    try {
      const root = realDirectory(source),
        files = listFiles(root);
      const active = new Set();
      const scanned = files.map((file) => {
        if (!/^(\d+)\.sav$/i.test(file.name)) return { ...file, metadata: null };
        const key = path.join(root, file.name),
          stat = fs.statSync(key),
          stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        active.add(key);
        let cached = this.cache.get(key);
        if (!cached || cached.stamp !== stamp) {
          const buffer = fs.readFileSync(key);
          cached = { stamp, hash: sha(buffer), metadata: enrich(readMetadata(buffer)) };
          this.cache.set(key, cached);
        }
        return { ...file, hash: cached.hash, metadata: cached.metadata };
      });
      for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
      return {
        path: root,
        files: scanned.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
        total: files.reduce((sum, f) => sum + f.bytes, 0),
        error: '',
      };
    } catch (e) {
      return { path: source, files: [], total: 0, error: e.message };
    }
  }
  details(source, name) {
    if (typeof name !== 'string' || !/^\d+\.sav$/i.test(name)) throw Error('请选择一个游戏存档槽位');
    const root = realDirectory(source),
      files = listFiles(root),
      file = files.find((f) => f.name === name);
    if (!file) throw Error('这个存档已不存在，请刷新列表');
    const fullPath = path.join(root, name),
      stat = fs.lstatSync(fullPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32n * 1024n * 1024n)
      throw Error('所选存档文件异常，请刷新后重新选择');
    const buffer = fs.readFileSync(fullPath),
      after = fs.lstatSync(fullPath, { bigint: true });
    if (
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.ctimeNs !== after.ctimeNs ||
      stat.ino !== after.ino ||
      BigInt(buffer.length) !== after.size
    )
      throw Error('存档在读取期间发生变化，请稍等后重新读取');
    const stamp = sha(buffer);
    let cached = this.detailCache.get(fullPath);
    if (!cached || cached.stamp !== stamp) {
      cached = { stamp, metadata: enrich(readMetadata(buffer, { details: true })) };
      this.detailCache.set(fullPath, cached);
      if (this.detailCache.size > 4) this.detailCache.delete(this.detailCache.keys().next().value);
    }
    const metadata = cached.metadata;
    if (!metadata) throw Error('这个版本的存档暂时无法解析，仍然可以备份原文件');
    return {
      ...file,
      bytes: Number(stat.size),
      modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
      hash: stamp,
      metadata,
    };
  }
  compare(source, leftName, rightName) {
    for (const name of [leftName, rightName])
      if (typeof name !== 'string' || !/^\d+\.sav$/i.test(name)) throw Error('请选择两个游戏存档槽位');
    const root = realDirectory(source),
      files = listFiles(root);
    const selected = [leftName, rightName].map((name) => {
      const file = files.find((f) => f.name === name);
      if (!file) throw Error('所选存档已不存在，请刷新后重新选择');
      const full = path.join(root, name);
      const before = fs.lstatSync(full, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size > 32n * 1024n * 1024n)
        throw Error('所选存档文件异常，请刷新后重新选择');
      return { file, full, before };
    });
    const buffers = selected.map((x) => fs.readFileSync(x.full));
    for (const [i, x] of selected.entries()) {
      const after = fs.lstatSync(x.full, { bigint: true });
      if (
        x.before.size !== after.size ||
        x.before.mtimeNs !== after.mtimeNs ||
        x.before.ctimeNs !== after.ctimeNs ||
        x.before.ino !== after.ino ||
        BigInt(buffers[i].length) !== after.size
      )
        throw Error('存档在读取期间发生变化，请稍等后重新比较');
    }
    const records = selected.map((x, i) => ({
      ...x.file,
      modifiedAt: new Date(Number(x.before.mtimeMs)).toISOString(),
      bytes: Number(x.before.size),
      metadata: enrich(readMetadata(buffers[i], { details: true })),
    }));
    return compareRecords(records[0], records[1]);
  }
  list() {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9T-]+_[a-f0-9-]{36}$/.test(d.name))
      .map((d) => {
        try {
          const dir = realDirectory(path.join(this.root, d.name)),
            file = path.join(dir, 'manifest.json'),
            stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
          const m = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (
            m.schema !== 1 ||
            m.id !== d.name ||
            !Array.isArray(m.files) ||
            m.files.length < 1 ||
            m.files.length > 1000 ||
            typeof m.label !== 'string' ||
            m.label.length > 100 ||
            typeof m.createdAt !== 'string' ||
            Number.isNaN(Date.parse(m.createdAt)) ||
            typeof m.source !== 'string' ||
            m.files.some((f) => !Number.isSafeInteger(f.bytes) || f.bytes < 0)
          )
            return null;
          return {
            id: m.id,
            label: m.label,
            createdAt: m.createdAt,
            count: m.files.length,
            bytes: m.files.reduce((s, f) => s + f.bytes, 0),
            source: m.source,
            kind: m.kind,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  capture(source, label = '手动备份', kind = 'manual') {
    if (this.busy) throw new Error('存档操作进行中，请稍后重试');
    this.busy = true;
    try {
      return this._capture(source, label, kind);
    } finally {
      this.busy = false;
    }
  }
  _capture(source, label, kind) {
    const root = realDirectory(source),
      backupRoot = fs.realpathSync(this.root);
    if (isWithin(backupRoot, root) || isWithin(root, backupRoot))
      throw new Error('备份目录与游戏存档目录不能重叠');
    if (typeof label !== 'string' || label.length > 100) throw new Error('备份名称最多 100 字');
    const files = listFiles(root),
      buffers = new Map();
    for (const f of files) {
      const buffer = fs.readFileSync(path.join(root, f.name));
      if (buffer.length !== f.bytes) throw new Error('游戏正在写入存档，请等待保存完成后重试');
      buffers.set(f.name, buffer);
      f.sha256 = sha(buffer);
    }
    const after = listFiles(root);
    if (
      JSON.stringify(after.map((f) => [f.name, f.bytes, f.modifiedAt])) !==
      JSON.stringify(files.map((f) => [f.name, f.bytes, f.modifiedAt]))
    )
      throw new Error('存档刚刚发生变化，请稍后重试');
    for (const f of files)
      if (sha(fs.readFileSync(path.join(root, f.name))) !== f.sha256)
        throw new Error('存档正在变化，请稍后重试');
    const createdAt = new Date().toISOString(),
      id = `${createdAt.replace(/[:.Z]/g, '-')}_${crypto.randomUUID()}`;
    const dir = path.join(backupRoot, id);
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'files'));
    for (const f of files) {
      const target = path.join(dir, 'files', f.name);
      durableWrite(target, buffers.get(f.name));
      if (sha(fs.readFileSync(target)) !== f.sha256) throw new Error('备份校验失败，原存档未改动');
      const originalTime = new Date(f.modifiedAt);
      fs.utimesSync(target, originalTime, originalTime);
    }
    const manifest = {
      schema: 1,
      id,
      label: label.trim() || '手动备份',
      kind,
      createdAt,
      source: root,
      files,
    };
    durableWrite(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }
  verify(id) {
    if (!validId(id)) throw new Error('备份编号无效');
    const dir = realDirectory(path.join(this.root, id));
    if (!isWithin(dir, fs.realpathSync(this.root))) throw new Error('备份路径无效');
    const manifestFile = path.join(dir, 'manifest.json'),
      manifestStat = fs.lstatSync(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024)
      throw new Error('备份清单异常');
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (
      m.schema !== 1 ||
      m.id !== id ||
      !Array.isArray(m.files) ||
      !m.files.length ||
      m.files.length > 1000 ||
      typeof m.source !== 'string'
    )
      throw new Error('备份清单损坏');
    const seen = new Set();
    let total = 0;
    const buffers = new Map();
    const filesDir = realDirectory(path.join(dir, 'files'));
    if (!isWithin(filesDir, dir)) throw new Error('备份文件目录异常');
    for (const f of m.files) {
      if (
        !validName(f.name) ||
        seen.has(f.name.toLowerCase()) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0 ||
        f.bytes > 32 * 1024 * 1024 ||
        (total += f.bytes) > MAX_TOTAL ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        typeof f.modifiedAt !== 'string' ||
        Number.isNaN(Date.parse(f.modifiedAt))
      )
        throw new Error('备份清单包含无效文件');
      seen.add(f.name.toLowerCase());
      const file = path.join(filesDir, f.name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== f.bytes)
        throw new Error(`备份文件异常：${f.name}`);
      const b = fs.readFileSync(file);
      if (sha(b) !== f.sha256) throw new Error(`备份校验失败：${f.name}`);
      buffers.set(f.name, b);
    }
    return { manifest: m, buffers };
  }
  inspect(id, source) {
    const { manifest, buffers } = this.verify(id);
    const comparison = {
      available: false,
      sameSource: false,
      unchanged: 0,
      changed: 0,
      missing: 0,
      extra: 0,
      error: '',
    };
    let current = new Map();
    if (source)
      try {
        const root = realDirectory(source);
        comparison.sameSource = normalize(root) === normalize(manifest.source);
        if (comparison.sameSource) {
          current = new Map(
            listFiles(root).map((f) => [
              f.name,
              { ...f, sha256: sha(fs.readFileSync(path.join(root, f.name))) },
            ]),
          );
          comparison.available = true;
        } else comparison.error = '这份备份属于其他存档目录，当前不作覆盖比较。';
      } catch (e) {
        comparison.error = e.message;
      }
    const files = manifest.files.map((f) => {
      const live = current.get(f.name),
        status = comparison.available
          ? !live
            ? 'missing'
            : live.sha256 === f.sha256
              ? 'unchanged'
              : 'changed'
          : 'unknown';
      if (comparison.available) comparison[status]++;
      return {
        name: f.name,
        bytes: f.bytes,
        modifiedAt: f.modifiedAt,
        status,
        metadata: /^\d+\.sav$/i.test(f.name) ? enrich(readMetadata(buffers.get(f.name))) : null,
      };
    });
    if (comparison.available)
      comparison.extra = [...current.keys()].filter((n) => !manifest.files.some((f) => f.name === n)).length;
    return {
      id: manifest.id,
      label: manifest.label,
      createdAt: manifest.createdAt,
      source: manifest.source,
      kind: manifest.kind,
      files,
      comparison,
    };
  }
  rename(id, label) {
    if (typeof label !== 'string' || !label.trim() || label.length > 100)
      throw Error('备份名称须为 1 至 100 字');
    const { manifest } = this.verify(id);
    manifest.label = label.trim();
    atomicWrite(path.join(this.root, id, 'manifest.json'), manifest);
    return { id, label: manifest.label };
  }
  restore(id, source, checkGameStopped = () => true) {
    if (this.busy) throw new Error('存档操作进行中，请稍后重试');
    this.busy = true;
    try {
      if (this._readOperation()?.pending) throw Error('上次恢复尚未结束，请先处理存档匣中的恢复提示');
      const root = realDirectory(source),
        { manifest, buffers } = this.verify(id);
      if (normalize(root) !== normalize(manifest.source))
        throw new Error('该备份属于其他存档目录，请先在设置中切换到对应目录');
      if (!checkGameStopped()) throw new Error('请先退出逸剑风云决，再恢复存档');
      listFiles(root);
      for (const f of manifest.files) {
        const target = path.join(root, f.name);
        if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error('目标路径不是普通文件');
      }
      const safety = this._capture(root, '恢复前 · 安全副本', 'safety');
      const beforeFiles = new Map(safety.files.map((f) => [f.name, f.sha256]));
      if (!checkGameStopped()) throw new Error('检测到游戏运行，已停止恢复；安全副本已保留');
      const operation = {
        schema: 1,
        pending: true,
        phase: 'prepared',
        source: root,
        backupId: id,
        safetyId: safety.id,
        attempted: [],
        createdAt: new Date().toISOString(),
      };
      this._recordOperation(operation);
      try {
        for (const f of manifest.files) {
          this._expectFile(root, f.name, beforeFiles.get(f.name) || null);
          operation.phase = 'writing';
          operation.attempted.push(f.name);
          // Durably record intent before rename, so a killed process can recover it.
          this._recordOperation(operation);
          this._replaceFile(root, f.name, buffers.get(f.name), f.sha256, f.modifiedAt);
        }
        for (const f of manifest.files) this._expectFile(root, f.name, f.sha256);
        operation.pending = false;
        operation.phase = 'complete';
        this._recordOperation(operation);
      } catch (e) {
        try {
          this._rollback(operation, checkGameStopped);
        } catch (rollbackError) {
          throw new Error(
            `恢复中断，自动回退尚未完成。请先保持游戏关闭，在存档匣处理恢复提示。安全副本：${safety.id}。${rollbackError.message}`,
          );
        }
        throw new Error(`恢复中断，已回退已写入文件。安全副本：${safety.id}。${e.message}`);
      }
      return { restored: manifest.files.length, safetyId: safety.id };
    } finally {
      this.busy = false;
    }
  }
  _fileHash(root, name) {
    const file = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw Error(`待操作文件异常：${name}`);
    return sha(fs.readFileSync(file));
  }
  _expectFile(root, name, expectedHash) {
    if (this._fileHash(root, name) !== expectedHash)
      throw Error(`文件 ${name} 在恢复期间发生了其他修改，已停止操作；请先等待游戏和云同步结束`);
  }
  _replaceFile(root, name, bytes, expectedHash, modifiedAt) {
    const target = path.join(root, name);
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('目标存档不是普通文件');
    }
    const temp = path.join(root, `.yijian-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, target);
      if (sha(fs.readFileSync(target)) !== expectedHash) throw Error('恢复后的校验失败');
      if (modifiedAt) {
        const time = new Date(modifiedAt);
        fs.utimesSync(target, time, time);
      }
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  _recordOperation(operation) {
    atomicWrite(this.operationFile, operation);
  }
  _readOperation() {
    if (!fs.existsSync(this.operationFile)) return null;
    const stat = fs.lstatSync(this.operationFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
      throw Error('恢复记录异常，请保留备份并检查数据目录');
    const op = JSON.parse(fs.readFileSync(this.operationFile, 'utf8'));
    if (
      op.schema !== 1 ||
      typeof op.pending !== 'boolean' ||
      typeof op.source !== 'string' ||
      !validId(op.backupId) ||
      !validId(op.safetyId) ||
      !Array.isArray(op.attempted) ||
      op.attempted.length > 1000 ||
      op.attempted.some((n) => !validName(n)) ||
      new Set(op.attempted.map((n) => n.toLowerCase())).size !== op.attempted.length ||
      !['prepared', 'writing', 'rolling-back', 'complete', 'rolled-back'].includes(op.phase)
    )
      throw Error('恢复记录损坏，请保留安全副本');
    return op;
  }
  pendingRestore() {
    try {
      const op = this._readOperation();
      return op?.pending
        ? {
            pending: true,
            source: op.source,
            safetyId: op.safetyId,
            backupId: op.backupId,
            createdAt: op.createdAt,
            count: op.attempted.length,
          }
        : null;
    } catch (e) {
      return { pending: true, error: e.message };
    }
  }
  _rollback(op, checkGameStopped) {
    if (!checkGameStopped()) throw Error('请先退出逸剑风云决再回退');
    const root = realDirectory(op.source),
      old = this.verify(op.safetyId),
      incoming = this.verify(op.backupId);
    if (
      normalize(old.manifest.source) !== normalize(root) ||
      normalize(incoming.manifest.source) !== normalize(root)
    )
      throw Error('恢复记录与安全副本的目录不一致');
    const oldFiles = new Map(old.manifest.files.map((f) => [f.name, f])),
      newFiles = new Map(incoming.manifest.files.map((f) => [f.name, f])),
      observed = new Map();
    // Inspect the complete write set before touching any live file. A later game
    // session must never be silently replaced by recovery of an old transaction.
    for (const name of op.attempted) {
      if (!newFiles.has(name)) throw Error('恢复记录含未知文件');
      const hash = this._fileHash(root, name);
      observed.set(name, hash);
      if (hash !== null && hash !== newFiles.get(name).sha256 && hash !== oldFiles.get(name)?.sha256)
        throw Error(`文件 ${name} 在恢复中断后发生了其他修改，已停止自动回退；请在备份目录核对副本`);
    }
    op.phase = 'rolling-back';
    op.pending = true;
    this._recordOperation(op);
    for (const name of op.attempted) {
      this._expectFile(root, name, observed.get(name));
      const before = oldFiles.get(name),
        target = path.join(root, name);
      if (before) this._replaceFile(root, name, old.buffers.get(name), before.sha256, before.modifiedAt);
      else if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    op.pending = false;
    op.phase = 'rolled-back';
    this._recordOperation(op);
    return { restored: op.attempted.length, safetyId: op.safetyId };
  }
  recoverRestore(checkGameStopped = () => true) {
    if (this.busy) throw Error('存档操作进行中，请稍后重试');
    this.busy = true;
    try {
      const op = this._readOperation();
      if (!op?.pending) throw Error('没有需要处理的中断恢复');
      return this._rollback(op, checkGameStopped);
    } finally {
      this.busy = false;
    }
  }
  fingerprint(source) {
    const root = realDirectory(source);
    return listFiles(root)
      .map((f) => {
        const hash = this._fileHash(root, f.name);
        if (!hash) throw Error('存档正在变化，请稍后重试');
        return `${f.name}:${f.bytes}:${f.modifiedAt}:${hash}`;
      })
      .join('|');
  }
}
function discoverSaveFolders(localAppData) {
  const base = path.join(localAppData, 'Wandering_Sword', 'Saved');
  if (!fs.existsSync(base)) return [];
  const options = [
    path.join(base, 'SaveGames'),
    ...fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => path.join(base, d.name, 'SaveGames')),
  ];
  return options.filter((p) => {
    try {
      return listFiles(realDirectory(p)).length > 0;
    } catch {
      return false;
    }
  });
}
module.exports = { Saves, discoverSaveFolders, listFiles, realDirectory, isWithin, sha };
