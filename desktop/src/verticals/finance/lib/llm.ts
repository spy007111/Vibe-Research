/**
 * 用户的模型配置（**持久保存在当前浏览器 localStorage，不进仓库或后端配置**）+ 对话调用。
 *
 * 🔴 口径与开源版 Vibe-Research 对齐 —— 那一份经过真实用户验证：
 *    用户在「接入 AI」页选模型、粘自己的 key → 存本地 → **随请求发给本机后端** →
 *    后端把它拼进一个临时 env 交给引擎。**配置文件 / 日志 / 账本一个字节都碰不到。**
 *
 * ⚠️ 上一版的口径是「密钥只从环境变量读，界面只读」。那在终端里启动时没问题，
 *    但只依赖启动服务前配置 shell 环境，浏览器 UI 里就没有可操作的接入入口。
 *    「不进产品配置文件」这条纪律在新做法下照样成立。注意 localStorage 本身会由浏览器落到
 *    本机用户配置中，它不是系统钥匙串，也不承诺加密；这里只承诺不进入产品后端的持久化面。
 *
 * 🔴 浏览器产品只认用户明确保存的这一份配置，不回落到后端环境变量。
 *    否则首次使用会在没做选择时悄悄调用另一家模型，界面也无法解释实际走了哪条路。
 */
import { ApiError, backend } from "./backend.ts";
import { parseHeadlineTranslations, type HeadlineTranslationInput } from "./headlineTranslation.ts";
import { clearUserLlm, loadUserLlm, readAiRuntime, saveUserLlm, type LlmConfig } from "./llmStore.ts";
import { newAnalysisSession } from "./analysisSession.ts";

export type { LlmConfig };
// ⚠️ 存取一律走 llmStore —— 这里再抄一份实现，迟早两边判定不一致
export { loadUserLlm };

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  /** 上游用它显示"AI 调了哪些数据工具"。我们的对话线程不联网、不调工具,恒为空 */
  trace: { tool: string; args: Record<string, unknown> }[];
  rounds: number;
}

export interface ChatHandlers {
  onDelta?: (text: string) => void;
  onTool?: (tool: string, args: Record<string, unknown>) => void;
}

export function saveLlm(cfg: LlmConfig): void {
  try {
    saveUserLlm(cfg);
  } catch (e) {
    // 🔴 存不下要**说出来**：静默失败会让用户以为配好了，下次打开又是空的
    throw new ApiError(`本地存储写不进去（${e instanceof Error ? e.message : String(e)}）—— 配置没保存`, 500, "storage_failed");
  }
}

export function clearLlm(): void {
  clearUserLlm();
}

/**
 * 浏览器端有没有完成一次明确的 AI 接入。
 */
export function hasLlm(): boolean {
  return readAiRuntime().status === "ok";
}

/** 兼容上游签名：上游的 `loadLlm()` 语义是"当前生效的配置"。 */
export function loadLlm(): LlmConfig | null {
  return loadUserLlm();
}

/**
 * 发一轮对话。
 * ⚠️ `context` 拼在问题前面 —— 上游用它把"当前这一页在看什么"带进去。
 * 每次页面分析使用新会话，只发最后一条用户消息与本次页面上下文；
 * 需要连续对话的入口使用 useAiChat 管理自己的会话，不调用本函数。
 */
export async function chatStream(
  messages: ChatMsg[],
  context: string,
  handlers: ChatHandlers = {},
  signal?: AbortSignal,
): Promise<ChatResult> {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) throw new ApiError("没有要问的内容", 400, "empty_message");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const message = context ? `【当前页面的数据】\n${context}\n\n【问题】\n${last.content}` : last.content;
  // ⚠️ 用户那份由 `backend.chat` 自己带上（见 llmStore.ts 里那条"防线只守一个入口等于没有"）
  const r = await backend.chat(message, newAnalysisSession("page-analysis"), signal);
  // 用户中途关面板 / 换问题:结果照样回来了,但不往界面上写(与上游 abort 行为一致)
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const content = r.redacted
    ? `${r.reply}\n\n> ⚠️ 有 ${r.redacted} 行触发产出红线被移除(不给操作建议)。`
    : r.reply;
  handlers.onDelta?.(content);
  return { content, trace: [], rounds: 1 };
}

export function chat(messages: ChatMsg[], context: string): Promise<ChatResult> {
  return chatStream(messages, context);
}

/**
 * Investment News 的专用标题翻译。
 *
 * 不复用 `default` 对话会话：后端为每一批开独立线程，并把翻译规则放在
 * developer 指令层，RSS 标题只作为 JSON 数据进入用户层。
 */
export async function translateHeadlineBatch(
  items: HeadlineTranslationInput[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (!items.length) return new Map();
  const r = await backend.translateHeadlines(items, signal);
  // 后端已经逐条移除触发红线的译文；其余安全条目必须保留，不能因一条而丢整批。
  // 被移除的 id 自然缺席，页面会把那几条保留成英文并显示 partial。
  return parseHeadlineTranslations(JSON.stringify({ items: r.items }), items);
}
