# Refresh existing Phoenix Music Maker UI tab/window, or open one if none.
# Used by start-all.bat so background bot restarts do not stack browser windows.
param(
  [string]$Url = 'http://127.0.0.1:3000/'
)
$ErrorActionPreference = 'SilentlyContinue'
if ($env:PHOENIX_SKIP_BROWSER -eq '1') {
  Write-Output 'PHOENIX_SKIP_BROWSER=1 — not opening UI'
  exit 0
}

Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$pattern = 'localhost:3000|127\.0\.0\.1:3000|Phoenix Music Maker'
$candidates = @('chrome','msedge','brave','firefox','opera') |
  ForEach-Object { Get-Process $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $pattern }

if ($candidates) {
  $win = $candidates | Sort-Object StartTime -Descending | Select-Object -First 1
  Write-Output ("REFRESH existing UI: PID={0} TITLE={1}" -f $win.Id, $win.MainWindowTitle)
  [Microsoft.VisualBasic.Interaction]::AppActivate($win.Id) | Out-Null
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{F5}')
  exit 0
}

Write-Output ("OPEN new UI: {0}" -f $Url)
Start-Process $Url
exit 0
