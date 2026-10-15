'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { TextDecoder, promisify } = require('node:util');
// Keep valid Windows 8.3 aliases while still resolving parent symlinks.
// promises.realpath expands short names, which are not redirected directories.
const realpath = promisify(fs.realpath);
const channel = require('../data/update-channel.json');

const MANIFEST_URL = 'https://data.riftbuddy.dpdns.org/yijian-journal/latest.json';
const KEY_ID = 'yijian-updates-20261015';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const CACHE_MANIFEST = 'manifest.json';
const PARTIAL_FILE = 'download.part';
const MANIFEST_TEMP = 'manifest.tmp';
const OWNED_FILE =
  /^(?:YijianJournal-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-windows-x64\.zip|manifest\.json|manifest\.tmp|download\.part)$/;

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function fail(code, message) {
  throw new UpdateError(code, message);
}
function versionParts(version) {
  if (
    typeof version !== 'string' ||
    version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
  )
    fail('invalid-version', '更新版本号无效');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) fail('invalid-version', '更新版本号无效');
  return parts;
}
function compareVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function exactKeys(object, keys, code) {
  if (
    !object ||
    typeof object !== 'object' ||
    Array.isArray(object) ||
    Object.keys(object).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(object, key))
  )
    fail(code, '更新清单格式无效');
}
function configuration(config = channel) {
  exactKeys(config, ['schemaVersion', 'manifestUrl', 'keyId', 'publicKey'], 'invalid-config');
  if (
    config.schemaVersion !== 1 ||
    config.manifestUrl !== MANIFEST_URL ||
    config.keyId !== KEY_ID ||
    typeof config.publicKey !== 'string'
  )
    fail('invalid-config', '更新来源配置无效');
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(config.publicKey);
  } catch {
    fail('invalid-config', '更新签名公钥无效');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('invalid-config', '更新签名公钥无效');
  return { ...config, publicKeyObject: publicKey };
}
function decodeBase64(value, code) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    fail(code, '更新清单编码无效');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) fail(code, '更新清单编码无效');
  return buffer;
}
function parseJson(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    // JSON.parse otherwise silently accepts duplicate, possibly escaped keys.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) || [];
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[i + 1] === ':') {
        const keys = stack.at(-1),
          key = JSON.parse(token);
        if (!keys || keys.has(key)) fail('invalid-json', '更新清单包含重复字段');
        keys.add(key);
      }
    }
    return value;
  } catch {
    fail('invalid-json', '更新清单不是有效的 JSON');
  }
}
function packageName(version) {
  versionParts(version);
  return `YijianJournal-${version}-windows-x64.zip`;
}
function verifyManifest(input, config = channel) {
  const trusted = configuration(config);
  let bytes;
  try {
    bytes = Buffer.isBuffer(input)
      ? input
      : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8');
  } catch {
    fail('invalid-envelope', '更新清单格式无效');
  }
  if (bytes.length > MAX_MANIFEST_BYTES) fail('manifest-too-large', '更新清单超过大小限制');
  const envelope = parseJson(bytes);
  exactKeys(envelope, ['schemaVersion', 'keyId', 'payload', 'signature'], 'invalid-envelope');
  if (envelope.schemaVersion !== 1 || envelope.keyId !== trusted.keyId)
    fail('untrusted-key', '更新清单签名标识不受信任');
  const payload = decodeBase64(envelope.payload, 'invalid-payload');
  const signature = decodeBase64(envelope.signature, 'invalid-signature');
  if (signature.length !== 64 || !crypto.verify(null, payload, trusted.publicKeyObject, signature))
    fail('invalid-signature', '更新清单签名校验失败');
  // Only parse and use publisher-controlled values after authenticating their exact bytes.
  const manifest = parseJson(payload);
  exactKeys(
    manifest,
    ['app', 'version', 'platform', 'arch', 'publishedAt', 'url', 'size', 'sha256', 'notes'],
    'invalid-payload',
  );
  versionParts(manifest.version);
  if (manifest.app !== 'yijian-journal' || manifest.platform !== 'win32' || manifest.arch !== 'x64')
    fail('incompatible-package', '更新包与当前应用不兼容');
  if (
    typeof manifest.publishedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.publishedAt)
  )
    fail('invalid-date', '更新发布时间无效');
  const timestamp = Date.parse(manifest.publishedAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !==
      manifest.publishedAt.replace(/Z$/, manifest.publishedAt.includes('.') ? 'Z' : '.000Z')
  )
    fail('invalid-date', '更新发布时间无效');
  const expectedUrl = new URL(packageName(manifest.version), MANIFEST_URL).href;
  if (manifest.url !== expectedUrl) fail('untrusted-url', '更新包来源不受信任');
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_PACKAGE_BYTES)
    fail('invalid-size', '更新包大小无效');
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    fail('invalid-hash', '更新包校验值无效');
  if (
    !Array.isArray(manifest.notes) ||
    manifest.notes.length > 8 ||
    !manifest.notes.every(
      (note) =>
        typeof note === 'string' &&
        Array.from(note).length <= 200 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note),
    )
  )
    fail('invalid-notes', '更新说明格式无效');
  return structuredClone(manifest);
}
function defaultRequest(url, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { signal, headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'YijianJournal-Updater' } },
      resolve,
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new UpdateError('timeout', '更新连接超时，请稍后重试')),
    );
    request.on('error', reject);
  });
}
function header(response, key) {
  const headers = response.headers || {};
  return headers[key] ?? Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
}
function validateResponse(response, limit, exactSize) {
  if (!response || typeof response[Symbol.asyncIterator] !== 'function')
    fail('invalid-response', '更新服务器响应无效');
  if (response.statusCode !== 200) {
    response.destroy?.();
    fail(
      'http-status',
      response.statusCode >= 300 && response.statusCode < 400
        ? '更新服务器重定向已拒绝'
        : '更新服务器暂时不可用',
    );
  }
  const encoding = header(response, 'content-encoding');
  if (encoding && encoding !== 'identity') {
    response.destroy?.();
    fail('invalid-encoding', '更新服务器响应编码无效');
  }
  const length = header(response, 'content-length');
  if (
    length !== undefined &&
    (typeof length !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(length) ||
      !Number.isSafeInteger(Number(length)) ||
      Number(length) > limit ||
      (exactSize !== undefined && Number(length) !== exactSize))
  ) {
    response.destroy?.();
    fail('invalid-length', '更新服务器响应大小无效');
  }
  return length === undefined ? null : Number(length);
}
function aborted(signal) {
  if (signal?.aborted) throw signal.reason || new UpdateError('cancelled', '下载已取消');
}
async function responseFor(request, url, controller, timeoutMs) {
  aborted(controller.signal);
  let listener;
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(controller.signal.reason || new UpdateError('cancelled', '下载已取消'));
    controller.signal.addEventListener('abort', listener, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => request(url, { signal: controller.signal, timeoutMs }));
    pending.then(
      (response) => {
        if (controller.signal.aborted) response?.destroy?.();
      },
      () => {},
    );
    return await Promise.race([pending, interrupted]);
  } finally {
    controller.signal.removeEventListener('abort', listener);
  }
}
async function consume(response, controller, consumeChunk) {
  const listener = () => response.destroy?.(controller.signal.reason);
  controller.signal.addEventListener('abort', listener, { once: true });
  try {
    aborted(controller.signal);
    for await (const chunk of response) {
      aborted(controller.signal);
      await consumeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    aborted(controller.signal);
  } finally {
    controller.signal.removeEventListener('abort', listener);
  }
}
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function samePackage(left, right) {
  return ['version', 'url', 'size', 'sha256'].every((key) => left[key] === right[key]);
}

class UpdateService {
  constructor({
    currentVersion,
    cacheDir,
    onChange = () => {},
    config = channel,
    request = defaultRequest,
    timeoutMs = 30000,
    downloadTimeoutMs = 1800000,
  }) {
    versionParts(currentVersion);
    configuration(config);
    if (
      typeof cacheDir !== 'string' ||
      !cacheDir ||
      typeof request !== 'function' ||
      typeof onChange !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isSafeInteger(downloadTimeoutMs) ||
      downloadTimeoutMs < 1
    )
      fail('invalid-options', '更新服务配置无效');
    this.cacheDir = path.resolve(cacheDir);
    if (samePath(this.cacheDir, path.parse(this.cacheDir).root)) fail('invalid-cache', '更新缓存目录无效');
    this.config = structuredClone(config);
    this.request = request;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this._state = {
      phase: 'idle',
      currentVersion,
      version: null,
      size: null,
      notes: [],
      progress: 0,
      error: '',
    };
    this._manifest = null;
    this._envelope = null;
    this._checkPromise = null;
    this._restorePromise = null;
    this._downloadPromise = null;
    this._downloadController = null;
  }
  status() {
    return structuredClone(this._state);
  }
  _set(change) {
    Object.assign(this._state, change);
    try {
      this.onChange(this.status());
    } catch {}
    return this.status();
  }
  _offer(manifest) {
    return { version: manifest.version, size: manifest.size, notes: [...manifest.notes] };
  }
  check() {
    if (this._checkPromise) return this._checkPromise;
    if (this._downloadPromise) return Promise.resolve(this.status());
    const start = () => {
      this._set({ phase: 'checking', error: '' });
      return this._check();
    };
    this._checkPromise = (this._restorePromise ? this._restorePromise.then(start) : start()).finally(() => {
      this._checkPromise = null;
    });
    return this._checkPromise;
  }
  async _check() {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new UpdateError('timeout', '检查更新超时，请稍后重试')),
      this.timeoutMs,
    );
    try {
      const response = await responseFor(this.request, MANIFEST_URL, controller, this.timeoutMs);
      const declared = validateResponse(response, MAX_MANIFEST_BYTES);
      const chunks = [];
      let size = 0;
      await consume(response, controller, (chunk) => {
        size += chunk.length;
        if (size > MAX_MANIFEST_BYTES) fail('manifest-too-large', '更新清单超过大小限制');
        chunks.push(chunk);
      });
      if (declared !== null && size !== declared) fail('invalid-length', '更新清单下载不完整');
      const envelope = Buffer.concat(chunks);
      const manifest = verifyManifest(envelope, this.config);
      if (compareVersions(manifest.version, this._state.currentVersion) <= 0) {
        this._manifest = this._envelope = null;
        return this._set({ phase: 'current', version: null, size: null, notes: [], progress: 0, error: '' });
      }
      this._manifest = manifest;
      this._envelope = envelope;
      try {
        await this._readReady();
        return this._set({ phase: 'ready', ...this._offer(manifest), progress: 100, error: '' });
      } catch {}
      return this._set({ phase: 'available', ...this._offer(manifest), progress: 0, error: '' });
    } catch (error) {
      try {
        const ready = await this._readReady(undefined, null);
        this._manifest = ready.manifest;
        this._envelope = ready.envelope;
        return this._set({
          phase: 'ready',
          ...this._offer(ready.manifest),
          progress: 100,
          error: '检查暂不可用，已下载更新可安装',
        });
      } catch {}
      return this._set({ phase: 'error', progress: 0, error: this._message(error) });
    } finally {
      clearTimeout(timer);
    }
  }
  _message(error) {
    return error instanceof UpdateError ? error.message : '更新未完成，请检查网络后重试';
  }
  _file(name) {
    if (!OWNED_FILE.test(name)) fail('invalid-cache', '更新缓存文件名无效');
    const file = path.join(this.cacheDir, name);
    if (path.dirname(file) !== this.cacheDir) fail('invalid-cache', '更新缓存路径无效');
    return file;
  }
  async _directory(create = false) {
    // Resolve the nearest existing ancestor before creating anything, so a
    // junction/symlink cannot redirect cache writes outside the configured path.
    let existing = this.cacheDir;
    for (;;) {
      try {
        const stat = await fs.promises.lstat(existing);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(existing), existing))
          fail('unsafe-cache', '更新缓存目录不安全');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) throw error;
        existing = path.dirname(existing);
      }
    }
    if (create) await fs.promises.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.cacheDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !samePath(await realpath(this.cacheDir), this.cacheDir)
    )
      fail('unsafe-cache', '更新缓存目录不安全');
  }
  async _remove(name) {
    const file = this._file(name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() && !stat.isSymbolicLink()) fail('unsafe-cache', '更新缓存文件不安全');
      await fs.promises.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async _cleanCache() {
    for (const name of await fs.promises.readdir(this.cacheDir))
      if (OWNED_FILE.test(name)) await this._remove(name);
  }
  async _openRead(name) {
    const file = this._file(name);
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) fail('unsafe-cache', '更新缓存文件不安全');
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      await handle.close();
      fail('unsafe-cache', '更新缓存文件发生变化');
    }
    return handle;
  }
  async _readReady(signal, expectedManifest = this._manifest) {
    aborted(signal);
    await this._directory();
    let handle = await this._openRead(CACHE_MANIFEST);
    let envelope;
    try {
      if ((await handle.stat()).size > MAX_MANIFEST_BYTES) fail('manifest-too-large', '更新缓存清单无效');
      envelope = await handle.readFile();
    } finally {
      await handle.close();
    }
    const manifest = verifyManifest(envelope, this.config);
    if (
      compareVersions(manifest.version, this._state.currentVersion) <= 0 ||
      (expectedManifest && !samePackage(expectedManifest, manifest))
    )
      fail('stale-cache', '更新缓存版本已失效，请重新下载');
    handle = await this._openRead(packageName(manifest.version));
    try {
      if ((await handle.stat()).size !== manifest.size)
        fail('invalid-size', '更新缓存包大小校验失败，请重新下载');
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        aborted(signal);
        bytes += chunk.length;
        if (bytes > manifest.size) fail('invalid-size', '更新缓存包大小校验失败，请重新下载');
        hash.update(chunk);
      }
      if (bytes !== manifest.size || hash.digest('hex') !== manifest.sha256)
        fail('invalid-hash', '更新缓存包校验失败，请重新下载');
    } finally {
      await handle.close();
    }
    aborted(signal);
    return { file: this._file(packageName(manifest.version)), manifest, envelope };
  }
  restoreDownloaded() {
    if (this._restorePromise) return this._restorePromise;
    if (this._checkPromise || this._downloadPromise) return Promise.resolve(this.status());
    this._restorePromise = this._restoreDownloaded().finally(() => {
      this._restorePromise = null;
    });
    return this._restorePromise;
  }
  async _restoreDownloaded() {
    try {
      const ready = await this._readReady(undefined, null);
      this._manifest = ready.manifest;
      this._envelope = ready.envelope;
      return this._set({ phase: 'ready', ...this._offer(ready.manifest), progress: 100, error: '' });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'stale-cache') {
        this._manifest = this._envelope = null;
        return this._set({ phase: 'idle', version: null, size: null, notes: [], progress: 0, error: '' });
      }
      return this._set({ phase: 'error', progress: 0, error: this._message(error) });
    }
  }
  async readyPackage() {
    if (this._downloadPromise) await this._downloadPromise;
    try {
      const ready = await this._readReady();
      this._set({
        phase: 'ready',
        ...this._offer(this._manifest || ready.manifest),
        progress: 100,
        error: '',
      });
      return { file: ready.file, manifest: ready.manifest };
    } catch (error) {
      this._set({ phase: 'error', progress: 0, error: this._message(error) });
      throw error;
    }
  }
  download() {
    if (this._downloadPromise) return this._downloadPromise;
    const controller = new AbortController();
    this._downloadController = controller;
    this._downloadPromise = this._download(controller).finally(() => {
      this._downloadPromise = null;
      this._downloadController = null;
    });
    return this._downloadPromise;
  }
  async _download(controller) {
    const timer = setTimeout(
      () => controller.abort(new UpdateError('timeout', '下载更新超时，请稍后重试')),
      this.downloadTimeoutMs,
    );
    let handle,
      manifest,
      createdPackage = false,
      prepared = false;
    try {
      if (this._checkPromise) await this._checkPromise;
      if (this._restorePromise) await this._restorePromise;
      aborted(controller.signal);
      if (!this._manifest || !this._envelope) fail('no-update', '请先检查可用更新');
      manifest = structuredClone(this._manifest);
      const envelope = Buffer.from(this._envelope);
      try {
        const ready = await this._readReady(controller.signal);
        this._set({ phase: 'ready', ...this._offer(manifest), progress: 100, error: '' });
        return { file: ready.file, manifest: ready.manifest };
      } catch (error) {
        aborted(controller.signal);
        if (error.code === 'unsafe-cache') throw error;
      }
      this._set({ phase: 'downloading', progress: 0, error: '' });
      await this._directory(true);
      aborted(controller.signal);
      await this._cleanCache();
      prepared = true;
      aborted(controller.signal);
      handle = await fs.promises.open(this._file(PARTIAL_FILE), 'wx', 0o600);
      const response = await responseFor(this.request, manifest.url, controller, this.timeoutMs);
      validateResponse(response, manifest.size, manifest.size);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      await consume(response, controller, async (chunk) => {
        bytes += chunk.length;
        if (bytes > manifest.size) fail('invalid-size', '更新包超过声明大小，下载已中止');
        hash.update(chunk);
        await handle.writeFile(chunk);
        const progress = Math.floor((bytes / manifest.size) * 100);
        if (progress !== this._state.progress) this._set({ progress });
      });
      if (bytes !== manifest.size) fail('invalid-size', '更新包下载不完整');
      if (hash.digest('hex') !== manifest.sha256) fail('invalid-hash', '更新包校验失败，请重新下载');
      await handle.sync();
      await handle.close();
      handle = null;
      aborted(controller.signal);
      await fs.promises.rename(this._file(PARTIAL_FILE), this._file(packageName(manifest.version)));
      createdPackage = true;
      const metadata = await fs.promises.open(this._file(MANIFEST_TEMP), 'wx', 0o600);
      try {
        await metadata.writeFile(envelope);
        await metadata.sync();
      } finally {
        await metadata.close();
      }
      aborted(controller.signal);
      await fs.promises.rename(this._file(MANIFEST_TEMP), this._file(CACHE_MANIFEST));
      this._set({ phase: 'ready', progress: 100, error: '' });
      return { file: this._file(packageName(manifest.version)), manifest };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
      }
      if (prepared) {
        for (const name of [
          PARTIAL_FILE,
          MANIFEST_TEMP,
          ...(createdPackage ? [packageName(manifest.version), CACHE_MANIFEST] : []),
        ])
          await this._remove(name).catch(() => {});
      }
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      this._set({
        phase: reason?.code === 'cancelled' ? 'available' : 'error',
        progress: 0,
        error: reason?.code === 'cancelled' ? '' : this._message(reason),
      });
      throw reason;
    } finally {
      clearTimeout(timer);
    }
  }
  cancel() {
    if (this._downloadController) {
      this._downloadController.abort(new UpdateError('cancelled', '下载已取消'));
      this._set({ phase: this._manifest ? 'available' : 'idle', progress: 0, error: '' });
    }
    return this.status();
  }
}

module.exports = { UpdateService, verifyManifest, compareVersions };
