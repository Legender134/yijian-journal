'use strict';
// Recover names only; the existence of a table row does not grant use or consultation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let input, output;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--skills-jsonl' && args[i + 1]) input = path.resolve(args[++i]);
  else if (args[i] === '--output' && args[i + 1]) output = path.resolve(args[++i]);
  else throw Error(`Unknown or incomplete option ${args[i]}`);
}
if (!input || !output) throw Error('Specify --skills-jsonl and --output');
const index = JSON.parse(fs.readFileSync(path.join(base, 'src/data/game-index.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(base, 'src/data/item-stats.json'), 'utf8'));
if (index.build !== '21798996' || stats.build !== index.build) throw Error('Unexpected game build');
const bytes = fs.readFileSync(input);
const raw = new Map();
for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
  const fields = JSON.parse(line).fields;
  if (!Number.isSafeInteger(fields?.Id)) throw Error('Invalid skill row ID');
  if (raw.has(fields.Id)) throw Error(`Duplicate skill row ${fields.Id}`);
  raw.set(fields.Id, String(fields.ViewName || '').replace(/<[^>]*>/g, '').trim());
}
const known = new Set(index.entries.map((entry) => entry.id));
const needed = new Set();
for (const entry of index.entries.filter((row) => row.kind === '物品')) {
  for (const action of stats.items[String(entry.gameId)]?.effects || []) {
    if (action.type === 'ASkill' && !known.has(`skill-${action.id}`)) needed.add(action.id);
  }
}
const names = Object.fromEntries([...needed].sort((a, b) => a - b)
  .filter((id) => raw.get(id)).map((id) => [id, raw.get(id)]));
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const result = `// Build ${index.build}; skills JSONL SHA-256 ${hash}. Names are not eligibility.\n` +
  `export const itemSkillNames = Object.freeze(${JSON.stringify(names, null, 2)});\n`;
fs.writeFileSync(output, result, {flag:'wx'});
console.log(`Wrote ${Object.keys(names).length} names; ${needed.size - Object.keys(names).length} target IDs have no source name.`);
