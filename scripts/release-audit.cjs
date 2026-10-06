'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');
const base = path.resolve(__dirname, '..');
const metadata = require('../package.json');
function audit(folder, { writeManifest = true } = {}) {
  if (!folder) throw Error('A packaged application folder is required');
  const archive = path.join(path.resolve(folder), 'resources', 'app.asar');
  const files = asar.listPackage(archive).map((name) => name.replace(/\\/g, '/').replace(/^\//, ''));
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const packagedFiles = {};
  for (const name of files) {
    if (
      !['src', 'README.md', 'package.json', '使用说明.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(
        name,
      ) &&
      !name.startsWith('src/')
    )
      throw Error(`Unexpected packaged file: ${name}`);
    if (!fs.statSync(path.join(base, name)).isFile()) continue;
    const embedded = asar.extractFile(archive, name.split('/').join(path.sep));
    packagedFiles[name] = hash(embedded);
    if (name === 'package.json') {
      // Packager deliberately removes scripts, private and devDependencies.
      const packed = JSON.parse(embedded);
      for (const field of ['name', 'productName', 'version', 'description', 'main', 'license'])
        assert.equal(packed[field], metadata[field], `Packaged metadata mismatch: ${field}`);
      assert.deepEqual(
        Object.keys(packed).sort(),
        [
          'name',
          'productName',
          'version',
          'description',
          'main',
          'license',
          'author',
          'repository',
          'homepage',
          'bugs',
          'engines',
        ].sort(),
      );
    } else if (packagedFiles[name] !== hash(fs.readFileSync(path.join(base, name)))) {
      throw Error(`Packaged file differs from source: ${name}`);
    }
  }
  assert.equal(hash(fs.readFileSync(path.join(folder, '使用说明.txt'))), packagedFiles['使用说明.txt']);
  const helperSha256 = hash(fs.readFileSync(path.join(folder, 'resources', 'YijianWindow.exe')));
  assert.equal(
    helperSha256,
    hash(fs.readFileSync(path.join(base, '.build', 'YijianWindow.exe'))),
    'Packaged window helper differs from build',
  );
  const manifest = {
    product: '逸剑手札',
    version: metadata.version,
    platform: 'win32-x64',
    auditedAt: new Date().toISOString(),
    electron: require('electron/package.json').version,
    gameDataBuild: require('../src/data/game-index.json').build,
    archiveSha256: hash(fs.readFileSync(archive)),
    helperSha256,
    packagedFiles,
  };
  if (writeManifest)
    fs.writeFileSync(path.join(folder, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (require.main === module) {
  const result = audit(process.argv[2]);
  console.log(
    'Release source/contents audit PASS:',
    result.version,
    Object.keys(result.packagedFiles).length,
    'files;',
    result.archiveSha256,
  );
}
module.exports = { audit };
