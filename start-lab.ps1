# Starts the lab on http://127.0.0.1:4400.
# On this machine node is not on PATH, so fall back to the portable install.
param([switch]$Demo)

$portable = 'C:\Users\RameshBabuSettivari\AppData\Local\Programs\nodejs-portable\node-v24.19.0-win-x64'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Test-Path $portable) { $env:PATH = "$portable;$env:PATH" }
  else { Write-Error 'Node 20 or newer is required and was not found on PATH.'; exit 1 }
}
Set-Location $PSScriptRoot
if ($Demo) { node scripts/demo.js } else { node server/index.js }
