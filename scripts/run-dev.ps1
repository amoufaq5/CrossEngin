<#
.SYNOPSIS
  One-command local launcher for CrossEngin Operate (API server + web console).

.DESCRIPTION
  Boots `operate-server` for a chosen vertical pack and the `operate-web`
  Next.js console in two new PowerShell windows, with a matching admin API key
  wired automatically. Defaults to the healthcare pack.

.EXAMPLE
  ./scripts/run-dev.ps1
  ./scripts/run-dev.ps1 -Pack erp-retail
  ./scripts/run-dev.ps1 -Pack erp-healthcare -Role front_desk   # see PHI redaction
  ./scripts/run-dev.ps1 -Build                                  # force a rebuild first
#>

[CmdletBinding()]
param(
  [ValidateSet("erp-core", "erp-retail", "erp-healthcare", "erp-grocery")]
  [string]$Pack = "erp-healthcare",
  [string]$Role = "",
  [int]$Port = 8787,
  [int]$WebPort = 3000,
  [string]$Tenant = "11111111-1111-1111-1111-111111111111",
  [string]$Store = "memory",
  [switch]$Build
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

# Default admin role per pack (must exist in that pack or you get 403s).
$defaultRole = @{
  "erp-core"        = "erp_admin"
  "erp-retail"      = "retail_admin"
  "erp-healthcare"  = "clinical_admin"
  "erp-grocery"     = "grocery_admin"
}[$Pack]
if ([string]::IsNullOrWhiteSpace($Role)) { $Role = $defaultRole }

$serverBin = Join-Path $repo "apps/operate-server/dist/bin/operate-server.js"
$webDir = Join-Path $repo "apps/operate-web"

# Build if the server bin is missing or a rebuild was requested.
if ($Build -or -not (Test-Path $serverBin)) {
  Write-Host "Building workspace (pnpm install + build)..." -ForegroundColor Cyan
  Push-Location $repo
  pnpm install
  pnpm -r build
  Pop-Location
}

if (-not (Test-Path $serverBin)) {
  throw "operate-server build not found at $serverBin. Run: pnpm -r build"
}

$apiKey = "devkey:${Role}:${Tenant}"

Write-Host ""
Write-Host "CrossEngin Operate" -ForegroundColor Red
Write-Host "  pack    : $Pack"
Write-Host "  role    : $Role"
Write-Host "  store   : $Store"
Write-Host "  API     : http://localhost:$Port"
Write-Host "  console : http://localhost:$WebPort"
Write-Host ""

# Terminal A: the API server.
$serverCmd = "node `"$serverBin`" --pack $Pack --store $Store --port $Port --api-key `"$apiKey`""
Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverCmd

# Give the server a moment to bind before the web app proxies to it.
Start-Sleep -Seconds 2

# Terminal B: the web console (proxy points at the API; key stays server-side).
$webCmd = @"
`$env:OPERATE_API_URL = 'http://localhost:$Port';
`$env:OPERATE_API_KEY = 'devkey';
Set-Location '$webDir';
pnpm exec next dev -p $WebPort
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $webCmd

Write-Host "Launched both windows. Open http://localhost:$WebPort (Ctrl+F5 to hard-refresh)." -ForegroundColor Green
Write-Host "Stop by closing the two new PowerShell windows." -ForegroundColor DarkGray
