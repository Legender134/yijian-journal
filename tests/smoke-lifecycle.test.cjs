'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../scripts/smoke.cjs'), 'utf8');
const closeSource = source.slice(
  source.indexOf('async function closeApp()'),
  source.indexOf('async function attach()'),
);
function setup({ close, force } = {}) {
  const calls = [],
    application = new EventEmitter();
  application.close =
    close ||
    (async () => {
      calls.push('close');
      application.emit('close');
    });
  application.evaluate = async (fn, expected) => {
    calls.push(['force', expected]);
    return fn(
      {
        app: {
          getPath: () => '/synthetic',
          exit:
            force ||
            (() => {
              application.emit('close');
              calls.push('exit');
            }),
        },
      },
      expected,
    );
  };
  const context = {
    app: application,
    appPid: 42,
    data: '/synthetic',
    path: { resolve: (x) => x },
    process: { kill: (pid, signal) => calls.push(['kill', pid, signal]) },
    Number,
    Promise,
    Error,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 15000 ? 2 : 4),
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(closeSource + '\nthis.closeTest=closeApp;', context);
  return { calls, context, application };
}
test('smoke shutdown preserves the normal acknowledgement path without force', async () => {
  const s = setup();
  await s.context.closeTest();
  assert.deepEqual(s.calls, ['close']);
  assert.equal(s.context.app, null);
});
test('a refused synthetic quit is bounded, force-closes only its fixture and still fails the test', async () => {
  const s = setup({ close: () => new Promise(() => {}) });
  await assert.rejects(s.context.closeTest(), /graceful shutdown/);
  assert.deepEqual(s.calls, [['force', '/synthetic'], 'exit']);
  assert.equal(s.context.app, null);
});
test('a nonresponsive synthetic main process is terminated by its launch identity without reporting success', async () => {
  const s = setup({ close: () => new Promise(() => {}), force: () => new Promise(() => {}) });
  await assert.rejects(s.context.closeTest(), /graceful shutdown/);
  assert(s.calls.some((r) => Array.isArray(r) && r[0] === 'kill' && r[1] === 42 && r[2] === 'SIGKILL'));
});
test('the first smoke failure is printed before teardown can hide it', () => {
  const catchAt = source.lastIndexOf("console.error('Electron smoke failed before cleanup:'");
  assert(catchAt > 0);
  assert(source.indexOf('await closeApp();', catchAt) > catchAt);
});

function handoffSetup({ closed = false, restoreLate = false, delayed = false } = {}) {
  const windows = [];
  let minimized = false;
  const destination = {
    webContents: { getURL: () => 'file:///index.html' },
    minimize: () => {
      minimized = true;
    },
    isVisible: () => !minimized,
    isMinimized: () => minimized,
    isFocused: () => !minimized,
  };
  const companion = new EventEmitter();
  companion.webContents = { getURL: () => 'file:///index.html?compact=1' };
  if (!closed) windows.push(destination);
  windows.push(companion);
  const context = {
    assert,
    nativeHandoffs: [],
    setTimeout,
    clearTimeout,
    app: { evaluate: async (fn) => fn({ BrowserWindow: { getAllWindows: () => windows } }) },
  };
  vm.createContext(context);
  const helper = source.slice(
    source.indexOf('async function handoffToMain('),
    source.indexOf('async function attach()'),
  );
  vm.runInContext(helper + '\nthis.handoffTest=handoffToMain;', context);
  const trigger = {
    click: async () => {
      const handoff = () => {
        if (!restoreLate) {
          if (closed) windows.unshift(destination);
          minimized = false;
        }
        companion.emit('hide');
        if (restoreLate) {
          if (closed) windows.unshift(destination);
          minimized = false;
        }
      };
      if (delayed) setTimeout(handoff, 5);
      else handoff();
    },
  };
  return { context, trigger };
}

test('native handoff regression minimizes an existing main and observes it before hiding the companion', async () => {
  const s = handoffSetup();
  await s.context.handoffTest(s.trigger);
  assert.equal(s.context.nativeHandoffs[0].preparation, 'minimized');
  assert.equal(s.context.nativeHandoffs[0].atSourceHide.visible, true);
});

test('native acceptance waits for asynchronous first-frame handoff after a click returns', async () => {
  const s = handoffSetup({ closed: true, delayed: true });
  await s.context.handoffTest(s.trigger);
  assert.equal(s.context.nativeHandoffs[0].atSourceHide.visible, true);
});

test('native handoff regression lets the real click recreate a closed main before source hide', async () => {
  const s = handoffSetup({ closed: true });
  await s.context.handoffTest(s.trigger);
  assert.equal(s.context.nativeHandoffs[0].preparation, 'closed');
  assert.equal(s.context.nativeHandoffs[0].atSourceHide.visible, true);
});

test('a main restored only after source hide still fails native handoff acceptance', async () => {
  for (const closed of [false, true]) {
    const s = handoffSetup({ closed, restoreLate: true });
    await assert.rejects(s.context.handoffTest(s.trigger), /visible/);
  }
});
