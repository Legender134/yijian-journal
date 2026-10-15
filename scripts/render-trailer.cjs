'use strict';
// Local deterministic film renderer; no game attachment, personal data, or app changes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2),
  opt = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '--preview') opt.preview = true;
  else if (k.startsWith('--') && i + 1 < argv.length) opt[k.slice(2)] = argv[++i];
  else throw new Error('Unknown argument ' + k);
}
const capture = path.resolve(opt.capture || ''),
  game = path.resolve(opt.game || ''),
  out = path.resolve(opt.out || '');
if (!opt.capture || !opt.game || !opt.out)
  throw new Error(
    'Required: --capture completed-take --game authorized.mp4 --out new-directory [--preview] [--music licensed-audio] [--music-offset seconds]',
  );
if (fs.existsSync(out))
  throw new Error('Output directory exists; preserve earlier renders and choose a new directory.');
const manifest = JSON.parse(fs.readFileSync(path.join(capture, 'capture.json'), 'utf8'));
if (!manifest.complete || manifest.errors.length)
  throw new Error('Capture must be completed and error-free.');
if (!fs.statSync(game).isFile()) throw new Error('Game clip missing.');
const script = JSON.parse(fs.readFileSync(path.join(root, 'docs/trailer-script.json'), 'utf8'));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const routes = new Map(),
  add = (file) => {
    const url = '/asset/' + routes.size;
    routes.set(url, path.resolve(file));
    return url;
  };
const frames = manifest.frames.map((f) => ({ ...f, url: add(path.join(capture, f.file)) }));
const markers = Object.fromEntries(manifest.markers.map((m) => [m.name, m.time]));
const segments = {};
for (const kind of ['now', 'flow', 'map', 'catalog', 'duels', 'learning', 'saves', 'tuck']) {
  const start = markers[kind === 'map' ? 'map-local' : kind === 'catalog' ? 'catalog-values' : kind + '-in'];
  const end = markers[kind === 'learning' ? 'person-preview' : kind + '-out'];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error('Missing capture segment: ' + kind);
  segments[kind] = [start, end];
}
const config = {
  frames,
  segments,
  script,
  game: add(game),
  portrait: add(
    path.join(root, 'src/assets/game', require('../src/data/game-images.json').entries['npc-10016']),
  ),
  equipment: add(
    path.join(root, 'src/assets/game', require('../src/data/game-images.json').entries['item-4014']),
  ),
};
const server = http.createServer((req, res) => {
  const file = routes.get(req.url);
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const size = fs.statSync(file).size;
  let start = 0,
    end = size - 1;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), end) : end;
    if (start > end) {
      res.writeHead(416).end();
      return;
    }
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'Content-Type': file.endsWith('.mp4')
      ? 'video/mp4'
      : file.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
});
async function main() {
  fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.frames.forEach((f) => (f.url = base + f.url));
  config.game = base + config.game;
  config.portrait = base + config.portrait;
  config.equipment = base + config.equipment;
  const browser = await chromium.launch({ headless: true, channel: opt.browser || 'msedge' });
  try {
    const page = await browser.newPage({
      viewport: { width: script.width, height: script.height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(
      `<html><body style="margin:0;background:#050e0c"><canvas width="${script.width}" height="${script.height}"></canvas></body></html>`,
    );
    await page.evaluate((data) => (window.FILM = data), config);
    await page.addScriptTag({ path: path.join(root, 'scripts/trailer-scene.js') });
    await page.evaluate(() => document.fonts.ready);
    const times = [
      2.8, 7.8, 14.5, 20, 27, 31, 33.1, 36.5, 42, 47, 50.1, 52.5, 60, 66.5, 70, 71.7, 73.2, 77, 82.6, 87,
      91.5,
    ];
    for (const t of times) {
      await page.evaluate((t) => window.render(t), t);
      await page.screenshot({
        path: path.join(out, `frame-${String(t).replace('.', '_')}.jpg`),
        type: 'jpeg',
        quality: 94,
      });
    }
    if (!opt.preview) {
      const silent = path.join(out, 'picture.mp4');
      const ff = spawn(
        'ffmpeg',
        [
          '-v',
          'error',
          '-n',
          '-f',
          'image2pipe',
          '-vcodec',
          'mjpeg',
          '-r',
          String(script.fps),
          '-i',
          '-',
          '-an',
          '-c:v',
          'libx264',
          '-crf',
          '18',
          '-preset',
          'fast',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          silent,
        ],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let stderr = '';
      ff.stderr.on('data', (d) => (stderr += d));
      const closed = once(ff, 'close');
      ff.on('error', (e) => errors.push(e.message));
      for (let i = 0; i < script.duration * script.fps; i++) {
        await page.evaluate((t) => window.render(t), i / script.fps);
        const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
        if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
        if (i % 150 === 0)
          process.stdout.write(`Rendered ${(i / script.fps).toFixed(0)} / ${script.duration}s\n`);
      }
      ff.stdin.end();
      const [code] = await closed;
      if (code) throw new Error('FFmpeg: ' + stderr);
      if (opt.music) {
        const music = path.resolve(opt.music);
        if (!fs.statSync(music).isFile()) throw new Error('Music missing');
        const result = spawnSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-n',
            '-i',
            silent,
            '-ss',
            opt['music-offset'] || '0',
            '-i',
            music,
            '-map',
            '0:v',
            '-map',
            '1:a',
            '-t',
            String(script.duration),
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '256k',
            '-ar',
            '48000',
            '-af',
            `afade=t=in:d=1,afade=t=out:st=${script.duration - 3}:d=3,loudnorm=I=-16:TP=-1.5:LRA=11`,
            '-movflags',
            '+faststart',
            path.join(out, 'trailer.mp4'),
          ],
          { windowsHide: true, encoding: 'utf8' },
        );
        if (result.status) throw new Error(result.stderr);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    fs.writeFileSync(
      path.join(out, 'render.json'),
      JSON.stringify(
        {
          complete: true,
          scriptSha256: sha(path.join(root, 'docs/trailer-script.json')),
          sceneSha256: sha(path.join(root, 'scripts/trailer-scene.js')),
          captureSha256: sha(path.join(capture, 'capture.json')),
          gameSha256: sha(game),
          music: opt.music
            ? { sha256: sha(path.resolve(opt.music)), offset: Number(opt['music-offset'] || 0) }
            : null,
          preview: !!opt.preview,
          ...script,
          errors,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((e) => {
  console.error(e);
  server.close();
  process.exitCode = 1;
});
