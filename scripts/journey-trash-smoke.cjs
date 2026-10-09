'use strict';
// Single personal-arrangement recovery in real windows; synthetic journal/saves only.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto');
const { _electron } = require('playwright'),
  { Store } = require('../src/core/store.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs'),
  game = require('../src/data/game-index.json');
const base = path.resolve(__dirname, '..'),
  override = process.env.YIJIAN_EXECUTABLE,
  executable = path.join(
    base,
    'dist',
    'v' + require('../package.json').version,
    '逸剑手札-win32-x64',
    '逸剑手札.exe',
  );
if (override && path.resolve(override).toLowerCase() !== executable.toLowerCase())
  throw Error('只接受本候选实际EXE');
const data = path.join(base, '.test-data', 'journey-trash-' + Date.now()),
  userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames'),
  results = path.join(base, 'test-results');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(results, { recursive: true });
const file = path.join(source, '1.sav');
fs.writeFileSync(file, syntheticSave({ full: true, inventory: [] }));
const stamp = new Date(Date.now() - 5000);
fs.utimesSync(file, stamp, stamp);
const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  initialSaveHash = hash();
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
const npcId = game.entries.find((e) => e.kind === '人物').id,
  itemId = game.entries.find((e) => e.kind === '物品' && e.giftable && e.quality === '蓝').id;
store.mutate({
  type: 'journey-todo-put',
  id: 'original-todo',
  title: '误删前的事项',
  detail: '完整原文\n说明末尾可搜索：保留原文',
  placeId: 'place-9',
  done: false,
});
store.mutate({
  type: 'journey-gift-put',
  id: 'original-gift',
  npcId,
  itemId,
  quantity: 7,
  placeId: 'place-9',
  note: '蓝品质赠礼的精确安排',
  done: false,
});
store.mutate({
  type: 'journey-place-put',
  placeId: 'place-9',
  note: '原地点计划',
  favorite: true,
  done: false,
});
store.mutate({
  type: 'goal-add',
  title: '误删前的行囊目标',
  detail: '目标的完整原文\n原末行',
  source: { type: 'database', id: 'fusion-1000', quantity: 3 },
});
const goalId = store.get().profiles[0].goals[0].id;
store.mutate({
  type: 'craft-plan-save',
  name: '原备料计划目标',
  list: [{ id: 'fusion-1000', quantity: 2 }],
  addGoal: true,
});
const plan = store.get().profiles[0].craftPlans[0],
  planGoalId = store.get().profiles[0].goals[0].id;
store.mutate({
  type: 'goal-edit',
  id: planGoalId,
  title: '原备料计划目标',
  detail: '备料计划已移除后仍应可继续的全文\n完整末行',
});
store.mutate({ type: 'goal-pin', id: planGoalId });
store.mutate({
  type: 'craft-plan-save',
  name: '完整待找回制作计划',
  list: [
    { id: 'fusion-1000', quantity: 3 },
    { id: 'fusion-1001', quantity: 2 },
  ],
  choices: { 10216: 'fusion-9500' },
  reserved: true,
});
const recoverablePlan = store.get().profiles[0].craftPlans.find((p) => p.name === '完整待找回制作计划');
const originals = structuredClone(store.get().profiles[0].journey),
  journal = path.join(data, '原安排.json'),
  protection = path.join(data, '已移除安排.yijian-protection');
let app, page, companion;
const checks = [],
  errors = [];
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'YIJIAN_EXECUTABLE', 'YIJIAN_TEST_HIDDEN', 'YIJIAN_TEST_TRAY'])
    delete env[key];
  for (const key of Object.keys(env)) if (/^YIJIAN_GAME.*(?:PATH|EXECUTABLE|EXE)$/.test(key)) delete env[key];
  app = await _electron.launch({
    executablePath: override ? executable : require('electron'),
    args: override ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.layout').waitFor();
}
async function current() {
  const r = await page.evaluate(() => window.journal.bootstrap());
  assert(r.ok, r.error);
  return r.data.state.profiles.find((p) => p.id === r.data.state.activeProfileId);
}
async function until(predicate) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const p = await current();
    if (predicate(p)) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('个人安排操作未完成');
}
async function nav(route) {
  await page.locator('.nav-btn[data-id="' + route + '"]').click();
}
async function editor(kind, target = page) {
  const selector =
    kind === 'todo'
      ? '[data-action="journey-todo-dialog"][data-id="original-todo"]'
      : kind === 'gift'
        ? '[data-action="journey-gift-edit"][data-id="original-gift"]'
        : '[data-action="journey-place-dialog"][data-id="place-9"]';
  const button = target.locator(selector).first();
  if (!(await button.isVisible()))
    await button.locator('xpath=ancestor::details[1]').locator('summary').first().click();
  await button.click();
}
async function remove(kind, target = page) {
  await editor(kind, target);
  await target.locator('[data-action="journey-intent-remove"]').click();
  await target.locator('[data-action="journey-intent-remove-confirm"]').click();
  await until((p) => p.journeyTrash?.some((r) => r.kind === kind));
}
async function written(file) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.statSync(file).size) return fs.readFileSync(file);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('导出未完成');
}
(async () => {
  try {
    await launch();
    await nav('journey');
    const scenes = page.locator('details[data-persist-detail^="journey-location:"]').first();
    const sceneKey = await scenes.getAttribute('data-persist-detail');
    await scenes.locator('summary').click();
    const redrawn = await page.evaluate(() =>
      window.journal.mutate({ type: 'settings', value: { spoiler: 'hints' } }),
    );
    assert(redrawn.ok, redrawn.error);
    await page.waitForFunction(
      (key) => document.querySelector('details[data-persist-detail="' + key + '"]')?.open,
      sceneKey,
    );
    await editor('todo');
    await page.locator('[data-action="journey-intent-remove"]').click();
    assert.match(await page.locator('#overlay').innerText(), /准备移除，尚未确认/);
    await page.keyboard.press('Escape');
    assert.equal((await current()).journey.todos.length, 1);
    assert.equal(await page.locator('#journey-title').count(), 1);
    await page.keyboard.press('Escape');
    for (const kind of ['todo', 'gift', 'place']) {
      for (const cancel of ['button', 'escape', 'backdrop']) {
        await editor(kind);
        await page.locator('#journey-note').fill('\n取消后继续 ' + kind + ' / ' + cancel + '\n末尾保留  ');
        if (kind === 'todo') await page.locator('#journey-title').fill('正在修改的待办 ' + cancel);
        if (kind === 'gift') await page.locator('#journey-quantity').fill('7');
        await page.locator('#journey-done').check();
        const before = await page.locator('#overlay').evaluate((el) => {
          const modal = el.querySelector('.modal');
          modal.scrollTop = modal.scrollHeight;
          return {
            values: [...el.querySelectorAll('input,textarea,select')].map((n) => ({
              id: n.id,
              value: n.value,
              checked: n.checked,
            })),
            scroll: modal.scrollTop,
          };
        });
        await page.locator('[data-action="journey-intent-remove"]').click();
        if (cancel === 'escape') await page.keyboard.press('Escape');
        else if (cancel === 'backdrop') await page.locator('.overlay-backdrop').evaluate((el) => el.click());
        else await page.locator('.modal-footer [data-action="close-overlay"]').click();
        const after = await page.locator('#overlay').evaluate((el) => ({
          values: [...el.querySelectorAll('input,textarea,select')].map((n) => ({
            id: n.id,
            value: n.value,
            checked: n.checked,
          })),
          scroll: el.querySelector('.modal').scrollTop,
          focus: document.activeElement?.dataset.action,
        }));
        assert.deepEqual(after.values, before.values);
        assert.equal(after.scroll, before.scroll);
        assert.equal(after.focus, 'journey-intent-remove');
        assert.deepEqual((await current()).journey, originals);
        await page.keyboard.press('Escape');
      }
    }
    checks.push('三类安排取消移除经按钮、Esc与背景返回原编辑，输入、选择、滚动和焦点保留，正式记录不变');
    await remove('todo');
    await remove('gift');
    await remove('place');
    let p = await current();
    assert.equal(p.journeyTrash.length, 3);
    assert.equal(p.journey.todos.length, 0);
    assert.equal(p.journey.gifts.length, 0);
    assert.equal(p.journey.places.length, 0);
    await page.locator('[data-action="journey-todo-dialog"]:not([data-id])').click();
    await page.locator('#journey-title').fill('后来新增的安排');
    await page.locator('#journey-note').fill('必须保留的后续内容');
    await page.locator('[data-action="journey-intent-save"]').click();
    await page.locator('[data-action="journey-trash-open"]').click();
    await page.locator('#journey-trash-query').fill('保留原文');
    assert.equal(await page.locator('[data-journey-trash-id]').count(), 1);
    await page.locator('[data-action="journey-trash-detail"]').click();
    assert.match(await page.locator('#overlay').innerText(), /完整原文\s+说明末尾可搜索/);
    await page.keyboard.press('Escape');
    const todoTrash = (await current()).journeyTrash.find((r) => r.kind === 'todo');
    await page.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.keyboard.press('Escape');
    assert.equal((await current()).journey.todos.length, 1);
    await page.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.journey.todos.some((r) => r.id === 'original-todo'));
    assert.deepEqual(
      p.journey.todos.find((r) => r.id === 'original-todo'),
      originals.todos[0],
    );
    assert(p.journey.todos.some((r) => r.title === '后来新增的安排'));
    assert(!p.journeyTrash.some((r) => r.id === todoTrash.id));
    await page.locator('#journey-trash-query').fill('');
    for (const kind of ['gift', 'place']) {
      const row = (await current()).journeyTrash.find((r) => r.kind === kind);
      await page.locator('[data-action="journey-trash-restore-preview"][data-id="' + row.id + '"]').click();
      await page.locator('[data-action="journey-trash-confirm"]').click();
      await until((p) => !p.journeyTrash.some((r) => r.id === row.id));
    }
    p = await current();
    assert.deepEqual(p.journey.gifts, originals.gifts);
    assert.deepEqual(p.journey.places, originals.places);
    checks.push('三类移除可取消并完整保留，正文全文可搜索，逐条找回精确引用且保留后来内容');
    await page.locator('[data-action="journey-trash-close"]').click();
    await remove('todo');
    await page.locator('[data-action="journey-trash-open"]').click();
    const oldTrash = (await current()).journeyTrash.find((r) => r.kind === 'todo');
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await created;
    companion.on('pageerror', (e) => errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await page.locator('[data-action="journey-trash-purge-preview"][data-id="' + oldTrash.id + '"]').click();
    const r = await companion.evaluate((command) => window.journal.mutate(command), {
      type: 'journey-trash-restore',
      id: oldTrash.id,
      expectedTrash: oldTrash,
    });
    assert(r.ok, r.error);
    const again = await companion.evaluate((command) => window.journal.mutate(command), {
      type: 'journey-todo-remove',
      id: 'original-todo',
      expectedRecord: originals.todos[0],
    });
    assert(again.ok, again.error);
    await page.locator('[data-action="journey-trash-confirm"]').click();
    await page.waitForFunction(() => /已变化|不存在/.test(document.querySelector('#toasts').textContent));
    p = await current();
    assert.equal(p.journeyTrash.length, 1);
    assert.notEqual(p.journeyTrash[0].id, oldTrash.id);
    await page.keyboard.press('Escape');
    checks.push('另一个窗口找回并再次移除后，旧永久清除确认被阻断，新删除实例保留');
    await nav('journal');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, journal);
    await page.locator('[data-action="journal-export"]').click();
    const exported = JSON.parse(await written(journal));
    assert.equal(exported.profiles[0].journeyTrash.length, 1);
    await nav('saves');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, protection);
    await page.locator('[data-action="protection-export"]').click();
    await written(protection);
    await page.waitForFunction(() => !document.querySelector('[data-action="protection-export"]')?.disabled);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, protection);
    await page.locator('[data-action="protection-import"]').click();
    const historical = page.locator('.journey-trash-panel').first();
    await historical.waitFor({ state: 'attached' });
    await historical.locator('xpath=ancestor::details[1]').locator('summary').first().click();
    assert.equal(await historical.locator('[data-action="journey-trash-restore-preview"]').count(), 0);
    await historical.locator('[data-action="historical-journey-trash-detail"]').click();
    assert.match(await page.locator('#overlay').innerText(), /完整原文/);
    await page.keyboard.press('Escape');
    assert.equal((await current()).journeyTrash.length, 1);
    checks.push('JSON和完整保护包携带已移除安排，历史只读完整回顾不替换当前手札');
    await nav('journey');
    const row = (await current()).journeyTrash[0];
    await page.locator('[data-action="journey-trash-purge-preview"][data-id="' + row.id + '"]').click();
    await page.keyboard.press('Escape');
    assert.equal((await current()).journeyTrash.length, 1);
    await page.locator('[data-action="journey-trash-purge-preview"][data-id="' + row.id + '"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    await until((p) => p.journeyTrash.length === 0);
    await app.close();
    app = null;
    await launch();
    p = await current();
    assert.equal(p.journeyTrash.length, 0);
    assert(p.journey.todos.some((r) => r.title === '后来新增的安排'));
    assert.deepEqual(p.journey.gifts, originals.gifts);
    assert.deepEqual(p.journey.places, originals.places);
    checks.push('明确永久清除只影响所选项，冷重启保留后来安排与其他已找回对象');
    await nav('goals');
    await page.locator('[data-action="goal-edit"][data-id="' + goalId + '"]').click();
    await page.locator('#goal-detail').fill('小窗继续编写的目标全文\n末尾可搜索：保留最新目标');
    await page.keyboard.press('Escape');
    p = await until((p) => p.intentDrafts?.some((d) => d.kind === 'goal' && d.targetId === goalId));
    const goalDraft = p.intentDrafts.find((d) => d.kind === 'goal' && d.targetId === goalId);
    const goalWindow = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await goalWindow;
    companion.on('pageerror', (e) => errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    await page.locator('[data-action="goal-remove"][data-id="' + goalId + '"]').click();
    assert.match(await page.locator('#overlay').innerText(), /目标的完整原文/);
    await page.keyboard.press('Escape');
    assert((await current()).goals.some((g) => g.id === goalId));
    await page.locator('[data-action="goal-remove"][data-id="' + goalId + '"]').click();
    await companion.locator('[data-action="intent-drafts"]').first().click();
    const resume = companion
      .locator('[data-action="intent-draft-resume"][data-id="' + goalDraft.id + '"]')
      .first();
    const details = resume.locator('xpath=ancestor::details');
    for (let i = 0; i < (await details.count()); i++)
      if ((await details.nth(i).getAttribute('open')) === null)
        await details.nth(i).locator(':scope > summary').click();
    await resume.click();
    await companion.locator('#goal-title').fill('小窗保存后的新目标');
    await companion.locator('[data-action="goal-save"]').click();
    p = await until((p) => p.goals.some((g) => g.id === goalId && g.title === '小窗保存后的新目标'));
    const latestGoal = p.goals.find((g) => g.id === goalId),
      beforeStale = fs.readFileSync(path.join(userData, 'journal.json'));
    await page.locator('[data-action="goal-remove-confirm"]').click();
    await page.waitForFunction(() => /已变化/.test(document.querySelector('#toasts').textContent));
    assert.deepEqual(
      (await current()).goals.find((g) => g.id === goalId),
      latestGoal,
    );
    assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), beforeStale);
    assert.equal((await current()).journeyTrash.length, 0);
    await page.keyboard.press('Escape');
    checks.push('真实主窗旧删除确认阻断小窗后来保存的新标题与全文，原目标和文件字节完整保留');
    await page.locator('[data-action="goal-remove"][data-id="' + goalId + '"]').click();
    assert.match(await page.locator('#overlay').innerText(), /保留最新目标/);
    await page.locator('[data-action="goal-remove-confirm"]').click();
    p = await until((p) => p.journeyTrash.some((r) => r.kind === 'goal'));
    const goalTrash = p.journeyTrash.find((r) => r.kind === 'goal');
    assert.deepEqual(goalTrash.record, latestGoal);
    await page.locator('[data-action="goal-add"]').first().click();
    await page.locator('#goal-title').fill('移除后新增的另一个目标');
    await page.locator('[data-action="goal-save"]').click();
    await until((p) => p.goals.some((g) => g.title === '移除后新增的另一个目标'));
    await app.close();
    app = null;
    await launch();
    await nav('goals');
    await page.locator('[data-action="journey-trash-open"]').click();
    await page.locator('#journey-trash-query').fill('保留最新目标');
    assert.equal(await page.locator('[data-journey-trash-id]').count(), 1);
    await page.locator('[data-action="journey-trash-detail"]').click();
    assert.match(
      await page.locator('#overlay').innerText(),
      /行囊目标[\s\S]*原资料：图鉴[\s\S]*制作次数 3[\s\S]*保留最新目标/,
    );
    assert(
      (await page.locator('#overlay').innerText()).includes(
        game.entries.find((e) => e.id === 'fusion-1000').name,
      ),
    );
    await page.screenshot({
      path: path.join(results, 'goal-trash-full-content.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.keyboard.press('Escape');
    assert(!(await current()).goals.some((g) => g.id === goalId));
    await page.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.goals.some((g) => g.id === goalId));
    assert.deepEqual(
      p.goals.find((g) => g.id === goalId),
      latestGoal,
    );
    assert(p.goals.some((g) => g.title === '移除后新增的另一个目标'));
    assert.equal(p.journeyTrash.length, 0);
    checks.push(
      '行囊入口在冷重启后可全文查找已移除目标，取消找回保持，单条找回完整引用与次数且保留后来新目标',
    );
    const countedReply = await page.evaluate(() =>
      window.journal.mutate({
        type: 'goal-add',
        title: '数量单位回归的金矿石',
        source: { type: 'database', id: 'item-10207', quantity: 10 },
      }),
    );
    assert(countedReply.ok, countedReply.error);
    p = await until((p) => p.goals.some((g) => g.title === '数量单位回归的金矿石'));
    const countedGoal = p.goals.find((g) => g.title === '数量单位回归的金矿石');
    await nav('goals');
    await page.locator(`[data-action="goal-remove"][data-id="${countedGoal.id}"]`).click();
    assert.match(await page.locator('#overlay').innerText(), /收集数量：10 件/);
    assert(!(await page.locator('#overlay').innerText()).includes('制作次数'));
    await page.screenshot({
      path: path.join(results, 'item-goal-removal-count.png'),
      animations: 'disabled',
    });
    await page.locator('[data-action="goal-remove-confirm"]').click();
    p = await until((p) => p.journeyTrash.some((r) => r.kind === 'goal' && r.record.id === countedGoal.id));
    const countedTrash = p.journeyTrash.find((r) => r.kind === 'goal' && r.record.id === countedGoal.id);
    assert.deepEqual(countedTrash.record, countedGoal);
    await nav('goals');
    await page.locator('[data-action="journey-trash-open"]').click();
    await page.locator('#journey-trash-query').fill('数量单位回归的金矿石');
    await page.locator(`[data-action="journey-trash-restore-preview"][data-id="${countedTrash.id}"]`).click();
    assert.match(await page.locator('#overlay').innerText(), /收集数量：10 件/);
    assert(!(await page.locator('#overlay').innerText()).includes('制作次数'));
    await page.screenshot({
      path: path.join(results, 'item-goal-recovery-count.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    assert(!(await current()).goals.some((g) => g.id === countedGoal.id));
    await page.locator(`[data-action="journey-trash-restore-preview"][data-id="${countedTrash.id}"]`).click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.goals.some((g) => g.id === countedGoal.id));
    assert.deepEqual(
      p.goals.find((g) => g.id === countedGoal.id),
      countedGoal,
    );
    checks.push('物品目标移除与找回均显示收集10件，配方仍按次数，取消不找回，确认精确保留原资料数量');
    await nav('goals');
    await page.locator('[data-action="goal-remove"][data-id="' + planGoalId + '"]').click();
    await page.locator('[data-action="goal-remove-confirm"]').click();
    p = await until((p) => p.journeyTrash.some((r) => r.record.id === planGoalId));
    const archivedPlanGoal = p.journeyTrash.find((r) => r.record.id === planGoalId),
      beforeCopyGoals = p.goals;
    await nav('materials');
    await page.locator('[data-action="craft-plan-remove"][data-id="' + plan.id + '"]').click();
    await page.locator('[data-action="craft-plan-remove-confirm"]').click();
    await until((p) => !p.craftPlans.some((r) => r.id === plan.id));
    await nav('goals');
    await page.locator('[data-action="journey-trash-open"]').click();
    await page.locator('#journey-trash-query').fill('原备料计划目标');
    const archivedGoalRow = page.locator('[data-journey-trash-id="' + archivedPlanGoal.id + '"]');
    await archivedGoalRow.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    await page.waitForFunction(() => /完整目标仍保留/.test(document.querySelector('#toasts').textContent));
    assert.deepEqual(
      (await current()).journeyTrash.find((r) => r.id === archivedPlanGoal.id),
      archivedPlanGoal,
    );
    await page.keyboard.press('Escape');
    await archivedGoalRow.locator('[data-action="journey-trash-copy-goal-preview"]').click();
    assert.match(await page.locator('#overlay').innerText(), /新的手动目标[\s\S]*原完整副本仍保留/);
    await page.keyboard.press('Escape');
    assert.deepEqual((await current()).goals, beforeCopyGoals);
    await archivedGoalRow.locator('[data-action="journey-trash-copy-goal-preview"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.goals.length === beforeCopyGoals.length + 1);
    const independent = p.goals.find((g) => !beforeCopyGoals.some((old) => old.id === g.id));
    assert.notEqual(independent.id, planGoalId);
    assert.equal(independent.title, archivedPlanGoal.record.title);
    assert.equal(independent.detail, archivedPlanGoal.record.detail);
    assert.equal(independent.pinned, true);
    assert.equal(independent.source, undefined);
    assert.equal(independent.progressMode, undefined);
    assert.deepEqual(
      p.goals.filter((g) => g.id !== independent.id),
      beforeCopyGoals,
    );
    assert.deepEqual(
      p.journeyTrash.find((r) => r.id === archivedPlanGoal.id),
      archivedPlanGoal,
    );
    await app.close();
    app = null;
    await launch();
    p = await current();
    assert.deepEqual(
      p.goals.find((g) => g.id === independent.id),
      independent,
    );
    assert.deepEqual(
      p.journeyTrash.find((r) => r.id === archivedPlanGoal.id),
      archivedPlanGoal,
    );
    checks.push(
      '原备料计划已移除时，找回会说明并保留；可取消或明确另存为独立目标，全文与置顶保留且冷重启仍保留原副本和后来目标',
    );
    await nav('materials');
    const beforeCancel = fs.readFileSync(path.join(userData, 'journal.json'));
    await page.locator('[data-action="craft-plan-remove"][data-id="' + recoverablePlan.id + '"]').click();
    const planPreview = await page.locator('#overlay').innerText();
    assert.match(
      planPreview,
      /完整待找回制作计划[\s\S]*制作次数 3[\s\S]*制作次数 2[\s\S]*加工选择：[\s\S]*保留材料[\s\S]*尚未完成/,
    );
    for (const recipeId of ['fusion-1000', 'fusion-1001', 'fusion-9500'])
      assert(planPreview.includes(game.entries.find((entry) => entry.id === recipeId).name));
    assert.match(planPreview, /当前编辑清单保持/);
    await page.keyboard.press('Escape');
    assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), beforeCancel);
    await page.locator('[data-action="craft-plan-remove"][data-id="' + recoverablePlan.id + '"]').click();
    const craftWindow = app.waitForEvent('window');
    await page.evaluate(() => window.journal.compact());
    companion = await craftWindow;
    companion.on('pageerror', (error) => errors.push(error.message));
    await companion.locator('.compact-shell').waitFor();
    const changedPlanResult = await companion.evaluate(
      (plan) =>
        window.journal.mutate({
          type: 'craft-plan-save',
          id: plan.id,
          name: '小窗后来更新的完整计划',
          list: [
            { id: 'fusion-1001', quantity: 4 },
            { id: 'fusion-1000', quantity: 6 },
          ],
          choices: {},
          reserved: false,
        }),
      recoverablePlan,
    );
    assert(changedPlanResult.ok, changedPlanResult.error);
    p = await until((p) =>
      p.craftPlans.some((row) => row.id === recoverablePlan.id && row.name === '小窗后来更新的完整计划'),
    );
    const latestPlan = p.craftPlans.find((row) => row.id === recoverablePlan.id),
      beforeStalePlan = fs.readFileSync(path.join(userData, 'journal.json'));
    await page.locator('[data-action="craft-plan-remove-confirm"]').click();
    await page.waitForFunction(() => /已变化/.test(document.querySelector('#toasts').textContent));
    assert.deepEqual(
      (await current()).craftPlans.find((row) => row.id === latestPlan.id),
      latestPlan,
    );
    assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), beforeStalePlan);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="craft-plan-remove"][data-id="' + latestPlan.id + '"]').click();
    assert.match(
      await page.locator('#overlay').innerText(),
      /小窗后来更新的完整计划[\s\S]*制作次数 4[\s\S]*制作次数 6[\s\S]*不保留材料/,
    );
    await page.locator('[data-action="craft-plan-remove-confirm"]').click();
    p = await until((p) =>
      p.journeyTrash.some((row) => row.kind === 'craft-plan' && row.record.id === latestPlan.id),
    );
    const planTrash = p.journeyTrash.find(
      (row) => row.kind === 'craft-plan' && row.record.id === latestPlan.id,
    );
    assert.deepEqual(planTrash.record, latestPlan);
    assert(await page.locator('[data-action="journey-trash-open"]').isVisible());
    for (const command of [
      { type: 'craft-set', id: 'fusion-1002', quantity: 5 },
      { type: 'craft-choice', itemId: '10216', recipeId: 'fusion-9500' },
      { type: 'craft-draft-reserve', value: false },
      { type: 'goal-add', title: '计划移除后的新目标', detail: '后来目标完整内容' },
      { type: 'note', value: '计划移除后的笔记\n完整末行' },
    ]) {
      const result = await companion.evaluate((command) => window.journal.mutate(command), command);
      assert(result.ok, result.error);
    }
    await app.close();
    app = null;
    await launch();
    await nav('materials');
    await page.locator('[data-action="journey-trash-open"]').click();
    await page.locator('#journey-trash-query').fill('制作次数 6');
    assert.equal(await page.locator('[data-journey-trash-id]').count(), 1);
    await page.locator('[data-action="journey-trash-detail"]').click();
    assert.match(
      await page.locator('#overlay').innerText(),
      /小窗后来更新的完整计划[\s\S]*制作次数 4[\s\S]*制作次数 6[\s\S]*不自动打开或改变当前编辑清单/,
    );
    await page.screenshot({
      path: path.join(results, 'craft-plan-trash-full-content.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.keyboard.press('Escape');
    assert(!(await current()).craftPlans.some((row) => row.id === latestPlan.id));
    const beforePlanRestore = await current();
    await page.locator('[data-action="journey-trash-restore-preview"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => p.craftPlans.some((row) => row.id === latestPlan.id));
    assert.deepEqual(
      p.craftPlans.find((row) => row.id === latestPlan.id),
      latestPlan,
    );
    for (const key of [
      'craftList',
      'craftChoices',
      'reserveCraftDraft',
      'activeCraftPlanId',
      'previousCraftList',
      'previousCraftChoices',
      'previousCraftContext',
      'goals',
      'notes',
      'resourcePriority',
      'journalEntries',
      'journalDrafts',
      'intentDrafts',
    ])
      assert.deepEqual(p[key], beforePlanRestore[key], key);
    assert.deepEqual(
      p.journeyTrash,
      beforePlanRestore.journeyTrash.filter((row) => row.id !== planTrash.id),
    );
    await nav('materials');
    await page.locator('[data-action="craft-plan-remove"][data-id="' + latestPlan.id + '"]').click();
    await page.locator('[data-action="craft-plan-remove-confirm"]').click();
    p = await until((p) => !p.craftPlans.some((row) => row.id === latestPlan.id));
    const purgePlan = p.journeyTrash.find(
      (row) => row.kind === 'craft-plan' && row.record.id === latestPlan.id,
    );
    await page.locator('[data-action="journey-trash-open"]').click();
    await page.locator('#journey-trash-query').fill('制作次数 6');
    await page.locator('[data-action="journey-trash-purge-preview"][data-id="' + purgePlan.id + '"]').click();
    await page.keyboard.press('Escape');
    assert((await current()).journeyTrash.some((row) => row.id === purgePlan.id));
    await page.locator('[data-action="journey-trash-purge-preview"][data-id="' + purgePlan.id + '"]').click();
    await page.locator('[data-action="journey-trash-confirm"]').click();
    p = await until((p) => !p.journeyTrash.some((row) => row.id === purgePlan.id));
    assert(p.journeyTrash.some((row) => row.id === archivedPlanGoal.id));
    checks.push(
      '制作计划完整配方次数/加工/预留预览可取消；真实小窗更新后旧删除拒绝且文件字节不变；材料入口冷重启全文搜索、逐条找回保留编辑和后来内容，明确永久清除保留其他副本',
    );
    for (const command of [
      { type: 'goal-add', title: '切周目前确认的目标', detail: '旧周目完整说明' },
      {
        type: 'craft-plan-save',
        name: '切周目前确认的计划',
        list: [{ id: 'fusion-1000', quantity: 2 }],
        choices: {},
        reserved: false,
      },
    ]) {
      const result = await page.evaluate((command) => window.journal.mutate(command), command);
      assert(result.ok, result.error);
    }
    const previousOwner = await current(),
      confirmedGoal = previousOwner.goals.find((row) => row.title === '切周目前确认的目标'),
      confirmedPlan = previousOwner.craftPlans.find((row) => row.name === '切周目前确认的计划');
    const switched = await page.evaluate(() =>
      window.journal.mutate({ type: 'profile-add', name: '另窗已切换的周目' }),
    );
    assert(switched.ok, switched.error);
    const beforeProfileRejection = fs.readFileSync(path.join(userData, 'journal.json')),
      beforePreviousRejection = fs.readFileSync(path.join(userData, 'journal.json.previous'));
    for (const [type, record] of [
      ['goal-remove', confirmedGoal],
      ['craft-plan-remove', confirmedPlan],
    ]) {
      const result = await page.evaluate((command) => window.journal.mutate(command), {
        type,
        profileId: previousOwner.id,
        id: record.id,
        expectedRecord: record,
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /周目已变化/);
      assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), beforeProfileRejection);
      assert.deepEqual(
        fs.readFileSync(path.join(userData, 'journal.json.previous')),
        beforePreviousRejection,
      );
    }
    const returned = await page.evaluate(
      (id) => window.journal.mutate({ type: 'profile-switch', id }),
      previousOwner.id,
    );
    assert(returned.ok, returned.error);
    p = await current();
    assert.deepEqual(p.goals, previousOwner.goals);
    assert.deepEqual(p.craftPlans, previousOwner.craftPlans);
    assert.deepEqual(p.journeyTrash, previousOwner.journeyTrash);
    checks.push(
      '真实 IPC 拒绝切周目后才到达的旧目标与计划删除确认，当前文件和上一份字节均保持，原周目完整安排可继续',
    );
    assert.equal(hash(), initialSaveHash);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'journey-trash-result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          executionMode: override ? 'packaged-assistant' : 'source-electron',
          checks,
          errors,
          data,
          initialSaveHash,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, data }));
  } catch (error) {
    fs.writeFileSync(
      path.join(results, 'journey-trash-result.json'),
      JSON.stringify({ status: 'FAIL', checks, errors, data, error: error.stack }, null, 2),
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(results, 'journey-trash-failure.png'), timeout: 15000 })
        .catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
