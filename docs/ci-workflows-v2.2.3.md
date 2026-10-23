# v2.2.3 工作流说明

本版沿用以下工作流；这里说明执行方式，不代表本版 CI 已通过。结果以对应的 Actions 运行记录为准。

- [Cross-platform verification](../.github/workflows/cross-platform.yml)：push、PR 或手动触发，覆盖 Ubuntu、macOS、Windows × Node.js 22 / 24，共 6 个组合，Python 为 3.12。
- macOS / Ubuntu 跑完整编排器测试，Windows 跑选定的跨平台契约测试；各组合还跑前端测试、构建和 Python 测试。Python 类型检查在 Node.js 24 的组合中执行。
- [Portable packages](../.github/workflows/portable.yml)：手动或 `v*` tag 触发，分别构建 `win-x64`、`mac-arm64`、`mac-x64`，依赖在对应平台安装。
- 每个包先解压到新目录，再做不依赖系统 Node.js / Python 的冒烟检查；通过后上传 ZIP 与对应的 `.zip.sha256` 文件为构建产物。
- 运行引用为 `v*` tag 时，三个目标全部构建与冒烟通过后，将 ZIP 和校验文件附加到同名 GitHub Release；其他引用只产生构建产物。
- 上传资产前必须已有同名 Release；工作流不会替代人工创建 Release，找不到时会报错，需要创建后重跑上传步骤。
