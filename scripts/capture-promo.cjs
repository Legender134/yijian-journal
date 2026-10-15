'use strict';
// Record real Electron interaction frames. All progress is synthetic and isolated.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const root = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openCapture(output) {
  output = path.resolve(output);
  if (fs.existsSync(output)) throw Error('Choose a new capture directory');
  const data = path.join(output, 'state');
  const source = path.join(data, '76561190000000000/SaveGames');
  fs.mkdirSync(path.join(output, 'frames'), { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  const attributes = {
    1: 100,
    2: 100,
    3: 50,
    4: 50,
    5: 15,
    44: 100,
    27: 1,
    48: 1,
    61: 1,
    63: 1,
    65: 1,
    67: 1,
  };
  const npc = (id, extra = {}) => ({ id, attributes, map: 'LV_25_P', friendliness: [[0, 70]], ...extra });
  const bytes = syntheticSave({
    full: true,
    map: 'LV_25_P',
    inventory: [
      { id: 10262, count: 0 },
      { id: 10263, count: 1 },
    ],
    quests: [5200, 5201, 11077, 11078].map((id) => ({ id, step: 1 })),
    trackingQuest: 11078,
    trackingMainQuest: 5200,
    npcs: [
      { id: 0, attributes, skills: [{ id: 850, level: 1 }] },
      npc(10016, {
        attributes: { ...attributes, 65: 3 },
        skills: [{ id: 100, level: 10 }],
        inventory: [{ id: 100034, count: 1 }],
      }),
      npc(10047, { inventory: [{ id: 100073, count: 1 }] }),
      npc(10038),
    ],
  });
  const saveFile = path.join(source, '1.sav');
  fs.writeFileSync(saveFile, bytes);
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false, checkUpdatesOnStart: false } });
  fs.writeFileSync(
    path.join(data, 'window-layout.json'),
    JSON.stringify({ companion: { x: 800, y: 70, width: 620, height: 940 } }),
  );
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--force-device-scale-factor=2'],
    cwd: root,
    env,
  });
  const errors = [];
  app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const main = await app.firstWindow();
  await main.locator('.layout').waitFor();
  const opening = app.waitForEvent('window');
  await main.locator('[data-action="compact"]').first().click();
  const page = await opening;
  page.setDefaultTimeout(8000);
  await page.locator('.compact-shell').waitFor();
  const native = await app.browserWindow(page);
  await native.evaluate((win) => {
    win.setBounds({ x: 800, y: 70, width: 620, height: 940 });
    win.webContents.setZoomFactor(1);
  });
  await native.dispose();
  await page.locator('[data-flow-now]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const mainNative = await app.browserWindow(main);
  await mainNative.evaluate((win) => win.minimize());
  await mainNative.dispose();
  const cdp = await app.context().newCDPSession(page);
  let started = 0,
    cursor = { x: 570, y: 870 },
    capturing = false;
  const frames = [],
    events = [],
    markers = [];
  const now = () => (Date.now() - started) / 1000;
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    deviceScaleFactor: devicePixelRatio,
  }));
  const persist = (complete = false) => {
    const result = {
      version: require('../package.json').version,
      ...viewport,
      duration: now(),
      complete,
      frames,
      events,
      markers,
      errors,
      context:
        'Actual Electron input and recorded frames; isolated synthetic progress; no real game or personal saves.',
    };
    fs.writeFileSync(path.join(output, 'capture.json'), JSON.stringify(result, null, 2) + '\n');
  };
  cdp.on('Page.screencastFrame', async ({ data: jpeg, metadata, sessionId }) => {
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!capturing) return;
    const name = `frames/${String(frames.length).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(output, name), Buffer.from(jpeg, 'base64'));
    frames.push({ time: now(), file: name, width: metadata.deviceWidth, height: metadata.deviceHeight });
  });
  const session = {
    app,
    page,
    main,
    output,
    errors,
    frames,
    events,
    markers,
    async start() {
      started = Date.now();
      capturing = true;
      events.push({ time: 0, kind: 'move', ...cursor });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 97,
        maxWidth: 1240,
        maxHeight: 1880,
        everyNthFrame: 1,
      });
      await wait(300);
    },
    mark(name) {
      const row = { name, time: now() };
      markers.push(row);
      persist();
      return row;
    },
    async hold(seconds) {
      await wait(seconds * 1000);
    },
    async move(x, y, seconds = 0.65) {
      const from = { ...cursor },
        steps = Math.max(1, Math.round(seconds * 40));
      for (let i = 1; i <= steps; i++) {
        const u = i / steps,
          eased = u * u * (3 - 2 * u);
        cursor = { x: from.x + (x - from.x) * eased, y: from.y + (y - from.y) * eased };
        await page.mouse.move(cursor.x, cursor.y);
        if (capturing) events.push({ time: now(), kind: 'move', ...cursor });
        await wait((seconds * 1000) / steps);
      }
    },
    async point(selector, seconds = 0.65) {
      const element = page.locator(selector).first();
      const box = await element.boundingBox();
      if (!box || box.y < 0 || box.y + box.height > 940)
        throw Error('Target outside recorded view: ' + selector);
      await session.move(box.x + box.width / 2, box.y + box.height / 2, seconds);
      return box;
    },
    async click(selector, pause = 0.25) {
      const box = await session.point(selector);
      await wait(pause * 1000);
      events.push({ time: now(), kind: 'click', ...cursor, selector, box });
      await page.mouse.click(cursor.x, cursor.y);
      persist();
    },
    async expand(selector) {
      if (
        !(await page
          .locator(selector)
          .first()
          .evaluate((el) => el.open))
      )
        await session.click(selector + ' > summary');
    },
    async type(selector, text) {
      await session.click(selector, 0.1);
      await page.keyboard.press('Control+A');
      for (const character of text) {
        await page.keyboard.insertText(character);
        await wait(90);
      }
      events.push({ time: now(), kind: 'typed', selector, text });
      persist();
    },
    async scroll(pixels, seconds = 1) {
      for (let i = 0; i < 24; i++) {
        await page.mouse.wheel(0, pixels / 24);
        await wait((seconds * 1000) / 24);
      }
    },
    async finish() {
      await wait(200);
      capturing = false;
      await cdp.send('Page.stopScreencast');
      const duration = now();
      assert(frames.length > 0, 'No actual frames recorded');
      assert.deepEqual(errors, []);
      assert.deepEqual(fs.readFileSync(saveFile), bytes, 'Synthetic source save changed');
      persist(true);
      await cdp.detach();
      await app.close();
      return { output, duration, frames: frames.length, events: events.length, markers };
    },
    async close() {
      await app.close();
    },
  };
  return session;
}

async function recordPart(session, part) {
  const { page } = session;
  session.mark(part + '-in');
  if (part === 'flow') {
    await session.hold(0.8);
    await session.click('.flow-risk-window > summary');
    await session.hold(3.2);
    await session.move(600, 900, 0.5);
  } else if (part === 'material') {
    await session.click('.flow-risk-window > summary');
    await session.point('[data-entity-id="item-10262"]', 0.65);
    await page.locator('#entity-preview').waitFor({ state: 'visible' });
    await session.hold(1.5);
    session.mark('material-hover');
    await session.click('[data-entity-id="item-10262"]', 0.1);
    await page.locator('#overlay .drawer').waitFor();
    await session.move(600, 900, 0.6);
    await session.hold(1.4);
  } else if (part === 'map') {
    const link = '#overlay .drawer [data-action="world-place"][data-id="place-22"]';
    await session.point(link, 0.65);
    await page.locator('#entity-preview .place-map').waitFor({ state: 'visible' });
    await session.hold(1.3);
    session.mark('map-preview');
    await session.click(link, 0.1);
    await page.locator('.drawer .place-map-frame').waitFor();
    await session.move(600, 900, 0.55);
    await session.hold(1.5);
    session.mark('map-local');
    await session.click('.drawer [data-action="place-map-scope"]');
    await session.move(600, 900, 0.4);
    await session.hold(1.8);
  } else if (part === 'duels') {
    await session.click('#overlay [data-action="close-overlay"]');
    await session.click('.companion-tabs [data-id="duels"]');
    await page.locator('[data-npc-progress-card="10016"]').waitFor();
    await session.hold(0.8);
    await session.expand('[data-npc-progress-card="10016"]');
    await session.expand('[data-persist-detail="npc-private-10016"]');
    await session.move(600, 900, 0.5);
    await session.hold(1.8);
  } else if (part === 'learning') {
    await session.click('[data-action="npc-progress-tab"][data-id="learning"]');
    await session.hold(0.8);
    await session.expand('[data-npc-progress-card="10016"]');
    await session.expand('[data-persist-detail="npc-learning-10016"]');
    await session.move(600, 900, 0.5);
    await session.hold(2);
    const person = '[data-npc-progress-card="10016"] [data-action="database-detail"][data-id="npc-10016"]';
    await session.point(person, 0.65);
    await page.locator('#entity-preview').waitFor({ state: 'visible' });
    await session.hold(1.2);
    session.mark('person-preview');
    await session.click(person, 0.1);
    await page.locator('#overlay .drawer').waitFor();
    await session.move(570, 720, 0.55);
    await session.hold(0.8);
    await session.scroll(310, 1.4);
    await session.hold(1.5);
  } else if (part === 'saves') {
    await session.click('#overlay [data-action="close-overlay"]');
    await session.click('.companion-tabs [data-id="saves"]');
    await session.expand('[data-persist-detail="compact-backups"]');
    await session.hold(0.5);
    await session.click('[data-action="backup"]');
    await page.locator('#backup-label').waitFor();
    await session.type('#backup-label', '拜师前 · 留一份退路');
    await session.hold(0.4);
    await session.click('[data-action="backup-confirm"]');
    await page.getByText('已备份并校验 1 个文件', { exact: true }).waitFor();
    await session.move(600, 900, 0.5);
    await session.hold(2);
    assert.match(
      await page.locator('[data-persist-detail="compact-backups"]').innerText(),
      /拜师前 · 留一份退路/,
    );
  } else if (part === 'tuck') {
    await session.click('[data-action="companion-tuck"]');
    await page.locator('[data-action="companion-untuck"]').waitFor({ state: 'visible' });
    await session.hold(1);
  } else throw Error('Unknown recording part');
  session.mark(part + '-out');
}

const PARTS = ['flow', 'material', 'map', 'duels', 'learning', 'saves', 'tuck'];
async function recordStory(output) {
  const session = await openCapture(output);
  try {
    await session.start();
    for (const part of PARTS) await recordPart(session, part);
    return await session.finish();
  } catch (error) {
    session.mark('interrupted');
    await session.close();
    throw error;
  }
}
module.exports = { openCapture, recordPart, recordStory, PARTS };
if (require.main === module)
  recordStory(process.argv[2] || path.join(root, '.test-data/promo-capture-' + Date.now()))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
