'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const { openMainPage } = require('./ui-smoke-actions.cjs');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'task-completion-ui-' + Date.now());
const data = path.join(out, 'userdata'),
  source = path.join(out, 'synthetic-SaveGames'),
  file = path.join(source, '1.sav');
fs.mkdirSync(source, { recursive: true });
let expected, app, main, compact;
const errors = [],
  checks = [];
function save(id, parent, money, inventory) {
  expected = syntheticSave({
    full: true,
    seconds: Date.now() % 100000,
    quests: [
      { id: parent, step: 1 },
      { id, step: 1 },
    ],
    money,
    inventory,
    trackingQuest: id,
    trackingMainQuest: parent,
  });
  fs.writeFileSync(file, expected);
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(file, old, old);
}
save(17009, 17008, 100000, [{ id: 10181, count: 1 }]);
const store = new Store(data, require('../src/data/catalog.cjs'));
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false, checkUpdatesOnStart: false } });
async function environment() {
  const result = await main.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.environment;
}
async function waitForStep(id, ready) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const current = await environment();
    const step = current.flow.active.flatMap((row) => row.steps).find((row) => row.id === 'quest-' + id);
    if (step && (ready === undefined || (step.targets.materialState === 'ready') === ready)) return step;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Current task reading did not arrive');
}
async function expand(page, selector) {
  const details = page.locator(selector).first();
  if (!(await details.evaluate((node) => node.open))) await details.locator(':scope > summary').click();
}
async function capture(page, name) {
  const win = await app.browserWindow(page);
  const bytes = await win.evaluate(async (window) =>
    (await window.webContents.capturePage()).toPNG().toString('base64'),
  );
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(bytes, 'base64'));
  await win.dispose();
}
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require('electron'), args: [base], cwd: base, env });
    app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    app.context().setDefaultTimeout(15000);
    main = await app.firstWindow();
    await main.locator('.layout').waitFor();
    await openMainPage(main, 'checklist');
    await waitForStep(17009, false);
    const currentTask = main.locator('[data-flow-quest="quest-17008"]').first();
    await currentTask.getByText('还需 1 文', { exact: false }).first().waitFor();
    assert.doesNotMatch(
      await currentTask.innerText(),
      /100,001 文/,
      'Detailed threshold is folded by default',
    );
    await expand(main, '[data-persist-detail="main-task-quest-17008"]');
    await currentTask.getByText('铜钱至少 100,001 文').waitFor();
    checks.push('Main flow shows the immediate shortfall and folds the full completion checklist');
    await currentTask.locator('[data-action="flow-quest"][data-id="quest-17009"]').first().click();
    await expand(main, '[data-quest-completion]');
    await main.locator('[data-quest-completion]').getByText('未满足', { exact: true }).waitFor();
    await capture(main, '01-codex-shortfall');
    save(17009, 17008, 100001, [{ id: 10181, count: 1 }]);
    await waitForStep(17009, true);
    await main.locator('[data-quest-completion]').getByText('已满足', { exact: true }).waitFor();
    assert(
      await main.locator('[data-quest-completion]').evaluate((node) => node.open),
      'An open checklist stays open when the reading updates',
    );
    await main.locator('[data-action="close-overlay"]').first().click();
    checks.push(
      'The codex shares live follow-up of the selected saved reading and keeps the open disclosure',
    );
    const opened = app.waitForEvent('window');
    await main.locator('[data-action="compact"]').first().click();
    compact = await opened;
    await compact.locator('.companion-tabs [data-id="home"]').click();
    await compact.locator('.flow-now .flow-next-action').filter({ hasText: '交付' }).waitFor();
    save(17009, 17008, 100000, [{ id: 10181, count: 1 }]);
    await waitForStep(17009, false);
    await compact.locator('.flow-now .flow-next-action').filter({ hasText: '还需 1 文' }).waitFor();
    await expand(compact, '.flow-now-details');
    await compact.locator('.flow-conditions').getByText('铜钱至少 100,001 文').waitFor();
    await capture(compact, '02-sidecar-completion');
    checks.push(
      'Sidecar completion changes with money, suppresses premature hand-in and reveals details in place',
    );
    save(12407, 12400, 0, [{ id: 1004, count: 1 }]);
    await waitForStep(12407);
    await compact.locator('[data-flow-quest="quest-12400"]').first().waitFor();
    await compact.locator('.flow-now .flow-next-action').filter({ hasText: '向莫问交付' }).waitFor();
    assert.doesNotMatch(await compact.locator('.flow-now .flow-next-action').innerText(), /购买|平康城/);
    await expand(compact, '.flow-now-details');
    await compact.locator('.flow-conditions .related-items [data-id="item-1004"]').waitFor();
    await capture(compact, '03-sidecar-alternatives');
    await compact.locator('[data-action="flow-quest"][data-id="quest-12400"]').first().click();
    await compact.locator('.drawer [data-action="world-quest"][data-id="quest-12407"]').first().click();
    await expand(compact, '[data-quest-completion]');
    const completion = compact.locator('[data-quest-completion]');
    for (const id of [1003, 1004, 1005])
      await completion.locator('[data-action="database-detail"][data-id="item-' + id + '"]').waitFor();
    await completion.getByText('持有 1', { exact: true }).waitFor();
    await completion.scrollIntoViewIfNeeded();
    await capture(compact, '04-alternative-gifts');
    checks.push(
      'Alternative hand-ins expose distinct linked item qualities and current counts inside the sidecar codex',
    );
    await compact.locator('[data-action="close-overlay"]').first().click();
    save(12407, 12400, 0, []);
    await compact.locator('.flow-now .flow-next-action').filter({ hasText: '平康城' }).waitFor();
    checks.push('An owned permitted gift switches to its recipient; using it restores the acquisition clue');
    assert.deepEqual(fs.readFileSync(file), expected);
    assert.deepEqual(errors, []);
  } catch (error) {
    errors.push(error.stack);
    process.exitCode = 1;
    console.error(error);
  } finally {
    if (app && errors.length) await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    if (app) await app.close().catch(() => {});
    const result = {
      status: errors.length ? 'FAIL' : 'PASS',
      checks,
      errors,
      out,
      sourceUnchangedByApp: fs.readFileSync(file).equals(expected),
    };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
})();
