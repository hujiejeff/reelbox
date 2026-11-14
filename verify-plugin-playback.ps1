# 插件源播放稳定性验收:连续跑 N 次 `reelbox.exe --selftest`,要求每次都 PASS。
#
# 判定依据(两者都要满足):
#   1) 日志里出现 `SELFTEST PASS` 和 `SELFTEST DONE`
#   2) 自检自己写的 docs/selftest-report.json 里 result = PASS
#      (play 阶段至少 2 集 readyState>=3 + videoWidth>0 + currentTime 前进)
#
# 任一次不满足 → 非零退出,并把那一次的 PROXY / PROBE / HLS / VIDEO 证据行打出来。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-plugin-playback.ps1
#   powershell ... -File verify-plugin-playback.ps1 -Runs 5
#   powershell ... -File verify-plugin-playback.ps1 -Title 折月亮   # 专门复现某个片名
param(
  [int]$Runs = 3,
  [string]$Source = "4k",
  [string]$Title = "",
  [int]$TimeoutSec = 260
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# 自检用同一个开关挑片名(Rust 侧读这个环境变量)
if ($Title) { $env:REELBOX_SELFTEST_TITLE = $Title } else { Remove-Item Env:REELBOX_SELFTEST_TITLE -ErrorAction SilentlyContinue }
$exe    = "D:/rt/release/reelbox.exe"
$log    = Join-Path $env:APPDATA "reelbox\reelbox.log"
$report = Join-Path $PSScriptRoot "docs\selftest-report.json"
$runsFile = Join-Path $PSScriptRoot "docs\selftest-runs.json"
Set-Location $PSScriptRoot

function Write-Utf8($path, $text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

if (-not (Test-Path $exe)) {
  Write-Host "[FAIL] 找不到 $exe,先 cargo build --release" -ForegroundColor Red
  exit 1
}

Write-Host "== 插件源播放验收:$Runs 次 --selftest ==" -ForegroundColor Cyan
$history = @()
$failed = 0

for ($i = 1; $i -le $Runs; $i++) {
  Write-Host ""
  Write-Host "-- run $i/$Runs --" -ForegroundColor Cyan
  Stop-Process -Name reelbox -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  if (Test-Path $report) { Remove-Item $report -Force -ErrorAction SilentlyContinue }
  $before = 0
  if (Test-Path $log) { $before = (Get-Item $log).Length }

  Start-Process -FilePath $exe -ArgumentList "--selftest" -WorkingDirectory $PSScriptRoot
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $session = ""
  $done = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
      $bytes = [System.IO.File]::ReadAllBytes($log)
      if ($bytes.Length -gt $before) {
        $session = [System.Text.Encoding]::UTF8.GetString($bytes, $before, $bytes.Length - $before)
      }
    }
    if ($session -match "SELFTEST DONE") { $done = $true; break }
  }
  Start-Sleep -Milliseconds 500
  Stop-Process -Name reelbox -Force -ErrorAction SilentlyContinue

  # 自检自己的结论
  $rep = $null
  if (Test-Path $report) {
    try { $rep = [System.IO.File]::ReadAllText($report) | ConvertFrom-Json } catch { $rep = null }
  }

  $lines = @()
  if ($session) {
    $lines = ($session -split "`n") | Where-Object { $_ -match "SELFTEST|sandbox ready" }
    $lines | ForEach-Object { Write-Host "  $_" }
  }
  $logPass  = ($session -match "SELFTEST PASS")
  $repPass  = ($rep -ne $null -and $rep.result -eq "PASS")
  $playPass = ($rep -ne $null -and $rep.play -ne $null -and $rep.play.ok -eq $true)
  $cmsOk    = ($rep -ne $null -and $rep.cms -ne $null -and $rep.cms.ok -eq $true)
  $ok = $done -and $logPass -and $repPass -and $playPass

  $title = ""
  if ($rep -ne $null -and $rep.detail -ne $null) { $title = $rep.detail.title }
  $playNote = "n/a"
  if ($rep -ne $null -and $rep.play -ne $null) {
    $playNote = "$($rep.play.passed)/$($rep.play.needed) tries=$($rep.play.tries) ms=$($rep.play.ms)"
  }
  $cmsNote = if ($cmsOk) { "ok" } else { "warn" }

  if ($ok) {
    Write-Host "  [PASS] run $i  源=$Source 片名=$title  play=$playNote  cms=$cmsNote" -ForegroundColor Green
  } else {
    $failed++
    Write-Host "  [FAIL] run $i  done=$done logPass=$logPass reportPass=$repPass play=$playNote" -ForegroundColor Red
    # 失败证据:反代/探测/播放器的原始日志行
    ($session -split "`n") | Where-Object { $_ -match "PROXY|PROBE|HLS |HLS ERR|VIDEO ERR|STREAM FAIL|M3U8 probe" } |
      Select-Object -Last 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    if ($rep -ne $null -and $rep.reason) { Write-Host "    reason: $($rep.reason)" -ForegroundColor DarkYellow }
  }

  $history += [ordered]@{
    run      = $i
    ok       = $ok
    title    = $title
    play     = $playNote
    cms      = $cmsNote
    durationMs = if ($rep -ne $null) { $rep.durationMs } else { 0 }
    reason   = if ($rep -ne $null) { $rep.reason } else { "" }
    at       = (Get-Date).ToString("s")
  }
}

$verdict = if ($failed -eq 0) { "PASS" } else { "FAIL" }
$summary = [ordered]@{
  goal    = "插件源(4k影视)播放稳定性:$Runs 次 --selftest 全 PASS"
  runs    = $history
  passed  = ($Runs - $failed)
  failed  = $failed
  result  = $verdict
  at      = (Get-Date).ToString("s")
}
Write-Utf8 $runsFile (($summary | ConvertTo-Json -Depth 6))

Write-Host ""
if ($failed -eq 0) {
  Write-Host "PASS: $Runs/$Runs 次自检全部通过(每份摘要见 docs/selftest-report.json)" -ForegroundColor Green
  exit 0
}
Write-Host "FAIL: $failed/$Runs 次没通过,证据见上面的 PROXY/PROBE/HLS 行" -ForegroundColor Red
exit 1
