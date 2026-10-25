'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const body = source.slice(
  source.indexOf("    handle('window', async"),
  source.indexOf('    windowMonitor = new GameWindow('),
);
function setup({
  ready = true,
  fromCompanion = true,
  collapse,
  created = false,
  timeout = 30000,
  actual = false,
} = {}) {
  const calls = [],
    small = {},
    main = Object.assign(new EventEmitter(), {
      visible: false,
      minimized: true,
      webContents: Object.assign(new EventEmitter(), {
        id: 7,
        send: (channel, message) => calls.push(['send', channel, message]),
      }),
      isVisible() {
        return this.visible;
      },
      isDestroyed() {
        return !!this.destroyed;
      },
      destroy() {
        this.destroyed = true;
        this.emit('closed');
      },
      show() {
        this.visible = true;
        this.minimized = false;
      },
      focus() {},
    });
  let handler;
  const context = {
    handle: (name, fn) => {
      assert.equal(name, 'window');
      handler = fn;
    },
    owner: () => (fromCompanion ? small : main),
    handbookContext: (value) => value,
    store: { get: () => ({ activeProfileId: 'current' }) },
    showMain: () => {
      calls.push(['show']);
      main.visible = !created;
      main.minimized = created;
      return main;
    },
    companion: {
      window: small,
      collapse: async (restore) => {
        calls.push(['collapse', restore]);
        assert.equal(main.visible, true);
        assert.equal(main.minimized, false);
        if (collapse) await collapse();
      },
    },
    rendererReady: new Set(ready ? [7] : []),
    pendingActions: new Map(),
    nativePaintReady: new WeakSet(created ? [] : [main]),
    mainPaintWaiters: new WeakMap(),
    mainWindow: null,
    makeWindow: () => main,
    setTimeout: (fn) => setTimeout(fn, timeout),
    clearTimeout,
  };
  const showSource = source.slice(
    source.indexOf('function showMain()'),
    source.indexOf('function detected()'),
  );
  vm.runInNewContext((actual ? showSource : '') + '\n' + body, context);
  return { calls, context, main, run: (reading) => handler({}, 'main', reading) };
}
test('handbook handoff restores the destination before hiding its click source and preserves the reading context', async () => {
  const s = setup(),
    reading = { profileId: 'current', route: 'database', query: '程钰' };
  await s.run(reading);
  assert.deepEqual(s.calls.slice(0, 2), [['show'], ['collapse', false]]);
  assert.equal(s.calls[2][1], 'journal:action');
  assert.equal(s.calls[2][2].context, reading);
});
test('a not-yet-ready destination retains the exact context while source collapse finishes', async () => {
  let finish;
  const wait = new Promise((r) => {
    finish = r;
  });
  const s = setup({ ready: false, collapse: () => wait });
  const reading = { profileId: 'current', route: 'world', detail: { id: 'place-411' } };
  const pending = s.run(reading);
  await Promise.resolve();
  assert.deepEqual(s.calls, [['show'], ['collapse', false]]);
  assert.equal(s.context.pendingActions.size, 0);
  finish();
  await pending;
  assert.equal(s.context.pendingActions.get(7).context, reading);
});
test('a changed profile refuses the handoff before either window changes', async () => {
  const s = setup();
  await assert.rejects(s.run({ profileId: 'other' }), /周目已变化/);
  assert.deepEqual(s.calls, []);
});
test('main-window and context-free requests keep their existing behavior', async () => {
  const main = setup({ fromCompanion: false });
  await main.run();
  assert.deepEqual(main.calls, [['show']]);
  const small = setup();
  await small.run();
  assert.deepEqual(small.calls, [['show'], ['collapse', false]]);
});

test('recreated main waits for its first visible frame before hiding the companion', async () => {
  const s = setup({ ready: false, created: true });
  const reading = { profileId: 'current', route: 'world' };
  const pending = s.run(reading);
  await Promise.resolve();
  assert.deepEqual(s.calls, [['show']]);
  s.main.emit('ready-to-show');
  await pending;
  assert.equal(s.main.visible, true);
  assert.deepEqual(s.calls, [['show'], ['collapse', false]]);
  assert.equal(s.context.pendingActions.get(7).context, reading);
  assert.equal(s.main.listenerCount('closed'), 0);
  assert.equal(s.main.webContents.listenerCount('did-fail-load'), 0);
});

test('a failed or closed recreated main leaves its companion visible and removes readiness listeners', async () => {
  for (const event of ['closed', 'did-fail-load']) {
    const s = setup({ ready: false, created: true });
    const pending = s.run();
    if (event === 'closed') s.main.emit(event);
    else s.main.webContents.emit(event);
    await assert.rejects(pending, /主窗口/);
    assert.deepEqual(s.calls, [['show']]);
    assert.equal(s.main.listenerCount('ready-to-show'), 0);
    assert.equal(s.context.pendingActions.size, 0);
  }
});

test('a recreated main that never paints times out without hiding the companion', async () => {
  const s = setup({ ready: false, created: true, timeout: 2 });
  await assert.rejects(s.run(), /打开超时/);
  assert.deepEqual(s.calls, [['show']]);
  assert.equal(s.main.listenerCount('ready-to-show'), 0);
});

test('failed or timed-out first load is discarded and retry waits for a genuinely new main', async () => {
  const showSource = source.slice(
    source.indexOf('function showMain()'),
    source.indexOf('function detected()'),
  );
  for (const failure of ['load', 'timeout']) {
    let handler;
    const windows = [],
      calls = [],
      small = {};
    const context = {
      mainWindow: null,
      makeWindow: () => {
        const w = Object.assign(new EventEmitter(), {
          visible: false,
          destroyed: false,
          isDestroyed() {
            return this.destroyed;
          },
          isVisible() {
            return this.visible;
          },
          isMinimized() {
            return false;
          },
          show() {
            this.visible = true;
          },
          restore() {},
          focus() {},
          destroy() {
            this.destroyed = true;
            this.emit('closed');
          },
          webContents: Object.assign(new EventEmitter(), { id: windows.length + 1, send() {} }),
        });
        windows.push(w);
        return w;
      },
      handle: (_name, fn) => {
        handler = fn;
      },
      owner: () => small,
      handbookContext: (value) => value,
      store: { get: () => ({ activeProfileId: 'current' }) },
      companion: {
        window: small,
        collapse: async () => {
          assert(context.mainWindow.visible);
          calls.push('collapse');
        },
      },
      rendererReady: new Set(),
      pendingActions: new Map(),
      nativePaintReady: new WeakSet(),
      mainPaintWaiters: new WeakMap(),
      setTimeout: (fn) => setTimeout(fn, 5),
      clearTimeout,
    };
    vm.runInNewContext(showSource + '\n' + body, context);
    const first = handler({}, 'main');
    if (failure === 'load') windows[0].webContents.emit('did-fail-load');
    await assert.rejects(first, /主窗口/);
    assert.equal(windows[0].destroyed, true);
    assert.equal(context.mainWindow, null);
    assert.deepEqual(calls, []);
    const retry = handler({}, 'main');
    assert.equal(windows.length, 2);
    assert.deepEqual(calls, []);
    windows[1].emit('ready-to-show');
    await retry;
    assert.deepEqual(calls, ['collapse']);
    assert.equal(context.mainWindow, windows[1]);
  }
});

test('two entry points share native readiness and neither hides its source before a first paint', async () => {
  const s = setup({ actual: true, created: true, ready: false });
  const a = s.run({ profileId: 'current', route: 'database' });
  const b = s.run({ profileId: 'current', route: 'world' });
  assert.equal(s.main.visible, false);
  assert(!s.calls.some((row) => row[0] === 'collapse'));
  assert.equal(s.main.listenerCount('ready-to-show'), 1);
  s.main.emit('ready-to-show');
  await Promise.all([a, b]);
  assert.equal(s.main.visible, true);
  assert.equal(s.context.pendingActions.get(7).context.route, 'world');
});

test('concurrent first-load failure preserves both callers sources and discards the failed target once', async () => {
  const s = setup({ actual: true, created: true, ready: false });
  const a = s.run();
  const b = s.run();
  assert.equal(s.main.visible, false);
  s.main.webContents.emit('did-fail-load');
  const result = await Promise.allSettled([a, b]);
  assert(result.every((row) => row.status === 'rejected'));
  assert(!s.calls.some((row) => row[0] === 'collapse'));
  assert.equal(s.main.destroyed, true);
  assert.equal(s.context.mainWindow, null);
  assert.equal(s.context.mainPaintWaiters.has(s.main), false);
});

test('a profile change during first paint cannot hand off an earlier profile context', async () => {
  const s = setup({ created: true, ready: false });
  const pending = s.run({ profileId: 'current', route: 'world' });
  s.context.store.get = () => ({ activeProfileId: 'changed' });
  s.main.emit('ready-to-show');
  await assert.rejects(pending, /周目已变化/);
  assert(!s.calls.some((row) => row[0] === 'collapse'));
  assert.equal(s.context.pendingActions.size, 0);
});
