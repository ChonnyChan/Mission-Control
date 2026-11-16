# Mission Control: one-time Windows setup.
# Run from the Mission-Control folder in an *Administrator* PowerShell:
#     powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1
#
# What it does:
#   1. Installs dependencies (npm install)
#   2. Allows port 3000 through Windows Firewall on *private* networks only (home Wi-Fi, not public hotspots)
#   3. Registers a scheduled task that starts Mission Control whenever Windows boots (no login needed)
#      and restarts it if it crashes
#   4. Starts it now and prints the addresses for the TV and your phone
#
# To undo:  Unregister-ScheduledTask -TaskName MissionControl -Confirm:$false
#           Remove-NetFirewallRule -DisplayName "Mission Control (port 3000)"

$ErrorActionPreference = 'Stop'
$Port = 3000
$TaskName = 'MissionControl'
$Root = Split-Path -Parent $PSScriptRoot

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Please run this from an Administrator PowerShell (right-click PowerShell > Run as administrator).' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js not found. Install the LTS version from https://nodejs.org, reopen PowerShell, and run this again.' }
Write-Host "Using Node $(& $node -v) at $node"

Write-Host 'Installing dependencies...'
Push-Location $Root
npm install --omit=dev
Pop-Location

Write-Host 'Opening firewall for home (private) networks...'
Get-NetFirewallRule -DisplayName "Mission Control (port $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Mission Control (port $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null

$profiles = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' }
if ($profiles | Where-Object { $_.NetworkCategory -eq 'Public' }) {
  Write-Warning 'Your network is set to "Public", so the TV and phones will be blocked. Fix: Settings > Network & internet > (your connection) > Network profile type > Private.'
}

Write-Host 'Registering startup task...'
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$Root\server.js`"" -WorkingDirectory $Root
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Limited
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Mission Control family dashboard (http://localhost:3000)' | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

try {
  Invoke-WebRequest "http://localhost:$Port/api/state" -UseBasicParsing -TimeoutSec 5 | Out-Null
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue |
         Where-Object { $_.IPAddress -notlike '169.254*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
         Select-Object -First 1).IPAddress
  Write-Host ''
  Write-Host 'Mission Control is running and will start automatically with Windows.' -ForegroundColor Green
  Write-Host "  TV (Samsung Internet app):  http://${ip}:$Port"
  Write-Host "  Phone admin:                http://${ip}:$Port/admin"
  Write-Host ''
  Write-Host 'Tip: give this PC a reserved IP in your router so the TV bookmark never breaks.'
} catch {
  Write-Warning "The task was created but the server didn't answer yet. Check Task Scheduler > $TaskName > History, or run 'npm start' in $Root to see the error."
}
