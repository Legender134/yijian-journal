'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../.downloads/game-json');
function value(p) {
  if (p.$type?.includes('TextPropertyData')) return p.CultureInvariantString;
  if (Array.isArray(p.Value)) {
    if (p.$type?.includes('ArrayPropertyData')) return p.Value.map(value);
    return Object.fromEntries(p.Value.map((x) => [x.Name, value(x)]));
  }
  return p.Value;
}
function rows(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  return raw.Exports.find((e) => e.Table).Table.Data.map((p) => ({ id: p.Name, ...value(p) }));
}
if (require.main === module) {
  for (const name of process.argv.slice(2)) {
    const data = rows(name);
    fs.writeFileSync(path.join(dir, `${name}-simple.json`), JSON.stringify(data, null, 2));
    console.log(name, data.length, JSON.stringify(data.slice(0, 2)).slice(0, 10000));
  }
}
module.exports = { rows, value };
