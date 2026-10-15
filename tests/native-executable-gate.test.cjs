'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const provenance = require('../src/game-bridge/provenance.json');
const base = path.resolve(__dirname, '..');

test('native producer source and distributed DLL pin the same EXE as installation compatibility', () => {
  const source = fs.readFileSync(path.join(base, 'src/native/UnicodeBridge.cpp'), 'utf8');
  const pin = source.match(/SupportedGameExeSha256="([a-f0-9]{64})"/)?.[1];
  assert.equal(pin, provenance.gameExeSha256, 'Native and installation EXE pins diverged');
  const dll = fs.readFileSync(path.join(base, 'src/game-bridge/runtime/unicode/main.dll'));
  assert.ok(dll.includes(Buffer.from(pin)), 'Distributed native DLL lacks its fixed EXE pin');
  assert.ok(
    dll.includes(Buffer.from('unsupported_game_executable')),
    'Distributed native DLL lacks the gate rejection',
  );
});
