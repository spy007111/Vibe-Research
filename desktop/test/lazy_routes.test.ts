import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("保留全部路由，但非首屏业务按需加载并保留加载/错误反馈", () => {
  const source = readFileSync(new URL("../src/verticals/finance/router.tsx", import.meta.url), "utf8");
  const paths = [...source.matchAll(/path: "([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(paths, ["/", "/daily-review", "/intel", "/intel/:tab", "/signals", "/signals/:tab", "/sectors", "/sectors/:key", "/candidates", "/my-stocks", "/calendar", "/backtest", "/research", "/debate", "/my-reports", "/notes", "/inbox", "/settings",
    "/stock-data", "/watchlist", "/portfolio"]);
  assert.equal((source.match(/lazy: async/g) ?? []).length, 16);
  // 旧地址都还能打开：跳到新页面对应的分页，原来的查询参数照带
  assert.match(source, /path: "\/stock-data", element: <Moved to="\/research" \/>/);
  assert.match(source, /path: "\/watchlist", element: <Moved to="\/my-stocks" tab="watch" \/>/);
  assert.match(source, /path: "\/portfolio", element: <Moved to="\/my-stocks" tab="hold" \/>/);
  // 多空辩论 10-09 又回到单独一页（研究工具下）；个股页旧的 ?tab=debate 由个股页自己跳过去
  assert.match(source, /path: "\/debate", lazy: async \(\) => \(\{ Component: \(await import\("@\/pages\/Debate"\)\)\.DebatePage \}\)/);
  assert.doesNotMatch(source, /<Moved to="\/research" tab="debate"/);
  assert.doesNotMatch(source, /^import .* from "@\/pages\/(?!Home|Settings)/m);
  assert.match(source, /hydrateFallbackElement:/);
  assert.match(source, /errorElement: <RouteErrorPage/);
});
