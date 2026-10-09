'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const index = require('../src/core/game-data.cjs').encyclopedia();
const modulePromise = import(
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(__dirname, '../src/renderer/place-picker.js')).toString('base64')
);
test('all locations remain reachable with bounded choices and explicit identity for same-name scenes', async () => {
  const { placeChoices, placeChoiceLabel } = await modulePromise;
  const first = placeChoices(index),
    seen = [];
  for (let page = 1; page <= first.pages; page++) {
    const result = placeChoices(index, { page });
    assert.ok(result.rows.length <= 12);
    assert.equal(result.selected, undefined);
    seen.push(...result.rows.map((place) => place.id));
  }
  assert.deepEqual(new Set(seen), new Set(index.world.maps.map((place) => place.id)));
  assert.equal(seen.length, index.world.maps.length);
  const duplicates = index.world.maps.filter((place) => place.name === '梧桐村');
  assert.ok(duplicates.length > 1);
  assert.equal(
    new Set(duplicates.map((place) => placeChoiceLabel(place, index.world.maps))).size,
    duplicates.length,
  );
});
test('known place aliases find canonical scenes and multiword searches retain exact selection', async () => {
  const { placeChoices } = await modulePromise;
  assert.ok(placeChoices(index, { query: '武当山' }).rows.some((place) => place.name === '武当派'));
  const same = index.world.maps.filter((place) => place.name === '梧桐村');
  const chosen = same[1];
  assert.equal(placeChoices(index, { query: '梧桐村 ' + chosen.gameId }).rows[0].id, chosen.id);
  const filtered = placeChoices(index, { selectedId: chosen.id, query: '没有这个地点' });
  assert.equal(filtered.total, 0);
  assert.equal(filtered.pinned.id, chosen.id);
  assert.equal(filtered.selected.id, chosen.id);
  assert.equal(placeChoices(index, { selectedId: 'npc-5011' }).selected, undefined);
});
