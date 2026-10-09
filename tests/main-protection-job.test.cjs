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
