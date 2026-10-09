'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store, validateState } = require('../src/core/store.cjs');
const { StartupRecovery } = require('../src/core/startup-recovery.cjs');
const { applyEntryCommand, applyDraftCommand } = require('../src/core/event-journal.cjs');
const {
  MAX_REVISIONS,
  MAX_REVISION_BYTES,
  validateRevisions,
  applyRevisionCommand,
  retainEditedRevisions,
  assertFreshEntryIds,
} = require('../src/core/journal-revisions.cjs');
const migration = require('../src/core/migration.cjs');
const complete = require('../src/core/complete-migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs');
const T0 = '2026-10-09T00:00:00.000Z',
  T1 = '2026-10-09T00:01:00.000Z';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-record-versions-'));
const current = (store) => store.get().profiles.find((p) => p.id === store.get().activeProfileId);
const manual = (extra = {}) => ({
  type: 'journal-entry-put',
  title: '原标题',
  body: '原正文\n完整末尾',
  occurredAt: T0,
  tags: ['故人'],
  links: [],
  snapshotMode: 'none',
  ...extra,
});
const entry = (extra = {}) => ({
  id: 'entry-1',
  kind: 'manual',
  title: '原标题',
  body: '原正文',
  occurredAt: T0,
  createdAt: T0,
  updatedAt: T0,
  tags: ['故人'],
  links: [],
  ...extra,
});
const ctx = () => ({ profile: { id: 'profile-1', goals: [] } });
const row = (extra = {}) => ({ id: 'version-1', entry: entry(), replacedAt: T1, ...extra });
function fixture(name) {
  return new Store(path.join(root, name), catalog);
}
function update(store, fields = {}) {
  const original = current(store).journalEntries.find((e) => e.kind === 'manual');
  return {
    ...manual(),
    body: '实际修改后的正文',
    type: 'journal-entry-update',
    id: original.id,
    expectedEntry: original,
    ...fields,
  };
}
function draft(original, fields = {}) {
  return {
    type: 'journal-draft-put',
    id: 'edit-draft',
    revision: 0,
    entryId: original.id,
    entryUpdatedAt: original.updatedAt,
    entrySnapshot: original,
    title: '误改标题',
    body: '误改正文',
    localTime: '2026-10-09T08:00',
    tags: '改过标签',
    links: [],
    snapshotMode: 'none',
    ...fields,
  };
}
function revisionCommand(store, type = 'journal-revision-restore') {
  const p = current(store),
    revision = p.journalRevisions[0];
  return {
    type,
    id: revision.id,
    profileId: p.id,
    expectedRevision: revision,
    expectedEntry: p.journalEntries.find((e) => e.id === revision.entry.id) || null,
  };
}
function unchanged(store, command, pattern) {
  const state = store.get(),
    bytes = fs.readFileSync(store.file),
    previous = fs.readFileSync(store.file + '.previous');
  assert.throws(() => store.mutate(command), pattern);
  assert.deepEqual(store.get(), state);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(fs.readFileSync(store.file + '.previous'), previous);
}

test('direct edits and real draft commits retain complete previous versions in the same commit', () => {
  const store = fixture('both-edit-paths');
  store.mutate({ type: 'goal-add', title: '原目标' });
  const goal = current(store).goals[0];
  store.mutate(manual({ links: [{ type: 'goal', id: goal.id }], snapshotMode: 'selected' }), {
    selectedReference: {
      name: '1.sav',
      hash: 'a'.repeat(64),
      modifiedAt: T0,
      metadata: { mapName: '原地点', playSeconds: 123 },
      path: '/synthetic/never-persist',
    },
  });
  const original = current(store).journalEntries[0];
  store.mutate(update(store, { title: '修改后的标题', body: '修改后的正文', tags: ['新标签'] }));
  let p = current(store);
  assert.deepEqual(p.journalRevisions[0].entry, original);
  assert.equal(p.journalRevisions.length, 1);
  assert.ok(Date.parse(p.journalRevisions[0].replacedAt) > Date.parse(original.updatedAt));
  const second = p.journalEntries[0];
  store.mutate(draft(second));
  store.mutate({ type: 'journal-draft-commit', id: 'edit-draft', revision: 1, occurredAt: T0 });
  p = current(store);
  assert.deepEqual(p.journalRevisions[1].entry, second);
  assert.equal(p.journalEntries[0].body, '误改正文');
  assert.deepEqual(p.journalDrafts, []);
  assert.deepEqual(new Store(store.dir, catalog).get().profiles[0].journalRevisions, p.journalRevisions);
  assert.doesNotMatch(JSON.stringify(p.journalRevisions), /never-persist|nativeLoad|inventory/);
});

test('restore creates a separate manual record and preserves source, later records, drafts and completed goals', () => {
  const store = fixture('restore-as-new');
  store.mutate({ type: 'goal-add', title: '已经完成' });
  store.mutate({ type: 'goal-toggle', id: current(store).goals[0].id });
  store.mutate(manual());
  store.mutate(update(store, { body: '当前仍要保留' }));
  store.mutate(manual({ title: '后来新增的记录', body: '后来内容' }));
  const p = current(store),
    original = p.journalRevisions[0].entry;
  const command = revisionCommand(store);
  // Cancelling the preview means no mutation and no version consumption.
  assert.deepEqual(current(store), p);
  store.mutate(command);
  const after = current(store),
    restored = after.journalEntries.at(-1);
  assert.notEqual(restored.id, original.id);
  for (const key of ['kind', 'title', 'body', 'occurredAt', 'tags', 'links'])
    assert.deepEqual(restored[key], original[key]);
  assert.ok(Date.parse(restored.createdAt) > Date.parse(original.createdAt));
  assert.deepEqual(after.journalEntries.slice(0, -1), p.journalEntries);
  assert.deepEqual(after.journalRevisions, p.journalRevisions);
  assert.deepEqual(after.goals, p.goals);
});

test('stale complete entry, stale revision and foreign profile guards reject without writes', () => {
  const store = fixture('stale');
  store.mutate(manual());
  const original = current(store).journalEntries[0];
  store.mutate(draft(original));
  store.mutate(update(store, { body: '另一窗口的正文' }));
  unchanged(
    store,
    { type: 'journal-draft-commit', id: 'edit-draft', revision: 1, occurredAt: T0 },
    /原记录已被修改/,
  );
  const command = revisionCommand(store);
  for (const malformed of [
    { ...command, profileId: undefined },
    { ...command, profileId: 'foreign-profile' },
    { ...command, expectedEntry: original },
    { ...command, expectedRevision: { ...command.expectedRevision, replacedAt: T0 } },
    { ...command, expectedRevision: { ...command.expectedRevision, entry: { ...original, body: '伪造' } } },
    { ...command, nativeLoadToken: 'forged' },
  ])
    unchanged(store, malformed);
  unchanged(
    store,
    update(store, {
      expectedEntry: {
        ...current(store).journalEntries[0],
        links: [{ type: 'goal', id: 'old', label: '旧引用', detached: true }],
      },
    }),
    /原记录已变化/,
  );
  assert.equal(current(store).journalDrafts[0].body, '误改正文');
});

test('complete snapshots detect same-timestamp edits; legacy editing drafts remain readable but cannot overwrite', () => {
  const original = entry(),
    context = ctx();
  const created = applyDraftCommand([], [original], draft(original), context, { now: T0 });
  assert.throws(
    () =>
      applyDraftCommand(
        created.drafts,
        [{ ...original, body: '相同时间戳但正文不同' }],
        { type: 'journal-draft-commit', id: 'edit-draft', revision: 1, occurredAt: T0 },
        context,
      ),
    /完整核对|已被修改/,
  );
  const legacy = structuredClone(created.drafts);
  delete legacy[0].entrySnapshot;
  assert.throws(
    () =>
      applyDraftCommand(
        legacy,
        [original],
        { type: 'journal-draft-commit', id: 'edit-draft', revision: 1, occurredAt: T0 },
        context,
      ),
    /完整核对/,
  );
  assert.throws(
    () =>
      applyEntryCommand([original], { ...manual(), type: 'journal-entry-update', id: original.id }, context),
    /完整核对/,
  );
});

test('row and UTF-8 byte capacities reject edits atomically and preserve the saved editing draft', () => {
  for (const mode of ['rows', 'bytes']) {
    const store = fixture('capacity-' + mode);
    store.mutate(manual());
    const original = current(store).journalEntries[0];
    store.mutate(draft(original));
    const state = store.get(),
      p = state.profiles[0];
    if (mode === 'rows')
      p.journalRevisions = Array.from({ length: MAX_REVISIONS }, (_, i) => row({ id: 'v-' + i }));
    else {
      const sample = row({ entry: entry({ body: '汉'.repeat(4000) }) });
      const sampleBytes = Buffer.byteLength(JSON.stringify(sample));
      const count = Math.floor((MAX_REVISION_BYTES - 100) / (sampleBytes + 8));
      p.journalRevisions = Array.from({ length: count }, (_, i) => ({ ...sample, id: 'v-' + i }));
      const remaining = MAX_REVISION_BYTES - Buffer.byteLength(JSON.stringify(p.journalRevisions));
      // Pad with small legal versions so less than a new original version fits.
      let index = count;
      while (
        Buffer.byteLength(JSON.stringify(p.journalRevisions)) +
          Buffer.byteLength(JSON.stringify(row({ id: 'v-' + index }))) +
          1 <=
        MAX_REVISION_BYTES
      )
        p.journalRevisions.push(row({ id: 'v-' + index++ }));
      assert.ok(remaining > 0);
      assert.ok(Buffer.byteLength(JSON.stringify(p.journalRevisions)) <= MAX_REVISION_BYTES);
    }
    store.commit(state);
    unchanged(
      store,
      { type: 'journal-draft-commit', id: 'edit-draft', revision: 1, occurredAt: T0 },
      /5000|8 MiB/,
    );
    unchanged(store, update(store, { body: '直接编辑也不能丢弃旧文' }), /5000|8 MiB/);
    assert.deepEqual(current(store).journalEntries[0], original);
    assert.equal(current(store).journalDrafts[0].body, '误改正文');
  }
});

test('strict imported versions reject duplicate IDs, unknown fields, system events, bad timestamps and oversized UTF-8', () => {
  const context = ctx();
  assert.doesNotThrow(() => validateRevisions([row(), row({ id: 'v-2' })], context));
  for (const rows of [
    [row(), row()],
    [row({ path: '/private' })],
    [row({ entry: entry({ nativeLoadToken: 'forged' }) })],
    [row({ entry: entry({ id: '../escape' }) })],
    [row({ entry: entry({ kind: 'goal-completed' }) })],
    [row({ replacedAt: T0 })],
    [row({ replacedAt: '2026-02-30T00:00:00Z' })],
    Array.from({ length: 700 }, (_, i) => row({ id: 'v-' + i, entry: entry({ body: '汉'.repeat(4000) }) })),
  ])
    assert.throws(() => validateRevisions(rows, context));
  assert.throws(
    () =>
      applyRevisionCommand(
        [entry()],
        [row()],
        {
          type: 'journal-revision-restore',
          id: 'version-1',
          expectedRevision: row(),
          expectedEntry: entry(),
        },
        context,
        { id: 'entry-1' },
      ),
    /冲突/,
  );
  assert.throws(() => assertFreshEntryIds([], [entry()], [row()]), /历史冲突/);
  const sameTime = applyEntryCommand(
    [entry()],
    { ...manual(), type: 'journal-entry-update', id: 'entry-1', expectedEntry: entry() },
    context,
    { now: T0 },
  );
  assert.equal(retainEditedRevisions([entry()], sameTime, [], context, { id: 'v' })[0].entry.body, '原正文');
});

test('removed personal associations detach in all versions and snapshots and never attach to reused entity IDs', () => {
  const store = fixture('detached');
  store.mutate({ type: 'journey-todo-put', id: 'todo-reused', title: '原待办', detail: '', done: false });
  store.mutate(manual({ links: [{ type: 'todo', id: 'todo-reused' }] }));
  store.mutate(update(store, { links: [{ type: 'todo', id: 'todo-reused' }], snapshotMode: 'keep' }));
  const original = current(store).journalEntries[0];
  store.mutate(draft(original, { links: [{ type: 'todo', id: 'todo-reused' }] }));
  const todo = current(store).journey.todos[0];
  store.mutate({ type: 'journey-todo-remove', id: todo.id, expectedRecord: todo });
  store.mutate({ type: 'journey-todo-put', id: todo.id, title: '同编号新待办', detail: '', done: false });
  let p = current(store);
  assert.equal(p.journalRevisions[0].entry.links[0].detached, true);
  assert.equal(p.journalDrafts[0].entrySnapshot.links[0].detached, true);
  store.mutate(revisionCommand(store));
  p = current(store);
  assert.deepEqual(p.journalEntries.at(-1).links[0], {
    type: 'todo',
    id: todo.id,
    label: '原待办',
    detached: true,
  });
  assert.equal(p.journey.todos[0].title, '同编号新待办');
});

test('restoration at the formal-record limit rejects without consuming the version or changing current records', () => {
  const entries = Array.from({ length: 5000 }, (_, i) => entry({ id: 'entry-' + i }));
  const revision = row({ entry: entries[0] }),
    before = structuredClone(entries),
    versions = [revision];
  assert.throws(
    () =>
      applyRevisionCommand(
        entries,
        versions,
        {
          type: 'journal-revision-restore',
          id: revision.id,
          expectedRevision: revision,
          expectedEntry: entries[0],
        },
        ctx(),
      ),
    /5000/,
  );
  assert.deepEqual(entries, before);
  assert.deepEqual(versions, [revision]);
});

test('permanent removal consumes only the confirmed version and restoring after source deletion still creates a new record', () => {
  const store = fixture('purge');
  store.mutate(manual());
  store.mutate(update(store));
  store.mutate(update(store, { body: '第二次编辑' }));
  const preview = revisionCommand(store, 'journal-revision-purge');
  const p = current(store),
    source = p.journalEntries[0];
  store.mutate({ type: 'journal-entry-remove', id: source.id, expectedEntry: source });
  unchanged(store, preview, /原记录已变化/);
  store.mutate(revisionCommand(store));
  assert.equal(current(store).journalTrash[0].entry.id, source.id);
  assert.notEqual(current(store).journalEntries[0].id, source.id);
  const purge = revisionCommand(store, 'journal-revision-purge');
  const before = current(store).journalEntries;
  store.mutate(purge);
  assert.equal(current(store).journalRevisions.length, 1);
  assert.deepEqual(current(store).journalEntries, before);
  unchanged(store, purge, /旧版本已变化/);
});

test('JSON, full protection, read-only history and explicit startup recovery preserve complete versions', async () => {
  const store = fixture('transport');
  store.mutate(manual());
  store.mutate(update(store));
  store.mutate(draft(current(store).journalEntries[0]));
  const expected = current(store).journalRevisions;
  const json = path.join(store.dir, 'export.json');
  fs.writeFileSync(json, JSON.stringify(store.get()));
  const imported = fixture('json-import');
  imported.importData(JSON.parse(fs.readFileSync(json)));
  assert.deepEqual(current(imported).journalRevisions, expected);
  const protection = path.join(store.dir, 'complete.yijian-protection');
  await migration.exportProtection({ dataRoot: store.dir, file: protection });
  const targetDirectory = path.join(root, 'read-only-history');
  await migration.importProtection({ file: protection, targetDirectory });
  const history = (await migration.readHistory({ directory: targetDirectory })).journal;
  assert.deepEqual(history.profiles[0].journalRevisions, expected);
  assert.deepEqual(
    history.profiles[0].journalDrafts[0].entrySnapshot,
    current(store).journalDrafts[0].entrySnapshot,
  );
  for (const kind of ['json', 'protection']) {
    const broken = path.join(root, 'startup-' + kind);
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'journal.json'), 'broken current');
    fs.writeFileSync(path.join(broken, 'journal.json.previous'), 'broken previous');
    const recovery = new StartupRecovery(broken, catalog);
    const preview = await recovery.preview(kind, kind === 'json' ? json : protection);
    assert.equal(preview.profiles[0].recordVersions, expected.length);
    await recovery.confirm(preview.token);
    assert.deepEqual(current(new Store(broken, catalog)).journalRevisions, expected);
  }
  const malformed = store.get();
  malformed.profiles[0].journalRevisions[0].nativeLoadToken = 'forged';
  assert.throws(() => validateState(malformed, store.ids), /未知字段/);
});

test('failed disk replacement leaves the current record and durable editing draft recoverable without a half-version', () => {
  const store = fixture('disk-failure');
  store.mutate(manual());
  const original = current(store).journalEntries[0];
  store.mutate(draft(original));
  const before = store.get(),
    bytes = fs.readFileSync(store.file),
    rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === store.file) throw Object.assign(Error('synthetic disk full'), { code: 'ENOSPC' });
    return rename(source, target);
  };
  try {
    assert.throws(
      () => store.mutate({ type: 'journal-draft-commit', id: 'edit-draft', revision: 1, occurredAt: T0 }),
      /synthetic disk full/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  const loaded = new Store(store.dir, catalog);
  assert.deepEqual(current(loaded).journalEntries[0], original);
  assert.equal(current(loaded).journalDrafts[0].body, '误改正文');
  assert.deepEqual(current(loaded).journalRevisions, []);
});

test('successive complete protection collections retain every generation of record versions as independent read-only histories', async () => {
  const a = fixture('complete-generation-a'),
    b = fixture('complete-generation-b'),
    receiver = fixture('complete-receiver');
  for (const [store, name] of [
    [a, '第一代'],
    [b, '第二代'],
  ]) {
    store.mutate(manual({ title: name + '原文' }));
    store.mutate(update(store, { title: name + '修改后' }));
    store.mutate(draft(current(store).journalEntries[0]));
  }
  const expected = [current(a).journalRevisions, current(b).journalRevisions];
  const originals = [a, b, receiver].map((store) => fs.readFileSync(store.file));
  const one = path.join(root, 'version-generation-a.yijian-protection');
  await migration.exportProtection({ dataRoot: a.dir, file: one });
  const bArchives = new ProtectionArchives(b.dir, () => ''),
    receiverArchives = new ProtectionArchives(receiver.dir, () => '');
  await bArchives.import(one);
  const collection = path.join(root, 'version-generations-complete.yijian-protection');
  await complete.exportComplete({ dataRoot: b.dir, archives: bArchives, file: collection });
  const imported = await complete.importComplete({ archives: receiverArchives, file: collection });
  assert.equal(imported.archiveIds.length, 2);
  const histories = await Promise.all(
    imported.archiveIds.map((id) => receiverArchives.history(id, receiver)),
  );
  for (const history of histories) {
    assert.ok(history.readOnly && !history.bound);
    const profile = history.journal.profiles[0],
      matching = expected.find((rows) => rows[0].id === profile.journalRevisions[0].id);
    assert.deepEqual(profile.journalRevisions, matching);
    assert.equal(profile.journalDrafts[0].entrySnapshot.id, profile.journalEntries[0].id);
    assert.equal(history.journal.settings.savePath, '');
  }
  for (const [i, store] of [a, b, receiver].entries())
    assert.deepEqual(fs.readFileSync(store.file), originals[i]);
});

test('version views show complete escaped content with read-only historical controls and per-entry entry points', async () => {
  const module = await import(
    'data:text/javascript;base64,' +
      fs.readFileSync(path.join(__dirname, '../src/renderer/event-journal-views.js')).toString('base64')
  );
  const helpers = {
    esc: (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    act: (a, l, c, id) => `<button data-action="${a}" data-id="${id || ''}">${l}</button>`,
    pill: (s) => `<span>${s}</span>`,
    notice: (s) => s,
    empty: (s) => s,
    when: (s) => s,
    icon: () => '',
  };
  const views = module.createEventJournalViews(helpers);
  const old = row({
    entry: entry({
      body: '<script>bad()</script>' + '正文'.repeat(1900) + '完整末尾',
      snapshot: { name: '1.sav', hash: 'a'.repeat(64), modifiedAt: T0, mapName: '旧地点', playSeconds: 123 },
    }),
  });
  const p = { ...ctx().profile, journalEntries: [entry()], journalRevisions: [old] };
  const detail = views.revisionDetail(p, old.id);
  assert.match(detail, /完整末尾/);
  assert.match(detail, /原游玩秒数 123/);
  assert.ok(detail.includes(T0));
  assert.match(detail, /&lt;script>/);
  assert.doesNotMatch(detail, /<script>/);
  assert.match(views.detail(p, 'entry-1'), /journal-revisions-entry/);
  assert.match(views.revisions(p), /另存为新记录/);
  const history = views.revisions(p, { readOnly: true }) + views.revisionDetail(p, old.id, true);
  assert.match(history, /historical-journal-revision-detail/);
  assert.doesNotMatch(history, /data-action="journal-revision-(restore|purge)/);
});

test('unchanged direct and draft saves advance concurrency timestamps without versions, including at full capacity', () => {
  for (const full of [false, true]) {
    const store = fixture('unchanged-' + full);
    store.mutate(manual());
    if (full) {
      const state = store.get();
      state.profiles[0].journalRevisions = Array.from({ length: MAX_REVISIONS }, (_, i) =>
        row({ id: 'full-' + i }),
      );
      store.commit(state);
    }
    let original = current(store).journalEntries[0];
    const command = {
      type: 'journal-entry-update',
      id: original.id,
      expectedEntry: original,
      title: original.title,
      body: original.body,
      occurredAt: original.occurredAt,
      tags: original.tags,
      links: original.links.map(({ type, id }) => ({ type, id })),
      snapshotMode: 'keep',
    };
    store.mutate(command);
    let p = current(store);
    assert.ok(Date.parse(p.journalEntries[0].updatedAt) > Date.parse(original.updatedAt));
    assert.equal(p.journalRevisions.length, full ? MAX_REVISIONS : 0);
    assert.deepEqual(p.journalEntries[0], { ...original, updatedAt: p.journalEntries[0].updatedAt });
    original = p.journalEntries[0];
    store.mutate(
      draft(original, {
        title: original.title,
        body: original.body,
        tags: original.tags.join('，'),
        links: original.links.map(({ type, id }) => ({ type, id })),
        snapshotMode: 'keep',
      }),
    );
    store.mutate({
      type: 'journal-draft-commit',
      id: 'edit-draft',
      revision: 1,
      occurredAt: original.occurredAt,
    });
    p = current(store);
    assert.deepEqual(p.journalDrafts, []);
    assert.equal(p.journalRevisions.length, full ? MAX_REVISIONS : 0);
    assert.deepEqual(p.journalEntries[0], { ...original, updatedAt: p.journalEntries[0].updatedAt });
    assert.ok(Date.parse(p.journalEntries[0].updatedAt) > Date.parse(original.updatedAt));
  }
});

test.after(() => console.log('Retained synthetic record-version fixtures: ' + root));
