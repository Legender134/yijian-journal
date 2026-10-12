'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./store.cjs');

function validBounds(rect) {
  return (
    !!rect &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(rect[key])) &&
    Math.abs(rect.x) <= 100000 &&
    Math.abs(rect.y) <= 100000 &&
    rect.width >= 1 &&
    rect.width <= 32768 &&
    rect.height >= 1 &&
    rect.height <= 32768
  );
}
function fitBounds(rect, area, minimum = { width: 360, height: 360 }) {
  const width = Math.round(Math.min(area.width, Math.max(minimum.width, rect.width)));
  const height = Math.round(Math.min(area.height, Math.max(minimum.height, rect.height)));
  return {
    x: Math.round(Math.max(area.x, Math.min(rect.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(rect.y, area.y + area.height - height))),
    width,
    height,
  };
}
function applyBounds(win, bounds) {
  let request = { ...bounds };
  // Frameless Windows bounds can gain border pixels at fractional DPI.
  // Correct the observed offset so restoring saved bounds does not grow them.
  for (let attempt = 0; attempt < 3; attempt++) {
    win.setBounds(request);
    const actual = win.getBounds();
    if (Object.keys(bounds).every((key) => actual[key] === bounds[key])) break;
    request = Object.fromEntries(
      Object.keys(bounds).map((key) => [key, request[key] + bounds[key] - actual[key]]),
    );
    if (!validBounds(request)) break;
  }
}
// Native window geometry is local to this computer, separate from game progress.
// Only the main process records it; a damaged layout never blocks the journal.
class WindowLayout {
  constructor(directory) {
    this.file = path.join(directory, 'window-layout.json');
    this.data = {};
    for (const file of [this.file, this.file + '.previous']) {
      try {
        if (fs.statSync(file).size > 4096) continue;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        if (
          Object.entries(data).some(
            ([key, value]) =>
              !['main', 'companion'].includes(key) ||
              !validBounds(value) ||
              (value.maximized !== undefined && typeof value.maximized !== 'boolean'),
          )
        )
          continue;
        this.data = data;
        this.recovered = file !== this.file;
        break;
      } catch {
        /* Layout is optional; keep invalid originals until a new layout is saved. */
      }
    }
  }
  get(kind) {
    return this.data[kind] ? { ...this.data[kind] } : null;
  }
  remember(kind, rect, maximized) {
    if (!['main', 'companion'].includes(kind) || !validBounds(rect)) return;
    this.data[kind] = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, rect[key]]));
    if (kind === 'main') this.data[kind].maximized = maximized === true;
  }
  save() {
    atomicWrite(this.file, this.data, this.recovered);
    this.recovered = false;
  }
  reset(kind) {
    delete this.data[kind];
    this.save();
  }
}
module.exports = { WindowLayout, validBounds, fitBounds, applyBounds };
