<#
  ABUD FUN Company OS - native Windows launcher (daily use).
    start (default)  start the Local Bridge if needed, wait for health, open the browser
    status           health, PID, uptime, memory and how the previous session ended
    stop             graceful stop of the instance this launcher started (-Force: terminate that same PID if unhealthy)
    restart          stop then start
    shortcut         create a desktop shortcut to Start-ABUD-OS.cmd
    autostart-on     start Company OS when you sign in to Windows (a shortcut in your Startup folder; no admin, no service)
    autostart-off    remove that sign-in shortcut
    autostart-status show whether sign-in start is enabled
  -AtSignIn (used by the sign-in shortcut): up to 3 start attempts with 5/15/45 s backoff, opens the browser once if the
  owner's preference (local\launcher.json, default on) allows it, then starts one hidden supervisor that restarts the bridge
  only after an unclean exit, at most 3 times per hour. A clean owner stop is never undone.
  Only the process recorded in local\runtime\bridge.pid and verified by its command line is ever stopped. OmniRoute and other
  Node.js processes are never touched. Development tests are separate (see README).
#>
param(
  [ValidateSet('start', 'status', 'stop', 'restart', 'shortcut', 'autostart-on', 'autostart-off', 'autostart-status', 'supervise')]
  [string]$Action = 'start',
  [int]$Port = 4172,
  [switch]$NoBrowser,
  [switch]$Force,
  [switch]$AtSignIn,
  [string]$ShortcutFolder
)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$serverEntry = Join-Path $project 'apps\local-bridge\src\server.mjs'
$database = Join-Path $project 'local\company.db'
$runtime = Join-Path $project 'local\runtime'
$logs = Join-Path $project 'local\logs'
$pidFile = Join-Path $runtime 'bridge.pid'
$stateFile = Join-Path $runtime 'bridge-state.json'
$origin = "http://127.0.0.1:$Port"
$shortcutName = 'ABUD FUN Company OS.lnk'
$keepLogPairs = 30
$launcherStateFile = Join-Path $runtime 'launcher-state.json'
$supervisorPidFile = Join-Path $runtime 'supervisor.pid'
$prefsFile = Join-Path $project 'local\launcher.json'
$launcherLog = Join-Path $logs 'launcher.log'

function Write-LauncherLog([string]$message) {
  try {
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    Add-Content -LiteralPath $launcherLog -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $message) -Encoding UTF8
    if ((Get-Item -LiteralPath $launcherLog).Length -gt 512KB) { Move-Item -LiteralPath $launcherLog -Destination "$launcherLog.1" -Force }
  } catch { }
}

# Small, non-secret record System Center reads: last attempt, success, failure and supervisor restarts.
function Set-LauncherState([hashtable]$fields) {
  $current = @{}
  try { if (Test-Path -LiteralPath $launcherStateFile) { (Get-Content -LiteralPath $launcherStateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $current[$_.Name] = $_.Value } } } catch { }
  foreach ($key in $fields.Keys) { $current[$key] = $fields[$key] }
  try { New-Item -ItemType Directory -Path $runtime -Force | Out-Null; ($current | ConvertTo-Json -Compress) | Set-Content -LiteralPath $launcherStateFile -Encoding UTF8 } catch { }
}
$nowUtc = { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Get-OpenBrowserPreference {
  try { if (Test-Path -LiteralPath $prefsFile) { $p = Get-Content -LiteralPath $prefsFile -Raw | ConvertFrom-Json; if ($p.openBrowserAtSignIn -eq $false) { return $false } } } catch { }
  return $true
}

function Get-SupervisorProcess {
  if (-not (Test-Path -LiteralPath $supervisorPidFile)) { return $null }
  $savedPid = 0
  if (-not [int]::TryParse("$(Get-Content -LiteralPath $supervisorPidFile -Raw)".Trim(), [ref]$savedPid) -or $savedPid -le 0) { Remove-Item -LiteralPath $supervisorPidFile -Force; return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.CommandLine -or -not $proc.CommandLine.Contains('ABUD-OS.ps1') -or -not $proc.CommandLine.Contains('supervise')) { Remove-Item -LiteralPath $supervisorPidFile -Force; return $null }
  return $proc
}

function Get-BridgeProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $savedPid = 0
  # A zero-byte file (power loss during the write) reads as $null; "$null" is '' and is discarded like any unparsable record.
  $savedText = "$(Get-Content -LiteralPath $pidFile -Raw)".Trim()
  if (-not [int]::TryParse($savedText, [ref]$savedPid) -or $savedPid -le 0) { Remove-Item -LiteralPath $pidFile -Force; return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
  # After a crash or a Windows restart the recorded PID may be gone or reused by an unrelated program. Either way it is not
  # ours: forget the stale record and never touch that process.
  if (-not $proc -or $proc.Name -notmatch '^node(\.exe)?$' -or -not $proc.CommandLine -or -not $proc.CommandLine.Contains($serverEntry)) {
    Remove-Item -LiteralPath $pidFile -Force
    return $null
  }
  return $proc
}

function Get-Health {
  try {
    $health = Invoke-RestMethod -Uri "$origin/local-api/health" -TimeoutSec 2
    # apiVersion 3 is V4.x, 5 is V5 and 6 is V6; accepting all keeps this launcher valid for a V4.1 or V5 rollback.
    if ($health.status -eq 'ok' -and $health.service -eq 'abud-local-universe' -and [int]$health.apiVersion -ge 3) { return $health }
  } catch { }
  return $null
}

function Get-ListenerPid {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { return [int]$listener.OwningProcess }
  return $null
}

function Assert-OwnedListener {
  $owned = Get-BridgeProcess
  $listenerPid = Get-ListenerPid
  if ($listenerPid -and (-not $owned -or $listenerPid -ne [int]$owned.ProcessId)) {
    throw "Port $Port belongs to PID $listenerPid, which this launcher does not own. No process was stopped."
  }
  return $owned
}

function Get-PreviousSession {
  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
  try { return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Stop-Bridge {
  $owned = Assert-OwnedListener
  if (-not $owned) { Write-Host 'ABUD FUN Company OS is not running under this launcher.'; return }
  $ownedPid = [int]$owned.ProcessId
  # Any owner stop (including -Force) is recorded so the sign-in supervisor never restarts what the owner stopped.
  Set-LauncherState @{ ownerStoppedAt = (& $nowUtc) }
  if (Get-Health) {
    $session = Invoke-RestMethod -Uri "$origin/local-api/session" -TimeoutSec 3
    Invoke-RestMethod -Method Post -Uri "$origin/local-api/company/shutdown" -Headers @{ 'X-ABUD-SESSION' = $session.token } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
      if (-not (Get-Process -Id $ownedPid -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host 'ABUD FUN Company OS stopped cleanly.'
        return
      }
      Start-Sleep -Milliseconds 250
    }
    if (-not $Force) { throw "Shutdown did not complete for PID $ownedPid. Inspect local\logs, or run: ABUD-OS.ps1 stop -Force" }
  } elseif (-not $Force) {
    throw "Owned process $ownedPid is not answering health checks. Inspect local\logs, or run: ABUD-OS.ps1 stop -Force"
  }
  # -Force: only the verified bridge PID (node.exe running this project's server.mjs) is terminated.
  Stop-Process -Id $ownedPid -Force
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Terminated the unresponsive bridge process $ownedPid (owned by this launcher). SQLite recovers its journal on next start."
}

function Start-OwnedBridge([string]$nodePath) {
  if (Get-Health) { throw "A Company OS listener already exists on $Port but this launcher cannot establish ownership. Close it manually or use its own launcher." }
  if (Get-ListenerPid) { throw "Port $Port is occupied by another program. No process was stopped." }
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  Remove-OldLogs
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $logs "bridge-$stamp.out.log"
  $stderr = Join-Path $logs "bridge-$stamp.err.log"
  $env:LOCAL_UNIVERSE_PORT = [string]$Port
  $child = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverEntry + '"') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Set-Content -LiteralPath $pidFile -Value $child.Id
  for ($i = 0; $i -lt 80; $i++) {
    if (-not (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; throw "Bridge exited during startup. Inspect $stdout and $stderr" }
    $healthy = Get-Health
    if ($healthy -and [int]$healthy.pid -eq $child.Id) { return @{ pid = $child.Id; stdout = $stdout } }
    Start-Sleep -Milliseconds 250
  }
  throw "Bridge did not become healthy within 20 seconds. Inspect $stdout and $stderr"
}

function Start-Supervisor {
  if (Get-SupervisorProcess) { return }
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $proc = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + (Join-Path $project 'ABUD-OS.ps1') + '"'), '-Action', 'supervise', '-Port', [string]$Port) -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $supervisorPidFile -Value $proc.Id
  Write-LauncherLog "supervisor started (PID $($proc.Id))"
}

function Remove-OldLogs {
  if (-not (Test-Path -LiteralPath $logs)) { return }
  Get-ChildItem -LiteralPath $logs -Filter 'bridge-*.log' | Sort-Object Name -Descending | Select-Object -Skip ($keepLogPairs * 2) | Remove-Item -Force -ErrorAction SilentlyContinue
}

function New-LauncherShortcut([string]$folder, [string]$arguments, [string]$windowStyleNote) {
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $path = Join-Path $folder $shortcutName
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = $arguments
  $link.WorkingDirectory = $project
  $link.Description = "ABUD FUN Company OS ($windowStyleNote)"
  $link.WindowStyle = 7
  $link.Save()
  return $path
}

$quotedScript = '"' + (Join-Path $project 'ABUD-OS.ps1') + '"'
try {
  if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }

  if ($Action -eq 'shortcut') {
    $folder = if ($ShortcutFolder) { $ShortcutFolder } else { [Environment]::GetFolderPath('Desktop') }
    $path = New-LauncherShortcut $folder "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScript -Action start" 'opens the browser'
    Write-Host "Created $path"
    exit 0
  }
  $startupFolder = if ($ShortcutFolder) { $ShortcutFolder } else { [Environment]::GetFolderPath('Startup') }
  $autostartLink = Join-Path $startupFolder $shortcutName
  if ($Action -eq 'autostart-on') {
    $path = New-LauncherShortcut $startupFolder "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScript -Action start -AtSignIn" 'starts at sign-in; browser per owner preference'
    Write-Host "Enabled: Company OS will start when you sign in to Windows ($path). Disable with: Start-ABUD-OS.cmd autostart-off"
    exit 0
  }
  if ($Action -eq 'autostart-off') {
    if (Test-Path -LiteralPath $autostartLink) { Remove-Item -LiteralPath $autostartLink -Force; Write-Host 'Disabled: Company OS will no longer start at sign-in.' }
    else { Write-Host 'Sign-in start was not enabled.' }
    exit 0
  }
  if ($Action -eq 'autostart-status') {
    if (Test-Path -LiteralPath $autostartLink) { Write-Host "Sign-in start: enabled ($autostartLink)" } else { Write-Host 'Sign-in start: disabled' }
    exit 0
  }

  if (-not (Test-Path -LiteralPath $serverEntry)) { throw "Missing bridge entry point: $serverEntry" }
  if (-not (Test-Path -LiteralPath (Join-Path $project 'index.html'))) { throw 'Missing application index.html.' }
  if (-not (Test-Path -LiteralPath $database)) { throw "Missing company database: $database. Restore it from a verified local backup before starting." }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js 22.13 or newer is required. Install Node.js and reopen this launcher.' }
  $version = (& $node.Source -p 'process.versions.node').Trim()
  $parts = $version.Split('.')
  if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) { throw "Node.js $version is too old; 22.13+ is required." }
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  $owned = Assert-OwnedListener

  if ($Action -eq 'status') {
    $health = Get-Health
    $previous = Get-PreviousSession
    if ($owned -and $health) {
      $minutes = [math]::Round($health.uptimeSec / 60)
      Write-Host "Healthy: $origin (PID $($owned.ProcessId), Node.js $version, up $minutes min, memory $([math]::Round($owned.WorkingSetSize / 1MB)) MB)"
      try {
        # The first infrastructure read after a start also probes OmniRoute and can take several seconds.
        $infra = Invoke-RestMethod -Uri "$origin/local-api/infra" -TimeoutSec 20
        Write-Host "OmniRoute: $($infra.local.router.state). Database schema $($infra.local.store.schemaVersion), $($infra.local.store.backups) backups."
        if ($infra.local.bridge.previousExit) { Write-Host "Previous session ended: $($infra.local.bridge.previousExit.kind) (last heartbeat $($infra.local.bridge.previousExit.lastSeenAt))" }
      } catch { Write-Host "OmniRoute and database details are unavailable right now ($($_.Exception.Message)). Run status again." }
    }
    elseif ($owned) { Write-Host "Bridge PID $($owned.ProcessId) exists but health is unavailable. Inspect local\logs, or stop it with: Start-ABUD-OS.cmd stop -Force"; exit 1 }
    else {
      Write-Host 'ABUD FUN Company OS is stopped.'
      if ($previous -and -not $previous.clean) { Write-Host "The last session did not stop cleanly (last heartbeat $($previous.heartbeatAt)); it will be classified on the next start." }
    }
    exit 0
  }
  if ($Action -eq 'stop') { Stop-Bridge; exit 0 }
  if ($Action -eq 'restart') { Stop-Bridge; $owned = $null }

  if ($Action -eq 'supervise') {
    # Bounded recovery for the sign-in session: restart only after an unclean exit (crash or external kill), never after a
    # clean owner stop, and at most 3 times in any hour; then give up and record why.
    $restarts = New-Object System.Collections.Generic.List[datetime]
    Write-LauncherLog "supervisor watching $origin"
    while ($true) {
      Start-Sleep -Seconds 30
      if (-not (Test-Path -LiteralPath $serverEntry)) { Write-LauncherLog 'supervisor exit: project missing'; exit 0 }
      if (Get-BridgeProcess) { continue }
      if (Get-ListenerPid) { continue }  # someone else (e.g. a manual start elsewhere) owns the port; do nothing
      $previous = Get-PreviousSession
      if (-not $previous -or $previous.clean) { continue }
      $launcherState = $null
      try { $launcherState = Get-Content -LiteralPath $launcherStateFile -Raw | ConvertFrom-Json } catch { }
      if ($launcherState.ownerStoppedAt -and $previous.startedAt -and ([datetime]$launcherState.ownerStoppedAt).ToUniversalTime() -ge ([datetime]$previous.startedAt).ToUniversalTime()) { continue }
      $cutoff = (Get-Date).AddHours(-1)
      $recent = @($restarts | Where-Object { $_ -gt $cutoff })
      if ($recent.Count -ge 3) {
        Set-LauncherState @{ supervisorGaveUpAt = (& $nowUtc); lastFailure = 'Bridge exited uncleanly more than 3 times within an hour; automatic restart stopped.'; lastFailureAt = (& $nowUtc) }
        Write-LauncherLog 'supervisor gave up after 3 restarts within an hour'
        Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
        exit 1
      }
      try {
        $started = Start-OwnedBridge $node.Source
        $restarts.Add((Get-Date))
        $state = Get-Content -LiteralPath $launcherStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        Set-LauncherState @{ lastSuccessAt = (& $nowUtc); supervisorRestarts = [int]($state.supervisorRestarts) + 1 }
        Write-LauncherLog "supervisor restarted the bridge after an unclean exit (PID $($started.pid))"
      } catch {
        $restarts.Add((Get-Date))
        Set-LauncherState @{ lastFailureAt = (& $nowUtc); lastFailure = $_.Exception.Message }
        Write-LauncherLog "supervisor restart failed: $($_.Exception.Message)"
      }
    }
  }

  $mode = if ($AtSignIn) { 'sign-in' } else { 'manual' }
  if (-not $owned) {
    # At sign-in the machine may still be settling (disk, network, antivirus); retries are bounded and spaced.
    $delays = if ($AtSignIn) { @(5, 15, 45) } else { @() }
    $attempt = 0
    $started = $null
    while (-not $started) {
      $attempt++
      Set-LauncherState @{ mode = $mode; lastAttemptAt = (& $nowUtc); attempts = $attempt }
      try { $started = Start-OwnedBridge $node.Source }
      catch {
        Set-LauncherState @{ lastFailureAt = (& $nowUtc); lastFailure = $_.Exception.Message }
        Write-LauncherLog "start attempt $attempt failed: $($_.Exception.Message)"
        if ($attempt -gt $delays.Count) { throw }
        Start-Sleep -Seconds $delays[$attempt - 1]
        if (Get-BridgeProcess) { $owned = Get-BridgeProcess; break }
      }
    }
    if ($started) {
      Set-LauncherState @{ lastSuccessAt = (& $nowUtc) }
      Write-LauncherLog "started ($mode, attempt $attempt, PID $($started.pid))"
      Write-Host "Started ABUD FUN Company OS at $origin (PID $($started.pid)). Logs: $($started.stdout)"
    }
  } elseif (-not (Get-Health)) {
    throw "Owned process $($owned.ProcessId) is running but health is unavailable. Inspect local\logs, or run: Start-ABUD-OS.cmd restart -Force"
  } else { Write-Host "Using the healthy ABUD FUN Company OS at $origin (PID $($owned.ProcessId))." }
  if ($AtSignIn) {
    Start-Supervisor
    # One tab at most, only after success, only if the owner wants it.
    if (-not $NoBrowser -and (Get-OpenBrowserPreference)) { Start-Process -FilePath $origin }
  } elseif (-not $NoBrowser) { Start-Process -FilePath $origin }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
