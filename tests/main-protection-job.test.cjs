'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
function section(start, end) {
  const a = main.indexOf(start),
    b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return main.slice(a, b);
}
function setup(flags = {}) {
  const messages = [],
    commands = [];
  const context = {
    protectionJobPromise: null,
    quitRequested: false,
    isTest: false,
    bridge: {
      ...flags,
      save: async () => {
        commands.push('save');
        return { map: 'synthetic-map' };
      },
    },
    broadcast: (...args) => messages.push(args),
    resultFeedback: (...args) => messages.push(args),
    clearOperationFault: () => {},
    enrich: () => ({ mapName: '合成地点' }),
    updateTray: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    section('async function protectionJob(', '\nlet gameCheckedAt') +
      '\n' +
      section('async function quickSave()', '\nfunction updateTray(') +
      '\nthis.job = protectionJob; this.quick = quickSave;',
    context,
  );
  return { context, messages, commands };
}
test('a protection job never starts while a native command is running or queued', async () => {
  for (const flag of ['busy', 'loadQueued', 'quiescing']) {
    const s = setup({ [flag]: true });
    let work = false;
    await assert.rejects(
      s.context.job('合成保护任务', () => {
        work = true;
      }),
      /存读档操作正在进行/,
    );
    assert.equal(work, false);
    assert.equal(s.context.protectionJobPromise, null);
  }
});
test('tray and shortcut save requests wait for protection work without sending a native command', async () => {
  const s = setup();
  let release;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const work = s.context.job('合成保护任务', () => pause);
  await s.context.quick();
  assert.deepEqual(s.commands, []);
  assert.ok(s.messages.some((row) => row[0] === 'info' && /处理保护资料/.test(row[1])));
  release('verified');
  assert.equal(await work, 'verified');
  assert.equal(s.context.protectionJobPromise, null);
  await s.context.quick();
  assert.deepEqual(s.commands, ['save']);
});
test('a failed protection operation releases the command barrier', async () => {
  const s = setup();
  await assert.rejects(
    s.context.job('合成失败', () => {
      throw Error('fixture fault');
    }),
    /fixture fault/,
  );
  assert.equal(s.context.protectionJobPromise, null);
  await s.context.quick();
  assert.deepEqual(s.commands, ['save']);
});

function restoreSetup({ answer = 1, failPrepare = false, failRestore = false, local = false } = {}) {
  const { Activity } = require('../src/core/activity.cjs');
  const parent = path.join(__dirname, '..', '.test-data', 'restore-receipt');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'synthetic-'));
  const activity = new Activity(directory),
    calls = [],
    events = [];
  let handler;
  const context = {
    activity,
    isTest: true,
    broadcast: (...args) => events.push(args),
    updateTray: () => {},
    protectionJob: async (_label, work) => work(),
    owner: () => null,
    checkedBackup: (_id, verify) => verify(),
    bridge: { busy: false, canStop: () => true },
    timeline: { data: {} },
    realDirectory: (value) => value,
    store: { get: () => ({ settings: { savePath: 'synthetic-target-SaveGames' } }) },
    protectionArchives: {
      history: async () => ({
        backups: [
          {
            id: 'history-backup',
            label: '出发前保护点',
            files: [{ name: '1.sav' }, { name: 'JHSaveConfig.sav' }],
          },
        ],
      }),
      prepareRecovery: async () => {
        calls.push('prepare');
        if (failPrepare) throw Error('synthetic verification failure');
        return { id: 'bound-history' };
      },
    },
    saves: {
      verify: () => {
        calls.push('verify');
        if (failPrepare) throw Error('synthetic verification failure');
        return {
          manifest: { label: '本机出发前保护点', files: [{ name: '1.sav' }, { name: 'JHSaveConfig.sav' }] },
        };
      },
      pendingRestore: () => null,
      restore: () => {
        calls.push('restore');
        if (failRestore) throw Error('synthetic restore failure');
        return { restored: 2, safetyId: 'verified-safety-copy' };
      },
    },
    dialog: { showMessageBox: async () => ({ response: answer }) },
    overview: () => ({}),
    handle: (name, callback) => {
      assert.equal(name, local ? 'restore' : 'protection-restore');
      handler = callback;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    section('function resultFeedback(', '\nfunction bridgeEvent(') +
      '\n' +
      (local
        ? section("    handle('restore',", "    handle('choose-saves',")
        : section("    handle('protection-restore',", "    handle('export',")),
    context,
  );
  return { handler, activity, directory, calls, events, context };
}

test('history restore leaves a persistent receipt identifying target and verified protection copy', async () => {
  const { Activity } = require('../src/core/activity.cjs');
  const s = restoreSetup();
  const result = await s.handler({}, 'archive', 'history-backup');
  assert.equal(result.restored, 2);
  assert.deepEqual(s.calls, ['prepare', 'restore']);
  const receipt = new Activity(s.directory).get().events[0];
  assert.equal(receipt.level, 'success');
  for (const value of ['出发前保护点', '2', 'synthetic-target-SaveGames', 'verified-safety-copy'])
    assert(receipt.message.includes(value));
  assert(
    s.events.some(
      ([channel, event]) =>
        channel === 'event' && event.type === 'operation' && event.result.message === receipt.message,
    ),
  );
});

test('history restore cancellation and failed verification or restore never leave a success receipt', async () => {
  for (const flags of [{ answer: 0 }, { failPrepare: true }, { failRestore: true }]) {
    const s = restoreSetup(flags);
    if (flags.answer === 0) {
      assert.equal((await s.handler({}, 'archive', 'history-backup')).cancelled, true);
      assert.deepEqual(s.calls, []);
    } else await assert.rejects(s.handler({}, 'archive', 'history-backup'), /synthetic/);
    assert.deepEqual(s.activity.get().events, []);
    assert(!s.events.some(([, event]) => event.type === 'operation'));
  }
});

test('history restore remains successful when its receipt cannot be written, with the existing warning', async () => {
  const s = restoreSetup();
  s.activity.record = () => {
    throw Error('synthetic disk fault');
  };
  assert.equal((await s.handler({}, 'archive', 'history-backup')).restored, 2);
  assert.match(s.activity.warning, /操作结果未能写入本机/);
  assert(
    s.events.some(([, event]) => event.type === 'operation' && /记录未能写入/.test(event.result.message)),
  );
});

test('local complete restore records the actual target and protection copy after success and survives cold reopening', async () => {
  const { Activity } = require('../src/core/activity.cjs');
  const s = restoreSetup({ local: true });
  assert.equal((await s.handler({}, 'local-backup')).restored, 2);
  assert.deepEqual(s.calls, ['verify', 'restore']);
  const receipt = new Activity(s.directory).get().events[0];
  assert.equal(receipt.level, 'success');
  for (const text of ['本机出发前保护点', '2', 'synthetic-target-SaveGames', 'verified-safety-copy'])
    assert(receipt.message.includes(text));
  assert(
    s.events.some(([, event]) => event.type === 'operation' && event.result.message === receipt.message),
  );
});

test('local complete restore cancellation and verification or restore failure never record a successful operation', async () => {
  for (const flags of [{ answer: 0 }, { failPrepare: true }, { failRestore: true }]) {
    const s = restoreSetup({ ...flags, local: true });
    if (flags.answer === 0) {
      assert.equal((await s.handler({}, 'local-backup')).cancelled, true);
      assert.deepEqual(s.calls, ['verify']);
    } else await assert.rejects(s.handler({}, 'local-backup'), /synthetic/);
    assert.deepEqual(s.activity.get().events, []);
    assert(!s.events.some(([, event]) => event.type === 'operation'));
  }
});

test('a completed local restore remains successful if saving its receipt fails, with the existing recording warning', async () => {
  const s = restoreSetup({ local: true });
  s.activity.record = () => {
    throw Error('synthetic activity write fault');
  };
  assert.equal((await s.handler({}, 'local-backup')).restored, 2);
  assert.match(s.activity.warning, /操作结果未能写入本机/);
  assert(
    s.events.some(([, event]) => event.type === 'operation' && /记录未能写入/.test(event.result.message)),
  );
});

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function rendererSection(start, end) {
  const a = renderer.indexOf(start),
    b = renderer.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return renderer.slice(a, b);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function backupPreviewSetup() {
  const noop = () => {},
    body = { scrollTop: 0 },
    focusable = { focus: noop };
  let markup = '';
  const overlay = {
    firstChild: null,
    contains: () => false,
    querySelector: (selector) =>
      selector === '.drawer-body' ? body : selector === 'input,textarea,select,button' ? focusable : null,
    querySelectorAll: () => [],
    get innerHTML() {
      return markup;
    },
    set innerHTML(value) {
      markup = value;
      this.firstChild = value ? {} : null;
    },
  };
  const context = {
    overlay,
    root: { inert: false, querySelector: () => null },
    document: { activeElement: null, querySelector: () => null },
    window: { journal: { timelineRelease: async () => {} } },
    CSS: { escape: (value) => value },
    currentDrawer: null,
    drawerHistory: [],
    backupPreviewRequest: 0,
    backupRestorePending: false,
    route: 'saves',
    state: { activeProfileId: 'synthetic-profile', settings: { savePath: 'synthetic-SaveGames' } },
    environment: { backups: [] },
    resourcePriorityDraft: null,
    resourcePriorityRequest: 0,
    activeIntentEditor: null,
    detailRequest: 0,
    protectionRequest: 0,
    lastFocus: null,
    captureNodeDraft: noop,
    captureJournalDraft: noop,
    captureIntentDrafts: noop,
    render: noop,
    saveNote: async () => {},
    toast: noop,
    esc: (value) => String(value),
    when: (value) => String(value),
    bytes: (value) => String(value),
    hours: (value) => String(value),
    pill: (value, color) => `<span class="${color || ''}">${value}</span>`,
    notice: (value) => `<p>${value}</p>`,
    act: (action, label, _class, id) =>
      `<button data-action="${action}" data-id="${id || ''}">${label}</button>`,
    iconButton: () => '<button data-action="close-overlay">关闭</button>',
  };
  vm.createContext(context);
  vm.runInContext(
    rendererSection('function rememberDrawer(', '\nconst paths =') +
      rendererSection('function backupPreviewScope()', '\nasync function call(') +
      rendererSection('function showOverlay(', '\nfunction dismissOverlay()') +
      rendererSection('function closeOverlay()', '\nfunction showDetail(') +
      '\nasync function handle(action, id, target, navigationFocused = false) { switch (action) {\n' +
      rendererSection("    case 'backup-preview':", "    case 'backup-folder':") +
      rendererSection("    case 'restore': {", "    case 'recover-restore': {") +
      rendererSection("    case 'drawer-back': {", "    case 'navigate': {") +
      rendererSection("    case 'navigate': {", "    case 'journey-refresh':") +
      rendererSection("    case 'reconnect-detected': {", "    case 'refresh':") +
      '} }',
    context,
  );
  const inspected = (id = 'synthetic-backup', label = '本次新校验') => ({
    id,
    label,
    source: 'synthetic-SaveGames',
    createdAt: '2026-10-10',
    files: [{ name: '1.sav', bytes: 1, modifiedAt: '2026-10-10', status: 'unchanged' }],
    comparison: { sameSource: true, available: true, unchanged: 1, changed: 0, missing: 0, extra: 1 },
  });
  const invalid = () => {
    assert.equal(context.currentDrawer.status, 'invalid');
    assert.doesNotMatch(markup, /校验已通过|完全一致|data-action="restore"/);
    assert.match(markup, /重新校验并预览/);
  };
  return { context, inspected, invalid, markup: () => markup };
}

test('backup restore synchronously revokes its snapshot, rejects duplicate requests, and requires a fresh inspect after every failure or cancellation', async () => {
  const { context: u, inspected, invalid, markup } = backupPreviewSetup();
  u.call = async () => inspected();
  await u.handle('backup-preview', 'synthetic-backup');
  assert.match(markup(), /校验已通过|完全一致/);
  const pending = deferred();
  let requests = 0;
  u.call = (method) => {
    assert.equal(method, 'restore');
    requests++;
    return pending.promise;
  };
  const work = u.handle('restore', 'synthetic-backup');
  assert.equal(u.currentDrawer.status, 'restoring');
  assert.doesNotMatch(markup(), /校验已通过|完全一致|data-action="restore"/);
  await u.handle('restore', 'synthetic-backup');
  assert.equal(requests, 1);
  pending.reject(Error('任意恢复失败；列表没有 verificationError'));
  await work;
  invalid();
  assert.match(markup(), /任意恢复失败/);
  await u.handle('restore', 'synthetic-backup');
  assert.equal(requests, 1);
  u.call = async () => {
    throw Error('仍然损坏');
  };
  await u.handle('backup-preview', 'synthetic-backup');
  invalid();
  assert.match(markup(), /仍然损坏/);
  u.call = async () => inspected();
  await u.handle('backup-preview', 'synthetic-backup');
  assert.match(markup(), /data-action="restore"/);
  u.call = async () => ({ cancelled: true });
  await u.handle('restore', 'synthetic-backup');
  invalid();
  assert.match(markup(), /已取消恢复/);
  assert.equal(u.backupRestorePending, false);
  u.call = async () => inspected();
  await u.handle('backup-preview', 'synthetic-backup');
  u.call = async () => ({ restored: 1, environment: { backups: [] } });
  await u.handle('restore', 'synthetic-backup');
  assert.equal(markup(), '');
  assert.equal(u.root.inert, false);
});

test('deferred backup inspections cannot reopen closed drawers or replace newer overlays, requests, routes or sources', async () => {
  for (const change of ['close', 'search', 'other-backup', 'same-id', 'navigation', 'source']) {
    for (const reject of [false, true]) {
      const { context: u, inspected, markup } = backupPreviewSetup();
      const pending = deferred();
      u.call = () => pending.promise;
      const old = u.handle('backup-preview', 'synthetic-backup');
      if (change === 'close') u.closeOverlay();
      else if (change === 'search') u.showOverlay('<dialog>新的搜索框</dialog>');
      else if (change === 'navigation') await u.handle('navigate', 'home');
      else if (change === 'source') {
        u.call = async () => ({
          state: { ...u.state, settings: { savePath: 'other-synthetic-SaveGames' } },
          environment: { backups: [] },
        });
        await u.handle('reconnect-detected', 'other-synthetic-SaveGames');
      } else {
        u.call = async () =>
          inspected(change === 'same-id' ? 'synthetic-backup' : 'other-backup', '新的预览');
        await u.handle('backup-preview', change === 'same-id' ? 'synthetic-backup' : 'other-backup');
      }
      const expected = markup(),
        owner = u.overlay.firstChild;
      if (reject) pending.reject(Error('旧请求失败'));
      else pending.resolve(inspected('synthetic-backup', '旧请求成功'));
      await old;
      assert.equal(markup(), expected, change);
      assert.equal(u.overlay.firstChild, owner, change);
      if (change === 'close') assert.equal(u.root.inert, false);
    }
  }
});

test('an older same-id inspect success cannot overwrite a newer inspect failure, and drawer-back always inspects again', async () => {
  const { context: u, inspected, invalid, markup } = backupPreviewSetup();
  const first = deferred(),
    second = deferred();
  u.call = () => first.promise;
  const a = u.handle('backup-preview', 'synthetic-backup');
  u.call = () => second.promise;
  const b = u.handle('backup-preview', 'synthetic-backup');
  second.reject(Error('新的校验失败'));
  await b;
  first.resolve(inspected());
  await a;
  invalid();
  assert.match(markup(), /新的校验失败/);
  u.drawerHistory.push({ type: 'backup', data: inspected() });
  u.currentDrawer = { type: 'guide' };
  const back = deferred();
  u.call = () => back.promise;
  const work = u.handle('drawer-back');
  assert.equal(u.currentDrawer.status, 'checking');
  assert.doesNotMatch(markup(), /校验已通过|完全一致|data-action="restore"/);
  back.reject(Error('返回时重新校验失败'));
  await work;
  invalid();
});

test('late restore success, cancellation and failure leave a newer search or reopened same-id drawer intact', async () => {
  for (const result of ['success', 'cancelled', 'failure']) {
    for (const next of ['search', 'same-id']) {
      const { context: u, inspected, markup } = backupPreviewSetup();
      u.call = async () => inspected();
      await u.handle('backup-preview', 'synthetic-backup');
      const pending = deferred();
      u.call = () => pending.promise;
      const work = u.handle('restore', 'synthetic-backup');
      u.closeOverlay();
      if (next === 'search') u.showOverlay('<dialog>恢复期间打开的新搜索</dialog>');
      else {
        u.call = async () => inspected('synthetic-backup', '同 ID 新抽屉');
        await u.handle('backup-preview', 'synthetic-backup');
        assert.doesNotMatch(markup(), /校验已通过|完全一致|data-action="restore"/);
      }
      const expected = markup(),
        owner = u.overlay.firstChild;
      if (result === 'failure') pending.reject(Error('旧恢复失败'));
      else
        pending.resolve(
          result === 'cancelled' ? { cancelled: true } : { restored: 1, environment: { backups: [] } },
        );
      await work;
      assert.equal(markup(), expected, `${result}/${next}`);
      assert.equal(u.overlay.firstChild, owner);
      assert.equal(u.backupRestorePending, false);
    }
  }
});
