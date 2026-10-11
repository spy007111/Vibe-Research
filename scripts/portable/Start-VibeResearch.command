#!/bin/sh
# 免安装包（macOS）：双击启动 Vibe Research。关掉这个终端窗口或按 Ctrl+C 即退出。
cd "$(dirname "$0")" || exit 1
if [ ! -f scripts/portable/start-portable.sh ]; then
  echo "[Vibe Research] 这个文件夹不完整：请先把整个压缩包解压，再双击解压出来的文件夹里的 Start-VibeResearch.command。按回车关闭。"
  read -r _ || true
  exit 1
fi
sh scripts/portable/start-portable.sh "$@"
code=$?
if [ "$code" -ne 0 ]; then
  echo ""
  echo "[Vibe Research] 没有正常启动（退出码 $code），上面是原因。按回车关闭。"
  read -r _ || true
fi
exit "$code"
