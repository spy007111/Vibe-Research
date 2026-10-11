"""组合收益率：手算对照、公开样例（Ghostfolio 测试场景的输入与期望值）、送转与拆股、缺口、窗口、入参与 JSON 入口。"""
from __future__ import annotations

import io
import json
import math
import os
import sys
from datetime import date, timedelta

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import portfolio_perf as P  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "trade_replay_parity.json")

_n = 0


def tr(symbol, kind, day, **kw):
    global _n
    _n += 1
    return {"id": f"t{_n}", "symbol": symbol, "type": kind, "date": day, "created_at": f"2020-01-01T00:00:{_n:02d}.000Z", **kw}


def bdays(start, end):
    return [str(d.date()) for d in pd.bdate_range(start, end)]


def fake(series, fail=(), calls=None):
    """kline.build 的替身：series = {规整代码: {日期: 收盘价}}；fail 里的代码报取不到。"""
    def build(req, out_dir):
        if calls is not None:
            calls.append(dict(req))
        code = req["symbol"]
        if code in fail:
            raise P.kline.KlineError("模拟：这只取不到")
        s = series[code]
        days = sorted(s)
        return {"source": "测试行情", "fetched_at": "2026-01-01T00:00:00+08:00", "adjust": "none",
                "ui_only": {"series": {"dates": days, "close": [s[d] for d in days]}}}
    return build


def run(monkeypatch, tmp_path, trades, series, as_of, fail=(), calls=None, window="2021-01-04", **req):
    """window = 取价窗口的起点（真实运行按今天算，测试里固定，免得结果跟着日期变）。"""
    monkeypatch.setattr(P.kline, "build", fake(series, fail, calls))
    monkeypatch.setattr(P, "window_start", lambda: pd.Timestamp(window))
    return P.build({"trades": trades, "as_of": as_of, **req}, tmp_path)


def only(result):
    assert len(result["groups"]) == 1
    g = result["groups"][0]
    assert g["ok"], g
    return g


def walk(days, first, last):
    """一串收盘价：从 first 匀速走到 last，中间加点起伏（时间加权收益只取决于首尾，与中间怎么走无关的场景用）。"""
    n = len(days)
    out = {}
    for i, d in enumerate(days):
        base = first + (last - first) * i / (n - 1)
        out[d] = round(base * (1.03 if i % 3 == 1 else 0.98 if i % 3 == 2 else 1.0), 4) if 0 < i < n - 1 else (first if i == 0 else last)
    return out


# ---------------------------------------------------------------- 重放与编排器同口径

def test_replay_matches_orchestrator_fixture():
    fx = json.load(open(FIXTURE, encoding="utf-8"))
    valid, skipped, held = P.replay([P.trade_of(t) for t in fx["trades"]])
    assert [{"id": s["id"], "why": s["why"]} for s in skipped] == fx["expected"]["skipped"]
    assert set(held) == set(fx["expected"]["held"])
    for s, n in fx["expected"]["held"].items():
        assert held[s] == pytest.approx(n, abs=1e-9)
    assert len(valid) + len(skipped) == len(fx["trades"])


# ---------------------------------------------------------------- 纯计算

def test_xirr_basics():
    t0 = date(2024, 1, 1)
    # 几天里亏一成：年化贴着 −100%，在对数空间里照样解得出、不丢精度
    x = P.irr_log([(t0, -1000.0), (t0 + timedelta(days=3), 900.0)])
    assert x == pytest.approx(math.log(0.9) * 365 / 3, rel=1e-9)
    assert P.irr_log([(t0, -100.0), (t0 + timedelta(days=36500), 1e9)]) == pytest.approx(math.log(1e7) / 100, rel=1e-9)
    assert P.xirr([(t0, -100.0), (t0 + timedelta(days=365), 110.0)]) == pytest.approx(0.1, abs=1e-9)
    assert P.xirr([(t0, -100.0), (t0 + timedelta(days=730), 121.0)]) == pytest.approx(0.1, abs=1e-9)
    assert P.xirr([(t0, -100.0), (t0 + timedelta(days=365), 50.0)]) == pytest.approx(-0.5, abs=1e-9)
    assert P.xirr([(t0, -100.0), (t0 + timedelta(days=365), -5.0)]) is None, "只有投入、没有取出，解不出"
    assert P.xirr([(t0, -100.0), (t0, 110.0)]) is None, "全在同一天，没有时间跨度"
    # 中途加仓：解出来的值代回去现金流现值为 0
    flows = [(t0, -1000.0), (t0 + timedelta(days=100), -500.0), (t0 + timedelta(days=200), 300.0), (t0 + timedelta(days=400), 1400.0)]
    r = P.xirr(flows)
    assert r is not None
    assert sum(v / (1 + r) ** ((d - t0).days / 365) for d, v in flows) == pytest.approx(0, abs=1e-6)


def test_hand_calculated_twr_with_mid_period_buy(monkeypatch, tmp_path):
    # 第 1 天 10 元买 100 股（收 10），第 2 天收 11，第 3 天 11 元再买 100 股（收 12），第 4 天收 9
    # 时间加权 = 1.0 × 1.1 × (2400 / 2200) × (1800 / 2400) − 1 = −10%
    days = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("600519", "buy", days[2], shares=100, price=11)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11, 12, 9]))}, days[-1]))
    assert g["currency"] == "CNY" and g["market"] == "a_share"
    assert g["twr"] == pytest.approx(-0.1, abs=1e-6)
    assert (g["invested"], g["proceeds"], g["end_value"], g["gain"]) == (2100, 0, 900 * 2, -300)
    assert g["start"] == days[0] and g["end"] == days[-1] and g["span_days"] == 3
    assert g["twr_annualized"] is None and g["xirr"] is None, "不满一年不给年化"
    assert any("不满一年" in n for n in g["notes"])
    # 区间资金加权收益 m：按「整个区间增长 1+m」把现金流折现，现值为 0
    m = g["mwr_period"]
    npv = -1000 - 1100 / (1 + m) ** (2 / 3) + 1800 / (1 + m)
    assert npv == pytest.approx(0, abs=0.01)
    assert m < g["twr"], "加仓正赶在最后一天大跌之前：钱多的时候亏得多，资金加权比时间加权更差"


def test_annualized_only_from_one_year(monkeypatch, tmp_path):
    days = bdays("2024-01-02", "2026-01-02")
    trades = [tr("600519", "buy", days[0], shares=100, price=10)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": walk(days, 10, 12.1)}, days[-1]))
    span = (date(2026, 1, 2) - date(2024, 1, 2)).days
    assert g["span_days"] == span and g["twr"] == pytest.approx(0.21, abs=1e-6)
    assert g["twr_annualized"] == pytest.approx(1.21 ** (365 / span) - 1, abs=1e-6)
    assert g["xirr"] == pytest.approx(1.21 ** (365 / span) - 1, abs=1e-6), "只有一笔投入：资金加权年化 = 时间加权年化"
    assert g["mwr_period"] == pytest.approx(0.21, abs=1e-6)
    days = bdays("2025-01-02", "2025-12-31")   # 363 天
    g = only(run(monkeypatch, tmp_path, [tr("600519", "buy", days[0], shares=100, price=10)], {"600519.SH": walk(days, 10, 11)}, days[-1]))
    assert g["span_days"] == 363 and g["twr_annualized"] is None and g["xirr"] is None


def test_buy_fee_counts_as_money_in(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    trades = [tr("600519", "buy", days[0], shares=100, price=10, fee=5)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11]))}, days[-1]))
    assert g["twr"] == pytest.approx(1000 / 1005 * 1.1 - 1, abs=1e-6)
    assert (g["invested"], g["fees"], g["gain"]) == (1005, 5, 95)


def test_blank_fee_counts_as_zero_and_says_so(monkeypatch, tmp_path):
    """没填费用按 0 算，要说出来（只说笔数）；填了 0 的是真免佣，不提醒。"""
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("600519", "buy", days[1], shares=100, price=10, fee=0),
              tr("600519", "sell", days[2], shares=50, price=11, fee=None)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 10, 11]))}, days[-1]))
    assert g["fees"] == 0 and g["trades_without_fee"] == 2
    assert [n for n in g["notes"] if "没填费用" in n] == ["有 2 笔买卖没填费用，按 0 算：费用合计偏少，收益率可能偏高；补上费用后会更准"]
    g = only(run(monkeypatch, tmp_path, [tr("600519", "buy", days[0], shares=100, price=10, fee=0)], {"600519.SH": dict(zip(days, [10, 10, 11]))}, days[-1]))
    assert g["trades_without_fee"] == 0 and not [n for n in g["notes"] if "没填费用" in n]


def test_opening_enters_at_that_days_close_not_at_cost(monkeypatch, tmp_path):
    # 迁移来的旧记录：成本 5 元是多年前的，日期是迁移当天 —— 按成本计入会凭空多出一天 +100%
    days = ["2026-03-02", "2026-03-03"]
    trades = [tr("600519", "opening", days[0], shares=100, price=5)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11]))}, days[-1]))
    assert g["twr"] == pytest.approx(0.1, abs=1e-9)
    assert (g["invested"], g["gain"]) == (1000, 100)
    assert g["notes"] == ["区间只有 1 天，不满一年：不给年化数字（短期涨跌年化后会被放大），看区间收益", "A 股用不复权价，送转按流水里记的比例换算股数"]
    res = P.build({"trades": trades, "as_of": days[-1]}, tmp_path)
    assert res["notes"] == list(P.METHOD_NOTES) and any("期初持仓按当天收盘价计入" in n for n in res["notes"]), "共用口径只在顶层给一份"
    one = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11]))}, days[0]))
    assert one["span_days"] == 0 and one["twr"] == 0 and one["mwr_period"] is None
    assert one["notes"][0] == "流水从 2026-03-02 才开始，还没有下一个交易日可比，收益率从下一个交易日起才有变化"


# ---------------------------------------------------------------- Ghostfolio 公开测试场景（只用输入与期望数字）

def test_ghostfolio_novn_buy_and_sell(monkeypatch, tmp_path):
    days = bdays("2022-03-07", "2022-04-20")   # 价格比卖光那天长：全卖光就算到最后一笔
    trades = [tr("NOVN", "buy", "2022-03-07", shares=2, price=75.8), tr("NOVN", "sell", "2022-04-08", shares=2, price=85.73)]
    g = only(run(monkeypatch, tmp_path, trades, {"NOVN": walk(days, 76.1, 88.0)}, "2022-04-20"))
    assert g["twr"] == pytest.approx(0.13100263852242744, abs=1e-6), "一买一卖全仓：时间加权 = 卖价 / 买价 − 1，与中间怎么走无关"
    assert g["gain"] == pytest.approx(19.86, abs=0.005)
    assert g["end"] == "2022-04-08" and g["span_days"] == 32 and g["end_value"] == 0
    assert g["twr_annualized"] is None, "32 天不给年化"
    assert g["xirr"] is None, "不满一年不给年化"
    assert g["mwr_period"] == pytest.approx(171.46 / 151.6 - 1, abs=1e-6)


def test_ghostfolio_novn_partial_sell_with_fees(monkeypatch, tmp_path):
    days = bdays("2022-03-07", "2022-04-08")
    trades = [tr("NOVN", "buy", "2022-03-07", shares=2, price=75.8, fee=2.95),
              tr("NOVN", "sell", "2022-04-08", shares=1, price=85.73, fee=1.3)]
    g = only(run(monkeypatch, tmp_path, trades, {"NOVN": walk(days, 76.1, 87.8)}, "2022-04-08"))
    assert g["gain"] == pytest.approx(17.68, abs=0.005)
    assert g["fees"] == pytest.approx(4.25, abs=0.005)
    assert g["end_value"] == pytest.approx(87.8, abs=0.005)


def test_ghostfolio_jnug_round_trips_same_day(monkeypatch, tmp_path):
    days = bdays("2025-12-11", "2025-12-31")
    trades = [tr("JNUG", "buy", "2025-12-11", shares=9, price=209.45, fee=1),
              tr("JNUG", "sell", "2025-12-18", shares=9, price=210, fee=1),
              tr("JNUG", "buy", "2025-12-18", shares=10, price=204.11, fee=1),
              tr("JNUG", "sell", "2025-12-28", shares=10, price=208.01, fee=1)]   # 周日：沿用前一个收盘价
    g = only(run(monkeypatch, tmp_path, trades, {"JNUG": walk(days, 209, 207)}, "2025-12-31"))
    assert g["gain"] == pytest.approx(39.95, abs=0.005)
    assert g["fees"] == pytest.approx(4, abs=0.005)
    assert g["end"] == "2025-12-28"


def test_ghostfolio_msft_buy_with_dividend(monkeypatch, tmp_path):
    days = bdays("2021-09-16", "2021-12-31")
    trades = [tr("MSFT", "buy", "2021-09-16", shares=1, price=298.58, fee=19), tr("MSFT", "dividend", "2021-11-16", amount=0.62)]
    g = only(run(monkeypatch, tmp_path, trades, {"MSFT": walk(days, 305, 331.83)}, "2021-12-31"))
    assert g["gain"] == pytest.approx(14.87, abs=0.005)
    assert g["dividends"] == pytest.approx(0.62)


def test_ghostfolio_baln_buy_and_buy(monkeypatch, tmp_path):
    days = bdays("2021-11-22", "2021-12-17")
    trades = [tr("BALN", "buy", "2021-11-22", shares=2, price=142.9, fee=1.55),
              tr("BALN", "buy", "2021-11-30", shares=2, price=136.6, fee=1.65)]
    g = only(run(monkeypatch, tmp_path, trades, {"BALN": walk(days, 142.9, 148.9)}, "2021-12-17"))
    assert g["end_value"] == pytest.approx(595.6, abs=0.005)
    assert g["gain"] == pytest.approx(33.4, abs=0.005)
    assert g["invested"] == pytest.approx(562.2, abs=0.005), "投入含费用（Ghostfolio 的 investment 559 不含费用）"


# ---------------------------------------------------------------- 送转与拆股

def test_a_share_recorded_bonus_shares(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    series = {"600519.SH": dict(zip(days, [20, 10.5]))}   # 不复权价：10 送 10 除权
    trades = [tr("600519", "opening", days[0], shares=100, price=1), tr("600519", "split", days[1], ratio=2)]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1]))
    assert g["twr"] == pytest.approx(0.05, abs=1e-9) and g["end_value"] == 2100
    assert g["warnings"] == []


def test_a_share_unrecorded_bonus_shares_warns(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    series = {"600519.SH": dict(zip(days, [20, 10.5]))}
    trades = [tr("600519", "opening", days[0], shares=100, price=1, name="贵州茅台")]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1]))
    assert g["twr"] == pytest.approx(-0.475, abs=1e-9), "没记送转：市值按 100 股算，照实给出（同时提醒）"
    assert len(g["warnings"]) == 1
    assert "贵州茅台 2026-03-03" in g["warnings"][0] and "像是送转" in g["warnings"][0]


def test_jump_while_not_held_does_not_warn(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    series = {"600519.SH": dict(zip(days, [10, 10.5, 11])), "000001.SZ": dict(zip(days, [20, 20, 10]))}
    trades = [tr("600519", "buy", days[0], shares=100, price=10),
              tr("000001", "buy", days[0], shares=100, price=20), tr("000001", "sell", days[1], shares=100, price=20)]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1]))
    assert g["warnings"] == [], "已经卖光的那只后来价格断崖，不影响市值，不提醒"


def test_hk_split_adjusted_prices_are_restored_with_recorded_split(monkeypatch, tmp_path):
    # Yahoo 给的是拆股已调整价：实际 400 / 410 / 拆 1 变 5 后 84 → 调整后 80 / 82 / 84
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    series = {"00700.HK": dict(zip(days, [80, 82, 84]))}
    trades = [tr("00700.HK", "buy", days[0], shares=100, price=400), tr("00700.HK", "split", days[2], ratio=5)]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1]))
    assert g["currency"] == "HKD"
    assert g["twr"] == pytest.approx(0.05, abs=1e-9)
    assert (g["invested"], g["end_value"], g["gain"]) == (40000, 42000, 2000)
    assert any("拆股已调整价" in n for n in g["notes"])


def test_hk_split_restore_matters_when_money_moves_before_the_split(monkeypatch, tmp_path):
    # 单笔买入时中间几天的市值会在连乘里约掉；拆股前再加仓一笔，没还原就会算错
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    series = {"00700.HK": dict(zip(days, [80, 82, 84]))}   # 实际 400 / 410 / 拆 1 变 5 后 84
    trades = [tr("00700.HK", "buy", days[0], shares=100, price=400), tr("00700.HK", "buy", days[1], shares=100, price=410),
              tr("00700.HK", "split", days[2], ratio=5)]
    monkeypatch.setattr(P.kline, "build", fake(series))
    g = P.build({"trades": trades, "as_of": days[-1], "charts": True}, tmp_path)["groups"][0]
    assert g["twr"] == pytest.approx(84000 / 81000 - 1, abs=1e-6)
    assert g["ui_only"]["series"]["value"] == [40000, 82000, 84000], "拆股前的市值按实际价算"


# ---------------------------------------------------------------- 分组、缺口、窗口

def test_currencies_are_separate_groups(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    series = {"600519.SH": dict(zip(days, [10, 11])), "AAPL": dict(zip(days, [200, 210])), "00700.HK": dict(zip(days, [400, 380]))}
    trades = [tr("AAPL", "buy", days[0], shares=1, price=200), tr("600519", "buy", days[0], shares=100, price=10),
              tr("00700.HK", "buy", days[0], shares=100, price=400)]
    res = run(monkeypatch, tmp_path, trades, series, days[-1])
    assert [g["currency"] for g in res["groups"]] == ["CNY", "HKD", "USD"]
    assert [g["twr"] for g in res["groups"]] == [pytest.approx(0.1), pytest.approx(-0.05), pytest.approx(0.05)]


def test_symbol_without_prices_is_excluded_not_valued_at_cost(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    series = {"AAPL": dict(zip(days, [200, 210]))}
    trades = [tr("AAPL", "buy", days[0], shares=1, price=200), tr("MSFT", "buy", days[0], shares=1, price=400, name="微软")]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1], fail=("MSFT",)))
    assert [s["symbol"] for s in g["symbols"]] == ["AAPL"]
    assert g["excluded"] == [{"symbol": "MSFT", "name": "微软", "reason": "价格没取到，这只没算进收益率：模拟：这只取不到"}]
    assert g["invested"] == 200 and g["twr"] == pytest.approx(0.05)


def test_group_with_no_prices_at_all_is_not_ok(monkeypatch, tmp_path):
    trades = [tr("MSFT", "buy", "2026-03-02", shares=1, price=400)]
    res = run(monkeypatch, tmp_path, trades, {}, "2026-03-03", fail=("MSFT",))
    g = res["groups"][0]
    assert g["ok"] is False and "都没取到" in g["reason"] and "twr" not in g


def test_unrecognized_code_goes_to_gaps(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    trades = [tr("AAPL", "buy", days[0], shares=1, price=200), tr("BRK.B", "buy", days[0], shares=1, price=400)]
    res = run(monkeypatch, tmp_path, trades, {"AAPL": dict(zip(days, [200, 210]))}, days[-1])
    assert [x["symbol"] for x in res["gaps"]] == ["BRK.B"] and res["gaps"][0]["reason"].startswith("代码认不出")
    assert [s["symbol"] for s in only(res)["symbols"]] == ["AAPL"]


def test_trades_older_than_price_history_start_from_first_price(monkeypatch, tmp_path):
    days = ["2021-01-04", "2021-01-05", "2021-01-06"]
    trades = [tr("600519", "buy", "2019-01-02", shares=100, price=5), tr("600519", "dividend", "2020-06-01", amount=30)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [8, 8.4, 8.8]))}, "2021-01-06"))
    assert g["start"] == "2021-01-04"
    assert (g["invested"], g["dividends"], g["end_value"], g["gain"]) == (800, 0, 880, 80), "起算日之前的买入和分红不算，持仓按那天收盘价计入"
    assert g["twr"] == pytest.approx(0.1)
    assert any("流水比能取到的价格早" in n for n in g["notes"])


def test_late_listed_stock_does_not_push_the_whole_group_start(monkeypatch, tmp_path):
    # 审查发现：上市前申购的新股（第一根价格晚于第一笔买入）曾把整组起算日推到它上市那天，老持仓三年的收益全丢
    old = {d: 10.0 for d in bdays("2023-01-02", "2026-01-02")}
    ipo = {d: 20.0 for d in bdays("2025-12-15", "2026-01-02")}
    trades = [tr("600000", "buy", "2023-01-02", shares=1000, price=10), tr("688999", "buy", "2025-12-05", shares=500, price=15, name="新股")]
    g = only(run(monkeypatch, tmp_path, trades, {"600000.SH": old, "688999.SH": ipo}, "2026-01-02", charts=True))
    assert g["start"] == "2023-01-02" and g["invested"] == 17500
    s = g["ui_only"]["series"]
    assert s["value"][s["dates"].index("2025-12-08")] == 17500, "上市前按成交价计市值"
    assert s["value"][s["dates"].index("2025-12-15")] == 20000
    assert g["twr"] == pytest.approx(20000 / 17500 - 1, abs=1e-6)
    assert "新股 2025-12-15 之前没有收盘价（多半还没上市），那之前按成交价计市值" in g["notes"]


def test_pre_listing_value_follows_a_split_recorded_before_listing(monkeypatch, tmp_path):
    # 上市前按成交价计市值时，这中间记了送转：股数变了，每股价也要跟着除，市值不凭空翻倍
    days = bdays("2025-12-15", "2025-12-17")
    trades = [tr("00700.HK", "buy", "2025-12-05", shares=100, price=10), tr("00700.HK", "split", "2025-12-10", ratio=2)]
    g = only(run(monkeypatch, tmp_path, trades, {"00700.HK": dict(zip(days, [5, 5, 5]))}, days[-1], charts=True))
    s = g["ui_only"]["series"]
    assert [s["value"][s["dates"].index(d)] for d in ("2025-12-05", "2025-12-10", "2025-12-15")] == [1000, 1000, 1000]
    assert g["twr"] == pytest.approx(0, abs=1e-12)


def test_price_history_cut_short_far_from_buy_still_moves_start(monkeypatch, tmp_path):
    # 最早的价格明显晚于窗口起点、但离第一笔买入超过两个月：不当新股按成交价凑，照旧从有价格那天起算
    days = bdays("2024-01-02", "2024-01-05")
    trades = [tr("600519", "buy", "2023-06-01", shares=100, price=5)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [8, 8, 8, 8.8]))}, days[-1]))
    assert g["start"] == "2024-01-02" and g["invested"] == 800 and g["twr"] == pytest.approx(0.1)
    # 最早的价格就在取价窗口起点：是窗口截断，哪怕买入只早一个月也不按成交价凑
    days = bdays("2021-01-04", "2021-01-07")
    trades = [tr("600519", "buy", "2020-12-01", shares=100, price=5)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [8, 8, 8, 8.8]))}, days[-1], window="2021-01-01"))
    assert g["start"] == "2021-01-04" and g["invested"] == 800


def test_span_starts_at_first_money_in_not_at_price_window(monkeypatch, tmp_path):
    # 审查发现：早年已清仓的流水曾让区间从取价窗口起点算，一年 +20% 被摊成五年、年化只剩 3.7%
    hist = {d: 10.0 for d in bdays("2021-01-04", "2024-12-31")}
    later = bdays("2025-01-02", "2026-01-01")
    hist.update({d: 100 + 20 * i / (len(later) - 1) for i, d in enumerate(later)})
    trades = [tr("600000", "buy", "2019-03-01", shares=100, price=10), tr("600000", "sell", "2019-06-03", shares=100, price=10),
              tr("600000", "dividend", "2021-03-01", amount=50), tr("600000", "buy", "2025-01-02", shares=100, price=100)]
    g = only(run(monkeypatch, tmp_path, trades, {"600000.SH": hist}, "2026-01-01"))
    assert (g["start"], g["span_days"]) == ("2025-01-02", 364)
    assert (g["invested"], g["dividends"], g["end_value"]) == (10000, 0, 12000)
    assert g["twr"] == pytest.approx(0.2) and g["mwr_period"] == pytest.approx(0.2)
    assert "有 2 笔流水早于能取到的价格（从 2021-01-04 开始），那时已经卖光，没算进收益率" in g["notes"]
    assert "第一笔买入（2025-01-02）之前有 1 笔分红到账，那时没有持仓，没算进收益率" in g["notes"]
    assert not any("按当天收盘价计入" in n for n in g["notes"]), "起算那天没有旧持仓，不说按收盘价计入"


def test_group_with_no_money_in_inside_the_window_is_not_ok(monkeypatch, tmp_path):
    hist = {d: 10.0 for d in bdays("2021-01-04", "2021-03-05")}
    trades = [tr("600000", "buy", "2019-03-01", shares=100, price=8), tr("600000", "sell", "2019-06-03", shares=100, price=12),
              tr("600000", "dividend", "2021-03-01", amount=50)]
    g = run(monkeypatch, tmp_path, trades, {"600000.SH": hist}, "2021-03-05")["groups"][0]
    assert g["ok"] is False and "买卖都早于能取到的价格" in g["reason"] and "twr" not in g
    g = run(monkeypatch, tmp_path, [tr("AAPL", "dividend", "2026-03-02", amount=5)], {"AAPL": {"2026-03-02": 200}}, "2026-03-02")["groups"][0]
    assert g["ok"] is False and "只有分红或送转" in g["reason"]


def test_symbols_sold_out_before_the_window_are_not_fetched_or_counted(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    calls = []
    trades = [tr("600000", "buy", "2019-03-01", shares=100, price=8), tr("600000", "sell", "2019-06-03", shares=100, price=12),
              tr("600519", "buy", days[0], shares=100, price=10)]
    monkeypatch.setattr(P, "MAX_SYMBOLS", 1)
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11]))}, days[-1], calls=calls))
    assert [c["symbol"] for c in calls] == ["600519.SH"], "早已卖光的不取价、不占只数上限"
    assert "有 1 只在 2021-01-04 之前就已卖光（早于能取到的价格），没算进收益率" in g["notes"]
    g = run(monkeypatch, tmp_path, trades[:2], {}, days[-1])["groups"][0]
    assert g["ok"] is False and "约 5 年前" in g["reason"]


def test_symbol_cap_is_per_group_and_other_groups_still_compute(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    calls = []
    series = {"600519.SH": dict(zip(days, [10, 11])), "AAPL": dict(zip(days, [200, 210])), "MSFT": dict(zip(days, [400, 400]))}
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("AAPL", "buy", days[0], shares=1, price=200),
              tr("MSFT", "buy", days[0], shares=1, price=400)]
    monkeypatch.setattr(P, "MAX_SYMBOLS", 1)
    res = run(monkeypatch, tmp_path, trades, series, days[-1], calls=calls)
    a, us = res["groups"]
    assert a["ok"] and a["twr"] == pytest.approx(0.1)
    assert us["ok"] is False and us["reason"] == "这一组近 5 年有流水或还持有的有 2 只，一次最多算 1 只，算不了"
    assert [c["symbol"] for c in calls] == ["600519.SH"], "超了上限的那一组不取价"


def test_us_split_recorded_while_flat_still_restores_older_prices(monkeypatch, tmp_path):
    # 审查发现：卖光后才拆股、之后又买回 —— 空仓时的拆股曾被当成数据不对跳过，拆股前那段按调整后价算，凭空跌 75%
    days = bdays("2024-01-02", "2024-12-31")
    series = {"NVDA": {d: 100.0 for d in days}, "MSFT": {d: 50.0 for d in days}}   # NVDA 实际 400，2024-06-10 一拆四
    trades = [tr("MSFT", "buy", "2024-01-02", shares=100, price=50),
              tr("NVDA", "buy", "2024-02-01", shares=10, price=400), tr("NVDA", "sell", "2024-05-01", shares=10, price=400),
              tr("NVDA", "split", "2024-06-10", ratio=4), tr("NVDA", "buy", "2024-08-01", shares=10, price=100)]
    res = run(monkeypatch, tmp_path, trades, series, days[-1], charts=True)
    assert res["skipped"] == []
    g = only(res)
    s = g["ui_only"]["series"]
    assert s["value"][s["dates"].index("2024-02-01")] == 9000, "拆股前按实际价 400 计"
    assert g["twr"] == pytest.approx(0, abs=1e-12)


def test_todays_bar_is_flagged_as_maybe_intraday(monkeypatch, tmp_path):
    today = P.datetime.now(P.ZoneInfo("America/New_York")).date()
    days = [str(today - timedelta(days=1)), str(today)]
    trades = [tr("AAPL", "buy", days[0], shares=1, price=200)]
    g = only(run(monkeypatch, tmp_path, trades, {"AAPL": dict(zip(days, [200, 210]))}, days[-1]))
    assert any("还没收盘" in n for n in g["notes"])
    g = only(run(monkeypatch, tmp_path, trades, {"AAPL": dict(zip(days[:1], [200]))}, days[0]))
    assert not any("还没收盘" in n for n in g["notes"])


def test_trades_after_as_of_are_ignored(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("600519", "sell", days[2], shares=100, price=12)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11, 12]))}, days[1]))
    assert g["end"] == days[1] and g["end_value"] == 1100 and g["proceeds"] == 0


def test_split_recorded_after_as_of_still_restores_adjusted_prices(monkeypatch, tmp_path):
    """审计 D7：3/2 以 100 买 100 股，3/4 一拆二，算到 3/3。今天取到的是拆股已调整价（50），
    要乘回拆股比例还原成当时的 100：期末市值 10000、收益 0，不是 5000、-50%。"""
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    trades = [tr("AAPL", "buy", days[0], shares=100, price=100), tr("AAPL", "split", days[2], ratio=2)]
    g = only(run(monkeypatch, tmp_path, trades, {"AAPL": dict(zip(days, [50, 50, 50]))}, days[1]))
    assert g["end"] == days[1] and g["end_value"] == 10000 and g["twr"] == pytest.approx(0.0)


def test_split_not_yet_effective_does_not_restore_prices(monkeypatch, tmp_path):
    """审计第二轮（D7 修复引入）：流水里记了下个月才实施的一拆二，本次行情最新到 3/4、价格仍是 100（还没按它调整）。
    不能把比例乘上去：期末市值 10000、收益 0，不是 20000、+100%；说明里写明这笔拆股没参与还原。"""
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    trades = [tr("AAPL", "buy", days[0], shares=100, price=100), tr("AAPL", "split", "2026-04-01", ratio=2)]
    g = only(run(monkeypatch, tmp_path, trades, {"AAPL": dict(zip(days, [100, 100, 100]))}, days[1]))
    assert g["end"] == days[1] and g["end_value"] == 10000 and g["twr"] == pytest.approx(0.0)
    assert any("2026-04-01 的拆股在行情里还没实施" in n for n in g["notes"]), g["notes"]


def test_dividend_after_selling_out_is_noted(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03", "2026-03-04"]
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("600519", "sell", days[1], shares=100, price=11),
              tr("600519", "dividend", days[2], amount=20)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11, 11]))}, days[-1]))
    assert g["twr"] == pytest.approx(0.1), "清仓后到账的分红没有本金可比，时间加权里不算"
    assert g["gain"] == 120 and g["end"] == days[2]
    assert "有 1 笔分红在清仓以后才到账，没有本金可比，时间加权收益里没算；资金加权和区间盈亏里算了" in g["notes"]


def test_bad_trades_are_skipped_and_reported(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("600519", "sell", days[1], shares=500, price=11)]
    res = run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11]))}, days[-1])
    assert [s["why"] for s in res["skipped"]] == ["卖出 500 股,超过当时持有的 100 股(之前的买入或送转可能没录)"]
    assert only(res)["end_value"] == 1100


def test_prices_fetched_unadjusted_once_per_symbol(monkeypatch, tmp_path):
    days = ["2026-03-02", "2026-03-03"]
    calls = []
    trades = [tr("600519", "buy", days[0], shares=100, price=10), tr("600519", "buy", days[1], shares=100, price=11)]
    run(monkeypatch, tmp_path, trades, {"600519.SH": dict(zip(days, [10, 11]))}, days[-1], calls=calls)
    assert calls == [{"symbol": "600519.SH", "period": "day", "adjust": "none", "charts": True}]


# ---------------------------------------------------------------- 入参与 JSON 入口

@pytest.mark.parametrize("req, word", [
    ({"trades": "x"}, "trades 要是流水列表"),
    ({"trades": [1]}, "每一项都要是对象"),
    ({"trades": [], "as_of": "2026-02-30"}, "as_of"),
    ({"trades": [{}] * (P.MAX_TRADES + 1)}, "最多算"),
])
def test_bad_requests(req, word, tmp_path):
    with pytest.raises(P.PerfError, match=word):
        P.build(req, tmp_path)


def _main(monkeypatch, capsys, payload):
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    P.main()
    return json.loads(capsys.readouterr().out)


def test_main_json_entry(monkeypatch, capsys):
    days = ["2026-03-02", "2026-03-03"]
    monkeypatch.setattr(P.kline, "build", fake({"600519.SH": dict(zip(days, [10, 11]))}))
    trades = [tr("600519", "buy", days[0], shares=100, price=10)]
    out = _main(monkeypatch, capsys, json.dumps({"trades": trades, "as_of": days[-1]}))
    assert out["ok"] and out["result"]["groups"][0]["twr"] == pytest.approx(0.1)
    assert "ui_only" not in out["result"]["groups"][0], "不要图时不带逐日序列"
    out = _main(monkeypatch, capsys, json.dumps({"trades": trades, "as_of": days[-1], "charts": True}))
    s = out["result"]["groups"][0]["ui_only"]["series"]
    assert s["dates"] == days and s["value"] == [1000, 1100] and s["twr_index"] == [1, 1.1]
    assert out["result"]["sources"] == ["测试行情"]
    assert _main(monkeypatch, capsys, '{"action":"catalog"}')["catalog"]["parameters"]["trades"]
    assert _main(monkeypatch, capsys, "not json")["ok"] is False
    assert _main(monkeypatch, capsys, '{"trades":"x"}') == {"ok": False, "error": "trades 要是流水列表"}
