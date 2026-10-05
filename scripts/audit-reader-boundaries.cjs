'use strict';
// Deterministic malformed-input audit. Synthetic buffers only; no game files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const { readMetadata, readInventory, readQuestSpecs } = require('../src/core/save-reader.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');

if (isMainThread) {
  const started = new Date().toISOString();
  const worker = new Worker(__filename, { resourceLimits: { maxOldGenerationSizeMb: 256 } });
  const timer = setTimeout(() => {
    worker.terminate();
    console.error('Malformed-input audit exceeded its 45-second budget');
    process.exitCode = 1;
  }, 45000);
  worker.on('message', (result) => {
    clearTimeout(timer);
    fs.writeFileSync(
      path.join(__dirname, '../test-results/reader-boundaries.json'),
      JSON.stringify({ startedAt: started, finishedAt: new Date().toISOString(), ...result }, null, 2),
    );
    console.log(`Reader boundary audit PASS: ${result.cases} inputs; no throws or input mutations`);
  });
  worker.on('error', (error) => {
    clearTimeout(timer);
    console.error(error);
    process.exitCode = 1;
  });
} else {
  let seed = 0x51a7cafe,
    cases = 0,
    accepted = 0,
    slowestMs = 0;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const base = syntheticSave({
    full: true,
    inventory: [{ id: 40001, count: 123 }],
    quests: [{ id: 5200, step: 1 }],
  });
  const raw = zlib.inflateSync(base.subarray(12));
  function check(bytes) {
    const before = Buffer.from(bytes),
      start = performance.now();
    for (const details of [false, true]) {
      const value = readMetadata(bytes, { details });
      if (value !== null) {
        accepted++;
        assert.equal(typeof value, 'object');
        assert.ok(Number.isSafeInteger(value.playSeconds) && value.playSeconds >= 0);
        assert.ok(value.playSeconds < 100000000);
        if (value.teamIds) assert.ok(value.teamIds.length <= 128);
        if (value.quests) assert.ok(value.quests.length <= 20000);
        if (value.inventory) assert.ok(value.inventory.length <= 10000);
        if (value.thumbnail) assert.ok(value.thumbnail.length < 1400000);
        assert.doesNotThrow(() => JSON.stringify(value));
      }
    }
    assert.deepEqual(bytes, before, 'Reader changed its input buffer');
    slowestMs = Math.max(slowestMs, performance.now() - start);
    cases++;
  }
  check(base);
  check(raw);
  for (const specimen of [base, raw])
    for (let end = 0; end < specimen.length; end++) check(specimen.subarray(0, end));
  for (let i = 0; i < 6000; i++) {
    const bytes = Buffer.from(i % 4 ? raw : base);
    const count = 1 + (random() % 8);
    for (let j = 0; j < count; j++) bytes[random() % bytes.length] = random() & 255;
    check(bytes);
  }
  for (let i = 0; i < 400; i++) {
    const bytes = Buffer.alloc(random() % 4096);
    for (let j = 0; j < bytes.length; j++) bytes[j] = random() & 255;
    check(bytes);
    for (const start of [-1, 0, bytes.length, NaN, Infinity]) {
      assert.doesNotThrow(() => readInventory(bytes, start));
      assert.doesNotThrow(() => readQuestSpecs(bytes, start, bytes.length));
    }
  }
  const bomb = zlib.deflateSync(Buffer.alloc(65 * 1024 * 1024));
  const header = Buffer.alloc(12);
  header.writeUInt32LE(14);
  header.writeUInt32LE(64 * 1024 * 1024, 4);
  header.writeUInt32LE(bomb.length, 8);
  const oversizedOutput = Buffer.concat([header, bomb]);
  assert.equal(readMetadata(oversizedOutput, { details: true }), null);
  check(oversizedOutput);
  const oversizedInput = Buffer.alloc(32 * 1024 * 1024 + 1);
  assert.equal(readMetadata(oversizedInput), null);
  check(oversizedInput);
  parentPort.postMessage({
    passed: true,
    cases,
    acceptedMetadataResults: accepted,
    slowestMs: Math.round(slowestMs),
    seed: '0x51a7cafe',
  });
}
