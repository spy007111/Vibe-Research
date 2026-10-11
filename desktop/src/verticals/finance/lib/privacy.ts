/**
 * 隐私模式：录屏、截图分享前一键把**自己的**金额和股数遮成 ••••。
 *
 * 🔴 只遮屏幕显示：计算、存盘、发给 AI 的内容都用原值（AI 要靠真实数字才答得对）。
 * 🔴 百分比不遮：看结构、比风险都要用，单凭比例推不出本金。
 * 🔴 现价、PE、总市值这类公开行情不遮；成本价、清仓价是自己的成交价，遮。
 *
 * 对话里的文字没有结构，只能按措辞认：「N 股 / N 手」、「成本 / 市值 / 盈亏 / 本金…」后面的数字，
 * 以及表头是这些词的表格列。模型换一种说法时可能认不出 —— 开关的说明里要如实写。
 */
export const MASK = "••••";

/** 结构化的数值：隐私模式下显示成 ••••；「—」（没有数）照旧，遮了反而像有数 */
export const hideIf = (on: boolean, text: string) => (on && text !== "—" ? MASK : text);

const NUM = String.raw`[-+]?(?:HK\$|US\$|[¥$])?\d[\d,]*(?:\.\d+)?`;
const MAG = String.raw`(?:\s*(?:万亿|亿|万|千))?`;

/** 数量：N 股 / N 手。股价、股票、股东、股本、股息、股权、股份、股指… 前面的数字不是数量 */
const SHARES = new RegExp(String.raw`${NUM}${MAG}(?=\s*(?:股|手)(?![价票东本息权份指市民吧评性]))`, "g");

/** 这些词后面紧跟的数字是自己的钱。市值单独处理：总市值、流通市值是公司的，不遮 */
const MONEY_WORDS = "持仓金额|买入金额|卖出金额|持仓价值|总价值|资产总值|浮动盈亏|已实现盈亏|已实现|浮盈|浮亏|盈亏|成本价|成本|本金|总资产|清仓价|买入价|卖出价";
const MONEY = new RegExp(
  String.raw`((?:${MONEY_WORDS})|(?<![总流通])市值)([^\d\n%。；;|]{0,6}?)(${NUM}${MAG})(?![\d.,]*\s*%)`, "g");

/** 表头是这些词的列，整列数字都遮（模型常把持仓列成表，表格里没有「成本 1500」这种措辞） */
const PRIVATE_HEADER = /数量|股数|持股|成本|(?<![总流通])市值|盈亏|浮盈|浮亏|金额|本金|价值|清仓价|买入价|卖出价|已实现/;
const CELL_NUM = new RegExp(String.raw`${NUM}${MAG}(?![\d.,]*\s*%)`, "g");

const cellsOf = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|");
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function maskTables(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableRow(lines[i]!) || !isSeparator(lines[i + 1]!)) continue;
    const cols = cellsOf(lines[i]!).map((h) => PRIVATE_HEADER.test(h));
    let j = i + 2;
    for (; j < lines.length && isTableRow(lines[j]!); j++) {
      if (!cols.some(Boolean)) continue;
      const cells = cellsOf(lines[j]!).map((c, k) => (cols[k] ? c.replace(CELL_NUM, MASK) : c));
      lines[j] = `| ${cells.map((c) => c.trim()).join(" | ")} |`;
    }
    i = j - 1;
  }
  return lines.join("\n");
}

/** 对话、记录这类自由文字：按措辞遮自己的金额和股数 */
export function maskPrivateText(text: string): string {
  return maskTables(text)
    .replace(SHARES, MASK)
    .replace(MONEY, (_m, word: string, gap: string) => `${word}${gap}${MASK}`);
}
