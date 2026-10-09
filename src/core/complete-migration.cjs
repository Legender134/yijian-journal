'use strict';
// Complete migration keeps all generations as independent read-only archives.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const migration = require('./migration.cjs');
const codec = require('./protection-collection.cjs');
const { atomicWrite } = require('./store.cjs');
const { recordProtectionExportResult, readProtectionExportResult } = require('./backup-anomalies.cjs');
const check = (ok, message) => {
  if (!ok) throw Error(message);
};
const exportConfirmations = new Map(),
  CONFIRMATION_TTL_MS = 5 * 60 * 1000;
function confirmationExpired() {
  return Object.assign(Error('资料或导出范围已变化，或确认已过期；请重新发起导出并确认'), {
    code: 'HISTORY_EXPORT_CONFIRMATION_EXPIRED',
    recoverable: true,
  });
}
function requestExportConfirmation(failedArchives, snapshot) {
  const now = Date.now();
  for (const [token, value] of exportConfirmations)
    if (value.expiresAt <= now) exportConfirmations.delete(token);
  while (exportConfirmations.size >= 32) exportConfirmations.delete(exportConfirmations.keys().next().value);
  const confirmationToken = crypto.randomUUID();
  exportConfirmations.set(confirmationToken, { snapshot, expiresAt: now + CONFIRMATION_TTL_MS });
  return Object.assign(Error('无法校验历史档案；本次尚未导出任何资料，需要确认遗漏这些本机记录'), {
    code: 'HISTORY_EXPORT_CONFIRMATION_REQUIRED',
    recoverable: true,
    failedArchives,
    confirmationToken,
  });
}
// Failed files remain unverified. Their no-follow metadata fingerprint only
// detects changes while a confirmation is pending; it never proves equivalence.
async function historyState(archives, id) {
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id), '离线档案编号无效');
  const root = archives.root(),
    digest = crypto.createHash('sha256');
  let count = 0;
  async function visit(relative) {
    check(++count <= migration.DEFAULT_LIMITS.entries * 3, '历史档案目录数量超限，无法确认遗漏');
    const file = path.join(root, relative);
    let stat;
    try {
      stat = await fs.lstat(file, { bigint: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      digest.update(JSON.stringify([relative, 'missing']));
      return;
    }
    const identity = [stat.mode, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    digest.update(JSON.stringify([relative, ...identity]));
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      check((await fs.realpath(file)) === file, '历史档案目录发生变化');
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      const after = await fs.lstat(file, { bigint: true });
      check(
        identity.join(',') ===
          [after.mode, after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].map(String).join(','),
        '历史档案目录发生变化',
      );
    }
  }
  await visit(id);
  return digest.digest('hex');
}
async function staging(archives) {
  const parent = archives.root('protection-transfer'),
    directory = path.join(parent, crypto.randomUUID());
  await fs.mkdir(directory, { mode: 0o700 });
  const identity = await fs.lstat(directory, { bigint: true });
  return { directory, parent, identity };
}
async function cleanup(stage) {
  // Only our flat staging files and our new extraction directory are removed.
  // A replaced root or unexpected object is left intact for recovery.
  try {
    const now = await fs.lstat(stage.directory, { bigint: true });
    check(
      now.isDirectory() &&
        !now.isSymbolicLink() &&
        now.dev === stage.identity.dev &&
        now.ino === stage.identity.ino,
      '临时目录发生变化',
    );
    check(
      path.dirname(await fs.realpath(stage.directory)) === (await fs.realpath(stage.parent)),
      '临时目录越界',
    );
    for (const entry of await fs.readdir(stage.directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(current(?:-\d+)?|history-\d+|verify-\d+|volume-\d+)\.yijian-protection$/.test(entry.name)
      )
        await fs.unlink(path.join(stage.directory, entry.name));
      else if (entry.isDirectory() && entry.name === 'extracted') {
        const directory = path.join(stage.directory, entry.name);
        const extracted = await fs.lstat(directory);
        check(
          extracted.isDirectory() &&
            !extracted.isSymbolicLink() &&
            path.dirname(await fs.realpath(directory)) === (await fs.realpath(stage.directory)),
          '导入临时目录发生变化',
        );
        for (const component of await fs.readdir(directory, { withFileTypes: true })) {
          if (!component.isFile() || !/^\d+\.yijian-protection$/.test(component.name))
            throw Error('导入临时资料异常');
          await fs.unlink(path.join(directory, component.name));
        }
        await fs.rmdir(directory);
      } else throw Error('保留未知临时资料');
    }
    await fs.rmdir(stage.directory);
  } catch {
    /* Preserve uncertain objects, never follow links or delete other files. */
  }
}
function previewView(scanned) {
  const current = scanned.components[0].preview,
    histories = scanned.components.slice(1);
  return {
    ...current,
    packageHash: scanned.packageHash,
    collection: true,
    createdAt: scanned.createdAt,
    historicalArchives: histories.length,
    historicalBackups: histories.reduce((sum, c) => sum + c.preview.backups.length, 0),
    historicalNodes: histories.reduce((sum, c) => sum + c.preview.nodes, 0),
    historicalBookmarks: histories.reduce((sum, c) => sum + c.preview.bookmarks, 0),
  };
}
async function exportCompleteAttempt({
  archives,
  dataRoot,
  file,
  limits,
  volumeBytes = codec.MAX_BYTES,
  volumeComponents = codec.MAX_COMPONENTS,
  excludedArchiveIds,
  confirmationToken,
}) {
  archives.assertSeparated(file);
  check(
    Number.isSafeInteger(volumeBytes) &&
      volumeBytes > 0 &&
      volumeBytes <= codec.MAX_BYTES &&
      Number.isSafeInteger(volumeComponents) &&
      volumeComponents > 0 &&
      volumeComponents <= codec.MAX_COMPONENTS,
    '分卷容量无效',
  );
  const confirming = excludedArchiveIds !== undefined || confirmationToken !== undefined;
  let confirmation;
  if (confirming) {
    confirmation = exportConfirmations.get(confirmationToken);
    // A confirmation authorizes only one attempt, including an interrupted one.
    exportConfirmations.delete(confirmationToken);
    if (
      !confirmation ||
      confirmation.expiresAt <= Date.now() ||
      !Array.isArray(excludedArchiveIds) ||
      !excludedArchiveIds.length ||
      !excludedArchiveIds.every((id) => typeof id === 'string') ||
      new Set(excludedArchiveIds).size !== excludedArchiveIds.length
    )
      throw confirmationExpired();
  }
  const known = archives.list(),
    plan = await migration.planProtectionExports({ dataRoot, limits });
  if (!confirming && !known.length && plan.parts.length === 1)
    return {
      ...(await migration.exportProtection({
        dataRoot,
        file,
        limits,
        ...plan.parts[0],
        expectedJournalHash: plan.journalHash,
      })),
      files: [file],
      volumes: 1,
      omittedArchives: [],
    };
  const stage = await staging(archives);
  try {
    const components = [],
      currentResults = [],
      currentContents = [],
      verifiedArchives = [],
      failedArchives = [],
      states = new Map();
    for (const [index, part] of plan.parts.entries()) {
      const current = path.join(
        stage.directory,
        index ? 'current-' + index + '.yijian-protection' : 'current.yijian-protection',
      );
      currentResults.push(
        await migration.exportProtection({
          dataRoot,
          file: current,
          limits,
          ...part,
          expectedJournalHash: plan.journalHash,
        }),
      );
      const { manifest } = await migration.readProtectionIndex({ file: current });
      // The newly generated package timestamp changes on every attempt. All
      // actual source bytes, including raw journal/backup/timeline metadata,
      // are instead bound by their fully verified manifest entries.
      currentContents.push(manifest.entries);
      components.push({ kind: index ? 'history' : 'current', file: current });
    }
    for (const [index, archive] of known.entries()) {
      const history = path.join(stage.directory, 'history-' + index + '.yijian-protection'),
        state = await historyState(archives, archive.id);
      states.set(archive.id, state);
      try {
        await archives.export(archive.id, history);
      } catch (e) {
        // Output/storage failures must not turn into permission to omit history.
        if (
          ['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'].includes(e.code) ||
          (typeof e.path === 'string' && e.path.startsWith(stage.directory + path.sep))
        )
          throw e;
        failedArchives.push({ id: archive.id, label: archive.label, reason: e.message });
        continue;
      }
      const digest = await codec.fileDigest(history);
      verifiedArchives.push({ id: archive.id, label: archive.label, ...digest });
      components.push({ kind: 'history', file: history, archiveId: archive.id, ...digest });
    }
    const currentKnown = archives.list();
    if (
      JSON.stringify(
        known.map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)),
      ) !==
      JSON.stringify(
        currentKnown.map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)),
      )
    ) {
      if (confirming) throw confirmationExpired();
      throw Error('历史档案集合在校验时发生变化，请重新导出');
    }
    for (const archive of known)
      if (states.get(archive.id) !== (await historyState(archives, archive.id))) {
        if (confirming) throw confirmationExpired();
        throw Error('历史档案在校验时发生变化，请重新导出');
      }
    const snapshot = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          dataRoot: await fs.realpath(dataRoot),
          file: path.resolve(file),
          limits: Object.entries(limits || {}).sort(([a], [b]) => a.localeCompare(b)),
          volumeBytes,
          volumeComponents,
          currentContents,
          states: [...states].sort(([a], [b]) => a.localeCompare(b)),
          verifiedArchives: verifiedArchives.sort((a, b) => a.id.localeCompare(b.id)),
          failedArchives: failedArchives.sort((a, b) => a.id.localeCompare(b.id)),
        }),
      )
      .digest('hex');
    const volumes = [],
      selected = [],
      seen = new Set();
    let group = [],
      bytes = 0,
      historicalArchives = 0;
    for (const component of components) {
      const digest = await codec.fileDigest(component.file);
      check(
        !component.sha256 || (digest.sha256 === component.sha256 && digest.bytes === component.bytes),
        '已校验历史临时副本发生变化',
      );
      check(digest.bytes <= volumeBytes, '这份档案超过单卷容量，请在完整备份列表缩小导出范围');
      if (seen.has(digest.sha256)) continue;
      seen.add(digest.sha256);
      selected.push(component);
      if (component.archiveId) historicalArchives++;
      if (group.length && (bytes + digest.bytes > volumeBytes || group.length >= volumeComponents)) {
        volumes.push(group);
        group = [];
        bytes = 0;
      }
      group.push({ ...component, ...digest });
      bytes += digest.bytes;
    }
    if (group.length) volumes.push(group);
    if (confirming) {
      if (
        confirmation.expiresAt <= Date.now() ||
        confirmation.snapshot !== snapshot ||
        JSON.stringify([...excludedArchiveIds].sort()) !==
          JSON.stringify(failedArchives.map((a) => a.id).sort())
      )
        throw confirmationExpired();
    } else if (failedArchives.length) throw requestExportConfirmation(failedArchives, snapshot);
    const omittedArchives = failedArchives;
    const currentResult = {
      ...currentResults[0],
      backups: currentResults.flatMap((r) => r.backups),
      entries: currentResults.reduce((n, r) => n + r.entries, 0),
    };
    if (volumes.length === 1) {
      const result = await codec.exportCollection({ components: selected, file });
      return {
        ...currentResult,
        ...result,
        collection: true,
        historicalArchives,
        omittedArchives,
        supplementalArchives: plan.parts.length - 1,
        files: [file],
        volumes: 1,
      };
    }
    const prepared = [];
    for (const [index, volume] of volumes.entries()) {
      const output = path.join(stage.directory, 'volume-' + index + '.yijian-protection');
      await codec.exportCollection({
        components: volume.map((c, i) => ({ file: c.file, kind: i ? 'history' : 'current' })),
        file: output,
      });
      prepared.push({
        name: 'part-' + String(index + 1).padStart(4, '0') + '.yijian-protection',
        source: output,
        ...(await codec.fileDigest(output)),
      });
    }
    // All volumes are complete and verified before exposing a fresh directory.
    // Exclusive mkdir/link cannot overwrite an existing user's file or folder.
    const directory = path.resolve(file) + '.parts';
    archives.assertSeparated(directory);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      for (const part of prepared) await fs.link(part.source, path.join(directory, part.name));
      const receipt = {
        schema: 1,
        kind: 'yijian-protection-volumes',
        createdAt: new Date().toISOString(),
        parts: prepared.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
      };
      const handle = await fs.open(path.join(directory, 'transfer.json'), 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(receipt, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (e) {
      throw Error('分卷发布未完成，请保留新目录并改用新名称重试：' + directory + '；' + e.message);
    }
    return {
      ...currentResult,
      file: directory,
      files: prepared.map((p) => path.join(directory, p.name)),
      volumes: prepared.length,
      collection: true,
      historicalArchives,
      omittedArchives,
      supplementalArchives: plan.parts.length - 1,
    };
  } finally {
    await cleanup(stage);
  }
}
async function exportComplete(options) {
  if (options.recordResult !== true) return exportCompleteAttempt(options);
  const { dataRoot, file } = options;
  try {
    options.archives.assertSeparated(path.join(dataRoot, 'protection-export-result.json'));
    // Persist the attempt before collection or publication, so a recording IO
    // failure cannot allow an export or leave an old success as the latest one.
    recordProtectionExportResult(dataRoot, {
      status: 'running',
      file: path.resolve(file),
      message: '正在校验并导出全部保护资料，尚未确认导出完成。',
    });
  } catch (error) {
    const message = '完整导出已中止：无法写入本机导出结果记录。原件保留；' + error.message;
    throw Object.assign(Error(message), {
      code: 'EXPORT_RESULT_WRITE_FAILED',
      diagnostic: error.message,
      published: false,
      exportResult: {
        schema: 1,
        at: Date.now(),
        status: 'failed',
        file: path.resolve(file),
        code: 'EXPORT_RESULT_WRITE_FAILED',
        message,
        diagnostic: error.message,
        published: false,
        recordNotSaved: true,
      },
    });
  }
  let result;
  try {
    result = await exportCompleteAttempt(options);
  } catch (error) {
    const failure = {
      status: 'failed',
      file: path.resolve(file),
      code: error.code || 'PROTECTION_EXPORT_FAILED',
      message: error.message,
      ...(error.backupId
        ? {
            backupId: error.backupId,
            directory: error.directory,
            reasonCode: error.reasonCode,
            reason: error.reason,
            diagnostic: error.diagnostic,
          }
        : {}),
    };
    try {
      error.exportResult = recordProtectionExportResult(dataRoot, failure);
    } catch (recordError) {
      error.message += '；本次失败原因未能写入本机导出结果记录：' + recordError.message;
      error.recordError = recordError.message;
      error.recordCode = 'EXPORT_RESULT_WRITE_FAILED';
      error.exportResult = {
        ...failure,
        schema: 1,
        at: Date.now(),
        message: error.message,
        recordError: recordError.message,
        recordNotSaved: true,
      };
    }
    throw error;
  }
  try {
    result.exportResult = recordProtectionExportResult(dataRoot, {
      status: 'success',
      file: result.file || path.resolve(file),
      message: `已校验保护资料已导出，共 ${result.volumes} 卷；原件保留。${result.omittedArchives?.length ? `经确认未包含 ${result.omittedArchives.length} 份异常历史档案，请另行保留它们的原始目录。` : ''}`,
      omittedArchives: result.omittedArchives || [],
      volumes: result.volumes,
    });
  } catch (error) {
    const message =
      '保护资料已发布，但完成结果未能写入本机记录。请核对目标产物并保留原件：' +
      (result.file || file) +
      '；' +
      error.message;
    throw Object.assign(Error(message), {
      code: 'EXPORT_RESULT_WRITE_FAILED',
      diagnostic: error.message,
      published: true,
      file: result.file || file,
      exportResult: {
        schema: 1,
        at: Date.now(),
        status: 'failed',
        file: result.file || path.resolve(file),
        code: 'EXPORT_RESULT_WRITE_FAILED',
        message,
        diagnostic: error.message,
        published: true,
        recordNotSaved: true,
        omittedArchives: result.omittedArchives || [],
      },
    });
  }
  return result;
}
async function previewComplete({ archives, file }) {
  archives.assertSeparated(file);
  if (!(await codec.isCollection(file)))
    return { ...(await migration.previewProtection({ file })), collection: false, historicalArchives: 0 };
  const stage = await staging(archives);
  try {
    return {
      ...previewView(
        await codec.scanCollection({ file, extractionDirectory: path.join(stage.directory, 'extracted') }),
      ),
      file,
    };
  } finally {
    await cleanup(stage);
  }
}
async function receiptHint(archives, id) {
  try {
    const file = path.join(archives.directory(id), 'payload', 'receipt.json'),
      stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof receipt.packageHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.packageHash)
      ? receipt.packageHash
      : null;
  } catch {
    return null;
  }
}
async function importComplete({ archives, file, expectedPackageHash }) {
  archives.assertSeparated(file);
  const stage = await staging(archives);
  try {
    const collection = await codec.isCollection(file);
    const scanned = collection
      ? await codec.scanCollection({ file, extractionDirectory: path.join(stage.directory, 'extracted') })
      : {
          packageHash: (await migration.previewProtection({ file })).packageHash,
          components: [
            {
              file,
              kind: 'current',
              ...(await codec.fileDigest(file)),
              preview: await migration.previewProtection({ file }),
            },
          ],
        };
    check(
      expectedPackageHash === undefined || expectedPackageHash === scanned.packageHash,
      '保护资料在预览后发生变化',
    );
    // Receipt hashes are only an index hint. Every reused record is fully
    // re-exported and verified byte-for-byte before it is reused.
    const candidates = new Map();
    for (const archive of archives.list()) {
      const hint = await receiptHint(archives, archive.id);
      if (hint) {
        const list = candidates.get(hint) || [];
        list.push(archive);
        candidates.set(hint, list);
      }
    }
    const planned = [],
      results = [],
      retainedUnverifiedArchives = new Set();
    let reused = 0;
    for (const [index, component] of scanned.components.entries()) {
      let existing;
      for (const archive of candidates.get(component.preview.packageHash) || []) {
        const exported = path.join(stage.directory, 'verify-' + index + '.yijian-protection');
        try {
          const verified = await archives.export(archive.id, exported);
          const bytes = await codec.fileDigest(exported);
          check(
            bytes.bytes === component.bytes &&
              bytes.sha256 === component.sha256 &&
              verified.packageHash === component.preview.packageHash,
            '已存历史与保护包不一致',
          );
          existing = { id: archive.id, ...component.preview };
          reused++;
          break;
        } catch {
          // Preserve failed candidates as evidence. A receipt hint must never
          // prevent a verified original package from supplying a fresh copy.
          retainedUnverifiedArchives.add(archive.id);
        } finally {
          await fs.unlink(exported).catch(() => {});
        }
      }
      planned.push({ component, existing });
    }
    // All inner packages and selected reused records are valid before registering
    // any archive or repairing its summary. Failed candidates remain untouched.
    // Disk interruption remains retryable by verified receipts.
    for (const { component, existing } of planned) {
      if (existing) {
        const summary = path.join(archives.directory(existing.id), 'archive-summary.json');
        try {
          await fs.lstat(summary);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          atomicWrite(summary, {
            schema: 1,
            label: component.preview.profiles
              .map((p) => p.name)
              .join('、')
              .slice(0, 200),
            createdAt: component.preview.createdAt,
            profiles: component.preview.profiles.length,
            backups: component.preview.backups.length,
            nodes: component.preview.nodes,
          });
        }
      }
      const imported = existing || (await archives.import(component.file, component.preview.packageHash));
      results.push(imported);
    }
    return {
      ...results[0],
      ...(collection ? previewView(scanned) : { collection: false, historicalArchives: 0 }),
      file,
      id: results[0].id,
      archiveIds: results.map((r) => r.id),
      reusedArchives: reused,
      retainedUnverifiedArchives: [...retainedUnverifiedArchives],
    };
  } finally {
    await cleanup(stage);
  }
}
async function volumeFiles({ archives, directory }) {
  archives.assertSeparated(directory);
  const root = await fs.lstat(directory);
  check(root.isDirectory() && !root.isSymbolicLink(), '分卷目录无效');
  const file = path.join(directory, 'transfer.json'),
    stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, '分卷清单无效');
  const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
  check(
    receipt.schema === 1 &&
      receipt.kind === 'yijian-protection-volumes' &&
      Object.keys(receipt).every((k) => ['schema', 'kind', 'createdAt', 'parts'].includes(k)) &&
      Array.isArray(receipt.parts) &&
      receipt.parts.length > 0 &&
      receipt.parts.length <= 10000,
    '分卷清单格式无效',
  );
  const seen = new Set(),
    files = [];
  for (const [index, part] of receipt.parts.entries()) {
    check(
      part &&
        typeof part === 'object' &&
        Object.keys(part).length === 3 &&
        part.name === 'part-' + String(index + 1).padStart(4, '0') + '.yijian-protection' &&
        !seen.has(part.name) &&
        Number.isSafeInteger(part.bytes) &&
        part.bytes > 0 &&
        typeof part.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(part.sha256),
      '分卷名称或校验信息无效',
    );
    const component = path.join(directory, part.name),
      digest = await codec.fileDigest(component);
    check(digest.bytes === part.bytes && digest.sha256 === part.sha256, '分卷缺失或校验失败：' + part.name);
    files.push(component);
    seen.add(part.name);
  }
  return files;
}
async function previewCompleteSet({ archives, files }) {
  check(
    Array.isArray(files) &&
      files.length > 0 &&
      files.length <= 10000 &&
      new Set(files.map((f) => path.resolve(f))).size === files.length,
    '选择的保护包无效',
  );
  const previews = [];
  for (const file of files) previews.push(await previewComplete({ archives, file }));
  return {
    profiles: previews.flatMap((p) => p.profiles),
    backups: previews.flatMap((p) => p.backups),
    nodes: previews.reduce((n, p) => n + p.nodes, 0),
    bookmarks: previews.reduce((n, p) => n + p.bookmarks, 0),
    historicalArchives: previews.reduce((n, p) => n + p.historicalArchives, 0),
    historicalBackups: previews.reduce((n, p) => n + (p.historicalBackups || 0), 0),
    historicalNodes: previews.reduce((n, p) => n + (p.historicalNodes || 0), 0),
    historicalBookmarks: previews.reduce((n, p) => n + (p.historicalBookmarks || 0), 0),
    volumes: files.length,
    previews,
  };
}
async function importCompleteSet({ archives, files, preview }) {
  const fresh = await previewCompleteSet({ archives, files });
  check(
    !preview ||
      (fresh.previews.every((p, i) => p.packageHash === preview.previews[i]?.packageHash) &&
        fresh.previews.length === preview.previews.length),
    '保护分卷在预览后发生变化',
  );
  const results = [];
  for (const [index, file] of files.entries())
    results.push(
      await importComplete({ archives, file, expectedPackageHash: fresh.previews[index].packageHash }),
    );
  return {
    id: results[0].id,
    archiveIds: results.flatMap((r) => r.archiveIds || [r.id]),
    reusedArchives: results.reduce((n, r) => n + (r.reusedArchives || 0), 0),
    retainedUnverifiedArchives: [...new Set(results.flatMap((r) => r.retainedUnverifiedArchives))],
    historicalArchives: fresh.historicalArchives,
  };
}
module.exports = {
  exportComplete,
  readProtectionExportResult,
  previewComplete,
  importComplete,
  volumeFiles,
  previewCompleteSet,
  importCompleteSet,
};
