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
