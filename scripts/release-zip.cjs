'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { audit } = require('./release-audit.cjs');
const base = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version');
const root = path.join(base, 'dist', `v${version}`);
const folder = path.join(root, '逸剑手札-win32-x64');
audit(folder, { writeManifest: false });
const zip = path.join(root, `YijianJournal-${version}-windows-x64.zip`);
if (fs.existsSync(zip)) throw Error('Release ZIP already exists; no file was overwritten');
// Environment variables avoid interpolating filesystem paths into PowerShell code.
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:YIJIAN_ZIP_INPUT, $env:YIJIAN_ZIP_OUTPUT, [IO.Compression.CompressionLevel]::Optimal, $true)",
  ],
  {
    env: { ...process.env, YIJIAN_ZIP_INPUT: folder, YIJIAN_ZIP_OUTPUT: zip },
    windowsHide: true,
    stdio: 'inherit',
  },
);
const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
const sums = path.join(root, 'SHA256SUMS.txt');
fs.writeFileSync(sums, `${digest}  ${path.basename(zip)}\n`);
console.log('Windows release:', zip);
console.log(digest);
