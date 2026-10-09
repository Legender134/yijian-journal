'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const migration = require('./migration.cjs');
const { realDirectory } = require('./saves.cjs');
const { readMetadata } = require('./save-reader.cjs');
const { enrich } = require('./game-data.cjs');
const { validateState, atomicWrite } = require('./store.cjs');
const { bindHistoricalBackup } = require('./migration-recovery.cjs');
const idOK = (id) => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const normalize = (p) => path.resolve(p).toLowerCase();
const inside = (a, b) => normalize(a) === normalize(b) || normalize(a).startsWith(normalize(b) + path.sep);
class ProtectionArchives {
  constructor(dataRoot, getSource) {
    this.dataRoot = realDirectory(dataRoot);
    this.getSource = getSource;
  }
  assertSeparated(target) {
    const configured = this.getSource();
    if (!configured) return;
    const source = fs.existsSync(configured) ? fs.realpathSync(configured) : path.resolve(configured);
    if (inside(source, target) || inside(target, source)) throw Error('迁移资料与当前游戏存档目录不能重叠');
  }
  root(kind = 'protection-history') {
    const dir = path.join(this.dataRoot, kind);
    this.assertSeparated(dir);
    fs.mkdirSync(dir, { recursive: true });
    const resolved = realDirectory(dir);
    if (!inside(resolved, this.dataRoot)) throw Error('迁移资料目录异常');
    this.assertSeparated(resolved);
    return resolved;
  }
  directory(id) {
    if (!idOK(id)) throw Error('离线档案编号无效');
    const dir = realDirectory(path.join(this.root(), id));
    if (!inside(dir, this.root())) throw Error('离线档案目录异常');
    this.assertSeparated(dir);
    return dir;
  }
  list() {
    return fs
      .readdirSync(this.root())
      .filter(idOK)
      .map((id) => {
        try {
          const dir = this.directory(id),
            file = path.join(dir, 'archive-summary.json'),
            stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('摘要异常');
          const value = JSON.parse(fs.readFileSync(file, 'utf8'));
          return {
            id,
            label: typeof value.label === 'string' ? value.label.slice(0, 200) : '离线档案',
            createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 80) : '',
            profiles: Number.isSafeInteger(value.profiles) ? value.profiles : null,
            backups: Number.isSafeInteger(value.backups) ? value.backups : null,
            nodes: Number.isSafeInteger(value.nodes) ? value.nodes : null,
            verified: false,
          };
        } catch (e) {
          return { id, label: '离线档案 · 需核对', error: e.message, verified: false };
        }
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  async preview(file) {
    this.assertSeparated(file);
    return migration.previewProtection({ file });
  }
  async export(id, file) {
    this.assertSeparated(file);
    return migration.exportHistoricalProtection({ directory: this.directory(id), file });
  }
  async import(file, expectedPackageHash) {
    const targetDirectory = path.join(this.root(), crypto.randomUUID());
    const result = await migration.importProtection({ file, targetDirectory, expectedPackageHash });
    const id = path.basename(targetDirectory);
    atomicWrite(path.join(targetDirectory, 'archive-summary.json'), {
      schema: 1,
      label:
        result.profiles
          .map((p) => p.name)
          .join('、')
          .slice(0, 200) || '离线档案',
      createdAt: result.createdAt,
      profiles: result.profiles.length,
      backups: result.backups.length,
      nodes: result.nodes,
    });
    return { id, ...result, directory: undefined, payloadDirectory: undefined };
  }
  async history(id, store) {
    const view = await migration.readHistory({ directory: this.directory(id) });
    let compatible = true,
      compatibilityError = '';
    try {
      validateState(view.journal, store.ids);
    } catch (e) {
      compatible = false;
      compatibilityError = e.message;
    }
    return {
      id,
      createdAt: view.createdAt,
      readOnly: true,
      bound: false,
      compatible,
      compatibilityError,
      journal: view.journal,
      backups: view.backups,
      timeline: view.timeline,
    };
  }
  async inspect(id, type, recordId, name) {
    const directory = this.directory(id);
    let value;
    if (type === 'backup') value = await migration.readBackupFile({ directory, id: recordId, name });
    else if (type === 'timeline') value = await migration.readTimelineNode({ directory, id: recordId });
    else throw Error('离线档案内容类型无效');
    return {
      name: type === 'backup' ? name : value.record.label || '历史时间线节点',
      bytes: value.bytes.length,
      hash: crypto.createHash('sha256').update(value.bytes).digest('hex'),
      modifiedAt: value.file?.modifiedAt || new Date(value.record.at).toISOString(),
      metadata: enrich(readMetadata(value.bytes, { details: true })),
      readOnly: true,
      bound: false,
    };
  }
  async prepareRecovery(id, backupId, saves, expectedSource, stopped) {
    const source = realDirectory(this.getSource());
    if (normalize(source) !== normalize(expectedSource)) throw Error('本机存档目录已变化，请重新确认');
    if (!stopped()) throw Error('请先退出游戏再恢复迁移备份');
    const targetDirectory = path.join(this.root('protection-recovery'), crypto.randomUUID());
    const staged = await migration.materializeBackup({
      directory: this.directory(id),
      id: backupId,
      targetDirectory,
    });
    if (normalize(realDirectory(this.getSource())) !== normalize(source))
      throw Error('本机存档目录已变化，准备副本已保留');
    return bindHistoricalBackup({ saves, payloadDirectory: staged.payloadDirectory, source, stopped });
  }
}
module.exports = { ProtectionArchives };
