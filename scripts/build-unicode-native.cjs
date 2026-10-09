'use strict';
// Builds our extension against the existing pinned UE4SS exports without loading
// UE4SS or modifying game files. Output remains in the explicitly selected folder.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const TOOLCHAIN = 'MSVC-19.43.34810-x64-MD-WinSDK-10.0.26100.0';
const base = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (process.platform !== 'win32' || args.length !== 2 || args[0] !== '--out-dir' || !path.isAbsolute(args[1]))
  throw Error('Run on Windows: node scripts/build-unicode-native.cjs --out-dir <absolute-build-directory>');
if (process.env.YIJIAN_TOOLCHAIN_ID !== TOOLCHAIN || !process.env.YIJIAN_CL || !process.env.YIJIAN_LIB)
  throw Error('Configure the pinned x64 Microsoft compiler/SDK before building: ' + TOOLCHAIN);
const out = path.resolve(args[1]);
fs.mkdirSync(out, { recursive: true });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(fs.readFileSync(path.join(base, 'src/game-bridge/provenance.json')));
const dll = fs.readFileSync(path.join(base, 'src/game-bridge/runtime/ue4ss/UE4SS.dll'));
if (sha(dll) !== provenance.files['ue4ss/UE4SS.dll'] ||
    provenance.nativeIO?.ue4ssCommit !== 'e3ba1016562d6c0868c410d0a71e88bfcdbf691b' ||
    provenance.nativeIO.ue4ssDllSha256 !== provenance.files['ue4ss/UE4SS.dll'])
  throw Error('Pinned UE4SS ABI source/binary mismatch');
const pe = dll.readUInt32LE(60), optional = pe + 24;
const sectionCount = dll.readUInt16LE(pe + 6), sections = optional + dll.readUInt16LE(pe + 20);
if (dll.readUInt16LE(pe + 4) !== 0x8664 || dll.readUInt16LE(optional) !== 0x20b)
  throw Error('Pinned UE4SS must be Windows x64 PE32+');
function rva(value) {
  for (let i = 0; i < sectionCount; ++i) {
    const s = sections + i * 40, start = dll.readUInt32LE(s + 12);
    const size = Math.max(dll.readUInt32LE(s + 8), dll.readUInt32LE(s + 16));
    if (value >= start && value < start + size) return dll.readUInt32LE(s + 20) + value - start;
  }
  throw Error('Invalid pinned PE RVA');
}
const exportsAt = rva(dll.readUInt32LE(optional + 112));
const names = rva(dll.readUInt32LE(exportsAt + 32));
const symbols = [];
for (let i = 0; i < dll.readUInt32LE(exportsAt + 24); ++i) {
  const start = rva(dll.readUInt32LE(names + i * 4));
  const name = dll.toString('ascii', start, dll.indexOf(0, start));
  if (name.includes('CppUserModBase@RC@@') || name.includes('@Lua@LuaMadeSimple@RC@@')) symbols.push(name);
}
fs.writeFileSync(path.join(out, 'UE4SS.def'), 'LIBRARY UE4SS.dll\nEXPORTS\n' + symbols.join('\n') + '\n');
execFileSync(process.env.YIJIAN_LIB, ['/nologo', '/machine:x64', '/Brepro', '/def:UE4SS.def',
  '/out:UE4SS.lib'], { cwd: out, stdio: 'inherit', windowsHide: true });
const sourceRoot = path.join(base, 'src/native');
const sourceFiles = ['UnicodeBridge.cpp', 'UnicodeIo.hpp', 'NativeChannel.hpp', 'LuaApi.hpp', 'ue4ss-pinned-abi.hpp'];
const sourceSha256 = sha(Buffer.concat(sourceFiles.map((name) =>
  Buffer.concat([Buffer.from(name + '\n'), fs.readFileSync(path.join(sourceRoot, name))]))));
if (sourceSha256 !== provenance.nativeIO.sourceSha256) throw Error('Pinned native source mismatch');
// MSVC's anonymous-namespace names and COFF records depend on input/output paths.
// Verified copies, fixed relative inputs and path mapping make them reproducible
// across source checkouts and build directories, without moving any game files.
const stage = path.join(out, 'source');
fs.mkdirSync(stage, { recursive: true });
for (const name of sourceFiles) {
  const bytes = fs.readFileSync(path.join(sourceRoot, name)), target = path.join(stage, name);
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
  else if (!fs.readFileSync(target).equals(bytes)) throw Error('Build source copy changed; choose a fresh output directory');
}
execFileSync(process.env.YIJIAN_CL, ['/nologo', '/std:c++latest', '/utf-8', '/EHsc', '/MD', '/O2', '/W4', '/wd4100',
  '/experimental:deterministic', '/pathmap:' + out + '=X:\\YijianUnicodeBuild', '/Brepro', '/LD',
  'source/UnicodeBridge.cpp', '/Fo:UnicodeBridge.obj', '/Fe:main.dll', 'UE4SS.lib', 'kernel32.lib', 'bcrypt.lib',
  '/link', '/Brepro', '/INCREMENTAL:NO', '/IMPLIB:main.lib'], { cwd: out, stdio: 'inherit', windowsHide: true });
const outputHash = sha(fs.readFileSync(path.join(out, 'main.dll')));
const record = { toolchain: TOOLCHAIN, architecture: 'x64', crt: '/MD', cppStandard: 'C++23',
  ue4ssCommit: provenance.nativeIO.ue4ssCommit, ue4ssDllSha256: sha(dll), sourceSha256,
  buildScriptSha256: sha(fs.readFileSync(__filename)), deterministic: true,
  objectSha256: sha(fs.readFileSync(path.join(out, 'UnicodeBridge.obj'))),
  importLibrarySha256: sha(fs.readFileSync(path.join(out, 'UE4SS.lib'))),
  sha256: outputHash, pinnedOutputMatches: outputHash === provenance.nativeIO.sha256 };
fs.writeFileSync(path.join(out, 'build-manifest.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
// A build never updates the distribution pin. A different compiler or output
// requires a new reviewed provenance pin before it can pass the installer.
