'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;
const preparedPlans = new WeakSet();
const messages = Object.freeze({
  installed: '新版手札已安装。',
  plan: '更新安装计划无效，旧版本保持可用。',
  process: '旧版本尚未安全退出，更新未切换。',
  package: '更新包校验失败，请重新下载。',
  zip: '更新包结构无效，旧版本保持可用。',
  manifest: '更新包版本或文件校验失败，请重新下载。',
  install: '无法安装新版，旧版本保持可用。',
  shortcuts: '更新入口切换失败，已尝试恢复旧版本。',
  launch: '新版启动失败，已尝试重新打开旧版本。',
});

function contained(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw Error('更新路径无效');
  return path.resolve(value);
}
function noLinks(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('更新路径不能包含链接');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) break;
  }
}

// This is main-process-only. The renderer receives neither these paths nor the plan.
function prepareUpdateInstall({ package: ready, cacheDir, currentExe, processId, testRoot } = {}) {
  if (process.platform !== 'win32') throw Error('自动安装仅支持 Windows');
  cacheDir = absolute(cacheDir);
  currentExe = absolute(currentExe);
  const file = absolute(ready?.file);
  const manifest = ready?.manifest;
  if (
    !manifest ||
    typeof manifest.version !== 'string' ||
    manifest.version.length > 40 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > MAX_PACKAGE_BYTES ||
    !/^[a-f0-9]{64}$/i.test(manifest.sha256)
  )
    throw Error('更新包清单无效');
  if (!Number.isSafeInteger(processId) || processId < 0 || processId > 0x7fffffff)
    throw Error('更新退出进程无效');
  if (!contained(cacheDir, file) || file === cacheDir) throw Error('更新包必须位于更新缓存内');
  let installRoot;
  if (testRoot !== undefined) {
    const isolated = absolute(process.env.YIJIAN_TEST_DATA);
    testRoot = absolute(testRoot);
    if (
      !contained(isolated, testRoot) ||
      testRoot === isolated ||
      ![cacheDir, currentExe, file].every((value) => contained(testRoot, value))
    )
      throw Error('测试更新只能使用隔离目录');
    installRoot = path.join(testRoot, 'programs', 'YijianJournal');
  } else {
    if (processId === 0) throw Error('更新退出进程无效');
    installRoot = path.join(absolute(process.env.LOCALAPPDATA), 'Programs', 'YijianJournal');
  }
  for (const target of [cacheDir, file, currentExe, installRoot]) noLinks(target);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size !== manifest.size)
    throw Error('更新包大小已变化，请重新下载');
  if (!fs.statSync(currentExe).isFile()) throw Error('当前手札路径无效');
  fs.mkdirSync(cacheDir, { recursive: true });
  const workDir = path.join(cacheDir, 'install-' + crypto.randomUUID());
  fs.mkdirSync(workDir);
  const helperPath = path.join(workDir, 'update-install.ps1');
  const planPath = path.join(workDir, 'plan.json');
  fs.writeFileSync(helperPath, fs.readFileSync(path.join(__dirname, '..', 'assets', 'update-install.ps1')), {
    flag: 'wx',
  });
  const plan = {
    schema: 1,
    packagePath: file,
    version: manifest.version,
    size: manifest.size,
    sha256: manifest.sha256.toLowerCase(),
    cacheDir,
    workDir,
    currentExe,
    processId,
    installRoot,
    testMode: testRoot !== undefined,
    ...(testRoot !== undefined ? { testRoot } : {}),
  };
  fs.writeFileSync(planPath, JSON.stringify(plan), { flag: 'wx', encoding: 'utf8' });
  const prepared = Object.freeze({ helperPath, planPath, workDir });
  preparedPlans.add(prepared);
  return prepared;
}

function launchUpdateInstall(prepared) {
  if (!preparedPlans.has(prepared)) return Promise.reject(Error('更新安装尚未准备完成'));
  preparedPlans.delete(prepared);
  return new Promise((resolve, reject) => {
    let polling,
      deadline,
      finished = false;
    const readyPath = path.join(prepared.workDir, 'helper-started.json');
    const child = spawn(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        prepared.helperPath,
        '-PlanPath',
        prepared.planPath,
        '-Bootstrap',
      ],
      // The script creates an independent hidden PowerShell host using Win32
      // ShellExecute. libuv's DETACHED_PROCESS makes PS 5.1 silently exit on
      // some hosts; an attached host can die when its Node console closes.
      { windowsHide: true, stdio: 'ignore', cwd: prepared.workDir },
    );
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearInterval(polling);
      clearTimeout(deadline);
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    const ready = () => {
      try {
        noLinks(readyPath);
        if (fs.statSync(readyPath).size > 256) return false;
        const marker = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
        return (
          marker.launcherProcessId === child.pid &&
          Number.isSafeInteger(marker.processId) &&
          marker.processId > 0
        );
      } catch {
        return false;
      }
    };
    child.once('error', finish);
    child.once('exit', () => {
      if (ready()) finish();
      else finish(Error('更新安装程序未能启动，手札保持运行。'));
    });
    child.once('spawn', () => {
      // PowerShell must have actually entered the verified plan before quitting
      // Electron; a native spawn event alone can precede host initialization.
      polling = setInterval(() => {
        if (ready()) finish();
      }, 50);
      deadline = setTimeout(() => finish(Error('更新安装程序启动超时，手札保持运行。')), 15000);
    });
  });
}

function readInstallResult(cacheDir) {
  try {
    const file = path.join(absolute(cacheDir), 'install-result.json');
    noLinks(file);
    const descriptor = fs.openSync(file, 'r');
    let bytes;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 8192) return null;
      const buffer = Buffer.alloc(8193);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (count > 8192) return null;
      bytes = buffer.subarray(0, count);
    } finally {
      fs.closeSync(descriptor);
    }
    const result = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (
      result.schema !== 1 ||
      !['installed', 'failed'].includes(result.status) ||
      !Object.hasOwn(messages, result.code) ||
      typeof result.version !== 'string' ||
      result.version.length > 40 ||
      !/^\d+\.\d+\.\d+$/.test(result.version) ||
      typeof result.at !== 'string' ||
      result.at.length > 40 ||
      !Number.isFinite(Date.parse(result.at)) ||
      (result.status === 'installed') !== (result.code === 'installed')
    )
      return null;
    return Object.freeze({
      status: result.status,
      version: result.version,
      code: result.code,
      message: messages[result.code],
      at: result.at,
    });
  } catch {
    return null;
  }
}

module.exports = { prepareUpdateInstall, launchUpdateInstall, readInstallResult };
