'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { GameWindow } = require('../src/core/game-window.cjs');
const { build } = require('./build-window-helper.cjs');
const base = path.resolve(__dirname, '..'),
  folder = path.join(base, '.test-data', `window-helper-${Date.now()}`);
fs.mkdirSync(folder, { recursive: true });
const source = path.join(folder, 'Fixture.cs'),
  executable = path.join(folder, 'Fixture.exe');
fs.writeFileSync(
  source,
  `using System; using System.Windows.Forms;
class Fixture : Form {
 protected override bool ShowWithoutActivation { get { return true; } }
 protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
 [STAThread] static void Main() { var f = new Fixture(); f.Text = "JH-Win64-Shipping (synthetic fixture)"; f.Width = 720; f.Height = 480;
 f.Shown += (s,e) => { Console.WriteLine("ready"); Console.Out.Flush(); };
 var timer = new Timer(); timer.Interval = 12000; timer.Tick += (s,e) => f.Close(); timer.Start(); Application.Run(f); }
}`,
);
const compiler = path.join(
  process.env.WINDIR || 'C:/Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
execFileSync(
  compiler,
  [
    '/nologo',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    `/out:${executable}`,
    source,
  ],
  { windowsHide: true },
);
function waitFor(emitter, event, predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, receive);
      reject(Error('Native helper wait timed out'));
    }, ms);
    const receive = (s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        emitter.off(event, receive);
        resolve(s);
      }
    };
    emitter.on(event, receive);
  });
}
(async () => {
  const helper = build();
  const fixture = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exact, spoof, second;
  try {
    await waitFor(fixture.stdout, 'data', (s) => String(s).includes('ready'));
    exact = new GameWindow(helper, executable);
    const detected = waitFor(exact, 'change', (s) => s?.available);
    exact.start();
    const state = await detected;
    assert(state.width >= 600 && state.width <= 3000);
    assert(state.height > 400);
    assert.notEqual(state.hwnd, '0');
    assert.equal(state.ownForeground, false);
    assert.equal(await exact.restore('0'), false, 'An invalid focus target must be rejected');
    assert.equal(
      await exact.restore(state.hwnd),
      false,
      'A valid target must not steal foreground from another application',
    );
    // The fixture has a convincing game title. A different full executable path must not match.
    spoof = new GameWindow(helper, path.join(folder, 'NotTheFixture.exe'));
    const absent = waitFor(spoof, 'change', (s) => s && !s.available);
    spoof.start();
    await absent;
    // Retarget the same controller to a different full executable path.
    const secondExecutable = path.join(folder, 'SecondFixture.exe');
    fs.copyFileSync(executable, secondExecutable);
    second = spawn(secondExecutable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(second.stdout, 'data', (s) => String(s).includes('ready'));
    const previous = exact.child;
    const previousExited = waitFor(previous, 'exit', () => true);
    const switched = waitFor(exact, 'change', (s) => s?.available && s.hwnd !== state.hwnd);
    exact.setTarget(secondExecutable);
    const secondState = await switched;
    await previousExited;
    assert.notEqual(secondState.hwnd, state.hwnd);
    assert.equal(await exact.restore(state.hwnd), false, 'A former target must not regain focus');
    const sameChild = exact.child;
    assert.equal(exact.setTarget(secondExecutable), false);
    assert.equal(exact.child, sameChild);
    const removed = waitFor(exact, 'change', (s) => s && !s.available);
    exact.setTarget('');
    await removed;
    const child = exact.child;
    const exited = waitFor(child, 'exit', () => true);
    exact.dispose();
    await exited;
    assert.equal(exact.state, null);
    fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'test-results', 'window-helper-smoke.json'),
      JSON.stringify(
        {
          passed: true,
          fullPathMatch: true,
          titleSpoofRejected: true,
          invalidFocusRejected: true,
          targetChangeFollowed: true,
          formerTargetFocusRejected: true,
          unchangedTargetReused: true,
          removedTargetCleared: true,
          pipeClosureExited: true,
        },
        null,
        2,
      ),
    );
    console.log('Native window helper smoke PASS (synthetic nonactivating window; no game/save access)');
  } finally {
    exact?.dispose();
    spoof?.dispose();
    fixture.kill();
    second?.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
