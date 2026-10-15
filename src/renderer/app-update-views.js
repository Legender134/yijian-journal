export function createAppUpdateViews({ esc, act, bytes }) {
  function badge(update) {
    if (!update?.installFailed && !['available', 'downloading', 'ready'].includes(update?.phase)) return '';
    const title = update.installFailed
      ? '更新未完成'
      : update.phase === 'ready'
        ? '更新已就绪'
        : update.phase === 'downloading'
          ? `下载 ${update.progress}%`
          : '有新版';
    return act('updates', title, 'text-btn', '', 'download');
  }
  function panel(update, currentVersion, automatic = true) {
    const status = update || { phase: 'idle' };
    const busy = ['checking', 'downloading'].includes(status.phase);
    const title =
      {
        idle: `当前 v${currentVersion}`,
        checking: '正在检查更新…',
        current: `已是最新版 · v${currentVersion}`,
        available: `新版 v${status.version}`,
        downloading: `正在下载 · ${status.progress}%`,
        ready: `v${status.version} 已就绪`,
        error: '暂未完成更新',
      }[status.phase] || `当前 v${currentVersion}`;
    let action = act('update-check', '检查更新', 'btn', '', 'refresh');
    if (status.phase === 'available')
      action = act('update-download', `下载更新 · ${bytes(status.size)}`, 'btn primary', '', 'download');
    if (status.phase === 'ready') action = act('update-install', '重启并更新', 'btn primary', '', 'refresh');
    if (status.phase === 'downloading') action = act('update-cancel', '取消下载', 'btn');
    if (status.phase === 'checking') action = '<button class="btn" disabled>检查中…</button>';
    return `<div data-update-panel aria-live="polite"><div class="setting-row"><strong>${esc(title)}</strong><div class="row wrap">${action}${['available', 'ready'].includes(status.phase) ? act('update-check', '重新检查', 'text-btn', '', 'refresh') : ''}</div></div>${status.phase === 'downloading' ? `<progress class="update-progress" max="100" value="${Number(status.progress) || 0}" aria-label="更新下载进度"></progress>` : ''}${status.error ? `<p class="notice">${esc(status.error)}</p>` : ''}${status.phase === 'ready' ? '<p class="small muted">重启手札后生效，记录和设置继续保留。</p>' : ''}${status.notes?.length ? `<details data-update-notes><summary>更新内容</summary><ul>${status.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul></details>` : ''}<div class="setting-row"><span>启动时检查更新</span><button class="switch ${automatic ? 'on' : ''}" role="switch" aria-checked="${automatic}" aria-label="启动时检查更新" data-action="update-auto"${busy ? ' disabled' : ''}></button></div></div>`;
  }
  return { badge, panel };
}
