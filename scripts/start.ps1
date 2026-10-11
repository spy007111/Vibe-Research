# -Prebuilt:用已经打包好的页面(desktop\dist,由 vite preview 提供),不起开发服务器。免安装包用它
# -NoOpen:启动后不自动打开浏览器
# -Port / -ApiPort:页面 / 本机 API 端口。默认 5930 / 8765，被占用或被系统保留时自动换一个空闲的；指定了就只用它
param([switch]$Prebuilt, [switch]$NoOpen, [int]$Port = 0, [int]$ApiPort = 0)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Node 运行时预检:版本不够或构建未启用 TypeScript 支持时给出指引,而不是 ERR_UNKNOWN_FILE_EXTENSION(#38)
& node (Join-Path $root "scripts\check-node.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Prebuilt -and -not (Test-Path (Join-Path $root "desktop\dist\index.html"))) {
  throw "缺少打包好的页面(desktop\dist)。先在 desktop 目录运行 npm run build,或去掉 -Prebuilt。"
}
# 选端口(规则见 orchestrator\src\startup_ports.ts):全部写在 stdout,说明是 [start] 开头的行,成功时最后一行是 {"ui":..,"api":..}
$portArgs = @()
if ($Port) { $portArgs += @("--port", "$Port") }
if ($ApiPort) { $portArgs += @("--api-port", "$ApiPort") }
$chosen = @(& node (Join-Path $root "orchestrator\src\startup_ports.ts") @portArgs)
$portCode = $LASTEXITCODE
$chosen | Where-Object { "$_".StartsWith("[start]") } | ForEach-Object { Write-Host $_ }
if ($portCode -ne 0) { exit $portCode }
$last = if ($chosen.Count) { "$($chosen[-1])" } else { "" }
if (-not $last.StartsWith("{")) { throw "没拿到端口选择结果(orchestrator\src\startup_ports.ts 没有输出)。" }
$ports = $last | ConvertFrom-Json
$uiPortChosen = [int]$ports.ui
$apiPortChosen = [int]$ports.api
# 页面服务器(Vite)按这两个变量监听和转发 /api;就绪检查和 API 拼推送链接也用它们。
# 退出时还原:在自己的 PowerShell 窗口里直接运行本脚本时,不能把这次选的端口留给下一次(下一次会被当成「指定了端口」)
$prevUiPort = $env:VRA_UI_PORT
$prevApiPort = $env:VRA_API_PORT
$env:VRA_UI_PORT = "$uiPortChosen"
$env:VRA_API_PORT = "$apiPortChosen"
$uiUrl = "http://127.0.0.1:$uiPortChosen"
$api = $null
$ui = $null
function Stop-ProcessTree($Process) {
  if (-not $Process) { return }
  $rootId = [int]$Process.Id
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $descendants = [System.Collections.Generic.List[int]]::new()
  $pending.Enqueue($rootId)
  [void]$seen.Add($rootId)
  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    foreach ($child in $all) {
      $childId = [int]$child.ProcessId
      if ([int]$child.ParentProcessId -eq $parentId -and $seen.Add($childId)) {
        $descendants.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }
  # 父进程已退出时 taskkill /PID <parent> /T 找不到树根；
  # CIM 快照里的 ParentProcessId 仍能让我们定位遗留子孙。
  foreach ($targetId in @($descendants | Sort-Object -Descending)) {
    & taskkill.exe /PID $targetId /T /F *> $null
  }
  $Process.Refresh()
  if (-not $Process.HasExited) {
    & taskkill.exe /PID $rootId /T /F *> $null
  }
}
try {
  $api = Start-Process -FilePath node -ArgumentList @("orchestrator\src\api.ts", "--port", "$apiPortChosen", "--host", "127.0.0.1") -WorkingDirectory $root -PassThru -NoNewWindow
  # UI 由 Vite 按 VRA_LAN 决定绑定；默认回环，API 的回环绑定不变。打包好的页面由 vite preview 提供，同样只听回环。
  if ($Prebuilt) {
    $ui = Start-Process -FilePath node -ArgumentList @("node_modules\vite\bin\vite.js", "preview") -WorkingDirectory (Join-Path $root "desktop") -PassThru -NoNewWindow
  } else {
    $ui = Start-Process -FilePath npm.cmd -ArgumentList @("run", "dev", "--prefix", "desktop") -WorkingDirectory $root -PassThru -NoNewWindow
  }
  $ready = $false
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $readyDeadline) {
    $api.Refresh()
    $ui.Refresh()
    if ($api.HasExited) { throw "API 启动失败（退出码 $($api.ExitCode)），请检查 $apiPortChosen 端口和产品配置。" }
    if ($ui.HasExited) { throw "界面启动失败（退出码 $($ui.ExitCode)）。" }
    # 经界面代理验证后端鉴权；令牌仍只留在本地服务，不传到浏览器或命令参数。
    & node (Join-Path $root "orchestrator\src\startup_health.ts")
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "启动等待超过 60 秒。请检查上方日志、$apiPortChosen/$uiPortChosen 端口以及产品配置；浏览器尚未打开。" }
  $api.Refresh()
  $ui.Refresh()
  if ($api.HasExited) { throw "API 启动失败（退出码 $($api.ExitCode)），请检查 $apiPortChosen 端口和产品配置。" }
  if ($ui.HasExited) { throw "界面启动失败（退出码 $($ui.ExitCode)）。" }
  Write-Host "`nVibe Research 已启动:$uiUrl`n按 Ctrl+C 或关掉这个窗口即退出。"
  if (-not $NoOpen) { Start-Process $uiUrl }
  while (-not $api.HasExited -and -not $ui.HasExited) {
    Start-Sleep -Milliseconds 250
    $api.Refresh()
    $ui.Refresh()
  }
  if ($api.HasExited) { throw "API 已停止（退出码 $($api.ExitCode)），界面同步关闭。" }
  if ($ui.HasExited) { throw "界面已提前停止（退出码 $($ui.ExitCode)）。" }
} finally {
  Stop-ProcessTree $ui
  Stop-ProcessTree $api
  if ($null -eq $prevUiPort) { Remove-Item Env:VRA_UI_PORT -ErrorAction SilentlyContinue } else { $env:VRA_UI_PORT = $prevUiPort }
  if ($null -eq $prevApiPort) { Remove-Item Env:VRA_API_PORT -ErrorAction SilentlyContinue } else { $env:VRA_API_PORT = $prevApiPort }
}
