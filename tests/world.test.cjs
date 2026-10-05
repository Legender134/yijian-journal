'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { encyclopedia } = require('../src/core/game-data.cjs'),
  { Saves, sha } = require('../src/core/saves.cjs'),
  { syntheticSave } = require('./fixtures.cjs');
test('world projection preserves visible quest identities and distinguishes event scenery from interaction targets', () => {
  const index = encyclopedia(),
    world = index.world,
    maps = new Set(world.maps.map((m) => m.key));
  const quests = new Map(world.quests.map((q) => [q.gameId, q]));
  assert.equal(quests.size, 1736);
  assert.equal(world.maps.length, 244);
  assert.equal(new Set(index.entries.map((e) => e.id)).size, index.entries.length);
  assert.ok(world.quests.some((q) => q.placements.some((p) => !p.interactionTarget)));
  for (const q of quests.values()) {
    assert.equal(q.id, `quest-${q.gameId}`);
    assert.equal(q.name, require('../src/data/game-index.json').quests[q.gameId].name);
    for (const p of q.placements) {
      assert.ok(maps.has(p.mapKey));
      assert.equal(
        p.interactionTarget,
        (p.phase === 'request' ? q.requestNPCs : q.finishNPCs).includes(p.npcId),
      );
    }
    const seen = new Set();
    let at = q;
    while (at) {
      assert.ok(!seen.has(at.gameId), 'Quest parent cycle');
      seen.add(at.gameId);
      at = quests.get(at.parentId);
    }
  }
  const wei = index.entries.find((e) => e.id === 'npc-10047');
  assert.deepEqual(
    wei.friendshipLocks.map((l) => l.at),
    [0, 20, 60],
  );
  assert.ok(wei.skills.every((s) => index.entries.some((e) => e.id === s.id)));
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-world-')),
    source = path.join(root, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, money: 100 }));
  return { source, saves: new Saves(path.join(root, 'backups')) };
}
test('details uses fresh content even if size and modification time look unchanged, without writing sources', () => {
  const { source, saves } = fixture(),
    file = path.join(source, '1.sav');
  assert.equal(saves.details(source, '1.sav').metadata.money, 100);
  const before = fs.statSync(file);
  const replacement = syntheticSave({ full: true, money: 103 });
  assert.equal(replacement.length, before.size);
  fs.writeFileSync(file, replacement);
  fs.utimesSync(file, before.atime, before.mtime);
  const bytes = fs.readFileSync(file),
    time = fs.statSync(file, { bigint: true }).mtimeNs;
  assert.equal(saves.details(source, '1.sav').metadata.money, 103);
  assert.equal(sha(fs.readFileSync(file)), sha(bytes));
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, time);
});
test('details refuses a source modified after reading and can retry a stable record', () => {
  const { source, saves } = fixture(),
    file = path.join(source, '1.sav'),
    original = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function (f, ...args) {
    const value = original.call(fs, f, ...args);
    if (f === file && !injected) {
      injected = true;
      fs.writeFileSync(file, syntheticSave({ full: true, money: 777 }));
    }
    return value;
  };
  try {
    assert.throws(() => saves.details(source, '1.sav'), /读取期间发生变化/);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(saves.details(source, '1.sav').metadata.money, 777);
});
