'use strict';

// A single status for the header and tray, including the default file-backup mode.
function protectionStatus(health) {
  const t = health.timeline || {};
  const native = (label, warning = false, ready = false) => ({
    label,
    warning,
    ready,
    detail: t.indexError ? '历史数量待核对' : t.latest ? '最近保存' : '尚未生成游戏内自动存档',
    at: t.latest?.at,
    reason: t.reason || '自动存档需要游戏连接并处于可保存状态',
  });
  if (health.quitting || t.quiescing) return native('等待存读档结束后退出');
  if (t.error) return { ...native('自动保存已停止', true), reason: t.error };
  if (t.busy) return native('正在存读档');
  if (t.pending) return { ...native('上次存读档待核对', true), reason: '请到存档匣核对中断记录' };
  if (health.recovery)
    return {
      label: '存档恢复待核对',
      warning: true,
      detail: '完整保护副本仍保留',
      reason: '请到存档匣核对上次中断的恢复',
    };
  if (health.backupCare?.length)
    return {
      label: '副本清理待处理',
      warning: true,
      ready: false,
      detail: '导出留底保留，暂存副本待核对',
      reason: '请到存档匣放回暂存副本，或重新核验原保护包后继续',
    };
  if (health.backupError && (!t.enabled || !t.connected))
    return { label: '完整备份未完成', warning: true, detail: '请核对备份错误', reason: health.backupError };
  if (t.enabled && !t.connected && health.backupStatus === 'watching' && health.saveConnected) {
    const latest = health.lastBackup;
    return {
      label: latest ? '完整备份守护中' : '正在准备首份备份',
      ready: !!latest,
      detail: latest ? '最近备份' : '存档稳定后自动留存',
      at: latest?.at,
      reason: '游戏内自动存档等待连接；已保存的文件仍会自动备份',
    };
  }
  if (t.enabled)
    return native(!t.connected ? '等待游戏连接' : !t.ready ? '暂时暂停' : '自动保存中', false, !!t.ready);
  if (health.backupStatus === 'watching') {
    if (!health.saveConnected)
      return {
        label: '等待游戏存档',
        detail: '图鉴和攻略已经可以查询',
        reason: '游戏里保存一次后，会自动寻找本机存档',
      };
    const latest = health.lastBackup;
    return {
      label: latest ? '完整备份守护中' : '正在准备首份备份',
      ready: !!latest,
      detail: latest ? '最近备份' : '存档稳定后自动留存',
      at: latest?.at,
      reason: '自动复制已保存的文件；游戏内自动存档尚未开启',
    };
  }
  return {
    label: '资料查询已就绪',
    detail: '自动备份未开启',
    reason: '图鉴、攻略和手札记录可以直接使用；可到存档匣开启备份',
  };
}

module.exports = { protectionStatus };
