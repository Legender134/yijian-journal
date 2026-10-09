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
