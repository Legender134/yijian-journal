'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const { ICON_SIZES, TRAY_SIZES, TRAY_STATES, generate } = require('../scripts/assets.cjs');
const base = path.join(__dirname, '..', 'src', 'assets');

test('Windows ICO contains matching independently rasterized frames at common shell sizes', async () => {
  const ico = fs.readFileSync(path.join(base, 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
  let expectedOffset = 6 + ICON_SIZES.length * 16;
  for (const [index, size] of ICON_SIZES.entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 4), 1);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, expectedOffset, 'ICO frame offsets must be contiguous');
    const png = ico.subarray(offset, offset + length);
    assert.deepEqual(png, fs.readFileSync(path.join(base, `icon-${size}.png`)));
    const info = await sharp(png).metadata();
    assert.equal(info.format, 'png');
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    assert.equal(info.hasAlpha, true);
    expectedOffset += length;
  }
  assert.equal(ico.length, expectedOffset);
  assert.deepEqual(
    fs.readFileSync(path.join(base, 'icon.png')),
    fs.readFileSync(path.join(base, 'icon-256.png')),
  );
});

test('tray states remain distinct in grayscale, with correctly sized transparent margins', async () => {
  for (const size of TRAY_SIZES) {
    const buffers = [];
    const symbols = [];
    for (const state of TRAY_STATES) {
      const file = path.join(base, `tray-${state}-${size}.png`);
      const info = await sharp(file).metadata();
      assert.equal(info.width, size);
      assert.equal(info.height, size);
      const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(data[3], 0, 'outer corner remains transparent');
      buffers.push(await sharp(file).greyscale().raw().toBuffer());
      // Ignore badge colour: the white check, pause and exclamation masks must differ too.
      const symbol = Buffer.from(
        Array.from({ length: size * size }, (_, pixel) =>
          data[pixel * 4] > 230 &&
          data[pixel * 4 + 1] > 230 &&
          data[pixel * 4 + 2] > 230 &&
          data[pixel * 4 + 3] > 200
            ? 1
            : 0,
        ),
      );
      assert.ok(symbol.includes(1), 'a visible white status glyph is present');
      symbols.push(symbol);
    }
    for (let left = 0; left < buffers.length; left++)
      for (let right = left + 1; right < buffers.length; right++) {
        assert.notDeepEqual(buffers[left], buffers[right]);
        assert.notDeepEqual(symbols[left], symbols[right], 'status shape cannot depend on colour alone');
      }
  }
});

test('asset generator is reproducible and does not depend on working-directory paths', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-icons-'));
  try {
    await generate(temporary);
    for (const file of fs.readdirSync(temporary))
      assert.deepEqual(
        fs.readFileSync(path.join(temporary, file)),
        fs.readFileSync(path.join(base, file)),
        file,
      );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
