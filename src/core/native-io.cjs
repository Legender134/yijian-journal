'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const PROTOCOL = 2;
const slash = (value) => value.replaceAll('\\', '/');
function assertNativePath(value, label) {
  if (!value) return;
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) ||
      value.length > 32700 || /[<>"|?*]/.test(value) || /:/.test(value.slice(2)))
    throw Error(label + '包含原生组件不支持的路径格式，已保留文件');
  for (const part of slash(value).replace(/^[a-z]:\//i, '').split('/').filter(Boolean))
    if (part.length > 255 || /[. ]$/.test(part) || part === '..' || part === '.' ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      throw Error(label + '包含原生组件不支持的路径格式，已保留文件');
}
function mac(key, bytes) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('游戏接入密钥无效');
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(bytes).digest('hex');
}
function grantFrame({ token, source, root, revision, build, epoch }) {
  if (!/^[a-f0-9]{64}$/.test(revision) || !/^\d+$/.test(build) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(epoch))
    throw Error('游戏接入授权格式无效');
  const account = path.basename(path.dirname(source));
  if (!/^\d{17}$/.test(account) || path.basename(source) !== 'SaveGames')
    throw Error('存档目录与 Steam 账户不一致');
  assertNativePath(root, '手札目录');
  assertNativePath(source, '存档目录');
  const base = [PROTOCOL, token, slash(source), epoch, account, build, 29, revision].join('\n') + '\n';
  const binding = base + slash(root) + '/\n';
  return { bytes: Buffer.from(base + mac(token, binding) + '\n'), binding };
}
function commandFrame(token, command, binding) {
  if (!binding || !command.endsWith('\n')) throw Error('请重新明确开启时间线自动保存');
  return Buffer.from(command.slice(0, -1) + '\t' + mac(token, command + binding) + '\n');
}
module.exports = { PROTOCOL, assertNativePath, grantFrame, commandFrame, mac };
