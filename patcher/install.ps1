param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot,
  [string]$WorkDir = "$env:USERPROFILE\.zcode\token-speed-live"
)

$ErrorActionPreference = "Stop"
$appRootResolved = (Resolve-Path $AppRoot).Path
if (-not (Test-Path (Join-Path $appRootResolved "ZCode.exe"))) {
  throw "ZCode.exe not found under $appRootResolved"
}
if (-not (Test-Path (Join-Path $appRootResolved "resources\app.asar"))) {
  throw "resources\app.asar not found under $appRootResolved"
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 22+ is required on PATH."
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$files = @("patch.mjs", "launch.vbs", "watch.vbs", "restore.mjs", "restore.cmd")
foreach ($file in $files) {
  $source = Join-Path $PSScriptRoot $file
  $target = Join-Path $WorkDir $file
  if ($source -ne $target) {
    Copy-Item -Path $source -Destination $target -Force
  }
}
@{ appRoot = $appRootResolved } | ConvertTo-Json | Set-Content -Path (Join-Path $WorkDir "config.json") -Encoding UTF8

Write-Host "Applying patch..."
& node (Join-Path $WorkDir "patch.mjs")
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Patcher exited with $LASTEXITCODE. See $WorkDir\patch.log"
}

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "ZCode (Token Speed).lnk"
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = '"' + (Join-Path $WorkDir "launch.vbs") + '"'
$shortcut.IconLocation = (Join-Path $appRootResolved "ZCode.exe") + ",0"
$shortcut.WorkingDirectory = $appRootResolved
$shortcut.Description = "Launch ZCode and re-apply the token speed patch after updates"
$shortcut.Save()

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$watchCommand = 'wscript.exe "' + (Join-Path $WorkDir "watch.vbs") + '"'
New-ItemProperty -Path $runKey -Name "ZCodeTokenSpeedWatch" -Value $watchCommand -PropertyType String -Force | Out-Null
Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList ('"' + (Join-Path $WorkDir "watch.vbs") + '"') -WindowStyle Hidden

Write-Host ""
Write-Host "Installed."
Write-Host "1. Fully quit ZCode (including the tray icon)."
Write-Host "2. Launch from the new 'ZCode (Token Speed)' desktop shortcut."
Write-Host "3. Open Usage Stats to see the new metric and daily chart."
Write-Host ""
Write-Host "Work dir: $WorkDir"
Write-Host "Restore: quit ZCode, then run $WorkDir\restore.cmd"
