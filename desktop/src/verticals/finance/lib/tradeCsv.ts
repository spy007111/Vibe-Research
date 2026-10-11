/**
 * 从表格导入交易流水:把 CSV / 从表格软件复制来的内容,按列名转成一笔笔流水(在本机解析,不发给 AI)。
 *
 * 🔴 每一行都过 `tradeRecord`,和手动「记一笔」同一套检查;不对的行写原因、不导入,不猜不补。
 * 🔴 1–5 位纯数字代码一律拒:表格软件会把 000001 存成 1、把 00700 存成 700,
 *    这时分不清原来是 A 股还是港股(手动记一笔时 700 当港股是对的,导入时这样猜会把 A 股记成港股)。
 * 🔴 负数不取绝对值:有的券商导出卖出数量是负的,但那是导出的写法,换算方向要用户自己确认。
 */
import { tradeRecord, emptyTradeForm, type TradeForm, type TradeType } from "./holdings.ts";

export const CSV_MAX_ROWS = 1000;

type Field = "date" | "type" | "symbol" | "name" | "shares" | "price" | "fee" | "amount" | "ratio" | "note";
const FIELD_NAMES: Record<Field, string> = {
  date: "日期", type: "类型", symbol: "代码", name: "名称", shares: "数量", price: "价格", fee: "费用", amount: "金额", ratio: "比例", note: "备注",
};
/** 列名别名(比较前去掉空格、括号里的单位,英文不分大小写) */
const HEADER_ALIASES: Record<Field, string[]> = {
  date: ["日期", "成交日期", "交易日期", "发生日期", "date"],
  type: ["类型", "操作", "买卖", "买卖标志", "业务名称", "type"],
  symbol: ["代码", "证券代码", "股票代码", "symbol", "code"],
  name: ["名称", "证券名称", "股票名称", "name"],
  shares: ["数量", "成交数量", "股数", "shares"],
  price: ["价格", "成交价", "成交价格", "成交均价", "每股成本", "price"],
  fee: ["费用", "手续费", "佣金", "交易费用", "fee"],
  amount: ["金额", "到账金额", "分红金额", "发生金额", "amount"],
  ratio: ["比例", "送转比例", "ratio"],
  note: ["备注", "note"],
};
const REQUIRED: Field[] = ["date", "type", "symbol"];
const TYPE_ALIASES: Record<TradeType, string[]> = {
  buy: ["买入", "买", "证券买入", "buy"],
  sell: ["卖出", "卖", "证券卖出", "sell"],
  dividend: ["现金分红", "分红", "红利", "红利入账", "股息", "股息入账", "dividend"],
  split: ["送转", "拆股", "送转拆股", "送转/拆股", "合股", "split"],
  opening: ["期初持仓", "期初", "opening"],
};

const norm = (s: string) => s.replace(/[\s　]/g, "").replace(/[(（][^)）]*[)）]$/, "").toLowerCase();
const HEADER_OF = new Map<string, Field>();
for (const [f, names] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) for (const n of names) HEADER_OF.set(norm(n), f);
const TYPE_OF = new Map<string, TradeType>();
for (const [t, names] of Object.entries(TYPE_ALIASES) as [TradeType, string[]][]) for (const n of names) TYPE_OF.set(norm(n), t);

export interface CsvRow {
  /** 在原文里是第几行(从 1 数,含表头) */
  line: number;
  /** 原样的几格,预览列表用 */
  cells: { date: string; type: string; symbol: string; name: string };
  /** 能导入的台账记录;这一行不对时为 null,原因在 error */
  record: Record<string, unknown> | null;
  error: string | null;
}
export type CsvParse =
  | { ok: true; rows: CsvRow[]; columns: Field[]; unused: string[]; delimiter: "," | "\t" }
  | { ok: false; error: string };

/** 一段表格文本 → 一行行格子(RFC 4180:引号里可以有分隔符、换行,"" 是一个引号)。每行带它开始的行号 */
export function splitTable(text: string, delimiter: "," | "\t"): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], cell = "", quoted = false, line = 1, start = 1, i = 0;
  const end = () => { cells.push(cell); out.push({ line: start, cells }); cells = []; cell = ""; };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === "\n") line++; cell += c; }
    } else if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (c === delimiter) { cells.push(cell); cell = ""; }
    else if (c === "\n") { end(); line++; start = line; }
    else cell += c;
  }
  if (cell !== "" || cells.length) end();
  return out;
}

/** 首个非空行里制表符多就按制表符(从表格软件复制来的),否则按逗号 */
function delimiterOf(text: string): "," | "\t" {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return (first.match(/\t/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) && first.includes("\t") ? "\t" : ",";
}

/** 日期:YYYY-MM-DD、YYYY/M/D、YYYY.M.D、YYYYMMDD;后面带时间的只取日期 */
export function normalizeDate(raw: string): string {
  const s = raw.trim().replace(/[T\s].*$/, "");
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : raw.trim();
}

/** 数字:去掉千分位逗号和空格;别的照原样交给检查(写错了报错,不当 0) */
const normalizeNumber = (raw: string) => raw.replace(/[,，\s　]/g, "");

/** 表格文本 → 每行一笔流水(或原因)。表头不对、行数超限直接整体报错 */
export function parseTradeCsv(input: string): CsvParse {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return { ok: false, error: "没有内容:请粘贴表格,或选一个 CSV 文件" };
  const delimiter = delimiterOf(text);
  const table = splitTable(text, delimiter).filter((r) => r.cells.some((c) => c.trim() !== ""));
  const head = table.shift();
  if (!head) return { ok: false, error: "没有内容:请粘贴表格,或选一个 CSV 文件" };

  const col = new Map<Field, number>();
  const unused: string[] = [];
  for (const [i, h] of head.cells.entries()) {
    const f = HEADER_OF.get(norm(h));
    if (!f) { if (h.trim()) unused.push(h.trim()); continue; }
    if (col.has(f)) return { ok: false, error: `有两列都是「${FIELD_NAMES[f]}」:第 ${col.get(f)! + 1} 列和第 ${i + 1} 列,请删掉一列` };
    col.set(f, i);
  }
  const missing = REQUIRED.filter((f) => !col.has(f));
  if (missing.length) {
    return { ok: false, error: `第一行要是列名,至少要有${missing.map((f) => `「${FIELD_NAMES[f]}」`).join("")}这几列(认得的写法:${missing.map((f) => HEADER_ALIASES[f].join(" / ")).join(";")})。可以先点「填入格式示例」照着改` };
  }
  if (table.length > CSV_MAX_ROWS) return { ok: false, error: `一次最多导入 ${CSV_MAX_ROWS} 行,这份有 ${table.length} 行:请分成几份` };

  const get = (cells: string[], f: Field) => (col.has(f) ? (cells[col.get(f)!] ?? "").trim() : "");
  const rows: CsvRow[] = table.map(({ line, cells }) => {
    const c = { date: get(cells, "date"), type: get(cells, "type"), symbol: get(cells, "symbol"), name: get(cells, "name") };
    const row = (error: string): CsvRow => ({ line, cells: c, record: null, error });
    const type = TYPE_OF.get(norm(c.type));
    if (!type) return row(`类型「${c.type || "空"}」不认识(写 买入 / 卖出 / 现金分红 / 送转 / 期初持仓)`);
    if (/^\d{1,5}$/.test(c.symbol)) {
      return row(`代码「${c.symbol}」只有 ${c.symbol.length} 位:表格软件常把开头的 0 去掉。A 股请写满 6 位(如 000001),港股写成 00700.HK 这样`);
    }
    const form: TradeForm = {
      ...emptyTradeForm(type), symbol: c.symbol, name: c.name, date: normalizeDate(c.date),
      shares: normalizeNumber(get(cells, "shares")), price: normalizeNumber(get(cells, "price")), fee: normalizeNumber(get(cells, "fee")),
      amount: normalizeNumber(get(cells, "amount")), ratio: normalizeNumber(get(cells, "ratio")), note: get(cells, "note"),
    };
    const r = tradeRecord(form);
    return "error" in r ? row(r.error) : { line, cells: c, record: r.record, error: null };
  });
  return { ok: true, rows, columns: [...col.keys()], unused, delimiter };
}

/** 读文件:先按 UTF-8 严格解;解不了按 GB18030(券商、旧版表格软件导出的中文 CSV 常是 GBK) */
export function decodeTableFile(buf: ArrayBuffer | Uint8Array): { text: string } | { error: string } {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { error: "这是 Excel 工作簿(.xlsx),读不了:请在表格软件里「另存为 CSV」,或者直接选中表格复制、粘贴到下面" };
  }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; } catch { /* 不是 UTF-8 */ }
  try { return { text: new TextDecoder("gb18030").decode(bytes) }; } catch { return { error: "文件编码认不出:请另存为「CSV UTF-8」再选" }; }
}

/** 模板:列名 + 每种类型一行。数量、价格是格式示例,不是谁的真实交易;导入前换成自己的 */
export const TRADE_CSV_TEMPLATE = [
  "日期,类型,代码,名称,数量,价格,费用,金额,比例,备注",
  "2020-01-02,期初持仓,AAPL,Apple,10,300,,,,示例:开始记账前就有的写期初持仓",
  "2020-08-31,送转,AAPL,Apple,,,,,4,示例:1 拆 4 比例写 4;10 转 5 写 1.5",
  "2025-01-02,买入,600519,贵州茅台,100,1500,5,,,示例:A 股写满 6 位",
  "2025-02-03,买入,00700.HK,腾讯控股,200,380,25,,,示例:港股写成 00700.HK",
  "2025-03-04,卖出,00700.HK,腾讯控股,100,420,30,,,示例",
  "2025-06-20,现金分红,00700.HK,腾讯控股,,,,340,,示例:金额写到账的(税后)",
].join("\n");
