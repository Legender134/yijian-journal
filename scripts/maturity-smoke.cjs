'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const base = path.resolve(__dirname, '..');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require(path.join(base, 'src/core/store.cjs'));
const { Saves } = require(path.join(base, 'src/core/saves.cjs'));
const { Timeline } = require(path.join(base, 'src/core/timeline.cjs'));
const migration = require(path.join(base, 'src/core/migration.cjs'));
const complete = require(path.join(base, 'src/core/complete-migration.cjs'));
const { ProtectionArchives } = require(path.join(base, 'src/core/protection-archives.cjs'));
const { syntheticSave } = require(path.join(base, 'tests/fixtures.cjs'));
const catalog = require(path.join(base, 'src/data/catalog.cjs'));
const game = require(path.join(base, 'src/data/game-index.json'));
const data = path.join(base, '.test-data', 'maturity-ui-' + Date.now()),
  oldData = path.join(data, '旧机器资料'),
  currentData = path.join(data, '新机器资料');
const oldGame = path.join(data, '旧合成游戏目录'),
  currentGame = path.join(currentData, 'synthetic-SaveGames');
const importedPackage = path.join(data, '完整换机资料.yijian-protection'),
  exportedPackage = path.join(data, '当前保护资料.yijian-protection');
const at = new Date(Date.now() - 5000);
for (const dir of [oldGame, currentGame]) fs.mkdirSync(dir, { recursive: true });
const save = (seconds) =>
  syntheticSave({
    full: true,
    seconds,
    inventory: [
      { id: 100, count: 2 },
      { id: 10226, count: 6 },
      { id: 10220, count: 2 },
      { id: 10205, count: 10 },
      { id: 10207, count: 3 },
    ],
    quests: [
      { id: 5053, step: 1 },
      { id: 13803, step: 1 },
      { id: 14052, step: 1 },
      { id: 14073, step: 1 },
    ],
  });
for (const [dir, seconds] of [
  [oldGame, 1000],
  [currentGame, 2000],
]) {
  fs.writeFileSync(path.join(dir, '1.sav'), save(seconds));
  fs.writeFileSync(path.join(dir, 'JHSaveConfig.sav'), Buffer.from('synthetic-index-' + seconds));
}
fs.writeFileSync(path.join(currentGame, '28.sav'), Buffer.from('foreign-unrelated-28'));
fs.writeFileSync(path.join(currentGame, '29.sav'), Buffer.from('foreign-unrelated-29'));
for (const dir of [oldGame, currentGame])
  for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), at, at);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const foreign = Object.fromEntries(['28.sav', '29.sav'].map((n) => [n, hash(path.join(currentGame, n))]));
const old = new Store(oldData, catalog);
old.setPath('savePath', oldGame);
old.mutate({ type: 'settings', value: { autoBackup: false } });
old.mutate({ type: 'note', value: '旧机器笔记：迁移保留这些中文文字' });
old.mutate({
  type: 'goal-add',
  title: '按原数收集药草',
  source: { type: 'database', id: 'item-100', quantity: 37 },
});
old.mutate({
  type: 'goal-add',
  title: '按原数准备配方',
  source: { type: 'database', id: 'alchemy-100', quantity: 9 },
});
old.mutate({
  type: 'craft-plan-save',
  name: '旧机器独立制作计划',
  list: [{ id: 'fusion-1000', quantity: 2 }],
  addGoal: true,
});
const backup = new Saves(path.join(oldData, 'save-backups')).capture(oldGame, '旧机器完整保护');
const timeline = new Timeline(path.join(oldData, 'game-timeline'));
timeline.configure(oldGame, false, 30);
const node = timeline.record(fs.readFileSync(path.join(oldGame, '1.sav')), 'manual');
timeline.updateNode(node.id, { bookmarked: true, label: '迁移验收书签', note: '历史节点说明不能丢失' });
const store = new Store(currentData, catalog);
store.setPath('savePath', currentGame);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'craft-set', id: 'fusion-1002', quantity: 3 });
const before = hash(path.join(currentGame, '1.sav')),
  oldHash = hash(path.join(oldGame, '1.sav'));
assert.notEqual(before, oldHash);
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
const checks = [],
  errors = [];
let app, pid;
async function nav(page, id) {
  await page.locator('.nav-btn[data-id="' + id + '"]').click();
}
async function dialogAnswer(value) {
  await app.evaluate(({ dialog }, response) => {
    globalThis.maturityDialogResponses = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.maturityDialogResponses.push({ response, title: args.at(-1)?.title });
      return { response };
    };
  }, value);
}
async function beginRestoreCycle(page) {
  await page.evaluate(() => {
    window.maturityRestoreEvents = [];
    window.maturityRestoreStop = window.journal.onEvent((event) => {
      if (event.type === 'protection' && event.label === '正在准备迁移备份恢复')
        window.maturityRestoreEvents.push(event);
    });
  });
}
async function finishRestoreCycle(page, response) {
  await page.waitForFunction(
    () =>
      window.maturityRestoreEvents.some((event) => event.busy) &&
      window.maturityRestoreEvents.at(-1)?.busy === false,
    null,
    { timeout: 15000 },
  );
  await page.evaluate(() => window.maturityRestoreStop());
  const answers = await app.evaluate(() => globalThis.maturityDialogResponses);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].response, response);
}
async function multiPlanFlow(page) {
  async function currentState() {
    const r = await page.evaluate(() => window.journal.bootstrap());
    assert.equal(r.ok, true, r.error);
    return r.data.state;
  }
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await currentState();
      if (predicate(state.profiles.find((p) => p.id === state.activeProfileId))) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error('UI mutation did not persist its requested state');
  }
  await page.locator('#craft-qty-fusion-1002').fill('1');
  await page.locator('#craft-qty-fusion-1002').press('Tab');
  await until((p) => p.craftList[0].quantity === 1);
  for (const [i, name] of ['第一份金装', '第二份金装'].entries()) {
    await page.locator('[data-action="craft-plan-dialog"]').first().click();
    await page.locator('#craft-plan-name').fill(name);
    await page.locator('[data-action="craft-plan-save"]').click();
    await until((p) => p.craftPlans.length === i + 1);
    await page.locator('#craft-plan-name').waitFor({ state: 'hidden' });
  }
  await page.locator('[data-action="craft-review"]').click();
  await page.waitForSelector('.crafting-stages');
  const state = await currentState(),
    p = state.profiles.find((p) => p.id === state.activeProfileId);
  const reply = await page.evaluate((list) => window.journal.materialPlan(list, '1.sav'), p.craftList);
  assert.equal(reply.ok, true, reply.error);
  const budget = reply.data.sharedBudget;
  assert.equal(budget.crafts.length, 2);
  assert.equal(budget.physicalUsed[10207], 3);
  assert.equal(budget.baseMaterialMissingTotal, 1);
  assert.equal(budget.directMissingTotal, 4);
  assert.equal(budget.physicalUsed[10221], undefined);
  assert.match(await page.locator('.content').innerText(), /按加工安排的原料还差 1 件/);
  assert.match(await page.locator('.crafting-stages').innerText(), /计划产物/);
  const stages = reply.data.stages;
  assert.deepEqual(stages, budget.crafts.find((c) => c.id === p.activeCraftPlanId).processing);
  checks.push('界面保存两份制作计划，共用三份金矿石，原料缺一份，预计金锭不算物理库存');
  await page.screenshot({ path: path.join(data, 'joint-processing.png') });
}
(async () => {
  try {
    await migration.exportProtection({ dataRoot: oldData, file: importedPackage });
    const env = { ...process.env, YIJIAN_TEST_DATA: currentData, YIJIAN_TEST_HIDDEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
      timeout: 30000,
    });
    pid = app.process().pid;
    await app.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.imported] });
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.exported });
        dialog.showMessageBox = async () => ({ response: 1 });
      },
      { imported: importedPackage, exported: exportedPackage },
    );
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForSelector('.layout');
    await nav(page, 'materials');
    await page.waitForSelector('.crafting-stages');
    assert.match(await page.locator('.crafting-stages').innerText(), /金锭\s*× 6/);
    assert.match(await page.locator('.crafting-stages').innerText(), /还不是背包库存/);
    await page.screenshot({ path: path.join(data, 'crafting-stages.png'), fullPage: false });
    checks.push('真实界面展开金矿石→金锭→成品，最小产量与未知条件可见');
    await multiPlanFlow(page);
    await nav(page, 'journey');
    assert.equal((await page.locator('.journey-action').count()) > 3, true);
    await page.locator('[data-action="journey-todo-dialog"]').first().click();
    await page.locator('#journey-title').fill('去药铺 <script>文字验收');
    await page.locator('#journey-note').fill('这只是文本，保留中文与标点');
    await page.locator('#journey-place-search').fill('place-22');
    await page.locator('#journey-place').selectOption('place-22');
    await page.locator('[data-action="journey-intent-save"]').click();
    const todo = page.locator('.journey-action').filter({ hasText: '去药铺 <script>文字验收' });
    await todo.waitFor();
    assert.equal(await todo.locator('script').count(), 0);
    await todo.locator('[data-action="journey-handle"]').click();
    assert.equal(await todo.count(), 0);
    await page.locator('[data-action="journey-show-completed"]').click();
    assert.match(await todo.innerText(), /手动已处理/);
    const recoveryReadability = await todo.locator('[data-action="journey-handle"]').evaluate((button) => {
      const rgb = (color) => (color.match(/[\d.]+/g) || []).map(Number);
      const blend = (color, background, alpha = color[3] ?? 1) =>
        color.slice(0, 3).map((v, i) => v * alpha + background[i] * (1 - alpha));
      const luminance = (color) =>
        color
          .map((v) => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ancestors = [];
      for (let el = button; el; el = el.parentElement) ancestors.unshift(el);
      const group = button.closest('.journey-action');
      let background = [255, 255, 255],
        behind;
      for (const el of ancestors) {
        if (el === group) behind = [...background];
        background = blend(rgb(getComputedStyle(el).backgroundColor), background);
      }
      const opacity = Number(getComputedStyle(group).opacity),
        foreground = blend(rgb(getComputedStyle(button).color), background);
      const levels = [
        luminance(blend(foreground, behind, opacity)),
        luminance(blend(background, behind, opacity)),
      ].sort((a, b) => b - a);
      return {
        text: button.textContent.trim(),
        enabled: !button.disabled,
        contrast: (levels[0] + 0.05) / (levels[1] + 0.05),
      };
    });
    assert(
      recoveryReadability.enabled && recoveryReadability.contrast >= 4.5,
      JSON.stringify(recoveryReadability),
    );
    await page.screenshot({ path: path.join(data, 'handled-recovery-readable.png') });
    await todo.locator('[data-action="journey-handle"]').click();
    assert.match(await todo.innerText(), /个人待办/);
    checks.push('带地点个人待办持久保存、转义、处理与撤回，和游戏完成分开');
    const npc = game.entries.find((e) => e.id === 'npc-5014');
    assert(npc);
    await page.locator('[data-action="search"]').click();
    await page.locator('#global-search').fill(npc.name);
    await page.locator('#global-results [data-action="database-detail"][data-id="' + npc.id + '"]').click();
    await page.locator('.drawer-actions [data-action="journey-gift-dialog"]').click();
    await page
      .locator('#journey-item-search')
      .fill(game.entries.find((entry) => entry.id === 'item-100').name);
    await page.locator('#journey-item').selectOption('item-100');
    await page.locator('#journey-quantity').fill('2');
    await page.locator('[data-action="journey-intent-save"]').click();
    await page.locator('[data-action="search"]').click();
    await page.locator('#global-search').fill(npc.name);
    await page.locator('#global-results [data-action="database-detail"][data-id="' + npc.id + '"]').click();
    await page.locator('.drawer-actions [data-action="journey-gift-dialog"]').click();
    await page
      .locator('#journey-item-search')
      .fill(game.entries.find((entry) => entry.id === 'item-100').name);
    await page.locator('#journey-item').selectOption('item-100');
    await page.locator('#journey-quantity').fill('2');
    await page.locator('[data-action="journey-intent-save"]').click();
    const journey = await page.evaluate(async () => {
      const r = await window.journal.journeyPlan();
      if (!r.ok) throw Error(r.error);
      return r.data;
    });
    const gifts = journey.actions.filter((a) => a.kind === 'gift');
    assert.equal(gifts.length, 2);
    assert.equal(
      gifts.reduce((sum, a) => sum + a.gift.allocated, 0),
      2,
    );
    assert.equal(
      gifts.reduce((sum, a) => sum + a.gift.missing, 0),
      2,
    );
    await page.screenshot({ path: path.join(data, 'journey.png') });
    checks.push('两个赠礼计划共同分配两件库存，明确缺两件，不重复消费');
    await nav(page, 'settings');
    await page.locator('[data-action="protection-import"]').click();
    await page.waitForSelector('[data-action="protection-backup-select"]');
    assert.match(await page.locator('.content').innerText(), /迁移验收书签/);
    assert.match(await page.locator('.content').innerText(), /历史节点说明不能丢失/);
    const historicalProfile = page
      .locator('.content details.detail-block')
      .filter({ has: page.locator('summary', { hasText: '件目标' }) })
      .first();
    await historicalProfile.locator(':scope > summary').click();
    await historicalProfile.locator('summary', { hasText: '目标记录' }).click();
    const historicalGoals = await historicalProfile
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: '目标记录' }) })
      .innerText();
    assert.match(historicalGoals, /按原数收集药草[\s\S]*收集数量：37 件/);
    assert.match(historicalGoals, /按原数准备配方[\s\S]*配方次数：9 次/);
    assert.equal(hash(path.join(currentGame, '1.sav')), before);
    await page.screenshot({
      path: path.join(data, 'historical-goal-quantities.png'),
      animations: 'disabled',
    });
    checks.push('只读历史目标按保存值显示自定义标题、37件收集目标和9次配方，未替换手札或改写存档');
    assert.equal(hash(path.join(currentGame, '1.sav')), before);
    await page.locator('[data-action="protection-backup-select"]').click();
    await page.locator('[data-action="protection-backup-inspect"][data-id="1.sav"]').click();
    await page.waitForSelector('[aria-label="历史存档只读回顾"]');
    assert.match(await page.locator('[aria-label="历史存档只读回顾"]').innerText(), /未绑定本机/);
    await page.locator('[data-action="close-overlay"]').click();
    checks.push('完整迁移保留备份、中文手札、书签说明并可只读解析历史存档');
    const liveBackups = new Saves(path.join(currentData, 'save-backups'));
    const beforeRestoreBackupIds = liveBackups
      .list()
      .map((backup) => backup.id)
      .sort();
    const activityFile = path.join(currentData, 'activity.json');
    const beforeRestoreEvents = JSON.parse(fs.readFileSync(activityFile, 'utf8')).events;
    await dialogAnswer(0);
    await beginRestoreCycle(page);
    await page.locator('[data-action="protection-restore"]').click();
    await finishRestoreCycle(page, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(activityFile, 'utf8')).events, beforeRestoreEvents);
    assert.equal(hash(path.join(currentGame, '1.sav')), before);
    assert.deepEqual(
      liveBackups
        .list()
        .map((backup) => backup.id)
        .sort(),
      beforeRestoreBackupIds,
    );
    for (const [n, digest] of Object.entries(foreign)) assert.equal(hash(path.join(currentGame, n)), digest);
    await dialogAnswer(1);
    await beginRestoreCycle(page);
    await page.locator('[data-action="protection-restore"]').click();
    await finishRestoreCycle(page, 1);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((node) =>
        node.innerText.includes('完整备份已恢复，恢复前的完整进度已保留'),
      ),
    );
    assert.equal(hash(path.join(currentGame, '1.sav')), oldHash);
    const safety = liveBackups.list().find((b) => b.kind === 'safety');
    assert(safety);
    const restoreReceipt = JSON.parse(fs.readFileSync(activityFile, 'utf8')).events[0];
    assert.equal(restoreReceipt.level, 'success');
    for (const value of ['旧机器完整保护', currentGame.slice(0, 220), safety.id])
      assert(restoreReceipt.message.includes(value));
    assert.match(restoreReceipt.message, /已恢复 2 个文件/);
    assert.equal(
      crypto.createHash('sha256').update(liveBackups.verify(safety.id).buffers.get('1.sav')).digest('hex'),
      before,
    );
    for (const [n, digest] of Object.entries(foreign)) assert.equal(hash(path.join(currentGame, n)), digest);
    checks.push('取消恢复不写游戏；确认恢复先验证安全副本，其他28/29槽字节保留');
    const reexportedPackage = path.join(data, '历史再次换机.yijian-protection');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, reexportedPackage);
    await page.locator('[data-action="protection-history-export"]').click();
    await page.locator('.toast').filter({ hasText: '历史保护包已校验 ·' }).waitFor();
    assert.equal(hash(reexportedPackage), hash(importedPackage));
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, exportedPackage);
    checks.push('再次换机可重新导出全部历史，保护包字节与原包完全一致');
    await page.locator('[data-action="protection-use-journal"]').click();
    await page.locator('.toast').filter({ hasText: '历史手札已使用，替换前的本机手札副本已保留' }).waitFor();
    const live = JSON.parse(fs.readFileSync(path.join(currentData, 'journal.json'), 'utf8'));
    assert.equal(live.settings.savePath, currentGame);
    assert.equal(live.profiles[0].referenceMode, 'none');
    assert.equal(live.profiles[0].craftPlans[0].name, '旧机器独立制作计划');
    assert(fs.readdirSync(currentData).some((n) => n.startsWith('journal-before-import-')));
    await page.locator('[data-action="protection-export"]').click();
    await page.locator('.toast').filter({ hasText: '保护包已校验 ·' }).waitFor();
    const exported = await complete.previewComplete({
      archives: new ProtectionArchives(currentData, () => currentGame),
      file: exportedPackage,
    });
    assert(exported.backups.length >= 2);
    assert.equal(exported.historicalArchives, 1);
    checks.push('使用历史手札前保留当前副本，保持本机路径并重新导出可校验保护包');
    await page.screenshot({ path: path.join(data, 'imported-history.png') });
    await nav(page, 'saves');
    await page
      .locator('.backup-row [data-action="backup-preview"][data-id="' + safety.id + '"]')
      .click();
    await page.locator('[data-backup-preview-state="verified"]').waitFor();
    const beforeLocalEvents = JSON.parse(fs.readFileSync(activityFile, 'utf8')).events;
    const beforeLocalBackupIds = liveBackups
      .list()
      .map((b) => b.id)
      .sort();
    await dialogAnswer(0);
    await page.locator('[data-action="restore"]').click();
    await page.locator('[data-backup-preview-state="invalid"]').waitFor();
    assert.equal((await app.evaluate(() => globalThis.maturityDialogResponses)).length, 1);
    assert.equal(await page.locator('[data-action="restore"]').count(), 0);
    assert(
      (await page.locator('[aria-label="备份预览"]').innerText()).includes('已取消恢复，旧预览已失效'),
    );
    assert((await page.evaluate(() => window.journal.bootstrap())).ok);
    assert.deepEqual(JSON.parse(fs.readFileSync(activityFile, 'utf8')).events, beforeLocalEvents);
    assert.deepEqual(
      liveBackups
        .list()
        .map((b) => b.id)
        .sort(),
      beforeLocalBackupIds,
    );
    assert.equal(hash(path.join(currentGame, '1.sav')), oldHash);
    for (const [n, digest] of Object.entries(foreign)) assert.equal(hash(path.join(currentGame, n)), digest);
    await page
      .locator('[data-backup-preview-state="invalid"] [data-action="backup-preview"][data-id="' + safety.id + '"]')
      .click();
    await page.locator('[data-backup-preview-state="verified"]').waitFor();
    await dialogAnswer(1);
    await page.locator('[data-action="restore"]').click();
    await page.locator('.toast').filter({ hasText: '已恢复 4 个文件，恢复前副本已保留' }).waitFor();
    const localReceipt = JSON.parse(fs.readFileSync(activityFile, 'utf8')).events[0];
    const localSafety = liveBackups
      .list()
      .find((b) => b.kind === 'safety' && !beforeLocalBackupIds.includes(b.id));
    assert(localSafety);
    assert.equal(localReceipt.level, 'success');
    for (const value of [safety.label, currentGame.slice(0, 220), localSafety.id])
      assert(localReceipt.message.includes(value));
    assert.match(localReceipt.message, /完整备份[\s\S]*已恢复 4 个文件/);
    assert.equal(
      crypto
        .createHash('sha256')
        .update(liveBackups.verify(localSafety.id).buffers.get('1.sav'))
        .digest('hex'),
      oldHash,
    );
    assert.equal(hash(path.join(currentGame, '1.sav')), before);
    for (const [n, digest] of Object.entries(foreign)) assert.equal(hash(path.join(currentGame, n)), digest);
    await app.close();
    app = null;
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
      timeout: 30000,
    });
    pid = app.process().pid;
    const restarted = await app.firstWindow();
    restarted.on('pageerror', (e) => errors.push(e.message));
    await restarted.waitForSelector('.layout');
    await nav(restarted, 'saves');
    const operationHistory = restarted.locator('.operation-history');
    assert((await operationHistory.innerText()).includes(restoreReceipt.message));
    assert((await operationHistory.innerText()).includes(localReceipt.message));
    assert(
      JSON.parse(fs.readFileSync(activityFile, 'utf8')).events.some(
        (event) => event.at === restoreReceipt.at && event.message === restoreReceipt.message,
      ),
    );
    assert.equal(hash(path.join(currentGame, '1.sav')), before);
    for (const [n, digest] of Object.entries(foreign)) assert.equal(hash(path.join(currentGame, n)), digest);
    await restarted.screenshot({ path: path.join(data, 'restore-receipt-restarted.png') });
    checks.push(
      '历史完整恢复留下目标与安全副本的持久成功回执，取消不记成功，冷重启后操作结果与恢复字节可核对',
    );
    checks.push(
      '本机完整恢复取消后旧预览失效且保留全部字节、不记成功；重新校验确认后核对4个文件、安全副本与外来28/29槽，冷重启显示两类恢复回执',
    );
    assert.deepEqual(errors, []);
    assert.equal(await restarted.locator('.toast.error').count(), 0);
    fs.writeFileSync(
      path.join(base, 'test-results', 'maturity-flows-ui-result.json'),
      JSON.stringify(
        { status: 'PASS', data, checks, errors, pid, foreign, at: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, data }));
  } catch (e) {
    fs.writeFileSync(
      path.join(base, 'test-results', 'maturity-flows-ui-result.json'),
      JSON.stringify(
        { status: 'FAIL', data, checks, errors, error: e.stack, pid, at: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (app) {
      const processHandle = app.process();
      await app.close();
      fs.writeFileSync(
        path.join(data, 'process-exit.json'),
        JSON.stringify(
          {
            pid,
            exitCode: processHandle.exitCode,
            signalCode: processHandle.signalCode,
            closedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }
  }
})();
