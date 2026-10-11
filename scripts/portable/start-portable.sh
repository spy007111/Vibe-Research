#!/bin/sh
# 免安装包（macOS）启动：用包里自带的 Node / Python，页面用打包好的那份；数据在这个文件夹的 .local 里。
# 包根目录的 Start-VibeResearch.command 双击后调用本脚本。源码版请用 scripts/setup + scripts/start。
set -eu
# 依赖里有只支持 macOS 14 以上的二进制（这个数同 build.mts 的 MIN_MACOS）；旧系统上会在加载时才崩，先说清楚
MIN_MACOS=14
mac_ver="$(sw_vers -productVersion 2>/dev/null || true)"
mac_major="${mac_ver%%.*}"
case "$mac_major" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$mac_major" -lt "$MIN_MACOS" ]; then
      echo "[Vibe Research] 免安装包需要 macOS $MIN_MACOS 或更新版本，这台电脑是 macOS $mac_ver。" >&2
      echo "  请升级系统，或按 README 的源码安装方式使用。" >&2
      exit 1
    fi
    ;;
esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$ROOT/runtime/node/bin"
PY="$ROOT/runtime/python/bin/python3"
if [ ! -x "$NODE_BIN/node" ] || [ ! -x "$PY" ]; then
  echo "[Vibe Research] 这个文件夹不是完整的免安装包（缺 runtime 里的 Node 或 Python）。" >&2
  echo "  源码版请先运行 scripts/setup，再运行 scripts/start。" >&2
  exit 1
fi
PATH="$NODE_BIN:$PATH"
VRA_PYTHON="$PY"
PYTHONDONTWRITEBYTECODE=1
# 只用包里装好的依赖：不看用户目录的 site-packages，外面残留的 Python 路径变量也不沿用
PYTHONNOUSERSITE=1
export PATH VRA_PYTHON PYTHONDONTWRITEBYTECODE PYTHONNOUSERSITE
unset PYTHONHOME PYTHONPATH PYTHONUSERBASE
# 数据只放在这个文件夹的 .local 里（init / 体检都按这个布局）；外面残留的数据目录变量不沿用
unset VRA_DATA_ROOT
if [ ! -f "$ROOT/.local/config.json" ]; then
  echo "[Vibe Research] 第一次在这个文件夹启动，新建空白数据目录 .local。"
  echo "  用过旧版本、想带上原来的数据：先按 Ctrl+C 关掉，把旧文件夹里的 .local 整个复制到这个文件夹，再双击启动。"
  # 初始化的「下一步」是写给源码版的（scripts/start、填 python），这里不显示；出错信息照常显示
  node "$ROOT/orchestrator/src/init.ts" >/dev/null
fi
exec sh "$ROOT/scripts/start" --prebuilt "$@"
