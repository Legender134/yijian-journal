'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const MAX_MANIFEST = 1024 * 1024;
const RESULT_FILE = 'protection-export-result.json';
const normalized = (value) =>
  process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a, b) => normalized(a) === normalized(b);
function realBackupRoot(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(root), root))
    throw problem('BACKUP_DIRECTORY_UNSAFE', '备份根目录不是普通目录或发生跳转');
  return fs.realpathSync(root);
}
function validBackupId(id) {
  if (typeof id !== 'string') return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})-_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(
      id,
    );
  if (!match) return false;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso;
}
function problem(code, reason) {
  return Object.assign(Error(reason), { code, reason });
}
function backupDirectory(root, id) {
  if (!validBackupId(id)) throw problem('BACKUP_ID_INVALID', '备份目录编号无效');
  root = realBackupRoot(root);
  const directory = path.join(root, id),
    stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw problem('BACKUP_DIRECTORY_UNSAFE', '备份目录不是普通目录或含链接');
  const resolved = fs.realpathSync(directory);
  if (!samePath(resolved, directory) || !samePath(path.dirname(resolved), fs.realpathSync(root)))
    throw problem('BACKUP_DIRECTORY_UNSAFE', '备份目录发生跳转，已停止访问');
  return resolved;
}
function backupDirectories(root) {
  root = realBackupRoot(root);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && validBackupId(entry.name))
    .map((entry) => entry.name)
    .sort();
}
function validateBackupManifest(value, id) {
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const date = (v) => typeof v === 'string' && v.length <= 80 && Number.isFinite(Date.parse(v));
  if (
    !object(value) ||
    value.schema !== 1 ||
    value.id !== id ||
    !validBackupId(id) ||
    typeof value.label !== 'string' ||
    value.label.length > 100 ||
    typeof value.kind !== 'string' ||
    value.kind.length > 80 ||
    !date(value.createdAt) ||
    typeof value.source !== 'string' ||
    (value.locked !== undefined && typeof value.locked !== 'boolean') ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 1000
  )
    throw problem('BACKUP_MANIFEST_INVALID_STRUCTURE', '备份清单结构无效，无法确认副本内容');
  const seen = new Set();
  let bytes = 0;
  for (const file of value.files) {
    if (
      !object(file) ||
      typeof file.name !== 'string' ||
      !file.name.length ||
      file.name.length > 255 ||
      file.name.normalize('NFC') !== file.name ||
      /[\\/<>:"|?*\x00-\x1f\x7f]/.test(file.name) ||
      file.name === '.' ||
      file.name === '..' ||
      /[. ]$/.test(file.name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name) ||
      seen.has(file.name.toLowerCase()) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 32 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !date(file.modifiedAt)
    )
      throw problem('BACKUP_MANIFEST_INVALID_STRUCTURE', '备份清单包含无效文件或重复文件，无法确认副本内容');
    seen.add(file.name.toLowerCase());
    bytes += file.bytes;
  }
  if (bytes > 256 * 1024 * 1024 || !value.files.some((file) => /\.sav$/i.test(file.name)))
    throw problem('BACKUP_MANIFEST_INVALID_STRUCTURE', '备份清单大小异常或没有存档文件');
  return value;
}
function parseBackupManifest(bytes, id) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    throw problem('BACKUP_MANIFEST_INVALID_JSON', '备份清单截断、损坏或不是有效的 UTF-8 JSON');
  }
  return validateBackupManifest(value, id);
}
function readBackupManifest(root, id) {
  const directory = backupDirectory(root, id),
    file = path.join(directory, 'manifest.json');
  let handle;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_MANIFEST))
      throw problem('BACKUP_MANIFEST_UNSAFE', '备份清单不是普通文件、含链接或超过大小限制');
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(handle, { bigint: true });
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      throw problem('BACKUP_MANIFEST_CHANGED', '备份清单在读取期间发生变化，请稍后重新检查');
    const bytes = fs.readFileSync(handle),
      after = fs.lstatSync(file, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key]) ||
      BigInt(bytes.length) !== before.size
    )
      throw problem('BACKUP_MANIFEST_CHANGED', '备份清单在读取期间发生变化，请稍后重新检查');
    return parseBackupManifest(bytes, id);
  } catch (error) {
    if (error.code?.startsWith('BACKUP_')) throw error;
    throw Object.assign(
      problem(
        error.code === 'ENOENT' ? 'BACKUP_MANIFEST_MISSING' : 'BACKUP_MANIFEST_UNREADABLE',
        error.code === 'ENOENT'
          ? '缺少备份清单 manifest.json，无法确认副本内容'
          : '备份清单无法读取，请检查访问权限和磁盘',
      ),
      { diagnostic: `${error.code || 'IO'}: ${error.message}` },
    );
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}
function backupMetadataError(root, id, error) {
  if (error.code === 'BACKUP_METADATA_INVALID') return error;
  const reason =
    error.reason || (error.code === 'ENOENT' ? '缺少备份清单或副本文件' : '备份清单无法读取或未通过校验');
  return Object.assign(
    Error(`完整备份目录 ${id}：${reason}。本次导出已中止，原件保留。目录：${path.join(root, id)}`),
    {
      code: 'BACKUP_METADATA_INVALID',
      reasonCode: error.code?.startsWith('BACKUP_')
        ? error.code
        : error.code === 'ENOENT'
          ? 'BACKUP_MANIFEST_MISSING'
          : error.code
            ? 'BACKUP_MANIFEST_UNREADABLE'
            : 'BACKUP_MANIFEST_INVALID_STRUCTURE',
      backupId: id,
      directory: path.join(root, id),
      reason,
      diagnostic: error.diagnostic || error.message,
    },
  );
}
function anomaly(root, id, error) {
  return {
    id,
    directory: path.join(root, id),
    abnormal: true,
    reason: error.reason || '副本目录无法读取',
    reasonCode: error.code || 'BACKUP_DIRECTORY_UNREADABLE',
    diagnostic: error.diagnostic || error.message,
    recoverable: false,
  };
}
function resultPath(dataRoot) {
  if (
    path
      .resolve(dataRoot)
      .split(/[\\/]/)
      .some((component) => /^savegames$/i.test(component))
  )
    throw Error('游戏 SaveGames 目录不能用于保存导出诊断');
  const stat = fs.lstatSync(dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(dataRoot), dataRoot))
    throw Error('导出诊断数据目录不支持链接');
  return path.join(dataRoot, RESULT_FILE);
}
function recordProtectionExportResult(dataRoot, result) {
  const file = resultPath(dataRoot);
  for (const target of [file, file + '.previous']) {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('导出诊断记录不支持链接或异常文件');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // Metadata-only historical reads do not initialize the journal subsystem.
  const receipt = { schema: 1, at: Date.now(), ...result };
  require('./store.cjs').atomicWrite(file, receipt);
  return receipt;
}
// Only the export's own bounded result fields cross its existing IPC response.
function protectionExportReceipt(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.at) ||
    !['running', 'failed', 'success'].includes(value.status) ||
    typeof value.message !== 'string' ||
    value.message.length > 4000 ||
    typeof value.file !== 'string' ||
    value.file.length > 2000
  )
    return null;
  const receipt = { schema: 1, at: value.at, status: value.status, message: value.message, file: value.file };
  for (const key of ['code', 'directory', 'reasonCode', 'reason', 'diagnostic', 'recordError']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 4000) return null;
    receipt[key] = value[key];
  }
  if (value.backupId !== undefined) {
    if (!validBackupId(value.backupId)) return null;
    receipt.backupId = value.backupId;
  }
  for (const key of ['published', 'recordNotSaved']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') return null;
    receipt[key] = value[key];
  }
  if (value.volumes !== undefined) {
    if (!Number.isSafeInteger(value.volumes) || value.volumes < 1) return null;
    receipt.volumes = value.volumes;
  }
  if (value.omittedArchives !== undefined) {
    if (!Array.isArray(value.omittedArchives) || value.omittedArchives.length > 1000) return null;
    receipt.omittedArchives = [];
    for (const row of value.omittedArchives) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id) ||
        typeof row.label !== 'string' ||
        row.label.length > 200 ||
        typeof row.reason !== 'string' ||
        row.reason.length > 4000
      )
        return null;
      receipt.omittedArchives.push({ id: row.id, label: row.label, reason: row.reason });
    }
  }
  return receipt;
}
function readProtectionExportResult(dataRoot) {
  let file, handle;
  try {
    file = resultPath(dataRoot);
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64n * 1024n) throw Error('导出诊断记录无效');
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(handle, { bigint: true });
    if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw Error('导出诊断记录发生变化');
    const bytes = fs.readFileSync(handle),
      after = fs.lstatSync(file, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => stat[key] !== after[key]) ||
      BigInt(bytes.length) !== stat.size
    )
      throw Error('导出诊断记录发生变化');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !value ||
      value.schema !== 1 ||
      !Number.isSafeInteger(value.at) ||
      !['running', 'failed', 'success'].includes(value.status) ||
      typeof value.message !== 'string' ||
      value.message.length > 4000 ||
      typeof value.file !== 'string' ||
      value.file.length > 2000 ||
      (value.backupId !== undefined && !validBackupId(value.backupId)) ||
      ['code', 'directory', 'reasonCode', 'reason', 'diagnostic'].some(
        (key) => value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 4000),
      ) ||
      (value.volumes !== undefined && (!Number.isSafeInteger(value.volumes) || value.volumes < 1)) ||
      (value.omittedArchives !== undefined &&
        (!Array.isArray(value.omittedArchives) ||
          value.omittedArchives.length > 1000 ||
          value.omittedArchives.some(
            (row) =>
              !row ||
              typeof row.id !== 'string' ||
              !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id) ||
              typeof row.label !== 'string' ||
              row.label.length > 200 ||
              typeof row.reason !== 'string' ||
              row.reason.length > 4000,
          )))
    )
      throw Error('导出诊断记录无效');
    // An interrupted attempt cannot be interpreted as an earlier success.
    return value.status === 'running'
      ? { ...value, message: '上次完整导出未能确认完成，请核对目标目录后重新导出；原件仍保留。' }
      : value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return {
      schema: 1,
      at: 0,
      status: 'failed',
      code: 'EXPORT_RESULT_UNREADABLE',
      file: '',
      message: '上次导出结果记录无法读取，不能确认导出完成。请保留原件并重新导出。',
      diagnostic: error.message,
      recordPath: file || path.join(dataRoot, RESULT_FILE),
    };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}
module.exports = {
  validBackupId,
  backupDirectory,
  backupDirectories,
  readBackupManifest,
  parseBackupManifest,
  backupMetadataError,
  anomaly,
  recordProtectionExportResult,
  protectionExportReceipt,
  readProtectionExportResult,
};
