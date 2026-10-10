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

test('rapid clears retain exact unsaved full texts and the saved baseline in one cold-recoverable write', (t) => {
  const { store, root, p } = fixture(t);
  const baseline = 'saved baseline';
  const first = '  saved baseline\n刚输入 <script>literal</script>  ';
  const second = '\n第二次尚未自动保存的全文\n';
  store.mutate({ type: 'note', value: baseline });
  const previous = fs.readFileSync(path.join(root, 'journal.json'));
  store.mutate({ type: 'note', value: 'clear 后续写', clearedValues: [first, second] });
  assert.equal(p().notes, 'clear 后续写');
  assert.deepEqual(
    p().noteRevisions.map((row) => row.body),
    [second, first, baseline],
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'journal.json.previous')), previous);
  const cold = new Store(root, catalog);
  assert.deepEqual(cold.get().profiles[0], p());
  cold.mutate({ type: 'note-restore', id: p().noteRevisions[1].id, expectedValue: p().notes });
  assert.equal(cold.get().profiles[0].notes, first);
});

test('unsaved clear history is retained even without a saved baseline or a changed final body', (t) => {
  const { store, p } = fixture(t);
  store.mutate({ type: 'note', value: '', clearedValues: ['never saved first draft'] });
  assert.equal(p().notes, '');
  assert.equal(p().noteRevisions[0].body, 'never saved first draft');
  store.mutate({
    type: 'note',
    value: 'undo restored exact text',
    clearedValues: ['undo restored exact text'],
  });
  assert.equal(p().notes, 'undo restored exact text');
  assert.equal(p().noteRevisions[0].body, p().notes);
});

test('a late clear followed by new text also protects the latest saved text from another window', (t) => {
  const { store, p } = fixture(t);
  store.mutate({ type: 'note', value: 'old history' });
  store.mutate({ type: 'note', value: '' });
  store.mutate({ type: 'note', value: 'other window latest saved text' });
  store.mutate({ type: 'note', value: 'later continuation', clearedValues: ['local unsaved clear text'] });
  assert.equal(p().notes, 'later continuation');
  assert.deepEqual(
    p().noteRevisions.map((row) => row.body),
    ['local unsaved clear text', 'other window latest saved text', 'old history'],
  );
});

test('clear snapshots follow their explicit profile while active profile and its text remain unchanged', (t) => {
  const { store, p } = fixture(t);
  const one = p().id;
  store.mutate({ type: 'note', value: 'profile one saved' });
  store.mutate({ type: 'profile-add', name: 'second' });
  store.mutate({ type: 'note', value: 'profile two saved' });
  const before = store.get(),
    two = before.activeProfileId;
  store.mutate({ type: 'note', profileId: one, value: '', clearedValues: ['profile one unsaved'] });
  const after = store.get();
  assert.equal(after.activeProfileId, two);
  assert.deepEqual(
    after.profiles.find((row) => row.id === two),
    before.profiles.find((row) => row.id === two),
  );
  assert.deepEqual(
    p().noteRevisions.map((row) => row.body),
    ['profile one unsaved', 'profile one saved'],
  );
});

test('invalid clear batches are rejected without changing disk, memory or recoverable history', (t) => {
  const { store, root } = fixture(t);
  store.mutate({ type: 'note', value: 'valid saved text' });
  const before = store.get(),
    raw = fs.readFileSync(path.join(root, 'journal.json'));
  for (const clearedValues of [
    null,
    {},
    'text',
    ['', 'valid'],
    ['  '],
    [7],
    ['x'.repeat(20001)],
    Array(21).fill('x'),
  ]) {
    assert.throws(() => store.mutate({ type: 'note', value: '', clearedValues }));
    assert.deepEqual(store.get(), before);
    assert.deepEqual(fs.readFileSync(path.join(root, 'journal.json')), raw);
  }
});

test('clear retries retain stable revision identities, distinct order and the existing twenty-version limit', (t) => {
  const { store, p } = fixture(t);
  const batch = Array.from({ length: 20 }, (_, i) => 'unsaved clear ' + i);
  store.mutate({ type: 'note', value: '', clearedValues: batch });
  const rows = p().noteRevisions;
  store.mutate({ type: 'note', value: '', clearedValues: batch });
  assert.deepEqual(p().noteRevisions, rows);
  store.mutate({ type: 'note', value: '', clearedValues: [batch[5], 'x'.repeat(20000)] });
  assert.equal(p().noteRevisions.length, 20);
  assert.equal(new Set(p().noteRevisions.map((row) => row.body)).size, 20);
  assert.equal(p().noteRevisions[0].body.length, 20000);
  assert.equal(p().noteRevisions[1].id, rows.find((row) => row.body === batch[5]).id);
  assert(!p().noteRevisions.some((row) => row.body === batch[0]));
});

test('atomic replacement failure leaves clear history uncommitted and the whole batch can be retried', (t) => {
  const { store, root, p } = fixture(t);
  store.mutate({ type: 'note', value: 'protected saved baseline' });
  const before = store.get(),
    raw = fs.readFileSync(path.join(root, 'journal.json'));
  const original = fs.renameSync;
  const blocked = t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === path.join(root, 'journal.json')) throw Error('synthetic atomic replacement blocked');
    return original.call(this, from, to);
  });
  const command = { type: 'note', value: '', clearedValues: ['unsaved clear one', 'unsaved clear two'] };
  assert.throws(() => store.mutate(command), /synthetic atomic replacement blocked/);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(path.join(root, 'journal.json')), raw);
  blocked.mock.restore();
  store.mutate(command);
  assert.equal(p().notes, '');
  assert.deepEqual(
    p().noteRevisions.map((row) => row.body),
    ['unsaved clear two', 'unsaved clear one', 'protected saved baseline'],
  );
});
