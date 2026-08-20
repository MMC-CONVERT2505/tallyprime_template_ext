# Starts/stops the local Postgres + Redis dev dependencies without Docker.
# Installed as portable (zip) binaries under %USERPROFILE%\.local because
# Docker Desktop was unavailable and choco install needs admin elevation.
# These run as plain user processes, not Windows services, so they do NOT
# survive a reboot on their own — rerun `start` after restarting the machine.
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$pgBin = "$env:USERPROFILE\.local\pgsql16\pgsql\bin"
$pgData = "$env:USERPROFILE\.local\pgsql16-data"
$pgLog = "$pgData\server.log"
$redisDir = "$env:USERPROFILE\.local\redis"

function Start-Local {
  if (Get-Process postgres -ErrorAction SilentlyContinue) {
    Write-Host 'Postgres already running.'
  } else {
    & "$pgBin\pg_ctl.exe" -D $pgData -l $pgLog -w start
  }

  if (Get-Process redis-server -ErrorAction SilentlyContinue) {
    Write-Host 'Redis already running.'
  } else {
    # Config path must be relative (not `"$redisDir\...`") — this msys2 build of
    # redis-server mishandles an absolute Windows path as its first arg, mangling
    # it into a bogus concatenated path. A bare filename + -WorkingDirectory works.
    Start-Process -FilePath "$redisDir\redis-server.exe" `
      -ArgumentList "redis.windows.conf --port 6379" `
      -WorkingDirectory $redisDir -WindowStyle Hidden
    Write-Host 'Redis started.'
  }
}

function Stop-Local {
  & "$pgBin\pg_ctl.exe" -D $pgData stop -m fast
  Get-Process redis-server -ErrorAction SilentlyContinue | Stop-Process
  Write-Host 'Stopped Postgres and Redis.'
}

function Get-LocalStatus {
  Get-Process postgres, redis-server -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize
}

switch ($Action) {
  'start' { Start-Local }
  'stop' { Stop-Local }
  'status' { Get-LocalStatus }
}
