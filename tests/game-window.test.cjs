'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise process races with inert pipes; never discover or launch a real game.
function setup(t) {
  const children = [],
    timers = [];
  let clock = 1000;
  const source = fs.readFileSync(path.join(__dirname, '../src/core/game-window.cjs'), 'utf8');
  const module = { exports: {} };
  const spawn = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.writes = [];
    child.stdin.write = (text) => child.writes.push(text);
    child.stdin.end = () => {
      child.ended = true;
      child.stdin.writable = false;
    };
    Object.assign(child, { executable, args: [...args], options: JSON.parse(JSON.stringify(options)) });
    children.push(child);
    return child;
  };
  vm.runInNewContext(source, {
    module,
    require: (name) => (name === 'node:child_process' ? { spawn } : require(name)),
    Date: { now: () => clock },
    setInterval: (tick, ms) => {
      const timer = { tick, ms, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      if (timer) timer.active = false;
    },
    setTimeout,
    clearTimeout,
  });
  const monitor = new module.exports.GameWindow('synthetic-helper.exe', 'synthetic-A.exe', 777);
  const changes = [];
  monitor.on('change', (state) => changes.push(state));
  t.after(() => monitor.dispose());
  const emitWindow = (child, hwnd) =>
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'window',
        hwnd,
        available: true,
        gameForeground: false,
        ownForeground: false,
        x: 0,
        y: 0,
        width: 720,
        height: 480,
      }) + '\n',
    );
  return {
    monitor,
    children,
    timers,
    changes,
    emitWindow,
    now: (value) => {
      clock = value;
    },
  };
}

test('target changes preserve the requested monitor lifecycle and use isolated process arguments', (t) => {
  const f = setup(t);
  assert.equal(f.monitor.setTarget('synthetic-B.exe'), true);
  assert.equal(f.children.length, 0, 'Changing configuration must not start an inactive monitor');
  f.monitor.start();
  assert.deepEqual(f.children[0].args, ['synthetic-B.exe', '777']);
  assert.equal(f.children[0].options.windowsHide, true);
  assert.deepEqual(f.children[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(f.monitor.setTarget('synthetic-B.exe'), false);
  assert.equal(f.children.length, 1);
  assert.equal(f.monitor.setTarget(null), true);
  assert.equal(f.children[0].ended, true);
  assert.deepEqual(f.children[1].args, ['', '777']);
  assert.equal(f.timers[0].active, false);
  assert.equal(f.timers[1].active, true);
});

test('retargeting cancels old focus and ignores old process data, errors, exits and timers', async (t) => {
  const f = setup(t);
  f.monitor.start();
  const old = f.children[0],
    oldTimer = f.timers[0];
  f.emitWindow(old, '123');
  const focus = f.monitor.restore('123');
  assert.deepEqual(old.writes, ['focus:123\n']);
  f.monitor.setTarget('synthetic-B.exe');
  assert.equal(await focus, false);
  assert.equal(f.monitor.state, null);
  assert.equal(f.changes.at(-1), null);
  const current = f.children[1];
  f.emitWindow(current, '987');
  f.now(4000);
  const newFocus = f.monitor.restore('987');
  old.stdout.emit('data', '{"type":"focus","ok":true}\n');
  f.emitWindow(old, '123');
  old.emit('error', Error('late old helper error'));
  old.emit('exit', 1);
  oldTimer.tick();
  assert.equal(f.monitor.child, current);
  assert.equal(f.monitor.state.hwnd, '987');
  assert.equal(f.monitor.error, '');
  assert.equal(typeof f.monitor.focusResult, 'function');
  current.stdout.emit('data', '{"type":"focus","ok":true}\n');
  assert.equal(await newFocus, true);
  f.timers[1].tick();
  assert.equal(f.monitor.state, null, 'Only the current timer may expire a current stale observation');
});

test('disposed monitors cannot be revived or changed by late helper output', async (t) => {
  const f = setup(t);
  f.monitor.start();
  const old = f.children[0];
  f.emitWindow(old, '123');
  const focus = f.monitor.restore('123');
  f.monitor.dispose();
  assert.equal(await focus, false);
  f.emitWindow(old, '123');
  old.emit('error', Error('late shutdown error'));
  old.emit('exit', 0);
  assert.equal(f.monitor.state, null);
  assert.equal(f.monitor.error, '');
  f.monitor.setTarget('synthetic-B.exe');
  f.monitor.setTarget('synthetic-B.exe');
  assert.equal(f.children.length, 1);
  assert.equal(await f.monitor.restore('123'), false);
});

test('a requested monitor recovers from a helper failure on the next target refresh without leaking timers', (t) => {
  const f = setup(t);
  f.monitor.start();
  f.children[0].emit('error', Error('synthetic missing helper'));
  assert.equal(f.monitor.child, null);
  assert.equal(f.monitor.error, 'synthetic missing helper');
  assert.equal(f.timers[0].active, false);
  assert.equal(f.monitor.setTarget('synthetic-A.exe'), false);
  assert.equal(f.children.length, 2);
  f.emitWindow(f.children[1], '456');
  assert.equal(f.monitor.error, '');
  f.children[1].emit('exit', 1);
  assert.equal(f.monitor.child, null);
  assert.equal(f.timers[1].active, false);
  f.monitor.setTarget('synthetic-A.exe');
  assert.equal(f.children.length, 3);
  assert.equal(f.timers.filter((timer) => timer.active).length, 1);
  f.monitor.dispose();
  f.monitor.setTarget('synthetic-A.exe');
  assert.equal(f.children.length, 3);
  assert.equal(f.timers.filter((timer) => timer.active).length, 0);
});
