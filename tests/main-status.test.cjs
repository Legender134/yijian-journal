'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { protectionStatus } = require('../src/core/protection-status.cjs');
const { goalProgress } = require('../src/core/goal-progress.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
function section(start, end) {
  const a = main.indexOf(start),
    b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return main.slice(a, b);
}
const code =
  section('function autoBackupBlocked(', '\nfunction sendAction(') +
  '\n' +
  section('function overview() {', '\nfunction handle(');

test('overview shares one current timeline snapshot and retains fields and protection faults', () => {
  let calls = 0,
    busy = false,
    selectedSavePath = 'synthetic-SaveGames';
  const context = {
    bridge: {
      get busy() {
        return busy;
      },
      summary: () => ({
        enabled: true,
        ready: false,
        connected: false,
        latest: { id: 'snapshot-' + ++calls, at: 1000 },
        busy,
        count: 7,
        history: [{ id: 'history' }],
        error: '',
      }),
      connected: () => false,
    },
    timeline: { data: { enabled: true } },
    quitRequested: false,
    protectionJobPromise: null,
    tray: null,
    store: {
      get: () => ({
        activeProfileId: 'p',
        profiles: [{ id: 'p', referenceMode: 'latest', goals: [] }],
        settings: { savePath: selectedSavePath, autoBackup: true },
      }),
    },
    saves: {
      busy: false,
      root: 'synthetic-backups',
      scan: () => ({ files: [] }),
      list: () => [],
      anomalies: () => [],
      pendingRestore: () => null,
    },
    autoBackup: { error: '', lastBackup: { at: 1000 } },
    activity: { get: () => ({ fault: { message: 'Synthetic retained fault' }, events: [] }) },
    pendingBackupCare: () => [],
    game: { installed: false },
    refreshGameEnvironment: () => {},
    detected: () => [],
    app: { getPath: () => 'synthetic-userData' },
    shortcuts: null,
    shortcutReady: false,
    DEFAULT_SHORTCUTS: {},
    recoveredIsolation: null,
    readProtectionExportResult: () => null,
    protectionStatus,
    goalProgress,
    resourceBudget,
    journeyPlan,
  };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.overviewResult = overview();', context);
  const result = context.overviewResult;
  assert.equal(result.backupCare.length, 0);
  assert.equal(calls, 1);
  assert.equal(result.timeline.latest.id, result.health.timeline.latest.id);
  assert.equal(result.timeline.count, 7);
  assert.equal(result.timeline.history[0].id, 'history');
  assert.equal(result.health.backupStatus, 'watching');
  busy = true;
  vm.runInContext('this.currentHealth = health();', context);
  assert.equal(calls, 2, 'standalone health is a fresh observation');
  assert.equal(context.currentHealth.timeline.busy, true);
  assert.equal(context.currentHealth.backupStatus, 'paused');
  context.bridge.summary = () => {
    calls++;
    return { enabled: false, connected: false, error: '' };
  };
  vm.runInContext('this.fault = overview();', context);
  assert.equal(calls, 3);
  assert.equal(context.fault.timeline.error, 'Synthetic retained fault');
  assert.equal(context.fault.health.timeline.error, 'Synthetic retained fault');
  context.bridge.summary = () => ({ enabled: false, indexError: true, error: '时间线记录损坏' });
  vm.runInContext('this.unreadable = overview();', context);
  assert.equal(context.unreadable.health.timeline.indexError, true);
  assert.equal(context.unreadable.health.protection.detail, '历史数量待核对');
  context.activity.get = () => ({ events: [] });
  context.bridge.summary = () => ({ enabled: false });
  context.autoBackup.lastBackup = { id: 'staged-copy', at: 1000 };
  context.pendingBackupCare = () => [{ id: 'synthetic-pending', ids: ['staged-copy'], phase: 'deleting' }];
  vm.runInContext('this.cleanupPending = overview();', context);
  assert.equal(context.cleanupPending.backupCare[0].id, 'synthetic-pending');
  assert.equal(context.cleanupPending.health.lastBackup, null);
  assert.equal(context.cleanupPending.health.backupStatus, 'paused');
  assert.equal(context.cleanupPending.health.protection.ready, false);
  assert.equal(context.cleanupPending.health.protection.label, '副本清理待处理');
  context.saves.anomalies = () => [{ id: 'synthetic-damaged', recoverable: false }];
  context.readProtectionExportResult = () => ({ status: 'failed', message: '合成导出未完成' });
  context.recoveredIsolation = { retainedDirectory: 'journal-recovery-synthetic' };
  selectedSavePath = '';
  vm.runInContext('this.recovered = overview();', context);
  assert.equal(context.recovered.backupAnomalies[0].recoverable, false);
  assert.equal(context.recovered.protectionExportResult.status, 'failed');
  assert.equal(context.recovered.journalRecovery.needsSaveConfirmation, true);
  assert.equal(context.recovered.journalRecovery.retainedDirectory, 'journal-recovery-synthetic');
  selectedSavePath = 'explicitly-confirmed-synthetic-SaveGames';
  vm.runInContext('this.confirmed = overview();', context);
  assert.equal(context.confirmed.journalRecovery.needsSaveConfirmation, false);
  assert.equal(
    context.confirmed.journalRecovery.isolated,
    true,
    'old native records remain isolated after a new path is explicitly chosen',
  );
});
