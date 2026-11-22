$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outPath = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) "public\raft-node"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null

Push-Location $scriptDir
try {
  $env:GOOS = "linux"
  $env:GOARCH = "arm64"
  $env:CGO_ENABLED = "0"
  go build -ldflags="-s -w" -o $outPath .
  $item = Get-Item $outPath
  Write-Host ("Built {0} ({1:N2} MiB)" -f $item.FullName, ($item.Length / 1MB))
} finally {
  Pop-Location
}
