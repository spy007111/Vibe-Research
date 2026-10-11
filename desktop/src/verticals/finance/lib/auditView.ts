/**
 * 防篡改核对：把后端登记簿的核对结果（/audit）整理成页面上的话。
 *
 * 🔴 只翻译、不下结论：后端说「和登记时不一样」就照说，不猜是谁改的、为什么改。
 * 🔴 链头那段局限必须原样说出来：登记簿和数据在同一个文件夹，能改数据的人也能把整份登记簿重写，
 *    只有另存在别处的链头能发现这种情况。
 */

export type AuditSubject = "run" | "ledger";
export type AuditIssueKind = "changed" | "missing" | "unregistered";
export interface AuditIssue {
  subject: AuditSubject;
  ref: string;
  kind: AuditIssueKind;
  why: string;
  files?: { changed: string[]; added: string[]; removed: string[] };
  last?: { seq: number; at: string; action: string };
}
export interface ChainProblem { line: number; seq: number | null; why: string; serious: boolean }
export interface AuditReport {
  entries: number;
  head: { seq: number; hash: string; at: string } | null;
  head_text: string | null;
  chain_ok: boolean;
  problems: ChainProblem[];
  issues: AuditIssue[];
  consistent: { run: number; ledger: number };
}
export interface HeadCheck { ok: boolean; seq: number | null; why: string }

export const HEAD_CAVEAT = "登记簿和数据在同一个文件夹：能改数据的人，也能把整份登记簿按新内容重写一遍，这样「核对」看不出来。"
  + "把下面的链头复制到别处保存（备忘录、邮件、发给自己），以后粘回来比一下，就能发现这种情况。";

/** 显示名：研究运行 → 公司 + 代码；台账记录 → 种类名 + 标题 */
export interface AuditNames {
  run: (id: string) => { name: string | null; symbol: string | null } | null;
  kindLabel: (kind: string) => string | null;
  record: (kind: string, id: string) => Record<string, unknown> | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** 台账记录的标题：有标题用标题，否则名称 + 代码 + 日期（同一只票的几笔交易靠日期分），再不然只给种类 */
export function recordTitle(rec: Record<string, unknown> | null): string {
  if (!rec) return "";
  const title = str(rec.title) || str(rec.statement);
  if (title) return title.length > 40 ? `${title.slice(0, 40)}…` : title;
  return [str(rec.name), str(rec.symbol), str(rec.date)].filter(Boolean).join(" ");
}

export function issueSubject(i: AuditIssue, names: AuditNames): string {
  if (i.subject === "run") {
    const r = names.run(i.ref);
    const who = [r?.name, r?.symbol].filter(Boolean).join(" ");
    return who ? `研究 ${who}（${i.ref}）` : `研究 ${i.ref}`;
  }
  const slash = i.ref.indexOf("/");
  const kind = slash > 0 ? i.ref.slice(0, slash) : i.ref;
  const id = slash > 0 ? i.ref.slice(slash + 1) : "";
  const label = names.kindLabel(kind) ?? kind;
  const title = recordTitle(names.record(kind, id));
  return title ? `${label}「${title}」` : `${label}（${id || i.ref}）`;
}

const FILE_NAMES: Record<string, string> = {
  "report.md": "报告", "evidence.json": "证据", "calculations.json": "计算结果",
  "manifest.json": "运行清单", "conflicts.json": "证据冲突", "report_appendix.md": "报告附录", "viewer.html": "证据查看器",
};
const DIR_NAMES: Record<string, string> = { stages: "阶段结果", raw: "原始文件", fetch: "取数记录", calcs: "计算记录" };

export function fileLabel(rel: string): string {
  if (FILE_NAMES[rel]) return `${FILE_NAMES[rel]}（${rel}）`;
  const slash = rel.indexOf("/");
  const dir = slash > 0 ? DIR_NAMES[rel.slice(0, slash)] : undefined;
  return dir ? `${dir} ${rel.slice(slash + 1)}` : rel;
}

/** 研究运行变了哪些文件，一句话；文件多时只列前几个 */
export function filesText(f: AuditIssue["files"], max = 4): string {
  if (!f) return "";
  const part = (label: string, xs: string[]) => {
    if (!xs.length) return "";
    const shown = xs.slice(0, max).map(fileLabel).join("、");
    return `${label}${shown}${xs.length > max ? ` 等 ${xs.length} 个` : ""}`;
  };
  return [part("改了：", f.changed), part("多了：", f.added), part("少了：", f.removed)].filter(Boolean).join("；");
}

export const fmtAt = (at: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? at.slice(0, 16).replace("T", " ") : at);

export type AuditTone = "ok" | "warn" | "bad";

/** 一句话结论。链断了最严重；其次是改过 / 不见了；只剩没登记的是提醒 */
export function auditHeadline(r: AuditReport): { tone: AuditTone; text: string } {
  const n = (k: AuditIssueKind) => r.issues.filter((i) => i.kind === k).length;
  const changed = n("changed"), missing = n("missing"), unregistered = n("unregistered");
  if (!r.chain_ok) return { tone: "bad", text: `登记簿本身被改过：${r.problems.filter((p) => p.serious).length} 处对不上，下面的结论都要打折扣` };
  if (changed || missing) {
    const parts = [changed && `${changed} 处和登记时不一样`, missing && `${missing} 处登记过但现在不见了`].filter(Boolean);
    return { tone: "bad", text: `发现 ${parts.join("，")}（登记簿里没有这些改动的记录：多半是绕开软件改的，也可能是当时登记没写上）` };
  }
  const ok = `${r.consistent.run} 次研究、${r.consistent.ledger} 条记录和登记时一致`;
  if (unregistered) return { tone: "warn", text: `${ok}；还有 ${unregistered} 条没登记（功能上线前就有的，或当时没登记上）` };
  if (!r.entries) return { tone: "warn", text: "登记簿还是空的：之后每次研究结束、每次保存记录都会自动登记" };
  return { tone: "ok", text: `登记簿完好：共 ${r.entries} 条，${ok}` };
}
