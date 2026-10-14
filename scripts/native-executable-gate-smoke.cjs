'use strict';
// Explicit Windows development toolchain; all files, grants and processes are
// synthetic and stay in a fresh ignored directory. Never loads UE4SS or a game.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const toolchain = 'MSVC-19.43.34810-x64-MD-WinSDK-10.0.26100.0';
if (process.platform !== 'win32' || args.length !== 2 || args[0] !== '--out-dir' || !path.isAbsolute(args[1]))
  throw Error(
    'Run on Windows: node scripts/native-executable-gate-smoke.cjs --out-dir <fresh-absolute-ignored-directory>',
  );
if (process.env.YIJIAN_TOOLCHAIN_ID !== toolchain || !process.env.YIJIAN_CL)
  throw Error('Explicitly configure the pinned Microsoft compiler/SDK: ' + toolchain);
const out = path.resolve(args[1]);
const relative = path.relative(path.join(base, '.test-data'), out);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(out))
  throw Error('Choose a fresh directory inside this repository .test-data; existing evidence is preserved');
fs.mkdirSync(out, { recursive: true });
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const provenance = JSON.parse(fs.readFileSync(path.join(base, 'src/game-bridge/provenance.json')));
const bridge = fs.readFileSync(path.join(base, 'src/native/UnicodeBridge.cpp'), 'utf8');
assert.equal(bridge.match(/SupportedGameExeSha256="([a-f0-9]{64})"/)?.[1], provenance.gameExeSha256);
const root = path.join(out, '合成授权');
const source = path.join(out, '合成存档', '76561190000000000', 'SaveGames');
fs.mkdirSync(root);
fs.mkdirSync(source, { recursive: true });
const token = 'b'.repeat(64),
  revision = 'a'.repeat(64);
const config = [
  '2',
  token,
  source,
  '00000000-0000-0000-0000-000000000001',
  '76561190000000000',
  '21798996',
  '29',
  revision,
  '',
].join('\n');
const mac = crypto
  .createHmac('sha256', Buffer.from(token, 'hex'))
  .update(config + root + '\n')
  .digest('hex');
fs.writeFileSync(path.join(root, 'token.txt'), token);
fs.writeFileSync(path.join(root, 'config.txt'), config + mac + '\n');
fs.writeFileSync(path.join(source, '29.sav'), 'synthetic-save');
const observationRoot = root + '-observe';
fs.mkdirSync(observationRoot);
const observationConfig = config
  .split('\n')
  .map((line, index) => (index === 6 ? 'observe' : line))
  .join('\n');
const observationMac = crypto
  .createHmac('sha256', Buffer.from(token, 'hex'))
  .update(observationConfig + observationRoot + '\n')
  .digest('hex');
fs.writeFileSync(path.join(observationRoot, 'token.txt'), token);
fs.writeFileSync(path.join(observationRoot, 'config.txt'), observationConfig + observationMac + '\n');
fs.writeFileSync(path.join(observationRoot, 'command.txt'), 'synthetic command must not be read');
const unchanged = new Map(
  [
    path.join(root, 'token.txt'),
    path.join(root, 'config.txt'),
    path.join(source, '29.sav'),
    ...['token.txt', 'config.txt', 'command.txt'].map((name) => path.join(observationRoot, name)),
  ].map((file) => [file, hash(file)]),
);
const imageDir = path.join(out, '原生进程');
fs.mkdirSync(imageDir);
const executable = path.join(imageDir, 'gate-smoke.exe');
execFileSync(
  process.env.YIJIAN_CL,
  [
    '/nologo',
    '/std:c++latest',
    '/utf-8',
    '/EHsc',
    '/MD',
    '/O2',
    '/W4',
    '/wd4100',
    '/I' + path.join(base, 'src/native'),
    path.join(base, 'tests/fixtures/native-executable-gate.cpp'),
    '/Fo:' + path.join(out, 'gate.obj'),
    '/Fe:' + executable,
    'kernel32.lib',
    'bcrypt.lib',
    '/link',
    '/INCREMENTAL:NO',
  ],
  { cwd: out, stdio: 'inherit', windowsHide: true },
);
function run(image, expectedStatus) {
  const result = spawnSync(image, [root], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const result = run(executable, 0);
const nodeSha256 = hash(executable);
const powershellSha256 = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$ErrorActionPreference="Stop"; $stream=[System.IO.File]::OpenRead($env:YIJIAN_NATIVE_SMOKE_IMAGE); ' +
      '$algorithm=[System.Security.Cryptography.SHA256]::Create(); try { ' +
      '[System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() ' +
      '} finally { $algorithm.Dispose(); $stream.Dispose() }',
  ],
  {
    env: { ...process.env, YIJIAN_NATIVE_SMOKE_IMAGE: executable },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  },
).trim();
assert.equal(result.sha256, nodeSha256);
assert.equal(result.sha256, powershellSha256);
assert.notEqual(result.sha256, provenance.gameExeSha256);
assert.equal(result.rejected, true);
assert.equal(result.luaParameterReads, 0);
assert.equal(result.producerBound, false);
assert.equal(result.validPersistedGrant, true);
// An image launched through a directory junction must fail before any grant I/O.
const redirected = path.join(out, '重解析进程');
fs.symlinkSync(imageDir, redirected, 'junction');
assert.equal(run(path.join(redirected, path.basename(executable)), 3).error, 'reparse path rejected');
for (const [file, before] of unchanged)
  assert.equal(hash(file), before, 'Synthetic fixture changed: ' + file);
assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
const evidence = {
  ...result,
  nodeSha256,
  powershellSha256,
  reparseRejected: true,
  fixturesUnchanged: true,
  toolchain,
};
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
