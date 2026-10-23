# 模型接入指南(v2)

本文讲清:选哪种 AI 来源、Agent 开关是什么、三家本机订阅怎么接、模型 API 怎么接与怎么验证、怎么加一家新的 provider。

后端默认来源的 key 只放环境变量;浏览器里由用户填写的 key 会持久保存在当前浏览器的本机 `localStorage`,以免每次重填。`localStorage` 按地址分开:默认端口被占、启动器换了页面端口时,新地址里看不到原来的设置,要重新填一次;默认端口空出来后重启就回到原来的地址和设置。
它不是系统钥匙串,也不承诺加密,只建议在可信个人电脑使用;共享电脑用完应主动清除。
调用时 key 随本轮请求交给本机后端,但不会写入产品配置、日志、事件账本或研究产物。

> v2.0 起产品不再内置 Codex Harness,也不再有产品专用的 Codex 登录(`.local/codex-home`)。
> 三家订阅都直接用你自己在本机装好、登录好的 CLI;模型 API 一律走 Chat Completions。v1 的接入记录见文末「v1 历史记录」。

## 1. 选 AI 来源

| 来源 | 适用 | 怎么接 | 说明 |
|---|---|---|---|
| Codex 订阅 | ChatGPT 订阅用户 | 安装 Codex CLI,终端运行 `codex login` 用 ChatGPT 账号登录 → 「接入 AI」测试并保存 | 用你自己的 Codex 登录(`CODEX_HOME`,缺省 `~/.codex`);产品只问「是否用 ChatGPT 登录」,不读 `auth.json`;用 API key 登录的 Codex 不算订阅 |
| Claude 订阅 | claude.ai 订阅用户 | 安装 Claude Code,运行 `claude` 完成 `/login` → 测试并保存 | 只认 claude.ai 订阅登录(API key / Bedrock / Vertex 不算);外壳里的 API key 环境变量不会带进 CLI,避免计费方被悄悄换掉 |
| WorkBuddy / CodeBuddy | WorkBuddy 桌面版或 CodeBuddy Code CLI 用户 | 桌面版已登录则直接识别;独立 CLI 运行 `codebuddy` 登录 → 测试并保存 | Windows 装在别的盘会从「已安装的程序」登记或运行中的 WorkBuddy 自动找到;仍找不到时在 WorkBuddy 卡片里填安装文件夹,或设环境变量 `CODEBUDDY_BIN` |
| 模型 API | 任意 OpenAI 兼容 Chat Completions 服务(DeepSeek / 通义千问 / 智谱 GLM / Kimi / MiMo / OpenAI / 自托管…) | 浏览器「接入 AI」→「API 接入」填写;命令行用 `export <ENV_KEY>=...` + `--provider <id>` | 浏览器 key 存在本机浏览器配置,调用时才发给本机后端;命令行 / 后台默认从模板声明的环境变量读 key |

- 每种来源保存前都要先做一次真实对话测试;失败不覆盖当前已生效配置。
- 选了哪个就用哪个:前置条件不满足(没装、没登录、缺 key)一律报错,不会悄悄换成别家。
- 产品不读、不复制、不软链任何 CLI 的认证文件,也不代填账号密码;登录发生在使用者自己的终端和浏览器里。
- Qwen Code 的旧免费 OAuth 已停止、DeepSeek CLI 也用 API key,所以二者不列为「免 key 订阅」,请走模型 API。

### 执行方式

2026-10-09 起取消「开启Agent」开关和普通对话:页面发出的请求一律是 agent,AI 按问题需要联网、取数和计算。
旧版本浏览器里存下的开关状态读取时忽略、不改写。

| 执行方式 | 能做什么 | 怎么跑 |
|---|---|---|
| agent(页面一律用它) | 本地上下文、联网查证、取数、计算、资料转写、多空辩论、Agent 回测与六阶段研究 | 订阅:各自的本机 CLI,只开放产品受控工具(MCP);模型 API:产品在本机跑工具循环(function calling),所以端点要支持工具调用 |
| direct(只给接口调用方) | 单轮对话与标题翻译;模型 API 另支持直连材料定位 | 不调用工具、不保留任务记忆;接口请求显式传 `executionMode: "direct"` 才会用;页面只在没接 AI 时用它跑确定性工具 |

接口调用方传 direct 时,研究、辩论、Agent 回测与资料转写直接报 `agent_required`,不会静默降级。
六阶段研究每个阶段使用一次独立会话:订阅 CLI 关闭全部内建工具,只开放本次运行目录内的 5 个受控工具;
运行清单(`manifest.json` 的 `engine.capabilities`)如实记录所用大脑与执行保障等级。

## 2. 三家本机订阅

设置页的订阅卡片不是静态开关:后端实时检测 CLI 是否安装、版本与登录状态,只向页面返回这几项结论,账号、token 与 CLI 原始输出不进入浏览器、日志或配置。
在终端装好或登录后,回到「接入 AI」点「重新检测」即可,不用重启。

### Codex 订阅

1. 安装 OpenAI 官方 Codex CLI:`npm install -g @openai/codex`。
2. 在终端运行 `codex login`,由用户本人在 OpenAI 官方页面用 ChatGPT 账号完成登录。
3. 回到「接入 AI」,在 Codex 卡片点「测试并保存」。只有真实对话测试成功后,订阅配置才会保存。

- 产品用的是你自己的 Codex 登录,`CODEX_HOME` 环境变量照常生效;运行时加 `--ignore-user-config` 与 `--ephemeral`,不读你的 `config.toml`、不保存会话(登录凭据到期时由 Codex 自己续期,这是它的正常行为)。
  你写在 `$CODEX_HOME/AGENTS.md` 里的全局指令 Codex 仍会读入(没有参数能关);产品指令放在优先级更高的 developer 指令里下发,但全局指令里的称呼、语气等设定仍可能生效(受控工具与校验由产品代码执行,不受影响)。
- Codex 当前用 API key 登录时,卡片会提示「这张卡片只走 ChatGPT 订阅」—— 运行 `codex login` 改用 ChatGPT 登录即可。每次调用前都会重新确认登录方式。
- v1 的产品专用 `.local/codex-home` 不再使用:留着不影响,要清理可自行删除(里面是旧的登录文件,别提交、别外传)。

### Claude 订阅

1. 安装 Claude Code 并运行 `claude`,完成 `/login`(claude.ai 订阅)。
2. 回到「接入 AI」,在 Claude 卡片点「测试并保存」。不需要把 Claude 的 key 填进产品。

- 每次调用前都会重新确认 Claude Code 带着受限运行所需的参数、当前是 claude.ai 订阅登录;中途换成 API key / Bedrock / Vertex 登录时直接报错,不会按 API 计费跑下去。

### WorkBuddy / CodeBuddy

1. 已安装并登录 WorkBuddy 桌面版:直接选 WorkBuddy / CodeBuddy,产品会发现应用内置的官方 CodeBuddy Code CLI。
2. 没有桌面版:运行 `npm install -g @tencent-ai/codebuddy-code`,再运行 `codebuddy` 完成登录。
3. 显示「可用」后点「测试并保存」。

- Windows 上自动检测依次看:常见安装目录 → 「已安装的程序」登记(卸载信息里的安装目录、图标、卸载程序)→ 正在运行的 WorkBuddy.exe;
  只读这两类系统信息、不改任何东西;登记里没有又没开着 WorkBuddy 时找不到,先打开 WorkBuddy 再点「重新检测」。
- 页面显示「未安装」但其实装了(装在非默认位置):在 WorkBuddy 卡片里填它的安装文件夹,保存在 `<数据根>/local-agents.json`,
  页面、对话与研究子进程共用;也可以在启动前设环境变量 `CODEBUDDY_BIN`(设了就只认它,页面不能改)。
  Claude Code 与 Codex 同理可用 `CLAUDE_BIN` / `CODEX_BIN`。
- 桌面版内置的旧 CLI 若没有「禁止会话落盘」参数,整次回答改在一次性临时用户目录运行,所需的订阅凭据只在进程内转交,结束后随临时目录删除。
- 新版初始化响应可以不带 token；产品检查新版账号结构后，让 CLI 自己使用本机登录，不要求它向产品交出 token。缺少会话隔离参数的旧版仍须具备原来的一次性目录执行条件，否则提示升级。
- WorkBuddy 桌面版内置 CLI 2.161.0 只带精简运行包。产品在检测与执行时明确设置 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`，避免过滤环境后启动器找不到默认运行包；其余环境变量仍按白名单过滤。独立 CLI 缺少精简运行包时由官方启动器回退到其自带运行包。

## 3. 模型 API

### 在页面里接

「接入 AI」→「API 接入」:选厂商、填 key(需要时改 Base URL 和模型名),点「测试并保存」。
页面先通过本机后端向所选服务发起一次真实对话,成功才保存并供全站使用;界面会标出这一家是否已用真实 key 实测。
没有模板的服务选「其它 OpenAI 兼容端点」直接填 Base URL、key 和模型名(始终按「未实测」处理)。

- 端点要支持 Chat Completions 和工具调用(function calling);只支持纯对话的端点接口 direct 模式能用,页面上的对话会失败。
- API 地址接受 HTTPS;HTTP 只允许字面主机 `localhost`、`127.0.0.1` 或 `[::1]`(可带端口和路径,如 `http://127.0.0.1:11434/v1`)。
  不允许远程 / 局域网明文 HTTP、URL 内嵌账号密码、查询参数或片段 —— 凭据请填到 API key。

### 命令行与后台默认

```bash
# 1) 密钥只放环境变量(变量名见模板 env_key;此处以 DeepSeek 为例)
export DEEPSEEK_API_KEY=...
# 2) 先跑兼容矩阵(结果在 .local/provider-matrix/deepseek/<时间>/summary.md,不含密钥)
node orchestrator/src/finance/provider_matrix.ts --provider deepseek
# 3) 用于研究(--model 可省,省略时用模板默认模型)
node orchestrator/src/run.ts --symbol 300308 --market SZ --provider deepseek --python "$(pwd)/.venv/bin/python" < /dev/null
```

不想每次传 `--provider`,就设后台默认:`<数据根>/config.json`(默认 `.local/config.json`)写

```json
{ "provider": { "profile": "deepseek" }, "defaults": { "model": "deepseek-flash" } }
```

或设环境变量 `VRA_PROVIDER=deepseek`;还没有这份配置时也可以运行 `scripts/init --provider deepseek` 生成
(已有配置时 init 不改它,会提示 `--provider` 未生效;加 `--force` 会先备份,再把整份配置重写成骨架)。本机订阅也可以当后台默认:`cli-claude` / `cli-codex` / `cli-codebuddy`。
优先级(低 → 高):产品配置 ← `<数据根>/config.json` ← 环境变量 `VRA_PROVIDER` ← CLI `--provider`。

**页面不读后台默认**:页面每次请求都自带使用者在「接入 AI」里选的来源;后台默认只给命令行研究、批量运行和直接调用本机接口(MCP)的 Agent 用。

### 「已实测」与「未实测」

模板里的 `direct` 段是产品用真实 key 实测的记录(段名是 v1 留下的历史名):

- 没有 `direct` 段 = 没实测:照样能用,结构化要求写进提示词,产物仍由产品自己的校验把关;界面与运行记录(`manifest.provider.matrix_status = "untested"`)如实标「未实测」。
- `direct.supported: true` = 实测可用;`structured_output: "server_schema"` 时请求带 `response_format`(JSON Schema 约束),`"prompt"` 时写进提示词。
- `direct.supported: false` = 实测不可用,产品拒绝接入(这和「没测过」是两回事)。

⚠️ 截至 2026-10-07,产品自带的模板**全部是「未实测」**:地址和模型名当天按各家官方文档核对过,但还没有用真实 key 跑过研究全流程。用之前先跑一遍兼容矩阵。

🔴 结构化输出写进提示词不算放松要求:**服务端 schema 从来就不是校验边界**。产物合不合规由产品自己校验(阶段过 validator、导入草稿过解析器);
写进提示词损失的只是命中率(模型更容易写歪、重试次数上升),写歪了照样过不了产品这关。

内置模板、默认模型与每家的已知限制见 [providers/README.md](../providers/README.md)。

## 4. 兼容矩阵怎么读

`provider_matrix.ts` 对模板指向的 Chat Completions 端点真跑 10 个小回合,机器判定 pass / partial / fail / error。
工具都是本地假工具,不联网、不加载产品宪法(只测协议兼容,不测研究纪律)。

| # | 项目 | pass 的判据 | 非 pass 的含义 |
|---|---|---|---|
| ① | 单次文本 | 回复含约定 token | 基本对话不通 |
| ② | 单工具调用 | 发起 `echo_text` 调用(参数是合法 JSON),最终回复含工具输出 | 不会调用工具 |
| ③ | 连续三轮工具调用 | `next_code` 三次调用依次用上一次的码 | 拿不到终码 = 不会多步工具调用 |
| ④ | 并行工具调用 | 一条回复里同时发起 ≥2 个调用 | partial = 都调了但分在多条回复里(产品本来就逐个执行,不影响使用) |
| ⑤ | 工具失败自修复 | 先有一次返回错误的调用、再有一次成功调用,最终回复带出成功结果 | 不会从工具错误中恢复 |
| ⑥ | 长输出 | 1–200 编号一个不缺且 `finish_reason=stop` | 输出被截断 |
| ⑦ | 工具后分轮收尾 | 先用工具取值,再发一轮不带工具的请求让它只输出 JSON,值正确 | 研究阶段的固定节奏走不通 |
| ⑧ | 服务端 schema | `response_format`(json_schema)下回复是合法 JSON 且字段齐 | 建议 `structured_output: "prompt"` |
| ⑨ | 多轮上下文延续 | 第二轮能复述第一轮的约定词 | 会话不连续 |
| ⑩ | 图片输入 | data URL 小图能说出颜色 | 端点拒绝图片:只影响资料导入的图片 / 截图,不影响研究与对话 |

结果写 `.local/provider-matrix/<id>/<时间>/results.json` + `summary.md`,落盘前做两层脱敏(key 精确替换 + 通用 token / 签名 URL)。
矩阵给出 `direct` 段的建议值,**不会自动改模板**:确认后写进 `<数据根>/providers/<id>.json` 覆盖模板,或由维护者回填产品模板。
判定口径与逐项正反单测见 `orchestrator/src/finance/provider_matrix.ts` 头注释与 `judge()`。

## 5. 自托管模型、局域网与远程访问

模型运行在哪里决定 API 地址;从哪台设备看工作台决定页面监听地址。两件事不要混为一谈。

### 自托管模型

普通用户在「接入 AI」选「其它 OpenAI 兼容端点」(或「自托管」),填写实际地址、模型名和 key 即可。
后端机器上的模型可用 `http://127.0.0.1:11434/v1`;远程模型使用 HTTPS。从手机访问时,模型地址中的 `127.0.0.1` 指后端所在电脑,不是手机。

需要 provider 模板时,复制 `providers/selfhosted.json` 到 `<数据根>/providers/selfhosted.json`,替换 `base_url` 并填写 `default_model`;
密钥仅经 `SELFHOSTED_API_KEY` 环境变量提供。模型必须支持 Chat Completions 和 function calling。
产品没有用任何具体推理框架版本跑过这份模板。

### 局域网工作台

默认只绑定 `127.0.0.1:5930`(端口被占时启动器自动换一个并在终端说明,以打印的地址为准)。从仓库根运行 `VRA_LAN=1 bash scripts/start` 才将页面绑定所有网卡;
Windows PowerShell 使用 `$env:VRA_LAN="1"` 后运行 `scripts/start.ps1`。后端继续只绑定回环地址(默认 `127.0.0.1:8765`);
代理先拒绝异源 / 不合法来源,再将合法请求归一化为回环来源。默认端口被占用时换端口会在终端说明,不会静默漂移;用 `--port` / `VRA_UI_PORT` 指定的端口被占用时明确失败。

这不是多用户产品:局域网模式没有登录保护,可达该端口的人可以使用工作台、读取或修改本地资料;
HTTP 上浏览器到后端这一跳不加密,输入的 API key 与资料有被窃听的风险。仅在受信任局域网主动开启,不对公网映射端口。

### 远程访问(部署在云端电脑上)

在你自己的云端电脑上用 `scripts/start --remote` 启动:页面带访问口令门(分享链接换 HttpOnly cookie)与来源校验,本机 API 仍只听回环。
**只用 https 公网地址**,否则使用者在页面里填的 API key 会明文传输。远程模式目前只支持 macOS / Linux。完整步骤见 [AGENTS.md §3](../AGENTS.md)。

## 6. 加一家新的 provider

1. 复制一份产品模板到 `<数据根>/providers/<id>.json`(默认 `.local/providers/`,同结构、优先级高于产品模板);`id` 小写字母开头,只含 `a-z0-9_-`,且与文件名一致。
2. 填 `name`、`base_url`(Chat Completions 根地址,请求发往 `{base_url}/chat/completions`)、`env_key`(大写变量名,不得借用 `PATH` / `HOME` 等系统变量名)、`default_model`;
   可选 `context_limit_tokens` / `known_incompatibilities` / `verified_at` / `notes`。字段与硬约束见 [providers/README.md](../providers/README.md)。
3. `export <env_key>=...` 后跑兼容矩阵,按结果写 `direct` 段(`supported` / `structured_output` / `verified_at`)。

v1 的旧引擎字段(`wire_api`、`auth_modes`、`responses_support`、`http_headers` 等)在旧覆盖模板里仍能加载,但一律不用。

## 7. 常见问题

- **报「后台默认 AI 来源 deepseek 需要环境变量 DEEPSEEK_API_KEY」**:密钥只从环境变量读,先 `export`。
- **报「还没有选择 AI 来源」**:命令行研究 / 批量运行 / MCP 的 `start_research` 用后台默认;用 `--provider` 指定,或按第 3 节设后台默认。
- **Codex 卡片提示「当前用 API key 登录」**:这张卡片只走 ChatGPT 订阅。在终端运行 `codex login` 改用 ChatGPT 登录,再点「重新检测」。
- **Claude 卡片显示未登录,但 `claude` 在终端能用**:多半是 API key / Bedrock / Vertex 登录,不算 claude.ai 订阅。要用订阅请在 `claude` 里 `/login`;要用 API key 请走模型 API。
- **WorkBuddy 显示未安装**:见第 2 节,在卡片里填位置或设 `CODEBUDDY_BIN`。
- **报「--codex-home 已在 v2.0 移除」等**:v1 的参数一律报错并说明改法;用 `--provider` 选大脑。
- **体检报「v1 旧配置残留」**:`.local/config.json` 里有 v1 字段(`engine.*`、`provider.auth` 等),v2 已不用,删掉即可(或 `scripts/init --force` 重写骨架,会先备份)。
- **OpenAI 换成 gpt-5.5 / gpt-5.6 或 GPT-6 后开 Agent 调不了工具**:从 GPT-5.4 起 Chat Completions 只在推理强度 none 时能调工具(模板默认的 gpt-5.4 默认就是 none);要用推理模型请改选「Codex 订阅」。
- **矩阵 ④ partial**:端点把同一回合的多个工具调用分在多条回复里,功能可用。
- **矩阵 ⑩ fail**:端点不接受图片,只影响资料导入的图片与截图。
- **报「端点地址里有占位符」**:模板的 base_url 里还留着 `{...}` / `<...>`;在 Base URL 里填上你自己的值,或写进覆盖模板。

## 8. v1 历史记录

v1(≤ v1.2.0)用内置的 Codex Harness 跑 Agent:Codex 订阅走产品专用的 `.local/codex-home` 登录,API 来源要么提供 Responses API 端点、
要么在中间架网关;普通对话的直连只对单独验证过的 provider 开放。以下记录都是 v1 线路下的结果,**不沿用到 v2**:

- 2026-08-22 OpenAI 订阅基线、2026-08-26 MiMo `mimo-v2.5` 矩阵、2026-08-28 从零接入实测(Codex 产品专用登录与 MiMo API 各完成一份每日复盘);
- 2026-09-05 真实六阶段运行与业务验收:[M8 / M12](跨来源业务验收_M12_2026-09-05.md)、[M14](完整版本机验收_M14_2026-09-05.md)、
  [深度研究取消](深度研究取消验收_2026-09-05.md)、[运行隔离与辩论中止](运行隔离与辩论中止验收_2026-09-05.md)。

v2 的实测记录写进各模板的 `direct` 段与 [CHANGELOG](../CHANGELOG.md)。
