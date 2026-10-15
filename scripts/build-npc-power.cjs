'use strict';
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/data/game-index.json');
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const proof = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (
  String(raw.buildId) !== String(game.build) ||
  raw.weights.length !== 7 ||
  raw.title.thresholds.length !== 11
)
  throw Error('power contract mismatch');
const output = {
  schema: 1,
  build: game.build,
  weights: raw.weights.map((w, i) => {
    if (w.order !== i || !Number.isFinite(w.coefficient) || !Number.isInteger(w.enumId))
      throw Error('weight');
    return { id: w.enumId, value: w.coefficient };
  }),
  titles: raw.title.thresholds.map((t, i) => {
    if (t.level !== i || !Number.isFinite(t.minimumFightingCapacity) || typeof t.title !== 'string')
      throw Error('title');
    return { minimum: t.minimumFightingCapacity, name: t.title };
  }),
  source: proof,
  scope:
    'Build 21798996 original configuration; TeamInfo CurrentValue, ASC=null, bBeforeCreate=false. Gift target minus player title >=2 blocks this BP_Gift_Base gate.',
  copyright: raw.copyright,
};
fs.writeFileSync(path.join(__dirname, '../src/data/npc-power.json'), JSON.stringify(output, null, 2) + '\n');
