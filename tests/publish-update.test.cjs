'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { signedFeed, activateScript } = require('../scripts/publish-update.cjs');
const { verifyManifest } = require('../src/core/app-updates.cjs');
const channel = require('../src/data/update-channel.json');

const keys = crypto.generateKeyPairSync('ed25519');
const config = { ...channel, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const archive = Buffer.from('synthetic release archive; no game or personal data');
const posixOnly = { skip: process.platform === 'win32' ? 'Run Linux activation checks in WSL' : false };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-publish-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'synthetic-key.pem');
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const root = path.join(dir, 'updates');
  fs.mkdirSync(root);
  function feed(version, bytes = archive, notes = ['合成测试更新']) {
    const zip = path.join(dir, `synthetic-${crypto.randomUUID()}.zip`);
    fs.writeFileSync(zip, bytes);
    return signedFeed({ version, zip, keyFile, notes, config });
  }
  function stage(version, bytes = archive, notes) {
    const uploadId = crypto.randomUUID();
    const incoming = path.join(root, `.incoming-${uploadId}`);
    fs.mkdirSync(incoming);
    const envelope = feed(version, bytes, notes);
    fs.writeFileSync(path.join(incoming, 'package.zip'), bytes);
    fs.writeFileSync(path.join(incoming, 'latest.json'), JSON.stringify(envelope) + '\n');
    return { uploadId, incoming, envelope };
  }
  function current(version, bytes = archive) {
    const envelope = feed(version, bytes);
    fs.writeFileSync(path.join(root, packageName(version)), bytes);
    const manifest = JSON.stringify(envelope) + '\n';
    fs.writeFileSync(path.join(root, 'latest.json'), manifest);
    return manifest;
  }
  function activate(upload, prefix = '') {
    const script = activateScript(upload.uploadId);
    assert.equal(script.split("'/srv/yijian-journal'").length, 2);
    return spawnSync('python3', ['-'], {
      input: prefix + script.replace("'/srv/yijian-journal'", JSON.stringify(root)),
      encoding: 'utf8',
    });
  }
  return { dir, root, keyFile, feed, stage, current, activate };
}
function packageName(version) {
  return `YijianJournal-${version}-windows-x64.zip`;
}
function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function failure(result, message) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  if (message) assert.match(result.stderr, message);
}

test('release signing authenticates exact synthetic archive bytes with the configured trust anchor', (t) => {
  const { feed } = fixture(t);
  const envelope = feed('1.20.0');
  const manifest = verifyManifest(envelope, config);
  assert.equal(manifest.version, '1.20.0');
  assert.equal(manifest.size, archive.length);
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(archive).digest('hex'));
  assert.equal(manifest.url, new URL(packageName('1.20.0'), channel.manifestUrl).href);
  assert.deepEqual(manifest.notes, ['合成测试更新']);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(envelope.payload, 'base64'),
      keys.publicKey,
      Buffer.from(envelope.signature, 'base64'),
    ),
    true,
  );
});

test('release signing rejects a foreign signer, unsupported key and invalid release metadata', (t) => {
  const { dir, keyFile, feed } = fixture(t);
  const zip = path.join(dir, 'archive.zip');
  fs.writeFileSync(zip, archive);
  const options = { version: '1.20.0', zip, keyFile, notes: [], config };
  const foreign = crypto.generateKeyPairSync('ed25519');
  assert.throws(
    () =>
      signedFeed({
        ...options,
        config: { ...config, publicKey: foreign.publicKey.export({ type: 'spki', format: 'pem' }) },
      }),
    /trust anchor/,
  );
  const otherKey = path.join(dir, 'synthetic-ec.pem');
  fs.writeFileSync(
    otherKey,
    crypto
      .generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  assert.throws(() => signedFeed({ ...options, keyFile: otherKey }), /Ed25519/);
  for (const version of ['1x20x0', '01.20.0', '1.20.0-beta']) assert.throws(() => feed(version));
  assert.throws(() => feed('1.20.0', archive, [7]));
  assert.throws(() => feed('1.20.0', Buffer.alloc(0)));
});

test('activation script accepts only a bounded upload identity and Python 3.9 syntax', posixOnly, () => {
  for (const uploadId of ['../outside', "a'.replace()", 'a'.repeat(37)])
    assert.throws(() => activateScript(uploadId), /upload identity/);
  const result = spawnSync(
    'python3',
    ['-c', 'import ast,sys;ast.parse(sys.stdin.read(),feature_version=(3,9))'],
    {
      input: activateScript(crypto.randomUUID()),
      encoding: 'utf8',
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test(
  'a first release publishes a complete manifest and archive with public read permissions',
  posixOnly,
  (t) => {
    const { root, stage, activate } = fixture(t);
    const upload = stage('1.19.0');
    const result = success(activate(upload));
    assert.equal(result.version, '1.19.0');
    assert.equal(result.size, archive.length);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['.publish.lock', packageName('1.19.0'), 'latest.json'].sort(),
    );
    const latest = path.join(root, 'latest.json');
    const file = path.join(root, packageName('1.19.0'));
    assert.deepEqual(verifyManifest(fs.readFileSync(latest), config).sha256, result.sha256);
    assert.deepEqual(fs.readFileSync(file), archive);
    for (const target of [latest, file]) assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  },
);

test(
  'activation retains only the newest owned archive and preserves similarly named or unrelated files',
  posixOnly,
  (t) => {
    const { root, current, stage, activate } = fixture(t);
    current('1.9.0');
    fs.writeFileSync(path.join(root, packageName('1.18.0')), 'older synthetic archive');
    const preserved = [
      'notes.txt',
      'YijianJournal-1x18x0-windows-x64azip',
      'YijianJournal-01.18.0-windows-x64.zip',
      'YijianJournal-1.18.0-beta-windows-x64.zip',
      'YijianJournal-1.18.0-windows-x64.zip.backup',
      'YijianJournal-1.18.0-linux-x64.zip',
    ];
    for (const name of preserved) fs.writeFileSync(path.join(root, name), 'preserve this file');
    const otherUpload = path.join(root, `.incoming-${crypto.randomUUID()}`);
    fs.mkdirSync(otherUpload);
    fs.writeFileSync(path.join(otherUpload, 'package.zip'), 'another publisher');
    const upload = stage('1.20.0');
    const result = success(activate(upload));
    assert.deepEqual(result.removed.sort(), [packageName('1.9.0'), packageName('1.18.0')].sort());
    assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.20.0'))), archive);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'latest.json'))), upload.envelope);
    assert.equal(fs.existsSync(upload.incoming), false);
    for (const name of preserved)
      assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'preserve this file');
    assert.equal(fs.readFileSync(path.join(otherUpload, 'package.zip'), 'utf8'), 'another publisher');
  },
);

test('damaged or truncated uploads fail without changing the current manifest or package', posixOnly, (t) => {
  for (const bytes of [Buffer.alloc(archive.length, 7), archive.subarray(1)]) {
    const { root, current, stage, activate } = fixture(t);
    const previous = current('1.19.0');
    const upload = stage('1.20.0');
    fs.writeFileSync(path.join(upload.incoming, 'package.zip'), bytes);
    failure(activate(upload));
    assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
    assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.19.0'))), archive);
    assert.equal(fs.existsSync(path.join(root, packageName('1.20.0'))), false);
  }
});

test('downgrades and changed bytes under a published version preserve the active release', posixOnly, (t) => {
  for (const [version, bytes, message] of [
    ['1.9.0', archive, /Refusing downgrade/],
    ['1.20.0', Buffer.from('different synthetic release'), /different bytes/],
  ]) {
    const { root, current, stage, activate } = fixture(t);
    const previous = current('1.20.0');
    failure(activate(stage(version, bytes)), message);
    assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
    assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.20.0'))), archive);
  }
});

test(
  'an identical version can refresh metadata but a corrupt existing destination is never overwritten',
  posixOnly,
  (t) => {
    const { root, current, stage, activate } = fixture(t);
    current('1.20.0');
    const upload = stage('1.20.0', archive, ['刷新合成更新说明']);
    assert.deepEqual(success(activate(upload)).removed, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'latest.json'))), upload.envelope);
    const previous = fs.readFileSync(path.join(root, 'latest.json'), 'utf8');
    fs.writeFileSync(path.join(root, packageName('1.21.0')), 'corrupt existing destination');
    failure(activate(stage('1.21.0')));
    assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
    assert.equal(
      fs.readFileSync(path.join(root, packageName('1.21.0')), 'utf8'),
      'corrupt existing destination',
    );
  },
);

test(
  'unsafe matching cleanup entries fail before changing the current release and never affect link targets',
  posixOnly,
  (t) => {
    for (const kind of ['directory', 'symlink']) {
      const { dir, root, current, stage, activate } = fixture(t);
      const previous = current('1.19.0');
      const unsafe = path.join(root, packageName('1.18.0'));
      const outside = path.join(dir, 'unrelated.txt');
      fs.writeFileSync(outside, 'preserve unrelated target');
      if (kind === 'directory') fs.mkdirSync(unsafe);
      else fs.symlinkSync(outside, unsafe);
      failure(activate(stage('1.20.0')));
      assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
      assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.19.0'))), archive);
      assert.equal(fs.existsSync(path.join(root, packageName('1.20.0'))), false);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve unrelated target');
      assert.equal(fs.lstatSync(unsafe).isSymbolicLink(), kind === 'symlink');
    }
  },
);

test('an interrupted manifest replacement keeps the complete old release available', posixOnly, (t) => {
  const { root, current, stage, activate } = fixture(t);
  const previous = current('1.19.0');
  const upload = stage('1.20.0');
  const prefix = `import os\nreplace_original=os.replace\ndef interrupt_manifest(source,destination):\n if os.fspath(destination)==${JSON.stringify(path.join(root, 'latest.json'))}:\n  assert os.path.isfile(${JSON.stringify(path.join(root, packageName('1.20.0')))})\n  assert open(destination).read()==${JSON.stringify(previous)}\n  assert os.path.isfile(${JSON.stringify(path.join(root, packageName('1.19.0')))})\n  raise OSError('synthetic manifest swap failure')\n return replace_original(source,destination)\nos.replace=interrupt_manifest\n`;
  failure(activate(upload, prefix), /synthetic manifest swap failure/);
  assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
  assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.19.0'))), archive);
  assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.20.0'))), archive);
  assert.equal(fs.existsSync(path.join(upload.incoming, 'latest.json')), true);
});

test('dangling active manifest or destination links are preserved and stop activation', posixOnly, (t) => {
  for (const name of ['latest.json', packageName('1.20.0')]) {
    const { dir, root, current, stage, activate } = fixture(t);
    const previous = current('1.19.0');
    const target = path.join(root, name);
    const missing = path.join(dir, 'nonexistent-target');
    if (name === 'latest.json') fs.unlinkSync(target);
    fs.symlinkSync(missing, target);
    failure(activate(stage('1.20.0')));
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(target), missing);
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.19.0'))), archive);
    if (name !== 'latest.json')
      assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
  }
});
