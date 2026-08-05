$ErrorActionPreference = 'Stop'

$target = 'C:\Program Files\TallyConnector'
$exePath = Join-Path $target 'tally-backend.exe'
$envPath = Join-Path $target '.env'

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item '.\dist-exe\tally-backend.exe' -Destination $exePath -Force

if (Test-Path '.env') {
  Copy-Item '.env' -Destination $envPath -Force
}

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Host 'nssm not installed. Please install NSSM or run the exe directly.'
  exit 0
}

nssm install TallyBackend $exePath
nssm set TallyBackend AppDirectory $target
nssm set TallyBackend Start SERVICE_AUTO_START
nssm start TallyBackend

Write-Host 'Installed as Windows service.'
