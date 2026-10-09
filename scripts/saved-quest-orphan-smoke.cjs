'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { _electron } = require('playwright'),
  { Store } = require('../src/core/store.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'saved-quest-orphan-' + Date.now()),
  userdata = path.join(out, 'userdata'),
  saves = path.join(out, 'synthetic-SaveGames'),
  temp = path.join(out, 'temp');
for (const dir of [userdata, saves, temp, path.join(base, 'test-results')])
  fs.mkdirSync(dir, { recursive: true });
process.env.TEMP = process.env.TMP = temp;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex'),
  hashes = {};
for (const [name, quests] of [
  ['1.sav', [{ id: 14082, step: 1 }]],
  [
    '2.sav',
    [
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
  ],
]) {
  const file = path.join(saves, name),
    bytes = syntheticSave({ full: true, quests });
  fs.writeFileSync(file, bytes);
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(file, old, old);
  hashes[name] = sha(bytes);
}
const store = new Store(userdata, require('../src/data/catalog.cjs'));
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '1.sav', mode: 'slot' });
const report = {
  at: new Date().toISOString(),
  syntheticOnly: true,
  executable: process.env.YIJIAN_EXECUTABLE || 'source Electron',
  checks: [],
  errors: [],
};
let app, page;
async function openFromHome(id) {
  await page.locator('.nav-btn[data-id="home"]').click();
  await page.locator(`[data-action="save-quest-jump"][data-id="${id}"]`).first().click();
  const section = page.locator('.save-recorded-quests');
  await section.locator(`[data-quest-id="${id}"] details[open]`).waitFor();
  assert.match(await section.locator(':scope > summary').innerText(), /任务记录 · 1 项/);
  assert(!/任务状态已变化/.test(await page.locator('#toasts').innerText()));
  return section;
}
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: userdata, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      cwd: base,
      env,
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => report.errors.push(e.message));
    await page.context().setOffline(true);
    await page.locator('.layout').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.showInactive()));
    let section = await openFromHome(14082);
    assert.match(await section.innerText(), /未记录上级任务/);
    await page.screenshot({ path: path.join(out, 'orphan-current-step.png'), animations: 'disabled' });
    report.checks.push(
      'home orphan task opens the same recorded active step, count and truthful parent context without a changed-state warning',
    );
    await section.locator('[data-action="save-quest-filter"][data-id="done"]').click();
    assert.equal(await section.locator('.saved-quest').count(), 0);
    await section.locator('[data-action="save-quest-filter"][data-id="active"]').click();
    assert.equal(await section.locator('[data-quest-id="14082"]').count(), 1);
    await page.keyboard.press('Escape');
    report.checks.push('orphan remains reachable after changing the recorded-state filter');
    const response = await page.evaluate(() =>
      window.journal.mutate({ type: 'save-slot', value: '2.sav', mode: 'slot' }),
    );
    assert(response.ok, response.error);
    section = await openFromHome(14073);
    assert.equal(await section.locator('.saved-quest').count(), 1);
    assert.equal(await section.locator('.quest-step').count(), 1);
    assert(!/未记录上级任务/.test(await section.innerText()));
    report.checks.push('parent plus child still opens one family with its nested recorded step');
    for (const [name, hash] of Object.entries(hashes))
      assert.equal(sha(fs.readFileSync(path.join(saves, name))), hash);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('Saved quest orphan PASS', report.checks.length, out);
  } catch (error) {
    report.failure = String(error.stack || error);
    throw error;
  } finally {
    if (app) await app.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results/saved-quest-orphan-result.json'),
      JSON.stringify({ ...report, evidence: out }, null, 2),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
