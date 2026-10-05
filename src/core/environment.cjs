'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function steamRoots() {
  const roots = new Set(['C:\\steam', 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']);
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      const m = out.match(/SteamPath\s+REG_SZ\s+([^\r\n]+)/);
      if (m) roots.add(m[1].trim());
    } catch {}
  }
  for (const root of [...roots]) {
    try {
      const text = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, '\\'));
    } catch {}
  }
  return [...roots];
}
function detectGame() {
  for (const root of steamRoots()) {
    try {
      const text = fs.readFileSync(path.join(root, 'steamapps', 'appmanifest_1876890.acf'), 'utf8');
      const install = text.match(/"installdir"\s+"([^"]+)"/)?.[1];
      if (!install || path.basename(install) !== install) continue;
      const gamePath = path.join(root, 'steamapps', 'common', install);
      if (fs.existsSync(path.join(gamePath, 'JH.exe')))
        return { installed: true, path: gamePath, build: text.match(/"buildid"\s+"([^"]+)"/)?.[1] || '' };
    } catch {}
  }
  return { installed: false, path: '', build: '' };
}
function gameStopped() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return !/^"(?:JH(?:-Win64-Shipping)?|Wandering_Sword(?:-Win64-Shipping)?)\.exe"/im.test(out);
  } catch {
    return false;
  } // Unable to inspect means restoration is not safe.
}
module.exports = { detectGame, gameStopped };
