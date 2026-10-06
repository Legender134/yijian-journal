'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const base = path.resolve(__dirname, '..');
function build() {
  if (process.platform !== 'win32') throw Error('游戏窗口组件需要在 Windows 编译');
  const output = path.join(base, '.build', 'YijianWindow.exe');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(
    path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/reference:System.Web.Extensions.dll',
      `/out:${output}`,
      path.join(base, 'src/native/GameWindow.cs'),
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  return output;
}
if (require.main === module) console.log(build());
module.exports = { build };
