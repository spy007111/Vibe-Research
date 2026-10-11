import assert from "node:assert/strict";
import test from "node:test";

import {
  currencyOfSymbol,
  isAnyMarketTrading,
  marketOfSymbol,
  normalizeMarketSymbol,
  parseMarketSymbols,
  quoteQueryOfSymbol,
  symbolFromQuoteKey,
  tradingMarketSymbols,
} from "../src/verticals/finance/lib/marketSymbol.ts";

test("三市场常见写法归一成唯一台账代码", () => {
  assert.equal(normalizeMarketSymbol("600519"), "600519");
  assert.equal(normalizeMarketSymbol("sh600519"), "600519");
  assert.equal(normalizeMarketSymbol("600519.SH"), "600519");
  assert.equal(normalizeMarketSymbol("700"), "00700.HK");
  assert.equal(normalizeMarketSymbol("hk00700"), "00700.HK");
  assert.equal(normalizeMarketSymbol("00700.hk"), "00700.HK");
  assert.equal(normalizeMarketSymbol("aapl"), "AAPL");
  assert.equal(normalizeMarketSymbol("usAAPL"), "AAPL");
  assert.equal(normalizeMarketSymbol("US:AAPL"), "AAPL");
  assert.equal(normalizeMarketSymbol("USB"), "USB", "合法的 US 开头美股不能被当成行情前缀拆掉");
  assert.equal(normalizeMarketSymbol("usb"), "USB", "小写美股代码也应按用户代码归一化");
  assert.equal(normalizeMarketSymbol("brk.b"), "BRK.B");
  for (const bad of ["", "1234567", "00700.HK/../../x", "AAPL!", "贵州茅台"]) {
    assert.equal(normalizeMarketSymbol(bad), null, bad);
  }
});

test("批量粘贴去重，并保留三市场", () => {
  assert.deepEqual(
    parseMarketSymbols("600519, AAPL\n00700.HK、hk00700  sh600519  BRK.B"),
    ["600519", "AAPL", "00700.HK", "BRK.B"],
  );
  // Yahoo 写法 BRK-B 归一成腾讯认的 BRK.B，和 BRK.B 去重；多字母后缀（优先股等）不动
  assert.deepEqual(parseMarketSymbols("BRK-B brk.b BF-B BAC-PL"), ["BRK.B", "BF.B", "BAC-PL"]);
  assert.equal(normalizeMarketSymbol("BRK-B"), "BRK-B", "已存进台账的旧写法照原样读（删得掉）");
});

test("台账代码与腾讯查询键可往返，市场和币种不混", () => {
  const cases = [
    ["600519", "600519", "CN", "CNY"],
    ["00700.HK", "hk00700", "HK", "HKD"],
    ["AAPL", "usAAPL", "US", "USD"],
  ] as const;
  for (const [symbol, query, market, currency] of cases) {
    assert.equal(quoteQueryOfSymbol(symbol), query);
    assert.equal(symbolFromQuoteKey(query), symbol);
    assert.equal(marketOfSymbol(symbol), market);
    assert.equal(currencyOfSymbol(symbol), currency);
  }
});

test("实时轮询按各自市场时区判断，不再只看 A 股时间", () => {
  // 2026-08-28 是周五。02:00 UTC = 上海 / 香港 10:00，纽约前一天 22:00。
  const asiaOpen = new Date("2026-08-28T02:00:00Z");
  assert.equal(isAnyMarketTrading(["600519"], asiaOpen), true);
  assert.equal(isAnyMarketTrading(["00700.HK"], asiaOpen), true);
  assert.equal(isAnyMarketTrading(["AAPL"], asiaOpen), false);

  // 14:00 UTC = 纽约夏令时 10:00，亚洲已收盘。
  const usOpen = new Date("2026-08-28T14:00:00Z");
  assert.equal(isAnyMarketTrading(["AAPL"], usOpen), true);
  assert.equal(isAnyMarketTrading(["600519", "00700.HK"], usOpen), false);
  assert.equal(isAnyMarketTrading(["600519", "AAPL"], usOpen), true, "任一关注市场开盘就应轮询");
  assert.deepEqual(tradingMarketSymbols(["600519", "00700.HK", "AAPL"], asiaOpen), ["600519", "00700.HK"]);
  assert.deepEqual(tradingMarketSymbols(["600519", "00700.HK", "AAPL"], usOpen), ["AAPL"]);

  // 港股 16:00 后的收盘竞价（收市价 16:08–16:10 才定）也算：08:05 UTC = 香港 16:05
  assert.equal(isAnyMarketTrading(["00700.HK"], new Date("2026-08-28T08:05:00Z")), true);
  assert.equal(isAnyMarketTrading(["00700.HK"], new Date("2026-08-28T08:11:00Z")), false);
  assert.equal(isAnyMarketTrading(["600519"], new Date("2026-08-28T07:05:00Z")), false, "A 股 15:00 收盘，不跟着延长");

  const weekend = new Date("2026-08-30T14:00:00Z");
  assert.equal(isAnyMarketTrading(["600519", "00700.HK", "AAPL"], weekend), false);
});
