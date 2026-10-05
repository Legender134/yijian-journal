const fs = require('node:fs');
const path = require('node:path');
// Build-time asset rasterizer, using the pinned sharp development dependency.
const sharp = require(process.env.SHARP_MODULE || 'sharp');
(async () => {
  const base = path.join(__dirname, '..', 'src', 'assets');
  const png = await sharp(path.join(base, 'icon.svg')).png().toBuffer();
  fs.writeFileSync(path.join(base, 'icon.png'), png);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(base, 'icon.ico'), Buffer.concat([header, png]));
  console.log('Icon assets created');
})();
