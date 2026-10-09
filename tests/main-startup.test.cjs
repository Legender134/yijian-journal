'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  vm = require('node:vm');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const start = main.indexOf('function prepareConfiguredTimeline() {'),
  end = main.indexOf('\nfunction overview()', start);
assert.ok(start > 0 && end > start);
const code = main.slice(start, end) + '\nprepareConfiguredTimeline();';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-startup-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-startup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store: new Store(root, require('../src/data/catalog.cjs')),
    saves: new Saves(path.join(root, 'backups')),
    timeline: new Timeline(path.join(root, 'history')),
  };
}
test('unavailable configured save directories leave startup usable and preserve the stored choice', (t) => {
  const s = fixture(t),
    source = path.join(s.root, 'previous-computer', 'SaveGames');
  s.store.setPath('savePath', source);
  s.store.mutate({ type: 'settings', value: { autoBackup: false } });
  const before = fs.readFileSync(s.store.file);
  vm.runInNewContext(code, s);
  assert.deepEqual(fs.readFileSync(s.store.file), before);
  assert.equal(s.store.get().settings.savePath, source);
  assert.equal(s.store.get().settings.autoBackup, false);
  assert.equal(s.timeline.data.source, '');
  assert.equal(fs.existsSync(s.timeline.file), false);
  assert.equal(fs.existsSync(source), false);
});
test('valid configured saves initialize a passive timeline without adopting or writing a foreign slot', (t) => {
  const s = fixture(t),
    source = path.join(s.root, 'SaveGames');
  fs.mkdirSync(source);
  const bytes = syntheticSave({ full: true });
  fs.writeFileSync(path.join(source, '29.sav'), bytes);
  s.store.setPath('savePath', source);
  vm.runInNewContext(code, s);
  assert.equal(s.timeline.data.source, fs.realpathSync(source));
  assert.equal(s.timeline.data.enabled, false);
  assert.equal(s.timeline.data.ownerHash, '');
  assert.deepEqual(fs.readFileSync(path.join(source, '29.sav')), bytes);
});
test('existing or interrupted timeline state is retained before any automatic configuration', () => {
  for (const reason of ['existing', 'pending', 'error', 'unset']) {
    let scans = 0,
      writes = 0;
    const context = {
      store: { get: () => ({ settings: { savePath: reason === 'unset' ? '' : 'synthetic-SaveGames' } }) },
      timeline: {
        data: {
          source: reason === 'existing' ? 'previous-source' : '',
          pending: reason === 'pending' ? { type: 'save' } : null,
        },
        error: reason === 'error' ? 'retained failure' : '',
        configure: () => writes++,
      },
      saves: {
        scan: () => {
          scans++;
          return { error: '' };
        },
      },
    };
    const before = JSON.stringify(context.timeline.data);
    vm.runInNewContext(code, context);
    assert.equal(scans, 0, reason);
    assert.equal(writes, 0, reason);
    assert.equal(JSON.stringify(context.timeline.data), before, reason);
  }
});
test('timeline persistence failures remain fatal instead of being mistaken for an unavailable source', () => {
  const context = {
    store: { get: () => ({ settings: { savePath: 'synthetic-readable-source' } }) },
    saves: { scan: () => ({ error: '' }) },
    timeline: {
      data: { source: '', pending: null },
      error: '',
      configure: () => {
        throw Error('synthetic history write failure');
      },
    },
  };
  assert.throws(() => vm.runInNewContext(code, context), /history write failure/);
});
