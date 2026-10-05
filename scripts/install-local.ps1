param([string]$Version)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version' }
$release = Join-Path $projectRoot "dist\v$Version\逸剑手札-win32-x64"
$manifest = Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) { throw 'Release version mismatch' }
$sourceArchive = Join-Path $release 'resources\app.asar'
if ((Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.archiveSha256) { throw 'Release hash mismatch' }
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\YijianJournal'))
$destination = [IO.Path]::GetFullPath((Join-Path $installRoot $Version))
if ([IO.Path]::GetDirectoryName($destination) -ne $installRoot) { throw 'Unsafe installation target' }
if (Test-Path -LiteralPath $destination) { throw 'Version already installed; no files were overwritten' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $release -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse }
$installedHash = (Get-FileHash -LiteralPath (Join-Path $destination 'resources\app.asar') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installedHash -ne $manifest.archiveSha256) { throw 'Installed archive hash mismatch; shortcut was not changed' }
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '逸剑手札.lnk'
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $destination '逸剑手札.exe'
$shortcut.WorkingDirectory = $destination
$shortcut.Arguments = ''
$shortcut.Description = '逸剑风云决个人助手：自动存读档、历史时间线、百物图鉴与备料'
$shortcut.IconLocation = "$(Join-Path $destination '逸剑手札.exe'),0"
$shortcut.Save()
$guardPath = Join-Path $desktop '逸剑风云决 · 存档守护.lnk'
$guard = $shellObject.CreateShortcut($guardPath)
$guard.TargetPath = Join-Path $destination '逸剑手札.exe'
$guard.WorkingDirectory = $destination
$guard.Arguments = '--guard-game'
$guard.Description = '同时打开逸剑风云决与手札；按已有设置守护存档'
$guard.IconLocation = "$(Join-Path $destination '逸剑手札.exe'),0"
$guard.Save()
[pscustomobject]@{ Version=$Version; Installed=$destination; Shortcut=$shortcutPath; ArchiveSha256=$installedHash } | ConvertTo-Json
