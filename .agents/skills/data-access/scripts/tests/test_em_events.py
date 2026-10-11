"""事件回看用的三张东财个股历史表：回购方案（首次公告日）、龙虎榜历次、限售解禁历次。全程不联网 —— 东财那一步换成给定的原始行。

重点：字段取对、单位照写（占总股本小数 ×100）、不取口径不清 / 东财自编的列、请求的是这只股票且回了别的股票时报错。
"""
from __future__ import annotations

import pytest

from test_astock_ported import _rows_file, _run
from sources import astock_ported as P, em_events as E, mappers_astock as M


def _fake_rows(monkeypatch, rows, seen=None):
    def fake(report, filter_str, sort_columns, sort_types, **kw):
        if seen is not None:
            seen.append((report, filter_str, sort_columns, sort_types))
        return rows
    monkeypatch.setattr(P, "_em_datacenter_strict", fake)


_BUYBACK = {"DIM_SCODE": "600519", "SECURITYSHORTNAME": "贵州茅台", "DIM_DATE": "2024-09-21 00:00:00", "DIM_TRADEDATE": "2024-09-20 00:00:00",
            "REPURPROGRESS": "006", "REPURSTARTDATE": "2024-11-27 00:00:00", "REPURENDDATE": "2025-11-27 00:00:00",
            "REPURAMOUNTLOWER": 3000000000, "REPURAMOUNTLIMIT": 6000000000, "REPURPRICECAP": 1795.78,
            "REPURAMOUNT": 5999985966.95, "REPURNUM": 4153600, "UPDATEDATE": "2025-08-30 00:00:00", "REPUROBJECTIVE": "基于对公司未来发展前景的信心……"}


def test_buyback_history_takes_first_notice_and_skips_objective_text(monkeypatch, tmp_path):
    seen: list = []
    _fake_rows(monkeypatch, [_BUYBACK], seen)
    f = E.buyback_history("600519")
    assert seen[0][:3] == ("RPTA_WEB_GETHGLIST_NEW", '(DIM_SCODE="600519")', "DIM_DATE,REPURCODE")
    r = f.iloc[0].to_dict()
    assert r["first_notice"] == "2024-09-21" and r["plan_start"] == "2024-11-27", "首次公告日不是计划起始日"
    assert r["progress"] == "完成实施" and r["amount_upper"] == 6e9 and r["done_amount"] == pytest.approx(5999985966.95)
    assert "objective" not in f.columns, "回购目的是公司原文，不进结果"
    res = _run(tmp_path, M.buyback_history_map, f, symbol="600519", args={"limit": 500})
    assert res["evidence"][0]["field"] == "buyback_plan_count" and res["evidence"][0]["value"] == 1
    assert {e["field"] for e in res["evidence"]} >= {"buyback_amount_upper", "buyback_done_amount", "buyback_progress"}
    assert _rows_file(tmp_path, res)["rows"][0]["first_notice"] == "2024-09-21"


def test_dragon_tiger_history_keeps_reason_and_amounts_but_not_success_rate(monkeypatch, tmp_path):
    row = {"SECURITY_CODE": "300308", "SECURITY_NAME_ABBR": "中际旭创", "TRADE_DATE": "2026-07-28 00:00:00", "EXPLANATION": "日跌幅达到15%的前5只证券",
           "EXPLAIN": "3家机构卖出，成功率40.86%", "CLOSE_PRICE": 908, "CHANGE_RATE": -15.687, "TURNOVERRATE": 4.8746,
           "BILLBOARD_NET_AMT": 2838898384.3, "BILLBOARD_BUY_AMT": 10601818014.59, "BILLBOARD_SELL_AMT": 7762919630.29,
           "DEAL_AMOUNT_RATIO": 35.59, "TRADE_ID": 100383644}
    seen: list = []
    _fake_rows(monkeypatch, [row], seen)
    f = E.dragon_tiger_history("300308")
    assert seen[0][1:3] == ('(SECURITY_CODE="300308")', "TRADE_DATE,TRADE_ID")
    r = f.iloc[0].to_dict()
    assert r["date"] == "2026-07-28" and r["reason"] == "日跌幅达到15%的前5只证券" and r["change_pct"] == -15.687
    assert r["net_buy"] == pytest.approx(2838898384.3)
    assert "成功率" not in str(f.to_dict("records")), "东财自编的成功率不取"
    res = _run(tmp_path, M.dragon_tiger_history_map, f, symbol="300308", args={"limit": 2000})
    net = next(e for e in res["evidence"] if e["field"] == "lhb_net_buy")
    assert net["unit"] == "元" and net["period"] == "2026-07-28"


def test_lockup_history_converts_total_ratio_and_skips_float_ratio(monkeypatch, tmp_path):
    rows = [{"SECURITY_CODE": "688981", "SECURITY_NAME_ABBR": "中芯国际", "FREE_DATE": "2027-06-23 00:00:00", "FREE_SHARES_TYPE": "定向增发机构配售股份",
             "FREE_SHARES": 254777.5982, "ABLE_FREE_SHARES": 54718.2073, "FREE_RATIO": 0.2735, "TOTAL_RATIO": 0.0639056281, "BATCH_HOLDER_NUM": 5},
            {"SECURITY_CODE": "688981", "SECURITY_NAME_ABBR": "中芯国际", "FREE_DATE": "2022-07-18 00:00:00", "FREE_SHARES_TYPE": "首发战略配售股份",
             "FREE_SHARES": 193846.3, "ABLE_FREE_SHARES": 6742.48, "FREE_RATIO": 0.0348, "TOTAL_RATIO": None, "BATCH_HOLDER_NUM": None}]
    _fake_rows(monkeypatch, rows)
    f = E.lockup_history("688981")
    a, b = f.to_dict("records")
    assert a["able_shares_10k"] == pytest.approx(54718.2073) and a["total_ratio_pct"] == 6.3906 and a["holders"] == 5
    assert "FREE_RATIO" not in str(f.columns.tolist()) and "float_ratio" not in str(f.columns.tolist())
    res = _run(tmp_path, M.lockup_history_map, f, symbol="688981", args={"limit": 500})
    assert res["evidence"][0]["value"] == 2 and res["evidence"][0]["unit"] == "批"
    old = _rows_file(tmp_path, res)["rows"][1]
    assert old["date"] == "2022-07-18" and old["total_ratio_pct"] is None and old["holders"] is None, "源没写就留空，不当 0"


def test_empty_is_partial_not_failure_and_other_stock_is_an_error(monkeypatch, tmp_path):
    _fake_rows(monkeypatch, [])
    f = E.lockup_history("600519")
    res = _run(tmp_path, M.lockup_history_map, f, symbol="600519", args={"limit": 500})
    assert res["status"] == "partial" and res["evidence"][0]["value"] == 0 and "没有限售解禁" in res["degraded"]
    _fake_rows(monkeypatch, [{**_BUYBACK, "DIM_SCODE": "000001"}])
    with pytest.raises(RuntimeError, match="DIM_SCODE=600519"):
        E.buyback_history("600519")
    with pytest.raises(ValueError):
        E.dragon_tiger_history("600519", limit=0)
