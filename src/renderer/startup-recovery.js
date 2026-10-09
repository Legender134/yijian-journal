'use strict';
const api = window.journalRecovery;
const status = document.getElementById('status'),
  error = document.getElementById('error'),
  preview = document.getElementById('preview'),
  ack = document.getElementById('ack'),
  confirm = document.getElementById('confirm');
let token = '',
  newJournal = false,
  busy = false;
function setBusy(value, message = '') {
  busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  ack.disabled = value;
  confirm.disabled = value || !token || !ack.checked;
  if (message) status.textContent = message;
}
function fail(message) {
  resetPreview();
  confirm.disabled = true;
  error.textContent = message;
  error.hidden = false;
  status.textContent = '恢复未完成，原件和保护副本仍保留。';
}
function resetPreview() {
  token = '';
  newJournal = false;
  preview.hidden = true;
  ack.checked = false;
  error.hidden = true;
}
function showPreview(value) {
  token = value.token;
  newJournal = value.intent === 'new';
  ack.checked = false;
  document.getElementById('preview-title').textContent = newJournal
    ? '2. 确认从空手札开始'
    : '2. 核对本次恢复范围';
  document.getElementById('source').textContent =
    `${value.kind} · ${value.sourceName} · ${newJournal ? '准备时间' : '资料日期'}：${value.createdAt ? new Date(value.createdAt).toLocaleString('zh-CN') : '未记录'} · ${value.profiles.length} 个周目`;
  const list = document.getElementById('profiles');
  list.replaceChildren();
  for (const profile of value.profiles) {
    const item = document.createElement('li');
    item.textContent = `${profile.name} · ${profile.goals} 项目标 · ${profile.entries} 条江湖记录 · ${profile.recordVersions ?? 0} 份记录旧版本 · ${profile.noteVersions ?? 0} 份随手记旧内容 · ${profile.drafts} 份草稿（记录） · ${profile.arrangementDrafts} 份安排草稿 · ${profile.deletedEntries} 条已删除记录 · ${profile.removedArrangements} 项已移除安排`;
    list.append(item);
  }
  document.getElementById('ignored').textContent =
    value.ignoredBackups || value.ignoredNodes
      ? `保护资料已完整校验，其中 ${value.ignoredBackups} 份游戏备份、${value.ignoredNodes} 个时间线节点不在本次手札恢复范围内。原保护包不会改动。`
      : '';
  document.getElementById('scope').textContent = newJournal
    ? '本次会开始一份空手札，旧周目、笔记、记录、草稿和计划尚未恢复，不会出现在新手札里。两个损坏原件会先另存并校验，现有完整备份、旧时间线和游戏存档全部原样保留，不会删除或覆盖。'
    : '仅恢复手札里的周目、笔记、待办、记录、草稿和计划，包括记录旧版本、已删除记录、已移除安排和物资用途顺序。游戏存档、完整备份和原时间线仍保留在原处；本次不恢复它们。旧机器路径、账户和固定槽位不会绑定，自动存读档权限不会启用。';
  document.getElementById('consequence').textContent = newJournal
    ? '新手札可直接用于离线查询和记录。确认后才会原子建立手札；旧路径、账户、固定槽位和原生存读档权限不会沿用。重新进入后，可以在设置中明确选择本机存档目录，原生时间线须另外明确开启。'
    : '确认后会先另存并校验两个损坏原件，随后原子替换本机手札。重新进入后，请在设置中重新确认本机存档目录；原生时间线须另外明确开启。';
  document.getElementById('ack-text').textContent = newJournal
    ? '我明白将从空手札开始，旧手札原件仍保留且尚未恢复，并确认新建'
    : '我已核对周目和恢复范围，确认恢复这份手札';
  confirm.textContent = newJournal ? '保留损坏原件并开始新手札' : '保留损坏原件并恢复手札';
  preview.hidden = false;
  status.textContent = newJournal
    ? '新手札尚未创建。请核对空白起点，再明确确认。'
    : '校验通过。请核对周目，再确认恢复范围。';
}
for (const button of document.querySelectorAll('[data-mode]'))
  button.addEventListener('click', async () => {
    if (busy) return;
    resetPreview();
    setBusy(true, '正在选择并完整校验资料，请稍候…');
    try {
      const result = await api.choose(button.dataset.mode);
      if (!result.ok) {
        fail(result.error);
        return;
      }
      if (result.data.cancelled) {
        status.textContent = '已取消选择，原件尚未替换。';
        return;
      }
      showPreview(result.data);
    } catch {
      fail('恢复资料暂时无法读取，请重新选择并重试。原件未替换。');
    } finally {
      setBusy(false);
    }
  });
document.getElementById('new-journal').addEventListener('click', async () => {
  if (busy) return;
  resetPreview();
  setBusy(true, '正在准备空手札预览，原件尚未替换…');
  try {
    const result = await api.prepareNew();
    if (!result.ok) {
      fail(result.error);
      return;
    }
    showPreview(result.data);
  } catch {
    fail('空手札预览暂时无法准备，请重试；损坏原件未替换。');
  } finally {
    setBusy(false);
  }
});
ack.addEventListener('change', () => {
  confirm.disabled = busy || !token || !ack.checked;
});
confirm.addEventListener('click', async () => {
  if (busy || !token || !ack.checked) return;
  error.hidden = true;
  setBusy(true, newJournal ? '正在保护损坏原件并建立空手札…' : '正在重新校验资料、保护损坏原件并恢复手札…');
  try {
    const result = await api.confirm(token);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    status.textContent = newJournal ? '新手札已建立，正在进入正常软件…' : '手札已恢复，正在进入正常软件…';
  } catch {
    fail('恢复状态暂时无法确认。保护原件仍在本机；请退出重启核对，再重新选择资料。');
  } finally {
    setBusy(false);
  }
});
document.getElementById('cancel').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true, '保留原件并退出…');
  const result = await api.cancel().catch(() => null);
  if (result && !result.ok) {
    fail(result.error);
    setBusy(false);
  }
});
api
  .status()
  .then((result) => {
    if (!result.ok) {
      fail(result.error);
      return;
    }
    document.getElementById('directory').textContent = result.data.directory;
    status.textContent = '原件尚未替换。请选择已有备份，或明确开始新手札，也可以保留原件并退出。';
  })
  .catch(() => fail('无法读取恢复状态，请保留本机数据并退出重试。'));
