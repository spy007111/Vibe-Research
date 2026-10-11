# 免安装包（Windows）启动：用包里自带的 Node / Python，页面用打包好的那份；数据在这个文件夹的 .local 里。
# 包根目录的 Start-VibeResearch.cmd 双击后调用本脚本。源码版请用 scripts\setup-windows.cmd + scripts\start.cmd。
# -NoOpen:启动后不自动打开浏览器(冒烟测试用)
# -Port / -ApiPort:指定页面 / 本机 API 端口;不给就用默认,被占用时自动换(见 scripts\start.ps1)
param([switch]$NoOpen, [int]$Port = 0, [int]$ApiPort = 0)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nodeDir = Join-Path $root "runtime\node"
$python = Join-Path $root "runtime\python\python.exe"
if (-not (Test-Path (Join-Path $nodeDir "node.exe")) -or -not (Test-Path $python)) {
  throw "这个文件夹不是完整的免安装包（缺 runtime 里的 Node 或 Python）。源码版请先运行 scripts\setup-windows.cmd，再运行 scripts\start.cmd。"
}
$env:PATH = "$nodeDir;$env:PATH"
$env:VRA_PYTHON = $python
$env:PYTHONDONTWRITEBYTECODE = "1"
# 只用包里装好的依赖：不看用户目录的 site-packages，外面残留的 Python 路径变量也不沿用
$env:PYTHONNOUSERSITE = "1"
Remove-Item Env:PYTHONHOME, Env:PYTHONPATH, Env:PYTHONUSERBASE -ErrorAction SilentlyContinue
# 数据只放在这个文件夹的 .local 里（init / 体检都按这个布局）；外面残留的数据目录变量不沿用
Remove-Item Env:VRA_DATA_ROOT -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $root ".local\config.json"))) {
  Write-Host "[Vibe Research] 第一次在这个文件夹启动，新建空白数据目录 .local。"
  Write-Host "  用过旧版本、想带上原来的数据：先关掉这个窗口，把旧文件夹里的 .local 整个复制到这个文件夹，再双击启动。"
  # 初始化的「下一步」是写给源码版的（scripts\start.cmd、填 python），这里不显示；出错信息照常显示
  & node (Join-Path $root "orchestrator\src\init.ts") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "初始化数据目录失败（退出码 $LASTEXITCODE）" }
}
& (Join-Path $root "scripts\start.ps1") -Prebuilt -NoOpen:$NoOpen -Port $Port -ApiPort $ApiPort
exit $LASTEXITCODE
