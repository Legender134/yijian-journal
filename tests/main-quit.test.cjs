'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const code = source.slice(source.indexOf('function requestQuit()'), source.indexOf('\nconst htmlPath'));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(prepare) {
  const calls = [];
  const window = { webContents: { id: 1 }, isDestroyed: () => false };
  const context = {
    quitPromise: null,
    quitRequested: false,
    quitGranted: false,
    protectionJobPromise: null,
    pendingAppUpdate: null,
    launchUpdateInstall: async () => calls.push(['update-launch']),
    BrowserWindow: { getAllWindows: () => [window] },
    rendererReady: new Set([1]),
    quitHandoff: {
      prepare: async (windows) => {
        calls.push(['prepare', windows.length]);
        return prepare();
      },
      cancel: () => calls.push(['cancel']),
    },
    bridge: {
      quiescing: false,
      quiesce: async () => {
        calls.push(['quiesce']);
      },
    },
    app: { quit: () => calls.push(['quit']) },
    broadcast: () => {},
    updateTray: () => {},
    showMain: () => calls.push(['show']),
    health: () => ({}),
  };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.request=requestQuit;', context);
  return { context, calls };
}
test('main waits for existing protection work and every saved-draft reply before draining and quitting', async () => {
  const protection = deferred(),
    renderer = deferred();
  const s = setup(() => renderer.promise);
  s.context.protectionJobPromise = protection.promise;
  const quit = s.context.request();
  await Promise.resolve();
  assert.deepEqual(s.calls, []);
  protection.resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.calls, [['prepare', 1]]);
  assert.equal(s.context.quitRequested, true);
  assert.equal(s.context.request(), quit, 'duplicate requests share the same acknowledgement');
  renderer.resolve(true);
  await quit;
  assert.deepEqual(s.calls, [['prepare', 1], ['quiesce'], ['quit']]);
  assert.equal(s.context.quitGranted, true);
});
test('failed preparation retains the window and releases both latches for a later explicit retry', async () => {
  let ready = false;
  const s = setup(() => ready);
  await s.context.request();
  assert.deepEqual(s.calls, [['prepare', 1], ['cancel'], ['show']]);
  assert.equal(s.context.quitRequested, false);
  assert.equal(s.context.quitGranted, false);
  assert.equal(s.context.quitPromise, null);
  assert.equal(s.context.bridge.quiescing, false);
  ready = true;
  await s.context.request();
  assert.deepEqual(s.calls.slice(-3), [['prepare', 1], ['quiesce'], ['quit']]);
});
test('a renderer error never drains or quits and still permits a later retry', async () => {
  const s = setup(() => {
    throw Error('synthetic reply failure');
  });
  await s.context.request();
  assert.deepEqual(s.calls, [['prepare', 1], ['cancel'], ['show']]);
  assert.equal(s.context.quitPromise, null);
  assert.equal(s.context.quitRequested, false);
});
test('native drain failure revokes the prepared exit instead of leaving quit latched', async () => {
  const s = setup(() => true);
  s.context.bridge.quiesce = async () => {
    throw Error('synthetic drain failure');
  };
  await s.context.request();
  assert.deepEqual(s.calls, [['prepare', 1], ['cancel'], ['show']]);
  assert.equal(s.context.quitGranted, false);
  assert.equal(s.context.quitRequested, false);
  assert.equal(s.context.quitPromise, null);
});

test('an update launches only after saved drafts and native operations are settled', async () => {
  const ready = deferred(),
    s = setup(() => ready.promise);
  s.context.pendingAppUpdate = { plan: 'synthetic' };
  const quit = s.context.request();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.calls, [['prepare', 1]]);
  ready.resolve(true);
  await quit;
  assert.deepEqual(s.calls, [['prepare', 1], ['quiesce'], ['update-launch'], ['quit']]);
  assert.equal(s.context.pendingAppUpdate, null);
});

test('cancelled draft handoff and failed updater launch keep the current app usable', async () => {
  const cancelled = setup(() => false);
  cancelled.context.pendingAppUpdate = { plan: 'synthetic' };
  await cancelled.context.request();
  assert.equal(
    cancelled.calls.some(([action]) => action === 'update-launch'),
    false,
  );
  assert.equal(cancelled.context.pendingAppUpdate, null);
  const failed = setup(() => true);
  failed.context.pendingAppUpdate = { plan: 'synthetic' };
  failed.context.launchUpdateInstall = async () => {
    throw Error('synthetic updater launch failure');
  };
  await failed.context.request();
  assert.equal(failed.context.quitGranted, false);
  assert.equal(failed.context.quitRequested, false);
  assert.equal(failed.context.pendingAppUpdate, null);
  assert.deepEqual(failed.calls, [['prepare', 1], ['quiesce'], ['cancel'], ['show']]);
});
