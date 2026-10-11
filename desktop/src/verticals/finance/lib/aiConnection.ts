import { SUBSCRIPTION_MODELS } from "./ai-models.ts";
import type { AiRuntimeRead, LlmConfig } from "./llmStore.ts";

const SOURCE_LABELS: Record<string, string> = {
  "cli-codex": "Codex订阅版", "cli-claude": "Claude订阅", "cli-codebuddy": "WorkBuddy CLI",
  deepseek: "DeepSeek API", mimo: "MiMo API", "openai-api": "OpenAI API", silicon: "硅基流动 API",
  minimax: "MiniMax API", openrouter: "OpenRouter API", groq: "Groq API", together: "Together API",
  glm: "智谱 GLM API", kimi: "Kimi API", qwen: "通义千问 API",
};

/** Saved connection identity, not a claim that the remote subscription never expires. */
export function aiConnectionLabel(runtime: AiRuntimeRead): string {
  if (runtime.status !== "ok" || !runtime.config) return "未接入AI，请设置";
  return `已接入AI：${SOURCE_LABELS[runtime.config.source.provider] ?? "自定义 API"}`;
}

export function subscriptionConfig(provider: string): LlmConfig {
  const model = SUBSCRIPTION_MODELS.find((entry) => entry.provider === provider);
  if (!model) throw new Error("不支持的快捷接入方式");
  return { provider: model.provider, model: model.id, baseURL: "", apiKey: "" };
}

interface ConnectionActions {
  read: () => string | null;
  probe: (config: LlmConfig, signal?: AbortSignal) => Promise<{ ok: true }>;
  save: (config: LlmConfig) => void;
}

/** Settings and home share the same probe-before-save contract. Never overwrite a newer choice. */
export async function testAndSaveAi(config: LlmConfig, actions: ConnectionActions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const previous = actions.read();
  const probe = await actions.probe(config, signal);
  signal?.throwIfAborted();
  if (probe.ok !== true) throw new Error("连接测试未成功，请重试");
  if (actions.read() !== previous) throw new Error("AI 接入配置已在其他页面更改，请重新确认当前选择");
  actions.save(config);
}
