# dsh-cua-pre one-command installer (Windows PowerShell)
# Usage:  irm https://raw.githubusercontent.com/Aik358/dsh-cua-pre/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Write-Host '== dsh-cua-pre installer ==' -ForegroundColor Cyan

$pkg = '@a9i5k4/dsh-cua-pre'
$legacy = '@a9iska/dsh-cua-pre'
$profileDir = Join-Path $HOME '.dsh\profiles\web'
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  Write-Host "[x] not found: $profileDir\package.json — is DeepSeek Harness (dsh web) installed?" -ForegroundColor Red
  exit 1
}
Set-Location $profileDir

# 1) install package. Scoped packages resolve via @a9i5k4 -> official registry
#    mapping in profile .npmrc (idempotent); other deps keep the default mirror.
Write-Host "[1/3] pnpm add $pkg ..."
$npmrc = Join-Path $profileDir '.npmrc'
$want = '@a9i5k4:registry=https://registry.npmjs.org/'
if (-not ((Test-Path $npmrc) -and (Select-String -Path $npmrc -SimpleMatch $want -Quiet))) {
  Add-Content -Path $npmrc -Value $want -Encoding ascii
  Write-Host "    added '$want' to $npmrc"
}
pnpm remove $legacy 2>$null | Out-Null
pnpm add $pkg
if ($LASTEXITCODE -ne 0) { Write-Host '[x] pnpm add failed' -ForegroundColor Red; exit 1 }

# 2) patch bundles array
Write-Host '[2/3] patching dsh.profile.bundles ...'
& node -e "
const fs = require('fs');
const p = 'package.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.dsh = d.dsh || {}; d.dsh.profile = d.dsh.profile || {}; d.dsh.profile.bundles = d.dsh.profile.bundles || [];
const b = d.dsh.profile.bundles;
const li = b.indexOf('$legacy'); if (li >= 0) b[li] = '$pkg'; else if (!b.includes('$pkg')) b.push('$pkg');
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('    bundles: ' + b.join(', '));
"
if ($LASTEXITCODE -ne 0) { Write-Host '[x] bundle patch failed' -ForegroundColor Red; exit 1 }

# 3) optional: enable plugin (config written WITHOUT BOM so JSON.parse accepts it)
Write-Host '[3/3] config (~/.dsh/cua-pre.json)'
$cfg = Join-Path $HOME '.dsh\cua-pre.json'
if (-not (Test-Path $cfg)) {
  [IO.File]::WriteAllText($cfg, "{`n  `"enabled`": false`n}`n")
  Write-Host "    created $cfg (enabled=false; default-off by design)"
}
Write-Host ''
Write-Host '== done ==' -ForegroundColor Green
Write-Host 'Next steps:'
Write-Host '  1. restart dsh web (port 3080 restart stays a manual user step)'
Write-Host ('  2. enable: put {"enabled":true} into ' + $cfg + ' (recommended: pythonExecutable -> your venv python)')
Write-Host '     optional vision: add "visionEnabled":true and "visionModel":"<vlm-model-name>"'
Write-Host '  3. verify log line: [dsh-cua-pre] ready: 30/30 tools; enabled=true; routes=6'
