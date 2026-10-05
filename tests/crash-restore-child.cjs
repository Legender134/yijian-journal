'use strict';
// Intentionally exits a disposable child process after a target rename.
// The caller supplies only a synthetic fixture directory.
const { Saves } = require('../src/core/saves.cjs');
const [backupRoot, source, id, stopAt] = process.argv.slice(2);
const saves = new Saves(backupRoot),
  replace = saves._replaceFile.bind(saves);
saves._replaceFile = (root, name, bytes, hash, modifiedAt) => {
  replace(root, name, bytes, hash, modifiedAt);
  if (name === stopAt) process.exit(71);
};
saves.restore(id, source);
process.exit(72);
