'use strict';
// This module can replace only the assistant's journal. It never creates Saves,
// Timeline or GameBridge, and never interprets an imported game path as a target.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateState, defaults, atomicWrite, MAX_JOURNAL_BYTES } = require('./store.cjs');
const migration = require('./migration.cjs');
const collection = require('./protection-collection.cjs');
const { volumeFiles } = require('./complete-migration.cjs');
const MARKER = 'journal-recovery-isolation.json';
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
function safeDirectory(value) {
  const resolved = path.resolve(value),
    parsed = path.parse(resolved);
  check(
    !resolved.split(/[\\/]/).some((part) => /^savegames$/i.test(part)),
    '恢复资料不能使用游戏 SaveGames 目录',
  );
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), '恢复目录不能使用链接或外部重定向');
  }
  return fs.realpathSync(resolved);
}
function stamp(stat) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => String(stat[key])).join(':');
}
function fileSnapshot(file, { optional = false, maxBytes } = {}) {
  safeDirectory(path.dirname(file));
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch (e) {
    if (optional && e.code === 'ENOENT') return null;
    throw e;
  }
  check(stat.isFile() && !stat.isSymbolicLink(), '恢复资料不能使用链接文件或目录');
  check(
    maxBytes === undefined || stat.size <= BigInt(maxBytes),
    '手札文件超过 32 MB，请重新选择正确的导出文件',
  );
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = crypto.createHash('sha256'),
    buffer = Buffer.alloc(64 * 1024);
  try {
    check(stamp(fs.fstatSync(fd, { bigint: true })) === stamp(stat), '资料打开时发生变化，请重新选择');
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    check(
      stamp(fs.fstatSync(fd, { bigint: true })) === stamp(stat) &&
        stamp(fs.lstatSync(file, { bigint: true })) === stamp(stat),
      '资料读取时发生变化，请重新选择',
    );
    safeDirectory(path.dirname(file));
    return {
      file: path.resolve(file),
      stamp: stamp(stat),
      sha256: hash.digest('hex'),
      bytes: Number(stat.size),
    };
  } finally {
    fs.closeSync(fd);
  }
}
function sameSnapshots(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function isolation(dataRoot) {
  const root = safeDirectory(dataRoot),
    file = path.join(root, MARKER);
  if (!fs.existsSync(file)) return null;
  fileSnapshot(file, { maxBytes: 4096 });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(
    value?.schema === 1 &&
      value.disableAutoDiscovery === true &&
      /^game-timeline-recovered-[a-f0-9-]{36}$/.test(value.timelineDirectory) &&
      /^game-bridge-recovered-[a-f0-9-]{36}$/.test(value.bridgeDirectory) &&
      /^journal-recovery-[a-f0-9-]{36}$/.test(value.retainedDirectory) &&
      Object.keys(value).every((key) =>
        [
          'schema',
          'disableAutoDiscovery',
          'timelineDirectory',
          'bridgeDirectory',
          'retainedDirectory',
        ].includes(key),
      ),
    '恢复隔离记录无法读取，原件已保留；请检查本机数据目录',
  );
  return value;
}
const PROFILE_FIELDS = [
  'id',
  'name',
  'stage',
  'stageConfirmed',
  'checks',
  'favorites',
  'goals',
  'notes',
  'noteRevisions',
  'createdAt',
  'updatedAt',
  'craftList',
  'previousCraftList',
  'previousCraftChoices',
  'craftPlans',
  'craftChoices',
  'activeCraftPlanId',
  'previousCraftContext',
  'reserveCraftDraft',
  'recentSearches',
  'savedSearches',
  'journey',
  'journalEntries',
  'journalDrafts',
  'journalTrash',
  'journalRevisions',
  'intentDrafts',
  'journeyTrash',
  'resourcePriority',
  'reservations',
  'allocations',
];
function localJournal(incoming, ids) {
  validateState(incoming, ids);
  const settings = defaults().settings;
  Object.assign(settings, {
    autoBackup: false,
    savePath: '',
    steamPath: '',
    offerAutoSaveOnStart: false,
    companionEnabled: false,
    spoiler: incoming.settings.spoiler,
  });
  const profiles = incoming.profiles.map((profile) => {
    const copy = Object.fromEntries(
      PROFILE_FIELDS.filter((key) => profile[key] !== undefined).map((key) => [key, clone(profile[key])]),
    );
    return { ...copy, saveSlot: '', referenceMode: 'none' };
  });
  return validateState(
    {
      schema: 1,
      activeProfileId: incoming.activeProfileId,
      profiles,
      settings,
      updatedAt: incoming.updatedAt || '1970-01-01T00:00:00.000Z',
    },
    ids,
  );
}
async function removeOwnStage(directory, identity) {
  // A unique, caller-created staging tree only; unknown objects are preserved.
  async function inspect(root) {
    safeDirectory(root);
    for (const item of await fsp.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, item.name),
        stat = await fsp.lstat(file);
      check(!stat.isSymbolicLink(), '临时目录包含链接，已保留');
      if (stat.isDirectory()) await inspect(file);
      else check(stat.isFile(), '临时目录包含未知对象，已保留');
    }
  }
  try {
    const originalRoot = async () => {
      const stat = await fsp.lstat(directory, { bigint: true });
      check(
        stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.dev === identity.dev &&
          stat.ino === identity.ino,
        '临时目录已被替换，已保留',
      );
    };
    await originalRoot();
    await inspect(directory);
    await originalRoot();
    await fsp.rm(directory, { recursive: true });
  } catch {
    /* A replaced or linked object is never followed or removed. */
  }
}
class StartupRecovery {
  constructor(dataRoot, catalog, { write = atomicWrite } = {}) {
    this.root = safeDirectory(dataRoot);
    this.ids = new Set(catalog.entries.map((entry) => entry.id));
    this.write = write;
    this.originals = this.snapshotOriginals();
    this.pending = null;
    this.busy = false;
  }
  snapshotOriginals() {
    return ['journal.json', 'journal.json.previous'].map((name) =>
      fileSnapshot(path.join(this.root, name), { optional: true }),
    );
  }
  status() {
    return {
      directory: this.root,
      originals: ['journal.json', 'journal.json.previous'],
      message: '当前手札和上一份记录都无法读取。原件仍在本机，尚未替换。',
    };
  }
  async readSelection(mode, selection) {
    check(['json', 'protection', 'volumes'].includes(mode), '恢复资料类型无效');
    check(
      typeof selection === 'string' && selection.length > 0 && selection.length <= 4000,
      '请选择恢复资料',
    );
    if (mode === 'json') {
      const before = fileSnapshot(selection, { maxBytes: MAX_JOURNAL_BYTES });
      let incoming;
      try {
        incoming = JSON.parse(fs.readFileSync(selection, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        throw Error('这份 JSON 手札无法读取，请重新选择手札导出的完整 JSON 文件');
      }
      const state = localJournal(incoming, this.ids);
      check(
        sameSnapshots(before, fileSnapshot(selection, { maxBytes: MAX_JOURNAL_BYTES })),
        '手札在校验时发生变化，请重新选择',
      );
      return {
        state,
        sources: [before],
        createdAt: incoming.updatedAt || '',
        kind: 'JSON 手札',
        ignoredBackups: 0,
        ignoredNodes: 0,
      };
    }
    const boundary = {
      assertSeparated: (target) =>
        safeDirectory(mode === 'volumes' && target === selection ? target : path.dirname(target)),
    };
    const files =
      mode === 'volumes'
        ? await volumeFiles({ archives: boundary, directory: safeDirectory(selection) })
        : [selection];
    const sources = [
      ...(mode === 'volumes'
        ? [fileSnapshot(path.join(selection, 'transfer.json'), { maxBytes: 1024 * 1024 })]
        : []),
      ...files.map((file) => fileSnapshot(file)),
    ];
    const working = path.join(this.root, 'journal-recovery-work');
    if (!fs.existsSync(working)) fs.mkdirSync(working);
    safeDirectory(working);
    const stage = await fsp.mkdtemp(path.join(working, 'verify-'));
    const stageIdentity = await fsp.lstat(stage, { bigint: true });
    let state,
      stateHash,
      createdAt = '',
      ignoredBackups = 0,
      ignoredNodes = 0;
    try {
      for (const [index, file] of files.entries()) {
        let currentFile = file,
          preview;
        if (await collection.isCollection(file)) {
          const scanned = await collection.scanCollection({
            file,
            extractionDirectory: path.join(stage, 'collection-' + index),
          });
          currentFile = scanned.components[0].file;
          preview = scanned.components[0].preview;
          for (const component of scanned.components) {
            ignoredBackups += component.preview.backups.length;
            ignoredNodes += component.preview.nodes;
          }
        } else {
          preview = await migration.previewProtection({ file });
          ignoredBackups += preview.backups.length;
          ignoredNodes += preview.nodes;
        }
        const imported = await migration.importProtection({
          file: currentFile,
          targetDirectory: path.join(stage, 'current-' + index),
          expectedPackageHash: preview.packageHash,
        });
        const history = await migration.readHistory({ directory: imported.directory });
        const candidate = localJournal(history.journal, this.ids),
          candidateHash = digest(JSON.stringify(candidate));
        check(
          stateHash === undefined || stateHash === candidateHash,
          '分卷包含不同的当前手札，请选择同一次导出的完整分卷目录',
        );
        if (!state) {
          state = candidate;
          stateHash = candidateHash;
          createdAt = history.createdAt || preview.createdAt;
        }
      }
      const after = sources.map((source) => fileSnapshot(source.file));
      check(sameSnapshots(sources, after), '保护资料在校验时发生变化，请重新选择');
      return {
        state,
        sources,
        createdAt,
        kind: mode === 'volumes' ? '完整分卷保护包' : '完整保护包',
        ignoredBackups,
        ignoredNodes,
      };
    } finally {
      await removeOwnStage(stage, stageIdentity);
    }
  }
  async preview(mode, selection) {
    check(!this.busy, '正在校验恢复资料，请稍候');
    this.busy = true;
    this.pending = null;
    try {
      const value = await this.readSelection(mode, selection),
        token = crypto.randomUUID();
      this.pending = { ...value, mode, selection, token };
      return this.previewSummary(path.basename(selection));
    } finally {
      this.busy = false;
    }
  }
  async prepareNew() {
    check(!this.busy, '正在处理恢复资料，请稍候');
    this.busy = true;
    this.pending = null;
    try {
      // Defaults are created only in memory after the explicit new-journal
      // choice. Corrupt bytes never become defaults or a valid saved journal.
      const state = localJournal(defaults(), this.ids);
      this.pending = {
        state,
        sources: [],
        mode: 'new',
        token: crypto.randomUUID(),
        kind: '新手札（空白开始）',
        createdAt: state.updatedAt,
        ignoredBackups: 0,
        ignoredNodes: 0,
      };
      return this.previewSummary('不使用导出文件');
    } finally {
      this.busy = false;
    }
  }
  previewSummary(sourceName) {
    const value = this.pending;
    return {
      token: value.token,
      intent: value.mode === 'new' ? 'new' : 'restore',
      kind: value.kind,
      sourceName,
      createdAt: value.createdAt,
      profiles: value.state.profiles.map((profile) => ({
        name: profile.name,
        stage: profile.stage,
        goals: profile.goals.length,
        entries: profile.journalEntries?.length || 0,
        drafts: profile.journalDrafts?.length || 0,
        arrangementDrafts: profile.intentDrafts?.length || 0,
        deletedEntries: profile.journalTrash?.length || 0,
        recordVersions: profile.journalRevisions?.length || 0,
        noteVersions: profile.noteRevisions?.length || 0,
        removedArrangements: profile.journeyTrash?.length || 0,
      })),
      ignoredBackups: value.ignoredBackups,
      ignoredNodes: value.ignoredNodes,
    };
  }
  async confirm(token) {
    check(!this.busy, '正在恢复手札，请稍候');
    check(this.pending && token === this.pending.token, '恢复预览已失效，请重新选择并校验');
    this.busy = true;
    try {
      const pending = this.pending,
        fresh =
          pending.mode === 'new'
            ? { ...pending, state: validateState(clone(pending.state), this.ids) }
            : await this.readSelection(pending.mode, pending.selection);
      check(
        sameSnapshots(pending.sources, fresh.sources) &&
          digest(JSON.stringify(pending.state)) === digest(JSON.stringify(fresh.state)),
        '资料在预览后发生变化，请重新选择并确认',
      );
      check(
        sameSnapshots(this.originals, this.snapshotOriginals()),
        '本机原件在预览后发生变化；已停止替换，请退出并重新启动',
      );
      const id = crypto.randomUUID(),
        retainedDirectory = 'journal-recovery-' + id,
        retained = path.join(this.root, retainedDirectory);
      fs.mkdirSync(retained);
      for (const original of this.originals.filter(Boolean)) {
        const output = path.join(retained, path.basename(original.file));
        fs.copyFileSync(original.file, output, fs.constants.COPYFILE_EXCL);
        const fd = fs.openSync(output, 'r+');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const verified = fileSnapshot(output);
        check(
          verified.sha256 === original.sha256 && verified.bytes === original.bytes,
          '损坏原件的保护副本校验失败；原件未替换，请检查磁盘后重试',
        );
      }
      this.write(path.join(retained, 'receipt.json'), {
        schema: 1,
        mode: pending.mode === 'new' ? 'new' : 'restore',
        originals: this.originals
          .filter(Boolean)
          .map(({ file, sha256, bytes }) => ({ name: path.basename(file), sha256, bytes })),
        recoveredAt: new Date().toISOString(),
      });
      const marker = {
        schema: 1,
        disableAutoDiscovery: true,
        timelineDirectory: 'game-timeline-recovered-' + id,
        bridgeDirectory: 'game-bridge-recovered-' + id,
        retainedDirectory,
      };
      // The durable isolation gate precedes replacement, so a crash cannot
      // reopen recovered notes with old machine paths or native permissions.
      fileSnapshot(path.join(this.root, MARKER), { optional: true, maxBytes: 4096 });
      this.write(path.join(this.root, MARKER), marker, true);
      check(
        sameSnapshots(this.originals, this.snapshotOriginals()),
        '本机原件在保护复制时发生变化，已停止替换',
      );
      this.write(path.join(this.root, 'journal.json'), fresh.state, true);
      const saved = validateState(
        JSON.parse(fs.readFileSync(path.join(this.root, 'journal.json'), 'utf8')),
        this.ids,
      );
      check(
        digest(JSON.stringify(saved)) === digest(JSON.stringify(fresh.state)),
        '恢复写入未通过核对，请退出重启；保护原件仍在本机',
      );
      this.pending = null;
      return { retainedDirectory: retained, mode: pending.mode === 'new' ? 'new' : 'restore' };
    } finally {
      this.busy = false;
    }
  }
}
function recoveryError(error) {
  if (
    error?.code === 'ENOSPC' ||
    error?.code === 'EACCES' ||
    error?.code === 'EPERM' ||
    error?.code === 'EROFS'
  )
    return '恢复未完成：请检查本机数据目录的写入权限和磁盘空间，再重试。原件与已生成的保护副本仍保留。';
  const message = error?.message || '';
  if (/^[\x00-\x7F]+$/.test(message))
    return '这份恢复资料未通过完整校验。请重新选择手札导出的 JSON、完整保护包或同一次导出的全部分卷；当前手札原件未替换。';
  return message || '恢复未完成，请重新选择资料后重试；原件仍保留。';
}
module.exports = { StartupRecovery, isolation, recoveryError, safeDirectory, fileSnapshot, MARKER };
