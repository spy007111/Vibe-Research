# Vibe-Research — 给 Agent 的部署与开发指南

你是来帮使用者部署、使用或改造本仓库的 Agent(Claude Code、Codex、WorkBuddy / CodeBuddy、Muse 一类个人云端 Agent……)。动手前先读完这一页。

> 研究方法论不在这里。研究线程的最高纪律是 [`methodology/constitution.md`](methodology/constitution.md)(研究宪法),
> 研究 SOP 在 [`.agents/skills/`](.agents/skills/),计算函数契约在 [`calc/SPEC.md`](calc/SPEC.md)。产品在每个研究阶段把它们放进提示词,对所有大脑一视同仁;
> 它们约束的是研究线程里的大脑,不是你在本仓库里的工作方式。

## 1. 这是什么

本地运行的 A 股个股研究工作台:浏览器页面 + 本机服务 + 六阶段研究编排器 + Python 取数层 + 确定性计算库(`calc/`)。
研究的「大脑」可以换,换了以后受控工具、方法论、校验与合规 gate 都是同一套:

| 大脑 | 接法 | 登录与凭据 |
|------|------|------------|
| Claude Code | 本机 `claude` CLI | 使用者本人在终端用 claude.ai 订阅登录(API key / Bedrock / Vertex 登录不算订阅);产品不读、不存、不复制登录文件 |
| Codex | 本机 `codex` CLI | 使用者本人在终端 `codex login` 用 ChatGPT 账号登录(Codex 里配的 API key 登录不认);同上 |
| WorkBuddy / CodeBuddy | 本机 `codebuddy` CLI(独立 CLI 或 WorkBuddy 桌面版内置) | 使用者本人登录 WorkBuddy;同上 |
| 模型 API | 任意 Chat Completions 兼容接口(模板见 `providers/`) | 页面里填的 key 只存在浏览器 `localStorage`,随请求交给本机服务,不落盘;命令行研究从模板声明的环境变量读 key |

研究线程里的大脑**没有 Shell、没有网络、没有任意文件读写**,只有 5 个受控工具:列文件、读文件、确定性计算、写阶段产物、写报告。
取数由编排器在每个阶段开始前执行完;大脑想收工时,产品先做收工检查,产物缺失或校验不过就把问题清单交回去接着修。

## 2. 帮使用者部署

环境:Node.js ≥ 22.18、Python ≥ 3.11(推荐 3.12)、git。

```bash
git clone https://github.com/simonlin1212/Vibe-Research.git
cd Vibe-Research
scripts/setup     # Windows:scripts\setup-windows.cmd
scripts/start     # Windows:scripts\start.cmd
```

- `scripts/setup` 创建 `.venv`、安装依赖、生成产品私有层 `.local/` 并跑体检;`scripts/doctor` 可单独再跑(`--json` 给机器读)。
- `scripts/start` 同时拉起本机 API 与页面,健康检查通过后打开 `http://127.0.0.1:5930`。
  默认端口(页面 5930、API 8765)被占用或被系统保留时自动换空闲端口并在终端说明,以终端打印的地址为准;
  换了页面端口时,浏览器里存的模型 API 设置和对话记录按地址分开,要在新地址重新设置(终端会提醒;默认端口空出来后重启就回到原来的);
  要固定端口用 `--port` / `--api-port`(Windows `-Port` / `-ApiPort`)或环境变量 `VRA_UI_PORT` / `VRA_API_PORT`,指定的端口不能用时直接报错。
  启动时提示「已经有一个 Vibe Research 在运行」:让使用者直接打开那个地址,不要终止别的进程去抢端口。
- 页面打开后到左侧栏最下方的「接入 AI」选大脑并做一次真实对话测试,测试通过才会保存。
  本机 CLI 要先由使用者本人登录(`claude` / `codex login` / `codebuddy`);登录发生在使用者自己的终端和浏览器里,你不代填、不转存任何账号信息。
- Windows 上 WorkBuddy 装在别的盘也会从「已安装的程序」登记或正在运行的 WorkBuddy 里自动找到;
  仍显示「未安装」时:先打开 WorkBuddy 再点「重新检测」,或在「接入 AI」的 WorkBuddy 卡片里填它的安装文件夹,
  或在启动前设环境变量 `CODEBUDDY_BIN` / `CLAUDE_BIN` / `CODEX_BIN`(设了就只认它)。
- 所有私有数据(配置、运行产物、对话、台账、上传资料)都在 `.local/`,已被 git 忽略。不要把它提交、打包或发给任何第三方。
- 使用者不想装 Node / Python / git 时,让他到 Releases 下载免安装包(Windows x64 / Apple 芯片 / Intel Mac),解压后双击 `Start-VibeResearch`;
  数据在包文件夹的 `.local/`,升级 = 新版本解压到新文件夹再把 `.local/` 整个复制过去。包由 `.github/workflows/portable.yml` 构建
  (本机构建:`node scripts/portable/build.mts`;冒烟:`node scripts/portable/smoke.mts <解压出来的目录>`),
  包里 Node / Python 的版本、下载地址和 SHA256 只写在 `scripts/portable/runtimes.json`,升级运行时只改这一个文件。
- 页面每天查一次 GitHub 最新正式版本(只带版本号;没查成隔一小时再试);设环境变量 `VRA_UPDATE_CHECK=0` 完全不联网。

## 3. 在你自己的云端电脑上部署(Muse 一类个人云端 Agent)

最简单的做法:在你自己的云端电脑上装好,用**远程模式**启动,把打印出来的链接发给使用者。不需要连回使用者的电脑,也不需要 SSH。

```bash
git clone https://github.com/simonlin1212/Vibe-Research.git
cd Vibe-Research
scripts/setup
scripts/start --remote --no-open --public-url https://<平台给页面端口(默认 5930)分配的公网地址>
```

1. 远程模式先把页面打包(首次约半分钟),再在 5930 端口对外提供页面;本机 API(默认 8765,被占用时自动换)仍只听回环地址,不对外。
   页面端口在远程模式下不会自动换(云平台映射的是固定端口):5930 被占用就先停掉占用它的程序,或用 `--port <端口>` 换成平台开放的端口,`--public-url` 也对应那个端口。
2. 启动成功后终端打印「本机打开」和「发给使用者的链接」(`https://…/?access=<访问口令>`)两行。
   不知道公网地址就省掉 `--public-url`,按提示把平台给 5930 端口的 https 地址接上 `/?access=…`;
   知道的话尽量带上:有的平台代理不告诉后台用户走的是 https,带上它访问 cookie 才能确定加 Secure 标记。
3. 把「发给使用者的链接」交给使用者本人。第一次打开后,口令换成浏览器里的 HttpOnly cookie、地址栏里的口令被去掉;
   之后 30 天内直接打开公网地址即可,过期或换了浏览器再用一次完整链接。

- 启动器在前台常驻,Ctrl+C 关闭。要放后台跑,必须让它脱离当前终端会话:Linux 用
  `setsid scripts/start --remote --no-open … > vr.log 2>&1 < /dev/null &`;macOS 没有 `setsid`,可用
  `tmux new -d -s vr 'scripts/start --remote --no-open …'`(要先装 tmux,`tmux capture-pane -p -t vr` 看打印的链接),
  或用平台自带的服务管理。**不要用 `nohup`**:启动器自己处理挂断信号(收到就连同页面和 API 一起退出),
  `nohup` 拦不住,终端会话一结束服务就停。**日志里有访问口令**,别外传。
- **只用 https 公网地址。** 使用者会在页面里填自己的模型 API key,明文 http 会让 key 在网上裸奔;`--public-url` 是公网 http 时启动器会警告。
- 页面只能挂在根地址(`https://xxx/`),不支持挂在子路径(如 `https://xxx/proxy/5930/`)下。
- 访问口令存在 `.local/access.token`(权限 600),重启沿用同一条链接。换新链接、让旧链接失效:先停掉正在运行的服务
  (前台按 Ctrl+C;后台运行时给启动器进程发 SIGTERM,如 `pkill -TERM -f orchestrator/src/startup.ts`,它会一起关掉页面和 API),
  再运行 `scripts/start --remote --rotate-access`;新服务起来后,旧链接和旧 cookie 立即失效。
  平台要自己管口令时,设环境变量 `VRA_ACCESS_TOKEN`(至少 32 位,只含字母、数字、`-`、`_`)。
- 拿到链接的人能用这台云端电脑上的全部功能。链接只交给使用者本人;不要写进仓库、公开频道或分享截图。
- 远程模式下页面不能修改 WorkBuddy 的位置(需要时由你用环境变量 `CODEBUDDY_BIN` 指定后重启);页面里填的模型地址只收
  https 公网域名,不能是 IP 地址、localhost 或内网名字。这只按地址字面拦,解析到内网 IP 的公网域名拦不住 ——
  不要在能访问敏感内网服务的机器上开远程模式。
- 大脑优先用模型 API(使用者在页面里填自己的 key)。云端电脑上没有使用者本人的订阅登录,就不要选本机 CLI 大脑。
- 远程模式目前只支持 macOS / Linux。

## 4. 给你读的接口与架构文档

| 想知道 | 去读 |
|--------|------|
| 整体架构、编排器、命令行跑一次研究 | [`orchestrator/README.md`](orchestrator/README.md) |
| 让你自己的 Agent 直接调取数与研究(MCP 8 个工具、本机 HTTP API) | [`orchestrator/README.md`](orchestrator/README.md)「服务层与接口」 |
| 模型接入、provider 模板、兼容性测试 | [`docs/model-access.md`](docs/model-access.md)、[`providers/README.md`](providers/README.md) |
| 取数脚本、端点与数据源 | [`.agents/skills/data-access/SKILL.md`](.agents/skills/data-access/SKILL.md) |
| 确定性计算函数契约 | [`calc/SPEC.md`](calc/SPEC.md) |
| 研究运行的磁盘契约(manifest / evidence / calculations / report) | [`methodology/constitution.md`](methodology/constitution.md) §4 |
| 开发期验证 | [`docs/development-validation.md`](docs/development-validation.md) |

## 5. 改代码前

```bash
cd orchestrator && npm test && npm run typecheck
cd ../desktop && npm test && npm run build
cd .. && python -m pytest calc/tests backtest/tests .agents/skills/data-access/scripts/tests -q && python -m mypy
```

Python 用安装时建的虚拟环境；mypy 的安装与约定见 [`docs/development-validation.md`](docs/development-validation.md)。

- 新写的界面测试用 `desktop/test/helpers/render.ts` 把组件渲染出来，断言用户看得到的内容；不要再新增比对源码文字的断言（「绝不能出现」类规则除外）。写法见同一份文档。
- `orchestrator/src/` 里除 `src/finance/` 外是垂类无关的 Core:不许出现行业词(注释也算),纯净度测试会拦。
- 大脑只能通过受控工具做事:不要给研究线程加 Shell、网络或任意文件访问,也不要为某一种大脑单独开后门。
- 研究宪法和 SOP 改了,要连带检查 `calc/`、validator 与测试是否还对得上。

## 6. 维护约定(仓库主人定的规则)

### 6.1 对话、资料与回测

- 用户上传资料的原文件只由服务层在本机保存与解析;模型只收到服务端检索命中的正文片段。
  联网不改变资料范围:不得把无关私人资料或密钥发送给搜索服务,不以任意文件读取绕过资料检索边界。
- 使用用户资料的回答必须保留本轮真实引用,格式为 `[资料:<id> p.<页码>]`(非 PDF 可不写页码);
  漏引、错引或引用本轮未召回的资料必须拒绝,不能只靠提示词要求模型自觉引用。
- 对话取数写 `.local/mcp/`,网页留档写 `.local/chat-web/`;对话返回实际工具记录,不声称未执行的操作已完成。
- 回测页只有 Agent 对话入口,不恢复代码、日期、资金、策略参数等旧表单。Agent 先读服务端返回的真实工具目录;
  信息不足只补问,条件齐备才调用正式 `backtest` 工具;工具拒绝、缺参数或失败时不得伪装成完成;`action` 等受控入口不得由模型覆盖。
- 回测结论只能根据本轮真实工具返回生成,完整报告至少包含:回测问题、回测假设、回测逻辑、回测结果。
- 回测与多空辩论完成或部分完成后自动写入用户本地记录。多空辩论归档除各阶段正文、证据数和资料缺口外,
  必须保存每阶段数字复核摘要及全部算式错误明细;中止后重开不得让旧会话回调污染新会话。
- 用户报告正文上限按长报告设计,当前为 10 万字符;不得为通过存储校验而截断已完成报告。

### 6.2 模型接入与凭据

- 本机 CLI 大脑一律用使用者自己的登录;产品不读取、复制、软链或转存任何 CLI 的认证文件,也不代填账号密码。
- 订阅与 API 配置都必须先完成真实对话测试,成功才保存;失败不得覆盖当前已生效配置。
- 浏览器 API key 只保存在当前浏览器 `localStorage`,随请求交给本机后端;不得写入仓库、后端配置、运行账本、日志、文档或测试夹具。
- provider 模板存在不等于已接通;接入探针通过也不等于所有业务已验收 —— 只有在实际业务页面跑通的通道才能在对应范围标为已验证。
  未接入时允许浏览栏目,不自动跳转设置。
- 代码审计与发版前审计一律用 Opus 5,在干净上下文里做只读复审;先审一轮,具体发现修复后复验受影响范围。

### 6.3 官网与公开口径

- 产品官网为 `https://viberesearch.wiki`,源码只从当前活动仓库 `website/` 维护;不要写回旧 checkout。
- 本地工作台左下角显示品牌官网 `https://phoenixtree.ai/`(新标签页打开;折叠侧栏保留可访问图标),不扩展为其他推广入口。
- 对外定位:可接入多种 Agent 大脑的本地金融研究工作台。必须区分「大脑」(本机订阅 Agent 或模型 API)与产品本身,
  不能把产品说成一次 API 问答的包装。
- v1.2.0 起暂撤 Mac 原生客户端及打包链路,保留源码 + 本地浏览器 UI;M41 动态板块未采用,不得凭旧授权恢复客户端或 M41。
  旧客户端数据和登录态不删除、不自动迁移。
- 新建 Release、删除历史安装包或官网部署都需要仓库主人单独授权。官网版本号优先读取 GitHub latest release。
- 用户要求「打开给我看」时打开可见的浏览器页;无头浏览器只用于短时自动化验证,完成后关闭。

### 6.4 公开发布前隐私检查

- 每次公开 push / tag / Release 前同时扫描当前工作树、当前 HEAD 快照和完整 Git 历史,不能只扫未提交 diff。
- 扫描命中必须人工核实,不把测试假 key、固定公开查询参数或安全用例误报成真实凭据;未经核实不得直接放行。
- 产品登录态、API key、`.env`、私钥和本机账号文件必须保持 ignored + untracked,并确认完整历史从未出现;
  旧版本遗留的 `.local/codex-home/` 只能留在本机。
- 发布前同时检查 GitHub Issues / PR / Release 正文、Actions artifacts、截图文字与图片元数据,
  避免密钥、持仓、研报名、本机路径、账号或设备信息从非代码入口泄露。
- README / 官网公开的作者名、GitHub、X、联系邮箱和 Buy Me a Coffee 属有意公开身份;删当前页面不等于删历史。
  历史作者邮箱如需清除必须单独授权重写历史,不得顺手处理。
- GitHub Secret Scanning 与 Push Protection 应保持开启;若平台显示未启用,发布检查必须明确列为待办。

### 6.5 对外内容与社交资料

- 抖音正式封面统一 9:16、2160×3840;首屏层级固定为:最大字号产品名 `Vibe-Research` → 副标题 `个人投研 Agent` → Star 背书。
  旧封面与尝试版保留为版本化旁支,不直接覆盖。
- 仓库主人当前对外身份:独立开发者,使用 AI 构建开源市场数据工具与本地 Agent;主项目口径为 `a-stock-data`、`TradingAgents-astock`、`Vibe-Research`。
- Star 数属于实时数据:写 X、YouTube、封面、README 或官网前必须重新查询 GitHub;可以展示稳定的整数档(如 `2,200+ Stars`),
  不得把旧快照写成当前精确值。
- YouTube 频道说明覆盖真实开发过程、AI Agent、金融数据与开源产品;保留「不卖课,不收徒」的边界。
