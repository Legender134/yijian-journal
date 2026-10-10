'use strict';
// Independent synthetic user-flow regression. YIJIAN_TEST_DATA blocks all native game commands.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { Activity } = require('../src/core/activity.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const gameIndex = require('../src/core/game-data.cjs').encyclopedia();
const base = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const reportFile = path.join(
  base,
  'test-results',
  `review-regressions-${version}${process.env.YIJIAN_REVIEW_REPORT_SUFFIX || ''}.json`,
);
const report = {
  version,
  executable: process.env.YIJIAN_EXECUTABLE || 'development Electron',
  startedAt: new Date().toISOString(),
  cases: [],
  errors: [],
  externalRequests: [],
};
const makeData = (name) => {
  const dir = fs.mkdtempSync(path.join(base, '.test-data', `review-${name}-`));
  report[name + 'Data'] = dir;
  return dir;
};
const save = (inventoryCount, questStep = 1, seconds = 3661) =>
  syntheticSave({
    full: true,
    seconds,
    money: 10000,
    quests: [{ id: 5200, step: questStep }],
    inventory: [{ id: 10300, count: inventoryCount }],
  });
const journal = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'));
const activity = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'));
const timeline = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'game-timeline', 'timeline.json'), 'utf8'));
const check = (name, facts) => {
  report.cases.push({ name, passed: true, ...facts });
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, inProgress: true }, null, 2));
  console.log('PASS:', name);
};
const launch = async (data, tray = false) => {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  if (tray) env.YIJIAN_TEST_TRAY = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
  });
  const win = await app.firstWindow();
  win.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  win.on('pageerror', (e) => report.errors.push(e.message));
  win.on('request', (r) => {
    if (/^https?:/i.test(r.url())) report.externalRequests.push(r.url());
  });
  await win.locator('.layout').waitFor();
  return { app, win };
};
const nav = (win, id) => win.locator(`.nav-btn[data-id="${id}"]`).click();
const close = async (win) => {
  await win.keyboard.press('Escape');
  await win.locator('.drawer').waitFor({ state: 'detached' });
};
const select = async (win, id, value) => {
  await win.locator(id).selectOption(value);
  assert.equal(await win.locator(id).inputValue(), value);
};
const stateSummary = (win) =>
  win.evaluate(async () => {
    const r = await window.journal.refresh();
    return { timeline: r.data.timeline, settings: r.data.health };
  });
let running;

async function importBusyFeedback() {
  const data = makeData('importBusyFeedback'),
    source = path.join(data, 'synthetic-SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '0.sav'), save(2));
  fs.writeFileSync(path.join(source, '29.sav'), Buffer.from('synthetic-foreign-slot-29'));
  fs.writeFileSync(path.join(source, 'unrelated.txt'), Buffer.from('synthetic-unrelated-target'));
  const hash = (file) =>
    require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = Object.fromEntries(
    fs.readdirSync(source).map((name) => [name, hash(path.join(source, name))]),
  );
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  const saves = new Saves(path.join(data, 'save-backups')),
    backup = saves.capture(source, '忙时反馈历史副本');
  const file = path.join(data, 'synthetic-protection.yijian-protection');
  await require('../src/core/migration.cjs').exportProtection({
    dataRoot: data,
    file,
    backupIds: [backup.id],
    includeTimeline: false,
  });
  const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
  const imported = await new ProtectionArchives(data, () => source).import(file);
  running = await launch(data);
  const { app, win } = running;
  try {
    await nav(win, 'saves');
    await win.locator('[data-action="protection-open"]').click();
    await win.locator('[data-action="protection-history"][data-id="' + imported.id + '"]').click();
    await win.locator('[data-action="protection-backup-select"][data-id="' + backup.id + '"]').click();
    await win.evaluate(() => {
      window.importBusyEvents = [];
      window.journal.onEvent((event) => window.importBusyEvents.push(event));
    });
    await app.evaluate(({ app, dialog }, id) => {
      const nodePath = process.mainModule.require('node:path');
      const { ProtectionArchives } = process.mainModule.require(
        nodePath.join(app.getAppPath(), 'src/core/protection-archives.cjs'),
      );
      const original = ProtectionArchives.prototype.history;
      global.importBusyProbe = { pickerCalls: 0, confirmations: [], entered: false };
      ProtectionArchives.prototype.history = async function (archiveId, ...args) {
        if (archiveId === id && !global.importBusyProbe.entered) {
          global.importBusyProbe.entered = true;
          await new Promise((resolve) => {
            global.importBusyProbe.release = resolve;
          });
        }
        return original.call(this, archiveId, ...args);
      };
      dialog.showMessageBox = async (_window, options) => {
        global.importBusyProbe.confirmations.push(options.title);
        return { response: 1 };
      };
      dialog.showOpenDialog = async () => {
        global.importBusyProbe.pickerCalls++;
        return { canceled: true, filePaths: [] };
      };
    }, imported.id);
    await win.locator('[data-action="protection-restore"]').click();
    await win.waitForFunction(() =>
      window.importBusyEvents.some((event) => event.type === 'protection' && event.busy),
    );
    const held = await app.evaluate(() => global.importBusyProbe.entered);
    assert(held, 'history verification must be pending before the second user action');
    await win.locator('[data-action="protection-import"]').click();
    await win.getByText('正在处理保护资料，请等待当前操作完成', { exact: true }).last().waitFor();
    const early = {
      text: await win.locator('body').innerText(),
      files: await app.evaluate(() => global.importBusyProbe.pickerCalls),
    };
    await app.evaluate(() => global.importBusyProbe.release());
    await win.waitForFunction(() =>
      window.importBusyEvents.some((event) => event.type === 'protection' && event.busy === false),
    );
    const late = {
      text: await win.locator('body').innerText(),
      details: await app.evaluate(() => ({
        pickerCalls: global.importBusyProbe.pickerCalls,
        confirmations: global.importBusyProbe.confirmations,
      })),
      events: await win.evaluate(() => window.importBusyEvents),
    };
    report.importBusyFeedback = {
      early,
      late,
      limits:
        'Only archive history verification is deliberately paused to expose the real asynchronous pre-confirmation window. Dialog choices use synthetic paths and are stubbed; actual sandboxed renderer, preload, job barrier, verification and protection-backed restore execute from the selected EXE.',
    };
    const native = await app.browserWindow(win),
      png = await native.evaluate(async (w) => (await w.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(
      path.join(
        base,
        'test-results',
        'import-busy-feedback-' + version + (process.env.YIJIAN_REVIEW_REPORT_SUFFIX || '') + '.png',
      ),
      Buffer.from(png, 'base64'),
    );
    assert.equal(early.files, 0);
    assert.equal(late.details.pickerCalls, 0);
    assert(
      !/重新复制完好的原包|导入未完成/.test(early.text),
      'Busy rejection before selection must not diagnose a damaged package',
    );
    assert(
      !/重新复制完好的原包|导入未完成/.test(late.text),
      'Completed restore must not leave a false package diagnosis',
    );
    assert(late.details.confirmations.includes('将历史备份恢复到本机'));
    assert(late.events.some((event) => event.type === 'operation' && event.result.level === 'success'));
    check(
      'import rejected during history verification opens no file picker and leaves no false package-failure guidance after successful protection-backed restore',
      { events: late.events, pickerCalls: 0 },
    );
    await win.locator('[data-action="protection-import"]').click();
    await win.waitForFunction(
      () =>
        window.importBusyEvents.filter((event) => event.type === 'protection' && event.busy === false)
          .length >= 2,
    );
    assert.equal(await app.evaluate(() => global.importBusyProbe.pickerCalls), 1);
    assert.equal(await win.locator('[aria-label="保护资料导入未完成"]').count(), 0);
    const after = Object.fromEntries(
      fs.readdirSync(source).map((name) => [name, hash(path.join(source, name))]),
    );
    assert.deepEqual(after, before);
    check(
      'retry after the active operation ends opens the picker, cancellation keeps the page and all saves including foreign29 and unrelated files remain byte-identical',
      { files: Object.keys(after), pickerCalls: 1 },
    );
  } finally {
    await app.evaluate(() => global.importBusyProbe?.release?.()).catch(() => {});
    await app.close();
    running = null;
  }
}

async function detailReadability() {
  const data = makeData('detailReadability'),
    source = path.join(data, 'synthetic-SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '0.sav'), save(2));
  fs.writeFileSync(path.join(source, 'JHSaveConfig.sav'), Buffer.from('synthetic-readability-index'));
  fs.writeFileSync(path.join(source, '29.sav'), Buffer.from('synthetic-foreign-slot-29'));
  const sourceHashes = Object.fromEntries(
    fs.readdirSync(source).map((name) => [
      name,
      require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path.join(source, name)))
        .digest('hex'),
    ]),
  );
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  const backup = new Saves(path.join(data, 'save-backups')).capture(source, '阅读核对副本');
  running = await launch(data);
  const { app, win } = running,
    ratios = [];
  report.detailReadability = { ratios, sourceHashes };
  const measure = async (selector, state) => {
    const locator = win.locator(selector).first();
    await locator.scrollIntoViewIfNeeded();
    const colors = await locator.evaluate((el) => {
      const rgb = (value) => value.match(/[\d.]+/g).map(Number),
        style = getComputedStyle(el);
      let background;
      for (let node = el; node; node = node.parentElement) {
        const computed = getComputedStyle(node),
          value = rgb(computed.backgroundColor);
        if (Number(computed.opacity) !== 1 || computed.backgroundImage !== 'none')
          throw Error('Text contrast needs explicit compositing');
        if (value.length === 3 || value[3] === 1) {
          background = value.slice(0, 3);
          break;
        }
        if (value[3] !== 0) throw Error('Text contrast needs explicit compositing');
      }
      if (!background) throw Error('No opaque text background found');
      return {
        text: el.textContent.trim(),
        foreground: rgb(style.color).slice(0, 3),
        background,
        fontSize: parseFloat(style.fontSize),
      };
    });
    const luminance = (color) =>
      color
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
    ratios.push({ state, selector, ...colors, ratio: (values[0] + 0.05) / (values[1] + 0.05) });
  };
  const capture = async (name) => {
    const native = await app.browserWindow(win),
      png = await native.evaluate(async (w) => (await w.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(
      path.join(
        base,
        'test-results',
        name + '-' + version + (process.env.YIJIAN_REVIEW_REPORT_SUFFIX || '') + '.png',
      ),
      Buffer.from(png, 'base64'),
    );
  };
  try {
    await app.context().setOffline(true);
    await win.emulateMedia({ reducedMotion: 'reduce' });
    const native = await app.browserWindow(win);
    await native.evaluate((w) => w.setBounds({ width: 1000, height: 720 }));
    for (const zoom of [1, 1.5]) {
      await app.evaluate(
        ({ BrowserWindow }, factor) =>
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.setZoomFactor(factor)),
        zoom,
      );
      await nav(win, 'library');
      await win
        .locator('[data-action="detail"]')
        .nth(zoom === 1 ? 0 : 1)
        .click();
      await win.locator('.drawer').waitFor();
      for (const selector of ['.drawer-body .intro', '.detail-label', '.spoiler-box p'])
        await measure(selector, zoom + '-index-before-reveal');
      await capture('detail-readability-index-' + zoom);
      await win.locator('[data-action="reveal"]').click();
      await measure('.steps li', zoom + '-index-actionable-step');
      await close(win);
      await nav(win, 'goals');
      const rule = win.locator('.note-paper details');
      if ((await rule.getAttribute('open')) === null) await rule.locator('summary').click();
      await measure('.note-paper .save-note', zoom + '-note-retention-rule');
      await nav(win, 'saves');
      await win.locator('[data-action="backup-preview"][data-id="' + backup.id + '"]').click();
      await win.locator('[data-backup-preview-state="verified"]').waitFor();
      await measure('.comparison-grid span', zoom + '-backup-comparison-label');
      await measure('.backup-file-list small', zoom + '-backup-file-date-size');
      await capture('detail-readability-backup-' + zoom);
      assert(await win.locator('.drawer-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await close(win);
    }
    for (const row of ratios) {
      assert(row.ratio >= 4.5, 'Actionable explanatory text below4.5:1: ' + JSON.stringify(row));
      assert(row.fontSize >= 12, 'Actionable explanatory text is too small: ' + JSON.stringify(row));
    }
    assert.equal(ratios.length, 14);
    check('index hints stage labels spoiler warnings and revealed steps remain readable at100 and150', {
      measurements: ratios.filter((row) => row.state.includes('index')),
    });
    check(
      'note retention guidance and backup comparison/file timestamps remain readable at100 and150 without horizontal overflow',
      { measurements: ratios.filter((row) => !row.state.includes('index')) },
    );
    const current = Object.fromEntries(
      fs.readdirSync(source).map((name) => [
        name,
        require('node:crypto')
          .createHash('sha256')
          .update(fs.readFileSync(path.join(source, name)))
          .digest('hex'),
      ]),
    );
    assert.deepEqual(current, sourceHashes);
    check(
      'reading details and backup metadata leaves every synthetic save and foreign slot29 byte-identical',
      { files: Object.keys(current) },
    );
  } finally {
    await app.close();
    running = null;
  }
}
async function searchReadability() {
  const data = makeData('searchReadability');
  new Store(data, catalog);
  running = await launch(data);
  const { app, win } = running;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  const ratios = [];
  const contrast = async (locator, state) => {
    const colors = await locator.evaluate((el) => {
      const rgb = (value) => value.match(/[\d.]+/g)?.map(Number);
      const style = getComputedStyle(el);
      let background;
      for (let node = el; node; node = node.parentElement) {
        const value = rgb(getComputedStyle(node).backgroundColor);
        if (value?.length === 3 || (value?.length === 4 && value[3] === 1)) {
          background = value.slice(0, 3);
          break;
        }
        if (value?.length === 4 && value[3] !== 0)
          throw Error('Composite background needs explicit measurement');
      }
      if (!background) throw Error('No opaque text background found');
      return {
        foreground: rgb(style.color).slice(0, 3),
        background,
        fontSize: style.fontSize,
        text: el.textContent,
      };
    });
    const luminance = (color) =>
      color
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
    const ratio = (values[0] + 0.05) / (values[1] + 0.05);
    assert(ratio >= 4.5, 'Search explanatory text contrast below4.5:1: ' + ratio);
    ratios.push({ state, ...colors, ratio });
  };
  const search = async (value) => {
    if (!(await win.locator('#global-search').count())) await win.keyboard.press('Control+k');
    await win.locator('#global-search').fill(value);
  };
  const qualityRows = async () => {
    for (const [id, quality] of [
      ['item-1000', '白'],
      ['item-1001', '绿'],
      ['item-1002', '蓝'],
    ]) {
      const row = win.locator('.search-result[data-id="' + id + '"]');
      await row.waitFor();
      assert((await row.locator('small').innerText()).includes(quality + '色品质'));
      const accessible = win.getByRole('button', { name: new RegExp('^纯钢剑 .*' + quality + '色品质$') });
      assert.equal(
        await accessible.count(),
        1,
        'Same-name results must expose their actual quality in the accessible name',
      );
      assert.equal(await accessible.getAttribute('data-id'), id);
      assert.equal(await row.locator('strong .quality-text').getAttribute('data-quality'), quality);
    }
  };
  const contrastStates = async (scale) => {
    const row = win.locator('.search-result[data-id="item-1002"]');
    await win.locator('.search-input').hover();
    await contrast(row.locator('small'), scale + '-normal');
    await row.hover();
    await contrast(row.locator('small'), scale + '-hover');
    await win.locator('.search-input').hover();
    await row.focus();
    await contrast(row.locator('small'), scale + '-keyboard-focus');
    await contrast(win.locator('.search-foot'), scale + '-search-instructions');
  };
  try {
    await app.context().setOffline(true);
    await search('纯钢剑');
    await qualityRows();
    check(
      'offline same-name search results expose exact white green and blue quality in visible metadata and accessible button names',
      { ids: ['item-1000', 'item-1001', 'item-1002'] },
    );
    await contrastStates('100');
    await win.screenshot({
      path: path.join(
        base,
        'test-results',
        'search-readability-100-' + version + (process.env.YIJIAN_REVIEW_REPORT_SUFFIX || '') + '.png',
      ),
      animations: 'disabled',
    });
    await win.locator('.search-result[data-id="item-1002"]').focus();
    await win.keyboard.press('Enter');
    await win.locator('.drawer .tag-row .quality-label').waitFor();
    assert.equal(await win.locator('.drawer .tag-row .quality-label').innerText(), '蓝色品质');
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('#global-search').waitFor();
    assert.equal(await win.locator('#global-search').inputValue(), '纯钢剑');
    assert.equal(await win.evaluate(() => document.activeElement.dataset.id), 'item-1002');
    await search('种类:物品 品质:绿 纯钢剑');
    await win.locator('.search-result[data-id="item-1001"]').waitFor();
    assert.equal(await win.locator('.search-result').count(), 1);
    assert((await win.locator('.search-result small').innerText()).includes('绿色品质'));
    check(
      'keyboard search opens the exact selected quality, returns focus and query, and the existing quality filter retains only its exact item',
      { opened: 'item-1002', filtered: 'item-1001' },
    );
    await search('纯钢剑精良图纸');
    await win.locator('.search-result[data-id="fusion-1000"]').waitFor();
    assert(
      (await win.locator('.search-result[data-id="fusion-1000"] small').innerText()).includes('蓝色品质'),
    );
    await search('纯钢剑图纸');
    await win.locator('.search-result[data-id="fusion-1100"]').waitFor();
    assert(!/色品质/.test(await win.locator('.search-result[data-id="fusion-1100"] small').innerText()));
    await search('种类:人物 卫霍');
    await win.locator('.search-result[data-action="database-detail"]').first().waitFor();
    assert(
      !/色品质/.test(
        await win
          .locator('.search-result[data-action="database-detail"]')
          .first()
          .locator('small')
          .innerText(),
      ),
    );
    check(
      'fixed-quality recipe retains its known quality while mixed-quality recipe and person results do not invent a quality',
      { fixed: 'fusion-1000', mixed: 'fusion-1100' },
    );
    await win.keyboard.press('Escape');
    await win.locator('#global-search').waitFor({ state: 'detached' });
    await nav(win, 'settings');
    await win.locator('#reading-scale').selectOption('150');
    const native = await app.browserWindow(win);
    const geometry = await native.evaluate((window) => {
      window.setBounds({ width: 980, height: 660 });
      return {
        bounds: window.getBounds(),
        content: window.getContentSize(),
        zoom: window.webContents.getZoomFactor(),
      };
    });
    assert.equal(geometry.zoom, 1.5);
    await search('纯钢剑');
    await qualityRows();
    await contrastStates('150-small-window');
    assert.equal(
      await win.locator('#global-results').evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
    check(
      'search metadata and instructions meet normal-text contrast in normal hover and keyboard states at100percent and real150percent small-window reading',
      { ratios, geometry },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function referenceAndPolling() {
  const data = makeData('references');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(10, 1, 3661));
  fs.writeFileSync(path.join(source, '2.sav'), save(2, 4, 4661));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'stage', value: 0 });
  store.mutate({ type: 'goal-add', title: '小窗撤销目标' });
  const goalId = store.get().profiles[0].goals[0].id;
  const otherTitle = '另一目标 <铜锭> & "药材"';
  store.mutate({ type: 'goal-add', title: otherTitle });
  const otherId = store.get().profiles[0].goals.find((g) => g.title === otherTitle).id;
  const untouchedGoal = structuredClone(store.get().profiles[0].goals.find((g) => g.id === goalId));
  running = await launch(data);
  const { app, win } = running;
  try {
    await nav(win, 'goals');
    for (const title of ['小窗撤销目标', otherTitle]) {
      for (const action of ['置顶目标 ', '编辑目标 ', '删除目标 ']) {
        const button = win.getByRole('button', { name: action + title, exact: true });
        assert.equal(await button.count(), 1);
        assert.equal(await button.getAttribute('title'), action + title);
      }
    }
    const edit = win.getByRole('button', { name: '编辑目标 ' + otherTitle, exact: true });
    await edit.focus();
    await win.keyboard.press('Enter');
    assert.equal(await win.locator('#goal-title').inputValue(), otherTitle);
    await close(win);
    await win.getByRole('button', { name: '删除目标 ' + otherTitle, exact: true }).click();
    assert(
      (await win.getByRole('dialog', { name: '从行囊中移除这件事？', exact: true }).innerText()).includes(
        otherTitle,
      ),
    );
    await close(win);
    assert.equal(journal(data).profiles[0].goals.find((g) => g.id === otherId).title, otherTitle);
    await win.getByRole('button', { name: '置顶目标 ' + otherTitle, exact: true }).click();
    await win.getByRole('button', { name: '取消置顶目标 ' + otherTitle, exact: true }).waitFor();
    assert.equal(journal(data).profiles[0].goals.find((g) => g.id === otherId).pinned, true);
    assert.deepEqual(
      journal(data).profiles[0].goals.find((g) => g.id === goalId),
      untouchedGoal,
    );
    await win.getByRole('button', { name: '取消置顶目标 ' + otherTitle, exact: true }).click();
    await nav(win, 'home');
    assert.equal(await win.getByRole('button', { name: '编辑目标 ' + otherTitle, exact: true }).count(), 1);
    check(
      'main goal actions name their exact target, escape user text, and keyboard edit/delete cancellation preserve it',
      { otherTitle, otherId },
    );
    const initial = await stateSummary(win);
    assert.equal(initial.timeline.enabled, false);
    assert.equal(journal(data).settings.autoBackup, true);
    await nav(win, 'world');
    await select(win, '#world-save', '1.sav');
    await win.waitForFunction(() =>
      document.querySelector('.world-reference')?.textContent.includes('已读取 1.sav'),
    );
    await win.locator('#world-search').fill('找山下的孙郎中取药材');
    await win.locator('#world-scope').selectOption('all');
    await win.locator('.world-quest-card[data-id="quest-5054"]').click();
    await win.locator('[data-action="database-detail"][data-id="npc-10001"]').first().click();
    assert.equal(await win.locator('#person-save').inputValue(), '1.sav');
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.world-drawer .save-note').first().innerText(), /对照 1\.sav/);
    await close(win);
    await select(win, '#world-save', '');
    await win.locator('.world-quest-card[data-id="quest-5054"]').click();
    await win.locator('[data-action="database-detail"][data-id="npc-10001"]').first().click();
    assert.equal(await win.locator('#person-save').inputValue(), '');
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.world-drawer .save-note').first().innerText(), /当前仅查资料/);
    check('world fixed slot and reference-free mode survive person detail and back', {
      fixed: '1.sav',
      none: '',
    });
    await close(win);

    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-7000"]').click();
    await select(win, '#recipe-save', '1.sav');
    await win.locator('#recipe-quantity').fill('3');
    await win.locator('#recipe-materials [data-action="database-detail"][data-id="item-10300"]').click();
    await win.locator('.item-sellers summary').click();
    await win.locator('.item-sellers [data-action="database-detail"][data-id="npc-10802"]').click();
    await select(win, '#person-save', '@latest');
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.drawer h1').innerText(), /麻布/);
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    // The reverse direction: latest parent remains latest after a fixed child selection.
    await select(win, '#recipe-save', '@latest');
    await win.locator('#recipe-quantity').fill('4');
    await win.locator('#recipe-materials [data-action="database-detail"][data-id="item-10300"]').click();
    await win.locator('.item-sellers summary').click();
    await win.locator('.item-sellers [data-action="database-detail"][data-id="npc-10802"]').click();
    await select(win, '#person-save', '1.sav');
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '4');
    check('nested recipe item person navigation restores both reference modes and quantity', {
      fixedQuantity: 3,
      latestQuantity: 4,
    });

    // Native and backup automation stay disabled; only an external synthetic file write changes data.
    await select(win, '#recipe-save', '1.sav');
    await win.locator('#recipe-quantity').fill('3');
    await win.locator('.drawer-body').evaluate((e) => {
      e.scrollTop = 180;
    });
    const recipeScroll = await win.locator('.drawer-body').evaluate((e) => e.scrollTop);
    assert.ok(recipeScroll > 0);
    assert.match(await win.locator('#recipe-materials').innerText(), /已有 10/);
    fs.writeFileSync(path.join(source, '1.sav'), save(0, 4, 3662));
    await win.waitForFunction(
      () => document.querySelector('#recipe-materials')?.textContent.includes('已有 0'),
      null,
      { timeout: 16000 },
    );
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.ok((await win.locator('.drawer-body').evaluate((e) => e.scrollTop)) > 0);
    check('recipe open drawer polls changed saved inventory without a synthetic event', {
      beforeOwned: 10,
      afterOwned: 0,
      quantity: 3,
      scrollBefore: recipeScroll,
    });
    await close(win);

    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('余裁缝');
    await win.locator('[data-action="database-detail"][data-id="npc-10802"]').click();
    await select(win, '#person-save', '1.sav');
    await win.locator('.person-gifts').scrollIntoViewIfNeeded();
    const beforeGifts = await win.locator('.person-gifts').innerText();
    assert.match(beforeGifts, /没有记录符合偏好/);
    fs.writeFileSync(path.join(source, '1.sav'), save(6, 1, 3663));
    await win.waitForFunction(
      () => document.querySelector('.person-gifts')?.textContent.includes('麻布'),
      null,
      { timeout: 16000 },
    );
    assert.equal(await win.locator('#person-save').inputValue(), '1.sav');
    check('person open drawer polls changed gifts without a synthetic event', {
      item: '麻布',
      selected: '1.sav',
    });
    await close(win);

    await nav(win, 'world');
    await select(win, '#world-save', '1.sav');
    await win.locator('#world-search').fill('武当求助');
    await win.waitForFunction(() =>
      document.querySelector('.world-quest-card[data-id="quest-5200"]')?.textContent.includes('进行中'),
    );
    await win.locator('.world-quest-card[data-id="quest-5200"]').click();
    await win
      .locator('.world-drawer details')
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    const expanded = await win
      .locator('.world-drawer details')
      .first()
      .evaluate((e) => e.open);
    assert.equal(expanded, true);
    fs.writeFileSync(path.join(source, '1.sav'), save(6, 4, 3664));
    await win.waitForFunction(
      () => document.querySelector('.world-drawer .tag-row')?.textContent.includes('已完成'),
      null,
      { timeout: 16000 },
    );
    assert.equal(
      await win
        .locator('.world-drawer details')
        .first()
        .evaluate((e) => e.open),
      true,
    );
    await close(win);
    assert.equal(await win.locator('#world-save').inputValue(), '1.sav');
    assert.equal(await win.locator('#world-search').inputValue(), '武当求助');
    check('world open drawer polls changed quest status and preserves expansion, query and slot', {
      old: '进行中',
      next: '已完成',
    });

    await nav(win, 'home');
    await win.locator('[data-action="compact"]').first().click();
    const companion = app.windows().find((w) => w !== win) || (await app.waitForEvent('window'));
    await companion.locator('.compact-shell').waitFor();
    for (const title of ['小窗撤销目标', otherTitle])
      assert.equal(
        await companion.getByRole('button', { name: '优先提示 ' + title, exact: true }).count(),
        1,
      );
    const otherPin = companion.getByRole('button', { name: '优先提示 ' + otherTitle, exact: true });
    await otherPin.focus();
    await companion.keyboard.press('Enter');
    await companion.getByRole('button', { name: '取消优先提示 ' + otherTitle, exact: true }).waitFor();
    await win.getByRole('button', { name: '取消置顶目标 ' + otherTitle, exact: true }).waitFor();
    assert.equal(journal(data).profiles[0].goals.find((g) => g.id === otherId).pinned, true);
    await companion.getByRole('button', { name: '取消优先提示 ' + otherTitle, exact: true }).click();
    await companion.getByRole('button', { name: '优先提示 ' + otherTitle, exact: true }).waitFor();
    assert.equal(journal(data).profiles[0].goals.find((g) => g.id === otherId).pinned, false);
    check(
      'companion goal priority names target and state, changes only the selected goal and synchronizes the main view',
      { otherTitle, otherId },
    );
    const goal = companion.locator(`[data-action="goal-toggle"][data-id="${goalId}"]`);
    await goal.click();
    const undo = companion.locator('[data-action="compact-undo"]');
    await undo.waitFor();
    assert.match(await companion.locator('.compact-body').innerText(), /小窗撤销目标/);
    await undo.click();
    await goal.waitFor();
    assert.equal(journal(data).profiles[0].goals.find((g) => g.id === goalId).done, false);
    const reminder = companion.locator('.compact-body .check-row [data-action="check"]').first();
    const reminderId = await reminder.getAttribute('data-id');
    await reminder.click();
    await undo.waitFor();
    await undo.click();
    await companion
      .locator(`.compact-body .check-row [data-action="check"][data-id="${reminderId}"]`)
      .waitFor();
    assert.equal(journal(data).profiles[0].checks[reminderId], undefined);
    check('compact goal and checklist completion expose immediate undo and restore disk state', {
      goalId,
      reminderId,
    });
    await companion.close();
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function firstSaveAppears() {
  const data = makeData('first-save');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'save-slot', value: '', mode: 'latest' });
  running = await launch(data);
  const { app, win } = running;
  try {
    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-7000"]').click();
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.doesNotMatch(await win.locator('#recipe-materials').innerText(), /已有\s+\d+/);
    fs.writeFileSync(path.join(source, '1.sav'), save(7));
    await win.waitForFunction(
      () => document.querySelector('#recipe-materials')?.textContent.includes('已有 7'),
      null,
      { timeout: 16000 },
    );
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    check('latest recipe with no initial save follows first readable file through natural polling', {
      file: '1.sav',
      owned: 7,
    });
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function recipeOutputUnits() {
  const data = makeData('recipe-output-units'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const bytes = syntheticSave({
    full: true,
    money: 300,
    inventory: [
      { id: 10202, count: 5 },
      { id: 10205, count: 5 },
    ],
    fusionRecipes: [9501],
  });
  fs.writeFileSync(path.join(source, '1.sav'), bytes);
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  running = await launch(data);
  const { app, win } = running;
  const capture = async (name) => {
    const window = await app.browserWindow(win);
    const png = await window.evaluate(async (w) => (await w.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(data, name + '.png'), Buffer.from(png, 'base64'));
  };
  try {
    await win.context().setOffline(true);
    const window = await app.browserWindow(win);
    await window.evaluate((w) => w.setBounds({ width: 980, height: 660 }));
    const fits = async (selector) => {
      const node = win.locator(selector).first();
      await node.scrollIntoViewIfNeeded();
      const geometry = await node.evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          body = document.querySelector('.drawer-body');
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
          scroll: body.scrollWidth,
          available: body.clientWidth,
        };
      });
      assert.ok(
        geometry.left >= -0.5 &&
          geometry.right <= geometry.width + 0.5 &&
          geometry.top >= -0.5 &&
          geometry.bottom <= geometry.height + 0.5 &&
          geometry.scroll <= geometry.available + 1,
        selector + ': ' + JSON.stringify(geometry),
      );
    };
    const zoom = async (value) => {
      await win.keyboard.press('Control+0');
      if (value === 150) for (let i = 0; i < 3; i++) await win.keyboard.press('Control+=');
      await win.waitForFunction(
        (expected) => innerWidth < 1000 / (expected / 100) + 2 && innerWidth > 900 / (expected / 100),
        value,
      );
      assert.equal(await window.evaluate((w) => w.webContents.getZoomFactor()), value / 100);
      assert.equal(journal(data).settings.readingScale || 100, value);
    };
    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('铜锭');
    await win.locator('[data-action="database-detail"][data-id="fusion-9501"]').click();
    await select(win, '#recipe-save', '1.sav');
    const output = win
      .locator('.drawer .detail-block')
      .filter({ has: win.getByRole('heading', { name: /产出参考/ }) });
    const counts = () => output.locator('.material-row > span:last-child').allTextContents();
    assert.deepEqual(await counts(), ['× 1', '× 2', '× 3']);
    await win.locator('#recipe-quantity').fill('4');
    await win.waitForFunction(() =>
      document.querySelector('#recipe-materials')?.textContent.includes('200 文'),
    );
    assert.deepEqual(
      await win
        .locator('#recipe-materials .material-row')
        .allTextContents()
        .then((rows) => rows.map((s) => /需 4/.test(s))),
      [true, true, false],
    );
    assert.deepEqual(await counts(), ['× 1', '× 2', '× 3']);
    // Read the actual launched application's detail before depending on any new locator.
    // The same driver must fail an older executable on the missing selected total itself.
    assert.match(
      await win.locator('#recipe-materials').innerText(),
      /制作 4 次的预计总产物[\s\S]*预计产物：[\s\S]*铜锭[\s\S]*绿色 × 4–12/,
      'Selected recipe detail must directly display copper total4-12 before adding a craft-list item',
    );
    const totals = win.locator('#recipe-materials [data-recipe-total-outputs]');
    assert.equal(await totals.locator('[data-recipe-output-id]').count(), 1);
    assert.match(await totals.innerText(), /尚未计入背包/);
    assert.deepEqual(journal(data).profiles[0].craftList || [], []);
    for (const selector of [
      '#recipe-quantity',
      '[data-recipe-total-outputs] h3',
      '[data-recipe-output-id="10217"]',
      '.drawer [data-action="craft-add"]',
    ])
      await fits(selector);
    await capture('random-four-executions');
    check(
      'offline selected copper totals appear before any craft-list add with per-execution values intact',
      { executions: 4, minimum: 4, maximum: 12, craftListEmpty: true, offline: true },
    );
    const quantity = win.locator('#recipe-quantity'),
      originalInput = await quantity.elementHandle();
    for (const raw of ['', '0', '-1', '1.5', '1000']) {
      await quantity.fill(raw);
      assert.equal(await quantity.inputValue(), raw);
      assert.equal(await totals.count(), 0, 'Stale selected total remained for invalid input ' + raw);
      assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
      assert.deepEqual(
        await quantity.evaluate((field) => ({
          valid: field.checkValidity(),
          custom: field.validity.customError,
          focused: document.activeElement === field,
        })),
        { valid: false, custom: true, focused: true },
      );
      await quantity.fill('4');
      assert.match(await totals.innerText(), /绿色 × 4–12/);
      assert.equal(await quantity.evaluate((field) => field.checkValidity()), true);
      assert.equal(await quantity.evaluate((field, original) => field === original, originalInput), true);
    }
    await quantity.fill('');
    await quantity.press('e');
    assert.equal(await quantity.evaluate((field) => field.validity.badInput), true);
    assert.equal(await totals.count(), 0);
    assert.equal(await quantity.evaluate((field) => field.validity.customError), true);
    await quantity.fill('4');
    assert.match(await totals.innerText(), /绿色 × 4–12/);
    check(
      'empty zero negative decimal overflow and browser badInput immediately clear totals, preserve input focus and recover on legal input',
      { invalid: ['', '0', '-1', '1.5', '1000', 'badInput:e'], recovered: 4, inputNodePreserved: true },
    );
    for (const mode of ['@latest', '', '1.sav']) {
      await select(win, '#recipe-save', mode);
      await win.waitForFunction(
        (value) =>
          document.querySelector('#recipe-save')?.value === value &&
          document.querySelector('[data-recipe-total-outputs]')?.textContent.includes('绿色 × 4–12'),
        mode,
      );
      assert.equal(await quantity.inputValue(), '4');
      assert.deepEqual(await counts(), ['× 1', '× 2', '× 3']);
      if (!mode) assert.equal(await win.locator('#recipe-materials .material-owned').count(), 0);
    }
    await totals.locator('[data-action="database-detail"][data-id="item-10217"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await quantity.inputValue(), '4');
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    assert.match(await totals.innerText(), /绿色 × 4–12/);
    await zoom(150);
    assert.equal(await quantity.inputValue(), '4');
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    assert.match(await totals.innerText(), /绿色 × 4–12/);
    for (const selector of [
      '#recipe-quantity',
      '[data-recipe-total-outputs] h3',
      '[data-recipe-output-id="10217"]',
      '.drawer [data-action="craft-add"]',
    ])
      await fits(selector);
    await capture('selected-copper-150');
    check(
      'fixed latest and absent reference, item link-back and real150percent zoom at980x660 preserve selected total and quantity',
      { modes: ['1.sav', '@latest', ''], executions: 4, zoom: 1.5, window: { width: 980, height: 660 } },
    );
    await zoom(100);
    assert.equal(
      await output.getByRole('heading').innerText(),
      '每次产出参考',
      'Recipe detail must explicitly identify per-execution output when execution count is4',
    );
    check(
      'random recipe distinguishes four-execution materials/money from explicitly labelled per-execution outputs',
      { executions: 4, materialCountEach: 4, money: 200, perExecution: [1, 2, 3] },
    );
    await win.locator('.drawer [data-action="craft-add"]').click();
    await win.locator('.drawer [data-action="craft-open"]').click();
    const stage = win.locator('[data-craft-stage="fusion-9501"]');
    await stage.waitFor();
    assert.match(await stage.innerText(), /× 4 次[\s\S]*预计产物：[\s\S]*铜锭[\s\S]*× 4–12/);
    assert.equal(await win.locator('#craft-qty-fusion-9501').inputValue(), '4');
    await capture('random-total-range');
    check(
      'four chosen executions carry into material plan with expected total output4-12, not existing inventory',
      { executions: 4, minimum: 4, maximum: 12 },
    );
    await nav(win, 'database');
    await win.locator('#list-search').fill('长虹剑精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-1002"]').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.equal(await output.getByRole('heading').innerText(), '每次产出参考');
    assert.deepEqual(await counts(), ['× 1']);
    assert.match(
      await win.locator('#recipe-materials').innerText(),
      /制作 3 次的预计总产物[\s\S]*长虹剑[\s\S]*金色 × 3/,
    );
    assert.doesNotMatch(await totals.innerText(), /× 3–3|NaN|Infinity/);
    await capture('fixed-three-executions');
    check('fixed output total is three golden swords for three selected executions', {
      executions: 3,
      total: 3,
    });
    await close(win);
    await win.locator('#list-search').fill('纯钢剑图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-1100"]').click();
    await win.locator('#recipe-quantity').fill('2');
    assert.equal(await totals.locator('[data-recipe-output-id]').count(), 3);
    for (const [id, quality] of [
      [1000, '白'],
      [1001, '绿'],
      [1002, '蓝'],
    ]) {
      const candidate = totals.locator('[data-recipe-output-id="' + id + '"]');
      assert.match(
        await candidate.innerText(),
        new RegExp('可能产物：[\\s\\S]*纯钢剑[\\s\\S]*' + quality + '色 × 0–2'),
      );
      assert.equal(await candidate.locator('[data-id="item-' + id + '"]').count(), 1);
    }
    assert.match(await totals.innerText(), /不会同时得到全部最大数量/);
    assert.doesNotMatch(await totals.innerText(), /NaN|Infinity|概率|%/);
    await zoom(150);
    for (const selector of [
      '#recipe-quantity',
      '[data-recipe-total-outputs] h3',
      '[data-recipe-output-id="1000"]',
      '[data-recipe-output-id="1001"]',
      '[data-recipe-output-id="1002"]',
      '[data-recipe-total-outputs] .save-note',
      '.drawer [data-action="craft-add"]',
    ])
      await fits(selector);
    await capture('quality-candidates-150');
    check(
      'three actual steel-sword quality IDs stay mutually exclusive0-2 candidates and remain reachable at real150percent zoom',
      {
        recipe: 'fusion-1100',
        executions: 2,
        ids: [1000, 1001, 1002],
        minimumEach: 0,
        maximumEach: 2,
        zoom: 1.5,
      },
    );
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), bytes);
    check('fixed-output recipe also labels output per execution and synthetic source save stays unchanged', {
      executions: 3,
      perExecution: 1,
    });
  } catch (error) {
    await capture('failure').catch(() => {});
    throw error;
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function referenceRefreshEdges() {
  const data = makeData('reference-edges');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const sample = (count, questStep, learned, seconds) =>
    syntheticSave({
      full: true,
      seconds,
      money: 10000,
      quests: [{ id: 5424, step: questStep }],
      inventory: [{ id: 10300, count }],
      fusionRecipes: learned ? [7000] : [],
    });
  fs.writeFileSync(path.join(source, '1.sav'), sample(10, 1, false, 3000));
  const person = gameIndex.entries
    .filter((e) => e.kind === '人物')
    .find(
      (e) =>
        gameIndex.entries.filter((x) => x.kind === '物品' && x.giftable && e.hobbyKeys?.includes(x.typeKey))
          .length > 30,
    );
  assert.ok(person);
  const gifts = gameIndex.entries.filter(
    (x) => x.kind === '物品' && x.giftable && person.hobbyKeys.includes(x.typeKey),
  );
  fs.writeFileSync(
    path.join(source, '2.sav'),
    syntheticSave({
      full: true,
      inventory: gifts.slice(0, 36).map((x) => ({ id: x.gameId, count: 10 })),
    }),
  );
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  running = await launch(data);
  const { app, win } = running;
  try {
    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('布锦鞋精良图纸');
    await win.locator('[data-action="database-detail"][data-id="fusion-7000"]').click();
    await select(win, '#recipe-save', '1.sav');
    assert.match(await win.locator('.drawer').innerText(), /还没有此配方/);
    await win.locator('#recipe-quantity').fill('');
    assert.equal(await win.locator('[data-recipe-total-outputs]').count(), 0);
    fs.writeFileSync(path.join(source, '1.sav'), sample(0, 4, true, 3001));
    await win.waitForFunction(
      () => document.querySelector('.drawer')?.textContent.includes('已记录此配方'),
      null,
      { timeout: 16000 },
    );
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '');
    assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
    assert.equal(await win.locator('[data-recipe-total-outputs]').count(), 0);
    assert.equal(await win.locator('#recipe-quantity').evaluate((field) => field.validity.customError), true);
    assert.equal(await win.locator('#recipe-save').inputValue(), '1.sav');
    await win.locator('#recipe-quantity').fill('3');
    await win.waitForFunction(() =>
      document.querySelector('#recipe-materials')?.textContent.includes('已有 0'),
    );
    assert.match(await win.locator('[data-recipe-total-outputs]').innerText(), /制作 3 次/);
    await win.locator('#recipe-quantity').fill('0');
    assert.equal(await win.locator('[data-recipe-total-outputs]').count(), 0);
    fs.writeFileSync(path.join(source, '1.sav'), sample(8, 1, false, 3002));
    await win.waitForFunction(
      () => document.querySelector('.drawer')?.textContent.includes('还没有此配方'),
      null,
      { timeout: 16000 },
    );
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '0');
    assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
    assert.equal(await win.locator('[data-recipe-total-outputs]').count(), 0);
    assert.equal(await win.locator('#recipe-quantity').evaluate((field) => field.validity.customError), true);
    await win.locator('#recipe-quantity').fill('2');
    await win.waitForFunction(() =>
      document.querySelector('#recipe-materials')?.textContent.includes('已有 8'),
    );
    assert.match(await win.locator('[data-recipe-total-outputs]').innerText(), /制作 2 次/);
    check(
      'invalid empty and zero recipe quantities preserve input while external inventory and learned status refresh',
      { quantities: ['', '0'], refreshedOwned: [0, 8] },
    );
    await win.locator('#recipe-quantity').fill('');
    await select(win, '#recipe-save', '@latest');
    await win.waitForFunction(
      () =>
        document.querySelector('#recipe-save')?.value === '@latest' &&
        document.querySelector('#recipe-materials')?.textContent.includes('填写 1 至 999'),
    );
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '');
    assert.match(await win.locator('.recipe-reference').innerText(), /已读取这份存档/);
    await select(win, '#recipe-save', '');
    await win.waitForFunction(
      () =>
        document.querySelector('#recipe-save')?.value === '' &&
        document.querySelector('.recipe-reference')?.textContent.includes('可连接本机存档'),
    );
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '');
    assert.match(await win.locator('#recipe-materials').innerText(), /填写 1 至 999/);
    assert.equal(await win.locator('[data-recipe-total-outputs]').count(), 0);
    assert.equal(await win.locator('#recipe-quantity').evaluate((field) => field.validity.customError), true);
    check(
      'recipe reference changes from fixed slot through latest to reference-free with invalid quantity intact',
      { modes: ['1.sav', '@latest', ''], invalidQuantity: '' },
    );
    await close(win);

    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill(person.name);
    await win.locator(`[data-action="database-detail"][data-id="${person.id}"]`).click();
    await select(win, '#person-save', '2.sav');
    await win.locator('.person-gifts [data-action="gift-page"]').last().click();
    assert.match(await win.locator('.person-gifts').innerText(), /第 2 \/ 2 页/);
    const gift = win.locator('.person-gifts [data-action="database-detail"]').first();
    const giftId = await gift.getAttribute('data-id');
    await gift.click();
    assert.match(await win.locator('.drawer h1').innerText(), /.+/);
    await win.locator('[data-action="drawer-back"]').click();
    assert.match(await win.locator('.person-gifts').innerText(), /第 2 \/ 2 页/);
    assert.equal(await win.locator('#person-save').inputValue(), '2.sav');
    check('gift page two and selected save survive opening item detail and returning', {
      person: person.id,
      item: giftId,
      page: 2,
    });
    await close(win);

    await nav(win, 'world');
    await select(win, '#world-save', '1.sav');
    await win.locator('#world-scope').selectOption('all');
    await win.locator('#world-search').fill('赢得品剑大会');
    await win.locator('.world-quest-card[data-id="quest-5424"]').click();
    const detail = win.locator('.world-drawer details').filter({ hasText: '关联场景线索' });
    await detail.locator('summary').click();
    assert.equal(await detail.evaluate((e) => e.open), true);
    const before = await win.locator('.world-drawer .drawer-body').evaluate((e) => {
      e.scrollTop = Math.min(400, e.scrollHeight - e.clientHeight);
      return { top: e.scrollTop, max: e.scrollHeight - e.clientHeight };
    });
    assert.ok(before.top >= 150, `quest drawer is not deep enough: ${JSON.stringify(before)}`);
    fs.writeFileSync(path.join(source, '1.sav'), sample(9, 4, true, 3003));
    await win.waitForFunction(
      () => document.querySelector('.world-drawer .tag-row')?.textContent.includes('已完成'),
      null,
      { timeout: 16000 },
    );
    const after = await win.locator('.world-drawer .drawer-body').evaluate((e) => e.scrollTop);
    assert.equal(await detail.evaluate((e) => e.open), true);
    assert.ok(Math.abs(after - before.top) <= 1, `deep quest scroll changed from ${before.top} to ${after}`);
    check('quest 5424 external refresh preserves expanded details and exact deep scroll', {
      before: before.top,
      after,
    });
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function fullDraftCapacity() {
  const data = makeData('draft-capacity');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(4));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const record = t.record(save(4), 'auto', Date.now() - 10000);
  const a = new Activity(data);
  for (let i = 0; i < 100; i++) a.draft(`orphan-${i}`, { label: `旧草稿 ${i}`, note: `旧内容 ${i}` });
  assert.equal(Object.keys(activity(data).drafts).length, 100);
  running = await launch(data);
  let { app, win } = running;
  try {
    await nav(win, 'saves');
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    await win.locator('#timeline-note').fill('满额后暂存失败的文字');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    assert.equal(activity(data).drafts[record.id], undefined);
    await win.locator('[data-action="timeline-draft-discard"]').click();
    await close(win);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    assert.equal(activity(data).drafts['orphan-0'].note, '旧内容 0');
    await Promise.all([
      win.waitForEvent('close', { timeout: 12000 }),
      win.locator('[data-action="window-close"]').click(),
    ]);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    check('failed new draft can be explicitly discarded and application exits with all old drafts intact', {
      oldDrafts: 100,
    });
    await app.close().catch(() => {});
    running = await launch(data);
    ({ app, win } = running);
    await nav(win, 'saves');
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    await win.locator('#timeline-note').fill('释放容量后可保存');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    await close(win);
    await win
      .locator('details')
      .filter({ hasText: '尚未正式保存的节点草稿' })
      .first()
      .locator('summary')
      .click();
    await win.locator('[data-action="node-draft-remove"][data-id="orphan-0"]').click();
    await win.locator('[data-action="node-draft-remove"][data-id="orphan-0"]').waitFor({ state: 'detached' });
    assert.equal(activity(data).drafts['orphan-0'], undefined);
    assert.equal(activity(data).drafts[record.id].note, '释放容量后可保存');
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    assert.equal(await win.locator('#timeline-note').inputValue(), '释放容量后可保存');
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.waitForFunction(
      (id) => !document.querySelector('#timeline-note')?.value.includes('暂存失败'),
      record.id,
    );
    assert.equal(timeline(data).records.find((r) => r.id === record.id).note, '释放容量后可保存');
    assert.equal(activity(data).drafts[record.id], undefined);
    check('deleting an orphan frees capacity and flushes pending new draft, then formal save clears it', {
      oldRemoved: 'orphan-0',
      recordId: record.id,
    });
    await close(win);

    const topUp = await win.evaluate(() =>
      window.journal.nodeDraft('orphan-replacement', { label: '补满', note: '仍保留' }),
    );
    assert.equal(topUp.ok, true);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    await win.locator('.latest-reliable [data-action="timeline-preview"]').click();
    await win.locator('#timeline-note').fill('满额仍可正式保存');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.waitForFunction(() => document.querySelector('.drawer h1'));
    assert.equal(timeline(data).records.find((r) => r.id === record.id).note, '满额仍可正式保存');
    assert.equal(activity(data).drafts[record.id], undefined);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    check('formal node save succeeds even when unfinished draft storage is full', { oldDrafts: 100 });
  } finally {
    await app.close().catch(() => {});
    running = null;
  }
}

async function interleavedNodeSave() {
  const data = makeData('interleaved-node');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(3));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const nodeA = t.record(save(3, 1, 3000), 'manual', Date.now() - 30000);
  const nodeB = t.record(save(4, 4, 4000), 'manual', Date.now() - 20000);
  t.updateNode(nodeA.id, { label: '节点 A', note: 'A 原备注' });
  t.updateNode(nodeB.id, { label: '节点 B', note: 'B 原备注' });
  running = await launch(data);
  const { app, win } = running;
  try {
    // Patch only this isolated process's Activity method. The gate resolves solely for A's
    // first draft write; the main IPC handler actually awaits it while the renderer opens B.
    await app.evaluate(({ app }, id) => {
      const requireForApp = process
        .getBuiltinModule('node:module')
        .createRequire(app.getAppPath() + '/package.json');
      const ActivityClass = requireForApp('./src/core/activity.cjs').Activity;
      globalThis.reviewDraftOriginal = ActivityClass.prototype.draft;
      globalThis.reviewDraftClass = ActivityClass;
      globalThis.reviewWaiting = false;
      globalThis.reviewReleased = false;
      globalThis.reviewTargetNote = 'A 新备注';
      ActivityClass.prototype.draft = function (draftId, value) {
        if (draftId === id && value?.note === globalThis.reviewTargetNote && !globalThis.reviewWaiting) {
          globalThis.reviewWaiting = true;
          return new Promise((resolve) => {
            globalThis.reviewRelease = () => {
              globalThis.reviewReleased = true;
              resolve(globalThis.reviewDraftOriginal.call(this, draftId, value));
            };
          });
        }
        return globalThis.reviewDraftOriginal.call(this, draftId, value);
      };
    }, nodeA.id);
    await nav(win, 'saves');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    await win.locator('#timeline-label').fill('A 新名称');
    await win.locator('#timeline-note').fill('A 新备注');
    await app.evaluate(async () => {
      const deadline = Date.now() + 4000;
      while (!globalThis.reviewWaiting && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!globalThis.reviewWaiting) throw Error('A draft did not reach the controlled IPC gate');
    });
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.keyboard.press('Escape');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeB.id}"]`).first().click();
    assert.equal(await win.locator('.drawer h1').innerText(), '节点 B');
    assert.equal(await win.locator('#timeline-note').inputValue(), 'B 原备注');
    assert.equal(await app.evaluate(() => globalThis.reviewReleased), false);
    await app.evaluate(() => globalThis.reviewRelease());
    await win.waitForFunction(
      (id) => document.querySelector('.drawer h1')?.textContent === '节点 B',
      nodeB.id,
    );
    await win.waitForTimeout(250);
    const records = timeline(data).records;
    assert.equal(records.find((r) => r.id === nodeA.id).label, 'A 新名称');
    assert.equal(records.find((r) => r.id === nodeA.id).note, 'A 新备注');
    assert.equal(records.find((r) => r.id === nodeB.id).label, '节点 B');
    assert.equal(records.find((r) => r.id === nodeB.id).note, 'B 原备注');
    assert.equal(await win.locator('.drawer h1').innerText(), '节点 B');
    assert.equal(await win.locator('#timeline-note').inputValue(), 'B 原备注');
    check('delayed A draft IPC does not read B fields or replace B preview after A save resumes', {
      aId: nodeA.id,
      bId: nodeB.id,
      gateReached: true,
      releasedAfterBOpened: true,
    });
    await win.keyboard.press('Escape');
    await app.evaluate(() => {
      globalThis.reviewTargetNote = 'A 第二备注';
      globalThis.reviewWaiting = false;
      globalThis.reviewReleased = false;
      globalThis.reviewRelease = null;
    });
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    await win.locator('#timeline-note').fill('A 第二备注');
    await app.evaluate(async () => {
      const deadline = Date.now() + 4000;
      while (!globalThis.reviewWaiting && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!globalThis.reviewWaiting) throw Error('second A draft did not reach IPC gate');
    });
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.keyboard.press('Escape');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    assert.equal(await win.locator('#timeline-note').isDisabled(), true);
    assert.equal(await win.locator('[data-action="timeline-edit-save"]').first().isDisabled(), true);
    assert.equal(await win.locator('[data-action="timeline-draft-discard"]').isDisabled(), true);
    assert.equal(await win.locator('#timeline-note').inputValue(), 'A 第二备注');
    await app.evaluate(() => globalThis.reviewRelease());
    await win.waitForFunction(
      () => document.querySelector('#timeline-note') && !document.querySelector('#timeline-note').disabled,
    );
    assert.equal(timeline(data).records.find((r) => r.id === nodeA.id).note, 'A 第二备注');
    await win.locator('#timeline-note').fill('A 最终备注');
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.waitForFunction(() => document.querySelector('#timeline-note')?.value === 'A 最终备注');
    assert.equal(timeline(data).records.find((r) => r.id === nodeA.id).note, 'A 最终备注');
    check('reopened same node stays locked during pending save, then unlocks for a durable follow-up edit', {
      aId: nodeA.id,
    });
  } finally {
    await app
      .evaluate(() => {
        if (globalThis.reviewRelease && !globalThis.reviewReleased) globalThis.reviewRelease();
        if (globalThis.reviewDraftClass && globalThis.reviewDraftOriginal)
          globalThis.reviewDraftClass.prototype.draft = globalThis.reviewDraftOriginal;
      })
      .catch(() => {});
    await app.close().catch(() => {});
    running = null;
  }
}

async function inFlightLoadUi() {
  const data = makeData('inflight-load-ui');
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(3));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  new Saves(path.join(data, 'save-backups')).capture(source, '隔离备份预览');
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const nodeA = t.record(save(3, 1, 3000), 'manual', Date.now() - 30000);
  const nodeB = t.record(save(4, 4, 4000), 'manual', Date.now() - 20000);
  t.updateNode(nodeA.id, { label: '等待节点 A' });
  t.updateNode(nodeB.id, { label: '等待节点 B' });
  running = await launch(data);
  const { app, win } = running;
  const waitCalls = (count) =>
    app.evaluate(async (_context, n) => {
      const deadline = Date.now() + 4000;
      while (globalThis.reviewLoadCalls.length < n && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (globalThis.reviewLoadCalls.length < n) throw Error(`expected ${n} controlled load IPC calls`);
    }, count);
  const pulse = async () => {
    const result = await win.evaluate(() => window.journal.health());
    assert.equal(result.ok, true);
    assert.equal(result.data.timeline.ready, true);
    await app.evaluate(({ app }, health) => {
      const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      for (const w of req('electron').BrowserWindow.getAllWindows())
        w.webContents.send('journal:event', { type: 'health', health });
    }, result.data);
  };
  try {
    await app.evaluate(({ app }, expectedData) => {
      if (process.env.YIJIAN_TEST_DATA !== expectedData)
        throw Error('controlled IPC requires isolated test data');
      const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const { ipcMain } = req('electron');
      const GameBridgeClass = req('./src/core/game-bridge.cjs').GameBridge;
      globalThis.reviewBridgeClass = GameBridgeClass;
      globalThis.reviewSummaryOriginal = GameBridgeClass.prototype.summary;
      GameBridgeClass.prototype.summary = function () {
        return {
          ...globalThis.reviewSummaryOriginal.call(this),
          ready: true,
          connected: true,
          busy: false,
          pending: false,
          quiescing: false,
          reason: '隔离测试可读档',
        };
      };
      globalThis.reviewLoadCalls = [];
      ipcMain.removeHandler('journal:timeline-load');
      ipcMain.handle(
        'journal:timeline-load',
        (_event, id) =>
          new Promise((resolve, reject) => {
            globalThis.reviewLoadCalls.push({ id, resolve, reject });
          }),
      );
    }, data);
    await pulse();
    await nav(win, 'saves');
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeA.id}"]`).first().click();
    const loadButton = win.locator('#timeline-load-button');
    await win.waitForFunction(() => document.querySelector('#timeline-load-button')?.disabled === false);
    await loadButton.click();
    await waitCalls(1);
    assert.equal((await app.evaluate(() => globalThis.reviewLoadCalls.map((c) => c.id)))[0], nodeA.id);
    await pulse();
    await win.waitForFunction(() => document.querySelector('#timeline-load-button')?.disabled === true);
    assert.match(await loadButton.innerText(), /确认或读档处理中/);
    assert.match(await win.locator('#timeline-load-readiness').innerText(), /关闭预览不会取消已确认的读档/);
    assert.match(
      await win.locator('.drawer-actions [data-action="close-overlay"]').innerText(),
      /关闭预览（不取消读档）/,
    );
    check('healthy status event cannot reenable an in-flight load; closing label states it does not cancel', {
      nodeId: nodeA.id,
    });

    await win.keyboard.press('Escape');
    await win.locator('.drawer').waitFor({ state: 'detached' });
    await win.locator(`[data-action="timeline-preview"][data-id="${nodeB.id}"]`).first().click();
    assert.equal(await win.locator('.drawer h1').innerText(), '等待节点 B');
    assert.equal(await loadButton.isDisabled(), true);
    assert.match(
      await win.locator('.drawer-actions [data-action="close-overlay"]').innerText(),
      /关闭预览（不取消读档）/,
    );
    await loadButton.evaluate((e) => e.click());
    await win.waitForTimeout(100);
    assert.deepEqual(await app.evaluate(() => globalThis.reviewLoadCalls.map((c) => c.id)), [nodeA.id]);
    check('Escape and reopening another node preserve the global load lock and refuse a second request', {
      first: nodeA.id,
      reopened: nodeB.id,
    });

    await app.evaluate(() => globalThis.reviewLoadCalls[0].resolve({ ok: true, data: { cancelled: true } }));
    await win.waitForFunction(
      () =>
        document.querySelector('.drawer h1')?.textContent === '等待节点 B' &&
        document.querySelector('#timeline-load-button')?.disabled === false,
    );
    assert.match(await loadButton.innerText(), /保护当前进度并读档/);
    assert.match(await win.locator('.drawer-actions [data-action="close-overlay"]').innerText(), /先不读档/);
    check('cancelled load restores B controls without closing B preview', {
      cancelled: nodeA.id,
      visible: nodeB.id,
    });

    await loadButton.click();
    await waitCalls(2);
    assert.equal((await app.evaluate(() => globalThis.reviewLoadCalls.map((c) => c.id)))[1], nodeB.id);
    await app.evaluate(() => globalThis.reviewLoadCalls[1].reject(Error('合成读档失败')));
    await win.locator('.toast.error').filter({ hasText: '合成读档失败' }).waitFor();
    await win.waitForFunction(
      () =>
        document.querySelector('.drawer h1')?.textContent === '等待节点 B' &&
        document.querySelector('#timeline-load-button')?.disabled === false,
    );
    check('rejected load restores B controls and retains its preview', { rejected: nodeB.id });

    await loadButton.click();
    await waitCalls(3);
    const environment = (await win.evaluate(() => window.journal.refresh())).data;
    await app.evaluate(
      (_context, snapshot) =>
        globalThis.reviewLoadCalls[2].resolve({
          ok: true,
          data: { cancelled: false, environment: snapshot },
        }),
      environment,
    );
    await win.locator('.drawer').waitFor({ state: 'detached' });
    await win.locator('.toast').filter({ hasText: '历史进度已读入' }).waitFor();
    check('simulated successful load follows the normal close-and-refresh path', { completed: nodeB.id });
    await win.locator('[data-action="backup-preview"]').first().click();
    assert.match(await win.locator('.drawer h1').innerText(), /隔离备份预览/);
    await pulse();
    assert.equal(await win.locator('#timeline-load-button').count(), 0);
    assert.equal(
      await win.locator('.drawer-actions [data-action="close-overlay"]').last().innerText(),
      '先不恢复',
    );
    check('healthy status event leaves backup preview footer labelled as declining restore', {
      backup: '隔离备份预览',
    });
    assert.equal(fs.existsSync(path.join(data, 'game-bridge', 'command.txt')), false);
  } finally {
    await app
      .evaluate(({ app }) => {
        const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
        const { ipcMain } = req('electron');
        for (const call of globalThis.reviewLoadCalls || [])
          call.resolve({ ok: true, data: { cancelled: true } });
        ipcMain.removeHandler('journal:timeline-load');
        if (globalThis.reviewBridgeClass && globalThis.reviewSummaryOriginal)
          globalThis.reviewBridgeClass.prototype.summary = globalThis.reviewSummaryOriginal;
      })
      .catch(() => {});
    await app.close().catch(() => {});
    running = null;
  }
}

async function cancelledTrayQuit(healthDelay = 0, companionDraft = false) {
  const data = makeData('tray-quit' + (healthDelay ? '-delayed' : '') + (companionDraft ? '-companion' : ''));
  const source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), save(5));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const t = new Timeline(path.join(data, 'game-timeline'));
  t.configure(source, false, 10);
  const record = t.record(save(5), 'manual', Date.now() - 10000);
  const a = new Activity(data);
  for (let i = 0; i < 100; i++) a.draft(`tray-old-${i}`, { label: `旧稿 ${i}`, note: `内容 ${i}` });
  running = await launch(data, true);
  const { app } = running;
  let win = running.win;
  try {
    console.log('tray: launched');
    const initial = await win.evaluate(async () => (await window.journal.health()).data);
    assert.equal(initial.background, true, 'the isolated tray must actually be available');
    if (healthDelay)
      await app.evaluate(({ BrowserWindow }, delay) => {
        for (const window of BrowserWindow.getAllWindows()) {
          const contents = window.webContents;
          const send = contents.send.bind(contents);
          contents.send = (channel, value) => {
            if (channel === 'journal:event' && value?.type === 'health') {
              setTimeout(() => {
                if (!contents.isDestroyed()) send(channel, value);
              }, delay);
              return;
            }
            send(channel, value);
          };
        }
      }, healthDelay);
    console.log('tray: active');
    if (companionDraft) {
      const created = app.waitForEvent('window');
      await win.evaluate(() => window.journal.compact());
      win = await created;
      win.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
      await win.locator('.compact-shell').waitFor();
      await win.locator('.companion-tabs [data-action="navigate"][data-id="saves"]').click();
    } else await nav(win, 'saves');
    await win.locator(`[data-action="timeline-preview"][data-id="${record.id}"]`).first().click();
    await win.locator('#timeline-note').fill('退出前写不下的新稿');
    await win.locator('.toast.error').filter({ hasText: '100' }).waitFor();
    console.log('tray: failed draft visible');
    assert.equal(activity(data).drafts[record.id], undefined);
    if (companionDraft) await win.evaluate(() => window.journal.companionCollapse());
    // Bypass the UI button preflush. Main must explicitly ask the renderer to
    // save or retain the failed draft, even when health forwarding is delayed.
    await win.evaluate(() => {
      window.journal.window('quit');
    });
    console.log('tray: quit requested');
    await win.locator('[data-action="window-quit-discard"]').waitFor();
    assert.match(await win.locator('.modal').innerText(), /仍有节点草稿未保存/);
    if (companionDraft) {
      assert.equal((await win.evaluate(() => window.journal.companionSnapshot())).data.mode, 'expanded');
      assert.equal(await win.locator('.compact-shell').isVisible(), true);
    }
    const quitResetDeadline = Date.now() + 12000;
    let quitReset = false;
    while (Date.now() < quitResetDeadline) {
      const r = await win.evaluate(() => window.journal.health());
      if (r.ok && !r.data.quitting && !r.data.timeline.quiescing) {
        quitReset = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(quitReset, true, 'a cancelled quit must reset both main and bridge latches');
    assert.equal(win.isClosed(), false);
    console.log('tray: quit latch reset');
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    await Promise.all([
      win.waitForEvent('close', { timeout: 12000 }),
      win.locator('[data-action="window-quit-discard"]').click(),
    ]);
    assert.equal(Object.keys(activity(data).drafts).length, 100);
    assert.equal(activity(data).drafts['tray-old-0'].note, '内容 0');
    console.log('tray: final quit complete');
    check(
      'tray quit cancelled for failed new draft resets quitting latch; modal discard exits with old drafts',
      {
        oldDrafts: 100,
        recordId: record.id,
        healthReset: true,
        healthDelay,
        companionDraft,
      },
    );
  } finally {
    const killTimer = setTimeout(() => {
      const launched = app.process();
      if (!launched || launched.exitCode !== null) return;
      try {
        if (process.platform === 'win32') {
          // Playwright's Windows launcher can own the real Electron process.
          // Stop only this test's process tree so a failed close cannot orphan it.
          execFileSync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else launched.kill();
      } catch {
        /* An already exited test process needs no further cleanup. */
      }
    }, 8000);
    await app.close().catch(() => {});
    clearTimeout(killTimer);
    running = null;
  }
}

async function corruptRestoreGuidance() {
  const data = makeData('corruptRestore'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const bytes = save(10);
  fs.writeFileSync(path.join(source, '1.sav'), bytes);
  new Store(data, catalog).setPath('savePath', source);
  const backups = new Saves(path.join(data, 'save-backups'));
  const protection = backups.capture(source, '损坏恢复记录之前的保护副本');
  const damaged = '{broken synthetic restore operation';
  fs.writeFileSync(backups.operationFile, damaged);
  const timelineRoot = path.join(data, 'game-timeline');
  fs.mkdirSync(timelineRoot, { recursive: true });
  fs.writeFileSync(path.join(timelineRoot, 'timeline.json'), '{broken synthetic timeline');
  const { app, win } = (running = await launch(data));
  try {
    await nav(win, 'saves');
    const banner = win.locator('[aria-label="存档恢复待核对"]');
    assert.match(await banner.innerText(), /恢复记录无法读取/);
    assert.match(await banner.innerText(), /先退出游戏.*保留当前存档/);
    assert.equal(await banner.locator('details').evaluate((e) => e.open), false);
    assert.equal(await banner.locator('[data-action="recover-restore"]').count(), 0);
    assert.equal(await banner.locator('[data-action="folder"][data-id="backups"]').count(), 1);
    const brokenTimeline = win.locator('[aria-label="时间线需要核对"]');
    assert.match(await brokenTimeline.innerText(), /核对之前不能更换目录或创建新备份/);
    assert.doesNotMatch(await brokenTimeline.innerText(), /仍可重新选择有效存档目录/);
    const denied = await win.evaluate(() => window.journal.chooseSaves());
    assert.equal(denied.ok, false);
    assert.match(denied.error, /核对完整存档恢复/);
    await banner.locator('summary').click();
    assert.match(await banner.innerText(), /restore-operation.json/);
    assert.match(await banner.innerText(), /JSON|position|property/i);
    assert.equal(fs.readFileSync(backups.operationFile, 'utf8'), damaged);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), bytes);
    assert.deepEqual(
      fs.readFileSync(path.join(data, 'save-backups', protection.id, 'files', '1.sav')),
      bytes,
    );
    check(
      'corrupt restore record gives Chinese next steps and optional diagnosis; original files remain protected',
      { data, protectionId: protection.id },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function interruptedRestoreReceipt() {
  const data = makeData('interruptedRestore'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const incoming = save(1, 1, 1000),
    current = save(10, 4, 5000),
    second = save(20, 4, 6000),
    foreign = save(30, 4, 7000),
    newer = save(99, 4, 9000);
  fs.writeFileSync(path.join(source, '1.sav'), incoming);
  fs.writeFileSync(path.join(source, '2.sav'), second);
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  const backups = new Saves(path.join(data, 'save-backups')),
    snapshot = backups.capture(source, '合成中断恢复来源');
  fs.writeFileSync(path.join(source, '1.sav'), current);
  fs.writeFileSync(path.join(source, '9.sav'), foreign);
  const child = spawnSync(
    process.execPath,
    [path.join(base, 'tests/crash-restore-child.cjs'), backups.root, source, snapshot.id, '1.sav'],
    { encoding: 'utf8', timeout: 20000, windowsHide: true },
  );
  assert.equal(child.status, 71, child.stderr);
  const pending = backups.pendingRestore();
  assert.equal(pending.count, 1);
  const operationBefore = fs.readFileSync(backups.operationFile),
    originalCopy = backups.verify(snapshot.id),
    safety = backups.verify(pending.safetyId);
  assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), incoming);
  let { app, win } = (running = await launch(data));
  try {
    await nav(win, 'saves');
    const banner = () => win.locator('[aria-label="存档恢复待核对"]');
    await banner().waitFor();
    const operations = () => new Activity(data).get().events;
    const beforeEvents = operations();
    const answer = (response) =>
      app.evaluate(({ dialog }, value) => {
        dialog.showMessageBox = async () => ({ response: value });
      }, response);
    await answer(0);
    await banner().locator('[data-action="recover-restore"]').click();
    await win.evaluate(() => window.journal.refresh());
    assert.deepEqual(operations(), beforeEvents);
    assert.deepEqual(fs.readFileSync(backups.operationFile), operationBefore);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), incoming);
    assert.deepEqual(fs.readFileSync(path.join(source, '2.sav')), second);
    assert.deepEqual(fs.readFileSync(path.join(source, '9.sav')), foreign);
    check(
      'interrupted restore cancellation preserves pending recovery, all save bytes and operation history',
      { data },
    );
    fs.writeFileSync(path.join(source, '1.sav'), newer);
    await answer(1);
    await banner().locator('[data-action="recover-restore"]').click();
    await win.locator('.toast.error').filter({ hasText: '其他修改' }).waitFor();
    assert.deepEqual(operations(), beforeEvents);
    assert.deepEqual(fs.readFileSync(backups.operationFile), operationBefore);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), newer);
    assert.deepEqual(fs.readFileSync(path.join(source, '2.sav')), second);
    assert.deepEqual(fs.readFileSync(path.join(source, '9.sav')), foreign);
    assert.equal(await banner().count(), 1);
    check('interrupted restore refuses later progress without recording success or modifying other slots', {
      data,
    });
    // Only the disposable fixture is reset to the known attempted-write bytes for retry.
    fs.writeFileSync(path.join(source, '1.sav'), incoming);
    await banner().locator('[data-action="recover-restore"]').click();
    await banner().waitFor({ state: 'detached' });
    assert.equal(backups.pendingRestore(), null);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), current);
    assert.deepEqual(fs.readFileSync(path.join(source, '2.sav')), second);
    assert.deepEqual(fs.readFileSync(path.join(source, '9.sav')), foreign);
    const receipt = operations().find((event) => /中断的恢复已回退/.test(event.message));
    assert(receipt, 'Successful interrupted restore must leave a persistent receipt');
    assert.equal(receipt.level, 'success');
    assert.match(receipt.message, /已回退 1 个文件/);
    assert(receipt.message.includes(source.slice(0, 220)));
    assert(receipt.message.includes(pending.safetyId));
    assert((await win.locator('.operation-history').innerText()).includes(receipt.message));
    for (const copy of [originalCopy, safety]) {
      const verified = backups.verify(copy.manifest.id);
      for (const [name, bytes] of copy.buffers) assert.deepEqual(verified.buffers.get(name), bytes);
    }
    await app.close();
    running = null;
    ({ app, win } = running = await launch(data));
    await nav(win, 'saves');
    assert.equal(await banner().count(), 0);
    assert((await win.locator('.operation-history').innerText()).includes(receipt.message));
    assert.equal(operations().filter((event) => event.message === receipt.message).length, 1);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), current);
    assert.deepEqual(fs.readFileSync(path.join(source, '2.sav')), second);
    assert.deepEqual(fs.readFileSync(path.join(source, '9.sav')), foreign);
    await win.screenshot({ path: path.join(data, 'recovery-receipt-restarted.png') });
    check(
      'successful interrupted restore retains target, file count and verified safety copy in UI after cold restart',
      {
        data,
        safetyId: pending.safetyId,
        restored: 1,
        receipt: receipt.message,
      },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function corruptTimelineReconnect() {
  const data = makeData('corruptTimeline'),
    source = path.join(data, 'old-SaveGames'),
    replacement = path.join(data, 'new-SaveGames');
  fs.mkdirSync(source);
  fs.mkdirSync(replacement);
  const original = save(10, 1, 3661),
    current = save(2, 4, 6000);
  fs.writeFileSync(path.join(source, '1.sav'), original);
  fs.writeFileSync(path.join(replacement, '1.sav'), current);
  fs.writeFileSync(path.join(replacement, '29.sav'), original);
  fs.utimesSync(path.join(replacement, '29.sav'), new Date('2025-01-01'), new Date('2025-01-01'));
  const history = new Timeline(path.join(data, 'game-timeline'));
  history.configure(source, false, 10);
  history.record(original, 'manual', Date.now() - 20000);
  history.record(current, 'manual', Date.now() - 10000);
  fs.writeFileSync(history.file, '{broken');
  const preserved = [
    history.file,
    history.file + '.previous',
    ...fs.readdirSync(history.blobs).map((name) => path.join(history.blobs, name)),
  ];
  const originalBytes = preserved.map((file) => fs.readFileSync(file));
  new Store(data, catalog).setPath('savePath', path.join(data, 'expired-SaveGames'));
  const { app, win } = (running = await launch(data));
  try {
    await nav(win, 'home');
    const retained = await win.locator('.stat-grid .stat').last().innerText();
    assert.match(retained, /时间线历史数量待核对/);
    assert.doesNotMatch(retained, /0\s*个时间线节点/);
    await nav(win, 'saves');
    const panel = win.locator('[aria-label="时间线需要核对"]');
    assert.match(await panel.innerText(), /历史数量暂时无法核对/);
    assert.equal(await win.locator('[data-action="timeline-toggle"]').count(), 0);
    assert.equal(await panel.locator('details').evaluate((e) => e.open), false);
    await app.evaluate(({ dialog }, replacement) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [replacement] });
    }, replacement);
    await win.locator('[data-action="choose-saves"]').first().click();
    await win.waitForFunction(() => document.querySelector('.save-stats strong')?.textContent === '2');
    const refreshed = (await win.evaluate(() => window.journal.bootstrap())).data;
    assert.equal(refreshed.state.settings.savePath, fs.realpathSync(replacement));
    assert.equal(refreshed.environment.recent.name, '1.sav');
    assert.equal(refreshed.environment.recent.playSeconds, 6000);
    assert.equal(refreshed.environment.timeline.enabled, false);
    assert.equal(refreshed.environment.timeline.indexError, true);
    await win.locator('[data-action="backup"]').first().click();
    await win.locator('#backup-label').fill('时间线异常时的完整保护');
    await win.locator('[data-action="backup-confirm"]').click();
    await win.locator('.backup-row').filter({ hasText: '时间线异常时的完整保护' }).waitFor();
    const copied = new Saves(path.join(data, 'save-backups'));
    const backup = copied.list().find((b) => b.label === '时间线异常时的完整保护');
    assert.equal(copied.verify(backup.id).manifest.files.length, 2);
    preserved.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), originalBytes[i]));
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), original);
    assert.deepEqual(fs.readFileSync(path.join(replacement, '1.sav')), current);
    assert.deepEqual(fs.readFileSync(path.join(replacement, '29.sav')), original);
    assert.equal(fs.existsSync(path.join(data, 'game-bridge', 'command.txt')), false);
    check(
      'corrupt timeline permits passive reconnect and verified complete backup, preserving history and foreign slot',
      { data, backupId: backup.id },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function knownBadBackup() {
  const data = makeData('bad-backup'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const original = save(10);
  fs.writeFileSync(path.join(source, '1.sav'), original);
  new Store(data, catalog).setPath('savePath', source);
  let { app, win } = (running = await launch(data));
  try {
    await nav(win, 'saves');
    await win.locator('.backup-row').first().waitFor();
    const copies = new Saves(path.join(data, 'save-backups'));
    const bad = copies.list()[0],
      payload = path.join(copies.root, bad.id, 'files', '1.sav');
    fs.writeFileSync(payload, 'deliberately damaged synthetic backup');
    await win.locator(`[data-action="verify"][data-id="${bad.id}"]`).click();
    await win.waitForFunction(() => document.body.innerText.includes('校验未通过'));
    await win.waitForFunction(() => document.querySelectorAll('.toast').length === 0, { timeout: 12000 });
    let current = (await win.evaluate(() => window.journal.refresh())).data;
    assert.equal(current.health.protection.warning, true);
    assert.notEqual(current.health.protection.ready, true);
    assert.equal(current.health.lastBackup, null);
    assert.match(current.backups.find((b) => b.id === bad.id).verificationError, /1.sav/);
    assert.ok(current.activity.events.some((e) => e.level === 'error' && /副本校验失败/.test(e.message)));
    await nav(win, 'home');
    assert.match(await win.locator('.content').innerText(), /需要核对|校验失败/);
    await nav(win, 'saves');
    await win.locator('[data-action="backup"]').first().click();
    await win.locator('#backup-label').fill('修复后重新保护');
    await win.locator('[data-action="backup-confirm"]').click();
    await win.locator('.backup-row').filter({ hasText: '修复后重新保护' }).waitFor();
    current = (await win.evaluate(() => window.journal.refresh())).data;
    assert.equal(current.health.protection.ready, true);
    const good = copies.list().find((b) => b.label === '修复后重新保护');
    assert.equal(current.health.lastBackup.id, good.id);
    assert.deepEqual(copies.verify(good.id).buffers.get('1.sav'), original);
    await win.locator(`[data-action="backup-preview"][data-id="${bad.id}"]`).click();
    current = (await win.evaluate(() => window.journal.refresh())).data;
    assert.equal(current.health.protection.ready, true, 'old damage cannot invalidate a newer verified copy');
    assert.equal(current.health.lastBackup.id, good.id);
    await app.close();
    running = null;
    ({ app, win } = running = await launch(data));
    await nav(win, 'saves');
    assert.match(await win.locator('.backup-row').filter({ hasText: bad.label }).innerText(), /校验未通过/);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), original);
    assert.equal(fs.readFileSync(payload, 'utf8'), 'deliberately damaged synthetic backup');
    check(
      'known damaged protection remains visibly invalid, a new verified copy restores readiness, and history survives restart',
      { data, bad: bad.id, good: good.id },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function questReadingAndReservations() {
  const data = makeData('quest-reading'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, '1.sav'),
    syntheticSave({ full: true, quests: [{ id: 5200, step: 1 }], inventory: [{ id: 10016, count: 2 }] }),
  );
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  store.mutate({
    type: 'goal-add',
    title: '已有任务记录',
    detail: '已有剧情备忘',
    source: { type: 'quest', id: 'quest-5200' },
  });
  store.mutate({ type: 'goal-add', title: '手写目标', detail: '自己的公开备忘' });
  const { app, win } = (running = await launch(data));
  try {
    await nav(win, 'world');
    await win.locator('#world-search').fill('武当求助');
    await win.locator('.world-quest-card[data-id="quest-5200"]').click();
    const story = win
      .locator('.drawer details')
      .filter({ has: win.locator('summary', { hasText: '任务说明' }) });
    assert.equal(await story.evaluate((e) => e.open), false);
    await win.locator('[data-action="world-quest-goal"]').click();
    await close(win);
    await nav(win, 'goals');
    const added = win.locator('.goal-row').filter({ hasText: '【主线】武当求助' });
    assert.equal(await added.locator('details p').isVisible(), false);
    assert.equal(
      await win.locator('.goal-row').filter({ hasText: '已有任务记录' }).locator('details p').isVisible(),
      false,
    );
    assert.equal(await win.getByText('自己的公开备忘', { exact: true }).isVisible(), true);
    await nav(win, 'home');
    assert.equal(
      await win.locator('.goal-row').filter({ hasText: '【主线】武当求助' }).locator('details p').isVisible(),
      false,
    );
    await nav(win, 'goals');
    await added.locator('summary').click();
    assert.equal(await added.locator('details p').isVisible(), true);
    await added.locator('[data-action="goal-pin"]').click();
    assert.equal(await added.locator('details').evaluate((e) => e.open), true);
    await win.evaluate(() => window.journal.mutate({ type: 'settings', value: { spoiler: 'details' } }));
    await win.waitForFunction(() => !document.querySelector('.goal-row details'));
    assert.equal(await added.locator('p:not(.muted)').isVisible(), true);
    await nav(win, 'world');
    await win.locator('#world-search').fill('采集半边莲');
    await win.locator('.world-quest-card[data-id="quest-5053"]').click();
    await win.locator('.drawer [data-action="world-quest"][data-id="quest-5057"]').click();
    assert.match(await win.locator('.drawer').innerText(), /库存 2 · 缺 3/);
    await win.locator('[data-action="world-reserve-material"][data-id="quest-5057:10016"]').click();
    await win.waitForFunction(() =>
      document.querySelector('[data-action="world-reserve-material"]')?.textContent.includes('已预留 5'),
    );
    assert.equal(
      journal(data).profiles[0].allocations.find((a) => a.questId === 'quest-5057').items['10016'],
      5,
    );
    await win.evaluate(() => window.journal.mutate({ type: 'reserve-set', id: '10016', count: 8 }));
    await win.locator('[data-action="world-reserve-material"]').click();
    await win.waitForFunction(() =>
      document.querySelector('[data-action="world-reserve-material"]')?.textContent.includes('已预留 5'),
    );
    assert.equal(journal(data).profiles[0].reservations['10016'], 8);
    assert.equal(
      journal(data).profiles[0].allocations.find((a) => a.questId === 'quest-5057').items['10016'],
      5,
    );
    await win.locator('[data-action="database-detail"][data-id="item-10016"]').click();
    assert.equal(await win.locator('#reserve-count').inputValue(), '8');
    await win.locator('#reserve-count').fill('1');
    await win.locator('[data-action="reserve-save"]').click();
    assert.equal(journal(data).profiles[0].reservations['10016'], 1);
    assert.equal(
      journal(data).profiles[0].allocations.find((a) => a.questId === 'quest-5057').items['10016'],
      5,
    );
    check(
      'task goals respect hidden story on home and goals, while explicit disclosure and task material reservations remain editable',
      { data },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function unreadableProgressAndImport() {
  const data = makeData('unreadable'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const invalid = Buffer.from('unknown synthetic save format');
  fs.writeFileSync(path.join(source, '1.sav'), invalid);
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  const { app, win } = (running = await launch(data));
  try {
    assert.match(await win.locator('.start-panel').innerText(), /暂时无法读取进度和库存/);
    assert.doesNotMatch(await win.locator('.start-panel').innerText(), /存档回顾.*现在就能使用/);
    await nav(win, 'saves');
    await win.locator('.backup-row').first().waitFor();
    assert.match(await win.locator('.content').innerText(), /进度暂无法读取/);
    const copies = new Saves(path.join(data, 'save-backups'));
    assert.deepEqual(copies.verify(copies.list()[0].id).buffers.get('1.sav'), invalid);
    await nav(win, 'settings');
    const broken = path.join(data, 'bad-import.json');
    fs.writeFileSync(broken, '{bad synthetic journal');
    const before = fs.readFileSync(path.join(data, 'journal.json'));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, broken);
    await win.locator('[data-action="import"]').click();
    await win.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('当前记录未改动'));
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), before);
    fs.writeFileSync(path.join(source, '1.sav'), save(10));
    await nav(win, 'home');
    await win.locator('[data-action="refresh"]').first().click();
    await win.waitForFunction(() =>
      document.querySelector('.start-panel')?.textContent.includes('已读到你的进度'),
    );
    check(
      'unknown save format has actionable guidance and remains backed up; malformed journal import preserves current records',
      { data },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function importedReferences() {
  const data = makeData('import-references'),
    source = path.join(data, 'SaveGames');
  fs.mkdirSync(source);
  const original = save(10, 1, 3661);
  fs.writeFileSync(path.join(source, '1.sav'), original);
  fs.utimesSync(path.join(source, '1.sav'), new Date('2020-01-01'), new Date('2020-01-01'));
  fs.writeFileSync(path.join(source, '7.sav'), save(20, 4, 8661));
  const store = new Store(data, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  store.mutate({ type: 'save-slot', value: '1.sav', mode: 'slot' });
  store.mutate({ type: 'reserve-set', id: '10016', count: 5 });
  const firstProfile = store.get().activeProfileId;
  store.mutate({ type: 'profile-add', name: '仅查资料的周目', mode: 'none' });
  store.mutate({ type: 'profile-switch', id: firstProfile });
  const { app, win } = (running = await launch(data));
  try {
    await nav(win, 'database');
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('道玄');
    const person = gameIndex.entries.find((e) => e.kind === '人物' && e.name === '道玄');
    await win.locator(`.database-card[data-id="${person.id}"]`).click();
    await win.locator('#person-save').selectOption('');
    await win.waitForFunction(() =>
      document.querySelector('.person-gifts')?.textContent.includes('尚未核对可用数量'),
    );
    assert.doesNotMatch(await win.locator('.person-gifts').innerText(), /仅列可用库存/);
    await close(win);
    await nav(win, 'settings');
    const file = path.join(data, 'exported-journal.json');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async (_owner, options) => {
        global.testImportPrompt = options;
        return { response: 0 };
      };
    }, file);
    await win.locator('[data-action="export"]').click();
    await win.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('导出'));
    const before = fs.readFileSync(path.join(data, 'journal.json'));
    await win.locator('[data-action="import"]').click();
    const prompt = await app.evaluate(() => global.testImportPrompt);
    assert.match(prompt.detail, /1 个周目的固定存档参照会改为跟随本机最新保存/);
    assert.match(prompt.detail, /周目管理.*重新选择固定参照/);
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), before);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await win.locator('[data-action="import"]').click();
    await win.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((t) =>
        t.textContent.includes('1 个周目已改为跟随最新存档'),
      ),
    );
    assert.equal(journal(data).profiles[0].referenceMode, 'latest');
    assert.equal(journal(data).profiles[0].saveSlot, '');
    assert.equal(journal(data).profiles[1].referenceMode, 'none');
    assert.equal(journal(data).settings.savePath, source);
    assert.equal(journal(data).settings.autoBackup, false);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), original);
    assert.ok(fs.readdirSync(data).some((f) => f.startsWith('journal-before-import-')));
    check(
      'import discloses reference reset before confirmation and after success; unknown gift stock stays explicitly illustrative',
      { data },
    );
  } finally {
    await app.close();
    running = null;
  }
}

async function customOpacityImport() {
  const data = makeData('custom-opacity');
  const store = new Store(data, catalog);
  store.mutate({ type: 'settings', value: { autoBackup: false, compactOpacity: 0.82 } });
  store.mutate({ type: 'note', value: '透明度导入应保留这份笔记' });
  const exported = path.join(data, 'imported-opacity.json');
  fs.writeFileSync(
    exported,
    JSON.stringify({ ...store.get(), settings: { ...store.get().settings, compactOpacity: 0.9 } }),
  );
  let launched = (running = await launch(data));
  try {
    await nav(launched.win, 'settings');
    assert.equal(await launched.win.locator('#companion-opacity').inputValue(), '0.82');
    assert.equal(await launched.win.locator('#companion-opacity option:checked').innerText(), '82%（当前）');
    assert.equal(journal(data).settings.compactOpacity, 0.82);
    await launched.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, exported);
    await launched.win.locator('[data-action="import"]').click();
    await launched.win.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('手札已导入')),
    );
    assert.equal(await launched.win.locator('#companion-opacity').inputValue(), '0.82');
    assert.equal(journal(data).settings.compactOpacity, 0.82);
    assert.equal(journal(data).profiles[0].notes, '透明度导入应保留这份笔记');
    await launched.app.close();
    running = null;
    launched = running = await launch(data);
    await nav(launched.win, 'settings');
    assert.equal(await launched.win.locator('#companion-opacity').inputValue(), '0.82');
    await launched.app.close();
    running = null;
    new Store(data, catalog).mutate({ type: 'settings', value: { compactOpacity: 0.9 } });
    launched = running = await launch(data);
    await nav(launched.win, 'settings');
    assert.equal(await launched.win.locator('#companion-opacity').inputValue(), '0.9');
    assert.equal(await launched.win.locator('#companion-opacity option:checked').innerText(), '90%（当前）');
    await launched.win.locator('#companion-opacity').selectOption('0.85');
    await launched.win.waitForFunction(() => document.querySelector('#companion-opacity')?.value === '0.85');
    assert.equal(journal(data).settings.compactOpacity, 0.85);
    assert.equal(await launched.win.locator('#companion-opacity option:checked').innerText(), '85%');
    const current = await launched.win.evaluate(() => window.journal.companionSnapshot());
    assert.equal(current.data.preferences.opacity, 0.85);
    check(
      'custom opacity displays accurately and survives journal import, restart and preset editing without changing notes',
      { data },
    );
  } finally {
    await launched.app.close();
    running = null;
  }
}

(async () => {
  try {
    const groups = {
      importBusyFeedback,
      detailReadability,
      searchReadability,
      references: referenceAndPolling,
      firstSave: firstSaveAppears,
      recipeOutputs: recipeOutputUnits,
      referenceEdges: referenceRefreshEdges,
      draftCapacity: fullDraftCapacity,
      interleavedNode: interleavedNodeSave,
      loadInFlight: inFlightLoadUi,
      trayQuit: cancelledTrayQuit,
      trayQuitDelayed: () => cancelledTrayQuit(100),
      trayQuitCompanion: () => cancelledTrayQuit(100, true),
      corruptRestore: corruptRestoreGuidance,
      interruptedRestore: interruptedRestoreReceipt,
      corruptTimeline: corruptTimelineReconnect,
      badBackup: knownBadBackup,
      questReading: questReadingAndReservations,
      unreadable: unreadableProgressAndImport,
      importReferences: importedReferences,
      customOpacity: customOpacityImport,
    };
    const requested = process.env.YIJIAN_REVIEW_ONLY?.split(',') || Object.keys(groups);
    for (const name of requested) {
      if (!groups[name]) throw Error('Unknown review group: ' + name);
      await groups[name]();
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
  } catch (e) {
    report.passed = false;
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    if (running) await running.app.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(report);
  }
})();
