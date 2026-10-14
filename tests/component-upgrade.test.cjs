'use strict';
// All DLLs, executables and saves below are inert synthetic bytes in isolated temporary directories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Timeline, readStable, writeBytes } = require('../src/core/timeline.cjs');
const { sha } = require('../src/core/saves.cjs');
const shipped = require('../src/game-bridge/provenance.json');
const bridgeFile = path.resolve(__dirname, '../src/core/game-bridge.cjs');
const bridgeSource = fs.readFileSync(bridgeFile, 'utf8');
const nativeMod = 'YijianJournalUnicode';
const oldNative = Buffer.from('Synthetic published old Unicode component; never executable');
const newNative = Buffer.from('Synthetic current Unicode component; never executable');
const oldHash = sha(oldNative);

function fixture(t, { legacy = false, mod = 'YijianJournalBridge', fresh = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-component-upgrade-'));
  const dataRoot = path.join(root, 'journal-data');
  const game = { installed: true, build: shipped.gameBuild, path: path.join(root, 'synthetic-game') };
  const bin = path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64');
  const nativeTarget = path.join(bin, 'ue4ss', 'Mods', nativeMod, 'dlls', 'main.dll');
  const marker = path.join(bin, '.yijian-component.json');
  const backup = path.join(dataRoot, 'component-backups', nativeMod, oldHash + '.dll');
  const exe = Buffer.from('Synthetic compatible EXE; never executable');
  const runtime = {
    'dwmapi.dll': Buffer.from('Synthetic pinned proxy; never executable'),
    'ue4ss/UE4SS.dll': Buffer.from('Synthetic pinned UE4SS; never executable'),
  };
  const provenance = {
    ...shipped,
    gameExeSha256: sha(exe),
    files: Object.fromEntries(Object.entries(runtime).map(([name, bytes]) => [name, sha(bytes)])),
    nativeIO: { ...shipped.nativeIO, sha256: sha(newNative), upgradeFromSha256: [oldHash] },
  };
  const resources = path.resolve(__dirname, '../src/game-bridge');
  const settings = Buffer.from(
    [
      'MajorVersion',
      'MinorVersion',
      'ConsoleEnabled',
      'GuiConsoleEnabled',
      'GuiConsoleVisible',
      'bUseUObjectArrayCache',
      'EnableHotReloadSystem',
      'EnableAutoReloadingLuaMods',
      'ControllingModsTxt',
    ]
      .map((key) => key + ' = synthetic')
      .join('\n') + '\n',
  );
  const bundled = new Map([
    [
      path.join(resources, 'main.lua'),
      Buffer.from('-- synthetic Lua\n__JOURNAL_ROOT__\n__JOURNAL_REVISION__\n'),
    ],
    [path.join(resources, 'runtime', 'unicode', 'main.dll'), newNative],
    [path.join(resources, 'runtime', 'ue4ss', 'UE4SS-settings.ini'), settings],
    [path.join(resources, 'runtime', 'ue4ss', 'LICENSE'), Buffer.from('Synthetic license fixture')],
    ...Object.entries(runtime).map(([name, bytes]) => [path.join(resources, 'runtime', name), bytes]),
  ]);
  const writes = [],
    hooks = {};
  let stopped = true;
  const injectedFs = Object.create(fs);
  injectedFs.readFileSync = (file, options) => {
    const bytes = bundled.get(file);
    if (!bytes) return fs.readFileSync(file, options);
    return typeof options === 'string' ? bytes.toString(options) : Buffer.from(bytes);
  };
  for (const name of ['mkdirSync', 'linkSync', 'unlinkSync']) {
    injectedFs[name] = (...args) => {
      writes.push([name, ...args]);
      hooks[name]?.(...args);
      const result = fs[name](...args);
      hooks['after' + name]?.(...args);
      return result;
    };
  }
  const realRequire = createRequire(bridgeFile),
    module = { exports: {} };
  vm.runInNewContext(bridgeSource, {
    module,
    __dirname: path.dirname(bridgeFile),
    Buffer,
    performance,
    setTimeout,
    setInterval,
    clearInterval,
    require: (name) => {
      if (name === 'node:fs') return injectedFs;
      if (name === 'node:child_process')
        return {
          execFileSync: () => {
            throw Error('No process access in synthetic installation tests');
          },
        };
      if (name === '../game-bridge/provenance.json') return provenance;
      if (name === './timeline.cjs')
        return {
          ...realRequire(name),
          readStable: (file) => {
            hooks.readStable?.(file);
            return readStable(file);
          },
          writeBytes: (file, bytes) => {
            writes.push(['writeBytes', file]);
            hooks.writeBytes?.(file, bytes);
            return writeBytes(file, bytes);
          },
        };
      return realRequire(name);
    },
  });
  fs.mkdirSync(fresh ? bin : path.dirname(nativeTarget), { recursive: true });
  if (!fresh) fs.writeFileSync(nativeTarget, oldNative);
  fs.writeFileSync(path.join(bin, 'JH-Win64-Shipping.exe'), exe);
  if (!fresh)
    for (const [name, bytes] of Object.entries(runtime)) fs.writeFileSync(path.join(bin, name), bytes);
  const timeline = new Timeline(path.join(dataRoot, 'game-timeline'));
  const bridge = new module.exports.GameBridge(
    legacy ? path.join(bin, 'ue4ss', 'YijianJournal') : path.join(dataRoot, 'game-bridge'),
    timeline,
    { getGame: () => game, stopped: () => stopped, account: () => '76561190000000000' },
  );
  const oldMarker = {
    schema: 1,
    mod,
    root: bridge.root,
    protocol: 2,
    nativeMod,
    unicodeSha256: oldHash,
    version: 'synthetic-old',
  };
  if (!fresh) fs.writeFileSync(marker, JSON.stringify(oldMarker));
  const saved = path.join(root, '76561190000000000', 'SaveGames', '1.sav');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, 'Synthetic read-only saved progress');
  writes.length = 0;
  t.after(() => {
    bridge.dispose();
    assert.equal(fs.readFileSync(saved, 'utf8'), 'Synthetic read-only saved progress');
    assert.equal(fs.existsSync(path.join(path.dirname(saved), '29.sav')), false);
    assert.equal(fs.existsSync(path.join(bridge.root, 'command.txt')), false);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-component-upgrade-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dataRoot,
    game,
    bin,
    bridge,
    timeline,
    marker,
    oldMarker,
    nativeTarget,
    backup,
    provenance,
    writes,
    hooks,
    setStopped: (value) => {
      stopped = value;
    },
  };
}

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      entries.push([
        path.relative(root, file),
        entry.isDirectory() ? null : fs.readFileSync(file).toString('hex'),
      ]);
      if (entry.isDirectory()) visit(file);
    }
  }
  visit(root);
  return entries;
}

function rejectWithoutWrites(s, pattern) {
  const before = snapshot(s.root);
  assert.throws(() => s.bridge.install(), pattern);
  assert.deepEqual(s.writes, [], 'rejection must happen before any installation write');
  assert.deepEqual(snapshot(s.root), before);
}

function assertOldComponent(s) {
  assert.deepEqual(fs.readFileSync(s.nativeTarget), oldNative);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.marker, 'utf8')), s.oldMarker);
  assert.equal(
    s.writes.some(([kind, file]) => kind === 'writeBytes' && file.startsWith(s.game.path + path.sep)),
    false,
  );
}

test('only the released v1.17 Unicode DLL is an allowed upgrade source', () => {
  assert.deepEqual(shipped.nativeIO.upgradeFromSha256, [
    'f632791ed6fce524a49d068de3f5f175eff99f932973bbc562d9f1a48433f6ae',
  ]);
  assert.ok(!shipped.nativeIO.upgradeFromSha256.includes(shipped.nativeIO.sha256));
});

for (const fresh of [true, false])
  test(`${fresh ? 'first installation' : 'component upgrade'} enables read-only guidance without reserving slot 29`, async (t) => {
    const s = fixture(t, { fresh });
    const source = path.join(s.root, '76561190000000000', 'SaveGames');
    const before = structuredClone(s.timeline.data);
    assert.equal(s.bridge.install().installed, true);
    s.bridge.connect(source);
    assert.deepEqual(s.timeline.data, before, 'observing must not grant timeline authority');
    assert.equal(s.bridge.grantBinding, '');
    const config = fs.readFileSync(path.join(s.bridge.root, 'config.txt'), 'utf8').trimEnd().split('\n');
    assert.equal(config[6], 'observe');
    const { mac } = require('../src/core/native-io.cjs');
    assert.equal(
      config[8],
      mac(s.bridge.token, config.slice(0, 8).join('\n') + '\n' + s.bridge.root.replaceAll('\\', '/') + '/\n'),
    );
    const dialogue = {
      schema: 1,
      sequence: 1,
      questId: 11004,
      npcId: 10038,
      options: [
        { index: 1, text: '买把新的比较好' },
        { index: 2, text: '重新锻造一番吧' },
      ],
    };
    writeBytes(
      path.join(s.bridge.root, 'state.json'),
      Buffer.from(
        JSON.stringify({
          protocol: 2,
          revision: s.bridge.revision,
          token: s.bridge.token,
          source,
          session: '1800000000-123456',
          at: Math.floor(Date.now() / 1000),
          ready: false,
          reason: '菜单或对话中暂停保存',
          dialogue,
        }),
      ),
    );
    assert.equal(s.bridge.connected(), true);
    assert.deepEqual(s.bridge.liveGuidance(source).dialogue, dialogue);
    assert.equal(s.bridge.summary().ready, false, 'connection is not save permission');
    await assert.rejects(
      s.bridge.request('00000000-0000-0000-0000-000000000001', 'save'),
      (e) => e.notDispatched === true,
    );
    await assert.rejects(
      s.bridge.request('00000000-0000-0000-0000-000000000001', 'load'),
      (e) => e.notDispatched === true,
    );
    const grant = fs.readFileSync(path.join(s.bridge.root, 'config.txt'));
    s.bridge.account = () => '76561190000000001';
    assert.throws(() => s.bridge.connect(source), /Steam/);
    assert.deepEqual(fs.readFileSync(path.join(s.bridge.root, 'config.txt')), grant);
    s.bridge.statusAccount = null;
    assert.deepEqual(structuredClone(s.bridge.liveGuidance(source)), {
      dialogue: null,
      suppressedQuestIds: [11004],
    });
    s.bridge.account = () => '76561190000000000';
    s.timeline.configure(source, false, 10); // Main prepares this on startup without native consent.
    const restarted = new s.bridge.constructor(s.bridge.root, s.timeline, {
      getGame: () => s.game,
      stopped: () => true,
      account: s.bridge.account,
    });
    t.after(() => restarted.dispose());
    assert.equal(restarted.connected(), true);
    assert.deepEqual(restarted.liveGuidance(source).dialogue, dialogue);
    assert.equal(restarted.grantBinding, '');
    assert.equal(s.timeline.data.nativeProtocol, 0);
    assert.equal(s.timeline.data.enabled, false);
    const waiting = new s.bridge.constructor(s.bridge.root, s.timeline, {
      getGame: () => s.game,
      stopped: () => true,
      account: () => {
        throw Error('Steam not ready');
      },
    });
    t.after(() => waiting.dispose());
    assert.equal(waiting.connected(), false);
    waiting.account = () => '76561190000000000';
    waiting.reconcileEnvironment();
    assert.equal(
      waiting.connected(),
      true,
      'Steam becoming ready resumes only the installed read-only connection',
    );
    assert.equal(waiting.grantBinding, '');
    assert.equal(s.timeline.data.nativeProtocol, 0);
    const next = path.join(s.root, '76561190000000001', 'SaveGames');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, '1.sav'), 'Synthetic next-account progress');
    s.timeline.configure(next, false, 10);
    waiting.account = () => {
      throw Error('Steam temporarily unavailable');
    };
    assert.throws(() => waiting.connect(next), /temporarily unavailable/);
    assert.equal(waiting.guidanceSource, source);
    waiting.account = () => '76561190000000001';
    waiting.reconcileEnvironment();
    assert.equal(waiting.guidanceSource, next, 'a failed source change retries the selected account');
    assert.equal(waiting.grantBinding, '');
    assert.equal(s.timeline.data.nativeProtocol, 0);
    assert.equal(s.timeline.data.enabled, false);
    assert.equal(fs.readFileSync(path.join(next, '1.sav'), 'utf8'), 'Synthetic next-account progress');
    assert.equal(fs.existsSync(path.join(next, '29.sav')), false);
  });

test('recognized old native components upgrade only after preserving verified original bytes in app data', (t) => {
  for (const mod of ['YijianJournalBridge', 'YijianSaveProbe']) {
    for (const legacy of [false, true]) {
      const s = fixture(t, { mod, legacy });
      s.hooks.writeBytes = (file) => {
        if (file === s.nativeTarget) assert.deepEqual(fs.readFileSync(s.backup), oldNative);
      };
      assert.equal(s.bridge.install().installed, true);
      assert.deepEqual(fs.readFileSync(s.nativeTarget), newNative);
      assert.deepEqual(fs.readFileSync(s.backup), oldNative);
      const marker = JSON.parse(fs.readFileSync(s.marker, 'utf8'));
      assert.equal(marker.unicodeSha256, sha(newNative));
      assert.equal(marker.mod, mod);
      assert.equal(marker.root, s.bridge.root);
      assert.equal(s.timeline.data.enabled, false);
      assert.equal(s.timeline.data.nativeProtocol, 0);
      assert.equal(s.bridge.installation().installed, true);
      assert.deepEqual(fs.readdirSync(path.dirname(s.backup)), [oldHash + '.dll']);
    }
  }
});

test('foreign, mismatched, missing and unknown native installations reject with zero writes', (t) => {
  const changes = [
    (s) => {
      s.oldMarker.root = path.join(s.root, 'foreign-journal');
    },
    (s) => {
      s.oldMarker.mod = 'ForeignMod';
    },
    (s) => {
      s.oldMarker.schema = 2;
    },
    (s) => {
      s.oldMarker.protocol = 1;
    },
    (s) => {
      s.oldMarker.nativeMod = 'ForeignNativeMod';
    },
    (s) => {
      s.oldMarker.unicodeSha256 = sha(newNative);
    },
    (s) => {
      delete s.oldMarker.unicodeSha256;
    },
    (s) => {
      fs.writeFileSync(s.nativeTarget, 'Synthetic modified DLL');
    },
    (s) => {
      const unknown = Buffer.from('Synthetic unrecognized old DLL');
      s.oldMarker.unicodeSha256 = sha(unknown);
      fs.writeFileSync(s.nativeTarget, unknown);
    },
  ];
  for (const change of changes) {
    const s = fixture(t);
    change(s);
    fs.writeFileSync(s.marker, JSON.stringify(s.oldMarker));
    rejectWithoutWrites(s);
  }
  const s = fixture(t);
  fs.unlinkSync(s.marker);
  rejectWithoutWrites(s, /其他游戏接入文件/);
});

test('running game, heartbeat and queued load refuse native upgrades with zero writes', (t) => {
  for (const state of ['process', 'heartbeat', 'queued']) {
    const s = fixture(t);
    if (state === 'process') s.setStopped(false);
    if (state === 'queued') s.bridge.loadQueued = true;
    if (state === 'heartbeat')
      fs.writeFileSync(
        path.join(s.bridge.root, 'state.json'),
        JSON.stringify({
          protocol: 2,
          at: Math.floor(Date.now() / 1000),
          ready: true,
          session: '1790000000-123456',
        }),
      );
    rejectWithoutWrites(s, /退出游戏/);
  }
});

test('EXE and UE4SS compatibility pins still reject before any upgrade writes', (t) => {
  for (const name of ['JH-Win64-Shipping.exe', 'dwmapi.dll', 'ue4ss/UE4SS.dll']) {
    const s = fixture(t);
    fs.writeFileSync(path.join(s.bin, name), 'Synthetic changed pinned component');
    rejectWithoutWrites(s, /已停止接入|停止安装/);
  }
});

test('an existing matching protection copy is reused and a mismatching copy is never overwritten', (t) => {
  for (const matching of [true, false]) {
    const s = fixture(t);
    fs.mkdirSync(path.dirname(s.backup), { recursive: true });
    const preserved = matching ? oldNative : Buffer.from('Synthetic unrelated protection copy');
    fs.writeFileSync(s.backup, preserved);
    const before = fs.statSync(s.backup, { bigint: true });
    if (matching) assert.equal(s.bridge.install().installed, true);
    else {
      assert.throws(() => s.bridge.install(), /保护副本不匹配/);
      assertOldComponent(s);
    }
    assert.deepEqual(fs.readFileSync(s.backup), preserved);
    assert.equal(fs.statSync(s.backup, { bigint: true }).mtimeNs, before.mtimeNs);
    assert.equal(
      s.writes.some(([kind]) => kind === 'linkSync'),
      false,
    );
  }
});

test('backup publication and verification failures preserve the original DLL and marker', (t) => {
  for (const failure of ['write', 'link', 'verify', 'collision']) {
    const s = fixture(t);
    if (failure === 'write')
      s.hooks.writeBytes = (file) => {
        if (file.startsWith(path.dirname(s.backup) + path.sep)) throw Error('Synthetic backup write failed');
      };
    if (failure === 'link')
      s.hooks.linkSync = () => {
        throw Error('Synthetic backup link failed');
      };
    if (failure === 'verify')
      s.hooks.readStable = (file) => {
        if (file === s.backup) throw Error('Synthetic backup verification failed');
      };
    if (failure === 'collision')
      s.hooks.linkSync = (from, to) => {
        fs.writeFileSync(to, 'Synthetic racing foreign protection copy');
      };
    assert.throws(() => s.bridge.install(), /无法保护旧接入组件.*原组件已保留.*目录权限|保护副本不匹配/);
    assertOldComponent(s);
    if (failure === 'collision')
      assert.equal(fs.readFileSync(s.backup, 'utf8'), 'Synthetic racing foreign protection copy');
  }
});

test('upgrades recheck stopped state, marker and original DLL after protection publication', (t) => {
  for (const change of ['process', 'marker', 'native']) {
    const s = fixture(t);
    s.hooks.afterlinkSync = () => {
      if (change === 'process') s.setStopped(false);
      if (change === 'marker') fs.writeFileSync(s.marker, 'Synthetic concurrent marker change');
      if (change === 'native') fs.writeFileSync(s.nativeTarget, 'Synthetic concurrent DLL change');
    };
    assert.throws(() => s.bridge.install(), /退出游戏|正在变化/);
    assert.deepEqual(fs.readFileSync(s.backup), oldNative);
    assert.deepEqual(
      fs.readFileSync(s.nativeTarget),
      change === 'native' ? Buffer.from('Synthetic concurrent DLL change') : oldNative,
    );
    assert.equal(
      s.writes.some(([kind, file]) => kind === 'writeBytes' && file.startsWith(s.game.path + path.sep)),
      false,
    );
  }
});

test('missing or game-local application data roots cannot be used for component protection', (t) => {
  for (const timelineRoot of [undefined, 'game-local']) {
    const s = fixture(t);
    s.timeline.root = timelineRoot === 'game-local' ? path.join(s.game.path, 'game-timeline') : undefined;
    rejectWithoutWrites(s);
  }
});

test('linked application data parents and linked component backup directories are refused', (t) => {
  for (const linkedParent of [true, false]) {
    const s = fixture(t);
    const target = path.join(s.root, 'synthetic-link-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'Synthetic unrelated directory contents');
    const link = linkedParent
      ? path.join(s.root, 'linked-app-data')
      : path.join(s.dataRoot, 'component-backups');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    if (linkedParent) s.timeline.root = path.join(link, 'game-timeline');
    const before = snapshot(target);
    assert.throws(() => s.bridge.install(), /无法确认手札数据目录|无法保护旧接入组件/);
    assert.deepEqual(snapshot(target), before);
    assertOldComponent(s);
    assert.equal(fs.existsSync(s.backup), false);
    if (linkedParent) assert.deepEqual(s.writes, []);
  }
});
