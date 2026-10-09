'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { auditNative } = require('../scripts/release-audit.cjs');
const base = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(base, name));
test('release audit verifies native source, production DLL, official UE4SS and required licenses without loading them', () => {
  const value = auditNative(read);
  assert.equal(value.protocol, 2);
  assert.equal(value.sha256, require('../src/game-bridge/provenance.json').nativeIO.sha256);
  for (const file of [
    'src/native/UnicodeIo.hpp',
    'src/game-bridge/runtime/unicode/main.dll',
    'src/game-bridge/runtime/dwmapi.dll',
    'src/native/LICENSE.ue4ss',
    'src/third-party/DIM-LICENSE.txt',
  ])
    assert.throws(() =>
      auditNative((name) => (name === file ? Buffer.from('altered synthetic bytes') : read(name))),
    );
});
test('even a repinned native binary must remain Windows x64', () => {
  const dll = read('src/game-bridge/runtime/unicode/main.dll');
  dll.writeUInt16LE(0x14c, dll.readUInt32LE(60) + 4);
  const provenance = JSON.parse(read('src/game-bridge/provenance.json'));
  provenance.nativeIO.sha256 = crypto.createHash('sha256').update(dll).digest('hex');
  assert.throws(
    () =>
      auditNative((name) =>
        name.endsWith('/unicode/main.dll')
          ? dll
          : name.endsWith('/provenance.json')
            ? Buffer.from(JSON.stringify(provenance))
            : read(name),
      ),
    /architecture/,
  );
});
