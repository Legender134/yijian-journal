'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, defaults, atomicWrite } = require('../src/core/store.cjs');
const { StartupRecovery, isolation, MARKER, recoveryError } = require('../src/core/startup-recovery.cjs');
const migration = require('../src/core/migration.cjs');
const collection = require('../src/core/protection-collection.cjs');
const catalog = require('../src/data/catalog.cjs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent =
    process.env.YIJIAN_STARTUP_RECOVERY_TMPDIR ||
    path.join(__dirname, '..', '.test-data', 'startup-recovery-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'synthetic-')),
    data = path.join(root, 'userdata');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'journal.json'), 'synthetic damaged current\n');
  fs.writeFileSync(path.join(data, 'journal.json.previous'), '{ synthetic damaged previous }');
  const incoming = defaults();
  incoming.profiles[0].name = '恢复验收周目';
  incoming.profiles[0].notes = '完整笔记不会丢失';
  incoming.profiles[0].goals = [{ id: 'synthetic-goal', title: '找线索', detail: '保留', done: false }];
  incoming.profiles[0].saveSlot = '29.sav';
  incoming.profiles[0].referenceMode = 'slot';
  incoming.settings.savePath = 'synthetic-old-account/SaveGames';
  incoming.settings.steamPath = 'synthetic-old-steam';
  incoming.token = 'must-not-restore';
  const file = path.join(root, 'export.json');
  fs.writeFileSync(file, JSON.stringify(incoming));
  return { root, data, file, incoming, before: originalBytes(data) };
}
function originalBytes(data) {
  return ['journal.json', 'journal.json.previous'].map((name) => [
    name,
    fs.readFileSync(path.join(data, name)),
  ]);
}
function unchanged(f) {
  assert.deepEqual(originalBytes(f.data), f.before);
}
async function protection(f, suffix = 'one') {
  const source = path.join(f.root, 'export-source-' + suffix);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'journal.json'), JSON.stringify(f.incoming));
  const file = path.join(f.root, suffix + '.yijian-protection');
  await migration.exportProtection({ dataRoot: source, file });
  return file;
}
test('both broken copies reach an explicit recovery error without replacing or copying either original', () => {
  const f = fixture();
  assert.throws(
    () => new Store(f.data, catalog),
    (error) => error.code === 'JOURNAL_RECOVERY_REQUIRED',
  );
  unchanged(f);
  assert.deepEqual(fs.readdirSync(f.data), ['journal.json', 'journal.json.previous']);
  const recovery = new StartupRecovery(f.data, catalog);
  assert.match(recovery.status().message, /尚未替换/);
  unchanged(f);
});
test('a missing current file with a damaged previous copy cannot silently start a new journal', async () => {
  const f = fixture(),
    missingData = path.join(f.root, 'missing-current-userdata');
  fs.mkdirSync(missingData);
  fs.writeFileSync(path.join(missingData, 'journal.json.previous'), 'synthetic damaged previous only');
  assert.throws(
    () => new Store(missingData, catalog),
    (error) => error.code === 'JOURNAL_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(path.join(missingData, 'journal.json')), false);
  const recovery = new StartupRecovery(missingData, catalog),
    preview = await recovery.preview('json', f.file);
  await recovery.confirm(preview.token);
  assert.equal(new Store(missingData, catalog).get().profiles[0].notes, '完整笔记不会丢失');
});
test('valid JSON previews then recovers only local notes with verified copies of both damaged originals', async () => {
  const f = fixture(),
    recovery = new StartupRecovery(f.data, catalog);
  const preview = await recovery.preview('json', f.file);
  assert.equal(preview.profiles[0].name, '恢复验收周目');
  unchanged(f);
  const result = await recovery.confirm(preview.token);
  for (const [name, bytes] of f.before)
    assert.deepEqual(fs.readFileSync(path.join(result.retainedDirectory, name)), bytes);
  const restored = new Store(f.data, catalog).get();
  assert.equal(restored.profiles[0].notes, '完整笔记不会丢失');
  assert.equal(restored.profiles[0].goals[0].title, '找线索');
  assert.equal(restored.settings.savePath, '');
  assert.equal(restored.settings.steamPath, '');
  assert.equal(restored.settings.autoBackup, false);
  assert.equal(restored.settings.offerAutoSaveOnStart, false);
  assert.equal(restored.profiles[0].referenceMode, 'none');
  assert.equal(restored.profiles[0].saveSlot, '');
  assert.equal(restored.token, undefined);
  const gate = isolation(f.data);
  assert.equal(gate.disableAutoDiscovery, true);
  assert.notEqual(gate.timelineDirectory, 'game-timeline');
  assert.notEqual(gate.bridgeDirectory, 'game-bridge');
  assert.equal(new Store(f.data, catalog).get().profiles[0].notes, '完整笔记不会丢失');
  assert.deepEqual(isolation(f.data), gate);
  await assert.rejects(recovery.confirm(preview.token), /失效/);
});
test('wrong JSON, semantically invalid journal and invalid package are refused without default data', async () => {
  const f = fixture(),
    recovery = new StartupRecovery(f.data, catalog);
  for (const value of [
    '{',
    JSON.stringify({ schema: 1 }),
    JSON.stringify({ ...f.incoming, activeProfileId: 'foreign' }),
  ]) {
    fs.writeFileSync(f.file, value);
    await assert.rejects(recovery.preview('json', f.file));
    unchanged(f);
  }
  await assert.rejects(recovery.preview('protection', f.file));
  assert.equal(recovery.pending, null);
  assert.equal(fs.existsSync(path.join(f.data, MARKER)), false);
});
test('source changed after preview or local originals changed block replacement', async () => {
  const f = fixture(),
    recovery = new StartupRecovery(f.data, catalog);
  const preview = await recovery.preview('json', f.file);
  f.incoming.profiles[0].notes = 'changed export';
  fs.writeFileSync(f.file, JSON.stringify(f.incoming));
  await assert.rejects(recovery.confirm(preview.token), /预览后发生变化/);
  unchanged(f);
  const fresh = await recovery.preview('json', f.file);
  fs.writeFileSync(path.join(f.data, 'journal.json'), 'new local bytes');
  await assert.rejects(recovery.confirm(fresh.token), /本机原件/);
  assert.equal(fs.readFileSync(path.join(f.data, 'journal.json'), 'utf8'), 'new local bytes');
});
test('protection-copy failure and atomic persistence failure preserve both originals and allow retry', async () => {
  for (const phase of ['receipt', 'marker', 'journal']) {
    const f = fixture();
    let fail = true;
    const recovery = new StartupRecovery(f.data, catalog, {
      write: (file, value, preserve) => {
        if (
          fail &&
          ((phase === 'receipt' && path.basename(file) === 'receipt.json') ||
            (phase === 'marker' && path.basename(file) === MARKER) ||
            (phase === 'journal' && file === path.join(f.data, 'journal.json')))
        ) {
          fail = false;
          throw Object.assign(Error('synthetic disk failure'), { code: 'ENOSPC' });
        }
        atomicWrite(file, value, preserve);
      },
    });
    const preview = await recovery.preview('json', f.file);
    await assert.rejects(recovery.confirm(preview.token), /synthetic disk/);
    unchanged(f);
    const restored = await recovery.confirm(preview.token);
    assert.ok(fs.existsSync(path.join(restored.retainedDirectory, 'journal.json.previous')));
    assert.equal(new Store(f.data, catalog).get().profiles[0].notes, '完整笔记不会丢失');
  }
});
test('actual copy failure and journal rename failure leave both damaged bytes exact, then retry succeeds', async () => {
  for (const phase of ['copy', 'rename']) {
    const f = fixture(),
      recovery = new StartupRecovery(f.data, catalog),
      preview = await recovery.preview('json', f.file);
    const original = phase === 'copy' ? fs.copyFileSync : fs.renameSync;
    if (phase === 'copy')
      fs.copyFileSync = (...args) => {
        if (args[0] === path.join(f.data, 'journal.json'))
          throw Object.assign(Error('injected protection copy failure'), { code: 'ENOSPC' });
        return original(...args);
      };
    else
      fs.renameSync = (...args) => {
        if (args[1] === path.join(f.data, 'journal.json'))
          throw Object.assign(Error('injected journal rename failure'), { code: 'ENOSPC' });
        return original(...args);
      };
    try {
      await assert.rejects(recovery.confirm(preview.token), /injected/);
    } finally {
      if (phase === 'copy') fs.copyFileSync = original;
      else fs.renameSync = original;
    }
    unchanged(f);
    await recovery.confirm(preview.token);
    assert.equal(new Store(f.data, catalog).get().profiles[0].notes, '完整笔记不会丢失');
  }
});
test('full collection validates all components but restores only its current journal', async () => {
  const f = fixture(),
    current = await protection(f),
    recovery = new StartupRecovery(f.data, catalog);
  f.incoming.profiles[0].notes = 'historical other notes';
  const history = await protection(f, 'history'),
    bundled = path.join(f.root, 'complete.yijian-protection');
  await collection.exportCollection({
    components: [
      { kind: 'current', file: current },
      { kind: 'history', file: history },
    ],
    file: bundled,
  });
  const preview = await recovery.preview('protection', bundled);
  unchanged(f);
  await recovery.confirm(preview.token);
  assert.equal(new Store(f.data, catalog).get().profiles[0].notes, '完整笔记不会丢失');
  assert.equal(fs.existsSync(path.join(f.data, 'protection-history')), false);
});
test('complete volume directory is verified, missing or changed parts rejected', async () => {
  const f = fixture(),
    source = await protection(f),
    directory = path.join(f.root, 'volumes');
  fs.mkdirSync(directory);
  const bytes = fs.readFileSync(source),
    name = 'part-0001.yijian-protection';
  fs.writeFileSync(path.join(directory, name), bytes);
  fs.writeFileSync(
    path.join(directory, 'transfer.json'),
    JSON.stringify({
      schema: 1,
      kind: 'yijian-protection-volumes',
      createdAt: new Date().toISOString(),
      parts: [{ name, bytes: bytes.length, sha256: sha(bytes) }],
    }),
  );
  const recovery = new StartupRecovery(f.data, catalog),
    preview = await recovery.preview('volumes', directory);
  fs.writeFileSync(path.join(directory, name), Buffer.from('bad part'));
  await assert.rejects(recovery.confirm(preview.token), /分卷/);
  unchanged(f);
  fs.writeFileSync(path.join(directory, name), bytes);
  const fresh = await recovery.preview('volumes', directory);
  await recovery.confirm(fresh.token);
  assert.equal(new Store(f.data, catalog).get().profiles[0].notes, '完整笔记不会丢失');
});
test('linked source, linked previous and linked ancestor never write an external target', async (t) => {
  const f = fixture(),
    external = path.join(f.root, 'external.json');
  fs.writeFileSync(external, 'unrelated synthetic bytes');
  const linked = path.join(f.root, 'linked.json');
  try {
    fs.symlinkSync(external, linked);
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Account cannot create symlinks');
      return;
    }
    throw error;
  }
  const recovery = new StartupRecovery(f.data, catalog);
  await assert.rejects(recovery.preview('json', linked), /链接/);
  fs.symlinkSync(f.data, path.join(f.root, 'linked-data'), 'dir');
  assert.throws(() => new Store(path.join(f.root, 'linked-data'), catalog), /链接/);
  assert.throws(() => new StartupRecovery(path.join(f.root, 'linked-data'), catalog), /链接/);
  const linkedPreviousData = path.join(f.root, 'linked-previous-userdata');
  fs.mkdirSync(linkedPreviousData);
  fs.writeFileSync(path.join(linkedPreviousData, 'journal.json'), 'synthetic broken current');
  fs.symlinkSync(external, path.join(linkedPreviousData, 'journal.json.previous'));
  assert.throws(() => new Store(linkedPreviousData, catalog), /链接/);
  assert.throws(() => new StartupRecovery(linkedPreviousData, catalog), /链接/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'unrelated synthetic bytes');
  unchanged(f);
});
test('recovery preload exposes no ordinary business or path-bearing IPC', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/startup-recovery-preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /bootstrap|mutate|launchGame|timeline|openFolder/);
  const host = fs.readFileSync(path.join(__dirname, '../src/startup-recovery-window.cjs'), 'utf8');
  assert.match(host, /nodeIntegration: false/);
  assert.match(host, /contextIsolation: true/);
  assert.match(host, /sandbox: true/);
  assert.match(host, /event.sender !== win.webContents/);
  assert.match(host, /event.senderFrame !== event.sender.mainFrame/);
  assert.match(recoveryError(Error('Unsupported protection package')), /未通过完整校验/);
  assert.match(recoveryError(Object.assign(Error('disk'), { code: 'ENOSPC' })), /磁盘空间/);
});
test('persisted recovery gate prevents automatic save discovery before and after a journal restart', async () => {
  const vm = require('node:vm'),
    f = fixture(),
    recovery = new StartupRecovery(f.data, catalog);
  const preview = await recovery.preview('json', f.file);
  await recovery.confirm(preview.token);
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const start = main.indexOf('function connectDetectedSaves() {'),
    end = main.indexOf('\nfunction refreshGameEnvironment()', start);
  assert.ok(start >= 0 && end > start);
  const code = main.slice(start, end) + '\nconnectDetectedSaves();';
  for (let attempt = 0; attempt < 2; attempt++) {
    let discovers = 0,
      configures = 0;
    const context = {
      recoveredIsolation: isolation(f.data),
      quitRequested: false,
      saves: { busy: false, pendingRestore: () => null },
      bridge: null,
      store: new Store(f.data, catalog),
      timeline: { data: { pending: null }, configure: () => configures++ },
      detected: () => {
        discovers++;
        return [];
      },
      selectSaveFolder: () => 'must-not-connect',
    };
    vm.runInNewContext(code, context);
    assert.equal(discovers, 0);
    assert.equal(configures, 0);
    assert.equal(context.store.get().settings.savePath, '');
  }
});
function newJournalFixture() {
  const parent =
    process.env.YIJIAN_STARTUP_RECOVERY_TMPDIR ||
    path.join(__dirname, '..', '.test-data', 'startup-recovery-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'synthetic-no-export-')),
    data = path.join(root, 'userdata');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'journal.json'), 'no-export synthetic broken current');
  fs.writeFileSync(path.join(data, 'journal.json.previous'), 'no-export synthetic broken previous');
  const untouched = [
    ['save-backups', 'retained-backup.bin'],
    ['game-timeline', 'retained-history.bin'],
  ].map((parts) => {
    const file = path.join(data, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'invented original local data: ' + parts.join('/'));
    return [file, fs.readFileSync(file)];
  });
  return { root, data, untouched, before: originalBytes(data) };
}
test('new-journal preparation is only an empty preview, can be canceled and does not require an export', async () => {
  const f = newJournalFixture(),
    recovery = new StartupRecovery(f.data, catalog);
  const beforeNames = fs.readdirSync(f.data),
    preview = await recovery.prepareNew();
  assert.equal(preview.intent, 'new');
  assert.equal(preview.profiles.length, 1);
  assert.equal(preview.profiles[0].goals, 0);
  assert.equal(preview.profiles[0].entries, 0);
  assert.equal(preview.profiles[0].drafts, 0);
  unchanged(f);
  assert.deepEqual(fs.readdirSync(f.data), beforeNames);
  assert.throws(
    () => new Store(f.data, catalog),
    (error) => error.code === 'JOURNAL_RECOVERY_REQUIRED',
  );
  await assert.rejects(recovery.confirm('not-the-preview-token'), /失效/);
  unchanged(f);
});
test('explicit new-journal confirmation preserves all originals, creates offline state and rejects duplicate/stale tokens', async () => {
  const f = newJournalFixture(),
    recovery = new StartupRecovery(f.data, catalog);
  const stale = await recovery.prepareNew(),
    preview = await recovery.prepareNew();
  await assert.rejects(recovery.confirm(stale.token), /失效/);
  const responses = await Promise.allSettled([
    recovery.confirm(preview.token),
    recovery.confirm(preview.token),
  ]);
  assert.equal(responses.filter((response) => response.status === 'fulfilled').length, 1);
  const result = responses.find((response) => response.status === 'fulfilled').value;
  assert.equal(result.mode, 'new');
  for (const [name, bytes] of f.before)
    assert.deepEqual(fs.readFileSync(path.join(result.retainedDirectory, name)), bytes);
  for (const [file, bytes] of f.untouched) assert.deepEqual(fs.readFileSync(file), bytes);
  const state = new Store(f.data, catalog).get();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].notes, '');
  assert.deepEqual(state.profiles[0].goals, []);
  assert.equal(state.profiles[0].referenceMode, 'none');
  assert.equal(state.settings.savePath, '');
  assert.equal(state.settings.steamPath, '');
  assert.equal(state.settings.autoBackup, false);
  assert.equal(state.settings.offerAutoSaveOnStart, false);
  const gate = isolation(f.data);
  assert.equal(gate.disableAutoDiscovery, true);
  assert.deepEqual(new Store(f.data, catalog).get(), state);
  assert.deepEqual(isolation(f.data), gate);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.retainedDirectory, 'receipt.json'))).mode, 'new');
});
test('new-journal confirmation blocks a changed original before protection or replacement', async () => {
  const f = newJournalFixture(),
    recovery = new StartupRecovery(f.data, catalog),
    preview = await recovery.prepareNew();
  fs.writeFileSync(path.join(f.data, 'journal.json.previous'), 'external synthetic change');
  await assert.rejects(recovery.confirm(preview.token), /本机原件/);
  assert.equal(fs.readFileSync(path.join(f.data, 'journal.json'), 'utf8'), f.before[0][1].toString());
  assert.equal(
    fs.readFileSync(path.join(f.data, 'journal.json.previous'), 'utf8'),
    'external synthetic change',
  );
  assert.equal(fs.existsSync(path.join(f.data, MARKER)), false);
  assert.equal(fs.readdirSync(f.data).filter((name) => name.startsWith('journal-recovery-')).length, 0);
});
test('new-journal copy, marker write and actual atomic rename failures preserve broken bytes and remain retryable', async () => {
  for (const phase of ['copy', 'marker', 'rename']) {
    const f = newJournalFixture();
    let fail = phase === 'marker';
    const recovery = new StartupRecovery(f.data, catalog, {
        write: (file, value, preserve) => {
          if (fail && path.basename(file) === MARKER) {
            fail = false;
            throw Object.assign(Error('injected marker failure'), { code: 'ENOSPC' });
          }
          atomicWrite(file, value, preserve);
        },
      }),
      preview = await recovery.prepareNew();
    const method = phase === 'copy' ? 'copyFileSync' : 'renameSync',
      original = fs[method];
    if (phase !== 'marker')
      fs[method] = (...args) => {
        if (args[phase === 'copy' ? 0 : 1] === path.join(f.data, 'journal.json'))
          throw Object.assign(Error('injected ' + phase + ' failure'), { code: 'ENOSPC' });
        return original(...args);
      };
    try {
      await assert.rejects(recovery.confirm(preview.token), /injected/);
    } finally {
      fs[method] = original;
    }
    unchanged(f);
    for (const [file, bytes] of f.untouched) assert.deepEqual(fs.readFileSync(file), bytes);
    await recovery.confirm(preview.token);
    assert.equal(new Store(f.data, catalog).get().settings.savePath, '');
  }
});
