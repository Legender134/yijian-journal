'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  fsp = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  vm = require('node:vm');
const { Store } = require('../src/core/store.cjs'),
  { Saves } = require('../src/core/saves.cjs'),
  { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const complete = require('../src/core/complete-migration.cjs'),
  migration = require('../src/core/migration.cjs'),
  catalog = require('../src/data/catalog.cjs'),
  { syntheticSave } = require('./fixtures.cjs');
const parent = path.resolve(process.env.YIJIAN_ANOMALY_TEST_ROOT || require('node:os').tmpdir());
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'yijian-export-target-'));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = (machine) => complete.readProtectionExportResult(machine.dataRoot);
function machine(label) {
  const directory = fs.mkdtempSync(path.join(root, label + '-')),
    dataRoot = path.join(directory, 'userdata'),
    source = path.join(directory, 'synthetic-SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, seconds: 43 }));
  const store = new Store(dataRoot, catalog),
    saves = new Saves(path.join(dataRoot, 'save-backups'));
  store.mutate({ type: 'note', value: label + '合成手札' });
  saves.capture(source, label + '合成保护');
  return { directory, dataRoot, source, archives: new ProtectionArchives(dataRoot, () => source) };
}
async function withHistory(label) {
  const m = machine(label),
    old = machine(label + '-history'),
    file = path.join(old.directory, 'history.yijian-protection');
  await migration.exportProtection({ ...old, file });
  await m.archives.import(file);
  return m;
}
function targetFailure(error, file, recorded = true) {
  assert.equal(error.code, 'PROTECTION_EXPORT_TARGET_EXISTS');
  assert.equal(error.file, file);
  assert.match(error.message, /目标已存在.*另选新文件名.*原文件已保留/);
  assert.doesNotMatch(error.message, /already exists|EEXIST|磁盘|损坏/);
  assert.match(error.diagnostic, /already exists|EEXIST/);
  assert.equal(error.cause.code, 'EEXIST');
  if (recorded) {
    assert.equal(error.exportResult.status, 'failed');
    assert.equal(error.exportResult.code, error.code);
    assert.equal(error.exportResult.message, error.message);
    assert.equal(error.exportResult.diagnostic, error.diagnostic);
    assert.equal(error.exportResult.file, file);
  }
  return true;
}
test.after(() => console.log('Retained synthetic export-target fixtures: ' + root));
test('single and historical collection exports preserve existing packages and succeed with a new name', async () => {
  for (const history of [false, true]) {
    const m = history ? await withHistory('collection') : machine('single'),
      file = path.join(m.directory, 'existing.yijian-protection');
    await complete.exportComplete({ ...m, file, recordResult: true });
    const previous = hash(file),
      source = hash(path.join(m.source, '1.sav'));
    await assert.rejects(complete.exportComplete({ ...m, file, recordResult: true }), (error) => {
      targetFailure(error, file);
      assert.deepEqual(error.exportResult, receipt(m));
      return true;
    });
    assert.equal(hash(file), previous);
    assert.equal(hash(path.join(m.source, '1.sav')), source);
    await assert.rejects(complete.exportComplete({ ...m, file }), (error) =>
      targetFailure(error, file, false),
    );
    assert.equal(hash(file), previous);
    const renamed = path.join(m.directory, 'new-name.yijian-protection'),
      result = await complete.exportComplete({ ...m, file: renamed, recordResult: true }),
      preview = await complete.previewComplete({ archives: m.archives, file: renamed });
    assert.equal(result.exportResult.status, 'success');
    assert.deepEqual(result.exportResult, receipt(m));
    assert.equal(preview.historicalArchives, history ? 1 : 0);
    assert.equal(hash(file), previous);
  }
});
test('exclusive final links classify genuine single and collection EEXIST races without replacing the racing file', async () => {
  for (const history of [false, true]) {
    const m = history ? await withHistory('race-collection') : machine('race-single'),
      file = path.join(m.directory, 'racing.yijian-protection'),
      originalLink = fsp.link;
    let calls = 0;
    fsp.link = async function (from, to) {
      if (to === file) {
        calls++;
        fs.writeFileSync(file, 'synthetic concurrent owner; preserve these exact bytes', { flag: 'wx' });
      }
      return originalLink.call(this, from, to);
    };
    try {
      await assert.rejects(complete.exportComplete({ ...m, file, recordResult: true }), (error) =>
        targetFailure(error, file),
      );
    } finally {
      fsp.link = originalLink;
    }
    assert.equal(calls, 1);
    const previous = hash(file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic concurrent owner; preserve these exact bytes');
    assert.equal(receipt(m).code, 'PROTECTION_EXPORT_TARGET_EXISTS');
    const result = await complete.exportComplete({
      ...m,
      file: path.join(m.directory, 'after-race.yijian-protection'),
      recordResult: true,
    });
    assert.equal(result.exportResult.status, 'success');
    assert.equal(hash(file), previous);
  }
});
test('an existing final volume directory gets the same filename advice and its content is preserved', async () => {
  const m = await withHistory('volume-directory'),
    file = path.join(m.directory, 'volumes.yijian-protection'),
    directory = file + '.parts';
  fs.mkdirSync(directory);
  const sentinel = path.join(directory, 'original.txt');
  fs.writeFileSync(sentinel, 'synthetic existing directory content');
  const previous = hash(sentinel);
  await assert.rejects(
    complete.exportComplete({ ...m, file, volumeComponents: 1, recordResult: true }),
    (error) => targetFailure(error, directory),
  );
  assert.equal(hash(sentinel), previous);
  assert.deepEqual(fs.readdirSync(directory), ['original.txt']);
  const result = await complete.exportComplete({
    ...m,
    file: path.join(m.directory, 'new-volumes.yijian-protection'),
    volumeComponents: 1,
    recordResult: true,
  });
  assert.equal(result.volumes, 2);
  assert.equal(result.exportResult.status, 'success');
  assert.equal(hash(sentinel), previous);
});
test('an unrelated temporary-file EEXIST retains its original error and is not reported as a destination collision', async () => {
  const m = machine('temporary-collision'),
    file = path.join(m.directory, 'unpublished.yijian-protection'),
    originalOpen = fsp.open;
  let calls = 0;
  fsp.open = async function (target, ...args) {
    if (path.dirname(target) === m.directory && path.basename(target).startsWith('.migration-export-')) {
      calls++;
      throw Object.assign(Error('synthetic temporary-file EEXIST'), { code: 'EEXIST', path: target });
    }
    return originalOpen.call(this, target, ...args);
  };
  try {
    await assert.rejects(complete.exportComplete({ ...m, file, recordResult: true }), (error) => {
      assert.equal(error.code, 'EEXIST');
      assert.equal(error.exportResult.code, 'EEXIST');
      assert.equal(error.message, 'synthetic temporary-file EEXIST');
      assert.doesNotMatch(error.message, /目标已存在|另选新文件名/);
      return true;
    });
  } finally {
    fsp.open = originalOpen;
  }
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(file), false);
});
test('the destination receipt gives filename advice, keeps raw diagnostics inside collapsed details, and leaves other guidance intact', () => {
  const context = {};
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/protection-views.js'), 'utf8');
  vm.runInContext(
    source.replace('export function createProtectionViews', 'function createProtectionViews'),
    context,
  );
  const esc = (value) =>
      String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    views = context.createProtectionViews({ esc, pill: () => '', when: () => '合成时间' }),
    message = '完整保护资料未导出：目标已存在，请另选新文件名后重试；原文件已保留，未被覆盖。',
    diagnostic = 'Protection file already exists; choose a new filename';
  const html = views.exportResult({
    status: 'failed',
    code: 'PROTECTION_EXPORT_TARGET_EXISTS',
    message,
    diagnostic,
  });
  assert.match(html, /再次选择「导出全部保护资料」，另选新文件名后重试/);
  assert.doesNotMatch(html, /磁盘状态|完好的来源恢复/);
  assert.ok(html.includes('<details><summary>查看诊断详情</summary>'));
  assert.doesNotMatch(html.split('<details>')[0], /Protection file already exists/);
  assert.ok(html.includes(diagnostic));
  assert.ok(!html.includes('<details open'));
  const generic = views.exportResult({ status: 'failed', code: 'EIO', message: '合成磁盘故障' });
  assert.match(generic, /异常副本或磁盘状态.*完好的来源恢复/);
  assert.doesNotMatch(generic, /另选新文件名/);
});
