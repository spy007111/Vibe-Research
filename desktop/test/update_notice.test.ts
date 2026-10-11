import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { announceUpdate, onUpdateChanged, updateStatusText, upgradeSteps, type UpdateInfo } from "../src/verticals/finance/lib/update.ts";

const src = (rel: string) => fs.readFileSync(new URL(`../src/verticals/finance/${rel}`, import.meta.url), "utf8");
const info = (patch: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "2.0.0", install: "source", enabled: true, env_disabled: false, skip_version: null, checked_at: "2026-10-09T08:00:00Z",
  latest: { version: "2.1.0", url: "https://github.com/simonlin1212/Vibe-Research/releases/tag/v2.1.0", published_at: null },
  error: null, update_available: true, ...patch,
});

test("新版提示:免安装包和源码安装各说各的升级做法", () => {
  const p = upgradeSteps("portable");
  assert.match(p, /解压到一个新文件夹/);
  assert.match(p, /旧文件夹里的 \.local 整个复制过去/);
  assert.match(p, /Command\+Shift\+\./, "Mac 的访达默认看不到 .local,要说怎么显示");
  assert.ok(!/git pull/.test(p));
  const s = upgradeSteps("source");
  assert.match(s, /先备份 \.local/);
  assert.match(s, /git pull/);
  assert.match(s, /scripts\/setup/);
  assert.match(s, /setup-windows\.cmd/);
});

test("新版提示:设置页状态一句话分清关着 / 没查过 / 查失败 / 最新 / 有新版 / 已跳过", () => {
  assert.match(updateStatusText(info({ env_disabled: true, update_available: false })), /VRA_UPDATE_CHECK=0/);
  assert.match(updateStatusText(info({ enabled: false, update_available: false })), /已关掉/);
  assert.match(updateStatusText(info({ error: "GitHub 返回 502", update_available: false })), /没成功：GitHub 返回 502/);
  assert.equal(updateStatusText(info({ checked_at: null, latest: null, update_available: false })), "还没检查过。");
  assert.equal(updateStatusText(info()), "有新版本 v2.1.0。");
  assert.match(updateStatusText(info({ skip_version: "2.1.0", update_available: false })), /v2\.1\.0 已设为不再提示/);
  assert.equal(updateStatusText(info({ latest: { version: "2.0.0", url: "u", published_at: null }, update_available: false })), "已是最新版本。");
});

test("新版提示:接口调用 GET /update 与 POST /update {action, version}", async () => {
  const orig = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(info()), { status: 200 });
  }) as typeof fetch;
  try {
    await backend.update();
    await backend.updateAct("skip", "2.1.0");
    await backend.updateAct("disable");
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls[0].url, "/api/update");
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { action: "skip", version: "2.1.0" });
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { action: "disable" });
});

test("新版提示界面:顶部提示条只在有新版时出现、查失败不打扰;设置页能重新打开并看到原因", () => {
  const layout = src("components/layout/Layout.tsx");
  assert.match(layout, /<\/header>\n\s*<UpdateBanner \/>\n\s*<main /, "提示条在顶栏和正文之间");
  const banner = src("components/layout/UpdateBanner.tsx");
  assert.match(banner, /if \(hidden \|\| !info\?\.update_available \|\| !latest\) return null;/);
  assert.match(banner, /\.catch\(\(\) => \{ \/\* 只是提示/);
  assert.match(banner, /target="_blank" rel="noreferrer"/);
  for (const t of ["这个版本不再提示", "关掉新版提示", "这次先不提示", "upgradeSteps(info.install)", "action === \"skip\" ? latest.version : undefined"]) assert.ok(banner.includes(t), t);
  const settings = src("pages/Settings.tsx");
  assert.match(settings, /<UpdateSettingsCard \/>/);
  assert.ok(settings.indexOf("<UpdateSettingsCard />") > settings.indexOf("</details>"), "不藏进「高级运行信息」");
  const card = src("components/UpdateSettingsCard.tsx");
  for (const t of ["有新版时提示我", "现在检查", "恢复提示 v{info.skip_version}", "updateStatusText(info)", "只发送当前版本号", "{err && <p role=\"alert\""]) assert.ok(card.includes(t), t);
  assert.match(card, /disabled=\{busy \|\| info\.env_disabled\}/, "环境变量关掉时开关不可点");
  // 两边改了开关互相通知,不用刷新
  assert.ok(banner.includes("setInfo(announceUpdate(await backend.updateAct(") && card.includes("setInfo(announceUpdate(await backend.updateAct(action)))"));
  assert.ok(banner.includes("onUpdateChanged((u) => { setInfo(u); setHidden(false); })") && card.includes("return onUpdateChanged(setInfo);"));
});

test("新版提示:一边改了开关就广播,另一边收到同一份状态;取消订阅后不再收", () => {
  const g = globalThis as { window?: EventTarget };
  const had = "window" in g;
  const prev = g.window;
  g.window = new EventTarget();
  try {
    const got: UpdateInfo[] = [];
    const off = onUpdateChanged((u) => got.push(u));
    const u = info({ enabled: false, update_available: false });
    assert.equal(announceUpdate(u), u);
    assert.deepEqual(got, [u]);
    off();
    announceUpdate(info());
    assert.equal(got.length, 1);
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
});
