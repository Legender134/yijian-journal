'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { protectionStatus } = require('../src/core/protection-status.cjs');

test('first-use protection distinguishes waiting for saves, preparing a backup and a verified copy', () => {
  const watching = { timeline: { enabled: false }, backupStatus: 'watching' };
  assert.equal(protectionStatus(watching).label, '等待游戏存档');
  const preparing = protectionStatus({ ...watching, saveConnected: true });
  assert.equal(preparing.label, '正在准备首份备份');
  assert.equal(preparing.ready, false);
  const backedUp = protectionStatus({ ...watching, saveConnected: true, lastBackup: { at: 1234 } });
  assert.equal(backedUp.label, '完整备份守护中');
  assert.equal(backedUp.at, 1234);
  assert.equal(backedUp.ready, true);
  assert.match(backedUp.reason, /已保存的文件/);
  assert.match(backedUp.reason, /游戏内自动存档尚未开启/);
});

test('turning backup off preserves the useful query state without claiming protection', () => {
  const status = protectionStatus({
    timeline: { enabled: false },
    backupStatus: 'disabled',
    lastBackup: { at: 1234 },
  });
  assert.equal(status.label, '资料查询已就绪');
  assert.match(status.detail, /未开启/);
  assert.ok(!status.ready);
});

test('native progress status takes precedence over paused full backups', () => {
  const health = { backupStatus: 'paused', timeline: { enabled: true, latest: { at: 2345 } } };
  assert.equal(protectionStatus(health).label, '等待游戏连接');
  health.timeline.connected = true;
  assert.equal(protectionStatus(health).label, '暂时暂停');
  health.timeline.ready = true;
  const status = protectionStatus(health);
  assert.equal(status.label, '自动保存中');
  assert.equal(status.at, 2345);
  assert.equal(status.ready, true);
  assert.equal(status.detail, '最近保存');
});

test('waiting for native connection keeps full-file protection truthful and shows copy failures', () => {
  const health = {
    timeline: { enabled: true, connected: false },
    backupStatus: 'watching',
    saveConnected: true,
  };
  assert.equal(protectionStatus(health).label, '正在准备首份备份');
  assert.equal(protectionStatus(health).ready, false);
  health.lastBackup = { at: 3456 };
  const protectedFiles = protectionStatus(health);
  assert.equal(protectedFiles.label, '完整备份守护中');
  assert.equal(protectedFiles.ready, true);
  assert.equal(protectedFiles.at, 3456);
  assert.match(protectedFiles.reason, /等待连接.*已保存的文件/);
  health.backupError = '合成磁盘写入失败';
  assert.equal(protectionStatus(health).label, '完整备份未完成');
  assert.equal(protectionStatus(health).reason, health.backupError);
  health.timeline.connected = true;
  health.timeline.ready = true;
  assert.equal(protectionStatus(health).label, '自动保存中');
  delete health.backupError;
  health.timeline.connected = false;
  health.backupStatus = 'disabled';
  assert.equal(protectionStatus(health).label, '等待游戏连接');
});

test('faults and interrupted operations stay visible even when an older backup exists', () => {
  const health = { backupStatus: 'watching', saveConnected: true, lastBackup: { at: 1234 } };
  const failed = protectionStatus({ ...health, backupError: '磁盘空间不足' });
  assert.equal(failed.label, '完整备份未完成');
  assert.equal(failed.warning, true);
  assert.equal(failed.reason, '磁盘空间不足');
  assert.equal(protectionStatus({ ...health, recovery: true }).label, '存档恢复待核对');
  const nativeFailure = protectionStatus({ ...health, timeline: { error: '连接异常', reason: '旧状态' } });
  assert.equal(nativeFailure.label, '自动保存已停止');
  assert.equal(nativeFailure.reason, '连接异常');
  const pending = protectionStatus({ ...health, timeline: { pending: true } });
  assert.equal(pending.warning, true);
  assert.match(pending.label, /待核对/);
});

test('a pending request in flight shows the operation, then asks for recovery when idle', () => {
  assert.equal(protectionStatus({ timeline: { busy: true, pending: true } }).label, '正在存读档');
  assert.equal(protectionStatus({ timeline: { busy: false, pending: true } }).label, '上次存读档待核对');
  assert.equal(
    protectionStatus({ quitting: true, timeline: { busy: true, pending: true } }).label,
    '等待存读档结束后退出',
  );
});
test('unreadable history reports an unknown count instead of claiming no previous saves', () => {
  const status = protectionStatus({
    timeline: { enabled: false, indexError: true, error: '时间线记录损坏' },
    backupStatus: 'watching',
    saveConnected: true,
    lastBackup: { at: 1234 },
  });
  assert.equal(status.warning, true);
  assert.equal(status.detail, '历史数量待核对');
  assert.equal(status.reason, '时间线记录损坏');
  assert.equal(status.at, undefined);
  assert.equal(status.ready, false);
});

test('unfinished backup cleanup never presents a staged or deleted copy as active protection', () => {
  const result = protectionStatus({
    timeline: { enabled: false },
    backupStatus: 'watching',
    saveConnected: true,
    lastBackup: { id: 'staged-copy', at: 1234 },
    backupCare: [{ id: 'transaction', ids: ['staged-copy'], phase: 'deleting' }],
  });
  assert.equal(result.label, '副本清理待处理');
  assert.equal(result.ready, false);
  assert.equal(result.warning, true);
  assert.match(result.reason, /原保护包/);
});
