'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { audit } = require('./release-audit.cjs');
const base = path.resolve(__dirname, '..');

function createReleaseZip({ folder, zip }) {
  if (process.platform !== 'win32') throw Error('Release ZIP creation requires Windows PowerShell');
  folder = path.resolve(folder);
  zip = path.resolve(zip);
  if (fs.existsSync(zip)) throw Error('Release ZIP already exists; no file was overwritten');
  const relative = path.relative(folder, zip);
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    throw Error('Release ZIP must be outside the packaged directory');
  // CreateFromDirectory on .NET Framework emits backslashes. Explicit entry names
  // keep the public ZIP compatible with the updater's canonical path validation.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$folder = [IO.DirectoryInfo]::new($env:YIJIAN_ZIP_INPUT)
if (!$folder.Exists -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid packaged directory' }
$stream = [IO.File]::Open($env:YIJIAN_ZIP_OUTPUT, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    function Add-Directory($directory, [string]$relative) {
      if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Packaged directory contains a link' }
      [void]$archive.CreateEntry($relative)
      foreach ($item in $directory.EnumerateFileSystemInfos()) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Packaged directory contains a link' }
        if ($item.Attributes -band [IO.FileAttributes]::Directory) { Add-Directory $item ($relative + $item.Name + '/') }
        else { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $item.FullName, ($relative + $item.Name), [IO.Compression.CompressionLevel]::Optimal) }
      }
    }
    Add-Directory $folder ($folder.Name + '/')
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }`,
    ],
    {
      env: { ...process.env, YIJIAN_ZIP_INPUT: folder, YIJIAN_ZIP_OUTPUT: zip },
      windowsHide: true,
      stdio: 'pipe',
    },
  );
}

function main() {
  const version = require('../package.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version');
  const root = path.join(base, 'dist', `v${version}`);
  const folder = path.join(root, '逸剑手札-win32-x64');
  audit(folder, { writeManifest: false });
  const zip = path.join(root, `YijianJournal-${version}-windows-x64.zip`);
  createReleaseZip({ folder, zip });
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  const sums = path.join(root, 'SHA256SUMS.txt');
  fs.writeFileSync(sums, `${digest}  ${path.basename(zip)}\n`);
  console.log('Windows release:', zip);
  console.log(digest);
}

if (require.main === module) main();
module.exports = { createReleaseZip };
