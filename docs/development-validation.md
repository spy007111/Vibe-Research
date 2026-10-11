# 开发验证：先跑通产品，再集中跨来源验收

2026-10-07(v2.0)开发约定：日常真实 Agent 联调用开发者本机已经登录好的订阅 CLI
(Claude Code / Codex / WorkBuddy 任选其一)；订阅 Agent 的模型由各自 CLI 决定，产品不传模型参数。
用模型 API 联调时用 `--model` 写明实际模型名，并在运行记录里注明。
这只决定开发测试用哪个来源，不修改产品默认值、不替用户选择来源。

## 三层验证

1. 每批修改先跑不调用真实模型的回归：前后端单测、Python 测试、类型检查与构建。
   这些测试中的订阅 CLI 与模型接口都使用可控替身，不消耗真实订阅或 API 额度。
2. 涉及 Agent 主流程时，在独立数据根做真实联调：先单阶段，再核心数据范围六阶段。
   `core` 缩小的是取数端点范围，不是删掉研究阶段，也不代表全端点验收。
3. 功能稳定后集中执行全数据范围、三家本机订阅、模型 API(先跑兼容矩阵)以及 Windows 验收。
   开发期仍保留各来源的自动契约测试和独立代码审查；已发现的超时等缺陷不得因延期而关闭。

## 零模型回归

在仓库根执行（先按安装说明准备依赖，Python 使用该安装的虚拟环境）：

```sh
npm test --prefix desktop
node --test --test-concurrency=1 orchestrator/test/*.test.ts
python -m pytest calc/tests backtest/tests .agents/skills/data-access/scripts/tests -q
python -m mypy
npm run typecheck --prefix orchestrator
npm run build --prefix desktop
```

逐项检查退出码，不能把最后一项成功当作前面全部成功。平台跳过项、构建警告单独记载。

`python -m mypy` 是 Python 类型检查，配置在仓库根目录 `mypy.ini`。mypy 不随产品安装，开发机装一次：
`python -m pip install mypy==2.4.0`（与 CI 同版本）。

- 报错先修代码或把标注写准；不加 `# type: ignore` 了事。确属检查器看不懂的写法，就改成它看得懂的写法。
- `sources/astock_ported.py` 由 `datasources/port_astock.py` 从上游生成，不在检查范围内；它的问题回上游修。
- 突然冒出一批 numpy / pandas 相关的新报错，多半是依赖升级换了类型标注，先对比依赖版本再改代码。

### 界面测试测行为，不比对源码文字

新写或改到的界面测试，把组件真正渲染出来，再断言用户看得到什么。公共件在 `desktop/test/helpers/render.ts`，范例见 `desktop/test/backtest_charts.test.ts` 最后一条：

```ts
await withRenderer(async (r) => {
  const { BacktestCharts } = await r.load("/src/verticals/finance/components/BacktestCharts.tsx");
  const text = textOf(r.html(BacktestCharts, { view }));
  assert.match(text, /重抽样 10000 次里为正的比例 >99\.9%/);
});
```

- 只渲染首屏，`useEffect` 不会跑。要测「拿到数据以后」的样子，把数据当 props 传给展示组件，不要去拼请求。
- 挑能分出对错的输入：比如占比用 0.9996，格式化函数用错了会显示成 100.0%，测试才会红。
- 写完把被测的那一处故意改坏，确认测试会红；从备份还原，不用 `git checkout`。
- 比对源码文字只留给「绝不能出现」的规则（Core 纯净度、禁用词、不许出现的调用），以及首屏渲染测不到的接线。
- 旧的源码比对测试不专门重写，改到哪条换哪条。

### 踩过的坑写成自动检查

`orchestrator/test/pitfall_rules.test.ts` 扫全仓正式代码，拦那些不报错、只给错数的写法（目前两条：只看首位判沪深北；用 `is_private` 一类属性判内网地址）。

- 加规则时同时写几条坏写法和好写法当样例，测试先确认规则认得出坏的、不误伤好的。
- 命中了先改写法。确实是统一做这件事的那一处，按原样整行登记豁免，并写明哪条测试把它的每种情况钉死；那一行一改，豁免就失效。

## 真实联调（会使用订阅或 API 额度）

用开发者自己在本机登录好的 CLI；产品不复制、不软链任何 CLI 的认证文件，也不借用其他产品的登录目录。
命令只把**测试产物**放进 `.local/dev-validation`，不污染日常数据根。
下面为 macOS / Linux 示例，在仓库根执行。Python 自动检测不适用时加 `--python` 指向本机虚拟环境。

```sh
VRA_DATA_ROOT="$PWD/.local/dev-validation" node orchestrator/src/run.ts \
  --symbol 300308 --market SZ --run-id cc-profile-001 \
  --provider cli-claude --endpoints core --stages profile \
  --max-retries 0 --turn-timeout-min 5 --knowledge off --no-archive < /dev/null
```

- 换来源只改 `--provider`：`cli-codex`(要求 Codex 用 ChatGPT 登录)、`cli-codebuddy`；
  模型 API 先 `export <模板 env_key>=...` 并跑 `node orchestrator/src/finance/provider_matrix.ts --provider <id>`，
  再用 `--provider <id> --model <实际模型名>`。
- 每次使用新的 `--run-id`；不覆盖既有产物。数据、事件和失败尝试留在 ignored 的 `.local/`。
- 单阶段验证应检查该阶段的 `validator_ok`；只跑画像的全局结果仍可能是 `incomplete / exit 2`，
  不能据此说完整报告通过，也不能把它误判成模型不可用。
- 六阶段联调去掉 `--stages profile`，使用新 run-id，可设 `--max-retries 1`。
  不降低来源、数字绑定、阶段所有权或合规校验标准。
- 每次运行核对 `manifest.json`：`engine.capabilities` 与 `provider`(含 `matrix_status`)是否就是本次选的来源，
  `stop_guard` 的拦截次数与是否被迫终止。
- `--no-archive` 同时跳过查看器和附录生成；它适合阶段测试，不适合验证报告引用界面。
  验证包含附录的自动收尾时去掉该参数，仍使用独立测试数据根，避免污染日常知识库。
- 登录失效、网络失败、资料缺口和模型产物校验失败是不同问题，不要一律归为模型不支持。
- 测试选择通过单次参数传入，不改全局配置，也不把测试登录态搬到其他产品。
- 只有六阶段产物、最终校验、报告访问路径均核实后，才能说该范围的业务闭环已通过。
  某一家来源跑通不代表其他来源也通过；本机成功也不等于 Windows 原生系统已经验证。

v1 时期用产品专用 Codex 登录(`--engine codex --codex-home ...`)的联调方式已随 v2.0 移除，这些参数现在会直接报错。
