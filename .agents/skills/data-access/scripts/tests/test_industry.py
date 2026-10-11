"""产业温度计(第 13 层)离线测试:FinMind 月营收 / Vast 现货 / Kalshi 远期的取数、三分判定、差分读法与 mapper 证据形状。不访问网络。"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(SCRIPTS, "..", "..", "..", ".."))
sys.path.insert(0, SCRIPTS)
from sources import industry, mappers_industry  # noqa: E402

NOW = datetime(2026, 8, 23, tzinfo=timezone.utc)


class R:
    def __init__(self, status, body, raw="raw/x.json"):
        self.status_code, self._body, self._vra_raw_ref = status, body, raw
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return self._body if not isinstance(self._body, str) else json.loads(self._body)


def _months(ticker, base, months=20, growth=1.05):
    rows, v = [], base
    y, m = 2025, 1
    for _ in range(months):
        rows.append({"revenue_year": y, "revenue_month": m, "revenue": v, "stock_id": ticker})
        v *= growth
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return rows


def test_tw_monthly_revenue_rows_differential_and_partial(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        t = params["data_id"]
        if t == "3081":
            return R(402, "Payment Required: quota exceeded")
        data = _months(t, 1e10 if t == "2383" else 5e9, growth=1.05 if t != "2368" else 0.98)
        return R(200, {"data": data}, raw=f"raw/finmind_{t}.json")

    monkeypatch.setattr(industry, "http_get", fake_get)
    r = industry.tw_monthly_revenue("2383,6274,2368,3081", now=NOW)
    assert [c["ticker"] for c in r["companies"]] == ["2383", "6274", "2368"] and r["errors"][0]["ticker"] == "3081" and "402" in r["errors"][0]["error"]
    c = r["companies"][0]
    assert c["latest_period"] == "2026-08" and c["mom_pct"] == 5.0 and c["yoy_pct"] == round((1.05 ** 12 - 1) * 100, 1) and c["raw_ref"] == "raw/finmind_2383.json"
    assert len(c["mom_seq_pct"]) == 4 and c["cum_yoy_pct"] is not None and c["stale"] is False
    assert r["differential"]["reading"].startswith("台光环比增而金像电平 / 负"), r["differential"]
    m = mappers_industry.tw_monthly_revenue_map(r, {"script": "tw_monthly_revenue", "symbol": "MARKET", "market": "CN", "source": "finmind", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m["status"] == "partial" and "402" in m["degraded"]
    f = [e for e in m["evidence"] if e["field"] == "tw_monthly_revenue" and e["symbol"] == "2383"][0]
    assert f["market"] == "TW" and f["currency"] == "TWD" and f["unit"] == "亿新台币" and f["period"] == "2026-08-01..2026-08-31" and f["raw_ref"] == "raw/finmind_2383.json"
    assert "读法:" in f["note"] and "差分" in f["note"]
    diff = [e for e in m["evidence"] if e["field"] == "tw_chain_differential"][0]
    assert diff["unit"] == "text" and "ccl_2383_mom_pct=5.0" in diff["note"]
    keys = [(e["field"], e["symbol"]) for e in m["evidence"]]
    assert len(keys) == len(set(keys))


def test_tw_differential_needs_the_same_month(monkeypatch):
    """第四轮审计 B6:台光已公布到八月、金像电还停在七月 —— 两个环比不是同一个月,不出差分读法,列进缺口。"""
    def fake_get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        t = params["data_id"]
        return R(200, {"data": _months(t, 1e10, months=20 if t == "2383" else 19, growth=1.05 if t == "2383" else 0.98)}, raw=f"raw/finmind_{t}.json")

    monkeypatch.setattr(industry, "http_get", fake_get)
    r = industry.tw_monthly_revenue("2383,2368", now=NOW)
    assert [c["latest_period"] for c in r["companies"]] == ["2026-08", "2026-07"]
    assert r["differential"]["reading"] is None
    m = mappers_industry.tw_monthly_revenue_map(r, {"script": "tw_monthly_revenue", "symbol": "MARKET", "market": "CN", "source": "finmind", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert not [e for e in m["evidence"] if e["field"] == "tw_chain_differential"]
    assert m["status"] == "partial" and any("最新月份不同" in x for x in m["missing"])


def test_tw_monthly_revenue_all_fail_and_stale(monkeypatch):
    monkeypatch.setattr(industry, "http_get", lambda *a, **k: R(500, "boom"))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.tw_monthly_revenue("2383", now=NOW)
    # 资料期过期(最新 2026-03,now 2026-08)→ stale → mapper partial
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": _months(params["data_id"], 1e9, months=15)}))
    r = industry.tw_monthly_revenue("2383", now=NOW)
    assert r["companies"][0]["latest_period"] == "2026-03" and r["companies"][0]["stale"] is True
    m = mappers_industry.tw_monthly_revenue_map(r, {"script": "x", "symbol": "MARKET", "market": "CN", "source": "finmind", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m["status"] == "partial" and "过期" in m["degraded"]
    # 数值无效 → 该家报错
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": [{"revenue_year": 2026, "revenue_month": 7, "revenue": -5}]}))
    with pytest.raises(industry.IndustryError):
        industry.tw_monthly_revenue("2383", now=NOW)


# ---------- 500.farm(Prometheus 代理)响应构造器 ----------
def _farm(values):
    """values = [[unix秒, "价格字符串"], ...];传 [] 表示"统计站没有这个型号的序列"。"""
    return {"data": {"result": ([{"values": values}] if values else [])}}


def _farm_count_body(available, total):
    return {"data": {"result": [{"metric": {"rented": "no"}, "value": [0, str(available)]},
                                {"metric": {"rented": "any"}, "value": [0, str(total)]}]}}


def test_gpu_rent_three_way_and_mapper(monkeypatch):
    """现货 = 曲线最后一点(同源同算法)+ 远期三分判定 + mapper 证据形状。"""
    kalshi = {"markets": [{"ticker": "KXB200MS-26SEP-3", "yes_bid": 60, "yes_ask": 70}, {"ticker": "KXB200MS-26SEP-5", "last_price": 20}, {"ticker": "KXB200MS-26SEP-X"}]}
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        calls.append((url[:60], headers))
        if "500.farm" in url:
            if "gpu_count" in url:
                return R(200, _farm_count_body(120, 400), raw="raw/count.json")
            if "A100" in url:
                return R(200, _farm([]), raw="raw/a100.json")          # 统计站无该型号序列
            if "H100" in url:
                return R(200, _farm([[1000, "2.5"], [86400, "2.66"]]), raw="raw/h100.json")
            return R(200, _farm([[1000, "6.0"], [86400, "NaN"], [172800, "6.4"]]), raw="raw/b200.json")
        return R(200, kalshi, raw="raw/kalshi.json")

    monkeypatch.setattr(industry, "http_get", fake_get)
    g = industry.gpu_rent_thermometer(now=NOW)

    # 曲线：NaN 被丢掉（它一旦进 JSON,下游序列化会整条端点失败）
    b_hist = g["history"][0]
    assert b_hist["gpu"] == "B200" and b_hist["n_points"] == 2 and b_hist["dropped"] == 1
    assert b_hist["points"][-1] == [172800, 6.4]

    # 🔴 现货必须**等于**曲线最后一点 —— 这是这个端点的核心不变量
    b_spot = g["spot"][0]
    assert b_spot["median_usd_per_gpu_hr"] == b_hist["latest"] == 6.4
    assert b_spot["asof_ts"] == 172800 and b_spot["available_gpus"] == 120 and b_spot["total_gpus"] == 400
    assert b_spot["below_depreciation_line"] is False
    assert g["spot"][1]["median_usd_per_gpu_hr"] == 2.66
    # 无序列的那张卡：unavailable(市场状态),不是 error
    assert g["spot"][2]["unavailable"] is True and "error" not in g["spot"][2]

    f = g["forward"]
    assert f["n_rungs"] == 2 and f["lowest_strike"] == 3.0 and f["p_below_lowest"] == 0.35

    m = mappers_industry.gpu_rent_thermometer_map(g, _ctx())
    assert m["status"] == "ok"
    fields = {(e["field"], e["symbol"]): e for e in m["evidence"]}
    spot = fields[("gpu_spot_median_usd_per_gpu_hr", "B200")]
    assert spot["market"] == "US" and spot["currency"] == "USD" and spot["unit"] == "美元/卡时" and spot["value"] == 6.4
    assert spot["raw_ref"] == "raw/b200.json" and "折旧参考线" in spot["note"] and "asof_ts=172800" in spot["note"]
    # 🔴 现货的资料期 = **曲线末点自己的日期**,不是取数日。
    #    标成取数日的话,上游停更几天后陈旧读数会看着像当天的 —— 而这个温度计的用处
    #    正是判"还热不热"。ts=172800 → 1970-01-03（UTC）
    assert spot["period"] == "1970-01-03" and spot["as_of"] == "1970-01-03"
    # 🔴 没有统计序列的卡:发 status 型证据,**不发 `gpu_available_count = 0`**。
    #    上游只说了"没有序列",没说"当前可租 0 张" —— 0 是一个我们并不知道成不成立的断言。
    assert ("gpu_available_count", "A100 SXM4") not in fields, "未覆盖不能造出一个数值证据"
    st = fields[("gpu_spot_status", "A100 SXM4")]
    assert st["value"] == "unavailable" and st["unit"] == "status" and "未覆盖≠可租 0 张" in st["note"]
    assert fields[("gpu_forward_p_below_lowest_strike", "B200")]["value"] == 0.35
    # 曲线走 extra(它是序列不是证据),且带上来源与天数
    hx = m["extra"]["history"]
    assert len(hx["gpus"]) == 3 and hx["days"] == industry.FARM_DAYS and "500.farm" in (hx["source"] or "")


def test_gpu_rent_failure_modes(monkeypatch):
    # 曲线全失败 + Kalshi ticker 全不可解析 → 抛(两边都没东西才算真失败)
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(500, "boom") if "500.farm" in url else R(200, {"markets": [{"ticker": "WEIRD"}]}))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.gpu_rent_thermometer(now=NOW)
    # 曲线 429 但远期正常 → 不抛,mapper partial **出声**
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(429, "rate limited") if "500.farm" in url else R(200, {"markets": [{"ticker": "KXB200MS-26SEP-3", "last_price": 50}]}))
    g = industry.gpu_rent_thermometer(now=NOW)
    m = mappers_industry.gpu_rent_thermometer_map(g, _ctx())
    assert m["status"] == "partial" and "429" in m["degraded"]
    assert any(e["field"] == "gpu_forward_p_below_lowest_strike" for e in m["evidence"])
    # 🔴 曲线的失败原因要带到 extra 里 —— 界面上少一条线,总得有地方说为什么
    assert m["extra"]["history"]["errors"] and "429" in m["extra"]["history"]["errors"][0]
    # 返回了序列但一个点都解析不出 = 上游契约变了,是 error 不是 unavailable
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, _farm([[1, "NaN"], [2, "Inf"]])) if "500.farm" in url else R(200, {"markets": []}))
    g2 = industry.gpu_rent_thermometer(now=NOW)
    assert "无一个点可解析" in g2["history"][0]["error"] and "error" in g2["spot"][0]


def test_forward_unavailable_does_not_claim_zero_rungs():
    """🔴 远期阶梯没取到时**不发 `gpu_forward_rung_count = 0`**。

    能确定的只是"没取到有效阶梯"（未开盘 / 无成交），不是"真实档数为 0"。
    发 0 的话下游会把它当一条正常证据展示，而它是一个我们并不知道成不成立的断言。
    """
    m = mappers_industry.gpu_rent_thermometer_map(
        {"checked_at": "2026-08-27", "spot": [], "forward": {"unavailable": True}}, _ctx())
    fields = {e["field"]: e for e in m["evidence"]}
    assert "gpu_forward_rung_count" not in fields, "未覆盖不能造出一个数值证据"
    st = fields["gpu_forward_status"]
    assert st["value"] == "unavailable" and st["unit"] == "status" and "未覆盖≠档数为 0" in st["note"]


def test_registry_endpoints_and_tag_table():
    """标签表与注册表**双向**一致:每个 tag 的 thermometers 都是真端点、端点的 industry_tags 必须回指该 tag;
    每个端点的 module / mapper_module 都能导入且参数对得上(端点可以来自不同源模块,如大宗走 commodity)。"""
    import importlib
    import inspect
    reg = json.load(open(os.path.join(REPO, "datasources", "registry.json"), encoding="utf-8"))
    eps = {e["id"]: e for e in reg["endpoints"]}
    tags = json.load(open(os.path.join(REPO, "datasources", "industry_tags.json"), encoding="utf-8"))["tags"]
    seen = set()
    for tag, td in tags.items():
        assert td["thermometers"], f"{tag} 没有温度计"
        for i in td["thermometers"]:
            e = eps[i]
            seen.add(i)
            assert e["layer"] == "13 产业温度计" and e["stages"] == {"risk": "optional"} and e["symbol_kind"] == "none"
            assert tag in e["industry_tags"], f"{i} 的 industry_tags 必须回指 {tag}(单向声明会让门控与提示词对不上)"
            mod = importlib.import_module(f"sources.{e['module']}")
            mappers = importlib.import_module(f"sources.{e['mapper_module']}")
            assert hasattr(mod, e["function"]) and hasattr(mappers, e["mapper"])
            params = inspect.signature(getattr(mod, e["function"])).parameters
            assert all(k in params for k in e.get("args", {})), f"{i} 注册表参数必须被函数接受"
    # 反向:**第 13 层**带 industry_tags 的端点必须被某个 tag 的 thermometers 收录(否则取了数、提示词却不列它 → 没人写进报告);
    # 其它层(如第 15 层数据日历的 us_anchor_earnings)可以借用同一套产业门控但不算温度计,由各自的提示词条目介绍。
    tagged13 = {e["id"] for e in reg["endpoints"] if e.get("industry_tags") and e.get("layer") == "13 产业温度计"}
    assert tagged13 == seen, f"第 13 层端点与标签表不一致:仅端点声明 {tagged13 - seen} / 仅标签表列出 {seen - tagged13}"
    other = [e["id"] for e in reg["endpoints"] if e.get("industry_tags") and e.get("layer") != "13 产业温度计"]
    for i in other:
        assert all(t in tags for t in eps[i]["industry_tags"]), f"{i} 借用了不存在的产业标签"
    assert set(tags["ai_compute"]["thermometers"]) == {"tw_monthly_revenue", "gpu_rent_thermometer", "cn_commodity_futures"}
    assert "折旧参考线" in tags["ai_compute"]["guard"] and "采购价" in tags["ai_compute"]["guard"]
    assert set(tags["storage_memory"]["thermometers"]) == {"dram_spot_thermo"}
    assert "不是 HBM 价格" in tags["storage_memory"]["guard"] and "社区" in tags["storage_memory"]["guard"]


# ---------- Codex industry-r1 补的用例 ----------
def _ctx(script="x"):
    return {"script": script, "symbol": "MARKET", "market": "CN", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": "raw/last.json", "args": {}}


def test_finmind_duplicates_future_and_missing_basis(monkeypatch):
    # 同月两个不同值 → 该家报错;完全相同重复行 → 去重放行
    rows = _months("2383", 1e9, months=19) + [{"revenue_year": 2026, "revenue_month": 7, "revenue": 123.0}]
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": rows}))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.tw_monthly_revenue("2383", now=NOW)
    dup = _months("2383", 1e9, months=19); dup.append(dict(dup[-1]))
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": dup}))
    assert industry.tw_monthly_revenue("2383", now=NOW)["companies"][0]["latest_period"] == "2026-07"
    # 未来月份(now 台北 2026-08)→ 报错
    fut = _months("2383", 1e9, months=19) + [{"revenue_year": 2026, "revenue_month": 9, "revenue": 5e9}]
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": fut}))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.tw_monthly_revenue("2383", now=NOW)
    # 只有 2026-01 与 2026-03:缺前月 / 去年同月 / 累计基数 → 不抛但 missing,mapper partial
    sparse = [{"revenue_year": 2026, "revenue_month": 1, "revenue": 1e9}, {"revenue_year": 2026, "revenue_month": 3, "revenue": 2e9}]
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": sparse}))
    r = industry.tw_monthly_revenue("2383", now=NOW)
    c = r["companies"][0]
    assert c["mom_pct"] is None and c["yoy_pct"] is None and c["cum_yoy_pct"] is None and len(c["missing"]) == 3 and c["stale"] is True
    m = mappers_industry.tw_monthly_revenue_map(r, _ctx())
    assert m["status"] == "partial" and m["missing"] and all("读法:" in e["note"] for e in m["evidence"] if e["unit"] != "text")
    # 台北时区:UTC 2026-08-31 17:00 = 台北 9-1 01:00 → "当前月"是 9 月,8 月数据不算未来
    aug = _months("2383", 1e9, months=20)
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": aug}))
    r2 = industry.tw_monthly_revenue("2383", now=datetime(2026, 8, 31, 17, 0, tzinfo=timezone.utc))
    assert r2["companies"][0]["latest_period"] == "2026-08" and r2["checked_at"] == "2026-09-01"


def test_differential_binds_both_raws_and_all_numeric_notes_have_guard(monkeypatch):
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": _months(params["data_id"], 1e9)}, raw=f"raw/fm_{params['data_id']}.json"))
    r = industry.tw_monthly_revenue("2383,6274,2368,3081", now=NOW)
    m = mappers_industry.tw_monthly_revenue_map(r, _ctx())
    d = [e for e in m["evidence"] if e["field"] == "tw_chain_differential"][0]
    assert d["raw_ref"] == "raw/fm_2383.json" and "raw_ref_2368=raw/fm_2368.json" in d["note"] and d["period"].startswith("2026-08-01")
    for e in m["evidence"]:
        if e["unit"] != "text":
            assert "读法:" in e["note"], e["field"]


def test_farm_spot_derivation_contract_errors_and_isolation(monkeypatch):
    """单卡异常只影响那一张;挂单卡数拿不到不算失败;合约月不跨月混排。"""
    def fake(url, params=None, headers=None, timeout=None, ext=None, **kw):
        if "500.farm" in url:
            if "gpu_count" in url:
                raise ConnectionError("count down")      # 规模读数拿不到 → None,不算失败
            if "H100" in url:
                raise ConnectionError("boom")
            if "A100" in url:
                return R(200, _farm([[5, "0.74"]]))
            return R(200, _farm([[5, "6.0"], [10, "6.4"]]))
        return R(200, {"markets": [{"ticker": "KXB200MS-26OCT-2", "last_price": 40}, {"ticker": "KXB200MS-26SEP-3", "yes_bid": 60, "yes_ask": 70}, {"ticker": "KXB200MS-26SEP-5", "last_price": 20}]})

    monkeypatch.setattr(industry, "http_get", fake)
    g = industry.gpu_rent_thermometer(now=NOW)
    assert g["spot"][0]["median_usd_per_gpu_hr"] == 6.4
    # 挂单卡数拿不到：字段是 None，但这张卡照样有价（它是配角，不能拖垮主角）
    assert g["spot"][0]["available_gpus"] is None and g["spot"][0]["total_gpus"] is None
    assert "ConnectionError" in g["spot"][1]["error"], "单卡异常隔离成 error 项"
    assert g["spot"][2]["median_usd_per_gpu_hr"] == 0.74, "别的卡不受影响"
    f = g["forward"]

    assert f["contract_month"] == "2026-09" and f["n_rungs"] == 2 and f["lowest_strike"] == 3.0 and f["other_months"] == ["2026-10"], "只用最近合约月,不跨月混排"
    m = mappers_industry.gpu_rent_thermometer_map(g, _ctx())
    assert m["status"] == "partial" and "ConnectionError" in m["degraded"]
    fw = [e for e in m["evidence"] if e["field"] == "gpu_forward_p_below_lowest_strike"][0]
    assert fw["period"] == "2026-09-01..2026-09-30" and "contract_month=2026-09" in fw["note"] and "折旧参考线" in fw["note"]
    assert all("读法:" in e["note"] for e in m["evidence"])
    # 统计站返回空序列 = 市场状态(unavailable),不是故障;Kalshi 顶层字段缺失 = 契约错
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, _farm([])) if "500.farm" in url else R(200, {}))
    g3 = industry.gpu_rent_thermometer(now=NOW)
    assert g3["spot"][0]["unavailable"] is True and "缺少 markets" in g3["forward"]["error"]
    # Kalshi 抛异常 + 曲线正常 → 不抛,partial
    def fake2(url, **k):
        if "kalshi" in url:
            raise TimeoutError("slow")
        return R(200, _farm([[1, "7.0"]]))
    monkeypatch.setattr(industry, "http_get", fake2)
    g4 = industry.gpu_rent_thermometer(now=NOW)
    assert "TimeoutError" in g4["forward"]["error"] and mappers_industry.gpu_rent_thermometer_map(g4, _ctx())["status"] == "partial"


# ---------- Codex industry-r2 补的用例 ----------
def test_r2_point_isolation_contract_month_fullmatch_and_tz(monkeypatch):
    # 单个坏点不击穿整条曲线;全坏才是契约错
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, _farm([[1, "bad"], [2, "8.0"]])) if "500.farm" in url else R(200, {"markets": []}))
    g = industry.gpu_rent_thermometer(now=NOW)
    assert g["history"][0]["n_points"] == 1 and g["history"][0]["dropped"] == 1 and g["spot"][0]["median_usd_per_gpu_hr"] == 8.0
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, _farm([[1, "bad"]])) if "500.farm" in url else R(200, {"markets": []}))
    g2 = industry.gpu_rent_thermometer(now=NOW)
    assert "无一个点可解析" in g2["history"][0]["error"]
    # 合约月严格整体匹配
    assert industry._contract_month("26SEP") == "2026-09" and industry._contract_month("26SEPT") is None and industry._contract_month("26SEPXYZ") is None and industry._contract_month("") is None
    # GPU 快照日期按 UTC+8:UTC 08-23 17:00 = 本地 08-24
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, _farm([[1, "7.0"]])) if "500.farm" in url else R(200, {"markets": []}))
    g3 = industry.gpu_rent_thermometer(now=datetime(2026, 8, 23, 17, 0, tzinfo=timezone.utc))
    assert g3["checked_at"] == "2026-08-24" and g3["checked_tz"] == "Asia/Shanghai"
    assert mappers_industry.gpu_rent_thermometer_map(g3, _ctx())["extra"]["checked_tz"] == "Asia/Shanghai"
    # naive datetime 当 UTC
    g4 = industry.gpu_rent_thermometer(now=datetime(2026, 8, 23, 17, 0))
    assert g4["checked_at"] == "2026-08-24"
