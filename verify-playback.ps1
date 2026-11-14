# Playback pipeline check: run core tests and assert the share-page extraction tests exist.
$ErrorActionPreference = "Continue"
$env:RUSTUP_HOME = "D:\rust\rustup"
$env:CARGO_HOME  = "D:\rust\cargo"
$env:PATH = "D:\rust\cargo\bin;D:\rust\w64devkit\bin;$env:PATH"

Write-Host "== cargo test -p reelbox-core ==" -ForegroundColor Cyan
$out = (cargo test -p reelbox-core 2>&1 | ForEach-Object { "$_" }) -join "`n"
($out -split "`n") | Where-Object { $_ -match "^test |test result" } | ForEach-Object { Write-Host $_ }

$count = 0
if ($out -match "test result: ok\. (\d+) passed") { $count = [int]$Matches[1] }

$need = @("finds_relative_m3u8", "finds_absolute_m3u8", "none_when_absent")
$missing = @()
foreach ($n in $need) { if ($out -notmatch [regex]::Escape($n)) { $missing += $n } }

Write-Host ""
if ($count -ge 10 -and $missing.Count -eq 0) {
  Write-Host "PASS: $count tests passed, share-page extraction covered" -ForegroundColor Green
  exit 0
}
Write-Host "FAIL: passed=$count missing=$($missing -join ',')" -ForegroundColor Red
exit 1
