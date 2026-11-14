# Playback acceptance check.
# 1) runs core tests  2) asserts each playback piece exists in the source tree
# Exit code 0 = all good.
$ErrorActionPreference = "Continue"
$env:RUSTUP_HOME = "D:\rust\rustup"
$env:CARGO_HOME  = "D:\rust\cargo"
$env:PATH = "D:\rust\cargo\bin;D:\rust\w64devkit\bin;$env:PATH"
$fail = 0

Write-Host "== 1. core tests ==" -ForegroundColor Cyan
$out = (cargo test -p reelbox-core 2>&1 | ForEach-Object { "$_" }) -join "`n"
($out -split "`n") | Where-Object { $_ -match "test result" } | ForEach-Object { Write-Host "  $_" }
$count = 0
if ($out -match "test result: ok\. (\d+) passed") { $count = [int]$Matches[1] }
foreach ($n in @("finds_relative_m3u8","finds_absolute_m3u8","none_when_absent")) {
  if ($out -notmatch [regex]::Escape($n)) { Write-Host "  MISSING test: $n" -ForegroundColor Red; $fail = 1 }
}
if ($count -lt 10) { Write-Host "  expected >=10 tests, got $count" -ForegroundColor Red; $fail = 1 }
else { Write-Host "  $count tests passed" -ForegroundColor Green }

Write-Host "== 2. playback wiring ==" -ForegroundColor Cyan
$checks = @(
  @{ f = "src-tauri/src/proxy.rs";        p = "fn rewrite";        d = "m3u8 URL rewrite" },
  @{ f = "src-tauri/src/proxy.rs";        p = "Access-Control";    d = "CORS header" },
  @{ f = "src-tauri/src/commands.rs";     p = "player_url";        d = "player_url command" },
  @{ f = "core/src/source/cms.rs";        p = "fn extract_m3u8";   d = "share page -> m3u8" },
  @{ f = "core/src/source/cms.rs";        p = "fn resolve_media";  d = "stream resolution" },
  @{ f = "ui/index.html";                 p = 'id="player"';       d = "player overlay" },
  @{ f = "ui/index.html";                 p = "hls.min.js";        d = "hls.js loaded" },
  @{ f = "ui/app.js";                     p = "function openPlayer"; d = "openPlayer" },
  @{ f = "ui/app.js";                     p = "function saveProgress"; d = "progress memory" },
  @{ f = "ui/app.js";                     p = "v.onended";         d = "auto next episode" },
  @{ f = "ui/app.js";                     p = "requestFullscreen"; d = "fullscreen key" },
  @{ f = "docs/PLAYBACK.md";              p = "PLAYBACK";          d = "docs" },
  @{ f = "docs/playback.png";             p = $null;               d = "screenshot" }
)
foreach ($c in $checks) {
  if (-not (Test-Path $c.f)) { Write-Host "  [MISSING] $($c.f) ($($c.d))" -ForegroundColor Red; $fail = 1; continue }
  if ($null -ne $c.p -and -not (Select-String -Path $c.f -Pattern ([regex]::Escape($c.p)) -Quiet)) {
    Write-Host "  [MISSING] $($c.d) in $($c.f)" -ForegroundColor Red; $fail = 1
  } else {
    Write-Host "  [OK] $($c.d)" -ForegroundColor Green
  }
}

Write-Host ""
if ($fail -eq 0) { Write-Host "PASS: playback implemented and wired" -ForegroundColor Green; exit 0 }
Write-Host "FAIL: see items above" -ForegroundColor Red; exit 1
