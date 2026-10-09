'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Store, defaults, validateState, MAX_JOURNAL_BYTES } = require('../src/core/store.cjs');
const { Saves, sha, discoverSaveFolders } = require('../src/core/saves.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const catalog = require('../src/data/catalog.cjs');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-test-'));
  t.after(() => {
    if (
      path.dirname(path.resolve(p)) !== path.resolve(os.tmpdir()) ||
      !path.basename(p).startsWith('yijian-test-')
    )
      throw Error('Unsafe test cleanup path');
    fs.rmSync(p, { recursive: true, force: true });
  });
  return p;
}
function fixture(t) {
  const base = temp(t),
    source = path.join(base, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), Buffer.from([0, 2, 4, 254, 128]));
  fs.writeFileSync(path.join(source, 'JHSaveConfig.sav'), 'original-index');
  fs.writeFileSync(path.join(source, 'JHGameConfig.cfg'), 'config');
  return { base, source, saves: new Saves(path.join(base, 'backups')) };
}
test('catalog has unique IDs, valid source references and no fabricated guaranteed deadlines', () => {
  const ids = new Set(catalog.entries.map((e) => e.id));
  assert.equal(ids.size, catalog.entries.length);
  for (const e of catalog.entries) {
    assert.ok(e.steps.length > 0);
    assert.ok(catalog.stages[e.stage]);
    for (const id of e.related) assert.ok(ids.has(id));
    for (const id of e.sourceIds)
      assert.ok(catalog.sources.some((s) => s.id === id && s.url.startsWith('https://')));
  }
});
test('journal persists checks, favorites, Unicode notes and goals across restart', (t) => {
  const base = temp(t),
    s = new Store(base, catalog),
    id = catalog.entries[0].id;
  s.mutate({ type: 'check', id, value: 'done' });
  s.mutate({ type: 'favorite', id });
  s.mutate({ type: 'note', value: '梧桐村的晚风\n明天出发。' });
  s.mutate({ type: 'goal-add', title: '去青木舫', detail: '带上司马铃' });
  const p = new Store(base, catalog).get().profiles[0];
  assert.equal(p.checks[id], 'done');
  assert.deepEqual(p.favorites, [id]);
  assert.match(p.notes, /明天出发/);
  assert.equal(p.goals[0].title, '去青木舫');
});
test('reading size persists, accepts older journals and preserves local preference when importing writing', (t) => {
  const dir = temp(t),
    store = new Store(dir, catalog);
  assert.equal(store.get().settings.readingScale, 100);
  for (const readingScale of [110, 125, 150, 100]) {
    store.mutate({ type: 'settings', value: { readingScale } });
    assert.equal(new Store(dir, catalog).get().settings.readingScale, readingScale);
  }
  store.mutate({ type: 'settings', value: { readingScale: 125 } });
  const legacy = defaults();
  delete legacy.settings.readingScale;
  assert.doesNotThrow(() => validateState(legacy, store.ids));
  legacy.profiles[0].notes = '旧手札的文字';
  store.importData(legacy);
  const reopened = new Store(dir, catalog).get();
  assert.equal(reopened.settings.readingScale, 125);
  assert.equal(reopened.profiles[0].notes, '旧手札的文字');
  assert(fs.readdirSync(dir).some((name) => name.startsWith('journal-before-import-')));
});

test('invalid reading size rejects the whole settings mutation and malformed imports without changing saved data', (t) => {
  const store = new Store(temp(t), catalog),
    before = store.get();
  for (const readingScale of [0, -100, 99, 120, 151, 500, '125', null, NaN, Infinity, [], {}]) {
    assert.throws(
      () => store.mutate({ type: 'settings', value: { spoiler: 'details', readingScale } }),
      /界面大小/,
    );
    assert.deepEqual(store.get(), before);
    assert.deepEqual(new Store(store.dir, catalog).get(), before);
  }
  const invalid = defaults();
  invalid.settings.readingScale = 1000;
  assert.throws(() => store.importData(invalid), /界面大小/);
  assert.deepEqual(store.get(), before);
  assert(!fs.readdirSync(store.dir).some((name) => name.startsWith('journal-before-import-')));
});

test('delayed note write remains in its original profile', (t) => {
  const s = new Store(temp(t), catalog),
    first = s.get().activeProfileId;
  s.mutate({ type: 'profile-add', name: '二周目' });
  const second = s.get().activeProfileId;
  s.mutate({ type: 'note', value: '第一周目旧编辑', profileId: first });
  const state = s.get();
  assert.equal(state.activeProfileId, second);
  assert.equal(state.profiles.find((p) => p.id === first).notes, '第一周目旧编辑');
  assert.equal(state.profiles.find((p) => p.id === second).notes, '');
});

test('goal references survive edits, restart and import without changing older goals', (t) => {
  const dir = temp(t),
    store = new Store(dir, catalog);
  const source = { type: 'database', id: 'fusion-1002', quantity: 3 };
  store.mutate({ type: 'goal-add', title: '三次制作', detail: '当时缺精钢锭 6', source });
  source.quantity = 999;
  const id = store.get().profiles[0].goals[0].id;
  store.mutate({ type: 'goal-edit', id, title: '换一个标题', detail: '保留资料入口' });
  store.mutate({ type: 'goal-add', title: '旧格式待办', detail: '' });
  store.mutate({
    type: 'goal-add',
    title: '线索',
    detail: '',
    source: { type: 'guide', id: catalog.entries[0].id },
  });
  const restarted = new Store(dir, catalog),
    data = restarted.get();
  assert.deepEqual(data.profiles[0].goals.find((g) => g.id === id).source, {
    type: 'database',
    id: 'fusion-1002',
    quantity: 3,
  });
  assert.equal(data.profiles[0].goals.find((g) => g.title === '旧格式待办').source, undefined);
  const imported = new Store(path.join(temp(t), 'imported'), catalog);
  imported.importData(data);
  assert.deepEqual(imported.get().profiles[0].goals, data.profiles[0].goals);
});

test('goal references reject external paths, commands and invalid quantities atomically', (t) => {
  const store = new Store(temp(t), catalog),
    before = store.get();
  for (const source of [
    null,
    [],
    'fusion-1002',
    { type: 'url', id: 'https://example.com' },
    { type: 'database', id: '../file' },
    { type: 'database', id: 'javascript:alert(1)' },
    { type: 'database', id: 'fusion-1002', quantity: 0 },
    { type: 'database', id: 'fusion-1002', quantity: 1000 },
    { type: 'database', id: 'fusion-1002', quantity: 1.5 },
    { type: 'database', id: 'fusion-1002', command: 'anything' },
    { type: 'guide', id: 'missing-guide' },
  ]) {
    assert.throws(() => store.mutate({ type: 'goal-add', title: '无效资料', source }));
    assert.deepEqual(store.get(), before);
  }
});

test('multi-profile export capacity matches the import ceiling and oversized state is rejected', () => {
  const state = defaults(),
    template = state.profiles[0],
    ids = new Set(catalog.entries.map((e) => e.id));
  const makeProfile = (i) => ({
    ...structuredClone(template),
    id: `profile-${i}`,
    goals: Array.from({ length: 300 }, (_, j) => ({
      id: `goal-${j}`,
      title: '材料准备',
      detail: '材'.repeat(2000),
      done: false,
    })),
  });
  state.profiles = Array.from({ length: 3 }, (_, i) => makeProfile(i));
  state.activeProfileId = state.profiles[0].id;
  const bytes = Buffer.byteLength(JSON.stringify(state, null, 2));
  assert.ok(bytes > 5 * 1024 * 1024 && bytes < MAX_JOURNAL_BYTES);
  assert.doesNotThrow(() => validateState(state, ids));
  state.profiles = Array.from({ length: 19 }, (_, i) => makeProfile(i));
  assert.throws(() => validateState(state, ids), /32 MB/);
});
test('preferred save slots are per profile, optional in older journals, and reset on source change', (t) => {
  const dir = temp(t),
    s = new Store(dir, catalog),
    first = s.get().activeProfileId;
  s.setPath('savePath', 'C:\\synthetic-a');
  s.mutate({ type: 'save-slot', value: '2.sav' });
  s.mutate({ type: 'profile-add', name: '另一程' });
  assert.equal(s.get().profiles.find((p) => p.id === s.get().activeProfileId).saveSlot, '');
  s.mutate({ type: 'save-slot', value: '10.sav' });
  s.mutate({ type: 'profile-switch', id: first });
  assert.equal(s.get().profiles.find((p) => p.id === first).saveSlot, '2.sav');
  assert.throws(() => s.mutate({ type: 'save-slot', value: '../2.sav' }));
  assert.equal(new Store(dir, catalog).get().profiles[0].saveSlot, '2.sav');
  s.setPath('savePath', 'C:\\synthetic-b');
  assert.ok(s.get().profiles.every((p) => p.saveSlot === ''));
  const legacy = s.get();
  for (const p of legacy.profiles) delete p.saveSlot;
  s.importData(legacy);
  assert.ok(s.get().profiles.every((p) => p.saveSlot === ''));
});
test('note whitespace and deliberate empty lines survive autosave', (t) => {
  const base = temp(t),
    store = new Store(base, catalog),
    note = '  梧桐村\n\n  下次去找裁缝。\n';
  store.mutate({ type: 'note', value: note });
  assert.equal(new Store(base, catalog).get().profiles[0].notes, note);
});
test('invalid mutations leave in-memory and disk state unchanged', (t) => {
  const s = new Store(temp(t), catalog),
    before = s.get(),
    onDisk = fs.readFileSync(s.file, 'utf8');
  for (const command of [
    { type: 'stage', value: 99 },
    { type: 'check', id: 'unknown', value: 'done' },
    { type: 'settings', value: { savePath: 'C:/' } },
    { type: 'goal-add', title: '' },
    { type: 'profile-rename', name: '' },
  ])
    assert.throws(() => s.mutate(command));
  assert.deepEqual(s.get(), before);
  assert.equal(fs.readFileSync(s.file, 'utf8'), onDisk);
});
test('damaged current journal recovers previous record and retains the damaged bytes', (t) => {
  const base = temp(t),
    s = new Store(base, catalog);
  s.mutate({ type: 'note', value: 'recover me' });
  s.mutate({ type: 'stage', value: 2 });
  fs.writeFileSync(s.file, 'damaged');
  const reopened = new Store(base, catalog);
  assert.equal(reopened.get().profiles[0].notes, 'recover me');
  assert.match(reopened.warning, /恢复/);
  assert.ok(fs.readdirSync(base).some((n) => n.startsWith('journal-damaged')));
  assert.equal(JSON.parse(fs.readFileSync(`${s.file}.previous`, 'utf8')).profiles[0].notes, 'recover me');
});
test('unrecoverable data is not silently replaced with a blank journal', (t) => {
  const base = temp(t);
  fs.writeFileSync(path.join(base, 'journal.json'), 'bad');
  assert.throws(() => new Store(base, catalog), /无法读取/);
  assert.equal(fs.readFileSync(path.join(base, 'journal.json'), 'utf8'), 'bad');
});
test('import keeps local paths/settings and preserves the pre-import journal', (t) => {
  const s = new Store(temp(t), catalog);
  s.mutate({ type: 'settings', value: { autoBackup: false } });
  s.setPath('savePath', 'C:/local/SaveGames');
  const imported = s.get();
  imported.profiles[0].name = '导入的周目';
  imported.settings.savePath = 'X:/external';
  imported.settings.autoBackup = true;
  s.importData(imported);
  assert.equal(s.get().settings.savePath, 'C:/local/SaveGames');
  assert.equal(s.get().settings.autoBackup, false);
  assert.equal(s.get().profiles[0].name, '导入的周目');
  assert.ok(fs.readdirSync(s.dir).some((n) => n.startsWith('journal-before-import')));
});
test('invalid imported state is rejected without altering the journal', (t) => {
  const s = new Store(temp(t), catalog),
    before = s.get(),
    bad = s.get();
  bad.profiles[0].favorites = ['bogus'];
  assert.throws(() => s.importData(bad));
  assert.deepEqual(s.get(), before);
});
test('snapshot is byte-exact, verifies all files and does not write the source', (t) => {
  const { source, saves } = fixture(t),
    before = fs
      .readdirSync(source)
      .map((name) => [
        name,
        sha(fs.readFileSync(path.join(source, name))),
        fs.statSync(path.join(source, name)).mtimeMs,
      ]);
  const m = saves.capture(source, '重要选择前');
  assert.equal(m.files.length, 3);
  assert.equal(saves.list().length, 1);
  assert.equal(saves.verify(m.id).manifest.label, '重要选择前');
  for (const file of m.files) {
    const copied = fs.statSync(path.join(saves.root, m.id, 'files', file.name));
    assert.ok(Math.abs(copied.mtimeMs - Date.parse(file.modifiedAt)) < 2);
  }
  assert.deepEqual(
    fs
      .readdirSync(source)
      .map((name) => [
        name,
        sha(fs.readFileSync(path.join(source, name))),
        fs.statSync(path.join(source, name)).mtimeMs,
      ]),
    before,
  );
});
test('restore creates a verified safety copy and retains unrelated current files', (t) => {
  const { source, saves } = fixture(t),
    m = saves.capture(source, '旧存档');
  fs.writeFileSync(path.join(source, '1.sav'), 'newer');
  fs.writeFileSync(path.join(source, '2.sav'), 'extra slot');
  const r = saves.restore(m.id, source);
  assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), Buffer.from([0, 2, 4, 254, 128]));
  assert.equal(fs.readFileSync(path.join(source, '2.sav'), 'utf8'), 'extra slot');
  assert.equal(saves.verify(r.safetyId).buffers.get('1.sav').toString(), 'newer');
});
test('corrupted snapshot refuses restore before touching any live file', (t) => {
  const { source, saves } = fixture(t),
    m = saves.capture(source);
  fs.writeFileSync(path.join(source, '1.sav'), 'live');
  fs.writeFileSync(path.join(saves.root, m.id, 'files', '1.sav'), 'corrupt');
  assert.throws(() => saves.restore(m.id, source), /异常|校验失败/);
  assert.equal(fs.readFileSync(path.join(source, '1.sav'), 'utf8'), 'live');
  assert.equal(saves.list().length, 1);
});
test('restore blocks while game runs and when its status cannot be confirmed', (t) => {
  const { source, saves } = fixture(t),
    m = saves.capture(source);
  assert.throws(() => saves.restore(m.id, source, () => false), /退出/);
  assert.equal(saves.list().length, 1);
});
test('restore blocks cross-directory backup and path traversal', (t) => {
  const { base, source, saves } = fixture(t),
    m = saves.capture(source),
    other = path.join(base, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'a.sav'), 'x');
  assert.throws(() => saves.restore(m.id, other), /其他存档/);
  assert.throws(() => saves.verify('../anything'), /编号无效/);
  const manifestPath = path.join(saves.root, m.id, 'manifest.json');
  m.files[0].name = '../escape.sav';
  fs.writeFileSync(manifestPath, JSON.stringify(m));
  assert.throws(() => saves.verify(m.id), /无效文件/);
});
test('backup refuses a nested output directory and a folder without saves', (t) => {
  const { base, source } = fixture(t),
    nested = new Saves(path.join(source, 'backup'));
  assert.throws(() => nested.capture(source), /重叠/);
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => new Saves(path.join(base, 'out')).capture(empty), /没有/);
});
test('source-directory junctions are rejected', (t) => {
  const { base, source, saves } = fixture(t),
    link = path.join(base, 'link');
  try {
    fs.symlinkSync(source, link, 'junction');
  } catch {
    t.skip('Junction creation is unavailable');
    return;
  }
  assert.throws(() => saves.capture(link), /链接/);
});
test('automatic backup fingerprint changes after new save and stays stable otherwise', (t) => {
  const { source, saves } = fixture(t),
    a = saves.fingerprint(source);
  assert.equal(a, saves.fingerprint(source));
  fs.writeFileSync(path.join(source, 'new.sav'), 'new');
  assert.notEqual(a, saves.fingerprint(source));
});
test('save discovery identifies only real save folders in the game root', (t) => {
  const base = temp(t),
    p = path.join(base, 'Wandering_Sword', 'Saved', '123456789', 'SaveGames');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, '1.sav'), 'valid');
  assert.deepEqual(discoverSaveFolders(base), [p]);
  assert.deepEqual(discoverSaveFolders(path.join(base, 'nonexistent')), []);
});
function syntheticSave() {
  const n = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const s = (v) => Buffer.concat([n(Buffer.byteLength(v) + 1), Buffer.from(v + '\0')]);
  const prop = (name, type, value, extra = Buffer.alloc(0)) =>
    Buffer.concat([s(name), s(type), n(value.length), n(0), extra, Buffer.from([0]), value]);
  const data = Buffer.concat([
    Buffer.from('GVAS'),
    n(2),
    n(522),
    Buffer.from([4, 0, 26, 0, 2, 0]),
    n(0),
    s('++UE4+Release-4.26'),
    n(3),
    n(0),
    s('/Script/JH.JHSaveGame'),
    n(0),
    prop('MapName', 'StrProperty', s('LV_World')),
    prop('SaveGameTime', 'IntProperty', n(3661)),
    prop('TeamInfos', 'ArrayProperty', Buffer.concat([n(2), n(0), n(10047)]), s('IntProperty')),
  ]);
  const zipped = zlib.deflateSync(data);
  return Buffer.concat([n(14), n(data.length), n(zipped.length), zipped]);
}
test('bounded read-only GVAS reader extracts game time and team IDs from valid compressed data', () => {
  const save = syntheticSave(),
    copy = Buffer.from(save);
  assert.deepEqual(readMetadata(save), { map: 'LV_World', playSeconds: 3661, teamIds: [0, 10047] });
  assert.deepEqual(save, copy);
});
test('metadata reader fails closed on unsupported, truncated, corrupt and oversized inputs', () => {
  assert.equal(readMetadata(Buffer.from('unknown')), null);
  const b = syntheticSave();
  assert.equal(readMetadata(b.subarray(0, b.length - 5)), null);
  b.writeUInt32LE(500000000, 4);
  assert.equal(readMetadata(b), null);
  assert.equal(readMetadata(Buffer.alloc(64)), null);
});
