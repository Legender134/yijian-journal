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
test('personal location choices exclude ambiguous legacy IDs and distinguish same-name scenes', async () => {
  const { placeChoices, placeChoiceLabel } = await modulePromise;
  const first = placeChoices(index),
    seen = [];
  for (let page = 1; page <= first.pages; page++) {
    const result = placeChoices(index, { page });
    assert.ok(result.rows.length <= 12);
    assert.equal(result.selected, undefined);
    seen.push(...result.rows.map((place) => place.id));
  }
  const unique = index.world.maps.filter(
    (place) => index.world.maps.filter((row) => row.id === place.id).length === 1,
  );
  assert.deepEqual(new Set(seen), new Set(unique.map((place) => place.id)));
  assert.equal(seen.length, unique.length);
  const duplicates = index.world.maps.filter((place) => place.name === '梧桐村');
  assert.ok(duplicates.length > 1);
  assert.equal(
    new Set(duplicates.map((place) => placeChoiceLabel(place, index.world.maps))).size,
    duplicates.length,
  );
});

test('editing retains an existing ambiguous scene without offering it for new choices', async () => {
  const { placeChoices, createPlacePicker } = await modulePromise;
  const picker = createPlacePicker({ esc: String, act: () => '' });
  for (const selectedId of ['place-96', 'place-97']) {
    const result = placeChoices(index, { selectedId, query: '梧桐村' });
    assert.equal(result.selected.id, selectedId);
    assert.equal(result.pinned.id, selectedId);
    assert.equal(result.selected.key, undefined);
    assert.equal(result.labels.get(selectedId), '原地点（场景待核对）');
    assert.ok(!result.rows.some((place) => place.id === selectedId));
    const html = picker.options(index, { selectedId, query: '梧桐村' });
    assert.ok(html.includes(`<option value="${selectedId}" selected>原地点（场景待核对）`));
    assert.ok(!html.includes('<option value="" selected>'));
    assert.ok(!picker.options(index, { query: '梧桐村' }).includes(`value="${selectedId}"`));
  }
});
test('known place aliases find canonical scenes and multiword searches retain exact selection', async () => {
  const { placeChoices } = await modulePromise;
  assert.ok(placeChoices(index, { query: '武当山' }).rows.some((place) => place.name === '武当派'));
  const same = index.world.maps.filter((place) => place.name === '梧桐村');
  const chosen = same[1];
  assert.equal(placeChoices(index, { query: '梧桐村 ' + chosen.id }).rows[0].id, chosen.id);
  const filtered = placeChoices(index, { selectedId: chosen.id, query: '没有这个地点' });
  assert.equal(filtered.total, 0);
  assert.equal(filtered.pinned.id, chosen.id);
  assert.equal(filtered.selected.id, chosen.id);
  assert.equal(placeChoices(index, { selectedId: 'npc-5011' }).selected, undefined);
});
