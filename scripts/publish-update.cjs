'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { audit } = require('./release-audit.cjs');
const { verifyManifest } = require('../src/core/app-updates.cjs');
const channel = require('../src/data/update-channel.json');
const base = path.resolve(__dirname, '..');

function verifyReleaseZip({ zip, folder }) {
  if (process.platform !== 'win32') throw Error('Release ZIP verification requires Windows PowerShell');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
function Stream-Hash($stream) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
$files = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
function Read-Directory($directory, [string]$relative) {
  if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Audited output contains a link' }
  [void]$directories.Add($relative)
  foreach ($item in $directory.EnumerateFileSystemInfos()) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Audited output contains a link' }
    if ($item.Attributes -band [IO.FileAttributes]::Directory) { Read-Directory $item ($relative + $item.Name + '/') }
    else {
      $stream = $item.OpenRead()
      try { $files.Add(($relative + $item.Name), @{ size = $stream.Length; sha256 = (Stream-Hash $stream) }) }
      finally { $stream.Dispose() }
    }
  }
}
$folder = [IO.DirectoryInfo]::new($env:YIJIAN_UPDATE_FOLDER)
if (!$folder.Exists) { throw 'Audited output directory is missing' }
Read-Directory $folder ($folder.Name + '/')
$zipFile = [IO.FileInfo]::new($env:YIJIAN_UPDATE_ZIP)
if (!$zipFile.Exists -or ($zipFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release ZIP is missing or linked' }
$zipStream = $zipFile.OpenRead()
try {
  $archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $foundDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $fileCount = 0
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName
      $parts = @($name.TrimEnd('/').Split('/'))
      if (!$name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or $name -match '[\x00-\x1f\x7f]' -or
          @($parts | Where-Object { !$_ -or $_ -eq '.' -or $_ -eq '..' -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count) { throw ('Unsafe ZIP entry path: ' + $name) }
      if (!$seen.Add($name.TrimEnd('/'))) { throw 'Duplicate ZIP entry' }
      if ((($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000 -or ($entry.ExternalAttributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ZIP contains a link' }
      $isDirectory = $name.EndsWith('/')
      $directoryParts = if ($isDirectory) { $parts.Count } else { $parts.Count - 1 }
      for ($i = 1; $i -le $directoryParts; $i++) {
        $parent = ($parts[0..($i - 1)] -join '/') + '/'
        if (!$directories.Contains($parent)) { throw 'Foreign ZIP directory' }
        [void]$foundDirectories.Add($parent)
      }
      if ($isDirectory) {
        if ($entry.Length -ne 0) { throw 'ZIP directory has content' }
        continue
      }
      if (!$files.ContainsKey($name)) { throw 'Foreign ZIP file' }
      $expected = $files[$name]
      if ($entry.Length -ne $expected.size) { throw 'ZIP entry size differs from audited output' }
      $stream = $entry.Open()
      try { if ((Stream-Hash $stream) -ne $expected.sha256) { throw 'ZIP entry hash differs from audited output' } }
      finally { $stream.Dispose() }
      $fileCount++
    }
    if ($fileCount -ne $files.Count -or !$foundDirectories.SetEquals($directories)) { throw 'ZIP entry set differs from audited output' }
  } finally { $archive.Dispose() }
  $zipStream.Position = 0
  @{ size = $zipStream.Length; sha256 = (Stream-Hash $zipStream); fileCount = $fileCount } | ConvertTo-Json -Compress
} finally { $zipStream.Dispose() }`,
    ],
    {
      env: {
        ...process.env,
        YIJIAN_UPDATE_ZIP: path.resolve(zip),
        YIJIAN_UPDATE_FOLDER: path.resolve(folder),
      },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw Error(result.error?.message || result.stderr || 'Release ZIP verification failed');
  return JSON.parse(result.stdout);
}

function signedFeed({ version, zip, notes, keyFile, verifiedArchive, config = channel }) {
  if (
    !Number.isSafeInteger(verifiedArchive?.size) ||
    verifiedArchive.size < 1 ||
    !/^[a-f0-9]{64}$/.test(verifiedArchive.sha256 || '')
  )
    throw Error('A verified release ZIP is required before signing');
  const file = fs.readFileSync(zip);
  const sha256 = crypto.createHash('sha256').update(file).digest('hex');
  if (file.length !== verifiedArchive.size || sha256 !== verifiedArchive.sha256)
    throw Error('Release ZIP changed after verification');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Expected Ed25519 release key');
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (publicKey !== config.publicKey) throw Error('Release key differs from the client trust anchor');
  const payload = {
    app: 'yijian-journal',
    version,
    platform: 'win32',
    arch: 'x64',
    publishedAt: new Date().toISOString(),
    url: new URL(`YijianJournal-${version}-windows-x64.zip`, config.manifestUrl).href,
    size: file.length,
    sha256,
    notes,
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = {
    schemaVersion: 1,
    keyId: config.keyId,
    payload: bytes.toString('base64'),
    signature: crypto.sign(null, bytes, privateKey).toString('base64'),
  };
  verifyManifest(envelope, config);
  return envelope;
}

function prepareUploadScript(uploadId) {
  if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw Error('Invalid upload identity');
  return String.raw`import pathlib,fcntl
root=pathlib.Path('/srv/yijian-journal')
assert root.resolve()==root and root.is_dir(), 'Unexpected update directory'
with (root/'.publish.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 pending=sorted(p.name for p in root.iterdir() if p.name.startswith('.incoming-'))
 assert not pending, 'Unfinished upload(s): '+', '.join(pending)+'. Complete active uploads or verify abandoned staging before removing it and retrying.'
 (root/'.incoming-${uploadId}').mkdir(mode=0o700)
`;
}

function activateScript(uploadId) {
  if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw Error('Invalid upload identity');
  return String.raw`import pathlib,os,json,base64,hashlib,re,fcntl
def sha(file):
 h=hashlib.sha256()
 with file.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
 return h.hexdigest()
root=pathlib.Path('/srv/yijian-journal')
assert root.resolve()==root and root.is_dir(), 'Unexpected update directory'
incoming=root/'.incoming-${uploadId}'
assert incoming.is_dir() and incoming.resolve()==incoming, 'Unexpected staging directory'
with (root/'.publish.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 pending=sorted(p.name for p in root.iterdir() if p.name.startswith('.incoming-') and p.name!=incoming.name)
 assert not pending, 'Unfinished upload(s): '+', '.join(pending)+'. Latest-only retention is incomplete; complete active uploads or verify abandoned staging before removing it and retrying.'
 envelope=json.loads((incoming/'latest.json').read_text())
 data=json.loads(base64.b64decode(envelope['payload'],validate=True))
 version=data['version']; assert re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',version)
 filename='YijianJournal-'+version+'-windows-x64.zip'
 assert data['app']=='yijian-journal' and data['platform']=='win32' and data['arch']=='x64'
 assert data['url']=='https://data.riftbuddy.dpdns.org/yijian-journal/'+filename
 package=incoming/'package.zip'
 assert package.is_file() and not package.is_symlink() and package.stat().st_size==data['size']
 digest=sha(package)
 assert digest==data['sha256'], 'Uploaded package hash mismatch'
 latest=root/'latest.json'
 if latest.exists() or latest.is_symlink():
  assert not latest.is_symlink()
  previous=json.loads(base64.b64decode(json.loads(latest.read_text())['payload'],validate=True))
  assert tuple(map(int,version.split('.')))>=tuple(map(int,previous['version'].split('.'))), 'Refusing downgrade'
  assert version!=previous['version'] or digest==previous['sha256'], 'Version already published with different bytes'
 destination=root/filename
 obsolete=[]
 for old in root.iterdir():
  if old.name!=filename and re.fullmatch(r'YijianJournal-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-windows-x64\.zip',old.name):
   assert old.is_file() and not old.is_symlink() and old.resolve().parent==root, 'Unexpected old package entry'
   obsolete.append(old)
 if destination.exists() or destination.is_symlink():
  assert destination.is_file() and not destination.is_symlink()
  assert sha(destination)==digest
  package.unlink()
 else:
  os.chmod(package,0o644);os.replace(package,destination)
 os.chmod(incoming/'latest.json',0o644);os.replace(incoming/'latest.json',latest)
 removed=[]
 for old in obsolete:
  old.unlink();removed.append(old.name)
 incoming.rmdir()
 print(json.dumps({'version':version,'sha256':digest,'size':data['size'],'removed':removed,'retained':sorted(p.name for p in root.iterdir())}))
`;
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--host', '--ssh-config', '--key-file', '--notes-file'].includes(args[i]) || !args[i + 1])
      throw Error(
        'Usage: node scripts/publish-update.cjs --host SSH_ALIAS --ssh-config CONFIG --key-file PRIVATE_KEY --notes-file NOTES_JSON',
      );
    options[args[i]] = args[i + 1];
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,100}$/.test(options['--host'] || ''))
    throw Error('Expected SSH host alias');
  for (const key of ['--ssh-config', '--key-file', '--notes-file'])
    if (!options[key]) throw Error('Missing ' + key);
  const version = require('../package.json').version;
  const directory = path.join(base, 'dist', `v${version}`);
  const folder = path.join(directory, '逸剑手札-win32-x64');
  const release = audit(folder, { writeManifest: false });
  const report = JSON.parse(
    fs.readFileSync(path.join(base, 'test-results', `packaged-regression-${version}.json`)),
  );
  const jobs = require('./regression-jobs.cjs');
  if (
    report.version !== version ||
    report.archiveSha256 !== release.archiveSha256 ||
    !report.passed ||
    report.jobs.length !== jobs.length ||
    jobs.some(
      (job) => !report.jobs.some((run) => run.script === job && run.exitCode === 0 && !run.reusedFrom),
    )
  )
    throw Error('A complete fresh regression of this exact package is required');
  const zip = path.join(directory, `YijianJournal-${version}-windows-x64.zip`);
  const verifiedArchive = verifyReleaseZip({ zip, folder });
  const envelope = signedFeed({
    version,
    zip,
    notes: JSON.parse(fs.readFileSync(options['--notes-file'])),
    keyFile: options['--key-file'],
    verifiedArchive,
  });
  const manifest = path.join(directory, 'latest.json');
  fs.writeFileSync(manifest, JSON.stringify(envelope) + '\n');
  const uploadId = crypto.randomUUID();
  const incoming = `/srv/yijian-journal/.incoming-${uploadId}`;
  const ssh = ['-F', path.resolve(options['--ssh-config']), options['--host']];
  function run(command, args, input) {
    const result = spawnSync(command, args, {
      input,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw Error(result.error?.message || result.stderr || `${command} failed`);
    return result.stdout;
  }
  // Claim the project upload under the publication lock before sending bytes.
  // Interrupted or concurrent uploads must be resolved, never silently ignored
  // or removed merely because their names or timestamps resemble old staging.
  run('ssh', [...ssh, 'python3 -'], prepareUploadScript(uploadId));
  try {
    run('scp', ['-F', ssh[1], zip, `${options['--host']}:${incoming}/package.zip`]);
    run('scp', ['-F', ssh[1], manifest, `${options['--host']}:${incoming}/latest.json`]);
    const result = run('ssh', [...ssh, 'python3 -'], activateScript(uploadId));
    console.log(result.trim());
  } catch (error) {
    // Remove only files from this upload, never an active or another publisher's release.
    run(
      'ssh',
      [...ssh, 'python3 -'],
      `import pathlib\np=pathlib.Path('${incoming}')\nassert p.resolve()==p and p.parent==pathlib.Path('/srv/yijian-journal')\nfor name in ['package.zip','latest.json']:\n f=p/name\n if f.is_file() and not f.is_symlink(): f.unlink()\nif p.exists(): p.rmdir()\n`,
    );
    throw error;
  }
}
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verifyReleaseZip, signedFeed, prepareUploadScript, activateScript };
