'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createReleaseZip } = require('../scripts/release-zip.cjs');
const { verifyReleaseZip } = require('../scripts/publish-update.cjs');

test(
  'Windows release ZIP preserves Unicode, hidden files and empty directories with updater-compatible paths',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-release-zip-'));
    try {
      const folder = path.join(root, '逸剑手札-win32-x64');
      fs.mkdirSync(path.join(folder, '资源', '空目录'), { recursive: true });
      fs.writeFileSync(path.join(folder, '逸剑手札.exe'), Buffer.from([0, 1, 2, 255]));
      fs.writeFileSync(path.join(folder, '资源', '说明.txt'), '中文与 $() 引号 " 保留\n');
      const hidden = path.join(folder, '.hidden');
      fs.writeFileSync(hidden, 'hidden file remains part of the release');
      execFileSync('attrib.exe', ['+H', hidden], { windowsHide: true });
      const zip = path.join(root, 'release.zip');
      createReleaseZip({ folder, zip });
      const verified = verifyReleaseZip({ folder, zip });
      assert.equal(verified.fileCount, 3);
      assert.equal(verified.size, fs.statSync(zip).size);
      const bytes = fs.readFileSync(zip);
      assert.equal(verified.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
      assert.throws(() => createReleaseZip({ folder, zip }), /already exists/);
      assert.deepEqual(fs.readFileSync(zip), bytes);
      assert.throws(() => createReleaseZip({ folder, zip: path.join(folder, 'nested.zip') }), /outside/);
      assert.equal(fs.existsSync(path.join(folder, 'nested.zip')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
