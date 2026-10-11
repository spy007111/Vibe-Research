/**
 * 三市场标的代码的唯一规范形。
 *
 * - A 股: `600519`
 * - 港股: `00700.HK`
 * - 美股: `AAPL` / `BRK.B`
 *
 * 用户可以粘贴常见的带前缀 / 后缀写法，但台账和界面只保存上面的规范形。
 * 否则同一只腾讯控股会同时出现 `700` / `hk00700` / `00700.HK`，
 * 去重、加仓和删除都会得到不同答案。
 */

export type MarketCode = "CN" | "HK" | "US";
export type CurrencyCode = "CNY" | "HKD" | "USD";

const US_TICKER = /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/;

export function normalizeMarketSymbol(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let m = /^(?:sh|sz|bj)(\d{6})$/i.exec(raw);
  if (m) return m[1]!;
  m = /^(\d{6})\.(?:sh|sz|bj)$/i.exec(raw);
  if (m) return m[1]!;
  if (/^\d{6}$/.test(raw)) return raw;

  m = /^hk[:.]?(\d{1,5})$/i.exec(raw);
  if (!m) m = /^(\d{1,5})\.hk$/i.exec(raw);
  const hkDigits = m?.[1] ?? (/^\d{1,5}$/.test(raw) ? raw : null);
  if (hkDigits) return `${hkDigits.padStart(5, "0")}.HK`;

  // 兼容腾讯批量行情的 `usAAPL` 以及常见的 `US:AAPL`。
  // 🔴 不能对无分隔符写 `/i`：`USB` 本身就是合法美股代码，会被误拆成 `B`。
  m = /^us([A-Z][A-Za-z0-9]{0,9}(?:[.-][A-Za-z0-9]{1,4})?)$/.exec(raw);
  if (!m) m = /^us[:.]([a-z][a-z0-9]{0,9}(?:[.-][a-z0-9]{1,4})?)$/i.exec(raw);
  const ticker = (m?.[1] ?? raw).toUpperCase();
  return US_TICKER.test(ticker) ? ticker : null;
}

export function marketOfSymbol(value: unknown): MarketCode | null {
  const symbol = normalizeMarketSymbol(value);
  if (!symbol) return null;
  if (symbol.endsWith(".HK")) return "HK";
  if (/^\d{6}$/.test(symbol)) return "CN";
  return "US";
}

export function currencyOfSymbol(value: unknown): CurrencyCode | null {
  const market = marketOfSymbol(value);
  return market === "CN" ? "CNY" : market === "HK" ? "HKD" : market === "US" ? "USD" : null;
}

export function currencyLabel(currency: CurrencyCode): string {
  return currency === "CNY" ? "人民币" : currency === "HKD" ? "港元" : "美元";
}

/** 台账规范形 → 腾讯批量行情入参。 */
export function quoteQueryOfSymbol(value: unknown): string | null {
  const symbol = normalizeMarketSymbol(value);
  if (!symbol) return null;
  const market = marketOfSymbol(symbol);
  if (market === "HK") return `hk${symbol.slice(0, 5)}`;
  if (market === "US") return `us${symbol}`;
  return symbol;
}

/** 腾讯返回的 record_key → 台账规范形。 */
export function symbolFromQuoteKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const hk = /^hk(\d{1,5})$/i.exec(raw);
  if (hk) return `${hk[1]!.padStart(5, "0")}.HK`;
  const us = /^us(.+)$/i.exec(raw);
  if (us) return normalizeMarketSymbol(us[1]);
  return normalizeMarketSymbol(raw);
}

/**
 * **新输入**的美股股份类别统一成点号：Yahoo 写法 BRK-B → BRK.B。腾讯只认 BRK.B（BRK-B 回空，自选里一直没有行情），
 * 同一只也不该在自选里出现两种写法。只用在输入 / 粘贴处 —— 已经存进台账的旧写法照原样读，免得删不掉。
 */
export function classDot(symbol: string | null): string | null {
  return symbol ? symbol.replace(/^([A-Z][A-Z0-9]{0,9})-([A-Z])$/, "$1.$2") : null;
}

/** 逗号 / 空格 / 换行 / 顿号均可一次粘贴。 */
export function parseMarketSymbols(raw: string): string[] {
  const out: string[] = [];
  for (const token of raw.split(/[\s,，、;；]+/)) {
    const symbol = classDot(normalizeMarketSymbol(token));
    if (symbol && !out.includes(symbol)) out.push(symbol);
  }
  return out;
}

function zonedClock(at: Date, timeZone: string): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * 当前自选中是否至少有一个市场在交易。
 * 只覆盖工作日和常规时段，不伪装成有三地节假日日历。
 */
export function isAnyMarketTrading(symbols: string[], at = new Date()): boolean {
  const markets = new Set(symbols.map(marketOfSymbol).filter((x): x is MarketCode => x !== null));
  if (markets.size === 0) markets.add("CN"); // 保留旧的空参数语义

  for (const market of markets) {
    if (isMarketTrading(market, at)) return true;
  }
  return false;
}

export function isMarketTrading(market: MarketCode, at = new Date()): boolean {
  const zone = market === "US" ? "America/New_York" : market === "HK" ? "Asia/Hong_Kong" : "Asia/Shanghai";
  const { weekday, minutes } = zonedClock(at, zone);
  if (weekday === "Sat" || weekday === "Sun") return false;
  if (market === "US") return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
  // 港股 16:00 后还有收盘竞价，收市价 16:08–16:10 才定；停在 16:00 会一直显示竞价前的价
  if (market === "HK") return (minutes >= 9 * 60 + 30 && minutes <= 12 * 60) || (minutes >= 13 * 60 && minutes <= 16 * 60 + 10);
  return (minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60);
}

/** 自动轮询只发正在交易的市场；首次进入和手动刷新仍拉完整列表。 */
export function tradingMarketSymbols(symbols: string[], at = new Date()): string[] {
  return symbols.filter((symbol) => {
    const market = marketOfSymbol(symbol);
    return market !== null && isMarketTrading(market, at);
  });
}
