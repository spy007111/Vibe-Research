"""Codex 审计第三轮(2026-10-10)取数层几条的回归测试:不联网,东财那一步换成给定的原始行。

重点:源没给的数不当 0、比例的分母要和字段名一致、缺了就进缺口并标部分结果。
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from sources import eastmoney, mappers  # noqa: E402


def _ctx(**kw):
    base = {"script": "t_ep", "symbol": "688981", "market": "SH", "source": "eastmoney", "endpoint": "ep", "raw_ref": "raw/x.json", "raws": [], "as_of": None, "args": {}, "ep": {"id": "t_ep"}}
    base.update(kw)
    return base


_LIFT = [{"SECURITY_CODE": "688981", "FREE_DATE": "2027-06-23 00:00:00", "FREE_SHARES_TYPE": "定向增发机构配售股份",
          "FREE_SHARES": 254777.5982, "ABLE_FREE_SHARES": 54718.2073, "FREE_RATIO": 0.2735, "TOTAL_RATIO": 0.0639056281},
         {"SECURITY_CODE": "688981", "FREE_DATE": "2022-07-18 00:00:00", "FREE_SHARES_TYPE": "首发战略配售股份",
          "FREE_SHARES": 193846.3, "ABLE_FREE_SHARES": 6742.48, "FREE_RATIO": 0.0348, "TOTAL_RATIO": None}]


def test_b2_old_lockup_endpoint_reports_total_share_ratio(monkeypatch):
    """🔴 旧端点把占流通股比例(FREE_RATIO 27.35%)按「占总股本」输出;正确是 TOTAL_RATIO 6.39%。源没给就进缺口。"""
    def fake(report, filter_str="", **kw):
        assert report == "RPT_LIFT_STAGE"
        return [_LIFT[0]] if "FREE_DATE>=" in filter_str else list(_LIFT)
    monkeypatch.setattr(eastmoney, "eastmoney_datacenter", fake)
    monkeypatch.setattr(eastmoney, "last_raw_ref", lambda: "raw/lift.json")
    res = eastmoney.lockup_expiry("688981", trade_date="2026-10-10", forward_days=365 * 2)
    assert res["upcoming"][0]["ratio"] == 0.0639056281 and res["history"][1]["ratio"] is None
    assert "shares" not in res["history"][0], "口径不清的 FREE_SHARES 不取"
    got = mappers.em_lockup(res, _ctx())
    ratios = [e for e in got["evidence"] if e["field"] == "lockup_ratio_of_total"]
    assert [e["value"] for e in ratios] == [0.0639056281, 0.0639056281], "待解禁一条、历史里同一批一条"
    assert not any(e["field"] == "lockup_shares" for e in got["evidence"])
    assert all(e["value"] != 0.2735 for e in got["evidence"])
    assert [(m["field"], m["period"]) for m in got["missing"]] == [("lockup_ratio_of_total", "2022-07-18")]


def test_b3_fund_flow_latest_dash_is_missing_not_zero(monkeypatch):
    """🔴 最新一天主力净额是 "-":以前写成 0 元、状态 ok。"""
    lines = [f"2026-10-0{d},{d}00.0,1,2,3,4,5" for d in range(1, 6)] + ["2026-10-09,-,-,-,-,-,-"]
    monkeypatch.setattr(eastmoney, "_push2his_json", lambda *a, **k: {"data": {"klines": lines}})
    rows = eastmoney.stock_fund_flow_120d("600519")
    assert rows[-1]["main_net"] is None and rows[0]["main_net"] == 100.0
    got = mappers.em_fund_flow_120d(rows, _ctx(symbol="600519"))
    assert not any(e["field"] == "main_net_inflow_daily_latest" for e in got["evidence"])
    assert got["status"] == "partial" and got["missing"][0]["field"] == "main_net_inflow_daily_latest" and got["missing"][0]["period"] == "2026-10-09"
    # 真实的 0 照常是 0
    zero = mappers.em_fund_flow_120d(eastmoney_rows_with_zero(), _ctx(symbol="600519"))
    assert next(e for e in zero["evidence"] if e["field"] == "main_net_inflow_daily_latest")["value"] == 0.0 and zero.get("status") is None


def eastmoney_rows_with_zero():
    return [{"date": f"2026-10-0{d}", "main_net": 0.0 if d == 5 else 1.0} for d in range(1, 6)]


def test_b3_stock_dragon_tiger_missing_amounts_are_not_zero(monkeypatch):
    """🔴 个股龙虎榜 BILLBOARD_NET_AMT=null 以前写成净买 0 万元;机构席位金额缺失时机构净额也不算。"""
    def fake(report, columns="ALL", filter_str="", page_size=50, sort_columns="", sort_types="-1", page=1):
        if report == "RPT_DAILYBILLBOARD_DETAILSNEW":
            return [{"TRADE_DATE": "2026-10-09 00:00:00", "EXPLANATION": "日涨幅偏离值达到7%", "BILLBOARD_NET_AMT": None, "TURNOVERRATE": None},
                    {"TRADE_DATE": "2026-10-01 00:00:00", "EXPLANATION": "连续三个交易日", "BILLBOARD_NET_AMT": 0, "TURNOVERRATE": 3.456}]
        if report == "RPT_BILLBOARD_DAILYDETAILSBUY":
            return [{"OPERATEDEPT_NAME": "机构专用", "OPERATEDEPT_CODE": "0", "BUY": None, "SELL": None, "NET": None}]
        return [{"OPERATEDEPT_NAME": "某营业部", "OPERATEDEPT_CODE": "1", "BUY": 0, "SELL": 5e6, "NET": -5e6}]
    monkeypatch.setattr(eastmoney, "eastmoney_datacenter", fake)
    monkeypatch.setattr(eastmoney, "last_raw_ref", lambda: "raw/lhb.json")
    res = eastmoney.dragon_tiger_board("600519", trade_date="2026-10-10")
    assert res["records"][0]["net_buy"] is None and res["records"][0]["turnover"] is None
    assert res["records"][1]["net_buy"] == 0.0 and res["records"][1]["turnover"] == 3.46, "真实的 0 照常是 0"
    assert res["institution"] == {"buy_amt": None, "sell_amt": None, "net_amt": None}
    assert res["seats"]["buy"][0]["buy_amt"] is None and res["seats"]["sell"][0]["sell_amt"] == 500.0
    got = mappers.em_dragon_tiger(res, _ctx(symbol="600519"))
    nets = [(e["period"], e["value"]) for e in got["evidence"] if e["field"] == "dragon_tiger_net_buy"]
    assert nets == [("2026-10-01", 0.0)]
    assert not any(e["field"] == "dragon_tiger_institution_net" for e in got["evidence"])
    assert sorted(m["field"] for m in got["missing"]) == ["dragon_tiger_institution_net", "dragon_tiger_net_buy", "dragon_tiger_turnover"]
