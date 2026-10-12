'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WindowLayout, validBounds, fitBounds, applyBounds } = require('../src/core/window-layout.cjs');

test('separate main and companion layouts persist, reset independently and recover a previous copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-window-layout-'));
  try {
    const layout = new WindowLayout(dir);
    const main = { x: -1500, y: 200, width: 1200, height: 740 };
    const companion = { x: 120, y: 80, width: 540, height: 610 };
    layout.remember('main', main, true);
    layout.remember('companion', companion);
    layout.save();
    const reopened = new WindowLayout(dir);
    assert.deepEqual(reopened.get('main'), { ...main, maximized: true });
    assert.deepEqual(reopened.get('companion'), companion);
    reopened.reset('companion');
    assert.equal(new WindowLayout(dir).get('companion'), null);
    assert.deepEqual(new WindowLayout(dir).get('main'), { ...main, maximized: true });
    // The previous atomic copy holds both independently adjusted layouts.
    fs.writeFileSync(layout.file, '{ damaged');
    const recovered = new WindowLayout(dir);
    assert.deepEqual(recovered.get('companion'), companion);
    const previous = fs.readFileSync(layout.file + '.previous');
    recovered.remember('main', main, false);
    recovered.save();
    assert.deepEqual(fs.readFileSync(layout.file + '.previous'), previous);
    assert.equal(new WindowLayout(dir).get('main').maximized, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removed displays and changed work areas keep the title bar and resize edges visible', () => {
  for (const area of [
    { x: 0, y: 0, width: 1536, height: 824 },
    { x: -1920, y: -200, width: 1920, height: 1040 },
    { x: 200, y: 40, width: 320, height: 280 },
  ]) {
    for (const rect of [
      { x: -5000, y: -3000, width: 590, height: 700 },
      { x: 9000, y: 4000, width: 3400, height: 1800 },
    ]) {
      const result = fitBounds(rect, area);
      assert(result.x >= area.x && result.y >= area.y);
      assert(result.x + result.width <= area.x + area.width);
      assert(result.y + result.height <= area.y + area.height);
    }
  }
  for (const invalid of [
    null,
    {},
    { x: 0, y: 0, width: Infinity, height: 600 },
    { x: 0, y: 0, width: -1, height: 600 },
    { x: 0.5, y: 0, width: 500, height: 600 },
  ])
    assert.equal(validBounds(invalid), false);
});

test('fractional DPI frame rounding is corrected instead of growing saved sizes on every restore', () => {
  const chosen = { x: 35, y: 35, width: 1025, height: 702 };
  let actual,
    calls = 0;
  const win = {
    setBounds(rect) {
      calls++;
      actual = { ...rect, width: rect.width + 1, height: rect.height + 2 };
    },
    getBounds: () => actual,
  };
  for (let reopen = 0; reopen < 3; reopen++) {
    applyBounds(win, reopen ? actual : chosen);
    assert.deepEqual(actual, chosen);
  }
  assert.equal(calls, 6);
  assert.deepEqual(chosen, { x: 35, y: 35, width: 1025, height: 702 });
});
