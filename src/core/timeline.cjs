'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./store.cjs');
const { realDirectory, sha, isWithin } = require('./saves.cjs');
const { readMetadata } = require('./save-reader.cjs');
const { enrich } = require('./game-data.cjs');
const { compareRecords } = require('./save-comparison.cjs');
const { selectAutomatic, MAX_AUTOMATIC, TOLERANCES } = require('./timeline-retention.cjs');
const AGES = Object.freeze([3600, 1800, 600, 300, 120, 60, 50, 40, 30, 20, 10]);
const INTERVALS = Object.freeze([10, 20, 30, 60, 120, 300]);
const SLOT = '29.sav';
const bookmarked = (r) => r.bookmarked === true || (r.kind === 'manual' && r.bookmarked !== false);
const MAX_SAVE = 32 * 1024 * 1024;
const safeHash = (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
const safeId = (id) =>
  typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
function readStable(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_SAVE))
    throw Error('时间线文件异常');
  const bytes = fs.readFileSync(file),
    after = fs.lstatSync(file, { bigint: true });
  if (
    ['size', 'mtimeNs', 'ctimeNs', 'ino'].some((k) => before[k] !== after[k]) ||
    BigInt(bytes.length) !== after.size
  )
    throw Error('存档正在写入，请稍后重试');
  return bytes;
}
function writeBytes(file, bytes) {
  let replaced = false;
  try {
    const temp = file + '.' + crypto.randomUUID() + '.tmp',
      fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    replaced = true;
    if (sha(readStable(file)) !== sha(bytes)) throw Error('时间线文件写入后校验失败');
  } catch (e) {
    // A command may already be visible when its read-back verification fails.
    e.notReplaced = !replaced;
    throw e;
  }
}
class Timeline {
  constructor(root, { now = Date.now } = {}) {
    fs.mkdirSync(root, { recursive: true });
    this.root = realDirectory(root);
    this.now = now;
    this.pins = new Map();
    this.file = path.join(this.root, 'timeline.json');
    this.blobs = path.join(this.root, 'blobs');
    fs.mkdirSync(this.blobs, { recursive: true });
    realDirectory(this.blobs);
    this.data = {
      schema: 1,
      enabled: false,
      interval: 10,
      source: '',
      ownerHash: '',
      records: [],
      pending: null,
      nativeProtocol: 0,
      retired: [],
    };
    this.error = '';
    this.diagnostic = '';
    if (fs.existsSync(this.file)) {
      try {
        this.data = this.validate(JSON.parse(readStable(this.file).toString('utf8')));
      } catch (e) {
        this.error = '时间线记录损坏，已停止自动存读档；原文件和历史副本保留。';
        this.diagnostic = e.message;
      }
    }
    if (this.data.pending || this.error) this.data.enabled = false;
  }
  validate(d) {
    if (
      d?.schema !== 1 ||
      typeof d.enabled !== 'boolean' ||
      !INTERVALS.includes(d.interval) ||
      typeof d.source !== 'string' ||
      !(d.nativeProtocol === undefined || d.nativeProtocol === 0 || d.nativeProtocol === 2) ||
      !(d.ownerHash === '' || safeHash(d.ownerHash)) ||
      !Array.isArray(d.records) ||
      d.records.length > 100000
    )
      throw Error('记录格式无效');
    const ids = new Set();
    for (const r of d.records) {
      if (
        !safeId(r.id) ||
        ids.has(r.id) ||
        !safeHash(r.hash) ||
        !Number.isSafeInteger(r.at) ||
        r.at < 0 ||
        typeof r.source !== 'string' ||
        !['auto', 'manual', 'before-load'].includes(r.kind) ||
        typeof r.map !== 'string' ||
        !Number.isSafeInteger(r.playSeconds) ||
        r.playSeconds < 0 ||
        (r.bookmarked !== undefined && typeof r.bookmarked !== 'boolean') ||
        (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > 80)) ||
        (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 500))
      )
        throw Error('历史节点格式无效');
      ids.add(r.id);
    }
    if (
      d.pending &&
      (!['save', 'stage', 'load'].includes(d.pending.type) ||
        !safeId(d.pending.id) ||
        !(d.pending.beforeHash === '' || safeHash(d.pending.beforeHash)) ||
        !Number.isSafeInteger(d.pending.at) ||
        d.pending.at < 0 ||
        (d.pending.type === 'save' &&
          (!['auto', 'manual', 'before-load'].includes(d.pending.kind) ||
            (d.pending.beforeStamp !== undefined &&
              (typeof d.pending.beforeStamp !== 'string' || !/^\d*$/.test(d.pending.beforeStamp))))) ||
        (d.pending.type !== 'save' && !safeHash(d.pending.targetHash)) ||
        (d.pending.targetHash && !safeHash(d.pending.targetHash)))
    )
      throw Error('中断操作格式无效');
    if (
      d.retired &&
      (!Array.isArray(d.retired) || d.retired.length > 100000 || d.retired.some((h) => !safeHash(h)))
    )
      throw Error('轮换记录无效');
    return { ...d, pending: d.pending || null, retired: d.retired || [] };
  }
  commit(next = this.data) {
    if (this.error) throw Error(this.error);
    atomicWrite(this.file, next);
    this.data = next;
  }
  validateSource(source) {
    const target = realDirectory(source);
    if (isWithin(this.root, target) || isWithin(target, this.root))
      throw Error('历史目录与游戏存档不能互相包含');
    return target;
  }
  configure(source, enabled, interval) {
    if (typeof enabled !== 'boolean' || !INTERVALS.includes(interval)) throw Error('保存间隔无效');
    const target = this.validateSource(source);
    if (this.data.pending) throw Error('请先核对上次中断的时间线操作');
    const changed = this.data.source.toLowerCase() !== target.toLowerCase();
    const next = {
      ...this.data,
      source: target,
      ownerHash: changed ? '' : this.data.ownerHash,
      nativeProtocol: enabled ? 2 : changed ? 0 : this.data.nativeProtocol || 0,
      enabled,
      interval,
    };
    if (enabled) this.assertOwned(next);
    this.commit(next);
  }
  stop() {
    this.commit({ ...this.data, enabled: false });
  }
  // Only the confirmed quick-start flow calls this, after verifying a complete backup.
  // Preserve an occupied slot as a permanent bookmark before explicitly reserving it.
  enableProtected(source, protectedSlot) {
    if (this.error) throw Error(this.error);
    if (this.data.pending) throw Error('请先核对上次中断的时间线操作');
    const target = realDirectory(source);
    if (isWithin(this.root, target) || isWithin(target, this.root))
      throw Error('历史目录与游戏存档不能互相包含');
    const next = {
      ...this.data,
      source: target,
      ownerHash: this.data.source.toLowerCase() === target.toLowerCase() ? this.data.ownerHash : '',
      enabled: true,
      nativeProtocol: 2,
      interval: 10,
    };
    const file = path.join(target, SLOT);
    let retained;
    if (fs.existsSync(file)) {
      if (!Buffer.isBuffer(protectedSlot) || sha(readStable(file)) !== sha(protectedSlot))
        throw Error('29 号槽与保护副本不一致，请重新开启助手');
      if (next.ownerHash !== sha(protectedSlot)) {
        const { hash, meta } = this.blob(protectedSlot);
        retained = {
          id: crypto.randomUUID(),
          hash,
          at: this.now(),
          source: target,
          kind: 'manual',
          bookmarked: true,
          label: '启用助手前的 29 号槽',
          map: meta.map,
          playSeconds: meta.playSeconds,
        };
        next.records = [...next.records, retained];
        next.ownerHash = hash;
      }
    } else if (protectedSlot || next.ownerHash) throw Error('29 号槽与保护副本不一致，请重新开启助手');
    this.assertOwned(next);
    this.commit(next);
    return retained;
  }
  assertOwned(data = this.data) {
    if (this.error) throw Error(this.error);
    const file = path.join(realDirectory(data.source), SLOT);
    if (fs.existsSync(file)) {
      if (!data.ownerHash || sha(readStable(file)) !== data.ownerHash)
        throw Error(
          '29 号槽包含其他进度，已停止保存。请在游戏中把它保存到其他槽，并清空 29 号槽后再开启时间线。',
        );
    } else if (data.ownerHash) throw Error('时间线专用槽丢失，已停止保存。');
    return file;
  }
  blob(bytes) {
    const meta = readMetadata(bytes);
    if (!meta) throw Error('存档格式无法识别，已停止时间线');
    const hash = sha(bytes),
      file = path.join(realDirectory(this.blobs), hash + '.sav');
    if (!fs.existsSync(file)) writeBytes(file, bytes);
    else if (sha(readStable(file)) !== hash) throw Error('历史副本损坏，已停止操作');
    return { hash, meta };
  }
  record(bytes, kind = 'auto', at = this.now()) {
    if (!['auto', 'manual', 'before-load'].includes(kind) || !Number.isSafeInteger(at) || at < 0)
      throw Error('节点参数无效');
    const { hash, meta } = this.blob(bytes);
    const r = {
      id: crypto.randomUUID(),
      hash,
      at,
      source: this.data.source,
      kind,
      map: meta.map,
      playSeconds: meta.playSeconds,
    };
    const all = [...this.data.records, r];
    const records = this.rolling(all, at);
    const ids = new Set(records.map((x) => x.id));
    const retired = [
      ...new Set([...this.data.retired, ...all.filter((x) => !ids.has(x.id)).map((x) => x.hash)]),
    ];
    this.commit({ ...this.data, records, ownerHash: hash, pending: null, retired });
    try {
      this.collect();
    } catch {} // Rotation cannot invalidate an already verified save.
    return r;
  }
  rolling(all, at) {
    const automatic = new Map(),
      protections = new Map();
    const ids = new Set(this.pins.keys());
    for (const r of [...all].sort((a, b) => a.at - b.at)) {
      if (bookmarked(r)) {
        ids.add(r.id);
        continue;
      }
      const source = r.source.toLowerCase();
      if (r.kind === 'before-load') {
        protections.set(source, r.id);
        continue;
      }
      if (!automatic.has(source)) automatic.set(source, []);
      automatic.get(source).push(r);
    }
    for (const records of automatic.values()) for (const id of selectAutomatic(records, at)) ids.add(id);
    for (const id of protections.values()) ids.add(id);
    return all.filter((r) => ids.has(r.id));
  }
  updateNode(id, value) {
    this.inspect(id);
    if (
      !value ||
      Object.keys(value).some((k) => !['bookmarked', 'label', 'note'].includes(k)) ||
      (value.bookmarked !== undefined && typeof value.bookmarked !== 'boolean') ||
      (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 80)) ||
      (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 500))
    )
      throw Error('节点名称或备注无效');
    const records = this.data.records.map((r) =>
      r.id === id
        ? {
            ...r,
            ...value,
            ...(value.label !== undefined ? { label: value.label.trim() } : {}),
            ...(value.note !== undefined ? { note: value.note.trim() } : {}),
            ...(value.bookmarked === false && r.kind === 'manual' ? { kind: 'auto' } : {}),
          }
        : r,
    );
    this.commit({ ...this.data, records });
    return this.inspect(id).record;
  }
  comparison(id) {
    const selected = this.inspect(id),
      basis = this.data.records
        .filter((r) => r.source.toLowerCase() === selected.record.source.toLowerCase())
        .sort((a, b) => b.at - a.at)[0];
    const latest = this.inspect(basis.id);
    const asFile = (v) => ({
      name: v.record.label || v.record.map,
      modifiedAt: new Date(v.record.at).toISOString(),
      metadata: v.metadata,
    });
    return {
      basis: { ...latest.record, mapName: latest.metadata.mapName },
      comparison: compareRecords(asFile(latest), asFile(selected)),
    };
  }
  pin(id) {
    this.inspect(id);
    this.pins.set(id, (this.pins.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.pins.get(id) - 1;
      if (remaining > 0) this.pins.set(id, remaining);
      else this.pins.delete(id);
    };
  }
  collect() {
    const keep = new Set(this.data.records.map((r) => r.hash));
    const protect = (d) => {
      if (d.ownerHash) keep.add(d.ownerHash);
      if (d.pending?.beforeHash) keep.add(d.pending.beforeHash);
      if (d.pending?.targetHash) keep.add(d.pending.targetHash);
    };
    protect(this.data);
    try {
      const previous = this.validate(JSON.parse(readStable(this.file + '.previous')));
      for (const r of previous.records) keep.add(r.hash);
      protect(previous);
    } catch {}
    const retired = [];
    for (const hash of this.data.retired) {
      if (keep.has(hash)) {
        retired.push(hash);
        continue;
      }
      const file = path.join(realDirectory(this.blobs), hash + '.sav');
      try {
        if (fs.existsSync(file)) {
          if (sha(readStable(file)) !== hash) throw Error('轮换文件已变化');
          fs.unlinkSync(file);
        }
      } catch {
        retired.push(hash);
      }
    }
    if (retired.length !== this.data.retired.length) this.commit({ ...this.data, retired });
  }
  inspect(id) {
    if (!safeId(id)) throw Error('历史节点编号无效');
    const r = this.data.records.find((r) => r.id === id);
    if (!r) throw Error('历史节点不存在');
    const bytes = readStable(path.join(realDirectory(this.blobs), r.hash + '.sav'));
    if (sha(bytes) !== r.hash) throw Error('历史节点校验失败，无法读档');
    const raw = readMetadata(bytes, { details: true });
    if (!raw) throw Error('历史节点格式无法识别');
    return { record: { ...r }, bytes, metadata: enrich(raw) };
  }
  beginSave(id, kind) {
    if (!safeId(id) || !['auto', 'manual', 'before-load'].includes(kind)) throw Error('保存请求无效');
    if (this.data.pending) throw Error('上次时间线操作尚未完成');
    if (
      this.data.records.some(
        (r) => r.source.toLowerCase() === this.data.source.toLowerCase() && r.at > this.now(),
      )
    )
      throw Error('系统时间早于最近留存记录，已暂停自动保存；请校正系统时间');
    const file = this.assertOwned(),
      bytes = fs.existsSync(file) ? readStable(file) : null;
    if ((bytes ? sha(bytes) : '') !== this.data.ownerHash) throw Error('29 号槽在保存准备期间发生了变化');
    const beforeStamp = bytes ? String(fs.lstatSync(file, { bigint: true }).mtimeNs) : '';
    this.commit({
      ...this.data,
      pending: { type: 'save', id, kind, beforeHash: this.data.ownerHash, beforeStamp, at: this.now() },
    });
    return bytes;
  }
  finishSave(id, receipt) {
    const p = this.data.pending;
    if (!p || p.type !== 'save' || p.id !== id) throw Error('保存回执不匹配');
    const current = readStable(path.join(realDirectory(this.data.source), SLOT));
    const stamp = fs.lstatSync(path.join(this.data.source, SLOT), { bigint: true });
    if ((p.beforeStamp && String(stamp.mtimeNs) === p.beforeStamp) || Number(stamp.mtimeMs) < p.at - 1000)
      throw Error('游戏存档尚未完成写入，已保留回执并停止操作');
    if (sha(current) !== sha(receipt)) throw Error('保存后 29 号槽又发生了变化，已保留回执并停止操作');
    return this.record(receipt, p.kind, Math.floor(Number(stamp.mtimeMs)));
  }
  cancelUnwritten(id) {
    const p = this.data.pending;
    if (!p || p.id !== id) throw Error('中断请求不匹配');
    const file = path.join(realDirectory(this.data.source), SLOT),
      hash = fs.existsSync(file) ? sha(readStable(file)) : '';
    if (hash !== p.beforeHash) throw Error('29 号槽已发生变化，需要核对保存回执');
    this.commit({ ...this.data, pending: null });
  }
  stage(id) {
    if (this.data.pending) throw Error('上次时间线操作尚未完成');
    const verified = this.inspect(id);
    if (verified.record.source.toLowerCase() !== this.data.source.toLowerCase())
      throw Error('历史节点来自另一个存档目录');
    const target = this.assertOwned(),
      before = readStable(target),
      latest = this.data.records.at(-1);
    const safety =
      latest?.kind === 'before-load' && latest.hash === sha(before)
        ? latest
        : this.record(before, 'before-load');
    const pending = {
      type: 'stage',
      id: crypto.randomUUID(),
      beforeHash: sha(before),
      targetHash: verified.record.hash,
      at: this.now(),
    };
    this.commit({ ...this.data, pending });
    if (sha(readStable(target)) !== pending.beforeHash) throw Error('读档前存档发生变化，已停止操作');
    writeBytes(target, verified.bytes);
    this.commit({ ...this.data, ownerHash: pending.targetHash, pending: null });
    return { safetyId: safety.id, record: verified.record, metadata: verified.metadata };
  }
  reconcileStage() {
    const p = this.data.pending;
    if (!p || !['stage', 'load'].includes(p.type)) throw Error('没有待核对的读档操作');
    const current = sha(readStable(path.join(realDirectory(this.data.source), SLOT)));
    if (![p.beforeHash, p.targetHash].includes(current))
      throw Error('29 号槽含新的外部修改，已保留所有副本并停止操作');
    if (sha(readStable(path.join(realDirectory(this.blobs), current + '.sav'))) !== current)
      throw Error('保护副本校验失败');
    this.commit({ ...this.data, ownerHash: current, pending: null, enabled: false });
  }
  nodes(now = this.now()) {
    const records = this.data.records
      .filter((r) => r.source.toLowerCase() === this.data.source.toLowerCase() && r.at <= now)
      .sort((a, b) => b.at - a.at);
    return AGES.map((seconds) => {
      const cutoff = now - seconds * 1000,
        r = records.find((r) => r.at <= cutoff);
      const gap = r ? (cutoff - r.at) / 1000 : null;
      const available = !!r && gap <= TOLERANCES[seconds];
      return {
        seconds,
        toleranceSeconds: TOLERANCES[seconds],
        reason: available ? '' : r ? '附近没有可用存档' : '尚未积累到这个时间',
        nearestAt: !available && r ? r.at : null,
        record: available
          ? {
              ...r,
              mapName: enrich({ map: r.map }).mapName,
              ageSeconds: Math.floor((now - r.at) / 1000),
              gapSeconds: Math.floor((cutoff - r.at) / 1000),
            }
          : null,
      };
    });
  }
  summary() {
    const records = this.data.records.filter(
      (r) => r.source.toLowerCase() === this.data.source.toLowerCase(),
    );
    return {
      enabled: this.data.enabled,
      interval: this.data.interval,
      count: records.length,
      source: this.data.source,
      latest: records.length
        ? { ...records.at(-1), mapName: enrich({ map: records.at(-1).map }).mapName }
        : null,
      nodes: this.nodes(),
      error: this.error,
      indexError: !!this.error,
      diagnostic: this.diagnostic,
      recordPath: this.error ? this.file : '',
      pending: this.data.pending,
      retention: 'bounded-sampling',
      maxAutomaticRecords: MAX_AUTOMATIC,
      automaticCount: records.filter((r) => r.kind !== 'before-load' && !bookmarked(r)).length,
      bookmarkCount: records.filter(bookmarked).length,
      returnRecord: [...records].reverse().find((r) => r.kind === 'before-load') || null,
      history: [...records]
        .sort((a, b) => b.at - a.at)
        .map((r) => ({ ...r, bookmarked: bookmarked(r), mapName: enrich({ map: r.map }).mapName })),
      protected: records
        .filter((r) => r.kind !== 'auto' || bookmarked(r))
        .reverse()
        .map((r) => ({ ...r, bookmarked: bookmarked(r) })),
      bytes: [...new Set(records.map((r) => r.hash))].reduce((n, h) => {
        try {
          return n + fs.statSync(path.join(this.blobs, h + '.sav')).size;
        } catch {
          return n;
        }
      }, 0),
    };
  }
}
module.exports = { Timeline, AGES, INTERVALS, SLOT, readStable, writeBytes, safeId };
