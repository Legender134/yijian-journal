'use strict';
// These ZIPs contain inert synthetic bytes. Test mode never starts an application,
// creates shortcuts, touches a game, or uses the user's actual installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  prepareUpdateInstall,
  launchUpdateInstall,
  readInstallResult,
} = require('../src/core/app-update-install.cjs');
const windows = process.platform === 'win32';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const temporaryRoot = path.resolve(__dirname, '../.test-data');
fs.mkdirSync(temporaryRoot, { recursive: true });
const isolated = fs.mkdtempSync(path.join(temporaryRoot, 'update-install-'));
const priorTestData = process.env.YIJIAN_TEST_DATA;
process.env.YIJIAN_TEST_DATA = isolated;
test.after(() => {
  if (priorTestData === undefined) delete process.env.YIJIAN_TEST_DATA;
  else process.env.YIJIAN_TEST_DATA = priorTestData;
});
const top = '逸剑手札-win32-x64/';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const { name, bytes = Buffer.alloc(0), attributes = 0, declaredSize = bytes.length } of entries) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(declaredSize, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(attributes >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture({ mutateEntries = (entries) => entries, manifest = {} } = {}) {
  const root = fs.mkdtempSync(path.join(isolated, 'case-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
  const currentExe = path.join(root, 'old', '逸剑手札.exe');
  fs.mkdirSync(path.dirname(currentExe));
  fs.writeFileSync(currentExe, 'Synthetic old exe, never executable');
  const asar = Buffer.from('Synthetic app archive, never executable');
  const helper = Buffer.from('Synthetic window helper, never executable');
  const release = {
    product: '逸剑手札',
    version: '2.0.1',
    platform: 'win32-x64',
    archiveSha256: hash(asar),
    helperSha256: hash(helper),
    packagedFiles: { 'package.json': hash(Buffer.from('synthetic')) },
    ...manifest,
  };
  const entries = mutateEntries([
    { name: top + 'release-manifest.json', bytes: Buffer.from(JSON.stringify(release)) },
    { name: top + '逸剑手札.exe', bytes: Buffer.from('Synthetic new exe, never executable') },
    { name: top + 'resources/app.asar', bytes: asar },
    { name: top + 'resources/YijianWindow.exe', bytes: helper },
    { name: top + 'locales/zh-CN.pak', bytes: Buffer.from('Synthetic locale') },
  ]);
  const bytes = zip(entries);
  const file = path.join(cacheDir, 'release.zip');
  fs.writeFileSync(file, bytes);
  const options = {
    package: { file, manifest: { version: '2.0.1', size: bytes.length, sha256: hash(bytes) } },
    cacheDir,
    currentExe,
    processId: 0,
    testRoot: root,
  };
  return {
    root,
    cacheDir,
    file,
    options,
    entries,
    destination: path.join(root, 'programs', 'YijianJournal', '2.0.1'),
    prepare: () => prepareUpdateInstall(options),
  };
}
function execute(prepared) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      prepared.helperPath,
      '-PlanPath',
      prepared.planPath,
    ],
    { windowsHide: true, timeout: 30000, encoding: 'utf8' },
  );
}
function run(f, expectedCode = 'installed') {
  const result = execute(f.prepare());
  assert.equal(result.error, undefined);
  const receipt = readInstallResult(f.cacheDir);
  assert.ok(receipt, `Result missing; exit=${result.status}; ${result.stdout} ${result.stderr}`);
  assert.equal(receipt.code, expectedCode, result.stderr);
  assert.equal(result.status, expectedCode === 'installed' ? 0 : 1);
  assert.equal(fs.readFileSync(f.options.currentExe, 'utf8'), 'Synthetic old exe, never executable');
  return receipt;
}

test(
  'test installation is gated by an explicit isolated root and contained package',
  { skip: !windows },
  () => {
    const f = fixture();
    assert.throws(() => prepareUpdateInstall({ ...f.options, testRoot: path.dirname(isolated) }), /隔离/);
    assert.throws(() => prepareUpdateInstall({ ...f.options, testRoot: isolated }), /隔离/);
    assert.throws(
      () =>
        prepareUpdateInstall({ ...f.options, package: { ...f.options.package, file: f.options.currentExe } }),
      /缓存/,
    );
    assert.throws(() => prepareUpdateInstall({ ...f.options, processId: 0, testRoot: undefined }), /进程/);
  },
);

test(
  'real PowerShell helper installs complete synthetic package and reuses an identical version',
  { skip: !windows },
  () => {
    const f = fixture();
    run(f);
    const installRoot = path.dirname(f.destination);
    assert.deepEqual(fs.readdirSync(installRoot), ['2.0.1']);
    for (const entry of f.entries)
      assert.deepEqual(fs.readFileSync(path.join(f.destination, entry.name.slice(top.length))), entry.bytes);
    run(f);
    assert.deepEqual(fs.readdirSync(installRoot), ['2.0.1']);
    assert.ok(fs.existsSync(path.join(f.cacheDir, 'install-result.previous.json')));
    const priorStage = '.update-' + crypto.randomUUID().replaceAll('-', '');
    const priorDiagnostic = path.join(installRoot, priorStage, 'diagnostic.txt');
    fs.mkdirSync(path.dirname(priorDiagnostic));
    fs.writeFileSync(priorDiagnostic, 'Preserve an earlier failed update stage');
    run(f);
    assert.deepEqual(fs.readdirSync(installRoot).sort(), [priorStage, '2.0.1'].sort());
    assert.equal(fs.readFileSync(priorDiagnostic, 'utf8'), 'Preserve an earlier failed update stage');
  },
);

test(
  'hidden helper survives the preparing process exiting after its spawn handshake',
  { skip: !windows },
  async () => {
    const f = fixture();
    await assert.rejects(launchUpdateInstall({ helperPath: 'arbitrary' }), /准备/);
    const bootstrap = spawnSync(
      process.execPath,
      [
        '-e',
        'const u=require(process.argv[1]);u.launchUpdateInstall(u.prepareUpdateInstall(JSON.parse(process.argv[2]))).catch(()=>{process.exitCode=1});',
        require.resolve('../src/core/app-update-install.cjs'),
        JSON.stringify(f.options),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const deadline = Date.now() + 30000;
    while (!readInstallResult(f.cacheDir) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(readInstallResult(f.cacheDir)?.code, 'installed');
  },
);

test(
  'package digest, embedded archive digest and release identity fail without switching installation',
  { skip: !windows },
  () => {
    const changed = fixture();
    changed.options.package.manifest.sha256 = '0'.repeat(64);
    run(changed, 'package');
    assert.equal(fs.existsSync(changed.destination), false);
    for (const manifest of [
      { archiveSha256: '0'.repeat(64) },
      { helperSha256: '0'.repeat(64) },
      { product: 'Other' },
      { version: '2.0.2' },
      { platform: 'linux-x64' },
    ]) {
      const f = fixture({ manifest });
      run(f, 'manifest');
      assert.equal(fs.existsSync(f.destination), false);
    }
  },
);

test(
  'a live unrelated PID fails closed without stopping it or changing installation',
  { skip: !windows },
  () => {
    const f = fixture();
    f.options.processId = process.pid;
    run(f, 'process');
    assert.equal(fs.existsSync(f.destination), false);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  },
);

test(
  'ZIP slip, alternate roots, Windows aliases, ADS and duplicate paths are rejected before extraction',
  { skip: !windows },
  () => {
    for (const name of [
      top + '../escape.txt',
      '/absolute.txt',
      'C:/absolute.txt',
      'other-root/file.txt',
      top + 'resources\\escape.txt',
      top + 'resources/app.asar:stream',
      top + 'NUL.txt',
      top + 'COM\u00b9.txt',
      top + 'CONIN$',
      top + 'trailing. /file',
      top + 'resources/APP.ASAR',
      top + 'resources//empty.txt',
      top + 'resources/./same.txt',
    ]) {
      const f = fixture({ mutateEntries: (entries) => [...entries, { name, bytes: Buffer.from('bad') }] });
      run(f, 'zip');
      assert.equal(fs.existsSync(path.dirname(f.destination)), false, name);
      assert.equal(fs.existsSync(path.join(f.root, 'escape.txt')), false);
    }
  },
);

test(
  'ZIP link attributes, file-directory collisions and expanded size limits are rejected',
  { skip: !windows },
  () => {
    for (const bad of [
      { name: top + 'link', attributes: 0xa1ff0000, bytes: Buffer.from('target') },
      { name: top + 'reparse', attributes: 0x400, bytes: Buffer.from('target') },
      { name: top + 'resources', bytes: Buffer.from('file conflicting with directory') },
      { name: top + 'huge', bytes: Buffer.alloc(1), declaredSize: 0x80000001 },
    ]) {
      const f = fixture({ mutateEntries: (entries) => [...entries, bad] });
      run(f, 'zip');
      assert.equal(fs.existsSync(f.destination), false);
    }
  },
);

test(
  'same-version conflict preserves all existing bytes and rejects unlisted files',
  { skip: !windows },
  () => {
    const f = fixture();
    run(f);
    const old = path.join(f.destination, '逸剑手札.exe');
    fs.writeFileSync(old, 'Different existing installation');
    run(f, 'install');
    assert.equal(fs.readFileSync(old, 'utf8'), 'Different existing installation');
    const extra = fixture();
    run(extra);
    fs.writeFileSync(path.join(extra.destination, 'foreign.txt'), 'Foreign file');
    run(extra, 'install');
    assert.equal(fs.readFileSync(path.join(extra.destination, 'foreign.txt'), 'utf8'), 'Foreign file');
  },
);

test(
  'junction destinations are refused and their foreign target is never modified',
  { skip: !windows },
  () => {
    const f = fixture();
    const foreign = path.join(f.root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'Keep this');
    const prepared = f.prepare();
    fs.mkdirSync(path.dirname(f.destination), { recursive: true });
    fs.symlinkSync(foreign, f.destination, 'junction');
    const result = execute(prepared);
    assert.equal(result.status, 1);
    assert.equal(readInstallResult(f.cacheDir)?.code, 'install');
    assert.deepEqual(fs.readdirSync(foreign), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'Keep this');
  },
);

test('receipt parsing excludes private fields, untrusted messages, excessive data and links', () => {
  const root = fs.mkdtempSync(path.join(isolated, 'receipt-'));
  const file = path.join(root, 'install-result.json');
  const receipt = {
    schema: 1,
    status: 'failed',
    version: '2.0.1',
    code: 'package',
    at: new Date().toISOString(),
    message: 'private path',
    token: 'secret',
  };
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.deepEqual(Object.keys(readInstallResult(root)).sort(), [
    'at',
    'code',
    'message',
    'status',
    'version',
  ]);
  assert.doesNotMatch(JSON.stringify(readInstallResult(root)), /private|token|secret/);
  fs.writeFileSync(file, JSON.stringify({ ...receipt, code: 'attacker' }));
  assert.equal(readInstallResult(root), null);
  fs.writeFileSync(file, ' '.repeat(8193));
  assert.equal(readInstallResult(root), null);
  if (windows) {
    const linked = path.join(root, 'linked-cache');
    const actual = path.join(root, 'actual-cache');
    fs.mkdirSync(actual);
    fs.writeFileSync(path.join(actual, 'install-result.json'), JSON.stringify(receipt));
    fs.symlinkSync(actual, linked, 'junction');
    assert.equal(readInstallResult(linked), null);
  }
});
