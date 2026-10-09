'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');
const base = path.resolve(__dirname, '..');
const metadata = require('../package.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function auditNative(read) {
  const provenance = JSON.parse(read('src/game-bridge/provenance.json'));
  for (const [file, expected] of Object.entries(provenance.files))
    assert.equal(hash(read('src/game-bridge/runtime/' + file)), expected, 'UE4SS file pin: ' + file);
  const native = provenance.nativeIO;
  assert.equal(native.protocol, 2);
  assert.equal(native.ue4ssCommit, 'e3ba1016562d6c0868c410d0a71e88bfcdbf691b');
  assert.equal(native.ue4ssDllSha256, provenance.files['ue4ss/UE4SS.dll']);
  const sources = [
    'UnicodeBridge.cpp',
    'UnicodeIo.hpp',
    'NativeChannel.hpp',
    'LuaApi.hpp',
    'ue4ss-pinned-abi.hpp',
  ];
  assert.deepEqual(native.sources, sources);
  assert.equal(
    hash(
      Buffer.concat(
        sources.map((name) => Buffer.concat([Buffer.from(name + '\n'), read('src/native/' + name)])),
      ),
    ),
    native.sourceSha256,
    'Native source pin',
  );
  const dll = read('src/game-bridge/runtime/unicode/main.dll');
  assert.equal(hash(dll), native.sha256, 'Native DLL pin');
  assert.equal(dll.toString('ascii', 0, 2), 'MZ');
  const pe = dll.readUInt32LE(60);
  assert.equal(dll.toString('ascii', pe, pe + 4), 'PE\u0000\u0000');
  assert.equal(dll.readUInt16LE(pe + 4), 0x8664, 'Native architecture must be x64');
  assert.equal(dll.readUInt16LE(pe + 24), 0x20b, 'Native binary must be PE32+');
  for (const file of [
    'src/game-bridge/runtime/ue4ss/LICENSE',
    'src/native/LICENSE.ue4ss',
    'src/third-party/DIM-LICENSE.txt',
  ])
    assert.match(read(file).toString('utf8'), /Permission is hereby granted/);
  return {
    protocol: native.protocol,
    sha256: native.sha256,
    sourceSha256: native.sourceSha256,
    ue4ssCommit: native.ue4ssCommit,
    buildScriptSha256: native.buildScriptSha256,
  };
}
function audit(folder, { writeManifest = true } = {}) {
  if (!folder) throw Error('A packaged application folder is required');
  const archive = path.join(path.resolve(folder), 'resources', 'app.asar');
  const files = asar.listPackage(archive).map((name) => name.replace(/\\/g, '/').replace(/^\//, ''));
  const packagedFiles = {};
  for (const name of files) {
    if (
      !['src', 'README.md', 'package.json', '使用说明.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(
        name,
      ) &&
      !name.startsWith('src/')
    )
      throw Error(`Unexpected packaged file: ${name}`);
    if (!fs.statSync(path.join(base, name)).isFile()) continue;
    const embedded = asar.extractFile(archive, name.split('/').join(path.sep));
    packagedFiles[name] = hash(embedded);
    if (name === 'package.json') {
      // Packager deliberately removes scripts, private and devDependencies.
      const packed = JSON.parse(embedded);
      for (const field of ['name', 'productName', 'version', 'description', 'main', 'license'])
        assert.equal(packed[field], metadata[field], `Packaged metadata mismatch: ${field}`);
      assert.deepEqual(
        Object.keys(packed).sort(),
        [
          'name',
          'productName',
          'version',
          'description',
          'main',
          'license',
          'author',
          'repository',
          'homepage',
          'bugs',
          'engines',
        ].sort(),
      );
    } else if (packagedFiles[name] !== hash(fs.readFileSync(path.join(base, name)))) {
      throw Error(`Packaged file differs from source: ${name}`);
    }
  }
  function verifySourceContents(dir, prefix = 'src') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + '/' + entry.name;
      assert.equal(entry.isSymbolicLink(), false, 'Source may not contain packaged symlinks: ' + name);
      if (entry.isDirectory()) verifySourceContents(path.join(dir, entry.name), name);
      else assert.ok(packagedFiles[name], 'Source file omitted from package: ' + name);
    }
  }
  verifySourceContents(path.join(base, 'src'));
  assert.equal(
    hash(fs.readFileSync(path.join(base, 'scripts/build-unicode-native.cjs'))),
    JSON.parse(fs.readFileSync(path.join(base, 'src/game-bridge/provenance.json'))).nativeIO
      .buildScriptSha256,
    'Native build script pin',
  );
  const nativeIO = auditNative((name) => asar.extractFile(archive, name.split('/').join(path.sep)));
  assert.equal(hash(fs.readFileSync(path.join(folder, '使用说明.txt'))), packagedFiles['使用说明.txt']);
  const helperSha256 = hash(fs.readFileSync(path.join(folder, 'resources', 'YijianWindow.exe')));
  assert.equal(
    helperSha256,
    hash(fs.readFileSync(path.join(base, '.build', 'YijianWindow.exe'))),
    'Packaged window helper differs from build',
  );
  const manifest = {
    product: '逸剑手札',
    version: metadata.version,
    platform: 'win32-x64',
    auditedAt: new Date().toISOString(),
    electron: require('electron/package.json').version,
    gameDataBuild: require('../src/data/game-index.json').build,
    archiveSha256: hash(fs.readFileSync(archive)),
    helperSha256,
    nativeIO,
    packagedFiles,
  };
  if (writeManifest)
    fs.writeFileSync(path.join(folder, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (require.main === module) {
  const result = audit(process.argv[2]);
  console.log(
    'Release source/contents audit PASS:',
    result.version,
    Object.keys(result.packagedFiles).length,
    'files;',
    result.archiveSha256,
  );
}
module.exports = { audit, auditNative };
