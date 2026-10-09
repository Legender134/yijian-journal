'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { MAX_NOTE_REVISIONS, validateNoteRevisions } = require('../src/core/note-revisions.cjs');
const migration = require('../src/core/migration.cjs');
const catalog = require('../src/data/catalog.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-note-revisions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source'),
    store = new Store(root, catalog);
  return { dir, root, store, p: () => store.get().profiles[0] };
}
test('clearing or replacing a note retains its exact previous text across cold restart', (t) => {
  const { store, root, p } = fixture(t);
  const original = '  synthetic old note\n\n第二行 <script>literal</script>  ';
  store.mutate({ type: 'note', value: original });
  assert.equal(p().noteRevisions, undefined);
  store.mutate({ type: 'note', value: '' });
  assert.equal(p().notes, '');
  assert.equal(p().noteRevisions[0].body, original);
  const cold = new Store(root, catalog),
    before = cold.get().profiles[0];
  cold.mutate({ type: 'note-restore', id: before.noteRevisions[0].id, expectedValue: '' });
  assert.equal(cold.get().profiles[0].notes, original);
  cold.mutate({ type: 'note', value: 'later content' });
  assert.equal(cold.get().profiles[0].noteRevisions.filter((row) => row.body === original).length, 1);
});
test('restore refuses a stale preview and retains both the newer note and its old version', (t) => {
  const { store, p } = fixture(t);
  store.mutate({ type: 'note', value: 'older text' });
  store.mutate({ type: 'note', value: 'current text' });
  const id = p().noteRevisions[0].id;
  store.mutate({ type: 'note', value: 'another window changed it' });
  const before = store.get();
  assert.throws(() => store.mutate({ type: 'note-restore', id, expectedValue: 'current text' }), /已变化/);
  assert.deepEqual(store.get(), before);
  store.mutate({ type: 'note-restore', id, expectedValue: p().notes });
  assert.equal(p().notes, 'older text');
  assert(p().noteRevisions.some((row) => row.body === 'another window changed it'));
});
test('note recovery is scoped to its profile and unchanged saves do not consume history', (t) => {
  const { store, p } = fixture(t);
  store.mutate({ type: 'note', value: 'profile one original' });
  store.mutate({ type: 'note', value: 'profile one current' });
  const one = p();
  store.mutate({ type: 'note', value: one.notes });
  assert.deepEqual(p().noteRevisions, one.noteRevisions);
  store.mutate({ type: 'profile-add', name: 'Second journey' });
  const two = store.get().activeProfileId;
  const before = store.get();
  assert.throws(
    () =>
      store.mutate({ type: 'note-restore', id: one.noteRevisions[0].id, profileId: two, expectedValue: '' }),
    /已变化/,
  );
  assert.deepEqual(store.get(), before);
  assert.equal(p().notes, one.notes);
});
test('recent distinct nonempty note history has an explicit bounded retention', (t) => {
  const { store, p } = fixture(t);
  for (let i = 0; i < MAX_NOTE_REVISIONS + 3; i++) {
    store.mutate({ type: 'note', value: 'version ' + i });
    store.mutate({ type: 'note', value: '' });
  }
  assert.equal(p().noteRevisions.length, MAX_NOTE_REVISIONS);
  assert.equal(p().noteRevisions[0].body, 'version 22');
  assert.equal(p().noteRevisions.at(-1).body, 'version 3');
  const rows = p().noteRevisions;
  assert.equal(validateNoteRevisions(rows), rows);
});
test('frequent automatic saves after clearing cannot quickly evict the cleared text', (t) => {
  const { store, p } = fixture(t);
  store.mutate({ type: 'note', value: 'accidentally cleared important text' });
  store.mutate({ type: 'note', value: '' });
  for (let i = 0; i < 50; i++) store.mutate({ type: 'note', value: 'new writing ' + i });
  assert.equal(p().noteRevisions.length, 1);
  assert.equal(p().noteRevisions[0].body, 'accidentally cleared important text');
  const { retainNote } = require('../src/core/note-revisions.cjs');
  const rows = retainNote(p().notes, 'after a later edit', p().noteRevisions, {
    now: new Date(Date.parse(p().noteRevisions[0].replacedAt) + 300000).toISOString(),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body, 'new writing 49');
});
test('note history validates its bounds and fields instead of accepting arbitrary portable data', () => {
  const row = { id: 'synthetic-id', body: 'valid old text', replacedAt: '2026-10-09T00:00:00.000Z' };
  for (const rows of [
    null,
    {},
    [row, row],
    [{ ...row, extra: true }],
    [{ ...row, body: '' }],
    [{ ...row, body: 'x'.repeat(20001) }],
    [{ ...row, replacedAt: 'bad' }],
    Array.from({ length: 21 }, (_, i) => ({ ...row, id: 'id-' + i })),
  ])
    assert.throws(() => validateNoteRevisions(rows));
  assert.doesNotThrow(() => validateNoteRevisions([row]));
});
test('note history survives full protection export, read-only history and startup recovery', async (t) => {
  const { store, dir, p, root } = fixture(t);
  store.mutate({ type: 'note', value: 'protected synthetic old note\nfull text' });
  store.mutate({ type: 'note', value: '' });
  const previous = p().noteRevisions,
    file = path.join(dir, 'notes.yijian-protection');
  await migration.exportProtection({ dataRoot: root, file });
  const targetDirectory = path.join(dir, 'history');
  await migration.importProtection({ file, targetDirectory });
  assert.deepEqual(
    (await migration.readHistory({ directory: targetDirectory })).journal.profiles[0].noteRevisions,
    previous,
  );
  const { StartupRecovery } = require('../src/core/startup-recovery.cjs');
  const broken = path.join(dir, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'journal.json'), 'synthetic damaged');
  const recovery = new StartupRecovery(broken, catalog),
    preview = await recovery.preview('protection', file);
  assert.equal(preview.profiles[0].noteVersions, 1);
  await recovery.confirm(preview.token);
  const recovered = new Store(broken, catalog);
  assert.deepEqual(recovered.get().profiles[0].noteRevisions, previous);
  recovered.mutate({ type: 'note-restore', id: previous[0].id, expectedValue: '' });
  assert.equal(recovered.get().profiles[0].notes, previous[0].body);
});
