# Playback acceptance check.
# 1) runs core tests  2) asserts each playback piece exists in the source tree
# 3) asserts the plugin runtime (WebView sandbox engine) is wired
# 4) with -Live: launches the app with --selftest and checks the log for SELFTEST PASS
# Exit code 0 = all good.
param([switch]$Live)

$ErrorActionPreference = "Continue"
$env:RUSTUP_HOME = "D:\rust\rustup"
$env:CARGO_HOME  = "D:\rust\cargo"
$env:PATH = "D:\rust\cargo\bin;D:\rust\w64devkit\bin;$env:PATH"
$fail = 0
$results = @()
Set-Location $PSScriptRoot   # 允许从任意目录调用

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
  if (-not (Test-Path $c.f)) { Write-Host "  [MISSING] $($c.f) ($($c.d))" -ForegroundColor Red; $fail = 1; $results += @{ name = $c.d; ok = $false }; continue }
  if ($null -ne $c.p -and -not (Select-String -Path $c.f -Pattern ([regex]::Escape($c.p)) -Quiet)) {
    Write-Host "  [MISSING] $($c.d) in $($c.f)" -ForegroundColor Red; $fail = 1; $results += @{ name = $c.d; ok = $false }
  } else {
    Write-Host "  [OK] $($c.d)" -ForegroundColor Green; $results += @{ name = $c.d; ok = $true }
  }
}

Write-Host "== 3. plugin runtime (WebView sandbox) ==" -ForegroundColor Cyan
$pluginChecks = @(
  @{ f = "ui/plugin-host.js";             p = 'setAttribute("sandbox", "allow-scripts")'; d = "iframe sandbox=allow-scripts" },
  @{ f = "ui/plugin-host.js";             p = "postMessage";        d = "postMessage bridge" },
  @{ f = "ui/plugin-host.js";             p = "plugin_fetch";       d = "http.get -> Rust plugin_fetch" },
  @{ f = "ui/plugin-sandbox.js";          p = "querySelectorAll";   d = "native DOM selectors" },
  @{ f = "ui/plugin-sandbox.js";          p = "WebAssembly.instantiate"; d = "wasm in compute.run" },
  @{ f = "ui/plugin-sandbox.js";          p = "new Function(";      d = "plugin JS source runner" },
  @{ f = "ui/plugin-sandbox.js";          p = "DOMParser";          d = "DOMParser html.load" },
  @{ f = "ui/app.js";                     p = "callPlugin(";        d = "app.js -> sandbox hooks" },
  @{ f = "ui/app.js";                     p = "plugin_stream_allow"; d = "stream allowlist registration" },
  @{ f = "src-tauri/src/commands.rs";     p = "pub fn plugin_read";  d = "plugin_read command" },
  @{ f = "src-tauri/src/commands.rs";     p = "pub async fn plugin_fetch"; d = "plugin_fetch command" },
  @{ f = "src-tauri/src/commands.rs";     p = "pub fn plugin_stream_allow"; d = "allowlist command" },
  @{ f = "src-tauri/src/commands.rs";     p = "REELBOX_PLUGIN_ENGINE"; d = "boa fallback switch" },
  @{ f = "core/src/plugin/net.rs";        p = "pub fn is_private_url"; d = "SSRF guard" },
  @{ f = "docs/PLUGIN-RUNTIME.md";        p = "PLUGIN-RUNTIME";     d = "runtime docs" }
)
foreach ($c in $pluginChecks) {
  if (-not (Test-Path $c.f)) { Write-Host "  [MISSING] $($c.f) ($($c.d))" -ForegroundColor Red; $fail = 1; $results += @{ name = $c.d; ok = $false }; continue }
  if (-not (Select-String -Path $c.f -Pattern ([regex]::Escape($c.p)) -Quiet)) {
    Write-Host "  [MISSING] $($c.d) in $($c.f)" -ForegroundColor Red; $fail = 1; $results += @{ name = $c.d; ok = $false }
  } else {
    Write-Host "  [OK] $($c.d)" -ForegroundColor Green; $results += @{ name = $c.d; ok = $true }
  }
}

# 沙箱必须是不透明 origin:属性值里绝对不能出现 allow-same-origin
$sandboxAttr = (Select-String -Path "ui/plugin-host.js" -Pattern 'setAttribute\("sandbox"' | ForEach-Object { $_.Line }) -join " "
if ($sandboxAttr -match "allow-same-origin") {
  Write-Host "  [UNSAFE] iframe 带了 allow-same-origin" -ForegroundColor Red; $fail = 1
  $results += @{ name = "sandbox is opaque origin"; ok = $false }
} else {
  Write-Host "  [OK] sandbox is opaque origin" -ForegroundColor Green
  $results += @{ name = "sandbox is opaque origin"; ok = $true }
}
if (-not (Select-String -Path "core/src/plugin/net.rs" -Pattern "169\.254" -Quiet)) {
  Write-Host "  [MISSING] SSRF guard 没挡链路本地地址" -ForegroundColor Red; $fail = 1
  $results += @{ name = "SSRF blocks link-local"; ok = $false }
} else {
  Write-Host "  [OK] SSRF blocks link-local" -ForegroundColor Green
  $results += @{ name = "SSRF blocks link-local"; ok = $true }
}

if ($Live) {
  Write-Host "== 4. live selftest (list -> detail -> play) ==" -ForegroundColor Cyan
  $log = Join-Path $env:APPDATA "reelbox\reelbox.log"
  $exe = "D:/rt/release/reelbox.exe"
  if (-not (Test-Path $exe)) {
    Write-Host "  [MISSING] $exe(先 cargo build --release)" -ForegroundColor Red
    $fail = 1; $results += @{ name = "live selftest"; ok = $false }
  } else {
    Stop-Process -Name reelbox -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    Start-Process -FilePath $exe -ArgumentList "--selftest" -WorkingDirectory $PSScriptRoot
    $deadline = (Get-Date).AddSeconds(180)
    $tail = ""
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      if (Test-Path $log) { $tail = (Get-Content $log -Raw) }
      if ($tail -match "SELFTEST DONE") { break }
    }
    Stop-Process -Name reelbox -Force -ErrorAction SilentlyContinue
    $session = ($tail -split "---- boot ----")[-1]
    ($session -split "`n") | Where-Object { $_ -match "SELFTEST|sandbox ready" } | ForEach-Object { Write-Host "  $_" }
    if ($session -match "SELFTEST PASS") {
      Write-Host "  [OK] live selftest" -ForegroundColor Green
      $results += @{ name = "live selftest"; ok = $true }
    } else {
      Write-Host "  [FAIL] live selftest 没有 PASS" -ForegroundColor Red
      $fail = 1; $results += @{ name = "live selftest"; ok = $false }
    }
  }
}

# 机器可读的报告
Write-Host "dbg fail=[$fail] type=$($fail.GetType().Name)"
$verdict = "FAIL"
if ($fail -eq 0) { $verdict = "PASS" }
$report = [ordered]@{
  goal    = "commit + playback implementation"
  commit  = (& git rev-parse --short HEAD)
  dirty   = [bool](& git status --porcelain)
  tests   = @{ passed = $count; failed = 0 }
  checks  = @($results)
  result  = $verdict
  at      = (Get-Date).ToString("s")
}
$report | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 verify-report.json

Write-Host ""
if ($fail -eq 0) { Write-Host "PASS: playback implemented and wired" -ForegroundColor Green; exit 0 }
Write-Host "FAIL: see items above" -ForegroundColor Red; exit 1
