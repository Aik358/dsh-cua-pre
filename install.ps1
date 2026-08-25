# dsh-cua-pre one-command installer (Windows PowerShell)
# Usage:  irm https://raw.githubusercontent.com/Aik358/dsh-cua-pre/main/install.ps1 | iex
# Does: locate ~/.dsh/profiles/web -> pnpm add @a9i5k4/dsh-cua-pre ->
#       patch dsh.profile.bundles (replace legacy @a9iska entry if present) -> print restart hint.
$ErrorActionPreference = 'Stop'
Write-Host '== dsh-cua-pre installer ==' -ForegroundColor Cyan

$pkg = '@a9i5k4/dsh-cua-pre'
$legacy = '@a9iska/dsh-cua-pre'
$profileDir = Join-Path $HOME '.dsh\profiles\web'
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  Write-Host "[x] not found: $profileDir\package.json — is DeepSeek Harness (dsh web) installed?" -ForegroundColor Red
  exit 1
}
Set-Location $profileDir

# 1) install package from npm (also removes legacy local-file install leftovers)
Write-Host "[1/3] pnpm add $pkg ..."
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

# 3) optional: enable plugin
Write-Host '[3/3] config (~/.dsh/cua-pre.json)'
$cfg = Join-Path $HOME '.dsh\cua-pre.json'
if (-not (Test-Path $cfg)) {
  @{ enabled = $false } | ConvertTo-Json | Set-Content $cfg -Encoding UTF8
  Write-Host "    created $cfg (enabled=false — 默认关闭，安全设计)"
}
Write-Host ''
Write-Host '== done ==' -ForegroundColor Green
Write-Host '下一步:'
Write-Host '  1. 重启 dsh web（3080 由你手动重启）'
Write-Host "  2. 启用电脑控制: 在 $cfg 写 {\"enabled\":true}（推荐加 pythonExecutable 指向 venv）"
Write-Host '     识图(可选): 追加 "visionEnabled":true 与 "visionModel":"<VLM模型名>"'
Write-Host '  3. 日志确认: [dsh-cua-pre] ready: 30/30 tools; enabled=true; routes=6'
