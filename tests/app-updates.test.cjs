'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { UpdateService, verifyManifest, compareVersions } = require('../src/core/app-updates.cjs');
const channel = require('../src/data/update-channel.json');
const keys = crypto.generateKeyPairSync('ed25519');
const config = { ...channel, publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) };
const archive = Buffer.from('synthetic update archive; no game or personal data');
function payload(change = {}) {
  const version = change.version || '1.20.0';
  return {
    app: 'yijian-journal',
    version,
    platform: 'win32',
    arch: 'x64',
    publishedAt: '2026-10-15T09:00:00.000Z',
    url: `https://data.riftbuddy.dpdns.org/yijian-journal/YijianJournal-${version}-windows-x64.zip`,
    size: archive.length,
    sha256: crypto.createHash('sha256').update(archive).digest('hex'),
    notes: ['修复合成测试问题'],
    ...change,
  };
}
function signed(value = payload(), privateKey = keys.privateKey) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return {
    schemaVersion: 1,
    keyId: channel.keyId,
    payload: bytes.toString('base64'),
    signature: crypto.sign(null, bytes, privateKey).toString('base64'),
  };
}
function response(bytes, options = {}) {
  const stream = options.stream || Readable.from([bytes]);
  return Object.assign(stream, { statusCode: options.statusCode ?? 200, headers: options.headers || {} });
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [],
    states = [];
  const envelope = options.envelope || signed();
  const service = new UpdateService({
    currentVersion: '1.19.0',
    cacheDir: path.join(dir, 'updates'),
    config,
    onChange: (state) => states.push(state),
    request: async (url, requestOptions) => {
      requests.push(url);
      if (options.request) return options.request(url, requestOptions);
      return url === channel.manifestUrl
        ? response(Buffer.from(JSON.stringify(envelope)))
        : response(archive);
    },
    ...options.service,
  });
  return { dir, service, requests, states, envelope };
}
function assertCode(code) {
  return (error) => error.code === code;
}

test('stable versions compare numerically and reject ambiguous or unsafe versions', () => {
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.20.0', '1.20.0'), 0);
  for (const version of ['v1.2.3', '1.2', '1.2.3-beta', '1.2.3+build', '01.2.3', '1.2.9007199254740992'])
    assert.throws(() => compareVersions(version, '1.0.0'), assertCode('invalid-version'));
});

test('manifest authenticates exact bytes before interpreting payload and pins its signer', () => {
  assert.deepEqual(verifyManifest(signed(), config), payload());
  const tampered = signed();
  tampered.payload = Buffer.from('not JSON').toString('base64');
  assert.throws(() => verifyManifest(tampered, config), assertCode('invalid-signature'));
  assert.throws(() => verifyManifest(signed(Buffer.from('not JSON')), config), assertCode('invalid-json'));
  assert.throws(
    () => verifyManifest({ ...signed(), keyId: 'other-key' }, config),
    assertCode('untrusted-key'),
  );
  assert.throws(
    () => verifyManifest(signed(payload(), crypto.generateKeyPairSync('ed25519').privateKey), config),
    assertCode('invalid-signature'),
  );
  assert.throws(
    () => verifyManifest({ ...signed(), unexpected: true }, config),
    assertCode('invalid-envelope'),
  );
  const encoded = signed();
  encoded.payload += '\n';
  assert.throws(() => verifyManifest(encoded, config), assertCode('invalid-payload'));
  const duplicatePayload = JSON.stringify(payload()).replace('"app":', '"app":"ignored","app":');
  assert.throws(
    () => verifyManifest(signed(Buffer.from(duplicatePayload)), config),
    assertCode('invalid-json'),
  );
  const duplicateEnvelope = JSON.stringify(signed()).replace(
    '"schemaVersion":',
    '"schemaVersion":1,"schemaVersion":',
  );
  assert.throws(() => verifyManifest(duplicateEnvelope, config), assertCode('invalid-json'));
});

test('signed manifests enforce exact source, file name and strict payload fields', () => {
  for (const url of [
    'http://data.riftbuddy.dpdns.org/yijian-journal/YijianJournal-1.20.0-windows-x64.zip',
    'https://evil.example/yijian-journal/YijianJournal-1.20.0-windows-x64.zip',
    'https://user@data.riftbuddy.dpdns.org/yijian-journal/YijianJournal-1.20.0-windows-x64.zip',
    payload().url + '?token=1',
    payload().url + '#fragment',
    payload().url.replace('/yijian-journal/', '/other/'),
    payload().url.replace('1.20.0', '1.21.0'),
    payload().url.replace('YijianJournal', '%59ijianJournal'),
  ])
    assert.throws(() => verifyManifest(signed(payload({ url })), config), assertCode('untrusted-url'));
  for (const change of [
    { extra: true },
    { platform: 'linux' },
    { arch: 'arm64' },
    { app: 'other' },
    { size: 0 },
    { size: 1.5 },
    { size: 512 * 1024 * 1024 + 1 },
    { sha256: 'A'.repeat(64) },
    { notes: Array(9).fill('note') },
    { notes: ['字'.repeat(201)] },
    { notes: [7] },
    { notes: ['bad\u0000note'] },
    { publishedAt: '2026-02-30T09:00:00.000Z' },
    { publishedAt: '2026-10-15' },
    { publishedAt: '2026-10-15T25:00:00.000Z' },
  ])
    assert.throws(() => verifyManifest(signed(payload(change)), config));
  assert.equal(
    verifyManifest(signed(payload({ publishedAt: '2026-10-15T09:00:00Z' })), config).version,
    '1.20.0',
  );
  assert.throws(
    () => verifyManifest(signed(), { ...config, manifestUrl: 'https://evil.example/latest.json' }),
    assertCode('invalid-config'),
  );
});

test('checking only retrieves the small manifest and exposes detached player state', async (t) => {
  const { service, requests, states, dir } = fixture(t);
  assert.equal(service.status().phase, 'idle');
  const checked = await service.check();
  assert.equal(checked.phase, 'available');
  assert.deepEqual(requests, [channel.manifestUrl]);
  assert.equal(fs.existsSync(path.join(dir, 'updates')), false);
  checked.notes.push('external mutation');
  assert.equal(service.status().notes.length, 1);
  assert(!JSON.stringify(states).includes(dir));
  assert(!Object.hasOwn(service.status(), 'file'));
});

test('check requests are reused and current or older published versions never download', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { service, requests } = fixture(t, {
    request: async () => {
      await gate;
      return response(Buffer.from(JSON.stringify(signed(payload({ version: '1.18.0' })))));
    },
  });
  const first = service.check(),
    second = service.check();
  assert.equal(first, second);
  release();
  assert.equal((await first).phase, 'current');
  assert.equal(requests.length, 1);
  await assert.rejects(service.download(), assertCode('no-update'));
  assert.equal(requests.length, 1);
});

test('HTTP redirects, oversized manifest bodies and false declared lengths stop checking', async (t) => {
  for (const makeResponse of [
    () =>
      response(Buffer.alloc(0), {
        statusCode: 302,
        headers: { location: 'https://evil.example/latest.json' },
      }),
    () => response(Buffer.alloc(16 * 1024 + 1)),
    () => response(Buffer.alloc(0), { headers: { 'content-length': String(16 * 1024 + 1) } }),
    () => response(Buffer.from('{}'), { headers: { 'content-length': '3' } }),
  ]) {
    const { service, requests } = fixture(t, { request: async () => makeResponse() });
    assert.equal((await service.check()).phase, 'error');
    assert.equal(requests.length, 1);
  }
});

test('total timeout also bounds injected transports that ignore the abort signal', async (t) => {
  const { service } = fixture(t, { request: () => new Promise(() => {}), service: { timeoutMs: 20 } });
  assert.equal((await service.check()).phase, 'error');
  assert.match(service.status().error, /超时/);
});

test('download is explicit, reuses concurrent requests, streams the hash and revalidates its cache', async (t) => {
  const { service, requests, dir } = fixture(t);
  await service.check();
  const first = service.download(),
    second = service.download();
  assert.equal(first, second);
  const downloaded = await first;
  assert.equal(service.status().phase, 'ready');
  assert.equal(service.status().progress, 100);
  assert.deepEqual(fs.readFileSync(downloaded.file), archive);
  assert.deepEqual(requests, [channel.manifestUrl, payload().url]);
  assert.deepEqual((await service.readyPackage()).manifest, payload());
  downloaded.manifest.notes.push('mutation outside service');
  assert.equal(service.status().notes.length, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'updates')).filter((file) => file.endsWith('.zip')).length, 1);
  assert(!fs.readdirSync(path.join(dir, 'updates')).some((file) => /\.part$|\.tmp$/.test(file)));
  await service.download();
  assert.equal(requests.length, 2, 'a verified cache must not download twice');
  const restarted = new UpdateService({
    currentVersion: '1.19.0',
    cacheDir: path.join(dir, 'updates'),
    config,
    request: () => {
      throw Error('network must not be used');
    },
  });
  assert.equal((await restarted.readyPackage()).file, downloaded.file);
});

test('startup restores a downloaded update without any network request', async (t) => {
  const { service, dir } = fixture(t);
  await service.check();
  const downloaded = await service.download();
  const restarted = new UpdateService({
    currentVersion: '1.19.0',
    cacheDir: path.join(dir, 'updates'),
    config,
    request: () => {
      throw Error('startup restore must not request the network');
    },
  });
  const first = restarted.restoreDownloaded(),
    second = restarted.restoreDownloaded();
  assert.equal(first, second);
  const restored = await first;
  assert.equal(restored.phase, 'ready');
  assert.equal(restored.version, '1.20.0');
  assert.equal(restored.progress, 100);
  assert.equal(restored.error, '');
  assert(!JSON.stringify(restored).includes(dir));
  assert.equal((await restarted.readyPackage()).file, downloaded.file);
  assert.equal((await restarted.download()).file, downloaded.file);
});

test('no downloaded cache or an already installed cache restores to idle', async (t) => {
  const { service, dir, requests } = fixture(t);
  assert.equal((await service.restoreDownloaded()).phase, 'idle');
  assert.equal(service.status().error, '');
  assert.equal(requests.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'updates')), false);
  await service.check();
  await service.download();
  const installed = new UpdateService({
    currentVersion: '1.20.0',
    cacheDir: path.join(dir, 'updates'),
    config,
  });
  assert.equal((await installed.restoreDownloaded()).phase, 'idle');
  assert.equal(installed.status().error, '');
});

test('rechecking a downloaded package stays ready and does not download the archive again', async (t) => {
  const { service, requests } = fixture(t);
  await service.check();
  await service.download();
  assert.equal((await service.check()).phase, 'ready');
  assert.equal((await service.check()).phase, 'ready');
  assert.equal(service.status().progress, 100);
  assert.equal(requests.filter((url) => url === payload().url).length, 1);
  const restarted = new UpdateService({
    currentVersion: '1.19.0',
    cacheDir: service.cacheDir,
    config,
    request: async () => response(Buffer.from(JSON.stringify(signed()))),
  });
  assert.equal((await restarted.check()).phase, 'ready');
});

test('the same package with republished notes and timestamp reuses its verified archive', async (t) => {
  let envelope = signed();
  const { service, requests } = fixture(t, {
    request: async (url) =>
      url === channel.manifestUrl ? response(Buffer.from(JSON.stringify(envelope))) : response(archive),
  });
  await service.check();
  await service.download();
  envelope = signed(payload({ notes: ['补充更新说明'], publishedAt: '2026-10-16T10:11:12Z' }));
  assert.equal((await service.check()).phase, 'ready');
  assert.deepEqual(service.status().notes, ['补充更新说明']);
  await service.readyPackage();
  assert.deepEqual(service.status().notes, ['补充更新说明']);
  await service.download();
  assert.equal(requests.filter((url) => url === payload().url).length, 1);
  envelope = signed(payload({ sha256: 'a'.repeat(64) }));
  assert.equal(
    (await service.check()).phase,
    'available',
    'a different archive under the same version must not reuse stale bytes',
  );
  await assert.rejects(service.readyPackage(), assertCode('stale-cache'));
});

test('an unavailable server preserves an independently verified downloaded update', async (t) => {
  let offline = false;
  const { service, dir } = fixture(t, {
    request: async (url) => {
      if (offline) throw Object.assign(Error('synthetic offline network'), { code: 'ENETUNREACH' });
      return url === channel.manifestUrl
        ? response(Buffer.from(JSON.stringify(signed())))
        : response(archive);
    },
  });
  await service.check();
  await service.download();
  offline = true;
  const checked = await service.check();
  assert.equal(checked.phase, 'ready');
  assert.equal(checked.error, '检查暂不可用，已下载更新可安装');
  const restarted = new UpdateService({
    currentVersion: '1.19.0',
    cacheDir: path.join(dir, 'updates'),
    config,
    request: async () => {
      throw Error('synthetic offline network');
    },
  });
  assert.equal((await restarted.check()).phase, 'ready');
  assert.match(restarted.status().error, /已下载更新可安装/);
  assert.equal((await restarted.readyPackage()).manifest.version, '1.20.0');
});

test('neither startup nor offline fallback accepts tampered cached archives or signatures', async (t) => {
  for (const tamper of [
    (dir, file) => fs.writeFileSync(file, Buffer.alloc(archive.length, 9)),
    (dir, file) => fs.writeFileSync(file, archive.subarray(1)),
    (dir) => {
      const bad = signed();
      bad.signature = Buffer.alloc(64).toString('base64');
      fs.writeFileSync(path.join(dir, 'updates', 'manifest.json'), JSON.stringify(bad));
    },
  ]) {
    const { service, dir } = fixture(t);
    await service.check();
    const { file } = await service.download();
    tamper(dir, file);
    const restarted = new UpdateService({
      currentVersion: '1.19.0',
      cacheDir: path.join(dir, 'updates'),
      config,
      request: async () => {
        throw Error('synthetic offline network');
      },
    });
    assert.equal((await restarted.restoreDownloaded()).phase, 'error');
    assert.equal((await restarted.check()).phase, 'error');
    await assert.rejects(restarted.readyPackage());
  }
});

test('oversized streaming body, wrong hash, short body and redirect leave no partial package', async (t) => {
  for (const makeResponse of [
    () => response(Buffer.concat([archive, Buffer.from('excess')])),
    () => response(Buffer.alloc(archive.length, 1)),
    () => response(archive.subarray(1)),
    () => response(archive, { statusCode: 307, headers: { location: payload().url } }),
    () => response(archive, { headers: { 'content-length': String(archive.length + 1) } }),
  ]) {
    const { service, dir } = fixture(t, {
      request: async (url) =>
        url === channel.manifestUrl ? response(Buffer.from(JSON.stringify(signed()))) : makeResponse(),
    });
    await service.check();
    await assert.rejects(service.download());
    assert.equal(service.status().phase, 'error');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'updates')), []);
  }
});

test('excess streaming bytes destroy the response before accepting more data', async (t) => {
  let readCount = 0;
  const stream = Readable.from(
    (async function* () {
      readCount++;
      yield Buffer.alloc(archive.length + 1);
      readCount++;
      yield Buffer.alloc(1024 * 1024);
    })(),
  );
  const { service } = fixture(t, {
    request: async (url) =>
      url === channel.manifestUrl
        ? response(Buffer.from(JSON.stringify(signed())))
        : response(null, { stream }),
  });
  await service.check();
  await assert.rejects(service.download(), assertCode('invalid-size'));
  assert(stream.destroyed);
  assert(readCount <= 2);
});

test('cancel aborts a downloading stream and permits a clean retry', async (t) => {
  const stream = new PassThrough();
  let start;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  let attempts = 0;
  const { service, dir } = fixture(t, {
    request: async (url) => {
      if (url === channel.manifestUrl) return response(Buffer.from(JSON.stringify(signed())));
      if (++attempts > 1) return response(archive);
      start();
      return response(null, { stream });
    },
  });
  await service.check();
  const download = service.download();
  await started;
  service.cancel();
  await assert.rejects(download, assertCode('cancelled'));
  assert.equal(service.status().phase, 'available');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'updates')), []);
  await service.download();
  assert.equal(service.status().phase, 'ready');
});

test('an immediate cancel prevents the download from starting its network request', async (t) => {
  const { service, requests } = fixture(t);
  await service.check();
  const download = service.download();
  service.cancel();
  await assert.rejects(download, assertCode('cancelled'));
  assert.deepEqual(requests, [channel.manifestUrl]);
  assert.equal(service.status().phase, 'available');
});

test('download deadline aborts a hanging transfer and removes its partial file', async (t) => {
  const { service, dir } = fixture(t, {
    service: { downloadTimeoutMs: 20 },
    request: async (url) =>
      url === channel.manifestUrl
        ? response(Buffer.from(JSON.stringify(signed())))
        : response(null, { stream: new PassThrough() }),
  });
  await service.check();
  await assert.rejects(service.download(), assertCode('timeout'));
  assert.equal(service.status().phase, 'error');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'updates')), []);
});

test('installation validation rejects modified archives, manifests and stale cached versions', async (t) => {
  const { service, dir } = fixture(t);
  await service.check();
  const { file } = await service.download();
  fs.writeFileSync(file, Buffer.alloc(archive.length, 9));
  await assert.rejects(service.readyPackage(), assertCode('invalid-hash'));
  assert.equal(service.status().phase, 'error');
  await service.download();
  const manifestFile = path.join(dir, 'updates', 'manifest.json');
  const bad = JSON.parse(fs.readFileSync(manifestFile));
  bad.signature = Buffer.alloc(64).toString('base64');
  fs.writeFileSync(manifestFile, JSON.stringify(bad));
  await assert.rejects(service.readyPackage(), assertCode('invalid-signature'));
  fs.writeFileSync(manifestFile, JSON.stringify(signed(payload({ version: '1.18.0' }))));
  await assert.rejects(service.readyPackage(), assertCode('stale-cache'));
});

test('cache only replaces its own previous package and preserves unrelated files', async (t) => {
  const { service, dir } = fixture(t);
  const cache = path.join(dir, 'updates');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'YijianJournal-1.18.0-windows-x64.zip'), 'old synthetic cache');
  fs.writeFileSync(path.join(cache, 'unrelated.txt'), 'keep');
  await service.check();
  await service.download();
  assert.equal(fs.readFileSync(path.join(cache, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(fs.readdirSync(cache).filter((file) => file.endsWith('.zip')).length, 1);
});

test('a redirected cache directory never writes into its symlink target', async (t) => {
  const { service, dir } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-update-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(dir, 'updates'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('symlink privilege unavailable');
      return;
    }
    throw error;
  }
  await service.check();
  await assert.rejects(service.download(), assertCode('unsafe-cache'));
  assert.deepEqual(fs.readdirSync(outside), []);
});
