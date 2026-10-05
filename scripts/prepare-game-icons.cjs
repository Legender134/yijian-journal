'use strict';
// Build-only references to selected UI textures from locally exported game assets.
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(base, '.downloads/game-json', `${name}-simple.json`), 'utf8'));
const data = require('../src/core/game-data.cjs').encyclopedia();
const resources = new Map(read('NPCResources').map((r) => [r.id, r]));
const objectPath = (r) => {
  const name = r?.AssetPath?.AssetName;
  return typeof name === 'string' && /^\/Game\/[A-Za-z0-9_/]+\.[A-Za-z0-9_]+$/.test(name)
    ? name.split('.')[0]
    : null;
};
const entries = {};
const assets = new Map();
function add(id, reference, kind) {
  const source = objectPath(reference);
  if (!source) return;
  const file = source.replace(/^\/Game\//, 'Wandering_Sword/Content/');
  const raw = path.join(base, '.downloads/game-icons-raw', `${file}.uexp`);
  if (!fs.existsSync(raw)) return;
  const key = require('node:crypto').createHash('sha256').update(source).digest('hex').slice(0, 20);
  entries[id] = key;
  assets.set(key, { key, source, raw, kind });
}
const ids = new Set(data.entries.map((e) => e.id));
for (const r of read('Items')) if (ids.has(`item-${r.Id}`)) add(`item-${r.Id}`, r.Icon, 'item');
for (const r of read('Skills')) if (ids.has(`skill-${r.Id}`)) add(`skill-${r.Id}`, r.Icon, 'skill');
// Retain exact resource references for saved party members and quest NPCs too.
for (const r of read('NPCs')) {
  const resource = resources.get(r.ResourceName);
  for (const field of ['HeadImage', 'TeamImage', 'DlgImage']) {
    if (!objectPath(resource?.[field])) continue;
    add(`npc-${r.Id}`, resource[field], 'person');
    if (entries[`npc-${r.Id}`]) break;
  }
}
for (const e of data.entries.filter((e) => e.kind === '配方')) {
  const result = e.results.find((r) => entries[`item-${r.id}`]);
  if (result) entries[e.id] = entries[`item-${result.id}`];
}
const plan = {
  build: data.build,
  entries,
  assets: [...assets.values()],
  output: path.join(base, 'src/assets/game'),
  base,
};
fs.writeFileSync(path.join(base, '.downloads/game-icon-plan.json'), JSON.stringify(plan, null, 2));
console.log(`Selected ${plan.assets.length} textures for ${Object.keys(entries).length} entry references`);
