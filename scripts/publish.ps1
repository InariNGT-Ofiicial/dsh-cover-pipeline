# publish.ps1 -- one-command publish of this plugin to GitHub.
#
# ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI unless it has a UTF-8 BOM,
# so non-ASCII comments here would mojibake. Keep this file ASCII.
#
# Usage:
#   1) Create an EMPTY repo on GitHub (do NOT add README / .gitignore / license).
#   2) powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
#      or: ... -Repo my-name -Owner my-account
#
# It is idempotent: re-running just re-points origin and pushes the current branch.

param(
  [string]$Owner = 'InariNGT-Ofiicial',
  [string]$Repo  = 'dsh-cover-pipeline',
  [string]$Branch = 'main',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$remote = "git@github.com:$Owner/$Repo.git"
Write-Host "[publish] repo root : $root"
Write-Host "[publish] remote    : $remote"

if (-not (Test-Path (Join-Path $root '.git'))) {
  Write-Host "[publish] no .git here -- run: git init -b $Branch"
  exit 1
}

# Refuse to publish anything that looks like audio / model weights / secrets.
$bad = & git ls-files | Where-Object { $_ -match '\.(wav|mp3|flac|pt|ckpt|onnx|safetensors|npy|npz)$' -or $_ -match '(^|/)(\.env|\.credentials)' }
if ($bad) {
  Write-Host "[publish] REFUSED -- these tracked files must not be published:"
  $bad | ForEach-Object { Write-Host "    $_" }
  Write-Host "[publish] remove them from tracking and add to .gitignore first."
  exit 1
}

$dirty = & git status --porcelain
if ($dirty) {
  Write-Host "[publish] working tree is dirty; commit first:"
  $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
  exit 1
}

Write-Host "[publish] tracked files: $((& git ls-files | Measure-Object).Count)"
Write-Host "[publish] last commit  : $((& git log --oneline -1))"

# The remote repo must already exist (we cannot create it without a token).
# NOTE: with $ErrorActionPreference='Stop', a native command writing to stderr
# becomes a TERMINATING error -- so relax it around the probe, otherwise the
# friendly "create it first" message below would never print.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& git ls-remote $remote 2>&1 | Out-Null
$probeRc = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($probeRc -ne 0) {
  Write-Host "[publish] remote repo not found: $remote"
  Write-Host "[publish] create it EMPTY first: https://github.com/new?name=$Repo"
  Write-Host "[publish] do NOT tick README / .gitignore / license -- keep it empty, so the first push has no conflict"
  exit 2
}

if ($DryRun) { Write-Host "[publish] dry-run: would push $Branch -> origin"; exit 0 }

# Same trap as the probe above: `git remote remove origin` writes to stderr when
# origin does not exist yet (the normal first-publish case), which under
# ErrorActionPreference='Stop' would abort BEFORE the push. So: relax, prefer
# set-url when origin already exists, and take exit codes explicitly.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$existingRemotes = & git remote 2>&1
if ($existingRemotes -contains 'origin') {
  & git remote set-url origin $remote 2>&1 | Out-Null
} else {
  & git remote add origin $remote 2>&1 | Out-Null
}
& git push -u origin $Branch
$pushRc = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($pushRc -ne 0) { Write-Host "[publish] push failed (rc=$pushRc)"; exit 3 }

Write-Host "[publish] done -> https://github.com/$Owner/$Repo"
