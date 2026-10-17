# install.ps1 -- 一条命令接入翻唱插件
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Root D:\AI-Song -Voice 祥子
#
# 做四件事：
#   1. 自动找 AI-Song 根目录（也可 -Root 指定）
#   2. 校验随包 15 个脚本 + 4 个预训练件 + 选中音色（含 sha256）
#   3. 把发现到的路径写进仓库根 cover.local.json（git 忽略，优先级最高）
#   4. 调 `dsh plugin --profile desktop add` 安装插件
#
# 只读预演：加 -DryRun（不写 cover.local.json，不安装）。

[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Voice = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "[x] 找不到 node.exe。请先确认 DSH 自带运行时在 PATH 里。" -ForegroundColor Red
  exit 1
}

if (-not $Root) {
  foreach ($c in @($env:DSH_COVER_ROOT, 'D:\AI-Song', 'C:\AudioWork')) {
    if ($c -and (Test-Path (Join-Path $c '01_人声分离_MSST-GUI'))) { $Root = $c; break }
  }
}

if (-not $Root -or -not (Test-Path $Root)) {
  Write-Host "[!] 没找到 AI-Song 根目录。先把三样材料解压到位：" -ForegroundColor Yellow
  Write-Host "    1) MSST 整合包   https://pan.baidu.com/s/1gLO9U5jcfrtO3WJmAAyo1Q?pwd=u3r2   提取码 u3r2"
  Write-Host "    2) DDSP 6.2 包  https://pan.baidu.com/s/16LUHAc40KsCI449TbPQ29Q?pwd=j44k   提取码 j44k"
  Write-Host "    3) 8 人音色包   https://pan.baidu.com/s/1GJBrq3287GA_KKwNudFDpw?pwd=2aj9   提取码 2aj9"
  Write-Host "    解压布局见 materials/README.md。"
  exit 2
}

Write-Host "仓库   : $repo"
Write-Host "根目录 : $Root"
if ($Voice) { Write-Host "音色   : $Voice" }
if ($DryRun) { Write-Host "模式   : 只读预演（不写配置、不安装）" }

$cliArgs = @((Join-Path $repo 'scripts\verify-materials.mjs'), '--root', $Root)
if ($Voice) { $cliArgs += @('--voice', $Voice) }
if (-not $DryRun) { $cliArgs += '--write-config' }

& $node @cliArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host "[x] 材料未齐，先补齐再装。下载入口见 materials/README.md。" -ForegroundColor Red
  exit $code
}
if ($DryRun) { Write-Host "[=] 预演结束。去掉 -DryRun 即写配置并安装。"; exit 0 }

Write-Host "`n[1/2] 安装插件到 desktop profile ..."
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
  & $dsh.Source plugin --profile desktop add $repo
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] dsh plugin add 返回 $LASTEXITCODE；可手动重试。" -ForegroundColor Yellow
  }
} else {
  Write-Host "[!] PATH 里没有 dsh 命令。手动执行：" -ForegroundColor Yellow
  Write-Host "    dsh plugin --profile desktop add `"$repo`""
}

$v = if ($Voice) { $Voice } else { '祥子' }
Write-Host "`n[2/2] 完成。★ 重启 DSH 后生效。" -ForegroundColor Green
Write-Host "然后直接说一句：用$v的声音翻唱《歌名》"
