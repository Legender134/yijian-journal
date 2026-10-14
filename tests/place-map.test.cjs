'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encyclopedia } = require('../src/core/game-data.cjs');
const url = (name) => {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8')
    .replace(/from '(\.\/[^']+)'/g, (_, dependency) => 'from ' + JSON.stringify(url(dependency.slice(2))));
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
};
const loaded = Promise.all([
  import(url('place-map-views.js')),
  import(url('entity-catalog.js')),
  import(url('entity-references.js')),
]);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

test('shipped map has verifiable game provenance and only valid official marker positions', () => {
  const index = encyclopedia(),
    atlas = index.world.mapAtlas;
  assert.equal(atlas.build, index.build);
  assert.equal(atlas.provenance.kind, 'owned-installed-game-static-map');
  assert.match(atlas.provenance.copyright, /不纳入.*MIT/);
  const background = fs.readFileSync(path.join(__dirname, '../src/assets/game', atlas.background));
  assert.equal(
    crypto.createHash('sha256').update(background).digest('hex'),
    atlas.provenance.backgroundSha256,
  );
  assert(atlas.provenance.sourceFiles.some((row) => row.asset.endsWith('/Tables/Maps')));
  assert(atlas.provenance.sourceFiles.some((row) => row.asset.endsWith('/BPCMP_CourierStationLayer')));
  for (const source of atlas.provenance.sourceFiles) {
    assert.match(source.asset, /^\/Game\/JH\//);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
  }
  const keys = new Set(index.world.maps.map((place) => place.key));
  const markers = new Set(atlas.markers.map((point) => point.key));
  assert.equal(markers.size, atlas.markers.length);
  for (const point of atlas.markers) {
    assert(keys.has(point.key), point.name);
    assert(Number.isFinite(point.x) && point.x >= 0 && point.x <= atlas.width, point.name);
    assert(Number.isFinite(point.y) && point.y >= 0 && point.y <= atlas.height, point.name);
    assert.match(point.method, /^official-(label-marker|city-widget|location-widget)$/);
  }
  for (const [key, location] of Object.entries(atlas.locations)) {
    assert(keys.has(key));
    assert(markers.has(location.markerKey));
    assert.equal(typeof location.approximate, 'boolean');
  }
  assert.doesNotMatch(JSON.stringify(atlas), /C:\\\\Users|SaveGames|\.sav|APPDATA/);
});

test('same game scene IDs retain distinct places rather than silently replacing one another', async () => {
  const [, { entityCatalog }] = await loaded;
  const catalog = entityCatalog(encyclopedia());
  assert.deepEqual(
    catalog
      .resolve('place-96')
      .map((place) => place.key)
      .sort(),
    ['LV_64_P2', 'LV_KZ_P2'],
  );
  assert.equal(catalog.resolve('place-96:LV_KZ_P2')[0].name, '山野客栈');
  assert.equal(catalog.resolve('place-96:LV_64_P2')[0].name, '仙人渡');
  assert.equal(catalog.resolve('place-97:LV_KZ_P3')[0].name, '客房');
  assert.equal(catalog.resolve('place-97:LV_64_P3')[0].name, '仙人渡密室');
});

test('regional and full map share real positions, keep cave regions qualified and never fabricate a missing point', async () => {
  const [{ placeMapModel, createPlaceMapViews }] = await loaded;
  const index = encyclopedia(),
    view = createPlaceMapViews({ esc, icon: esc });
  const village = placeMapModel(index, 'place-9');
  assert.equal(village.marker.name, '梧桐村');
  assert(village.marker.x > 1036 && village.marker.x < 1039);
  assert(village.marker.y > 580 && village.marker.y < 583);
  assert(village.nearby.some((point) => point.name === '洛村'));
  const cave = placeMapModel(index, 'place-11');
  assert.equal(cave.location.approximate, true);
  assert.equal(cave.location.areaName, '梧桐村');
  assert.equal(cave.marker.key, village.marker.key);
  const regional = view.render(index, 'place-11');
  assert.match(regional, /梧桐村一带/);
  assert.match(regional, /data-action="place-map-scope" data-id="place-11" data-scope="world"/);
  assert.match(regional, /aria-current="location"/);
  assert.match(regional, /role="group"/);
  assert.doesNotMatch(regional, /style=/);
  const world = placeMapModel(index, 'place-9', { scope: 'world' });
  assert.equal(world.marker.x, village.marker.x);
  assert.equal(world.marker.y, village.marker.y);
  assert.equal(world.points.length, index.world.mapAtlas.markers.length);
  assert.match(view.render(index, 'place-9', { scope: 'world' }), /viewBox="0 0 1920 1080"/);
  const overview = view.render(index, 'place-9', { scope: 'world', allowScopeChange: false });
  assert.doesNotMatch(overview, /data-action="place-map-scope"/);
  assert.match(overview, /data-action="world-place"/);
  const missing = index.world.maps.find((place) => !index.world.mapAtlas.locations[place.key]);
  const unmarked = placeMapModel(index, missing.id);
  assert.equal(unmarked.marker, undefined);
  assert.equal(unmarked.scope, 'world');
  assert.match(view.render(index, missing.id), /此场景没有独立地图标记/);
  assert.doesNotMatch(view.render(index, missing.id), /aria-current="location"/);
  assert.equal(view.render({ ...index, build: 'other-build' }, 'place-9'), '');
});

test('place tooltip embeds the same map without interactive controls or technical provenance', async () => {
  const [, , { createEntityReferences }] = await loaded;
  const index = encyclopedia();
  const refs = createEntityReferences({
    index: () => index,
    esc,
    icon: esc,
    picture: () => '',
    qualityText: { html: (_, label) => label },
  });
  const html = refs.preview('place-9');
  assert.match(html, /place-map-preview/);
  assert.match(html, /data-map-place="LV_25_P"/);
  assert.match(html, /role="img"/);
  assert.doesNotMatch(html, /<button|data-action=|sourceFiles|21798996|SHA|\.sav/);
});

test('faction alias markers and sourced interior regions remain useful without inventing an indoor coordinate', async () => {
  const [{ placeMapModel, createPlaceMapViews }] = await loaded;
  const index = encyclopedia(),
    view = createPlaceMapViews({ esc, icon: esc });
  const faction = placeMapModel(index, 'place-68');
  assert.equal(faction.marker.key, 'LV_GaiBang_P');
  assert.equal(faction.location.approximate, false);
  assert(faction.marker.x > 1040 && faction.marker.x < 1070);
  assert(faction.marker.y > 945 && faction.marker.y < 970);
  for (const [id, region] of [
    ['place-35', '饿虎坡'],
    ['place-1014', '武当派'],
    ['place-1015', '武当派'],
  ]) {
    const model = placeMapModel(index, id);
    assert.equal(model.marker.name, region);
    assert.equal(model.location.approximate, true);
    assert.equal(model.location.basis, 'community-region');
    const source = index.world.mapAtlas.provenance.regionSources.find(
      (row) => row.key === model.selected.key,
    );
    assert.equal(source.url, model.location.sourceUrl);
    assert.equal(source.anchor, model.marker.key);
    assert.match(view.render(index, id), new RegExp(region + '一带'));
  }
});
test('coincident official markers offer both locations instead of one covering the other', async () => {
  const [{ createPlaceMapViews, placeMapModel }, { entityCatalog, placeEntityId }] = await loaded;
  const index = encyclopedia();
  const view = createPlaceMapViews({ esc, icon: esc });
  const island = index.world.mapAtlas.markers.find((point) => point.key === 'LV_ShenLouDao_P');
  const id = `map-point:${island.x}:${island.y}`;
  const html = view.render(index, 'place-606');
  assert.equal((html.match(new RegExp('data-id="' + id + '"', 'g')) || []).length, 1);
  assert.match(html, /data-action="entity-choice"/);
  assert.deepEqual(
    entityCatalog(index)
      .resolve(id)
      .map((row) => row.name),
    ['蜃楼岛', '幻林'],
  );
  assert.equal((html.match(/aria-current="location"/g) || []).length, 1);
  for (const place of index.world.maps) {
    for (const compact of [false, true]) {
      const model = placeMapModel(index, placeEntityId(place, index.world.maps), { compact });
      for (const point of model.points) {
        const group = index.world.mapAtlas.markers.filter(
          (other) => other.x === point.x && other.y === point.y,
        );
        for (const other of group)
          assert(
            model.points.some((visible) => visible.key === other.key),
            `${place.key} must retain the whole ${point.x}:${point.y} group`,
          );
      }
    }
  }
});
