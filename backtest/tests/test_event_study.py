"""事件回看：逐日超额收益手算对照（第 0 天、几档累计、停牌、没满 20 日）、缺口（没上市 / 指数还没有 / 之后没交易日）、
平均只在 8 次以上给、停牌不进平均、业绩预告与增减持的事件归并、同一交易日合并、窗口重叠、入参校验。全部离线。"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

from backtest import event_study as E
from backtest.loader import FETCH_SCRIPT as REAL_FETCH

CAL = pd.bdate_range("2020-01-06", periods=60)
K = 20          # 事件落在第 20 个交易日


def _index(jump_at=K - 2):
    """指数：在事件前第 2 日涨 1%，其余不动。"""
    return pd.Series([100.0 if i < jump_at else 101.0 for i in range(len(CAL))], index=CAL, dtype="float64")


def _stock(drop=True):
    """股票：第 0 天涨 10%，第 3 天跌 5%。"""
    px = []
    for i in range(len(CAL)):
        if i < K:
            px.append(10.0)
        elif i < K + 3 or not drop:
            px.append(11.0)
        else:
            px.append(10.45)
    return pd.Series(px, index=CAL, dtype="float64")


def test_window_matches_hand_calculation():
    w, why = E._window(CAL[K], CAL, _stock(), _index())
    assert why is None
    assert w["day0"] == str(CAL[K].date())
    assert w["pre"] == pytest.approx(-0.01), "事件前第 2 日指数涨 1%，股票不动 → 超额 −1%"
    assert w["d0_1"] == pytest.approx(0.10)
    assert w["d0_5"] == pytest.approx(0.10 - 0.05)
    assert w["d0_20"] == pytest.approx(0.05)
    assert w["halted_days"] == 0 and w["days_after"] == 20
    assert len(w["path"]) == 26 and w["path"][0] == 0 and w["path"][3] == pytest.approx(-0.01)
    assert w["path"][5] == pytest.approx(0.09) and w["path"][-1] == pytest.approx(0.04)


def test_event_on_weekend_starts_on_next_trading_day():
    sat = CAL[K] - pd.Timedelta(days=CAL[K].weekday() + 2)          # 第 K 个交易日前的那个周六
    assert sat.weekday() == 5
    w, _ = E._window(sat, CAL, _stock(), _index())
    nxt = CAL[CAL.searchsorted(sat)]
    assert w["day0"] == str(nxt.date()) and nxt.weekday() == 0


def test_halted_days_are_counted_and_price_carried():
    s = _stock().drop(CAL[K + 5])
    w, _ = E._window(CAL[K], CAL, s, _index())
    assert w["halted_days"] == 1
    assert w["d0_5"] == pytest.approx(0.05), "停牌那天按停牌前的价，不当跌到 0"
    s2 = _stock().drop(CAL[K - 6])                                     # 起算那天也没价格
    assert E._window(CAL[K], CAL, s2, _index())[0]["halted_days"] == 1


def test_recent_event_only_has_the_horizons_that_exist():
    w, _ = E._window(CAL[-4], CAL, _stock(), _index())
    assert w["days_after"] == 3
    assert w["pre"] is not None and w["d0_1"] is not None
    assert w["d0_5"] is None and w["d0_20"] is None, "没满的那几档是空，不当 0"
    assert len(w["path"]) == E.PRE + 1 + 3
    w, _ = E._window(CAL[-5], CAL, _stock(), _index())
    assert w["days_after"] == 4 and w["d0_5"] is None, "差一天满 5 日也不算第 0–5 日"


def test_window_gaps():
    w, why = E._window(CAL[K], CAL, _stock().loc[CAL[K - 3]:], _index())
    assert w is None and "可能当时还没上市" in why and str(CAL[K - 3].date()) in why
    w, why = E._window(CAL[3], CAL, _stock(), _index())
    assert w is None and "对照指数在事件前不够 6 个交易日" in why and "2020-01-06" in why
    w, why = E._window(CAL[5], CAL, _stock(), _index())
    assert w is None and "不够 6 个交易日" in why, "第 0 天前只有 5 个交易日：差起算那一天"
    assert E._window(CAL[6], CAL, _stock(), _index())[0] is not None
    w, why = E._window(CAL[-1] + pd.Timedelta(days=3), CAL, _stock(), _index())
    assert w is None and why == "事件之后还没有交易日的价格"


def _ev(v, halted=0, direction=None, **over):
    base = {"pre": v, "d0_1": v, "d0_5": v, "d0_20": v, "halted_days": halted, "direction": direction}
    return {**base, **over}


def test_summary_needs_eight_and_skips_halted_and_missing():
    seven = [_ev(0.01 * i) for i in range(1, 8)]
    s = E._summary(seven, ["all"])[0]
    assert s["horizons"]["d0_20"] == {"n": 7, "mean": None, "median": None, "positive_share": None}
    assert "只有 7 次" in s["note"] and "不给平均" in s["note"]
    vals = [-0.03, -0.01, 0.0, 0.02, 0.04, 0.05, 0.06, 0.09]
    evs = [_ev(v) for v in vals] + [_ev(0.5, halted=2)] + [_ev(0.07, d0_20=None, d0_5=None)]
    s = E._summary(evs, ["all"])[0]
    h20 = s["horizons"]["d0_20"]
    assert h20["n"] == 8, "停牌的那次、还没满 20 日的那次都不算"
    assert h20["mean"] == pytest.approx(sum(vals) / 8) and h20["median"] == pytest.approx(0.03)
    assert h20["positive_share"] == pytest.approx(5 / 8), "0 不算上涨"
    assert s["horizons"]["d0_1"]["n"] == 9, "没满 20 日的那次照样进前几档"
    assert s["events"] == 10 and "停牌的 1 次没算进来" in s["note"]


def test_summary_groups_by_forecast_direction_and_drops_empty_groups():
    evs = [_ev(0.01, direction="up") for _ in range(8)] + [_ev(-0.02, direction="other")]
    groups = E._summary(evs, ["all", "up", "down"])
    assert [g["key"] for g in groups] == ["all", "up"], "没有向差的预告就不列这一组"
    assert groups[1]["horizons"]["d0_5"]["mean"] == pytest.approx(0.01)
    assert groups[0]["events"] == 9 and groups[1]["events"] == 8


def test_mean_path_needs_eight_complete_unhalted_events():
    full = [{"path": [0.01 * i] * 26, "halted_days": 0} for i in range(8)]
    p = E._mean_path(full)
    assert p["n"] == 8 and p["offsets"][0] == -5 and p["offsets"][-1] == 20
    assert p["mean"][0] == pytest.approx(0.035) and p["median"][0] == pytest.approx(0.035)
    assert E._mean_path(full[:7]) is None
    assert E._mean_path(full[:7] + [{"path": [1.0] * 26, "halted_days": 1}]) is None, "停牌的不算"
    assert E._mean_path(full[:7] + [{"path": [1.0] * 10, "halted_days": 0}]) is None, "没满的不算"


def test_forecast_events_group_by_notice_day_and_use_net_profit_row():
    rows = [
        {"notice_date": "2025-01-03", "report_date": "2024-12-31", "indicator": "扣除非经常性损益后的净利润", "forecast_type": "预减",
         "change_pct_lower": -30.0, "change_pct_upper": -20.0},
        {"notice_date": "2025-01-03", "report_date": "2024-12-31", "indicator": E.NET_PROFIT, "forecast_type": "略增",
         "change_pct_lower": 10.0, "change_pct_upper": 20.0},
        {"notice_date": "2024-07-10 00:00:00", "report_date": "2024-06-30", "indicator": "营业收入", "forecast_type": "预增",
         "change_pct_lower": 50.0, "change_pct_upper": 50.0},
        {"notice_date": "2023-04-01", "report_date": "2023-03-31", "indicator": E.NET_PROFIT, "forecast_type": "续亏",
         "change_pct_lower": None, "change_pct_upper": None},
        {"notice_date": None, "report_date": "2022-12-31", "indicator": E.NET_PROFIT, "forecast_type": "首亏"},
    ]
    evs, bad = E._forecast_events(rows)
    assert bad == 1
    by = {e["date"]: e for e in evs}
    assert set(by) == {"2025-01-03", "2024-07-10", "2023-04-01"}, "同一天的几条算一次；没有公告日的不算"
    a = by["2025-01-03"]
    assert a["label"] == "2024 年年报预告" and a["direction"] == "up", "有归母净利润那条就按它定类型"
    assert a["detail"] == "略增，归母净利润同比 +10.00% ~ +20.00%"
    b = by["2024-07-10"]
    assert b["label"] == "2024 年中报预告" and b["direction"] == "up" and b["detail"] == "预增", "没有归母那条不写同比"
    c = by["2023-04-01"]
    assert c["direction"] == "other" and c["detail"] == "续亏" and c["label"] == "2023 年一季报预告"
    two = E._forecast_events([
        {"notice_date": "2020-01-01", "indicator": "营业收入", "forecast_type": "预增"},
        {"notice_date": "2020-01-01", "indicator": "每股收益", "forecast_type": "预减"},
    ])[0][0]
    assert two["direction"] == "other" and two["label"] == "业绩预告", "几条方向不一样就不归入向好或向差"
    assert E._pct_range(14.67, 14.67) == "同比 +14.67%" and E._pct_range(None, -5.0) == "同比 -5.00%" and E._pct_range(None, None) == ""


def test_holder_events_filter_direction_and_merge_same_day():
    rows = [
        {"notice_date": "2025-12-30", "holder": "甲集团", "direction": "增持", "change_shares_10k": 100.0, "change_pct_total": 0.08, "channel": "二级市场"},
        {"notice_date": "2025-12-30", "holder": "乙公司", "direction": "增持", "change_shares_10k": 27.5, "change_pct_total": 0.02, "channel": "大宗交易"},
        {"notice_date": "2025-11-06", "holder": "甲集团", "direction": "增持", "change_shares_10k": 10.0, "change_pct_total": None, "channel": ""},
        {"notice_date": "2025-10-01", "holder": "丙", "direction": "减持", "change_shares_10k": -50.0, "change_pct_total": -0.1, "channel": "二级市场"},
        {"notice_date": "", "holder": "丁", "direction": "增持", "change_shares_10k": 1.0},
    ]
    evs, bad = E._holder_events(rows, "增持")
    assert bad == 1
    by = {e["date"]: e for e in evs}
    assert set(by) == {"2025-12-30", "2025-11-06"}
    assert by["2025-12-30"]["detail"] == "2 位股东，合计 127.50 万股，占总股本 0.10%，二级市场、大宗交易"
    assert by["2025-11-06"]["detail"] == "甲集团，合计 10.00 万股", "占比缺一条就不写占比"
    dec, _ = E._holder_events(rows, "减持")
    assert [e["detail"] for e in dec] == ["丙，合计 50.00 万股，占总股本 0.10%，二级市场"], "减持写绝对值"


@pytest.mark.parametrize("raw,msg", [
    ("510300", "不是个股"), ("920001", "北交所"), ("EURUSD", "代码认不出"),
    ("", "要给一只股票的代码"), (None, "要给一只股票的代码"), ("ABCDEFG", "代码认不出"),
])
def test_code_validation(raw, msg):
    with pytest.raises(E.EventError, match=msg):
        E._code(raw)
    assert E._code("600519") == "600519.SH" and E._code("sz.300750") == "300750.SZ"
    assert E._code("AAPL") == "AAPL" and E._code("00700.HK") == "00700.HK", "港美股也能做（业绩公布）"


def test_event_rows_reads_extracted_file_and_reports_failures(monkeypatch, tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "extracted_x.json").write_text(json.dumps({"rows": [{"a": 1}, "bad", {"b": 2}]}))
    env = {"status": "ok", "primary_source": "eastmoney", "extra": {"raw_files": ["raw/first.json", "raw/extracted_x.json"]}}
    calls = []
    monkeypatch.setattr(E, "_run_fetch", lambda ep, sym, args, out, py, t, **kw: (calls.append((ep, sym, args, kw)), env)[1])
    rows, src, cut = E._event_rows("holder_trades", "600519.SH", tmp_path)
    assert rows == [{"a": 1}, {"b": 2}] and src == "eastmoney" and cut is None
    assert calls == [("holder_trades", "600519", {"limit": 5000}, {"allow_partial": True})]
    monkeypatch.setattr(E, "_run_fetch", lambda *a, **kw: {"status": "partial", "extra": {"raw_files": []}})
    assert E._event_rows("share_buyback", "600519.SH", tmp_path) == ([], "", None)
    monkeypatch.setattr(E, "_run_fetch", lambda *a, **kw: {"status": "failed", "errors": [{"error": "东财超时"}]})
    with pytest.raises(E.EventError, match="事件没取到：东财超时"):
        E._event_rows("holder_trades", "600519.SH", tmp_path)

    def boom(*a, **kw):
        raise E.LoaderError("holder_trades 取 600519 退出码 3：网络错误")
    monkeypatch.setattr(E, "_run_fetch", boom)
    with pytest.raises(E.EventError, match="退出码 3"):
        E._event_rows("holder_trades", "600519.SH", tmp_path)


def _fake_fetch_script(tmp_path, rows, endpoint="holder_trades", fail=None):
    """真跑受控取数脚本（真子进程、真 mapper、真退出码），只把东财那一步换成给定的行 / 异常。"""
    scripts = REAL_FETCH.parent
    wrapper = tmp_path / f"fetch_wrapper_{len(list(tmp_path.glob('fetch_wrapper_*')))}.py"
    body = f"raise RuntimeError({fail!r})" if fail else (
        f"return A._v39_frame({rows!r}, 'eastmoney', 'https://datacenter-web.eastmoney.com/api/data/v1/get', "
        f"A._HOLDER_COLUMNS if {endpoint!r} == 'holder_trades' else A._FORECAST_COLUMNS)")
    wrapper.write_text(f"""
import os, runpy, sys
sys.path.insert(0, {str(scripts)!r})
os.chdir({str(scripts)!r})
import sources.astock_ported as A
def fake(**kw):
    {body}
A.{endpoint} = fake
sys.argv[0] = {str(REAL_FETCH)!r}
runpy.run_path({str(REAL_FETCH)!r}, run_name="__main__")
""")
    return wrapper


def test_event_rows_real_fetch_accepts_no_events_and_full_limit(monkeypatch, tmp_path):
    """端点对「没有这类事件」和「取满 limit」都给退出码 2（partial），不能当成取数失败（E3 审查 P1-1）。"""
    from backtest import loader as L
    monkeypatch.setattr(L, "FETCH_SCRIPT", _fake_fetch_script(tmp_path, []))
    assert E._event_rows("holder_trades", "601398.SH", tmp_path / "a") == ([], "eastmoney", None)

    row = {"code": "601398", "holder": "甲", "direction": "增持", "change_shares_10k": 1.0, "notice_date": "2020-03-09",
           "start_date": "2020-03-01", "end_date": "2020-03-06"}
    rows = [{**row, "holder": f"股东{i}"} for i in range(3)]
    monkeypatch.setattr(L, "FETCH_SCRIPT", _fake_fetch_script(tmp_path, rows))
    monkeypatch.setattr(E, "EVENT_LIMIT", 3)
    got, src, _ = E._event_rows("holder_trades", "601398.SH", tmp_path / "b")
    assert [r["holder"] for r in got] == ["股东0", "股东1", "股东2"] and src == "eastmoney"

    monkeypatch.setattr(L, "FETCH_SCRIPT", _fake_fetch_script(tmp_path, [], fail="东财超时"))
    with pytest.raises(E.EventError, match="事件没取到：.*东财超时"):
        E._event_rows("holder_trades", "601398.SH", tmp_path / "c")


def test_run_fetch_partial_only_when_asked(monkeypatch, tmp_path):
    from backtest import loader as L
    monkeypatch.setattr(L, "FETCH_SCRIPT", _fake_fetch_script(tmp_path, []))
    with pytest.raises(L.LoaderError, match="退出码 2"):
        L._run_fetch("holder_trades", "601398", {"limit": 10}, tmp_path / "a", sys.executable, 60)
    env = L._run_fetch("holder_trades", "601398", {"limit": 10}, tmp_path / "b", sys.executable, 60, allow_partial=True)
    assert env["status"] == "partial"
    monkeypatch.setattr(L, "FETCH_SCRIPT", _fake_fetch_script(tmp_path, [], fail="东财超时"))
    with pytest.raises(L.LoaderError, match="退出码 3"):
        L._run_fetch("holder_trades", "601398", {"limit": 10}, tmp_path / "c", sys.executable, 60, allow_partial=True)


def test_build_flags_event_rows_at_limit(monkeypatch, tmp_path):
    rows = [{"notice_date": "2020-03-09", "holder": f"股东{i}", "direction": "增持"} for i in range(4)]
    monkeypatch.setattr(E, "EVENT_LIMIT", 4)
    out, _ = _build(monkeypatch, tmp_path, rows)
    assert {"date": None, "label": "重要股东增持", "reason": "明细取到上限 4 条，更早的重要股东增持可能没取到"} in out["gaps"]
    out, _ = _build(monkeypatch, tmp_path, rows[:3])
    assert not any("上限" in g["reason"] for g in out["gaps"])


def _long_cal():
    return pd.bdate_range("2019-01-01", "2021-12-31")


def _build(monkeypatch, tmp_path, events, kind="holder_increase", charts=False, stock=None):
    cal = _long_cal()
    monkeypatch.setattr(E, "_event_rows", lambda ep, code, out: (events, "eastmoney", None))
    seen = {}

    def closes(code, a, b, out):
        seen["range"] = (a, b)
        return (stock if stock is not None else pd.Series(10.0, index=cal)), None, "bs_kline_qfq"
    monkeypatch.setattr(E, "_closes", closes)
    monkeypatch.setattr(E, "_benchmark", lambda m, a, b, out: (pd.Series(100.0, index=cal), None))
    return E.run({"symbol": "600519", "kind": kind, "charts": charts}, tmp_path), seen


def test_build_merges_same_trading_day_flags_overlap_and_orders_newest_first(monkeypatch, tmp_path):
    rows = [
        {"notice_date": "2020-03-07", "holder": "甲", "direction": "增持", "change_shares_10k": 1.0, "change_pct_total": 0.01},   # 周六
        {"notice_date": "2020-03-09", "holder": "乙", "direction": "增持", "change_shares_10k": 2.0, "change_pct_total": 0.02},   # 周一
        {"notice_date": "2020-03-20", "holder": "丙", "direction": "增持", "change_shares_10k": 3.0, "change_pct_total": 0.03},
        {"notice_date": "2020-09-01", "holder": "丁", "direction": "增持", "change_shares_10k": 4.0, "change_pct_total": 0.04},
    ]
    out, seen = _build(monkeypatch, tmp_path, rows)
    assert seen["range"][0] == "2020-02-06", "从最早的事件往前多取 30 天"
    days = [e["day0"] for e in out["events"]]
    assert days == ["2020-09-01", "2020-03-20", "2020-03-09"], "新的在前；周六和周一落在同一个交易日，算一次"
    merged = out["events"][-1]
    assert merged["detail"] == "甲，合计 1.00 万股，占总股本 0.01%；乙，合计 2.00 万股，占总股本 0.02%"
    assert [e["overlaps_prev"] for e in out["events"]] == [False, True, False]
    # 边界：相隔正好 25 个交易日算重叠（前一次的第 20 日 = 后一次的第 −5 日），26 个不算
    cal = _long_cal()
    k = int(cal.searchsorted(pd.Timestamp("2020-03-09")))
    for gap, want in ((25, True), (26, False)):
        rs = [rows[1], {**rows[2], "notice_date": str(cal[k + gap].date())}]
        o, _ = _build(monkeypatch, tmp_path, rs)
        assert o["events"][0]["overlaps_prev"] is want, gap
    assert any("窗口重叠" in n for n in out["notes"])
    assert out["sources"] == ["baostock 前复权日线", "东方财富", "腾讯 K 线"]
    assert out["summary"][0]["note"].startswith("能算的只有 3 次")
    assert "ui_only" not in out
    assert all("path" not in e for e in out["events"]), "逐日路径不进结果（Agent 那条路）"
    json.dumps(out, allow_nan=False)


def test_build_gives_average_path_only_with_enough_events(monkeypatch, tmp_path):
    rows = [{"notice_date": f"2020-{m:02d}-15", "holder": "甲", "direction": "增持", "change_shares_10k": 1.0, "change_pct_total": 0.01}
            for m in range(1, 10)]
    out, _ = _build(monkeypatch, tmp_path, rows, charts=True)
    assert out["ui_only"]["path"]["n"] == 9 and out["summary"][0]["horizons"]["d0_20"]["n"] == 9
    assert out["summary"][0]["horizons"]["d0_20"]["mean"] == pytest.approx(0.0)
    assert any("相隔不到 26 个交易日" in n for n in out["notes"]), "每月一次：前后窗口（共 26 个交易日）重叠"
    out, _ = _build(monkeypatch, tmp_path, rows[:7], charts=True)
    assert out["ui_only"]["path"] is None
    sparse = [{**r, "notice_date": f"2020-{m:02d}-15"} for r, m in zip(rows, (1, 3, 5, 7, 9, 11))]
    out, _ = _build(monkeypatch, tmp_path, sparse)
    assert not any(e["overlaps_prev"] for e in out["events"]) and not any("窗口重叠" in n for n in out["notes"])


def test_build_with_no_events_does_not_fetch_prices(monkeypatch, tmp_path):
    monkeypatch.setattr(E, "_event_rows", lambda *a: ([{"direction": "减持", "notice_date": "2020-01-01"}], "eastmoney", None))
    monkeypatch.setattr(E, "_closes", lambda *a: pytest.fail("没有事件时不该去取价格"))
    out = E.run({"symbol": "600519", "kind": "holder_increase", "charts": True}, tmp_path)
    assert out["events"] == [] and out["notes"] == ["这只股票没查到重要股东增持"] and out["ui_only"]["path"] is None
    assert out["sources"] == ["东方财富"]


def test_build_cuts_index_days_after_last_stock_price(monkeypatch, tmp_path):
    """盘中指数已有今天这根、股票日线收盘后才有：今天不能被当成停牌日（E3 审查 P1-2）。"""
    cal = pd.bdate_range("2026-08-03", "2026-10-09")
    idx = pd.Series(1000.0, index=cal)
    idx.iloc[-1] = 1010.0                                      # 今天盘中指数 +1%
    stock = pd.Series(50.0, index=cal[:-1])                    # 股票今天还没有
    rows = [{"notice_date": "2026-10-06", "holder": "甲", "direction": "增持"},
            {"notice_date": "2026-10-09", "holder": "乙", "direction": "增持"}]
    monkeypatch.setattr(E, "_event_rows", lambda *a: (rows, "eastmoney", None))
    monkeypatch.setattr(E, "_closes", lambda *a: (stock, None, "bs_kline_qfq"))
    monkeypatch.setattr(E, "_benchmark", lambda *a: (idx, None))
    out = E.run({"symbol": "600519", "kind": "holder_increase"}, tmp_path)
    (ev,) = out["events"]
    assert ev["day0"] == "2026-10-06" and ev["halted_days"] == 0 and ev["days_after"] == 2
    assert ev["d0_1"] == 0.0 and ev["d0_5"] is None
    assert out["gaps"] == [{"date": "2026-10-09", "label": "增持", "reason": "事件之后还没有交易日的价格"}]
    assert "这只股票最后一个价格在 2026-10-08，沪深300指数之后的 1 个交易日没算（当天的收盘价可能还没出，或者在停牌）" in out["notes"]
    # 股票和指数同一天结束：不截、不加这句
    monkeypatch.setattr(E, "_closes", lambda *a: (pd.Series(50.0, index=cal), None, "bs_kline_qfq"))
    out = E.run({"symbol": "600519", "kind": "holder_increase"}, tmp_path)
    assert not any("最后一个价格在" in n for n in out["notes"])
    assert {e["day0"] for e in out["events"]} == {"2026-10-06", "2026-10-09"}


def test_build_reports_price_failures_as_errors(monkeypatch, tmp_path):
    rows = [{"notice_date": "2020-03-09", "holder": "甲", "direction": "增持"}]
    monkeypatch.setattr(E, "_event_rows", lambda *a: (rows, "eastmoney", None))
    monkeypatch.setattr(E, "_closes", lambda *a: (None, "区间内一根 bar 都没有", None))
    with pytest.raises(E.EventError, match="日线没取到：区间内一根 bar 都没有"):
        E.run({"symbol": "600519", "kind": "holder_increase"}, tmp_path)
    monkeypatch.setattr(E, "_closes", lambda *a: (pd.Series(10.0, index=_long_cal()), None, "bs_kline_qfq"))
    monkeypatch.setattr(E, "_benchmark", lambda *a: (None, "tx_kline 返回 failed"))
    with pytest.raises(E.EventError, match="沪深300指数没取到：tx_kline 返回 failed"):
        E.run({"symbol": "600519", "kind": "holder_increase"}, tmp_path)


def test_build_earnings_lists_direction_groups_and_bad_rows(monkeypatch, tmp_path):
    rows = [{"notice_date": f"2020-{m:02d}-10", "report_date": "2019-12-31", "indicator": E.NET_PROFIT,
             "forecast_type": "预增" if m % 2 else "首亏"} for m in range(1, 7)] + [{"notice_date": None, "forecast_type": "预增"}]
    out, _ = _build(monkeypatch, tmp_path, rows, kind="earnings_forecast")
    assert [g["key"] for g in out["summary"]] == ["all", "up", "down"]
    assert out["gaps"][0] == {"date": None, "label": "业绩预告", "reason": "有 1 条没有公告日，没算进来"}
    assert any("同一天的几条预告" in n for n in out["notes"])
    # 周六一条向好、周一一条向差，落在同一个交易日合并成一次 → 不归入任何一组
    mixed = [{"notice_date": "2020-03-07", "report_date": "2019-12-31", "indicator": E.NET_PROFIT, "forecast_type": "预增"},
             {"notice_date": "2020-03-09", "report_date": "2020-03-31", "indicator": E.NET_PROFIT, "forecast_type": "首亏"}]
    out, _ = _build(monkeypatch, tmp_path, mixed, kind="earnings_forecast")
    assert len(out["events"]) == 1 and out["events"][0]["direction"] == "other"
    assert out["events"][0]["label"] == "2019 年年报预告；2020 年一季报预告"
    assert [g["key"] for g in out["summary"]] == ["all"]


def _main(monkeypatch, capsys, stdin):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    E.main()
    return json.loads(capsys.readouterr().out)


def test_main_validates_input_and_serves_catalog(monkeypatch, capsys):
    assert _main(monkeypatch, capsys, "{")["ok"] is False
    assert _main(monkeypatch, capsys, "[]")["error"] == "入参必须是对象"
    r = _main(monkeypatch, capsys, json.dumps({"symbol": "600519", "kind": "split"}))
    assert r["ok"] is False and "earnings_forecast（业绩预告）" in r["error"]
    r = _main(monkeypatch, capsys, json.dumps({"symbol": "AAPL", "kind": "earnings_forecast"}))
    assert r["ok"] is False and "只做 A 股" in r["error"]
    cat = _main(monkeypatch, capsys, json.dumps({"action": "catalog"}))
    assert cat["ok"] and "不给买卖提示" in cat["catalog"]["description"] and "少于 8 次" in cat["catalog"]["description"]


# ── 港股 / 美股：业绩公布 ──

def test_release_events_hk_after_close_starts_next_day_and_merges_same_day():
    rows = [
        {"date": "2026-03-18", "time": "16:30", "category": "末期业绩"},
        {"date": "2026-03-18", "time": "16:45", "category": "季度业绩"},       # 同一天两份 → 一次
        {"date": "2026-05-05", "time": "12:00", "category": "季度业绩"},       # 午休发布 → 当天
        {"date": "2025-08-13", "time": None, "category": "中期业绩"},          # 没有时间 → 当天、写明不详
        {"date": None, "time": "16:30", "category": "末期业绩"},
    ]
    evs, bad = E._release_events(rows, "hk_equity")
    by = {e["date"]: e for e in evs}
    assert bad == 1 and set(by) == {"2026-03-18", "2026-05-05", "2025-08-13"}
    assert by["2026-03-18"]["day0_from"] == "2026-03-19" and by["2026-03-18"]["label"] == "末期业绩、季度业绩"
    assert by["2026-03-18"]["detail"] == "港交所 16:30 发布，收市后发布，从下一个交易日算起"
    assert "day0_from" not in by["2026-05-05"] and by["2026-05-05"]["detail"] == "港交所 12:00 发布"
    assert "day0_from" not in by["2025-08-13"] and by["2025-08-13"]["detail"] == "发布时间不详"
    assert all("title" not in e and "公佈" not in e["detail"] for e in evs), "源标题不进结果"


@pytest.mark.parametrize("hhmm,shifted", [("15:59", False), ("16:00", True), ("08:30", False)])
def test_release_events_hk_close_boundary(hhmm, shifted):
    evs, _ = E._release_events([{"date": "2026-03-20", "time": hhmm, "category": "末期业绩"}], "hk_equity")
    assert ("day0_from" in evs[0]) is shifted
    if shifted:
        assert evs[0]["day0_from"] == "2026-03-21", "顺延只加一个自然日，非交易日由窗口往后找"


def test_release_events_us_uses_filing_date_only():
    rows = [{"date": "2026-07-30", "title": "Current report, items 2.02 and 9.01"}, {"date": "2026-07-30", "title": "Apple Reports"},
            {"date": "2026-04-30", "title": "x"}]
    evs, bad = E._release_events(rows, "us_equity")
    by = {e["date"]: e for e in evs}
    assert bad == 0 and by["2026-07-30"]["detail"] == "SEC 8-K Item 2.02，美东 2026-07-30 提交（同一天 2 份）"
    assert all("day0_from" not in e and e["label"] == "业绩 8-K" for e in evs)


def _build_global(monkeypatch, tmp_path, symbol, rows, cut=None, earliest=None, bench_seen=None, sec=None):
    """sec=None：没填 SEC 联系方式；sec="ok"：填了、SEC 取到；sec="fail"：填了、SEC 这次失败（退回东财）。"""
    cal = _long_cal()
    seen = {"endpoints": [], "outs": []}
    if sec:
        monkeypatch.setenv("VRA_SEC_CONTACT", "Test Person test@example.com")
    else:
        monkeypatch.delenv("VRA_SEC_CONTACT", raising=False)

    def rows_of(ep, code, out):
        seen["endpoints"].append((ep, code))
        seen["outs"].append(out.name)
        if ep == "sec_earnings_8k_dates":
            if sec == "fail":
                raise E.EventError("事件没取到：sec_earnings_8k_dates 取 JPM 退出码 1：HTTP 503 efts.sec.gov — ")
            return rows, "sec", cut
        return rows, "hkex" if code.endswith(".HK") else "eastmoney", cut
    monkeypatch.setattr(E, "_event_rows", rows_of)
    monkeypatch.setattr(E, "_closes", lambda code, a, b, out: (pd.Series(10.0, index=cal), None, "yahoo_kline"))

    def bench(m, a, b, out):
        seen["bench"] = (m, a)
        return pd.Series(100.0, index=cal), None
    monkeypatch.setattr(E, "_benchmark", bench)
    monkeypatch.setattr(E, "yahoo_daily_earliest", lambda: earliest or pd.Timestamp("2010-01-01").date())
    return E.run({"symbol": symbol, "kind": "earnings_release"}, tmp_path), seen


def test_build_hk_shifts_after_close_to_next_trading_day_and_uses_hk_benchmark(monkeypatch, tmp_path):
    rows = [{"date": "2020-03-18", "time": "16:30", "category": "末期业绩"},     # 周三收市后 → 周四
            {"date": "2020-03-20", "time": "16:30", "category": "季度业绩"},     # 周五收市后 → 下周一
            {"date": "2020-05-13", "time": "12:00", "category": "季度业绩"}]     # 午休 → 当天
    out, seen = _build_global(monkeypatch, tmp_path, "00700.HK", rows)
    assert seen["endpoints"] == [("hkex_results_dates", "00700.HK")] and seen["bench"][0] == "hk_equity"
    assert {e["date"]: e["day0"] for e in out["events"]} == {"2020-03-18": "2020-03-19", "2020-03-20": "2020-03-23", "2020-05-13": "2020-05-13"}
    assert all("day0_from" not in e for e in out["events"]), "内部字段不给界面"
    assert out["market"] == "hk_equity" and out["kind_label"] == "业绩公布" and out["benchmark_label"].startswith("盈富基金")
    assert out["sources"] == ["Yahoo 日线", "港交所披露易"]
    assert "16:00 收市后发布的算下一个交易日" in out["notes"][0] and "盈富基金" in out["notes"][0] and "半日市" in out["notes"][0]
    assert any("港股价格只做了拆股调整" in n for n in out["notes"])
    assert not any("沪深300" in n or "baostock" in n for n in out["notes"])


def test_build_global_drops_events_before_yahoo_window_into_one_gap(monkeypatch, tmp_path):
    rows = [{"date": "2019-02-01", "time": "09:00", "category": "末期业绩"}, {"date": "2019-03-01", "time": "09:00", "category": "末期业绩"},
            {"date": "2020-06-01", "time": "09:00", "category": "末期业绩"}]
    out, seen = _build_global(monkeypatch, tmp_path, "00700.HK", rows, earliest=pd.Timestamp("2019-04-01").date())
    assert [e["date"] for e in out["events"]] == ["2020-06-01"]
    assert out["gaps"] == [{"date": None, "label": "业绩公布", "reason": "港股日线只能取到约 10 年前（2019-05-02 之前的事件凑不齐事件前的价格），更早的 2 次没算"}]
    assert seen["bench"][1] == "2020-05-02", "取价从能算的最早一次往前 30 天，不会请求 10 年以外"
    # 全部都太早：不取价，写明原因见缺口
    out, _ = _build_global(monkeypatch, tmp_path, "00700.HK", rows[:2], earliest=pd.Timestamp("2019-04-01").date())
    assert out["events"] == [] and out["notes"] == ["能算的业绩公布一次也没有，原因见缺口"]


def test_build_us_notes_adr_when_nothing_found_but_not_when_pages_ran_out(monkeypatch, tmp_path):
    out, seen = _build_global(monkeypatch, tmp_path, "BABA", [])
    assert seen["endpoints"] == [("us_earnings_8k_dates", "BABA")]
    assert out["notes"] == ["这只股票没查到业绩公布：美股按 SEC 8-K 的 Item 2.02 找，外国公司（ADR）用 6-K 报业绩，这一版取不到"]
    cut = "只取到最近 30 页申报（每页 100 份），更早的业绩申报没取到"
    out, _ = _build_global(monkeypatch, tmp_path, "JPM", [], cut=cut)
    assert out["notes"] == ["这只股票没查到业绩公布", E.SEC_HINT] and out["gaps"] == [{"date": None, "label": "业绩公布", "reason": cut}]
    rows = [{"date": f"2020-{m:02d}-15"} for m in range(1, 11)]
    out, seen = _build_global(monkeypatch, tmp_path, "AAPL", rows)
    assert seen["bench"][0] == "us_equity" and out["benchmark_label"] == "标普500 ETF（SPY）"
    assert out["summary"][0]["horizons"]["d0_1"]["n"] == 10 and "看「第 0–1 日」那一档" in out["notes"][0]
    assert any("ADR" in n and "2.02" in n and "来自东财转载的申报" in n for n in out["notes"])
    assert E.SEC_HINT not in out["notes"], "东财取全了就不提示去填"
    out, _ = _build_global(monkeypatch, tmp_path, "AAPL", rows, cut=cut)
    assert E.SEC_HINT in out["notes"]


def test_build_us_uses_sec_when_contact_set_and_falls_back_to_eastmoney(monkeypatch, tmp_path):
    rows = [{"date": f"2020-{m:02d}-15"} for m in range(1, 11)]
    out, seen = _build_global(monkeypatch, tmp_path, "JPM", rows, sec="ok")
    assert seen["endpoints"] == [("sec_earnings_8k_dates", "JPM")]
    assert out["sources"] == ["SEC EDGAR", "Yahoo 日线"]
    assert any("来自 SEC 官方全文检索，更正版 8-K/A 不算" in n for n in out["notes"])
    assert E.SEC_HINT not in out["notes"] and not any("改用东财" in n for n in out["notes"])

    out, seen = _build_global(monkeypatch, tmp_path, "JPM", rows, sec="fail")
    assert seen["endpoints"] == [("sec_earnings_8k_dates", "JPM"), ("us_earnings_8k_dates", "JPM")]
    assert seen["outs"] == ["events", "fallback"], "退回东财另用一个目录，不和 SEC 那次的明细混"
    assert "SEC 这次没取到（HTTP 503 efts.sec.gov —），改用东财转载的申报" in out["notes"]
    assert out["sources"] == ["Yahoo 日线", "东方财富"] and any("来自东财转载的申报" in n for n in out["notes"])

    out, _ = _build_global(monkeypatch, tmp_path, "BABA", [], sec="fail")
    assert out["notes"][-1].startswith("SEC 这次没取到") and "ADR" in out["notes"][0]


def test_sec_contact_needs_an_email(monkeypatch):
    # 格式不对的（中文名、夹控制字符）取数层会当没填，这里也当没填走东财，免得 SEC 必败后再退回、白等一趟
    for v, want in (("Test Person test@example.com", True), ("Test\nPerson test@example.com", True), ("Test Person", False), ("", False),
                    ("测试 test@example.com", False), ("Test\x07Person test@example.com", False)):
        monkeypatch.setenv("VRA_SEC_CONTACT", v)
        assert E._sec_contact_set() is want
    monkeypatch.delenv("VRA_SEC_CONTACT")
    assert E._sec_contact_set() is False


@pytest.mark.parametrize("symbol,kind,msg", [
    ("600519", "earnings_release", "业绩公布这一版只做港股和美股；A 股可以看业绩预告"),
    ("00700.HK", "holder_increase", "重要股东增持只做 A 股（只有 A 股的来源）；港股这一版做业绩公布"),
    ("AAPL", "earnings_forecast", "业绩预告只做 A 股"),
    ("AAPL", "split", "美股的事件类型只认这几种：earnings_release（业绩公布）$"),
    ("AAPL", "lockup", "限售解禁只做 A 股"),
    ("00700.HK", "dragon_tiger", "龙虎榜上榜只做 A 股"),
])
def test_kind_must_fit_market(symbol, kind, msg, monkeypatch, tmp_path):
    monkeypatch.setattr(E, "_event_rows", lambda *a: pytest.fail("类型不对不该取数"))
    with pytest.raises(E.EventError, match=msg):
        E.run({"symbol": symbol, "kind": kind}, tmp_path)


def test_event_rows_global_plan_and_truncation_note(monkeypatch, tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    calls = []

    def fake(ep, sym, args, out, py, t, **kw):
        calls.append((ep, sym, args, t))
        return {"status": "partial", "primary_source": "eastmoney", "extra": {"raw_files": ["raw/extracted_r.json"]}}
    monkeypatch.setattr(E, "_run_fetch", fake)
    (raw / "extracted_r.json").write_text(json.dumps({"rows": [{"date": "2020-01-02"}], "truncated": True, "pages": 30}), encoding="utf-8")
    rows, src, cut = E._event_rows("us_earnings_8k_dates", "JPM", tmp_path)
    assert calls[-1] == ("us_earnings_8k_dates", "JPM", {"max_pages": 30}, 150) and rows == [{"date": "2020-01-02"}]
    assert cut == "只取到最近 30 页申报（每页 100 份），更早的业绩申报没取到"
    (raw / "extracted_r.json").write_text(json.dumps({"endpoint": "sec_earnings_8k_dates", "rows": [], "truncated": True, "pages": 5, "total": 612}), encoding="utf-8")
    _, _, cut = E._event_rows("sec_earnings_8k_dates", "JPM", tmp_path)
    assert calls[-1] == ("sec_earnings_8k_dates", "JPM", {}, 60) and cut == "SEC 全文检索命中 612 条（含附件和更正版），只取了前 5 页（每页 100 条），其余的没取到"
    (raw / "extracted_r.json").write_text(json.dumps({"rows": [], "truncated": ["末期业绩"]}), encoding="utf-8")
    _, _, cut = E._event_rows("hkex_results_dates", "00700.HK", tmp_path)
    assert calls[-1] == ("hkex_results_dates", "00700", {}, 60) and cut == "末期业绩超过一次能取的条数，更早的没取到"
    (raw / "extracted_r.json").write_text(json.dumps({"rows": [], "truncated": []}), encoding="utf-8")
    assert E._event_rows("hkex_results_dates", "00700.HK", tmp_path)[2] is None


# ── A 股：回购方案 / 机构调研 / 龙虎榜 / 限售解禁 ──

def test_buyback_events_use_first_notice_and_merge_same_day():
    rows = [{"first_notice": "2024-09-21", "amount_lower": 3e9, "amount_upper": 6e9, "progress": "完成实施", "done_amount": 5999985966.95},
            {"first_notice": "2023-01-05", "amount_lower": None, "amount_upper": 1e8, "progress": "实施中", "done_amount": 0},
            {"first_notice": "2023-01-05", "amount_lower": None, "amount_upper": None, "progress": "董事会预案"},
            {"first_notice": None, "amount_upper": 1e8}]
    evs, bad = E._buyback_events(rows)
    assert bad == 1
    by = {e["date"]: e for e in evs}
    assert by["2024-09-21"]["detail"] == "金额 30.00–60.00 亿元，完成实施，已回购 60.00 亿元"
    assert by["2023-01-05"]["detail"] == "金额上限 1.00 亿元，实施中；方案没写金额，董事会预案", "已回购 0 不写"
    assert all(e["label"] == "回购方案首次公告" and e["direction"] is None for e in evs)


def test_survey_events_use_notice_date_and_merge():
    rows = [{"notice_date": "2026-09-03", "survey_date": "2026-08-29", "org_count": 152, "survey_way": "电话会议"},
            {"notice_date": "2026-07-10", "survey_date": "2026-07-08", "org_count": 3},
            {"notice_date": "2026-07-10", "survey_date": "2026-07-09", "org_count": None}]
    evs, bad = E._survey_events(rows)
    by = {e["date"]: e for e in evs}
    assert bad == 0 and by["2026-09-03"]["detail"] == "接待日 2026-08-29，152 家机构，电话会议"
    assert by["2026-07-10"]["detail"] == "2 次调研，合计 机构家数没写全", "有一次没写家数就不报合计"


def test_dragon_events_start_next_day_and_group_by_net():
    rows = [{"date": "2026-07-28", "reason": "日跌幅达到15%的前5只证券", "change_pct": -15.687, "net_buy": 2838898384.3},
            {"date": "2026-07-28", "reason": "连续三个交易日内，跌幅偏离值累计达到30%的证券", "change_pct": -15.687, "net_buy": 1.5e9},
            {"date": "2026-07-31", "reason": "日涨幅偏离值达到7%的前5只证券", "change_pct": 9.98, "net_buy": -2e8},
            {"date": "2026-08-07", "reason": "a", "net_buy": 1e8}, {"date": "2026-08-07", "reason": "b", "net_buy": -1e8},
            {"date": "2026-08-14", "reason": "c", "net_buy": None}]
    evs, bad = E._dragon_events(rows)
    by = {e["date"]: e for e in evs}
    a = by["2026-07-28"]
    assert a["direction"] == "buy" and a["day0_from"] == "2026-07-29", "收盘后才公布：第 0 天从下一天起算"
    assert a["detail"] == ("当天 -15.69%；日跌幅达到15%的前5只证券、连续三个交易日内，跌幅偏离值累计达到30%的证券；"
                           "各条理由的席位净额 +28.39 / +15.00 亿元"), "几条理由口径不同：净额分别写、不相加；理由照原文"
    assert by["2026-07-31"]["direction"] == "sell" and by["2026-07-31"]["detail"].endswith("席位净额 -2.00 亿元")
    assert by["2026-08-07"]["direction"] == "other" and by["2026-08-14"]["direction"] == "other"
    assert by["2026-08-14"]["detail"] == "c；席位净额没写"
    # 审计 D11：一条 +1 亿、一条没写 —— 不能当成净买入
    mixed, _ = E._dragon_events([{"date": "2026-09-01", "reason": "d", "net_buy": 1e8}, {"date": "2026-09-01", "reason": "e", "net_buy": None}])
    assert mixed[0]["direction"] == "other" and mixed[0]["detail"].endswith("席位净额 +1.00 亿元（另有 1 条理由没写净额，不归组）")


def test_lockup_events_split_past_and_upcoming_and_size_boundary():
    rows = [{"date": "2027-06-23", "type": "定向增发机构配售股份", "able_shares_10k": 54718.2073, "total_ratio_pct": 6.39},
            {"date": "2026-10-09", "type": "首发原股东限售股份", "able_shares_10k": 800, "total_ratio_pct": 1.0},
            {"date": "2025-03-03", "type": "股权激励限售股份", "able_shares_10k": 12.5, "total_ratio_pct": 0.62},
            {"date": "2025-03-03", "type": "股权激励限售股份", "able_shares_10k": 10, "total_ratio_pct": 0.37},
            {"date": "2024-01-02", "type": "首发战略配售股份", "able_shares_10k": 6742.48, "total_ratio_pct": None},
            {"date": None, "type": "x"}]
    past, bad, upcoming = E._lockup_events(rows, E.date(2026, 10, 9))
    assert bad == 1
    by = {e["date"]: e for e in past}
    assert by["2026-10-09"]["direction"] == "large", "正好 1% 算较大；当天的算已经到了"
    assert by["2025-03-03"]["direction"] == "small" and by["2025-03-03"]["detail"] == "股权激励限售股份，实际可流通 22 万股，占总股本 0.99%", "同一天两批合并相加"
    assert by["2024-01-02"]["direction"] == "other" and "占总股本" not in by["2024-01-02"]["detail"]
    assert upcoming == [{"date": "2027-06-23", "label": "解禁", "detail": "定向增发机构配售股份，实际可流通 5.47 亿股，占总股本 6.39%"}]


def test_build_dragon_tiger_day0_is_next_trading_day(monkeypatch, tmp_path):
    cal = _long_cal()
    day = pd.Timestamp("2020-03-13")                                  # 周五上榜：当天 +10%，下周一 +5%
    k = int(cal.searchsorted(day))
    stock = pd.Series([10.0] * k + [11.0] + [11.55] * (len(cal) - k - 1), index=cal)
    rows = [{"date": "2020-03-13", "reason": "日涨幅偏离值达到7%", "change_pct": 10.0, "net_buy": 3e7}]
    out, _ = _build(monkeypatch, tmp_path, rows, kind="dragon_tiger", stock=stock)
    (ev,) = out["events"]
    assert ev["date"] == "2020-03-13" and ev["day0"] == "2020-03-16"
    assert ev["pre"] == pytest.approx(0.1) and ev["d0_1"] == pytest.approx(0.05), "上榜当天的涨幅落在事件前那一档"
    assert "day0_from" not in ev and ev["direction"] == "buy"
    assert [g["key"] for g in out["summary"]] == ["all", "buy"]
    assert any("上榜日之后的第一个交易日" in n for n in out["notes"])


def test_build_lockup_lists_upcoming_without_returns(monkeypatch, tmp_path):
    rows = [{"date": "2020-06-01", "type": "首发原股东限售股份", "able_shares_10k": 5000, "total_ratio_pct": 2.5},
            {"date": "2099-01-05", "type": "定向增发机构配售股份", "able_shares_10k": 100, "total_ratio_pct": 0.1}]
    out, _ = _build(monkeypatch, tmp_path, rows, kind="lockup")
    assert [e["date"] for e in out["events"]] == ["2020-06-01"] and out["events"][0]["direction"] == "large"
    assert out["upcoming"] == [{"date": "2099-01-05", "label": "解禁", "detail": "定向增发机构配售股份，实际可流通 100 万股，占总股本 0.10%"}]
    assert [g["key"] for g in out["summary"]] == ["all", "large"]
    assert out["summary"][1]["label"] == "较大的解禁（实际可流通股数占总股本 ≥ 1%）"
    # 过去一次都没有、只有排期的：不取价格，给排期
    monkeypatch.setattr(E, "_event_rows", lambda *a: (rows[1:], "eastmoney", None))
    monkeypatch.setattr(E, "_closes", lambda *a: pytest.fail("没有到期的解禁不该取价格"))
    out = E.run({"symbol": "600519", "kind": "lockup"}, tmp_path)
    assert out["events"] == [] and out["notes"] == ["这只股票过去没有限售解禁，只有已经排期、还没到的"] and len(out["upcoming"]) == 1
    # 别的类型不带 upcoming
    other, _ = _build(monkeypatch, tmp_path, [{"first_notice": "2020-06-01", "amount_upper": 1e8}], kind="buyback")
    assert "upcoming" not in other and any("首次公告" in n for n in other["notes"])


def test_build_new_kinds_name_their_date_in_gaps(monkeypatch, tmp_path):
    for kind, row, word in (("dragon_tiger", {"date": None}, "上榜日"), ("lockup", {"date": None}, "解禁日"),
                            ("survey", {"notice_date": None}, "公告日")):
        monkeypatch.setattr(E, "_event_rows", lambda *a, r=row: ([r], "eastmoney", None))
        out = E.run({"symbol": "600519", "kind": kind}, tmp_path)
        assert out["gaps"][0]["reason"] == f"有 1 条没有{word}，没算进来", kind


def test_market_today_uses_the_exchange_timezone_not_the_machine(monkeypatch):
    """解禁「已到 / 未到」和取价截止日按交易所那边的今天：UTC 1 点时上海已是 9 日，纽约还是 8 日。"""
    class Fixed(E.datetime):
        @classmethod
        def now(cls, tz=None):
            return E.datetime(2026, 10, 9, 1, 0, tzinfo=E.ZoneInfo("UTC")).astimezone(tz)
    monkeypatch.setattr(E, "datetime", Fixed)
    assert E._market_today("a_share") == E.date(2026, 10, 9)
    assert E._market_today("us_equity") == E.date(2026, 10, 8)
    assert "date.today()" not in Path(E.__file__).read_text(encoding="utf-8"), "回看里不再用本机日期"
