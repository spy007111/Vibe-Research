/**
 * 接入 AI 的模型清单。结构与开源版 Vibe-Research 对齐（那一份经过真实用户验证），
 * 但**多一列「已实测」** —— 产品自带的 `providers/*.json` 模板记着官方地址、默认模型和
 * 已知不兼容项，有没有用真实 key 跑过看模板里的 `direct` 段；没有模板的按通用
 * OpenAI 兼容端点（Chat Completions）走，如实标成未实测。
 *
 * 🔴 **不拿没验过的冒充验过的**。哪些算「已实测」由**后端下发**
 *    （`productInfo().provider_templates`）—— 前端写死一份的话，
 *    迟早与 `providers/` 目录对不上，而对不上时界面上看不出来。
 *
 * 🔴 **模型名不许凭印象编**。下面每个 id 的来源只有两处：
 *    ① 产品 `providers/*.json` 模板里的 `default_model`（建模板时实查过）；
 *    ② 开源版 Vibe-Research 的同一张表（真实用户在用）。
 *    编一个看着像的名字出来，表现是"选了就报模型不存在"，而用户会以为是 key 的问题。
 *
 * 两档：
 * - **订阅档**（`cli-*`）= 用这台机器上用户自己装好、登录好的 Agent CLI，**免 API key**
 * - **API 档** = 填自己的 key，走各家端点
 */

export type ProviderId =
  | "deepseek" | "silicon" | "openai-api" | "minimax" | "openrouter"
  | "groq" | "together" | "mimo" | "glm" | "kimi" | "qwen"
  | "openai-compatible"
  | "cli-codex" | "cli-claude" | "cli-codebuddy";

export interface ModelConfig {
  /** 真正传给引擎的 model 名 */
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
}

export const isCliProvider = (p: string): boolean => p.startsWith("cli-");

/**
 * 各家默认端点。选中即自动填，用户通常只需填 key。
 * 带 `{…}` 的是**必须由用户替换的占位**（百炼要填自己的 WorkspaceId）——
 * 原样留在这里是故意的：后端会拒绝没替换的占位，而界面上看得见才知道要改哪。
 */
export const PROVIDER_BASE: Partial<Record<ProviderId, string>> = {
  // 有模板的几家与 providers/*.json 的 base_url 一致(2026-10-07 按各家官方文档核实)
  deepseek: "https://api.deepseek.com",
  "openai-api": "https://api.openai.com/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  kimi: "https://api.moonshot.cn/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  mimo: "https://api.xiaomimimo.com/v1",
  silicon: "https://api.siliconflow.cn/v1",
  minimax: "https://api.minimaxi.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  "openai-compatible": "",
};

export const AI_MODELS: ModelConfig[] = [
  // —— 订阅档（免 API key，用这台机器上已登录的 Agent CLI）——
  // 可用性不在这里写死：设置页从后端实时检测本机是否安装、是否登录。
  // ⚠️ 订阅档这一栏的 `id` 是**这条订阅的名字，不是模型名** —— 模型由登录态决定。
  //    上一版这里写了个像模像样的 "gpt-5.6-codex"，真发出去收到的是
  //    "The 'gpt-5.6-codex' model is not supported when using Codex with a ChatGPT account"。
  //    后端现在对订阅档一律不转发模型名，这里也不再摆一个假模型名出来。
  { id: "codex", name: "Codex 订阅", description: "用本机 Codex CLI 的 ChatGPT 登录，免 API key", provider: "cli-codex" },
  { id: "claude-code", name: "Claude Code", description: "用本机 Claude Code 的订阅登录，免 API key", provider: "cli-claude" },
  { id: "codebuddy", name: "WorkBuddy / CodeBuddy", description: "用本机 CodeBuddy 已登录账号，免 API key", provider: "cli-codebuddy" },

  // —— API 档（填自己的 key）。带模板的排前面；模型名与 providers/*.json 的说明一致 ——
  { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", description: "DeepSeek 官方 · 快而省", provider: "deepseek" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "DeepSeek 官方 · 更强、更慢", provider: "deepseek" },
  { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", description: "小米 MiMo 官方 · 快，日常首选", provider: "mimo" },
  { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", description: "小米 MiMo 官方 · 适合复杂长任务，更准但慢", provider: "mimo" },
  { id: "glm-5.3", name: "智谱 GLM-5.3", description: "智谱官方开放平台", provider: "glm" },
  { id: "kimi-k3", name: "Kimi K3", description: "月之暗面官方 · 默认最高推理强度，较慢", provider: "kimi" },
  { id: "qwen3.8-max", name: "通义千问 3.8 Max", description: "阿里云百炼（北京地域）", provider: "qwen" },
  { id: "gpt-5.4", name: "OpenAI GPT-5.4", description: "OpenAI 官方 · 这条线路只能用不推理的模型调工具", provider: "openai-api" },
  // —— 以下没有产品模板，按通用 OpenAI 兼容端点走 ——
  { id: "deepseek-ai/DeepSeek-V3", name: "硅基流动 · DeepSeek V3", description: "SiliconFlow 聚合", provider: "silicon" },
  { id: "MiniMax-M2", name: "MiniMax M2", description: "MiniMax 海螺", provider: "minimax" },
  { id: "openai/gpt-4o", name: "OpenRouter · GPT-4o", description: "OpenRouter 聚合（model 可改任意 id）", provider: "openrouter" },
  { id: "llama-3.3-70b-versatile", name: "Groq · Llama 3.3 70B", description: "Groq 超快推理", provider: "groq" },
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Together · Llama 3.3 70B", description: "Together AI", provider: "together" },
  { id: "custom", name: "其它 OpenAI 兼容端点", description: "任意兼容端点，自填 baseURL / model", provider: "openai-compatible" },
];

export const SUBSCRIPTION_MODELS = AI_MODELS.filter((m) => isCliProvider(m.provider));
export const API_MODELS = AI_MODELS.filter((m) => !isCliProvider(m.provider));

/** A selectable preset is not the user's editable model name. Preserve provider identity on remount. */
export function apiPresetForSaved(saved: { provider: string; model: string } | null): string {
  if (!saved || isCliProvider(saved.provider)) return API_MODELS[0]!.id;
  return API_MODELS.find((m) => m.provider === saved.provider && m.id === saved.model)?.id
    ?? API_MODELS.find((m) => m.provider === saved.provider)?.id
    ?? "custom";
}

/** Model name to prefill when a preset is picked. The custom preset has no model of its own: leave it for the user. */
export const modelNameForPreset = (id: string): string => (id === "custom" ? "" : id);

export const modelById = (id: string): ModelConfig | undefined => AI_MODELS.find((m) => m.id === id);
export const providerOfModel = (id: string): ProviderId => modelById(id)?.provider ?? "openai-compatible";
