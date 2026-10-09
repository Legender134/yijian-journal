'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_DRAFTS,
  validateDrafts,
  applyEntryCommand,
  applyDraftCommand,
  detachLinks,
} = require('../src/core/event-journal.cjs');
const { Store, defaults } = require('../src/core/store.cjs');
const migration = require('../src/core/migration.cjs');
const catalog = require('../src/data/catalog.cjs');
const T0 = '2026-10-09T08:00:00.000Z';
const T1 = '2026-10-09T08:01:00.000Z';
const context = () => ({
  profile: { id: 'draft-profile', goals: [{ id: 'goal-1', title: '拜访故人' }] },
  catalog,
});
const put = (extra = {}) => ({
  type: 'journal-draft-put',
  id: 'draft-1',
  revision: 0,
  title: '',
  body: '尚未填写标题和日期的正文',
  localTime: '',
  tags: '重复，重复，，还没写完',
  links: [],
  snapshotMode: 'none',
  ...extra,
});
const options = { now: T0 };
const create = (extra = {}, ctx = context()) => applyDraftCommand([], [], put(extra), ctx, options).drafts;
const commit = (extra = {}) => ({
  type: 'journal-draft-commit',
  id: 'draft-1',
  revision: 1,
  occurredAt: T0,
  ...extra,
});

test('unfinished invalid event fields remain durable without becoming a formal event', () => {
  const result = applyDraftCommand([], [], put(), context(), options);
  assert.equal(result.drafts[0].localTime, '');
  assert.equal(result.drafts[0].title, '');
  assert.equal(result.drafts[0].tags, '重复，重复，，还没写完');
  assert.deepEqual(result.entries, []);
  assert.throws(() => applyDraftCommand(result.drafts, [], commit(), context()), /标题/);
  assert.equal(result.drafts[0].body, put().body);
});

test('only the acknowledged draft revision can replace or remove content; independent IDs coexist', () => {
  const first = create({ title: '窗口 A' });
  const second = applyDraftCommand(
    first,
    [],
    put({ id: 'draft-2', title: '窗口 B' }),
    context(),
    options,
  ).drafts;
  const changed = applyDraftCommand(second, [], put({ revision: 1, title: '窗口 A 新编辑' }), context(), {
    now: T1,
  }).drafts;
  assert.equal(changed[0].revision, 2);
  assert.equal(changed[1].title, '窗口 B');
  assert.throws(
    () => applyDraftCommand(changed, [], put({ revision: 1, title: '过期窗口覆盖' }), context()),
    /另一个窗口/,
  );
  assert.throws(
    () =>
      applyDraftCommand(changed, [], { type: 'journal-draft-remove', id: 'draft-1', revision: 1 }, context()),
    /另一个窗口/,
  );
  assert.equal(changed[0].title, '窗口 A 新编辑');
});

test('formal save validates raw input then atomically consumes exactly that draft', () => {
  const drafts = create({ title: '正式记录', localTime: '2026-10-09T16:00', tags: '朋友，探索' });
  const other = applyDraftCommand(drafts, [], put({ id: 'draft-2' }), context(), options).drafts;
  const saved = applyDraftCommand(other, [], commit(), context(), { now: T1 });
  assert.deepEqual(
    saved.drafts.map((d) => d.id),
    ['draft-2'],
  );
  assert.equal(saved.entries[0].id, 'draft-1');
  assert.deepEqual(saved.entries[0].tags, ['朋友', '探索']);
  assert.throws(
    () => applyDraftCommand(saved.drafts, saved.entries, commit(), context()),
    /另一个窗口|不存在/,
  );
  assert.equal(saved.entries.length, 1);
  assert.throws(
    () => applyDraftCommand(drafts, [], commit({ occurredAt: '2026-02-30T08:00:00Z' }), context()),
    /有效日期/,
  );
  assert.equal(drafts.length, 1);
});

test('editing drafts never overwrite an independently changed or deleted original; copying is explicit', () => {
  const original = {
    id: 'entry-1',
    kind: 'manual',
    title: '原记录',
    body: '',
    tags: [],
    links: [],
    occurredAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
  const draft = applyDraftCommand(
    [],
    [original],
    put({ entryId: original.id, entryUpdatedAt: T0, title: '我的编辑', tags: '', snapshotMode: 'keep' }),
    context(),
    options,
  ).drafts;
  assert.throws(
    () => applyDraftCommand(draft, [{ ...original, title: '其他窗口', updatedAt: T1 }], commit(), context()),
    /原记录已被修改/,
  );
  assert.throws(() => applyDraftCommand(draft, [], commit(), context()), /原记录已被修改/);
  const copied = applyDraftCommand(
    draft,
    [original],
    put({ id: 'new-copy', sourceId: 'draft-1', title: '我的编辑', tags: '' }),
    context(),
    options,
  ).drafts;
  const result = applyDraftCommand(copied, [original], commit({ id: 'new-copy' }), context(), options);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].title, '原记录');
  assert.equal(result.entries[1].title, '我的编辑');
  assert.equal(result.drafts[0].entryId, 'entry-1');
});

test('same-tick edits and clock rollback cannot let a stale draft replace newer formal content', () => {
  const original = {
    id: 'entry-1',
    kind: 'manual',
    title: '原记录',
    body: '原文',
    tags: [],
    links: [],
    occurredAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
  const drafts = applyDraftCommand(
    [],
    [original],
    put({ entryId: original.id, entryUpdatedAt: T0, title: '过期编辑', tags: '', snapshotMode: 'keep' }),
    context(),
    options,
  ).drafts;
  const update = (title) => ({
    type: 'journal-entry-update',
    id: original.id,
    title,
    body: '新正文',
    occurredAt: T0,
    tags: [],
    links: [],
    snapshotMode: 'keep',
  });
  const changed = applyEntryCommand([original], update('另一窗口已保存'), context(), options);
  const rolledBack = applyEntryCommand(changed, update('回拨时钟后的保存'), context(), {
    now: '2026-10-09T07:59:59.000Z',
  });
  assert.ok(Date.parse(changed[0].updatedAt) > Date.parse(original.updatedAt));
  assert.ok(Date.parse(rolledBack[0].updatedAt) > Date.parse(changed[0].updatedAt));
  for (const entries of [changed, rolledBack]) {
    assert.throws(() => applyDraftCommand(drafts, entries, commit(), context(), options), /原记录已被修改/);
    assert.equal(entries[0].body, '新正文');
    assert.equal(drafts[0].title, '过期编辑');
    assert.equal(drafts[0].revision, 1);
  }
});

test('removed personal references retain their label in draft, copy and formal new record', () => {
  const ctx = context();
  const first = create({ title: '拜访笔记', tags: '', links: [{ type: 'goal', id: 'goal-1' }] }, ctx);
  const detached = detachLinks(first, 'goal', 'goal-1');
  ctx.profile.goals = [];
  validateDrafts(detached, ctx);
  const copied = applyDraftCommand(
    detached,
    [],
    put({
      id: 'copy-1',
      sourceId: 'draft-1',
      title: '另存拜访',
      tags: '',
      links: [{ type: 'goal', id: 'goal-1' }],
    }),
    ctx,
    options,
  ).drafts;
  const saved = applyDraftCommand(copied, [], commit({ id: 'copy-1' }), ctx, options);
  assert.deepEqual(saved.entries[0].links, [
    { type: 'goal', id: 'goal-1', label: '拜访故人', detached: true },
  ]);
  assert.throws(
    () => applyDraftCommand([], [], put({ links: [{ type: 'goal', id: 'goal-1' }] }), ctx),
    /关联不存在/,
  );
});

test('bounded drafts reject overflow and injected paths/capabilities without evicting content', () => {
  let drafts = [];
  for (let n = 0; n < MAX_DRAFTS; n++)
    drafts = applyDraftCommand(drafts, [], put({ id: `draft-${n}` }), context(), options).drafts;
  assert.throws(() => applyDraftCommand(drafts, [], put({ id: 'overflow' }), context()), /20/);
  assert.equal(drafts.length, MAX_DRAFTS);
  for (const extra of [
    { path: 'private' },
    { title: 'x'.repeat(161) },
    { body: 'x'.repeat(4001) },
    { revision: -1 },
    { links: [{ type: 'goal', id: 'goal-1', label: 'forged' }] },
  ])
    assert.throws(() => applyDraftCommand([], [], put(extra), context()));
  assert.throws(() => validateDrafts([{ ...drafts[0], nativeLoadToken: 'forged' }], context()));
});

test('Store restart, previous copy, atomic failed save and migration retain incomplete drafts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-journal-drafts-'));
  const store = new Store(dir, catalog);
  const p = store.get().profiles[0];
  store.mutate({ ...put(), profileId: p.id });
  const before = fs.readFileSync(store.file);
  const loaded = new Store(dir, catalog);
  assert.equal(loaded.get().profiles[0].journalDrafts[0].body, put().body);
  const file = path.join(dir, 'drafts.yijian-protection');
  await migration.exportProtection({ dataRoot: dir, file });
  const targetDirectory = path.join(dir, 'history');
  await migration.importProtection({ file, targetDirectory });
  const portable = (await migration.readHistory({ directory: targetDirectory })).journal;
  assert.deepEqual(portable.profiles[0].journalDrafts, loaded.get().profiles[0].journalDrafts);
  const imported = new Store(path.join(dir, 'imported'), catalog);
  imported.importData(portable);
  assert.equal(imported.get().profiles[0].journalDrafts[0].localTime, '');
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === loaded.file) throw Object.assign(Error('synthetic disk unavailable'), { code: 'EIO' });
    return rename(source, target);
  };
  try {
    assert.throws(
      () => loaded.mutate({ ...put({ revision: 1, body: '未确认写入' }), profileId: p.id }),
      /synthetic/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readFileSync(loaded.file), before);
  assert.equal(loaded.get().profiles[0].journalDrafts[0].body, put().body);
  assert.deepEqual(fs.readFileSync(loaded.file + '.previous'), before);
  assert.ok(fs.readdirSync(dir).some((file) => file.endsWith('.tmp')));
});

test('new draft fields remain optional for prior journal schema', async () => {
  const state = defaults();
  assert.equal(state.profiles[0].journalDrafts, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-journal-drafts-legacy-'));
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(state));
  const file = path.join(dir, 'legacy.yijian-protection');
  await migration.exportProtection({ dataRoot: dir, file });
  const targetDirectory = path.join(dir, 'history');
  await migration.importProtection({ file, targetDirectory });
  assert.equal(
    (await migration.readHistory({ directory: targetDirectory })).journal.profiles[0].journalDrafts,
    undefined,
  );
});
