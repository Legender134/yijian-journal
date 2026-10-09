'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const collection = require('../src/core/protection-collection.cjs');
const migration = require('../src/core/migration.cjs');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'yijian-collection-test-'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function packageFor(name, seconds) {
  const data = path.join(root, name),
    source = path.join(data, '中文 合成存档');
  fs.mkdirSync(source, { recursive: true });
  const bytes = syntheticSave({ full: true, seconds });
  fs.writeFileSync(path.join(source, '1.sav'), bytes);
  fs.writeFileSync(path.join(source, '28.sav'), Buffer.from('foreign fixture'));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  store.mutate({ type: 'note', value: name + '手札' });
  new Saves(path.join(data, 'save-backups')).capture(source, name + '完整保护');
  const timeline = new Timeline(path.join(data, 'game-timeline'));
  timeline.configure(source, false, 30);
  const node = timeline.record(bytes, 'manual');
  timeline.updateNode(node.id, { bookmarked: true, label: name + '书签', note: '说明' });
  const file = path.join(root, name + '.yijian-protection');
  await migration.exportProtection({ dataRoot: data, file });
  return { file, source, bytes };
}
let files;
test.before(async () => {
  files = [await packageFor('旧机器', 1000), await packageFor('本机', 2000)];
});
test('a single streaming collection retains current and historical packages byte for byte and removes duplicate history', async () => {
  const file = path.join(root, '全部换机资料.yijian-protection');
  const result = await collection.exportCollection({
    file,
    components: [
      { kind: 'current', file: files[1].file },
      { kind: 'history', file: files[0].file },
      { kind: 'history', file: files[0].file },
    ],
  });
  assert.equal(result.components, 2);
  assert.equal(result.histories, 1);
  assert.equal(await collection.isCollection(file), true);
  assert.equal(await collection.isCollection(files[0].file), false);
  const scan = await collection.scanCollection({ file, extractionDirectory: path.join(root, '已验证提取') });
  assert.equal(scan.packageHash, result.packageHash);
  assert.deepEqual(
    scan.components.map((c) => c.kind),
    ['current', 'history'],
  );
  for (const [index, component] of scan.components.entries()) {
    assert.equal(hash(fs.readFileSync(component.file)), hash(fs.readFileSync(files[1 - index].file)));
    assert.equal(component.preview.backups.length, 1);
    assert.equal(component.preview.nodes, 1);
    assert.equal(component.preview.bookmarks, 1);
    assert.equal(component.preview.bound, false);
  }
  for (const source of files)
    assert.deepEqual(fs.readFileSync(path.join(source.source, '1.sav')), source.bytes);
});
test('existing output is never overwritten, including an atomic publication collision', async () => {
  const file = path.join(root, 'existing.yijian-protection'),
    before = Buffer.from('user-owned existing bytes');
  fs.writeFileSync(file, before);
  await assert.rejects(
    collection.exportCollection({ file, components: [{ kind: 'current', file: files[1].file }] }),
    { code: 'EEXIST' },
  );
  assert.deepEqual(fs.readFileSync(file), before);
});
test('corruption, truncation and trailing bytes cannot produce a verified collection', async () => {
  const original = fs.readFileSync(path.join(root, '全部换机资料.yijian-protection'));
  const altered = Buffer.from(original);
  altered[altered.length - 40] ^= 1;
  for (const [name, bytes] of [
    ['altered', altered],
    ['truncated', original.subarray(0, original.length - 1)],
    ['extra', Buffer.concat([original, Buffer.from('x')])],
  ]) {
    const file = path.join(root, name);
    fs.writeFileSync(file, bytes);
    await assert.rejects(collection.scanCollection({ file }), /校验|截断|多余/);
  }
});
function repackHeader(change) {
  const original = fs.readFileSync(path.join(root, '全部换机资料.yijian-protection'));
  const length = original.readUInt32BE(collection.MAGIC.length),
    offset = collection.MAGIC.length + 4;
  const header = JSON.parse(original.subarray(offset, offset + length));
  change(header);
  const metadata = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(offset);
  collection.MAGIC.copy(prefix);
  prefix.writeUInt32BE(metadata.length, collection.MAGIC.length);
  const content = Buffer.concat([prefix, metadata, original.subarray(offset + length, original.length - 32)]);
  return Buffer.concat([content, crypto.createHash('sha256').update(content).digest()]);
}
test('even correctly signed hostile headers reject paths, duplicate hashes, order changes and unbounded sizes before extraction', async () => {
  const changes = [
    (h) => {
      h.components[0].path = '../escape';
    },
    (h) => {
      h.components[1].sha256 = h.components[0].sha256;
    },
    (h) => {
      h.components[0].kind = 'history';
    },
    (h) => {
      h.components[0].bytes = collection.MAX_BYTES + 1;
    },
    (h) => {
      h.components = Array(collection.MAX_COMPONENTS + 1).fill(h.components[0]);
    },
  ];
  for (const [index, change] of changes.entries()) {
    const file = path.join(root, 'hostile-' + index),
      directory = path.join(root, 'rejected-' + index);
    fs.writeFileSync(file, repackHeader(change));
    await assert.rejects(collection.scanCollection({ file, extractionDirectory: directory }));
    assert.equal(fs.existsSync(directory), false);
  }
});
test('a collection can never be nested as an inner package and duplicate extraction cannot overwrite files', async () => {
  const original = path.join(root, '全部换机资料.yijian-protection'),
    target = path.join(root, 'nested');
  await assert.rejects(
    collection.exportCollection({ file: target, components: [{ kind: 'current', file: original }] }),
    /Unsupported protection package/,
  );
  assert.equal(fs.existsSync(target), false);
  await assert.rejects(
    collection.scanCollection({ file: original, extractionDirectory: path.join(root, '已验证提取') }),
    { code: 'EEXIST' },
  );
});
