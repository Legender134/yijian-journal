'use strict';
// Offline development utility: keep memory bounded while reducing UAssetAPI JSON.
const fs = require('node:fs');
const path = require('node:path');
const { value } = require('./inspect-tables.cjs');
async function main() {
  const name = process.argv[2];
  if (!/^[A-Za-z]+$/.test(name)) throw Error('Provide a table name');
  const dir = path.resolve(__dirname, '../.downloads/game-json');
  const input = fs.createReadStream(path.join(dir, `${name}.json`), { encoding: 'utf8' });
  let mode = 'seek',
    prefix = '',
    raw = '',
    depth = 0,
    quoted = false,
    escaped = false,
    count = 0;
  const output = fs.openSync(path.join(dir, `${name}-simple.json`), 'w');
  fs.writeSync(output, '[');
  for await (let chunk of input) {
    if (mode === 'seek') {
      prefix += chunk;
      const marker = /"Table"\s*:\s*\{[\s\S]*?"Data"\s*:\s*\[/.exec(prefix);
      if (!marker) {
        if (prefix.length > 16 * 1024 * 1024) throw Error('Table marker missing');
        continue;
      }
      chunk = prefix.slice(marker.index + marker[0].length);
      prefix = '';
      mode = 'rows';
    }
    let start = depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (!depth) {
        if (c === ']') {
          mode = 'done';
          break;
        }
        if (c !== '{') continue;
        start = i;
        depth = 1;
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (!depth) {
        raw += chunk.slice(start, i + 1);
        start = -1;
        const p = JSON.parse(raw);
        raw = '';
        fs.writeSync(output, (count++ ? ',\n' : '') + JSON.stringify({ id: p.Name, ...value(p) }));
      }
    }
    if (start >= 0 && depth) raw += chunk.slice(start);
    if (mode === 'done') break;
  }
  if (mode !== 'done') throw Error('Truncated table');
  fs.writeSync(output, ']\n');
  fs.closeSync(output);
  console.log(`${name}: ${count} records reduced`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
