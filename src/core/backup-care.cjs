'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./store.cjs');
const { readProtectionIndex } = require('./migration.cjs');

const CARE = '.backup-care';
const RECEIPT = 'receipt.json';
const MAX_FILE = 32 * 1024 * 1024;
const MAX_BACKUP = 256 * 1024 * 1024;
const MAX_META = 1024 * 1024;
const MAX_RECEIPT = 16 * MAX_META;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const idOK = (id) => typeof id === 'string' && /^[0-9T-]+_[a-f0-9-]{36}$/.test(id);
const transactionOK = (id) =>
  typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const hashOK = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const nameOK = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length < 256 &&
  name === path.basename(name) &&
  !/[\\/:\x00-\x1f]/.test(name) &&
  name !== '.' &&
  name !== '..' &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const normalized = (value) => path.resolve(value).toLowerCase();
const within = (child, parent) =>
  normalized(child) === normalized(parent) || normalized(child).startsWith(normalized(parent) + path.sep);
const sameStamp = (a, b) =>
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every((key) => a[key] === b[key]);
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};
function checked(condition, message) {
  if (!condition) throw Error(message);
}
function directory(file) {
  const stat = fs.lstatSync(file);
  checked(stat.isDirectory() && !stat.isSymbolicLink(), '备份管理不支持链接或异常目录');
  const real = fs.realpathSync(file);
  checked(normalized(real) === normalized(file), '备份管理目录发生跳转');
  return real;
}
function rootOf(saves) {
  checked(
    saves && typeof saves.root === 'string' && typeof saves.verify === 'function',
    '完整备份管理器无效',
  );
  return directory(saves.root);
}
function selected(ids) {
  checked(
    Array.isArray(ids) &&
      ids.length > 0 &&
      ids.length <= 1000 &&
      ids.every(idOK) &&
      new Set(ids).size === ids.length,
    '请选择 1 至 1000 个不重复的本机完整备份编号',
  );
  return ids.slice();
}
function stableFile(file, limit) {
  const before = fs.lstatSync(file, { bigint: true });
  checked(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit),
    '备份管理拒绝链接、额外副本或异常文件',
  );
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    checked(sameStamp(before, fs.fstatSync(handle, { bigint: true })), '备份文件在读取前发生变化');
    const bytes = fs.readFileSync(handle),
      after = fs.lstatSync(file, { bigint: true });
    checked(
      sameStamp(before, after) &&
        sameStamp(after, fs.fstatSync(handle, { bigint: true })) &&
        BigInt(bytes.length) === after.size,
      '备份文件在读取期间发生变化',
    );
    return { bytes, sha256: sha(bytes), stat: after };
  } finally {
    fs.closeSync(handle);
  }
}
function json(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('备份管理元数据无法读取');
  }
}
function validateManifest(manifest, id, root) {
  checked(
    manifest &&
      manifest.schema === 1 &&
      manifest.id === id &&
      idOK(id) &&
      typeof manifest.label === 'string' &&
      manifest.label.length <= 100 &&
      typeof manifest.kind === 'string' &&
      manifest.kind.length <= 80 &&
      typeof manifest.createdAt === 'string' &&
      !Number.isNaN(Date.parse(manifest.createdAt)) &&
      typeof manifest.source === 'string' &&
      manifest.source.length > 0 &&
      (manifest.locked === undefined || typeof manifest.locked === 'boolean') &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 1000,
    '完整备份清单无效',
  );
  checked(
    !within(manifest.source, root) && !within(root, manifest.source),
    '完整备份目录不能与游戏存档来源重叠',
  );
  let total = 0;
  const names = new Set();
  for (const file of manifest.files) {
    checked(
      file &&
        nameOK(file.name) &&
        !names.has(file.name.toLowerCase()) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= MAX_FILE &&
        hashOK(file.sha256) &&
        typeof file.modifiedAt === 'string' &&
        !Number.isNaN(Date.parse(file.modifiedAt)),
      '完整备份包含无效文件',
    );
    names.add(file.name.toLowerCase());
    total += file.bytes;
  }
  checked(
    total <= MAX_BACKUP && manifest.files.some((file) => /\.sav$/i.test(file.name)),
    '完整备份大小或存档内容无效',
  );
  return manifest;
}
function isBackupLocked(manifest) {
  return manifest.locked === true || (manifest.kind === 'safety' && manifest.locked !== false);
}
function verification(bytes) {
  const value = json(bytes);
  checked(
    value &&
      Object.keys(value).every((key) => ['schema', 'at', 'error'].includes(key)) &&
      value.schema === 1 &&
      Number.isSafeInteger(value.at) &&
      typeof value.error === 'string' &&
      value.error.length <= 600,
    '副本校验记录无效',
  );
}
const descriptors = (manifest) =>
  manifest.files.map((file) => [file.name, file.bytes, file.sha256]).sort((a, b) => a[0].localeCompare(b[0]));
function inspectBackup(root, dir, id, { forLock = false } = {}) {
  directory(dir);
  const manifestRead = stableFile(path.join(dir, 'manifest.json'), MAX_META);
  const manifest = validateManifest(json(manifestRead.bytes), id, root);
  const allowed = new Set([
    'manifest.json',
    'manifest.json.previous',
    'files',
    'verification.json',
    'verification.json.previous',
  ]);
  if (!forLock)
    checked(
      fs.readdirSync(dir).every((name) => allowed.has(name)),
      '副本中存在未知文件或目录，已保留全部内容',
    );
  const filesDir = directory(path.join(dir, 'files'));
  const names = fs.readdirSync(filesDir).sort(),
    expected = manifest.files.map((file) => file.name).sort();
  checked(
    JSON.stringify(names) === JSON.stringify(expected),
    '副本文件目录包含未知或缺失内容，已保留全部内容',
  );
  const files = [{ name: 'manifest.json', bytes: manifestRead.bytes.length, sha256: manifestRead.sha256 }];
  for (const file of manifest.files) {
    const read = stableFile(path.join(filesDir, file.name), MAX_FILE);
    checked(
      read.bytes.length === file.bytes && read.sha256 === file.sha256,
      '完整备份字节校验失败：' + file.name,
    );
    files.push({ name: 'files/' + file.name, bytes: read.bytes.length, sha256: read.sha256 });
  }
  const metadataNames = forLock
    ? ['manifest.json.previous']
    : ['manifest.json.previous', 'verification.json', 'verification.json.previous'];
  for (const name of metadataNames) {
    if (!exists(path.join(dir, name))) continue;
    const read = stableFile(path.join(dir, name), name.startsWith('manifest') ? MAX_META : 4096);
    if (name.startsWith('manifest')) {
      const previous = json(read.bytes),
        imported = manifest.importedFrom;
      const migratedPrevious =
        forLock &&
        manifest.kind === 'imported' &&
        imported &&
        idOK(imported.id) &&
        hashOK(imported.provenanceHash) &&
        imported.createdAt === previous.createdAt &&
        previous.id === imported.id &&
        previous.source === '' &&
        previous.readOnly === true &&
        previous.bound === false &&
        previous.provenanceEntry === `originals/save-backups/${imported.id}/manifest.json`;
      if (migratedPrevious) validateManifest({ ...previous, source: manifest.source }, imported.id, root);
      else {
        validateManifest(previous, id, root);
        checked(
          previous.source === manifest.source &&
            previous.kind === manifest.kind &&
            previous.createdAt === manifest.createdAt,
          '副本的 previous 清单不是同一份完整备份',
        );
      }
      checked(
        JSON.stringify(descriptors(previous)) === JSON.stringify(descriptors(manifest)),
        '副本的 previous 清单不是同一份完整备份',
      );
    } else verification(read.bytes);
    files.push({ name, bytes: read.bytes.length, sha256: read.sha256 });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    id,
    label: manifest.label,
    createdAt: manifest.createdAt,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
    manifest,
  };
}
const snapshot = ({ manifest, ...value }) => value;
const sameInventory = (actual, expected) => JSON.stringify(actual.files) === JSON.stringify(expected.files);
function assertUnlocked(backup) {
  checked(
    !isBackupLocked(backup.manifest),
    '副本「' + backup.label + '」已锁定；保护副本须先明确解锁并重新导出',
  );
}
function setBackupLock({ saves, id, locked }) {
  checked(idOK(id) && typeof locked === 'boolean', '副本编号或锁定状态无效');
  checked(!saves.busy, '存档操作进行中，请稍后重试');
  const root = rootOf(saves);
  checked(!listPending({ saves }).some((item) => item.blocking !== false), '请先处理尚未完成的副本清理');
  saves.busy = true;
  try {
    saves.verify(id);
    const backup = inspectBackup(root, path.join(root, id), id, { forLock: true });
    const manifest = { ...backup.manifest, locked };
    atomicWrite(path.join(root, id, 'manifest.json'), manifest);
    const after = inspectBackup(root, path.join(root, id), id, { forLock: true });
    checked(
      after.manifest.locked === locked &&
        JSON.stringify(descriptors(after.manifest)) === JSON.stringify(descriptors(backup.manifest)),
      '副本锁定写入校验失败',
    );
    return { id, locked, bytes: backup.manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
  } finally {
    saves.busy = false;
  }
}
async function packageIndex(root, packageFile, expectedPackageHash) {
  checked(
    typeof packageFile === 'string' && packageFile.length > 0 && hashOK(expectedPackageHash),
    '请选择刚刚核验的完整保护包',
  );
  checked(!within(packageFile, root), '导出保护包必须保留在完整备份目录之外');
  const file = path.resolve(packageFile),
    before = fs.lstatSync(file, { bigint: true });
  checked(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      !within(fs.realpathSync(file), root),
    '保护包不支持链接或位于清理目录内',
  );
  const result = await readProtectionIndex({ file });
  const after = fs.lstatSync(file, { bigint: true });
  checked(
    sameStamp(before, after) && result.packageHash === expectedPackageHash,
    '保护包在确认后发生变化，请重新导出并确认',
  );
  return { entries: new Map(result.manifest.entries.map((entry) => [entry.path, entry])), stat: after, file };
}
function exported(index, backup) {
  for (const file of backup.files) {
    const logical =
      file.name === 'manifest.json'
        ? `originals/save-backups/${backup.id}/manifest.json`
        : file.name.startsWith('files/')
          ? `save-backups/${backup.id}/${file.name}`
          : null;
    if (!logical) continue;
    const entry = index.entries.get(logical);
    checked(
      entry && entry.bytes === file.bytes && entry.sha256 === file.sha256,
      '所选副本与完整保护包不完全一致，请重新导出',
    );
  }
}
function receiptValue(value, id) {
  checked(
    value &&
      value.schema === 1 &&
      value.kind === 'yijian-backup-cleanup' &&
      value.id === id &&
      transactionOK(id) &&
      hashOK(value.packageHash) &&
      typeof value.createdAt === 'string' &&
      !Number.isNaN(Date.parse(value.createdAt)) &&
      ['staging', 'ready', 'deleting', 'complete', 'rolled-back'].includes(value.phase) &&
      Array.isArray(value.backups),
    '副本清理凭据无效，残留内容已保留',
  );
  selected(value.ids);
  checked(
    value.backups.length === value.ids.length &&
      value.backups.every((backup, position) => {
        if (
          !backup ||
          backup.id !== value.ids[position] ||
          typeof backup.label !== 'string' ||
          backup.label.length > 100 ||
          typeof backup.createdAt !== 'string' ||
          Number.isNaN(Date.parse(backup.createdAt)) ||
          !Number.isSafeInteger(backup.bytes) ||
          backup.bytes < 0 ||
          !Array.isArray(backup.files) ||
          backup.files.length < 2 ||
          backup.files.length > 1004
        )
          return false;
        const names = new Set();
        let total = 0;
        for (const file of backup.files) {
          if (
            !file ||
            typeof file.name !== 'string' ||
            names.has(file.name.toLowerCase()) ||
            !hashOK(file.sha256) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0
          )
            return false;
          const data = file.name.startsWith('files/') && nameOK(file.name.slice(6));
          const metadata = [
            'manifest.json',
            'manifest.json.previous',
            'verification.json',
            'verification.json.previous',
          ].includes(file.name);
          if (
            (!data && !metadata) ||
            file.bytes > (data ? MAX_FILE : file.name.startsWith('manifest') ? MAX_META : 4096)
          )
            return false;
          names.add(file.name.toLowerCase());
          total += file.bytes;
        }
        return (
          names.has('manifest.json') &&
          [...names].some((name) => /^files\/.+\.sav$/i.test(name)) &&
          total === backup.bytes &&
          total <= MAX_BACKUP + 2 * MAX_META + 8192
        );
      }),
    '副本清理凭据的精确文件列表无效',
  );
  return value;
}
function receiptTempName(name) {
  return (
    name.startsWith(RECEIPT + '.') &&
    name.endsWith('.tmp') &&
    transactionOK(name.slice(RECEIPT.length + 1, -4))
  );
}
function receiptTemps(dir, names) {
  const temporary = names.filter(receiptTempName);
  for (const name of temporary) {
    const file = path.join(dir, name),
      before = fs.lstatSync(file, { bigint: true });
    checked(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        before.size <= BigInt(MAX_RECEIPT),
      '清理临时记录包含链接或异常对象，内容已保留',
    );
    const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      checked(
        sameStamp(before, fs.fstatSync(handle, { bigint: true })) &&
          sameStamp(before, fs.lstatSync(file, { bigint: true })),
        '清理临时记录在检查期间发生变化',
      );
    } finally {
      fs.closeSync(handle);
    }
  }
  // These bytes never supply a phase, backup selection, hash, or deletion permission.
  return temporary;
}
function unstartedSummary(id, dir) {
  const names = fs.readdirSync(dir),
    temporary = receiptTemps(dir, names);
  checked(names.length === temporary.length, '未提交的清理目录包含副本或未知对象，内容已保留');
  return {
    id,
    ids: [],
    packageHash: '',
    phase: 'unstarted',
    backups: [],
    blocking: false,
    canFinish: false,
    canRollback: false,
    error: '清理记录尚未提交，暂存目录没有副本内容。临时记录已保留，请重新选择副本并导出确认。',
  };
}
function readReceipt(root, id) {
  checked(transactionOK(id), '副本清理事务编号无效');
  const dir = directory(path.join(directory(path.join(root, CARE)), id));
  checked(
    exists(path.join(dir, RECEIPT)),
    '清理记录尚未提交，未取得副本删除授权；请重新选择完整副本并导出确认',
  );
  const receipt = receiptValue(json(stableFile(path.join(dir, RECEIPT), MAX_RECEIPT).bytes), id);
  if (exists(path.join(dir, RECEIPT + '.previous'))) {
    const previous = receiptValue(
      json(stableFile(path.join(dir, RECEIPT + '.previous'), MAX_RECEIPT).bytes),
      id,
    );
    checked(
      previous.packageHash === receipt.packageHash &&
        JSON.stringify(previous.backups) === JSON.stringify(receipt.backups) &&
        JSON.stringify(previous.ids) === JSON.stringify(receipt.ids),
      '副本清理 previous 凭据不一致',
    );
  }
  const names = fs.readdirSync(dir),
    temporary = receiptTemps(dir, names);
  const allowed = new Set([RECEIPT, RECEIPT + '.previous', ...receipt.ids, ...temporary]);
  checked(
    names.every((name) => allowed.has(name)),
    '副本清理目录包含未知对象，内容已保留',
  );
  return { dir, receipt };
}
function pendingSummary(receipt) {
  return {
    id: receipt.id,
    ids: receipt.ids.slice(),
    packageHash: receipt.packageHash,
    phase: receipt.phase,
    backups: receipt.backups.map(({ id, label, createdAt, bytes }) => ({ id, label, createdAt, bytes })),
    canRollback: ['staging', 'ready'].includes(receipt.phase),
    canFinish: true,
    blocking: true,
    error: '',
  };
}
function listPending({ saves }) {
  const root = rootOf(saves),
    care = path.join(root, CARE);
  if (!exists(care)) return [];
  try {
    directory(care);
  } catch (e) {
    return [
      {
        id: '',
        ids: [],
        phase: 'blocked',
        canRollback: false,
        canFinish: false,
        blocking: true,
        error: e.message,
      },
    ];
  }
  return fs
    .readdirSync(care)
    .sort()
    .flatMap((id) => {
      try {
        checked(transactionOK(id), '副本清理事务编号无效');
        const transactionDir = directory(path.join(care, id));
        if (!exists(path.join(transactionDir, RECEIPT))) return [unstartedSummary(id, transactionDir)];
        const { dir, receipt } = readReceipt(root, id);
        if (['complete', 'rolled-back'].includes(receipt.phase)) {
          checked(
            fs
              .readdirSync(dir)
              .every((name) => [RECEIPT, RECEIPT + '.previous'].includes(name) || receiptTempName(name)),
            '已结束的副本清理仍有残留对象，内容已保留',
          );
          return [];
        }
        return [pendingSummary(receipt)];
      } catch (e) {
        return [
          {
            id,
            ids: [],
            phase: 'blocked',
            canRollback: false,
            canFinish: false,
            blocking: true,
            error: e.message,
          },
        ];
      }
    });
}
function saveReceipt(dir, receipt, phase) {
  receipt.phase = phase;
  atomicWrite(path.join(dir, RECEIPT), receipt);
}
function located(root, dir, id, allowAbsent = false) {
  const original = path.join(root, id),
    moved = path.join(dir, id),
    inRoot = exists(original),
    inStage = exists(moved);
  checked(!(inRoot && inStage), '原副本编号已被其他内容占用，已保留全部内容');
  checked(allowAbsent || inRoot || inStage, '清理中的副本缺失，已保留剩余内容');
  return inStage ? moved : inRoot ? original : null;
}
function checkComplete(root, dir, receipt, index) {
  return receipt.backups.map((expected) => {
    const location = located(root, dir, expected.id);
    const actual = inspectBackup(root, location, expected.id);
    assertUnlocked(actual);
    checked(sameInventory(actual, expected), '所选副本在确认后发生变化，全部清理已停止');
    if (index) exported(index, expected);
    return { expected, location };
  });
}
function restoreDirectories(root, dir, receipt) {
  const moved = receipt.ids.filter((id) => exists(path.join(dir, id)));
  for (const id of moved) {
    directory(path.join(dir, id));
    checked(!exists(path.join(root, id)), '无法回滚：原副本编号已被其他内容占用；暂存副本已保留');
  }
  for (const id of moved) fs.renameSync(path.join(dir, id), path.join(root, id));
  saveReceipt(dir, receipt, 'rolled-back');
}
function inspectRemaining(root, dir, receipt, index) {
  for (const expected of receipt.backups) {
    exported(index, expected);
    checked(!exists(path.join(root, expected.id)), '删除中的原副本编号已被其他内容占用，内容已保留');
    const location = path.join(dir, expected.id);
    if (!exists(location)) continue;
    directory(location);
    const inventory = new Map(expected.files.map((file) => [file.name, file]));
    const metadata = new Set(
      expected.files.filter((file) => !file.name.startsWith('files/')).map((file) => file.name),
    );
    checked(
      fs.readdirSync(location).every((name) => name === 'files' || metadata.has(name)),
      '删除暂存副本出现未知对象，内容已保留',
    );
    if (exists(path.join(location, 'files'))) {
      directory(path.join(location, 'files'));
      checked(
        fs.readdirSync(path.join(location, 'files')).every((name) => inventory.has('files/' + name)),
        '删除暂存副本出现未知文件，内容已保留',
      );
    }
    for (const file of expected.files) {
      const target = path.join(location, ...file.name.split('/'));
      if (!exists(target)) continue;
      const read = stableFile(
        target,
        file.name.startsWith('files/') ? MAX_FILE : file.name.startsWith('manifest') ? MAX_META : 4096,
      );
      checked(
        read.bytes.length === file.bytes && read.sha256 === file.sha256,
        '删除暂存副本发生变化，内容已保留',
      );
      if (file.name.startsWith('manifest')) {
        const manifest = validateManifest(json(read.bytes), expected.id, root);
        if (file.name === 'manifest.json') assertUnlocked({ manifest, label: manifest.label });
        checked(
          JSON.stringify(descriptors(manifest)) ===
            JSON.stringify(
              expected.files
                .filter((item) => item.name.startsWith('files/'))
                .map((item) => [item.name.slice(6), item.bytes, item.sha256])
                .sort((a, b) => a[0].localeCompare(b[0])),
            ),
          '暂存 previous 清单与导出文件不一致',
        );
      } else if (file.name.startsWith('verification')) verification(read.bytes);
    }
  }
}
function assertPackagePresent(index) {
  checked(
    sameStamp(index.stat, fs.lstatSync(index.file, { bigint: true })),
    '保护包在清理期间发生变化；剩余副本已保留',
  );
}
async function checkpoint(hook, phase, data = {}) {
  if (hook) await hook({ phase, ...data });
}
async function removePayload(root, dir, receipt, index, hook) {
  // Every unlink names an audited file. Empty directories are removed with rmdir, never recursive deletion.
  inspectRemaining(root, dir, receipt, index);
  for (const backup of receipt.backups) {
    const location = path.join(dir, backup.id);
    if (!exists(location)) continue;
    const order = backup.files
      .slice()
      .sort(
        (a, b) =>
          (a.name === 'manifest.json') - (b.name === 'manifest.json') ||
          Number(!a.name.startsWith('files/')) - Number(!b.name.startsWith('files/')) ||
          a.name.localeCompare(b.name),
      );
    for (const file of order) {
      const target = path.join(location, ...file.name.split('/'));
      if (!exists(target)) continue;
      directory(location);
      if (file.name.startsWith('files/')) directory(path.join(location, 'files'));
      assertPackagePresent(index);
      const read = stableFile(target, file.name.startsWith('files/') ? MAX_FILE : MAX_META);
      checked(
        read.bytes.length === file.bytes && read.sha256 === file.sha256,
        '暂存副本在删除前发生变化，内容已保留',
      );
      checked(
        sameStamp(read.stat, fs.lstatSync(target, { bigint: true })),
        '暂存文件在删除前发生变化，内容已保留',
      );
      fs.unlinkSync(target);
      await checkpoint(hook, 'file-deleted', { id: backup.id, name: file.name });
    }
    if (exists(path.join(location, 'files'))) {
      directory(path.join(location, 'files'));
      fs.rmdirSync(path.join(location, 'files'));
    }
    directory(location);
    fs.rmdirSync(location);
  }
  saveReceipt(dir, receipt, 'complete');
  return {
    id: receipt.id,
    ids: receipt.ids.slice(),
    count: receipt.ids.length,
    bytes: receipt.backups.reduce((sum, backup) => sum + backup.bytes, 0),
    packageHash: receipt.packageHash,
    phase: 'complete',
  };
}
async function stageAndDelete(
  root,
  dir,
  receipt,
  packageFile,
  expectedPackageHash,
  hook,
  autoRollback = false,
) {
  let deleting = receipt.phase === 'deleting';
  try {
    checked(receipt.packageHash === expectedPackageHash, '恢复清理必须使用原先确认的完整保护包');
    let index = await packageIndex(root, packageFile, expectedPackageHash);
    if (!deleting) {
      const group = checkComplete(root, dir, receipt, index);
      for (const { expected, location } of group) {
        if (normalized(location) === normalized(path.join(root, expected.id))) {
          const actual = inspectBackup(root, location, expected.id);
          assertUnlocked(actual);
          checked(sameInventory(actual, expected), '副本在暂存前发生变化');
          fs.renameSync(location, path.join(dir, expected.id));
          await checkpoint(hook, 'backup-staged', { id: expected.id, transactionId: receipt.id });
        }
      }
      checkComplete(root, dir, receipt, index);
      saveReceipt(dir, receipt, 'ready');
      await checkpoint(hook, 'before-delete', { transactionId: receipt.id });
      index = await packageIndex(root, packageFile, expectedPackageHash);
      checkComplete(root, dir, receipt, index);
      saveReceipt(dir, receipt, 'deleting');
      deleting = true;
    }
    return await removePayload(root, dir, receipt, index, hook);
  } catch (error) {
    if (!deleting && autoRollback) {
      try {
        restoreDirectories(root, dir, receipt);
      } catch (rollbackError) {
        error.message += '；' + rollbackError.message;
      }
    } else error.message += '；未完成清理已记录，可在应用中重新核验保护包后继续';
    throw error;
  }
}
async function cleanupExportedBackups({ saves, ids, packageFile, expectedPackageHash, onCheckpoint }) {
  const exactIds = selected(ids),
    root = rootOf(saves);
  checked(!saves.busy, '存档操作进行中，请稍后重试');
  checked(!listPending({ saves }).some((item) => item.blocking !== false), '请先处理尚未完成的副本清理');
  saves.busy = true;
  try {
    const index = await packageIndex(root, packageFile, expectedPackageHash);
    const backups = exactIds.map((id) => {
      saves.verify(id);
      const backup = inspectBackup(root, path.join(root, id), id);
      assertUnlocked(backup);
      exported(index, backup);
      return snapshot(backup);
    });
    await checkpoint(onCheckpoint, 'validated');
    const secondIndex = await packageIndex(root, packageFile, expectedPackageHash);
    for (const backup of backups) {
      const actual = inspectBackup(root, path.join(root, backup.id), backup.id);
      assertUnlocked(actual);
      checked(sameInventory(actual, backup), '所选副本在确认后发生变化');
      exported(secondIndex, actual);
    }
    const care = path.join(root, CARE);
    if (!exists(care)) fs.mkdirSync(care);
    directory(care);
    const id = crypto.randomUUID(),
      dir = path.join(care, id);
    const receipt = {
      schema: 1,
      kind: 'yijian-backup-cleanup',
      id,
      createdAt: new Date().toISOString(),
      packageHash: expectedPackageHash,
      ids: exactIds,
      backups,
      phase: 'staging',
    };
    checked(
      Buffer.byteLength(JSON.stringify(receipt, null, 2)) <= MAX_RECEIPT,
      '这批副本的清理凭据超过容量，请缩小选择范围',
    );
    fs.mkdirSync(dir);
    atomicWrite(path.join(dir, RECEIPT), receipt);
    return await stageAndDelete(root, dir, receipt, packageFile, expectedPackageHash, onCheckpoint, true);
  } finally {
    saves.busy = false;
  }
}
async function finishPending({ saves, id, packageFile, expectedPackageHash, onCheckpoint }) {
  const root = rootOf(saves);
  checked(!saves.busy, '存档操作进行中，请稍后重试');
  saves.busy = true;
  try {
    const { dir, receipt } = readReceipt(root, id);
    checked(!['complete', 'rolled-back'].includes(receipt.phase), '这次副本清理已经结束');
    return await stageAndDelete(root, dir, receipt, packageFile, expectedPackageHash, onCheckpoint);
  } finally {
    saves.busy = false;
  }
}
function rollbackPending({ saves, id }) {
  const root = rootOf(saves);
  checked(!saves.busy, '存档操作进行中，请稍后重试');
  saves.busy = true;
  try {
    const { dir, receipt } = readReceipt(root, id);
    checked(
      ['staging', 'ready'].includes(receipt.phase),
      '副本已开始删除；请重新核验原保护包后继续，不能回滚不完整副本',
    );
    checkComplete(root, dir, receipt);
    restoreDirectories(root, dir, receipt);
    return { id, ids: receipt.ids.slice(), phase: 'rolled-back' };
  } finally {
    saves.busy = false;
  }
}

module.exports = {
  isBackupLocked,
  setBackupLock,
  cleanupExportedBackups,
  listPending,
  finishPending,
  rollbackPending,
};
