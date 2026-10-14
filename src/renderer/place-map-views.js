import { placeEntityId } from './entity-catalog.js';

// UI marker coordinates come from the shipped official map, never live saves.
export function placeMapModel(index, id, { scope = 'region', compact = false } = {}) {
  const atlas = index?.world?.mapAtlas;
  if (!atlas || String(atlas.build) !== String(index.build)) return null;
  const maps = index.world.maps || [];
  const matches = maps.filter((place) => placeEntityId(place, maps) === id || place.key === id);
  const selected = matches.length === 1 ? matches[0] : null;
  const location = selected && atlas.locations[selected.key];
  const marker = location && atlas.markers.find((row) => row.key === location.markerKey);
  const placed = atlas.markers.flatMap((point) => {
    const place = maps.find((place) => place.key === point.key);
    return place ? [{ ...point, id: placeEntityId(place, maps) }] : [];
  });
  const nearby = marker
    ? placed
        .filter((point) => point.key !== marker.key)
        .sort(
          (a, b) => Math.hypot(a.x - marker.x, a.y - marker.y) - Math.hypot(b.x - marker.x, b.y - marker.y),
        )
        .slice(0, compact ? 4 : 6)
    : [];
  const world = scope === 'world' || !marker;
  const width = world ? atlas.width : compact ? 600 : 660;
  const height = world ? atlas.height : compact ? 390 : 420;
  const left = world ? 0 : Math.max(0, Math.min(marker.x - width / 2, atlas.width - width));
  const top = world ? 0 : Math.max(0, Math.min(marker.y - height / 2, atlas.height - height));
  return {
    atlas,
    selected,
    location,
    marker,
    nearby,
    scope: world ? 'world' : 'region',
    viewport: { left, top, width, height },
    points: world
      ? placed
      : placed.filter(
          (point) =>
            ((point.x === marker?.x && point.y === marker?.y) ||
              nearby.some((near) => near.x === point.x && near.y === point.y)) &&
            point.x >= left &&
            point.x <= left + width &&
            point.y >= top &&
            point.y <= top + height,
        ),
  };
}

export function createPlaceMapViews({ esc, icon }) {
  function render(
    index,
    id,
    { compact = false, interactive = true, scope = 'region', allowScopeChange = true } = {},
  ) {
    const model = placeMapModel(index, id, { scope, compact });
    if (!model || !/^[a-f0-9]{20}\.png$/.test(model.atlas.background)) return '';
    const { atlas, selected, location, marker, nearby, viewport } = model;
    const viewBox = [viewport.left, viewport.top, viewport.width, viewport.height].join(' ');
    const title = selected ? selected.name + '的位置' : '世界地图';
    const pointSize = model.scope === 'world' ? 42 : compact ? 44 : 32;
    const grouped = new Map();
    for (const point of model.points) {
      const key = `${point.x}:${point.y}`;
      const group = grouped.get(key) || [];
      group.push(point);
      grouped.set(key, group);
    }
    const points = [...grouped.entries()]
      .map(([position, group]) => {
        const point = group[0];
        const active = group.some((row) => row.key === marker?.key);
        const multiple = group.length > 1;
        const target = multiple
          ? 'map-point:' + position
          : active && selected
            ? placeEntityId(selected, index.world.maps)
            : point.id;
        const name = multiple
          ? group.map((row) => row.name).join('、')
          : active && selected
            ? selected.name
            : point.name;
        return interactive
          ? `<foreignObject x="${point.x - pointSize / 2}" y="${point.y - pointSize / 2}" width="${pointSize}" height="${pointSize}"><button xmlns="http://www.w3.org/1999/xhtml" type="button" class="place-map-pin${active ? ' is-selected' : ''}" data-action="${multiple ? 'entity-choice' : 'world-place'}" data-id="${esc(target)}" data-entity-id="${esc(target)}" aria-label="${esc('查看' + name)}"${active ? ' aria-current="location"' : ''}><span aria-hidden="true"></span></button></foreignObject>`
          : `<circle class="place-map-dot${active ? ' is-selected' : ''}" cx="${point.x}" cy="${point.y}" r="${active ? 9 : 5}"/>`;
      })
      .join('');
    const label =
      marker && selected
        ? `<text class="place-map-selected-label" x="${Math.max(viewport.left + 100, Math.min(marker.x, viewport.left + viewport.width - 100))}" y="${Math.max(viewport.top + 35, marker.y - pointSize)}" text-anchor="middle">${esc(selected.name)}</text>`
        : '';
    const toggle =
      interactive && marker && allowScopeChange
        ? `<button type="button" class="text-btn" data-action="place-map-scope" data-id="${esc(placeEntityId(selected, index.world.maps))}" data-scope="${model.scope === 'region' ? 'world' : 'region'}">${icon('map')}${model.scope === 'region' ? '完整地图' : '地点近景'}</button>`
        : '';
    const note = marker
      ? location.approximate
        ? `${location.areaName}一带`
        : '大致位置'
      : selected
        ? '此场景没有独立地图标记。'
        : '选择地点查看位置。';
    const neighbors =
      interactive && nearby.length
        ? `<div class="place-map-nearby"><small>附近</small>${nearby.map((point) => `<button type="button" class="text-btn entity-link" data-action="world-place" data-id="${esc(point.id)}" data-entity-id="${esc(point.id)}">${icon('pin')}<span class="entity-link-label">${esc(point.name)}</span></button>`).join('')}</div>`
        : '';
    return `<figure class="place-map${compact ? ' place-map-compact' : ''}${interactive ? '' : ' place-map-preview'}" data-map-place="${esc(selected?.key || '')}" data-map-scope="${model.scope}"><div class="place-map-heading"><figcaption>${esc(note)}</figcaption>${toggle}</div><svg class="place-map-frame" viewBox="${viewBox}" role="${interactive ? 'group' : 'img'}" aria-label="${esc(title)}"><image href="../assets/game/${atlas.background}" x="0" y="0" width="${atlas.width}" height="${atlas.height}"/>${points}${label}</svg>${neighbors}</figure>`;
  }
  return { render };
}
