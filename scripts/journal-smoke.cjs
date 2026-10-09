'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..'),
  { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { Saves } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs'),
  catalog = require('../src/data/catalog.cjs');
const complete = require('../src/core/complete-migration.cjs'),
  { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const data = path.join(base, '.test-data', 'journal-ui-' + Date.now()),
  userData = path.join(data, 'userdata'),
  source = path.join(data, 'synthetic-SaveGames');
const exported = path.join(data, '江湖记录备份.json'),
  protection = path.join(data, '完整保护.yijian-protection');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
fs.writeFileSync(
  path.join(source, '1.sav'),
  syntheticSave({ full: true, seconds: 9000, quests: [{ id: 5200, step: 1 }], inventory: [] }),
);
const old = new Date(Date.now() - 5000);
fs.utimesSync(path.join(source, '1.sav'), old, old);
const store = new Store(userData, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'note', value: '旧版随手记，不能覆盖或拆散。' });
store.mutate({ type: 'goal-add', title: '今晚准备白芍' });
const goalId = store.get().profiles[0].goals[0].id;
for (let i = 1; i <= 22; i++)
  store.mutate({ type: 'goal-add', title: '同名出发备药', detail: '关联备忘' + String(i).padStart(2, '0') });
const lastReferenceId = store.get().profiles[0].goals.find((g) => g.detail === '关联备忘22').id;
const goalScenes = [
  { placeId: 'place-14', label: '碗子山 · 场景 #14' },
  { placeId: 'place-22', label: '野猪林 · 场景 #22' },
];
for (const scene of goalScenes) {
  store.mutate({ type: 'goal-add', title: '明早采药', detail: '带上空行囊', placeId: scene.placeId });
  scene.id = store
    .get()
    .profiles[0].goals.find((g) => g.title === '明早采药' && g.placeId === scene.placeId).id;
}
const saves = new Saves(path.join(userData, 'save-backups'));
const backup = saves.capture(source, '界面筛选保护点');
const firstBody = '\n\n清霄道长提到武当，先记下与卫霍的约定。\n  原文 <literal> & 尾部  ';
const checks = [],
  errors = [];
let app;
async function current(page) {
  const result = await page.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.state.profiles.find((p) => p.id === result.data.state.activeProfileId);
}
async function until(page, predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const p = await current(page);
    if (predicate(p)) return p;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('record UI did not persist');
}
async function written(file, parse = false) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    try {
      const value = fs.readFileSync(file);
      if (value.length) return parse ? JSON.parse(value) : value;
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error('export did not finish: ' + file);
}
async function nav(page, id) {
  await page.locator('.nav-btn[data-id="' + id + '"]').click();
}
(async () => {
  try {
    const temp = path.join(data, 'temp');
    fs.mkdirSync(temp, { recursive: true });
    const env = { ...process.env, YIJIAN_TEST_DATA: userData, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      cwd: base,
      env,
    });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForSelector('.nav-btn');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((win) => win.showInactive()),
    );
    await nav(page, 'materials');
    await page.locator('#craft-search').fill('精钢锭');
    await page.locator('.craft-suggestions [data-action="craft-add"][data-id="fusion-9502"]').waitFor();
    assert((await page.locator('.craft-picker').innerText()).includes('同名成品和生产配方优先'));
    await page.locator('[data-action="craft-search-page"]').last().click();
    assert((await page.locator('.craft-picker').innerText()).includes('第 2 /'));
    checks.push('精确材料搜索优先生产配方，匹配结果分页可达');
    await nav(page, 'journal');
    for (const [i, title] of ['第一天见卫霍', '第二天重新安排'].entries()) {
      await page.locator('[data-action="journal-entry-new"]').click();
      await page.locator('#journal-title').fill(title);
      await page.locator('#journal-body').fill(i ? '今天仍未赠送，先去武当。' : firstBody);
      await page.locator('#journal-time').fill('2026-10-0' + (8 + i) + 'T10:30');
      await page.locator('#journal-tags').fill('人物，武当');
      await page.locator('#journal-reference-query').fill('卫霍');
      await page.locator('[data-action="journal-reference-add"][data-id="database:npc-10047"]').click();
      assert.equal(await page.locator('#journal-title').inputValue(), title);
      if (!i) {
        const results = page.locator('#journal-reference-results');
        await page.locator('#journal-reference-query').fill('同名出发备药');
        assert((await results.innerText()).includes('找到 22 项 · 第 1 / 2 页'));
        const first = await results
          .locator('[data-action="journal-reference-add"]')
          .evaluateAll((rows) => rows.map((row) => row.dataset.id));
        assert.equal(first.length, 20);
        await results.locator('[data-action="journal-reference-add"]').first().click();
        await results.locator('[data-action="journal-reference-page"]').focus();
        await page.keyboard.press('Enter');
        await results.locator('[data-reference-page-heading]').waitFor();
        assert((await results.innerText()).includes('找到 22 项 · 第 2 / 2 页'));
        assert.equal(
          await results
            .locator('[data-reference-page-heading]')
            .evaluate((el) => el === document.activeElement),
          true,
        );
        const rest = await results
          .locator('[data-action="journal-reference-add"]')
          .evaluateAll((rows) => rows.map((row) => row.dataset.id));
        assert.equal(rest.length, 2);
        assert.equal(new Set([...first, ...rest]).size, 22);
        await results.locator('[data-action="journal-reference-add"]').last().click();
        assert.equal(
          await page.locator('#journal-selected-references [data-action="journal-reference-remove"]').count(),
          3,
        );
        const selected = page.locator('#journal-selected-references');
        const selectedGoals = [first[0], rest.at(-1)].map((key) => ({
          key,
          detail: store.get().profiles[0].goals.find((goal) => 'goal:' + goal.id === key).detail,
        }));
        for (const goal of selectedGoals) {
          assert((await selected.innerText()).includes('当前备忘：' + goal.detail));
          assert.equal(
            await selected
              .getByRole('button', {
                name: '移除 目标 · 同名出发备药 · 当前备忘：' + goal.detail,
                exact: true,
              })
              .count(),
            1,
          );
        }
        await selected
          .getByRole('button', {
            name: '移除 目标 · 同名出发备药 · 当前备忘：' + selectedGoals[0].detail,
            exact: true,
          })
          .click();
        assert(
          !(await page.locator('#journal-links').inputValue()).split('\n').includes(selectedGoals[0].key),
        );
        assert(
          (await page.locator('#journal-links').inputValue()).split('\n').includes(selectedGoals[1].key),
        );
        await page.locator('#journal-reference-query').fill(selectedGoals[0].detail);
        await results
          .locator('[data-action="journal-reference-add"][data-id="' + selectedGoals[0].key + '"]')
          .click();
        checks.push('已选同名目标保留当前备忘，按可访问名称准确移除一项，另一项及正文保留');
        await page.locator('#journal-reference-query').fill('关联备忘22');
        assert.equal(await results.locator('[data-action="journal-reference-add"]').count(), 1);
        assert.equal(
          await results.locator('[data-action="journal-reference-add"]').getAttribute('data-id'),
          'goal:' + lastReferenceId,
        );
        assert((await results.innerText()).includes('关联备忘22'));
        assert.equal(await page.locator('#journal-title').inputValue(), title);
        assert.equal(await page.locator('#journal-body').inputValue(), firstBody);
        assert.equal(await page.locator('#journal-tags').inputValue(), '人物，武当');
        checks.push('22 个同名个人目标全部可翻页关联，说明可辨认和检索，键盘翻页保留正文、标签与已选关联');
        await page.locator('#journal-reference-query').fill('明早采药');
        assert.equal(await results.locator('[data-action="journal-reference-add"]').count(), 2);
        for (const scene of goalScenes) {
          assert((await results.innerText()).includes('明早采药 · ' + scene.label));
          await results
            .getByRole('button', {
              name: '关联 目标 · 明早采药 · ' + scene.label + ' · 带上空行囊',
              exact: true,
            })
            .click();
          await page
            .locator('#journal-selected-references')
            .getByRole('button', {
              name: '移除 目标 · 明早采药 · ' + scene.label + ' · 当前备忘：带上空行囊',
              exact: true,
            })
            .waitFor();
        }
        await page.locator('#journal-reference-query').fill('莫问授剑');
        assert.equal(await results.locator('[data-action="journal-reference-add"]').count(), 3);
        for (const id of [5230, 9010, 9011]) {
          await results
            .getByRole('button', { name: '关联 任务 · 莫问授剑 · 任务 #' + id, exact: true })
            .click();
          await page
            .locator('#journal-selected-references')
            .getByRole('button', { name: '移除 任务 · 莫问授剑 · 任务 #' + id, exact: true })
            .waitFor();
        }
        assert.equal(
          await page.locator('#journal-selected-references [data-action="journal-reference-remove"]').count(),
          8,
        );
        const referenceKeys = (await page.locator('#journal-links').inputValue()).split('\n');
        for (const scene of goalScenes) assert(referenceKeys.includes('goal:' + scene.id));
        for (const id of [5230, 9010, 9011]) assert(referenceKeys.includes('quest:quest-' + id));
        checks.push('同名不同地点目标与三个莫问授剑任务在候选、已选及按钮可访问名称中可辨认，关联值仍为原ID');
        await page.locator('#journal-snapshot').selectOption('selected');
        await page.screenshot({ path: path.join(base, 'test-results', 'journal-editor.png') });
      }
      await page.locator('[data-action="journal-entry-save"]').click();
      await until(page, (p) => p.journalEntries?.filter((e) => e.kind === 'manual').length === i + 1);
    }
    let p = await current(page);
    assert.equal(p.notes, '旧版随手记，不能覆盖或拆散。');
    assert.equal(p.journalEntries[0].snapshot.name, '1.sav');
    assert.equal(p.journalEntries[0].links[0].label, '人物 · 卫霍');
    for (const scene of goalScenes)
      assert.deepEqual(
        p.journalEntries[0].links.find((link) => link.id === scene.id),
        { type: 'goal', id: scene.id, label: '明早采药' },
      );
    for (const id of [5230, 9010, 9011])
      assert.deepEqual(
        p.journalEntries[0].links.find((link) => link.id === 'quest-' + id),
        { type: 'quest', id: 'quest-' + id, label: '莫问授剑' },
      );
    await page.locator('[data-action="search"]').click();
    await page.locator('#global-search').fill('卫霍');
    const original = page
      .locator('.search-result[data-action="journal-entry-open"]')
      .filter({ hasText: '第一天见卫霍' });
    await original.click();
    await page.locator('#overlay [data-journal-id="' + p.journalEntries[0].id + '"]').waitFor();
    assert((await page.locator('#overlay').innerText()).includes('清霄道长'));
    await page.locator('#overlay [data-action="journal-entry-edit"]').click();
    assert.equal(await page.locator('#journal-body').inputValue(), firstBody);
    await page.locator('#journal-title').fill('第一天见卫霍 · 只改标题');
    await page.locator('[data-action="journal-entry-save"]').click();
    p = await until(page, (p) => p.journalEntries.some((e) => e.title === '第一天见卫霍 · 只改标题'));
    const renamed = p.journalEntries.find((e) => e.title === '第一天见卫霍 · 只改标题');
    assert.equal(renamed.body, firstBody);
    assert.equal(renamed.snapshot.name, '1.sav');
    assert.equal(renamed.links[0].label, '人物 · 卫霍');
    checks.push('逐事件记录有时间、标签、人物关联和只读参照；全局搜索直达原记录');
    checks.push('记录重新编辑与只改标题保存完整保留首部空行、文字、尾部空白、资料关联和存档参照');
    await nav(page, 'goals');
    await page.locator('[data-action="goal-toggle"][data-id="' + goalId + '"]').click();
    await until(page, (p) => p.journalEntries.some((e) => e.kind === 'goal-completed'));
    await page.locator('[data-action="goal-toggle"][data-id="' + goalId + '"]').click();
    await until(page, (p) => p.journalEntries.some((e) => e.kind === 'goal-reopened'));
    await nav(page, 'journal');
    await page.locator('#journal-kind').selectOption('manual');
    await page.locator('[data-action="journal-filter"]').click();
    assert.equal(await page.locator('article[data-journal-id]').count(), 2);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, exported);
    await page.locator('[data-action="journal-export"]').click();
    const archived = await written(exported, true);
    assert.equal(archived.profiles[0].journalEntries.length, 4);
    await page.locator('[data-action="journal-remove-filtered"]').click();
    await page.locator('#overlay [data-action="close-overlay"]').first().click();
    assert.equal((await current(page)).journalEntries.length, 4);
    await page.locator('[data-action="journal-remove-filtered"]').click();
    await page.locator('[data-action="journal-remove-filtered-confirm"]').click();
    p = await until(page, (p) => p.journalEntries.length === 2);
    assert.equal(p.goals[0].done, false);
    assert(p.journalEntries.every((e) => e.kind !== 'manual'));
    checks.push('完成与重开生成独立用户事件；精确筛选删除先确认并可取消，导出留底且目标状态保持');
    await nav(page, 'saves');
    await page.locator('#backup-search').fill('界面筛选保护点');
    assert.equal(await page.locator('[data-action="backup-preview"]').count(), 1);
    await page.locator('[data-action="backup-selection"][data-id="' + backup.id + '"]').check();
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, protection);
    await page.locator('[data-action="backup-export-selected"]').click();
    await written(protection);
    const archives = new ProtectionArchives(userData, () => source),
      preview = await complete.previewComplete({ archives, file: protection });
    assert.deepEqual(
      preview.backups.map((b) => b.id),
      [backup.id],
    );
    checks.push('完整备份按名称查找并精确分批导出，原副本保留');
    // Archived event records are browsable without replacing the current journal.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, protection);
    await page.locator('[data-action="protection-import"]').click();
    await page.locator('[data-action="protection-journal-profile"]').waitFor({ state: 'attached' });
    await page
      .locator('[data-action="protection-journal-profile"]')
      .locator('xpath=ancestor::details[1]')
      .locator('summary')
      .first()
      .click();
    const historicalProfile = page
      .locator('[data-action="protection-journal-profile"]')
      .locator('xpath=ancestor::details[1]');
    await historicalProfile
      .locator('summary')
      .filter({ hasText: /^目标记录$/ })
      .click();
    for (const scene of goalScenes)
      assert((await historicalProfile.innerText()).includes('明早采药 · ' + scene.label));
    assert.deepEqual((await current(page)).goals, p.goals);
    checks.push('只读档案在使用历史手札前显示两条目标各自保存的地点与场景，当前目标保持原样');
    await page.locator('[data-action="protection-journal-profile"]').click();
    await page.locator('#historical-journal-search').fill('今晚准备白芍');
    await page.locator('[data-action="historical-journal-filter"]').click();
    const historyRecord = page
      .locator('[data-action="historical-journal-entry-open"]')
      .filter({ hasText: '完成目标' });
    await historyRecord.first().click();
    assert.equal(await page.locator('#overlay [data-action="journal-entry-edit"]').count(), 0);
    assert.equal(await page.locator('#overlay [data-action="journal-entry-remove"]').count(), 0);
    assert.equal((await current(page)).journalEntries.length, 2);
    await page.locator('#overlay [data-action="close-overlay"]').click();
    checks.push('旧档案逐条记录可检索、打开全文；只读浏览不会替换当前手札');
    // Default safety locks, explicit unlock, export-before-cleanup and cancellation.
    await nav(page, 'saves');
    await page.locator('[data-action="backup-lock"][data-id="' + backup.id + '"]').click();
    await page.locator('[data-action="backup-unlock"][data-id="' + backup.id + '"]').waitFor();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    await page.locator('[data-action="backup-unlock"][data-id="' + backup.id + '"]').click();
    assert.equal(
      new Saves(path.join(userData, 'save-backups')).list().find((b) => b.id === backup.id).locked,
      true,
    );
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await page.locator('[data-action="backup-unlock"][data-id="' + backup.id + '"]').click();
    await page.locator('[data-action="backup-lock"][data-id="' + backup.id + '"]').waitFor();
    const cancelledPackage = path.join(data, '清理取消留底.yijian-protection');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showMessageBox = async () => ({ response: 0 });
    }, cancelledPackage);
    await page.locator('[data-action="backup-cleanup-selected"]').click();
    await written(cancelledPackage);
    await page.waitForFunction(
      () => !document.querySelector('[data-action="backup-cleanup-selected"]')?.disabled,
    );
    assert(fs.existsSync(path.join(userData, 'save-backups', backup.id)));
    const cleanupPackage = path.join(data, '清理确认留底.yijian-protection');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, cleanupPackage);
    await page.locator('[data-action="backup-cleanup-selected"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="backup-preview"]'));
    assert(!fs.existsSync(path.join(userData, 'save-backups', backup.id)));
    const cleanupPreview = await complete.previewComplete({ archives, file: cleanupPackage });
    assert.deepEqual(
      cleanupPreview.backups.map((b) => b.id),
      [backup.id],
    );
    assert(
      fs
        .readFileSync(path.join(source, '1.sav'))
        .equals(syntheticSave({ full: true, seconds: 9000, quests: [{ id: 5200, step: 1 }], inventory: [] })),
    );
    checks.push('副本锁定、解锁取消和清理取消均保留原件；确认清理前导出留底，游戏文件字节不变');
    await app.close();
    app = null;
    const restarted = new Store(userData, catalog).get().profiles[0];
    assert.equal(restarted.journalEntries.length, 2);
    assert.equal(restarted.notes, '旧版随手记，不能覆盖或拆散。');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(base, 'test-results', 'journal-flows-ui-result.json'),
      JSON.stringify({ status: 'PASS', checks, data, errors }, null, 2),
    );
    console.log(JSON.stringify({ status: 'PASS', checks, data }));
  } catch (e) {
    fs.writeFileSync(
      path.join(base, 'test-results', 'journal-flows-ui-result.json'),
      JSON.stringify({ status: 'FAIL', checks, data, errors, error: e.stack }, null, 2),
    );
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
})();
