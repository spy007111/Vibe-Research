# docs

- v2.1.0(2026-10)起不再内置 Codex Harness（这次改动原定 v2.0.0，没有单独发布）：AI 来源改为本机已登录的订阅 CLI(Claude Code / Codex / WorkBuddy)与模型 API。
  带日期的里程碑文档里涉及 Codex 引擎、产品专用 Codex 登录、hooks 与 Responses 通道的内容都是 v1 历史。
- [source-delivery.md](source-delivery.md) — v1.2.0 源码交付：基于公开 v1.1.0 暂撤 Mac 客户端，保留源码与浏览器工作台。
- [issue-pr-triage-v1.2.0.md](issue-pr-triage-v1.2.0.md) — 2 个 Issue、6 个 PR 的处理范围、采纳与暂缓理由。
- 带日期的里程碑文档是历史记录，尤其 M32–M40 的客户端和安装验收不再代表当前交付范围；旧工具见公开 v1.1.0 标签。
- [AI接入与执行模式_v1_2026-09-04.md](AI接入与执行模式_v1_2026-09-04.md) — 历史方案；2026-10-09 起取消 Agent 开关，页面一律允许 AI 联网和调用工具，以 README 为准。
- [双引擎任务架构_v3_2026-09-04.md](双引擎任务架构_v3_2026-09-04.md) — 内部任务分层与历史实施记录：deterministic / quick / deep；不再代表用户要手动选择三种模式。
- [release-checklist.md](release-checklist.md) — 发布前清单:只能由维护者拍板 / 提供的事项(License、仓库地址、国产模型矩阵真测、模板易变字段核实)与发布时序(审计在 push 之前)。
- [model-access.md](model-access.md) — 模型接入指南：三家本机订阅 / 模型 API、执行方式、已实测与未实测、10 项兼容矩阵、远程访问和 provider 扩展。
- [development-validation.md](development-validation.md) — 开发验证：零模型回归与用本机订阅 / 模型 API 的真实联调。
- 编排器细节(状态机 / validator / 收工检查 / 大脑与受控工具 / 配置 / MCP / HTTP API / 批量 / 提醒 / 矩阵):[../orchestrator/README.md](../orchestrator/README.md)
- 数据源端点目录(自动生成):[../datasources/CATALOG.md](../datasources/CATALOG.md)
- 计算库契约:[../calc/SPEC.md](../calc/SPEC.md)
- provider 模板字段与约束:[../providers/README.md](../providers/README.md)
