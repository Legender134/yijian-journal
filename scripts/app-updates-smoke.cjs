'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const version = require('../package.json').version;
const base = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(base, '.test-data', 'app-update-ui-'));
const fixture = path.join(data, 'update-fixture');
fs.mkdirSync(fixture);
new Store(data, catalog);
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const next = `${Number(version.split('.')[0]) + 1}.0.0`;
const packageName = `YijianJournal-${next}-windows-x64.zip`;
const packageBytes = crypto.randomBytes(256 * 1024);
fs.writeFileSync(path.join(fixture, packageName), packageBytes);
fs.writeFileSync(
  path.join(fixture, 'fixture.json'),
  JSON.stringify({ publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }),
);
const payload = Buffer.from(
  JSON.stringify({
    app: 'yijian-journal',
    version: next,
    platform: 'win32',
    arch: 'x64',
    publishedAt: new Date().toISOString(),
    url: `https://data.riftbuddy.dpdns.org/yijian-journal/${packageName}`,
    size: packageBytes.length,
    sha256: crypto.createHash('sha256').update(packageBytes).digest('hex'),
    notes: ['合成更新：当前任务状态一致', '<img src=x onerror=alert(1)> 应当显示为文字'],
  }),
);
fs.writeFileSync(
  path.join(fixture, 'latest.json'),
  JSON.stringify({
    schemaVersion: 1,
    keyId: 'yijian-updates-20261015',
    payload: payload.toString('base64'),
    signature: crypto.sign(null, payload, privateKey).toString('base64'),
  }),
);
let app, win;
const errors = [],
  external = [];
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_UPDATES: '1', YIJIAN_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
  });
  win = await app.firstWindow();
  win.on('pageerror', (error) => errors.push(error.message));
  win.on('request', (request) => {
    if (/^https?:/.test(request.url())) external.push(request.url());
  });
  await win.locator('.layout').waitFor();
}
async function phase(page, expected) {
  await page.waitForFunction(
    async (wanted) => (await window.journal.bootstrap()).data.environment.updates.phase === wanted,
    expected,
  );
}
async function screenshot(page, name) {
  const encoded = await app.evaluate(
    async ({ BrowserWindow }, id) => {
      const target = BrowserWindow.getAllWindows().find((window) => window.webContents.id === id);
      target.webContents.setBackgroundThrottling(false);
      await target.webContents.capturePage();
      return (await target.webContents.capturePage(undefined, { stayAwake: true }))
        .toPNG()
        .toString('base64');
    },
    await app.evaluate(
      ({ BrowserWindow }, compact) =>
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact') === compact)
          .webContents.id,
      page !== win,
    ),
  );
  fs.writeFileSync(path.join(base, 'test-results', name), Buffer.from(encoded, 'base64'));
}
(async () => {
  try {
    await launch();
    await phase(win, 'available');
    assert.equal(
      fs.existsSync(path.join(data, 'app-updates', packageName)),
      false,
      'startup check does not download the package',
    );
    await win.locator('.topbar [data-action="updates"]').click();
    const dialog = win.getByRole('dialog', { name: '软件更新' });
    await dialog.locator('[data-action="update-download"]').waitFor();
    assert.equal(await dialog.locator('[data-update-notes]').getAttribute('open'), null);
    assert.equal(await dialog.locator('[data-update-notes] img').count(), 0);
    await dialog.locator('[data-action="update-download"]').click();
    await phase(win, 'ready');
    await dialog.locator('[data-action="update-install"]').waitFor();
    await dialog.locator('[data-update-notes] summary').click();
    await dialog.locator('[data-action="update-check"]').click();
    await phase(win, 'ready');
    assert.equal(await dialog.locator('[data-update-notes]').evaluate((node) => node.open), true);
    await dialog.locator('[data-action="update-auto"]').click();
    await win.waitForFunction(
      async () => (await window.journal.bootstrap()).data.state.settings.checkUpdatesOnStart === false,
    );
    await win.keyboard.press('Escape');
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-update-panel]').scrollIntoViewIfNeeded();
    await screenshot(win, 'app-updates-main.png');
    const newWindow = app.waitForEvent('window');
    await win.locator('.topbar [data-action="compact"]').click();
    const small = await newWindow;
    assert.ok(small, 'companion window exists');
    small.on('pageerror', (error) => errors.push(error.message));
    await small.locator('.compact-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact'));
      window.setBounds({ x: 100, y: 100, width: 360, height: 660 });
    });
    await small.locator('[data-action="companion-layout"]').click();
    await small.getByRole('dialog').locator('[data-action="updates"]').click();
    const smallDialog = small.getByRole('dialog', { name: '软件更新' });
    await smallDialog.locator('[data-action="update-install"]').waitFor();
    assert.ok(
      await smallDialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      'update controls fit a 360px companion',
    );
    await screenshot(small, 'app-updates-companion-360.png');
    const install = await small.evaluate(() => window.journal.installUpdate());
    assert.equal(install.ok, false);
    assert.match(install.error, /测试不安装/);
    await app.close();
    app = null;
    fs.writeFileSync(
      path.join(data, 'app-updates', 'install-result.json'),
      JSON.stringify({
        schema: 1,
        status: 'failed',
        version: next,
        code: 'install',
        at: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(path.join(fixture, 'latest.json'), 'synthetic unavailable manifest');
    await launch();
    await phase(win, 'ready');
    assert.match(await win.locator('.topbar [data-action="updates"]').innerText(), /更新未完成/);
    assert.equal(
      (await win.evaluate(() => window.journal.bootstrap())).data.state.settings.checkUpdatesOnStart,
      false,
    );
    await win.locator('.topbar [data-action="updates"]').click();
    await win.getByRole('dialog').getByText('无法安装新版，旧版本保持可用。', { exact: true }).waitFor();
    await win.getByRole('dialog').locator('[data-action="update-check"]').click();
    await phase(win, 'ready');
    await win.getByRole('dialog').getByText('检查暂不可用，已下载更新可安装', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      'App update UI PASS: startup metadata only, signed download, cached restart, companion controls, offline recovery, test install isolation. Fixture:',
      data,
    );
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
