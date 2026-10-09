'use strict';
// Only temporary synthetic games; the copied pinned DLLs are never loaded.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { GameBridge } = require('../src/core/game-bridge.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { sha } = require('../src/core/saves.cjs');
const provenance = require('../src/game-bridge/provenance.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-component-config-'));
  let game = { installed: true, build: provenance.gameBuild, path: path.join(root, 'synthetic-game') };
  const bin = path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64');
  fs.mkdirSync(bin, { recursive: true });
  const executable = Buffer.from('Synthetic game placeholder; never executed');
  fs.writeFileSync(path.join(bin, 'JH-Win64-Shipping.exe'), executable);
  const source = path.join(root, '76561190000000000', 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const saved = Buffer.from('Synthetic read-only save bytes');
  fs.writeFileSync(path.join(source, '1.sav'), saved);
  const timeline = new Timeline(path.join(root, 'history'));
  timeline.configure(source, false, 10);
  const bridge = new GameBridge(path.join(root, 'journal-ipc'), timeline, {
    getGame: () => game,
    stopped: () => true,
  });
  const checkedHash = bridge.checkedHash.bind(bridge);
  // This replaces only the synthetic game's compatibility hash.
  bridge.checkedHash = (file) =>
    path.basename(file) === 'JH-Win64-Shipping.exe' ? provenance.gameExeSha256 : checkedHash(file);
  assert.equal(bridge.install().installed, true);
  t.after(() => {
    bridge.dispose();
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), saved);
    assert.equal(fs.existsSync(path.join(bridge.root, 'command.txt')), false);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-component-config-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    bin,
    bridge,
    timeline,
    checkedHash,
    source,
    saved,
    getGame: () => game,
    setGame: (value) => {
      game = value;
    },
  };
}

test('component status detects obsolete generated Lua and disabled or stale control paths read-only', (t) => {
  const s = fixture(t);
  const marker = path.join(s.bin, '.yijian-component.json');
  for (const mod of ['YijianJournalBridge', 'YijianSaveProbe']) {
    fs.writeFileSync(marker, JSON.stringify({ schema: 1, mod, root: s.bridge.root }));
    assert.equal(s.bridge.install().installed, true);
    const script = path.join(s.bin, 'ue4ss', 'Mods', mod, 'Scripts', 'main.lua');
    const control = path.join(s.bin, 'ue4ss', 'Mods', 'yijian-mods.txt');
    const ini = path.join(s.bin, 'ue4ss', 'UE4SS-settings.ini');
    for (const [file, replacement, reason] of [
      [script, Buffer.from('-- synthetic obsolete Lua'), /脚本需要更新/],
      [control, Buffer.from(mod + ' : 0\n'), /配置需要更新/],
      [
        ini,
        Buffer.from(
          fs
            .readFileSync(ini, 'utf8')
            .replace(/^ControllingModsTxt.*$/m, 'ControllingModsTxt = nonexistent/old/mods.txt'),
        ),
        /配置需要更新/,
      ],
    ]) {
      const original = fs.readFileSync(file);
      const markerBefore = fs.readFileSync(marker);
      fs.writeFileSync(file, replacement);
      const status = s.bridge.installation();
      assert.equal(status.installed, false);
      assert.match(status.reason, reason);
      assert.deepEqual(fs.readFileSync(file), replacement, 'status must not silently repair configuration');
      assert.deepEqual(fs.readFileSync(marker), markerBefore);
      fs.writeFileSync(file, original);
      assert.equal(s.bridge.installation().installed, true);
    }
  }
});

test('relative control survives Steam moves, obsolete absolute controls require explicit update', (t) => {
  const s = fixture(t);
  const before = fs.readFileSync(s.timeline.file),
    token = s.bridge.token;
  const moved = path.join(s.root, 'moved-synthetic-game');
  const bin = path.join(moved, 'Wandering_Sword', 'Binaries', 'Win64');
  for (const relative of [
    'JH-Win64-Shipping.exe',
    '.yijian-component.json',
    ...Object.keys(provenance.files),
    'ue4ss/LICENSE',
    'ue4ss/UE4SS-settings.ini',
    'ue4ss/Mods/yijian-mods.txt',
    'ue4ss/Mods/YijianJournalBridge/Scripts/main.lua',
    'ue4ss/Mods/YijianJournalUnicode/dlls/main.dll',
  ]) {
    const file = path.join(bin, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(s.bin, relative), file);
  }
  s.setGame({ ...s.getGame(), path: moved });
  const settingsFile = path.join(bin, 'ue4ss', 'UE4SS-settings.ini');
  assert.equal(s.bridge.installation().installed, true, 'relative control works after the game folder moves');
  fs.writeFileSync(settingsFile, fs.readFileSync(settingsFile, 'utf8').replace(/^ControllingModsTxt.*$/m,
    'ControllingModsTxt = ' + path.join(s.bin, 'ue4ss', 'Mods', 'yijian-mods.txt').replaceAll('\\', '/')));
  const oldSettings = fs.readFileSync(settingsFile);
  const status = s.bridge.installation();
  assert.equal(status.installed, false);
  assert.match(status.reason, /配置需要更新/);
  assert.deepEqual(fs.readFileSync(settingsFile), oldSettings);
  assert.equal(s.bridge.install().installed, true, 'only an explicit install updates paths');
  assert.ok(
    fs
      .readFileSync(settingsFile, 'utf8')
      .includes('ControllingModsTxt = Mods/yijian-mods.txt'),
  );
  assert.equal(fs.readFileSync(path.join(s.bridge.root, 'token.txt'), 'utf8'), token);
  assert.deepEqual(fs.readFileSync(s.timeline.file), before);
  assert.equal(fs.existsSync(path.join(s.source, '29.sav')), false);
});

test('launch compatibility checks only active recognized project proxies and preserve every file', (t) => {
  const s = fixture(t),
    marker = path.join(s.bin, '.yijian-component.json');
  const markerBefore = fs.readFileSync(marker),
    proxy = path.join(s.bin, 'dwmapi.dll');
  const proxyBefore = fs.readFileSync(proxy);
  assert.doesNotThrow(() => s.bridge.assertLaunchSafe());
  s.setGame({ ...s.getGame(), build: 'synthetic-unsupported-build' });
  assert.throws(() => s.bridge.assertLaunchSafe(), /不兼容.*停用接入.*查询和完整备份/);
  assert.deepEqual(fs.readFileSync(marker), markerBefore);
  assert.deepEqual(fs.readFileSync(proxy), proxyBefore);
  fs.writeFileSync(marker, JSON.stringify({ schema: 1, mod: 'foreign-component', root: s.bridge.root }));
  assert.doesNotThrow(() => s.bridge.assertLaunchSafe(), 'foreign components are not managed by the journal');
  fs.writeFileSync(marker, markerBefore);
  fs.renameSync(proxy, proxy + '.yijian-disabled');
  assert.doesNotThrow(() => s.bridge.assertLaunchSafe(), 'a stopped project proxy permits normal launch');
  assert.equal(sha(fs.readFileSync(proxy + '.yijian-disabled')), provenance.files['dwmapi.dll']);
  fs.renameSync(proxy + '.yijian-disabled', proxy);
  s.setGame({ ...s.getGame(), build: provenance.gameBuild });
  s.bridge.checkedHash = s.checkedHash;
  assert.throws(() => s.bridge.assertLaunchSafe(), /不兼容.*停用接入/);
  s.bridge.test = true;
  s.bridge.getGame = () => {
    throw Error('Test isolation must not inspect games');
  };
  assert.throws(() => s.bridge.assertLaunchSafe(), /测试环境/);
});
