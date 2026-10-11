/**
 * 研究记录（沉淀）—— **存在用户自有台账里，不是浏览器缓存**。
 *
 * 🔴 与上游的关键不同：上游存 localStorage。清一次缓存、换一个浏览器，沉淀就没了 ——
 *    清缓存就会消失的东西不配叫沉淀，而且 agent 也读不到它。
 *    ⇒ 落在台账的 `note` 种类里：跟着数据根走、能被 agent 读到、不进仓库。
 *
 * ⚠️ **读是同步的、写是异步的**：页面在渲染时同步读（`useState(loadNotes)`），
 *    所以缓存必须在 React 挂载**之前**灌好（见 `main.tsx` 的 hydrate）。
 *    写则必须异步——写失败要让调用方看得见，不能默默"保存成功"。
 */
import { backend, type LedgerRecord } from "./backend";

export interface Note {
  id: string;
  kind: string;    // 复盘 / 今日要点 / 问AI / 多空辩论 / 反思审计
  title: string;
  content: string; // markdown 正文
  ts: number;      // 保存时间戳(ms)
}

let cache: Note[] = [];
/** 枚举键 → 中文名。**由后端随台账下发**（`Plugin.ledger.enumLabels`），前端不写死一份 */
let enumLabels: Record<string, string> = {};

/**
 * 界面上的分类叫法 → 台账枚举键。
 * ⚠️ 台账的 `category` 是**枚举**，不是自由文本。界面用的词（"问AI"）与
 *    垂类包给的显示名（"问 Agent"）不完全一样，所以要有这张别名表。
 * 🔴 映射不上时**抛错，不静默塞一个默认值** —— 悄悄归错类的记录，
 *    事后没人看得出它本来是什么。
 */
const KIND_TO_CATEGORY: Record<string, string> = {
  复盘: "review",
  今日要点: "highlight",
  问AI: "ask",
  "问 AI": "ask",
  "问 Agent": "ask",
  多空辩论: "debate",
  反思审计: "audit",
  回测: "backtest",
  研究对比: "compare",
};

function toCategory(kind: string): string {
  const direct = KIND_TO_CATEGORY[kind.trim()];
  if (direct) return direct;
  // 后端下发的显示名也认（垂类包改了措辞时不用回来改这里）
  const byLabel = Object.entries(enumLabels).find(([, label]) => label === kind.trim())?.[0];
  if (byLabel) return byLabel;
  throw new Error(`研究记录的分类「${kind}」没有对应的台账枚举 —— 加分类要同时改垂类包的 note.category`);
}

const toNote = (r: LedgerRecord): Note => {
  const cat = String(r.category ?? "");
  return {
    id: r.id,
    kind: enumLabels[cat] ?? cat,
    title: String(r.title ?? ""),
    content: String(r.body ?? ""),
    ts: Date.parse(r.created_at) || 0,
  };
};

/**
 * 从台账灌一次缓存。**在 React 挂载前调用**；失败要往上抛，别静默当成"没有记录"。
 *
 * 🔴 慢快照不许覆盖新缓存:hydrate 在途时若 `addNote` 写成功了,先发的那次 hydrate
 *    会带回**不含新记录的旧快照**,落地后表现为"刚存的东西不见了"（台账里其实有）。
 *    ⇒ 用序号把过期结果丢掉。写入也 ++seq,这样写完之后在途的旧 hydrate 一律作废。
 */
let seq = 0;
export async function hydrateNotes(): Promise<void> {
  const mine = ++seq;
  const led = await backend.ledger();
  if (mine !== seq) return;
  enumLabels = led.labels.enums ?? {};
  cache = (led.records.note ?? []).map(toNote).sort((a, b) => b.ts - a.ts);
}

/** ⚠️ 返回**副本**:直接交出内部数组的话,调用方一个 `sort()` 就改了缓存而没写台账 */
export function loadNotes(): Note[] {
  return [...cache];
}

/** 新记录置顶。返回更新后的完整列表。 */
export async function addNote(kind: string, title: string, content: string): Promise<Note[]> {
  const saved = await backend.ledgerSave("note", { category: toCategory(kind), title, body: content });
  seq++;                       // 让在途的旧 hydrate 作废,别把这条新记录冲掉
  cache = [toNote(saved), ...cache];
  return [...cache];
}

export async function deleteNote(id: string): Promise<Note[]> {
  await backend.ledgerDelete("note", id);
  seq++;
  cache = cache.filter((n) => n.id !== id);
  return [...cache];
}

export async function clearNotes(): Promise<void> {
  // 逐条删。⚠️ 一条失败就停下并把已删的反映到缓存里 —— 不要假装"全清了"
  seq++;
  for (const n of [...cache]) {
    await backend.ledgerDelete("note", n.id);
    cache = cache.filter((x) => x.id !== n.id);
  }
}
