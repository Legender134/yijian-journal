param([Parameter(Mandatory = $true)][string]$PlanPath, [switch]$Bootstrap, [int]$LauncherProcessId = 0)
# ASCII source is intentional: Windows PowerShell 5.1 reads unsigned UTF-8 scripts as ANSI.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$product = ([string][char]0x9038) + [char]0x5251 + [char]0x624b + [char]0x672d
$guardName = ([string][char]0x9038) + [char]0x5251 + [char]0x98ce + [char]0x4e91 + [char]0x51b3 + ' ' + [char]0xb7 + ' ' + [char]0x5b58 + [char]0x6863 + [char]0x5b88 + [char]0x62a4
$script:code = 'plan'
$script:trusted = $false
$script:plan = $null
$script:shortcuts = [Collections.Generic.List[object]]::new()
$script:oldStart = $null
$script:launched = $false

if ($Bootstrap) {
  # ShellExecute gives the real helper its own hidden console and lifetime.
  # Paths are separate native arguments at the Node boundary; Windows paths
  # cannot contain quotes, which are explicitly rejected here before quoting.
  if ($PSCommandPath.Contains('"') -or $PlanPath.Contains('"')) { exit 1 }
  try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
    $start.UseShellExecute = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -PlanPath "' + $PlanPath + '" -LauncherProcessId ' + $PID
    $helper = [Diagnostics.Process]::Start($start)
    $marker = Join-Path ([IO.Path]::GetDirectoryName($PlanPath)) 'helper-started.json'
    $until = [DateTime]::UtcNow.AddSeconds(14)
    while ([DateTime]::UtcNow -lt $until) {
      if ([IO.File]::Exists($marker)) { exit 0 }
      if ($helper.HasExited) { exit 1 }
      Start-Sleep -Milliseconds 50
    }
  } catch { }
  exit 1
}

function Fail([string]$Code) { $script:code = $Code; throw 'Update could not be completed.' }
function Full([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[a-zA-Z]:[\\/]' -or $Value.IndexOf(':', 2) -ge 0 -or $Value.IndexOf([char]0) -ge 0) { Fail 'plan' }
  return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]'\/')
}
function Inside([string]$Root, [string]$Value) {
  return $Value.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Value.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Same([string]$A, [string]$B) { return $A.Equals($B, [StringComparison]::OrdinalIgnoreCase) }
function NoLinks([string]$Value) {
  $part = $Value
  while ($part) {
    $item = Get-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse path refused.' }
    $parent = [IO.Path]::GetDirectoryName($part)
    if ($parent -eq $part) { break }
    $part = $parent
  }
}
function Json([string]$File, [long]$Limit) {
  NoLinks $File
  if ((Get-Item -LiteralPath $File -Force).Length -gt $Limit) { throw 'JSON exceeds limit.' }
  return [IO.File]::ReadAllText($File, [Text.Encoding]::UTF8) | ConvertFrom-Json
}
function Digest([string]$File) {
  NoLinks $File
  $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Result([string]$Status, [string]$Code) {
  if (-not $script:trusted) { return }
  $destination = Join-Path $script:plan.cacheDir 'install-result.json'
  $temporary = Join-Path $script:plan.workDir ('result-' + [Guid]::NewGuid().ToString('N') + '.json')
  $previous = Join-Path $script:plan.cacheDir 'install-result.previous.json'
  foreach ($target in @($destination, $temporary, $previous)) { NoLinks $target }
  $json = [ordered]@{ schema = 1; status = $Status; version = $script:plan.version; code = $Code; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, $previous, $true) }
  else { [IO.File]::Move($temporary, $destination) }
}
function OldProcess {
  if ($script:plan.processId -eq 0) { return $null }
  return Get-Process -Id $script:plan.processId -ErrorAction SilentlyContinue
}
function WaitForOld {
  $script:code = 'process'
  $old = OldProcess
  if ($null -eq $old) { return }
  if (-not (Same (Full $old.Path) $script:plan.currentExe)) { Fail 'process' }
  $script:oldStart = $old.StartTime.ToUniversalTime().Ticks
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  if ($script:plan.testMode) { $deadline = [DateTime]::UtcNow.AddSeconds(2) }
  while ($null -ne $old) {
    if ($old.StartTime.ToUniversalTime().Ticks -ne $script:oldStart -or -not (Same (Full $old.Path) $script:plan.currentExe)) { Fail 'process' }
    if ([DateTime]::UtcNow -ge $deadline) { Fail 'process' }
    Start-Sleep -Milliseconds 200
    $old = OldProcess
  }
}
function StartOld {
  if ($script:plan.testMode) { return }
  # Never duplicate an old process that is still running. No process is ever stopped.
  $old = OldProcess
  if ($null -ne $old) {
    if (Same (Full $old.Path) $script:plan.currentExe) { return }
  }
  NoLinks $script:plan.currentExe
  Start-Process -FilePath $script:plan.currentExe -WorkingDirectory ([IO.Path]::GetDirectoryName($script:plan.currentExe)) -WindowStyle Hidden | Out-Null
}
function SafeEntry([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Contains('\') -or $Name.StartsWith('/') -or $Name.Length -gt 1200) { Fail 'zip' }
  $parts = $Name.TrimEnd('/').Split('/')
  if ($parts.Count -lt 1 -or $parts[0] -cne ($product + '-win32-x64')) { Fail 'zip' }
  foreach ($part in $parts) {
    if ($part.Length -lt 1 -or $part.Length -gt 255 -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>:"\\|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)') { Fail 'zip' }
  }
  return [string]::Join('/', $parts)
}
function VerifyTree([string]$Root, $Hashes) {
  NoLinks $Root
  if (-not [IO.Directory]::Exists($Root)) { Fail 'install' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $directories = [Collections.Generic.Stack[string]]::new()
  $directories.Push($Root)
  while ($directories.Count -gt 0) {
    foreach ($item in [IO.Directory]::GetFileSystemEntries($directories.Pop())) {
      NoLinks $item
      if ([IO.Directory]::Exists($item)) { $directories.Push($item); continue }
      $relative = $item.Substring($Root.Length + 1).Replace('\', '/')
      if (-not $Hashes.ContainsKey($relative) -or (Digest $item) -ne $Hashes[$relative]) { Fail 'install' }
      [void]$seen.Add($relative)
    }
  }
  if ($seen.Count -ne $Hashes.Count) { Fail 'install' }
}
function RemoveCreatedStage([string]$Stage) {
  # Only the exact random stage created by this InstallPackage call is eligible.
  # Check the resolved boundary and every descendant before deleting anything;
  # literal .NET operations never recurse through a replacement junction.
  $Stage = Full $Stage
  $root = Full $script:plan.installRoot
  if (-not (Inside $root $Stage) -or -not (Same ([IO.Path]::GetDirectoryName($Stage)) $root) -or [IO.Path]::GetFileName($Stage) -cnotmatch '^\.update-[0-9a-f]{32}$') { Fail 'install' }
  NoLinks $Stage
  $directories = [Collections.Generic.List[string]]::new()
  $files = [Collections.Generic.List[string]]::new()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Stage)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    NoLinks $directory
    $directories.Add($directory)
    foreach ($item in [IO.Directory]::GetFileSystemEntries($directory)) {
      $item = Full $item
      if (-not (Inside $Stage $item) -or (Same $Stage $item)) { Fail 'install' }
      NoLinks $item
      if ([IO.Directory]::Exists($item)) { $pending.Push($item) }
      else { $files.Add($item) }
    }
  }
  foreach ($file in $files) {
    NoLinks $file
    [IO.File]::Delete($file)
  }
  for ($index = $directories.Count - 1; $index -ge 0; $index--) {
    NoLinks $directories[$index]
    [IO.Directory]::Delete($directories[$index], $false)
  }
}
function InstallPackage {
  $script:code = 'package'
  NoLinks $script:plan.packagePath
  $stream = [IO.File]::Open($script:plan.packagePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $archive = $null
  try {
    if ($stream.Length -ne $script:plan.size) { Fail 'package' }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
    if ($actual -ne $script:plan.sha256) { Fail 'package' }
    $stream.Position = 0
    $script:code = 'zip'
    Add-Type -AssemblyName System.IO.Compression
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    if ($archive.Entries.Count -lt 4 -or $archive.Entries.Count -gt 20000) { Fail 'zip' }
    $entries = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $archive.Entries) {
      $name = SafeEntry $entry.FullName
      if ($entries.ContainsKey($name)) { Fail 'zip' }
      $attributes = [uint32]([long]$entry.ExternalAttributes -band 0xffffffffL)
      $kind = ($attributes -shr 16) -band 0xf000
      $directory = $entry.FullName.EndsWith('/')
      if (($attributes -band 0x400) -ne 0 -or $kind -notin @(0, 0x8000, 0x4000) -or (($attributes -band 0x10) -ne 0 -and -not $directory) -or ($kind -eq 0x4000 -and -not $directory) -or ($directory -and $entry.Length -ne 0)) { Fail 'zip' }
      if (-not $directory) {
        if ($name.IndexOf('/') -lt 0 -or $entry.Length -lt 0 -or $entry.Length -gt 2147483648L) { Fail 'zip' }
        $total += $entry.Length
        if ($total -gt 2147483648L) { Fail 'zip' }
        [void]$files.Add($name)
      }
      $entries.Add($name, [pscustomobject]@{ Entry = $entry; Directory = $directory })
    }
    foreach ($name in $entries.Keys) {
      $parent = $name
      while ($parent.Contains('/')) {
        $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
        if ($files.Contains($parent)) { Fail 'zip' }
      }
    }
    # Every entry was checked before creating any extraction directory.
    NoLinks $script:plan.installRoot
    [void][IO.Directory]::CreateDirectory($script:plan.installRoot)
    $stage = Join-Path $script:plan.installRoot ('.update-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $stage) { Fail 'install' }
    [void][IO.Directory]::CreateDirectory($stage)
    $payload = Join-Path $stage ($product + '-win32-x64')
    $hashes = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $entries.Keys) {
      $record = $entries[$name]
      $target = [IO.Path]::GetFullPath((Join-Path $stage $name.Replace('/', '\')))
      if (-not (Inside $stage $target) -or (Same $stage $target)) { Fail 'zip' }
      NoLinks $target
      if ($record.Directory) { [void][IO.Directory]::CreateDirectory($target); continue }
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      $inputStream = $record.Entry.Open()
      $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $buffer = [byte[]]::new(65536)
        [long]$written = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $written += $count
          if ($written -gt $record.Entry.Length) { Fail 'zip' }
          $outputStream.Write($buffer, 0, $count)
        }
        if ($written -ne $record.Entry.Length) { Fail 'zip' }
        $outputStream.Flush($true)
      } finally { $outputStream.Dispose(); $inputStream.Dispose() }
      $relative = $target.Substring($payload.Length + 1).Replace('\', '/')
      $hashes.Add($relative, (Digest $target))
    }
    $script:code = 'manifest'
    $manifest = Json (Join-Path $payload 'release-manifest.json') 2097152
    if ($manifest.product -cne $product -or $manifest.version -cne $script:plan.version -or $manifest.platform -cne 'win32-x64' -or $manifest.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.helperSha256 -notmatch '^[a-f0-9]{64}$' -or $null -eq $manifest.packagedFiles -or $manifest.packagedFiles -isnot [pscustomobject]) { Fail 'manifest' }
    if (-not $hashes.ContainsKey($product + '.exe') -or -not $hashes.ContainsKey('resources/app.asar') -or -not $hashes.ContainsKey('resources/YijianWindow.exe') -or $hashes['resources/app.asar'] -ne $manifest.archiveSha256 -or $hashes['resources/YijianWindow.exe'] -ne $manifest.helperSha256) { Fail 'manifest' }
    $script:code = 'install'
    $destination = [IO.Path]::GetFullPath((Join-Path $script:plan.installRoot $script:plan.version))
    if (-not (Same ([IO.Path]::GetDirectoryName($destination)) $script:plan.installRoot)) { Fail 'install' }
    NoLinks $destination
    if (Test-Path -LiteralPath $destination) { VerifyTree $destination $hashes }
    else { [IO.Directory]::Move($payload, $destination); VerifyTree $destination $hashes }
    RemoveCreatedStage $stage
    return $destination
  } finally {
    # Failed or interrupted extraction stages remain available for diagnosis.
    if ($null -ne $archive) { $archive.Dispose() }
    $stream.Dispose()
  }
}
function SwitchShortcuts([string]$Destination) {
  if ($script:plan.testMode) { return }
  $script:code = 'shortcuts'
  $shell = New-Object -ComObject WScript.Shell
  $backupRoot = Join-Path $script:plan.workDir 'shortcut-backups'
  [void][IO.Directory]::CreateDirectory($backupRoot)
  $locations = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
  $nextExe = Join-Path $Destination ($product + '.exe')
  foreach ($location in $locations) {
    $location = Full $location
    NoLinks $location
    if (-not [IO.Directory]::Exists($location)) { throw 'Shortcut directory unavailable.' }
    foreach ($guard in @($false, $true)) {
      $name = $product + '.lnk'
      if ($guard) { $name = $guardName + '.lnk' }
      $link = Join-Path $location $name
      NoLinks $link
      $existed = [IO.File]::Exists($link)
      $shortcut = $shell.CreateShortcut($link)
      if ($existed) {
        $oldTarget = Full $shortcut.TargetPath
        # A same-name shortcut owned by another program is left alone.
        if (-not (Same $oldTarget $script:plan.currentExe) -and -not ((Inside $script:plan.installRoot $oldTarget) -and [IO.Path]::GetFileName($oldTarget) -ceq ($product + '.exe'))) { continue }
      }
      $backup = Join-Path $backupRoot ($script:shortcuts.Count.ToString() + '.lnk')
      if ($existed) { [IO.File]::Copy($link, $backup, $false) }
      $record = [pscustomobject]@{ Path = $link; Backup = $backup; Existed = $existed }
      $script:shortcuts.Add($record)
      $shortcut.TargetPath = $nextExe
      $shortcut.WorkingDirectory = $Destination
      $shortcut.Arguments = ''
      if ($guard) { $shortcut.Arguments = '--guard-game' }
      $shortcut.IconLocation = $nextExe + ',0'
      $shortcut.Description = $product
      $shortcut.Save()
      NoLinks $link
    }
  }
}
function RestoreShortcuts {
  foreach ($record in $script:shortcuts) {
    try {
      NoLinks $record.Path
      if ($record.Existed) { NoLinks $record.Backup; [IO.File]::Copy($record.Backup, $record.Path, $true) }
      elseif ([IO.File]::Exists($record.Path)) { [IO.File]::Delete($record.Path) }
    } catch { # Continue restoring the remaining project shortcuts.
    }
  }
}

try {
  $PlanPath = Full $PlanPath
  $script:plan = Json $PlanPath 65536
  $p = $script:plan
  if ($p.schema -ne 1 -or $p.version -isnot [string] -or $p.version.Length -gt 40 -or $p.version -notmatch '^\d+\.\d+\.\d+$' -or $p.sha256 -notmatch '^[a-f0-9]{64}$' -or ($p.size -isnot [long] -and $p.size -isnot [int]) -or $p.size -lt 1 -or $p.size -gt 2147483648L -or $p.processId -isnot [int] -or $p.processId -lt 0 -or $p.testMode -isnot [bool]) { Fail 'plan' }
  foreach ($field in @('cacheDir', 'workDir', 'packagePath', 'currentExe', 'installRoot')) {
    $p.$field = Full $p.$field
    NoLinks $p.$field
  }
  if (-not (Inside $p.cacheDir $p.workDir) -or (Same $p.cacheDir $p.workDir) -or -not (Same ([IO.Path]::GetDirectoryName($PlanPath)) $p.workDir) -or -not (Inside $p.cacheDir $p.packagePath) -or (Same $p.cacheDir $p.packagePath)) { Fail 'plan' }
  if ($p.testMode) {
    $isolated = Full $env:YIJIAN_TEST_DATA
    $p.testRoot = Full $p.testRoot
    NoLinks $isolated
    if (-not (Inside $isolated $p.testRoot) -or (Same $isolated $p.testRoot)) { Fail 'plan' }
    foreach ($value in @($p.cacheDir, $p.workDir, $p.packagePath, $p.currentExe)) { if (-not (Inside $p.testRoot $value)) { Fail 'plan' } }
    $expectedRoot = Full (Join-Path $p.testRoot 'programs\YijianJournal')
  } else {
    if ($p.processId -eq 0) { Fail 'plan' }
    $expectedRoot = Full (Join-Path (Full $env:LOCALAPPDATA) 'Programs\YijianJournal')
  }
  if (-not (Same $expectedRoot $p.installRoot) -or -not [IO.File]::Exists($p.currentExe)) { Fail 'plan' }
  $script:trusted = $true
  $started = Join-Path $p.workDir 'helper-started.json'
  $startedTemporary = Join-Path $p.workDir ('helper-started-' + $PID + '.tmp')
  NoLinks $started
  NoLinks $startedTemporary
  $startedStream = [IO.File]::Open($startedTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $startedBytes = [Text.Encoding]::UTF8.GetBytes(('{"processId":' + $PID + ',"launcherProcessId":' + $LauncherProcessId + '}'))
    $startedStream.Write($startedBytes, 0, $startedBytes.Length)
    $startedStream.Flush($true)
  } finally { $startedStream.Dispose() }
  [IO.File]::Move($startedTemporary, $started)
  WaitForOld
  $destination = InstallPackage
  SwitchShortcuts $destination
  $script:code = 'launch'
  if (-not $p.testMode) {
    $newExe = Join-Path $destination ($product + '.exe')
    NoLinks $newExe
    $newProcess = Start-Process -FilePath $newExe -WorkingDirectory $destination -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1000
    if ($newProcess.HasExited) { Fail 'launch' }
    $script:launched = $true
  }
  Result 'installed' 'installed'
  exit 0
} catch {
  if ($script:trusted -and $script:plan.testMode) {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.WriteLine($_.ScriptStackTrace)
  }
  if ($script:trusted) {
    # A receipt-write failure after a successful start must not open a second
    # application or roll its shortcuts back underneath the running new one.
    if ($script:launched) { exit 0 }
    RestoreShortcuts
    try { StartOld } catch { }
    try { Result 'failed' $script:code } catch { }
  }
  exit 1
}
