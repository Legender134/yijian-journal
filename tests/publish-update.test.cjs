'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  verifyReleaseZip,
  signedFeed,
  prepareUploadScript,
  activateScript,
} = require('../scripts/publish-update.cjs');
const { verifyManifest } = require('../src/core/app-updates.cjs');
const channel = require('../src/data/update-channel.json');

const keys = crypto.generateKeyPairSync('ed25519');
const config = { ...channel, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const archive = Buffer.from('synthetic release archive; no game or personal data');
const posixOnly = { skip: process.platform === 'win32' ? 'Run Linux activation checks in WSL' : false };
const windowsOnly = {
  skip: process.platform !== 'win32' ? 'Run native ZIP publication checks on Windows' : false,
};

function archiveIdentity(bytes) {
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

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
    return signedFeed({ version, zip, keyFile, notes, config, verifiedArchive: archiveIdentity(bytes) });
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
  function runScript(script, prefix = '') {
    assert.equal(script.split("'/srv/yijian-journal'").length, 2);
    return spawnSync('python3', ['-'], {
      input: prefix + script.replace("'/srv/yijian-journal'", JSON.stringify(root)),
      encoding: 'utf8',
    });
  }
  function activate(upload, prefix = '') {
    return runScript(activateScript(upload.uploadId), prefix);
  }
  function prepare(uploadId) {
    return runScript(prepareUploadScript(uploadId));
  }
  return { dir, root, keyFile, feed, stage, current, activate, prepare };
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

function zipFixture(t) {
  const setup = fixture(t);
  const folder = path.join(setup.dir, '逸剑手札-win32-x64');
  const files = [
    ['逸剑手札.exe', Buffer.from('synthetic executable')],
    ['resources/app.asar', Buffer.from('synthetic audited asar')],
    ['使用说明.txt', Buffer.from('合成发行内容')],
    ['.hidden', Buffer.from('synthetic hidden output')],
  ];
  for (const [name, bytes] of files) {
    const file = path.join(folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.mkdirSync(path.join(folder, 'empty'));
  const prefix = path.basename(folder) + '/';
  const entries = files.map(([name, bytes]) => ({ name: prefix + name, data: bytes.toString('base64') }));
  entries.push({ name: prefix + 'empty/', data: '' });
  function createZip(contents = entries) {
    const zip = path.join(setup.dir, `synthetic-${crypto.randomUUID()}.zip`);
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [IO.Compression.ZipFile]::Open($env:YIJIAN_TEST_ZIP_PATH, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in (ConvertFrom-Json $env:YIJIAN_TEST_ZIP_ENTRIES)) {
    $entry = $archive.CreateEntry($item.name)
    if ($null -ne $item.attributes) { $entry.ExternalAttributes = $item.attributes }
    $stream = $entry.Open()
    try {
      $bytes = [Convert]::FromBase64String($item.data)
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
  }
} finally { $archive.Dispose() }`,
      ],
      {
        env: {
          ...process.env,
          YIJIAN_TEST_ZIP_PATH: zip,
          YIJIAN_TEST_ZIP_ENTRIES: JSON.stringify(contents),
        },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return zip;
  }
  return { ...setup, folder, entries, createZip };
}

test(
  'native publication gate verifies the full tree and hashes of a canonical release ZIP before signing',
  windowsOnly,
  (t) => {
    const { folder, createZip, keyFile } = zipFixture(t);
    const zip = createZip();
    const verifiedArchive = verifyReleaseZip({ zip, folder });
    assert.deepEqual(verifiedArchive, { ...archiveIdentity(fs.readFileSync(zip)), fileCount: 4 });
    const envelope = signedFeed({ version: '1.20.0', zip, keyFile, notes: [], config, verifiedArchive });
    assert.equal(verifyManifest(envelope, config).sha256, verifiedArchive.sha256);
  },
);

test(
  'native publication gate rejects stale bytes, omitted output, foreign files and missing empty directories',
  windowsOnly,
  (t) => {
    const { folder, entries, createZip } = zipFixture(t);
    for (const [contents, message] of [
      [
        entries.map((entry, index) =>
          index === 1 ? { ...entry, data: Buffer.from('different audited asar').toString('base64') } : entry,
        ),
        /ZIP entry hash differs/,
      ],
      [entries.slice(1), /ZIP entry set differs/],
      [[...entries, { name: path.basename(folder) + '/unrelated.txt', data: '' }], /Foreign ZIP file/],
      [entries.slice(0, -1), /ZIP entry set differs/],
    ]) {
      assert.throws(() => verifyReleaseZip({ zip: createZip(contents), folder }), message);
    }
  },
);

test(
  'native publication gate rejects duplicate entries, case collisions, unsafe paths and ZIP links',
  windowsOnly,
  (t) => {
    const { folder, entries, createZip } = zipFixture(t);
    const prefix = path.basename(folder) + '/';
    for (const [entry, message] of [
      [entries[0], /Duplicate ZIP entry/],
      [{ ...entries[1], name: prefix + 'resources/APP.ASAR' }, /Duplicate ZIP entry/],
      [{ name: 'other-root/file.txt', data: '' }, /Foreign ZIP directory/],
      ...[
        '../outside',
        '/absolute',
        'C:/drive',
        prefix + '../outside',
        prefix + './file',
        prefix + 'resources\\file',
        prefix + 'resources//file',
      ].map((name) => [{ name, data: '' }, /Unsafe ZIP entry path/]),
      [{ ...entries[0], name: prefix + 'link', attributes: 0xa1ff << 16 }, /ZIP contains a link/],
    ]) {
      assert.throws(() => verifyReleaseZip({ zip: createZip([...entries, entry]), folder }), message);
    }
  },
);

test('release signing requires a verified archive and rejects any later byte replacement', (t) => {
  const { dir, keyFile } = fixture(t);
  const zip = path.join(dir, 'synthetic.zip');
  fs.writeFileSync(zip, archive);
  const options = { version: '1.20.0', zip, keyFile, notes: [], config };
  assert.throws(() => signedFeed(options), /verified release ZIP/);
  const verifiedArchive = archiveIdentity(archive);
  fs.writeFileSync(zip, Buffer.alloc(archive.length, 9));
  assert.throws(() => signedFeed({ ...options, verifiedArchive }), /changed after verification/);
});

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
  const options = {
    version: '1.20.0',
    zip,
    keyFile,
    notes: [],
    config,
    verifiedArchive: archiveIdentity(archive),
  };
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
  for (const uploadId of ['../outside', "a'.replace()", 'a'.repeat(37)]) {
    assert.throws(() => activateScript(uploadId), /upload identity/);
    assert.throws(() => prepareUploadScript(uploadId), /upload identity/);
  }
  const result = spawnSync(
    'python3',
    ['-c', 'import ast,sys;ast.parse(sys.stdin.read(),feature_version=(3,9))'],
    {
      input: prepareUploadScript(crypto.randomUUID()) + '\n' + activateScript(crypto.randomUUID()),
      encoding: 'utf8',
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('publication claims only one upload and stops before sending another archive', posixOnly, (t) => {
  const { root, current, prepare } = fixture(t);
  const previous = current('1.19.0');
  const firstId = crypto.randomUUID();
  const first = path.join(root, '.incoming-' + firstId);
  const started = prepare(firstId);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(fs.readdirSync(first), []);
  assert.equal(fs.statSync(first).mode & 0o777, 0o700);
  const secondId = crypto.randomUUID();
  failure(prepare(secondId), /Unfinished upload\(s\)/);
  assert.equal(fs.existsSync(path.join(root, '.incoming-' + secondId)), false);
  assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
  assert.deepEqual(fs.readdirSync(first), []);
});

test(
  'interrupted or active staging blocks activation without changing releases or deleting uploads',
  posixOnly,
  (t) => {
    for (const kind of ['abandoned', 'active', 'linked']) {
      const { dir, root, current, stage, activate, prepare } = fixture(t);
      const previous = current('1.19.0');
      const oldIncoming = path.join(root, '.incoming-' + crypto.randomUUID());
      const preserved = kind === 'linked' ? path.join(dir, 'unrelated') : oldIncoming;
      fs.mkdirSync(preserved);
      fs.writeFileSync(path.join(preserved, 'package.zip'), 'preserve pending or unrelated bytes');
      if (kind === 'linked') fs.symlinkSync(preserved, oldIncoming, 'dir');
      if (kind === 'abandoned') fs.utimesSync(oldIncoming, 1, 1);
      failure(prepare(crypto.randomUUID()), /Unfinished upload\(s\)/);
      const upload = stage('1.20.0');
      const blocked = activate(upload);
      failure(blocked, /Latest-only retention is incomplete/);
      assert.equal(blocked.stdout, '', 'an incomplete publication does not claim a retained set');
      assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), previous);
      assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.19.0'))), archive);
      assert.equal(fs.existsSync(path.join(root, packageName('1.20.0'))), false);
      assert.equal(
        fs.readFileSync(path.join(preserved, 'package.zip'), 'utf8'),
        'preserve pending or unrelated bytes',
      );
      assert.deepEqual(fs.readFileSync(path.join(upload.incoming, 'package.zip')), archive);
      // Simulate the operator resolving this exact, known synthetic upload.
      if (kind === 'linked') fs.unlinkSync(oldIncoming);
      else fs.rmSync(oldIncoming, { recursive: true });
      const published = success(activate(upload));
      assert.deepEqual(published.retained, fs.readdirSync(root).sort());
      assert.deepEqual(published.retained, ['.publish.lock', packageName('1.20.0'), 'latest.json'].sort());
      if (kind === 'linked')
        assert.equal(
          fs.readFileSync(path.join(preserved, 'package.zip'), 'utf8'),
          'preserve pending or unrelated bytes',
        );
    }
  },
);

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
    const upload = stage('1.20.0');
    const result = success(activate(upload));
    assert.deepEqual(result.removed.sort(), [packageName('1.9.0'), packageName('1.18.0')].sort());
    assert.deepEqual(fs.readFileSync(path.join(root, packageName('1.20.0'))), archive);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'latest.json'))), upload.envelope);
    assert.equal(fs.existsSync(upload.incoming), false);
    for (const name of preserved)
      assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'preserve this file');
    assert.deepEqual(
      result.retained,
      fs.readdirSync(root).sort(),
      'receipt includes preserved unrelated entries',
    );
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
