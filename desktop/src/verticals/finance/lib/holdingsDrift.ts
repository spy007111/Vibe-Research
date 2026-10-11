/**
 * 持仓体检、情景回放共用的「输入变没变」判断。
 *
 * 签名只管结构：代码、名称、股数、现价有没有取到。市值每次刷新行情都会动，放进签名就得每轮都重取历史价格；
 * 所以市值改成和「上次算的时候」比：有一只变了 2% 以上，占比和金额就可能差出几个百分点，算持仓变了
 * （Codex 审计 2026-10-09 C2：原来只看股数，市值从 1000/1000 变成 2000/1000 仍沿用 50%/50% 的旧结果）。
 */
export interface HoldingInput { code: string; name: string; shares: number; market_value: number | null }
export type HoldingValues = Record<string, number | null>;

/**
 * 市值相对上次变了多少算「变了」。
 *
 * 为什么留 2% 而不是一动就作废：交易时段行情 3 秒一跳，回放一次要一两分钟，「任何变动都作废」会让结果永远是过期的、
 * 也永远进不了 AI 上下文。2% 以内只会让**比例**差一点点；**金额**不靠这个容差：回放卡的「按现在的市值约」
 * 用 `amountAtNow` 按当前市值现算(审计第二轮 C2:两只都涨 1.5%,原来仍显示回放那一刻的 −60,000,应为 −60,900)。
 */
export const VALUE_DRIFT = 0.02;

export const holdingsSig = (hs: readonly HoldingInput[]) =>
  hs.map((h) => `${h.code}:${h.shares}:${h.market_value === null ? 0 : 1}:${h.name}`).sort().join("|");

export const holdingValues = (hs: readonly HoldingInput[]): HoldingValues =>
  Object.fromEntries(hs.map((h) => [h.code, h.market_value]));

const norm = (s: string) => s.trim().toUpperCase();

/**
 * 「这段时期的组合涨跌 × 这几只**现在**的市值」。有一只现在没有市值(或对不上),返回 null,
 * 调用方改用回放那一刻的金额并写明是那一刻的。
 */
export function amountAtNow(ret: number | null, symbols: readonly string[], now: HoldingValues): number | null {
  if (ret === null || !symbols.length) return null;
  const byKey = new Map(Object.entries(now).map(([k, v]) => [norm(k), v]));
  let total = 0;
  for (const s of symbols) {
    const v = byKey.get(norm(s));
    if (v === undefined || v === null) return null;
    total += v;
  }
  return ret * total;
}

/** 当前市值和上次算的时候比，有没有哪一只变了 2% 以上（多出、少了一只，或现价有无变了，都算变了） */
export function valuesDrifted(prev: HoldingValues, hs: readonly HoldingInput[]): boolean {
  if (Object.keys(prev).length !== hs.length) return true;
  return hs.some((h) => {
    if (!(h.code in prev)) return true;
    const a = prev[h.code] ?? null, b = h.market_value;
    if (a === null || b === null) return a !== b;
    return a === 0 ? b !== 0 : Math.abs(b / a - 1) > VALUE_DRIFT;
  });
}
