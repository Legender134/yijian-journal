'use strict';
const { packager } = require('@electron/packager');
const fs = require('node:fs');
const path = require('node:path');
const { audit } = require('./release-audit.cjs');
const { build } = require('./build-window-helper.cjs');
const base = path.join(__dirname, '..');
const version = require('../package.json').version;
const electronVersion = require('electron/package.json').version;
const cachedElectron = path.join(base, '.downloads', `electron-v${electronVersion}-win32-x64.zip`);
(async () => {
  const output = await packager({
    dir: base,
    name: '逸剑手札',
    executableName: '逸剑手札',
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    electronZipDir: fs.existsSync(cachedElectron) ? path.dirname(cachedElectron) : undefined,
    out: process.env.YIJIAN_PACKAGE_OUT || path.join(base, 'dist', `v${version}`),
    overwrite: false,
    asar: true,
    extraResource: [build()],
    icon: path.join(base, 'src', 'assets', 'icon.ico'),
    appVersion: version,
    appCopyright: 'Personal local companion. Unofficial fan utility.',
    win32metadata: {
      CompanyName: 'Personal Tools',
      FileDescription: '逸剑风云决个人桌面助手',
      ProductName: '逸剑手札',
      InternalName: 'YijianJournal',
    },
    ignore: [
      /^\/(dist|test-results|tests|scripts|\.test-data|\.downloads|\.build|node_modules)(\/|$)/,
      /^\/(docs|\.github|\.git)(\/|$)/,
      /pnpm-lock\.yaml$/,
      /\.gitignore$/,
      /\.gitattributes$/,
      /CONTRIBUTING\.md$/,
      /AGENTS\.md$/,
      /WORKLOG\.md$/,
      /\.prettierrc\.json$/,
    ],
    prune: false,
  });
  for (const folder of output) {
    fs.copyFileSync(path.join(folder, 'LICENSE'), path.join(folder, 'LICENSE.electron'));
    for (const name of ['使用说明.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
      fs.copyFileSync(path.join(base, name), path.join(folder, name));
    audit(folder);
  }
  console.log('Packaged:', output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
