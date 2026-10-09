'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Saves, realDirectory, listFiles } = require('./saves.cjs');
const { atomicWrite } = require('./store.cjs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function readPlain(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw Error('迁移副本文件异常');
  return fs.readFileSync(file);
}
function durable(file, bytes) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// Called only after the main-process confirmation for this machine's target.
// This registers a verified copy; only Saves.restore may change game files.
function bindHistoricalBackup({ saves, payloadDirectory, source, stopped }) {
  if (typeof stopped !== 'function' || !stopped()) throw Error('请先退出游戏再准备迁移恢复');
  if (saves.busy || saves.pendingRestore()) throw Error('请先核对正在进行的完整存档恢复');
  const root = realDirectory(source),
    payload = realDirectory(payloadDirectory);
  const normalize = (p) => path.resolve(p).toLowerCase();
  const inside = (a, b) => normalize(a) === normalize(b) || normalize(a).startsWith(normalize(b) + path.sep);
  if (inside(root, saves.root) || inside(saves.root, root) || inside(payload, root) || inside(root, payload))
    throw Error('迁移历史与游戏存档目录不能重叠');
  listFiles(root);
  const incoming = JSON.parse(readPlain(path.join(payload, 'manifest.json'), 1024 * 1024).toString('utf8'));
  if (
    incoming.source !== '' ||
    incoming.readOnly !== true ||
    incoming.bound !== false ||
    !/^[0-9T-]+_[a-f0-9-]{36}$/.test(incoming.id)
  )
    throw Error('需要已校验、未绑定的迁移备份');
  const provenance = readPlain(path.join(payload, 'provenance-manifest.json'), 1024 * 1024);
  const provenanceManifest = JSON.parse(provenance.toString('utf8').replace(/^\uFEFF/, ''));
  const entries = (list) =>
    Array.isArray(list) ? list.map((f) => [f.name, f.bytes, f.sha256, f.modifiedAt]) : null;
  if (
    provenanceManifest.id !== incoming.id ||
    JSON.stringify(entries(provenanceManifest.files)) !== JSON.stringify(entries(incoming.files))
  )
    throw Error('迁移副本与原始保护清单不一致');
  saves.busy = true;
  const stage = fs.mkdtempSync(path.join(saves.root, '.migration-binding-'));
  try {
    const verifier = new Saves(stage),
      old = path.join(stage, incoming.id),
      files = path.join(old, 'files');
    fs.mkdirSync(files, { recursive: true });
    durable(path.join(old, 'manifest.json'), JSON.stringify(incoming));
    const sourceFiles = realDirectory(path.join(payload, 'files'));
    if (incoming.files?.length > 1000 || !Array.isArray(incoming.files)) throw Error('迁移备份清单无效');
    let total = 0;
    for (const entry of incoming.files) {
      if (
        typeof entry.name !== 'string' ||
        entry.name !== path.basename(entry.name) ||
        /[\\/:\x00-\x1f]/.test(entry.name) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > 32 * 1024 * 1024 ||
        (total += entry.bytes) > 256 * 1024 * 1024
      )
        throw Error('迁移备份文件清单无效');
      const bytes = readPlain(path.join(sourceFiles, entry.name), 32 * 1024 * 1024);
      if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw Error('迁移备份字节校验失败');
      durable(path.join(files, entry.name), bytes);
    }
    verifier.verify(incoming.id);
    const id = new Date().toISOString().replace(/[:.Z]/g, '-') + '_' + crypto.randomUUID();
    const bound = {
      schema: 1,
      id,
      label: ('迁移 · ' + incoming.label).slice(0, 100),
      kind: 'imported',
      createdAt: new Date().toISOString(),
      source: root,
      files: incoming.files,
      importedFrom: { id: incoming.id, createdAt: incoming.createdAt, provenanceHash: sha(provenance) },
    };
    const prepared = path.join(stage, id);
    fs.renameSync(old, prepared);
    atomicWrite(path.join(prepared, 'manifest.json'), bound);
    durable(path.join(prepared, 'provenance-manifest.json'), provenance);
    verifier.verify(id);
    if (!stopped()) throw Error('检测到游戏运行，已保留准备副本并停止恢复');
    fs.renameSync(prepared, path.join(saves.root, id));
    saves.verify(id);
    fs.rmdirSync(stage);
    return { id, count: bound.files.length, source: root };
  } finally {
    saves.busy = false;
  }
}
module.exports = { bindHistoricalBackup };
