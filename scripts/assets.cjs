'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Build-time only. Runtime loads committed PNG/ICO files without sharp.
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const TRAY_SIZES = [16, 20, 24, 32];
const TRAY_STATES = ['ready', 'pending', 'warning'];
const palette = { ink: '#223c36', paper: '#f2edd8', gold: '#c8b479' };

function svg(size, shapes) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${shapes}</svg>\n`;
}

function iconSvg(size) {
  // Different small-size geometry: never shrink the detailed master.
  if (size <= 24) {
    return svg(
      size,
      `<g transform="scale(${size / 16})"><rect x=".5" y=".5" width="15" height="15" rx="3.5" fill="${palette.ink}"/><path d="M3.5 10V3.5h5L11 6" fill="none" stroke="${palette.gold}" stroke-width="1.1" stroke-linejoin="round"/><path d="m6 10 6-7 1.5-.5-.5 2-6 7Z" fill="${palette.paper}"/><path d="m4.5 9.5 3 3M5.8 11.2 3.5 13.5" stroke="${palette.gold}" stroke-width="1.7" stroke-linecap="round"/></g>`,
    );
  }
  if (size <= 48) {
    return svg(
      size,
      `<g transform="scale(${size / 32})"><rect x="1" y="1" width="30" height="30" rx="7" fill="${palette.ink}"/><path d="M7 22V7h10l5 5v2M17 7v5h5" fill="none" stroke="${palette.gold}" stroke-width="1.5" stroke-linejoin="round"/><path d="m11 22 13-16 3-1-1 4-13 15Z" fill="${palette.paper}"/><path d="m8 20 6 6M10.8 23.5 6 28" stroke="${palette.gold}" stroke-width="2.8" stroke-linecap="round"/></g>`,
    );
  }
  return svg(
    size,
    `<g transform="scale(${size / 256})"><rect x="8" y="8" width="240" height="240" rx="54" fill="${palette.ink}"/><path d="M57 179V57h82l40 40v19M139 57v40h40" fill="none" stroke="${palette.gold}" stroke-width="9" stroke-linejoin="round"/><path d="m88 176 99-119 25-8-8 29-99 119Z" fill="${palette.paper}"/><path d="m65 162 49 44M88 187l-34 34" stroke="${palette.gold}" stroke-width="20" stroke-linecap="round"/></g>`,
  );
}

function traySvg(size, state) {
  if (!TRAY_STATES.includes(state)) throw new Error('Unknown tray state: ' + state);
  const colour = { ready: '#2b865d', pending: '#a97720', warning: '#b83c35' }[state];
  const symbol = {
    ready:
      '<path d="m9.9 12.1 1.3 1.3 2.5-2.7" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
    pending: '<path d="M11 10h1v4h-1ZM13 10h1v4h-1Z" fill="#fff"/>',
    warning:
      '<rect x="11" y="10" width="2" height="2.5" rx=".4" fill="#fff"/><rect x="11" y="13.5" width="2" height="1" rx=".3" fill="#fff"/>',
  }[state];
  return svg(
    size,
    `<g transform="scale(${size / 16})"><rect x=".5" y=".5" width="15" height="15" rx="3.5" fill="${palette.ink}"/><path d="m4 9 5-6 2-.5-.5 2L5 11Z" fill="${palette.paper}"/><path d="m2.8 8.5 3.4 3M4.5 10.3 2.5 13" stroke="${palette.gold}" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="3.7" fill="${colour}" stroke="${palette.paper}" stroke-width=".7"/>${symbol}</g>`,
  );
}

function encodeIco(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(({ png }) => png)]);
}

async function generate(base = path.join(__dirname, '..', 'src', 'assets')) {
  fs.mkdirSync(base, { recursive: true });
  const frames = [];
  for (const size of ICON_SIZES) {
    const png = await sharp(Buffer.from(iconSvg(size)))
      .png()
      .toBuffer();
    frames.push({ size, png });
    fs.writeFileSync(path.join(base, `icon-${size}.png`), png);
    if (size === 256) fs.writeFileSync(path.join(base, 'icon.png'), png);
  }
  fs.writeFileSync(path.join(base, 'icon.svg'), iconSvg(256));
  fs.writeFileSync(path.join(base, 'icon.ico'), encodeIco(frames));
  for (const state of TRAY_STATES)
    for (const size of TRAY_SIZES)
      fs.writeFileSync(
        path.join(base, `tray-${state}-${size}.png`),
        await sharp(Buffer.from(traySvg(size, state)))
          .png()
          .toBuffer(),
      );
}

if (require.main === module)
  generate()
    .then(() => console.log('Icon assets created (8 ICO sizes, 3 tray states)'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
module.exports = { ICON_SIZES, TRAY_SIZES, TRAY_STATES, iconSvg, traySvg, encodeIco, generate };
