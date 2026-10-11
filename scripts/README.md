# scripts

- `scripts/init`(→ `orchestrator/src/init.ts`):幂等初始化,只生成产品自己的 `.local/` 私有层(目录 / `config.json` 骨架 / `.gitignore` 含 `.local/`),**不碰任何 Agent CLI 的用户目录与登录**;已有配置不改,`--force` 才改(先备份)。选项:`--python P` `--provider <id>`(`cli-claude` / `cli-codex` / `cli-codebuddy` 或 `providers/` 里的模板 id)`--force` `--json`。
- `scripts/doctor`(→ `orchestrator/src/doctor.ts`):体检——Node 版本 / 产品配置链 / v1 旧配置残留 / 本机订阅 Agent(Claude Code / Codex / WorkBuddy 是否安装并已登录)/ 后台默认 AI 来源 / 研究宪法 / 研究技能 / Python 与取数依赖 / calc 自检 / 注册表 / 数据根写权限 / `.gitignore` / 密钥扫描 / `api.token` 权限 / `--net` 数据源连通;每项 ok · warn · fail · skip + 中文修复提示;报告写 `.local/doctor/<时间>.json`(路径相对化、脱敏);`--net` 会把那次取数写到 `.local/mcp/doctor/`;退出码 0 全 ok / 2 只有 warn / 3 有 fail。选项:`--net` `--json` `--python P`。
- `scripts/setup`:macOS / Linux 一键安装。创建 `.venv`、安装两端依赖、初始化产品私有层并运行体检；`--skip-doctor` 可跳过最后一步。
- `scripts/start`:macOS / Linux 一键启动。本机端口与安装状态预检通过后，同时管理 API 和浏览器界面，真实健康检查通过才打开 `http://127.0.0.1:5930`；`--no-open` 不自动打开浏览器，Ctrl+C 同时关闭两端。
  - `--remote`:远程访问模式，给云端 Agent 部署在自己的云电脑上、再把链接发给使用者用(见 [AGENTS.md](../AGENTS.md) §3)。先 `vite build`，再由 `vite preview` 在 `0.0.0.0:5930` 对外;**每个请求**(页面、静态资源、`/api`)都要先过访问口令(`desktop/remote-access.ts`)，本机 API 仍只听 `127.0.0.1:8765`。口令来自环境变量 `VRA_ACCESS_TOKEN`，否则用 `.local/access.token`(首次生成、权限 600、重启沿用)。
  - `--public-url <地址>`:云平台给 5930 端口分配的公网**根地址**，用来直接拼出发给使用者的链接;只收 http(s)、不能带子路径，公网 http 会警告。
  - `--rotate-access`:换一条新的访问链接(要先停掉正在运行的服务;新服务起来后旧链接立即失效;口令来自环境变量时拒绝，请改变量的值)。
  - 远程模式目前只支持 macOS / Linux。

两者都是非验收型辅助工具,不改变研究运行的状态机。

开发期回归与真实模型联调见 [开发验证说明](../docs/development-validation.md)：
先跑零模型测试，再用真实大脑验证主流程；不修改使用者的默认接入。

## Windows

- `scripts\\setup-windows.cmd`:创建 `.venv`、安装 Python/Node 依赖、初始化并运行体检。
- `scripts\\start.cmd`:同时启动本机 API 与浏览器 UI；任一进程异常退出会立即报错，按 Ctrl+C 或 UI 进程退出时会用 `taskkill /T` 收掉两棵子进程树。
- `scripts\\init.ps1` / `scripts\\doctor.ps1`:PowerShell 版的同名入口，不依赖 WSL、Git Bash 或 `/bin/sh`。
- `api.token` 会断开 NTFS ACL 继承，只授权当前 Windows 用户 SID；doctor 会读取真实 ACL，不用 Unix mode 假判。
