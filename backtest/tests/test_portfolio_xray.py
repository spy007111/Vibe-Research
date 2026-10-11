"""持仓体检：风险贡献手算对照、按币种分组、缺口、停牌补价、申万行业暴露、港美股 GICS 行业暴露、入参校验。"""
from __future__ import annotations

import io
import json
import math
import os
import sys

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import portfolio_xray as X  # noqa: E402
from backtest.risk_xray import compute_risk_xray  # noqa: E402
import sources.sw as swmod  # noqa: E402  (kline 导入时已把取数层脚本目录放进 sys.path)
import sources.eastmoney as emmod  # noqa: E402
from backtest import gics as G  # noqa: E402


def _prices(rets, start=100.0):
    return list(start * np.cumprod(1 + np.asarray(rets, dtype=float)))


def test_risk_contribution_matches_hand_calculation():
    rng = np.random.default_rng(7)
    a = rng.normal(0, 0.01, 300)
    b = rng.normal(0, 0.02, 300)
    idx = pd.bdate_range("2025-01-01", periods=301)
    closes = pd.DataFrame({"A": [100.0] + _prices(a), "B": [100.0] + _prices(b)}, index=idx)
    x = compute_risk_xray(closes, {"A": 0.6, "B": 0.4})
    r = closes.pct_change().dropna()
    cov = r.cov().to_numpy()
    w = np.array([0.6, 0.4])
    var = w @ cov @ w
    want = {"A": 0.6 * (cov @ w)[0] / var, "B": 0.4 * (cov @ w)[1] / var}
    got = x["risk_contribution"]["shares"]
    assert got["A"] == pytest.approx(want["A"]) and got["B"] == pytest.approx(want["B"])
    assert sum(got.values()) == pytest.approx(1.0), "各只的风险贡献加起来是 100%"
    assert got["B"] > 0.4, "波动大的那只风险贡献高于它的资金占比"
    assert x["asset_vol_annualized"]["B"] == pytest.approx(r["B"].std() * math.sqrt(252))
    m = x["correlation_matrix"]
    assert m["symbols"] == ["A", "B"] and m["values"][0][0] == pytest.approx(1.0)
    assert m["values"][0][1] == pytest.approx(m["values"][1][0])
    json.dumps(x, allow_nan=False)


def test_single_asset_has_full_risk_share():
    idx = pd.bdate_range("2025-01-01", periods=80)
    closes = pd.DataFrame({"A": _prices(np.linspace(-0.01, 0.01, 80))}, index=idx)
    x = compute_risk_xray(closes, {"A": 1.0})
    assert x["risk_contribution"]["shares"] == {"A": pytest.approx(1.0)}


# ── 工具层：假 K 线 + 假申万 ──

def _fake_series(n=250, seed=0, start="2025-10-01", missing=()):
    rng = np.random.default_rng(seed)
    dates = [d.date().isoformat() for d in pd.bdate_range(start, periods=n)]
    close = _prices(rng.normal(0, 0.015, n))
    for i in missing:
        close[i] = None
    return dates, close


#: 港美股行业：代码 → 东财公司资料（{} = 东财没有这只的公司资料；不在表里 = 抛错）
_GLOBAL = {"AAPL": {"industry": "电脑硬件、储存设备及电脑周边", "gics_path": None},
           "MSFT": {"industry": "系统软件", "gics_path": None},
           "00700": {"industry": "软件服务", "gics_path": "通讯服务-媒体与娱乐-互动媒体与服务-互动媒体与服务"}}


def _install(monkeypatch, *, specs=None, fail=(), industry=None, sw_error=(), unadjusted=(), global_ind=None):
    """specs: 代码 → (n, seed, missing)。fail: 这些代码取数报错。"""
    specs = specs or {}
    calls = []

    def fake_build(req, out_dir):
        code = req["symbol"]
        calls.append(code)
        assert req == {"symbol": code, "period": "day", "adjust": "qfq", "charts": True}
        if code in fail:
            raise X.kline.KlineError(f"{code} 取不到")
        n, seed, missing = specs.get(code, (250, len(calls), ()))
        dates, close = _fake_series(n, seed, missing=missing)
        if missing:
            # 停牌日在真实数据里是**整行没有**，不是 None
            keep = [i for i in range(n) if i not in missing]
            dates, close = [dates[i] for i in keep], [close[i] for i in keep]
        src = "Yahoo chart" if "." not in code or code.endswith(".HK") else "腾讯 K 线、新浪复权因子"
        return {"source": src, "fetched_at": "2026-10-08T15:00:00+08:00", "adjust_label": "前复权",
                "adjust": "none" if code in (unadjusted or ()) else "qfq",
                "ui_only": {"series": {"dates": dates, "close": close}}}

    def fake_sw(code, as_of=None):
        if code in sw_error:
            raise RuntimeError("申万站点超时")
        l1 = (industry or {}).get(code)
        return {"code": code, "as_of": "2026-10-08", "current": {"l1_code": l1} if l1 else None, "history": []}

    def fake_global(code, market):
        table = _GLOBAL if global_ind is None else global_ind
        if code not in table:
            raise ValueError(f"东财未收录美股 {code}")
        return table[code]

    monkeypatch.setattr(X.kline, "build", fake_build)
    monkeypatch.setattr(swmod, "sw_industry", fake_sw)
    monkeypatch.setattr(emmod, "global_industry", fake_global)
    return calls


def test_groups_by_currency_and_weights_stay_within_group(monkeypatch, tmp_path):
    _install(monkeypatch, industry={"600519": "340000", "000858": "340000", "300750": "630000"})
    r = X.build({"positions": [
        {"symbol": "600519", "name": "茅台", "value": 500}, {"symbol": "000858", "name": "五粮液", "value": 300},
        {"symbol": "300750", "value": 200}, {"symbol": "AAPL", "name": "苹果", "value": 9000},
    ]}, tmp_path)
    assert [g["currency"] for g in r["groups"]] == ["CNY", "USD"], "人民币和美元分开体检"
    cny, usd = r["groups"]
    assert cny["total_value"] == 1000 and usd["total_value"] == 9000
    w = {p["symbol"]: p["weight"] for p in cny["positions"]}
    assert w == {"600519.SH": 0.5, "000858.SZ": 0.3, "300750.SZ": 0.2}, "美元那只不进人民币组的权重"
    assert cny["metrics"]["top1"] == {"symbol": "600519.SH", "name": "茅台", "weight": 0.5}
    assert cny["metrics"]["top3_weight"] == pytest.approx(1.0)
    buckets = {b["name"]: b["weight"] for b in cny["industry"]["buckets"]}
    assert buckets == {"食品饮料": pytest.approx(0.8), "电力设备": pytest.approx(0.2)}
    assert "申万 2021 一级行业" in cny["industry"]["classification"]
    assert usd["industry"]["buckets"] == [{"name": "信息技术", "weight": 1.0, "symbols": ["AAPL"]}]
    assert usd["positions"][0]["industry"] == "信息技术" and usd["positions"][0]["industry_detail"] == "电脑硬件、储存设备及电脑周边"
    assert "industry_detail" not in cny["positions"][0], "A 股没有细分行业这一项"
    assert usd["metrics"]["top1"]["weight"] == 1.0 and usd["metrics"]["max_corr_pair"] is None
    shares = [p["risk_share"] for p in cny["positions"]]
    assert sum(shares) == pytest.approx(1.0)
    assert "ui_only" not in r and "_matrix" not in cny, "Agent 那条路不带相关性矩阵"
    json.dumps(r, allow_nan=False)


def test_correlation_matrix_only_with_charts_flag(monkeypatch, tmp_path):
    _install(monkeypatch, industry={"600519": "340000", "000858": "340000"})
    r = X.build({"charts": True, "positions": [{"symbol": "600519", "value": 1}, {"symbol": "000858", "value": 1},
                                               {"symbol": "AAPL", "value": 1}]}, tmp_path)
    m = r["ui_only"]["correlation"]
    assert set(m) == {"CNY", "USD"} and m["CNY"]["symbols"] == ["600519.SH", "000858.SZ"]
    assert len(m["CNY"]["values"]) == 2 and m["USD"]["values"] == [[pytest.approx(1.0)]]


def test_missing_value_bad_code_and_fetch_failure_go_to_gaps(monkeypatch, tmp_path):
    _install(monkeypatch, fail={"920001.BJ"}, industry={"600519": "340000", "300750": "630000"})
    r = X.build({"positions": [
        {"symbol": "600519", "value": 700}, {"symbol": "300750", "value": 100},
        {"symbol": "920001", "name": "北交所", "value": 200}, {"symbol": "000001", "value": None},
        {"symbol": "EURUSD", "value": 5},
    ]}, tmp_path)
    top = {g["symbol"]: g["reason"] for g in r["gaps"]}
    assert "没有现价" in top["000001.SZ"] and "认不出" in top["EURUSD"]
    cny = r["groups"][0]
    assert [g["symbol"] for g in cny["gaps"]] == ["920001.BJ"] and "历史价格没取到" in cny["gaps"][0]["reason"]
    assert cny["total_value"] == 1000 and cny["positions_included"] == 2
    assert {p["symbol"]: p["weight"] for p in cny["positions"]} == {"600519.SH": 0.875, "300750.SZ": 0.125}
    assert any("80.0%" in n for n in cny["notes"]), "说清权重只在算得出来的几只之间分配"


def test_short_history_is_a_gap_not_a_shortened_window(monkeypatch, tmp_path):
    _install(monkeypatch, specs={"688001.SH": (40, 3, ())}, industry={"600519": "340000", "688001": "270000"})
    r = X.build({"positions": [{"symbol": "600519", "value": 1}, {"symbol": "688001", "value": 1}]}, tmp_path)
    g = r["groups"][0]
    assert [x["symbol"] for x in g["gaps"]] == ["688001.SH"] and "只有 40 个交易日" in g["gaps"][0]["reason"]
    assert g["metrics"]["window"]["days"] > 200


def test_halted_days_are_filled_and_reported(monkeypatch, tmp_path):
    _install(monkeypatch, specs={"600519.SH": (250, 1, tuple(range(100, 110)))},
             industry={"600519": "340000", "000858": "340000"})
    r = X.build({"positions": [{"symbol": "600519", "value": 1}, {"symbol": "000858", "value": 1}]}, tmp_path)
    g = r["groups"][0]
    assert any("600519.SH 窗口内有 10 个交易日没有价格" in n for n in g["notes"])
    assert g["metrics"]["window"]["days"] >= 240, "一只停牌不把共同区间砍短"


def test_etf_bucket_and_industry_failures(monkeypatch, tmp_path):
    _install(monkeypatch, industry={"600519": "340000", "600000": "999999"}, sw_error={"000858"})
    r = X.build({"positions": [
        {"symbol": "600519", "value": 1}, {"symbol": "510300", "value": 1},
        {"symbol": "000858", "name": "五粮液", "value": 1}, {"symbol": "600000", "value": 1},
    ]}, tmp_path)
    g = r["groups"][0]
    names = {b["name"] for b in g["industry"]["buckets"]}
    assert names == {"食品饮料", X.FUND_INDUSTRY, "行业未取到"}
    reasons = {x["symbol"]: x["reason"] for x in g["gaps"]}
    assert "申万行业没取到" in reasons["000858.SZ"] and "不在名称表里" in reasons["600000.SH"]
    assert next(x for x in g["gaps"] if x["symbol"] == "000858.SZ")["name"] == "五粮液"


def test_duplicate_codes_are_merged(monkeypatch, tmp_path):
    calls = _install(monkeypatch, industry={"600519": "340000"})
    r = X.build({"positions": [{"symbol": "600519", "value": 100}, {"symbol": "600519.SH", "name": "茅台", "value": 50}]}, tmp_path)
    assert calls == ["600519.SH"]
    assert r["groups"][0]["positions"][0]["value"] == 150 and r["groups"][0]["positions"][0]["name"] == "茅台"


@pytest.mark.parametrize("req, msg", [
    ({}, "没有持仓"),
    ({"positions": []}, "没有持仓"),
    ({"positions": [{"symbol": "600519", "value": 1}] * 61}, "最多"),
    ({"positions": ["600519"]}, "对象"),
    ({"positions": [{"value": 1}]}, "代码"),
])
def test_bad_requests(req, msg, tmp_path):
    with pytest.raises(X.XrayError, match=msg):
        X.build(req, tmp_path)


def test_bool_and_nonfinite_values_are_gaps(monkeypatch, tmp_path):
    _install(monkeypatch, industry={"600519": "340000"})
    r = X.build({"positions": [{"symbol": "600519", "value": 1}, {"symbol": "000858", "value": True},
                               {"symbol": "300750", "value": -5}]}, tmp_path)
    assert {g["symbol"] for g in r["gaps"]} == {"000858.SZ", "300750.SZ"}


def test_sw_l1_table_has_31_industries():
    assert len(X.SW_L1) == 31 and len(set(X.SW_L1.values())) == 31
    assert all(code.endswith("0000") and len(code) == 6 for code in X.SW_L1)


def test_main_catalog_and_error_are_json(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"action":"catalog"}'))
    X.main()
    cat = json.loads(capsys.readouterr().out)
    assert cat["ok"] is True and "不出综合分" in cat["catalog"]["description"]
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"positions":[]}'))
    X.main()
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False and "没有持仓" in out["error"]
    blob = json.dumps(cat, ensure_ascii=False)
    assert not any(w in blob for w in ("评分", "得分", "建议买入", "建议卖出", "目标价")), "只给数字，不打分、不给建议"


def test_unadjusted_prices_are_named_not_called_forward_adjusted(monkeypatch, tmp_path):
    """K 线工具说某只没有复权因子（如部分 ETF）：不能笼统写「A 股价格是前复权」。"""
    _install(monkeypatch, unadjusted={"510300", "510300.SH"})
    g = X.build({"positions": [{"symbol": "600519", "value": 1}, {"symbol": "510300", "value": 1}]}, tmp_path)["groups"][0]
    assert any("前复权" in n for n in g["notes"])
    assert any(n.startswith("510300.SH 没有复权因子") for n in g["notes"]), g["notes"]
    _install(monkeypatch, unadjusted={"510300", "510300.SH"})
    g = X.build({"positions": [{"symbol": "510300", "value": 1}]}, tmp_path / "b")["groups"][0]
    assert not any("前复权" in n for n in g["notes"]), "这一组没有一只是前复权"


# ── 港美股 GICS 行业暴露 ──

def test_gics_table_maps_each_name_to_one_sector():
    names = [n for ns in G._BY_SECTOR.values() for n in ns]
    assert len(names) == len(set(names)) == len(G.US_INDUSTRY_SECTOR) == 156, "一个名字只在一个一级行业里"
    assert list(G._BY_SECTOR) == G.GICS_SECTORS and len(G.GICS_SECTORS) == 11
    # GICS 2023 版的几处调整：支付处理在金融、数据处理外包在工业、抵押 REIT 在金融、其余 REIT 在房地产
    for name, sector in (("交易与支付处理服务", "金融"), ("数据处理与外包服务", "工业"), ("抵押房地产投资信托", "金融"),
                         ("写字楼REIT", "房地产"), ("多品类零售", "非日常生活消费品"), ("半导体产品", "信息技术"), ("互动媒体与服务", "通讯服务")):
        assert G.us_sector(name) == sector, name
    assert G.us_sector(" 系统软件 ") == "信息技术" and G.us_sector("不存在的行业") is None and G.us_sector(None) is None
    assert G.hk_sector("信息技术-半导体产品与设备-半导体产品与设备-半导体产品") == "信息技术"
    assert G.hk_sector("信息技术-半导体") is None and G.hk_sector("科技-a-b-c") is None and G.hk_sector(None) is None


def test_global_industry_buckets_and_gaps(monkeypatch, tmp_path):
    table = {**_GLOBAL, "SPY": {}, "NEWCO": {"industry": "太空采矿", "gics_path": None}, "BLANK": {"industry": None, "gics_path": None},
             "09999": {"industry": "软件服务", "gics_path": None}, "00005": {"industry": "银行", "gics_path": "金融-银行-银行-综合性银行"},
             "02800": {"industry": None, "gics_path": None}}
    _install(monkeypatch, global_ind=table)
    r = X.build({"positions": [
        {"symbol": "AAPL", "name": "苹果", "value": 400}, {"symbol": "MSFT", "value": 200}, {"symbol": "SPY", "name": "标普500ETF", "value": 200},
        {"symbol": "NEWCO", "value": 100}, {"symbol": "BLANK", "value": 50}, {"symbol": "BRKX", "value": 50},
        {"symbol": "00700.HK", "name": "腾讯", "value": 600}, {"symbol": "09999.HK", "value": 200}, {"symbol": "00005.HK", "value": 200},
        {"symbol": "02800.HK", "name": "盈富基金", "value": 100},
    ]}, tmp_path)
    hkd, usd = r["groups"]
    assert hkd["currency"] == "HKD" and usd["currency"] == "USD"
    ub = {b["name"]: (b["weight"], b["symbols"]) for b in usd["industry"]["buckets"]}
    assert ub["信息技术"] == (pytest.approx(0.6), ["AAPL", "MSFT"])
    assert ub[X.NO_PROFILE] == (pytest.approx(0.25), ["SPY", "BLANK"]), "没有公司资料、或资料里没写行业的单独一组，不当成行业没取到"
    assert ub[X.NO_INDUSTRY][1] == ["NEWCO", "BRKX"]
    assert "GICS 一级行业" in usd["industry"]["classification"]
    reasons = {g["symbol"]: g["reason"] for g in usd["gaps"]}
    assert reasons["NEWCO"] == "东财行业「太空采矿」不在 GICS 对照表里"
    assert reasons["BRKX"].startswith("行业没取到：ValueError: 东财未收录美股") and "SPY" not in reasons and "BLANK" not in reasons
    assert next(g for g in usd["gaps"] if g["symbol"] == "BRKX")["name"] == "", "缺口带上名字（没填就空）"
    pos = {p["symbol"]: p for p in usd["positions"]}
    assert pos["NEWCO"]["industry"] is None and pos["NEWCO"]["industry_detail"] == "太空采矿"
    assert pos["SPY"]["industry"] == X.NO_PROFILE and "industry_detail" not in pos["SPY"]
    hb = {b["name"]: b["symbols"] for b in hkd["industry"]["buckets"]}
    assert hb == {"通讯服务": ["00700.HK"], "金融": ["00005.HK"], X.NO_INDUSTRY: ["09999.HK"], X.NO_PROFILE: ["02800.HK"]}, \
        "港股按 GICS 路径第一段，不拿东财另一套行业名去猜；资料里行业全空的（盈富基金）归没有行业资料"
    assert {g["symbol"]: g["reason"] for g in hkd["gaps"]} == {"09999.HK": "东财公司资料里没有这只的 GICS 行业"}
    assert {p["symbol"]: p.get("industry_detail") for p in hkd["positions"]}["00700.HK"] == "软件服务"
    json.dumps(r, allow_nan=False)
