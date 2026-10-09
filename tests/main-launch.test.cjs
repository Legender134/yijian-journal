'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const start = main.indexOf('async function launchGame() {');
const end = main.indexOf('\napp.setName(', start);
assert.ok(start > 0 && end > start);
const launch = main.slice(start, end);

function fixture(flags = {}) {
  const calls = [];
  const context = {
    isTest: !!flags.test,
    quitRequested: !!flags.quit,
    protectionJobPromise: flags.protection ? Promise.resolve() : null,
    bridge: {
      busy: !!flags.busy,
      loadQueued: !!flags.loadQueued,
      quiescing: !!flags.quiescing,
      assertLaunchSafe() {
        calls.push('compatibility');
        if (flags.incompatible) throw Error('Synthetic incompatible component');
      },
    },
    saves: { busy: !!flags.restoreBusy, pendingRestore: () => flags.restorePending || null },
    timeline: { data: { enabled: !!flags.enabled, pending: flags.pending || null } },
    shell: {
      async openExternal(url) {
        calls.push(url);
        if (flags.steamFailure) throw Error('Synthetic Steam protocol failure');
      },
    },
    resultFeedback: (level, message) => calls.push({ level, message }),
  };
  vm.createContext(context);
  vm.runInContext(launch + '\nthis.launch = launchGame;', context);
  return { calls, launch: context.launch };
}

test('every launch entry refuses busy, interrupted and exiting protection states before Steam', async () => {
  for (const [flag, message] of [
    ['test', /测试环境/],
    ['quit', /正在退出/],
    ['protection', /正在处理保护资料/],
    ['busy', /等待当前存读档/],
    ['loadQueued', /等待当前存读档/],
    ['quiescing', /等待当前存读档/],
    ['restoreBusy', /等待当前存读档/],
    ['pending', /核对上次中断/],
    ['restorePending', /核对上次中断/],
  ]) {
    const s = fixture({ [flag]: true });
    await assert.rejects(s.launch(), message, flag);
    assert.deepEqual(s.calls, [], flag);
  }
  const incompatible = fixture({ incompatible: true });
  await assert.rejects(incompatible.launch(), /Synthetic incompatible/);
  assert.deepEqual(incompatible.calls, ['compatibility']);
});

test('normal launch needs no save configuration, reports only after Steam accepts and retains mode', async () => {
  for (const enabled of [false, true]) {
    const s = fixture({ enabled });
    assert.equal(await s.launch(), true);
    assert.deepEqual(s.calls.slice(0, 2), ['compatibility', 'steam://rungameid/1876890']);
    assert.equal(s.calls[2].level, 'info');
    assert.match(s.calls[2].message, enabled ? /连接后继续自动保存/ : /查询与存档备份可直接使用/);
  }
  const failed = fixture({ steamFailure: true });
  await assert.rejects(failed.launch(), /Synthetic Steam protocol failure/);
  assert.deepEqual(failed.calls, ['compatibility', 'steam://rungameid/1876890']);
});
