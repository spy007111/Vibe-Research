# 界面截图 / UI screenshots

拍摄日期 / Captured: 2026-10-10（周六，休市 / Saturday, market closed）。

开发版前端，由本地开发服务和产品自带的本地服务运行，数据目录是单独新建的演示目录；浏览器用全新的临时配置，视口 1440 × 1020，未接入 AI。拍首页前点了首次弹窗里的「暂不接入，先浏览」。没有注入假回复、修改页面文字或合成界面，拍摄时没有调用模型，也没有读取私人持仓、研报或账号凭据。图片不带任何元数据。

- **示例数据**：自选 5 只、持仓 3 笔期初流水、1 条论点和 2 条判据，是拍摄前通过产品自己的台账接口录入的，每条备注都写了「示例」，不是真实持仓。
- **研究报告**：用的是 2026-10-08 开发验证时用 Claude Code 订阅跑完的一份中际旭创六阶段报告，原样复制进演示目录，没有改动。
- **其余内容**（指数、复盘、K 线、资讯、GPU 租金、事件日历、候选池）都是拍摄时页面自己取到的公开数据快照。
- 候选池的条件（沪深300、市盈率 0–15 倍、市净率不超过 1.5 倍）只是为了演示核对过程，不是选股建议。

Development-build frontend, served by the local dev server and the product's own local server with a separate, newly created demo data directory. A fresh temporary browser profile, viewport 1440 × 1020, no AI connected. Before the home shots, the first-run dialog was closed with "暂不接入，先浏览" (browse without connecting). No fabricated replies, DOM text replacements, or composited UI; no model calls during capture and no access to private holdings, reports, or credentials. The images carry no metadata.

- **Demo data**: 5 watchlist entries, 3 opening-position transactions, 1 thesis, and 2 criteria were entered through the product's own ledger API before capture. Every note says "示例" (example); none of it is a real portfolio.
- **Research report**: a complete six-stage report on Zhongji Innolight (300308) produced on October 8, 2026 during development testing with a Claude Code subscription, copied into the demo directory unchanged.
- **Everything else** (indices, daily review, K-line, news, GPU rental rates, event calendar, candidate screen) is the public data the pages fetched at capture time.
- The candidate-screen conditions (CSI 300, P/E 0–15, P/B at most 1.5) only demonstrate the checking process; they are not a stock pick.

| 文件 / File | 场景 / View |
|---|---|
| [home-dark.png](home-dark.png) | 深色首页 / Dark home |
| [home-light.png](home-light.png) | 浅色首页 / Light home |
| [daily-review.png](daily-review.png) | 每日复盘 / Daily review |
| [stock-overview.png](stock-overview.png) | 个股深挖·概览 / Stock deep dive, overview |
| [research-report.png](research-report.png) | 六阶段研究报告 / Six-stage research report |
| [sectors.png](sectors.png) | 产业研究 / Industry research |
| [intel.png](intel.png) | 资讯雷达 / Intelligence radar |
| [signals.png](signals.png) | 产业信号 / Industry signals |
| [holdings.png](holdings.png) | 我的持仓（示例数据）/ Holdings (demo data) |
| [calendar.png](calendar.png) | 事件日历 / Event calendar |
| [candidates.png](candidates.png) | 候选池 / Candidate screen |
| [connect-ai.png](connect-ai.png) | 首次接入弹窗 / First connection dialog |

界面是 2026-10 的「静默数据台」样式：石墨底、橙色主色，每块数据一个方框。接入弹窗只展示选项，不代表任何账号已经通过连接测试。英文 README 沿用同一套中文产品界面截图，不暗示已提供英文 UI。

The look is the October 2026 "quiet data desk" style: graphite background, orange accent, one bordered box per block of data. The connection dialog only displays choices; it is not evidence that any account passed a connection test. The English README uses the same Chinese product UI screenshots and does not imply an English UI is available.
