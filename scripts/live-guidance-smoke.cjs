'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(base, '.test-data', 'live-guidance-'));
const data = path.join(output, 'state');
const source = path.join(data, '76561190000000000', 'SaveGames');
fs.mkdirSync(source, { recursive: true });
const saveFile = path.join(source, '1.sav');
const writeSave = (quests) => {
  const bytes = syntheticSave({ full: true, map: 'LV_25_P', quests, trackingQuest: 0, trackingMainQuest: 0 });
  fs.writeFileSync(saveFile, bytes);
  fs.utimesSync(saveFile, new Date('2020-01-01'), new Date('2020-01-01'));
  return bytes;
};
const original = writeSave([{ id: 5020, step: 1 }]);
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
const revision = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(base, 'src/game-bridge/main.lua')))
  .digest('hex');
const env = { ...process.env, YIJIAN_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const packet = (extra = {}) => ({
  schema: 1,
  sequence: 1,
  questId: 11004,
  npcId: 10038,
  options: [
    { index: 1, text: '买把新的比较好' },
    { index: 2, text: '重新锻造一番吧' },
  ],
  ...extra,
});
const errors = [];
let app,
  timer,
  current = null,
  token;
const pulse = () =>
  fs.writeFileSync(
    path.join(data, 'game-bridge/state.json'),
    JSON.stringify({
      protocol: 2,
      revision,
      token,
      source,
      at: Math.floor(Date.now() / 1000),
      ready: false,
      reason: '菜单或对话中暂停保存',
      session: '1800000000-123456',
      dialogue: current,
    }),
  );
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    const win = await app.firstWindow();
    win.on('pageerror', (error) => errors.push(error.message));
    await win.locator('.layout').waitFor();
    token = fs.readFileSync(path.join(data, 'game-bridge/token.txt'), 'utf8');
    timer = setInterval(pulse, 250);
    const choice = '[data-flow-decision="early-woodcutter-axe-choice"]';
    assert.equal(await win.locator(choice).count(), 0, 'the saved reference has not reached the choice');
    await win.locator('.sidebar-nav [data-id="duels"]').click();
    await win.locator('.duel-all > summary').click();
    const mainScroll = await win.locator('.content').evaluate((el) => {
      el.scrollTop = 650;
      return el.scrollTop;
    });
    assert(mainScroll > 400, 'the main window starts deep in a real long page');
    current = packet();
    pulse();
    await win.locator(choice).waitFor({ timeout: 5000 });
    assert(await win.locator('.live-choice-dock ' + choice).isVisible());
    assert.equal(await win.locator('.content').evaluate((el) => el.scrollTop), mainScroll);
    const mainBounds = await win.locator(choice).boundingBox();
    assert(
      mainBounds &&
        mainBounds.y >= 0 &&
        mainBounds.y + mainBounds.height <= (await win.evaluate(() => innerHeight)),
    );
    assert.match(await win.locator(choice).innerText(), /樵夫.*重锻/s);
    assert.equal(await win.locator(choice + ' > details').evaluate((el) => el.open), false);
    assert.deepEqual(
      fs.readFileSync(saveFile),
      original,
      'live guidance never saves or chooses for the player',
    );
    const opened = app.waitForEvent('window');
    await win.locator('[data-action="compact"]').first().click();
    const small = await opened;
    small.on('pageerror', (error) => errors.push(error.message));
    await small.locator(choice).waitFor();
    await small.locator('.companion-tabs [data-id="duels"]').click();
    await small.locator(choice).waitFor();
    assert.equal(
      await small.locator(choice).count(),
      1,
      'the current choice remains available on another companion tab',
    );
    await small.screenshot({ path: path.join(output, 'live-choice-brief.png'), animations: 'disabled' });
    await small.locator(choice + ' > details > summary').click();
    assert.match(
      await small.locator(choice + ' .flow-choices').innerText(),
      /买把新的比较好.*重新锻造一番吧/s,
    );
    await small.screenshot({ path: path.join(output, 'live-choice-on-duels.png'), animations: 'disabled' });
    const oldChoice = writeSave([
      { id: 11002, step: 1 },
      { id: 11004, step: 1 },
    ]);
    current = null;
    pulse();
    await small.locator(choice).waitFor({ state: 'detached', timeout: 5000 });
    await win.locator(choice).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(
      await small.evaluate(async () =>
        (await window.journal.companionSnapshot()).data.flow.decisions.some(
          (r) => r.id === 'early-woodcutter-axe-choice',
        ),
      ),
      false,
    );
    await small.locator('.duel-all > summary').click();
    const compactScroll = await small.locator('.compact-body').evaluate((el) => {
      el.scrollTop = 650;
      return el.scrollTop;
    });
    assert(compactScroll > 400, 'the companion starts deep in a real long page');
    current = packet({ sequence: 2 });
    pulse();
    await small.locator(choice).waitFor({ timeout: 5000 });
    assert(await small.locator('.live-choice-dock ' + choice).isVisible());
    assert.equal(await small.locator('.compact-body').evaluate((el) => el.scrollTop), compactScroll);
    const bounds = await small.locator(choice).boundingBox();
    assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= (await small.evaluate(() => innerHeight)));
    // Exercise the real navigation handler for the task page not present in the short tab strip.
    await small.evaluate(() => {
      const link = document.createElement('button');
      link.dataset.action = 'navigate';
      link.dataset.id = 'checklist';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    await small.locator('.flow-legacy').waitFor();
    assert.equal(
      await small.locator(choice).count(),
      1,
      'the full task page does not duplicate its live card',
    );
    current = packet({ sequence: 3, questId: 5076, npcId: 10016 });
    pulse();
    await small.locator(choice).waitFor({ state: 'detached', timeout: 5000 });
    assert.deepEqual(fs.readFileSync(saveFile), oldChoice);
    assert.deepEqual(errors, []);
    console.log(
      'Live guidance PASS: pre-save advice, both windows, other tab, close retirement, reopen and unmatched-dialogue isolation;',
      output,
    );
  } finally {
    clearInterval(timer);
    await app?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
