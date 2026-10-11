"""取数层「部分结果不能冒充齐全」:分页中途断、RSS 部分源失败、申万历史按截止日截(2026-10-11 审计)。"""
from __future__ import annotations

import pandas as pd

from test_registry_sources import _ctx
from sources import eastmoney, mappers, mappers_cn, sw


def _pages(total: int, sizes: dict[int, int]):
    def fake(_path, params=None, headers=None, timeout=None):
        pn = int((params or {}).get("pn", 1))
        diff = [{"f12": f"B{pn}{i}", "f14": "x", "f3": 1.0, "f62": 1e8, "f184": 1.0, "f6": 1e9} for i in range(sizes.get(pn, 0))]
        return {"data": {"diff": diff, "total": total}}
    return fake


def test_board_fund_flow_short_page_with_rows_left_is_partial(monkeypatch):
    monkeypatch.setattr(eastmoney, "_push2_json", _pages(496, {1: 100, 2: 0}))
    r = eastmoney.board_fund_flow("industry", "today", 500)
    assert len(r["rows"]) == 100 and r["expected"] == 496
    m = mappers.em_board_fund_flow(r, _ctx(symbol="MARKET", market="CN", source="eastmoney", ep={"id": "em_board_fund_flow"}))
    assert m["status"] == "partial" and "只拿到 100" in m["missing"][0]["reason"]
    # 取够了(或上游总数就这么多)照常 ok
    monkeypatch.setattr(eastmoney, "_push2_json", _pages(150, {1: 100, 2: 50}))
    r = eastmoney.board_fund_flow("industry", "today", 500)
    m = mappers.em_board_fund_flow(r, _ctx(symbol="MARKET", market="CN", source="eastmoney", ep={"id": "em_board_fund_flow"}))
    assert len(r["rows"]) == 150 and m.get("status") in (None, "ok") and not m.get("missing")


def test_turnover_rank_short_page_is_partial(monkeypatch):
    monkeypatch.setattr(eastmoney, "_push2_json", _pages(5400, {1: 100, 2: 10}))
    r = eastmoney.market_turnover_rank(200)
    assert r["returned"] == 110 and r["expected"] == 200
    m = mappers.em_turnover_rank(r, _ctx(symbol="MARKET", market="CN", source="eastmoney", ep={"id": "em_turnover_rank"}))
    assert m["status"] == "partial"


def test_rss_any_failed_source_is_partial_and_all_failed_is_failed():
    ctx = _ctx(symbol="MARKET", market="CN", source="rss", ep={"id": "rss_news"}, args={})
    item = {"source": "甲", "industry": "ai", "title": "一条新闻", "link": "https://a.example/1", "published": "2026-10-10 08:00", "redline": []}
    base = {"industry": "ai", "sources_tried": 16, "recent_days": 3, "industries": []}
    m = mappers_cn.rss_news_map({**base, "sources_ok": 1, "items": [item], "failures": [{"source": f"s{i}", "error": "timeout"} for i in range(15)]}, ctx)
    assert m["status"] == "partial" and "15/16" in (m.get("degraded") or "")
    m = mappers_cn.rss_news_map({**base, "sources_ok": 16, "items": [item], "failures": []}, ctx)
    assert m.get("status") in (None, "ok")
    m = mappers_cn.rss_news_map({**base, "sources_ok": 0, "items": [], "failures": [{"source": f"s{i}", "error": "x"} for i in range(16)]}, ctx)
    assert m["status"] == "failed"


def test_sw_history_and_count_stop_at_as_of(monkeypatch):
    df = pd.DataFrame({"code": ["600000", "600000"], "industry_code": ["480301", "490101"], "start_date": pd.to_datetime(["2025-01-01", "2026-10-09"])})
    df["l1_code"] = df["industry_code"].str[:2] + "0000"
    df["l2_code"] = df["industry_code"].str[:4] + "00"
    monkeypatch.setattr(sw, "sw_industry_history", lambda: df)
    r = sw.sw_industry("600000", "2026-09-30")
    assert r["current"]["industry_code"] == "480301"
    assert [h["industry_code"] for h in r["history"]] == ["480301"], "截止日之后的调整不进历史"
    m = mappers_cn.sw_industry_map(r, _ctx(symbol="600000", market="CN", source="sw", ep={"id": "sw_industry"}))
    assert next(e for e in m["evidence"] if e["field"] == "sw_industry_change_count")["value"] == 1
    assert len(sw.sw_industry("600000", "2026-10-10")["history"]) == 2


def test_missing_flow_and_margin_fields_are_not_zero(monkeypatch):
    """港美股资金流「-」、两融省略字段:留空不出证据,不写成 0。"""
    from sources import mappers_global
    monkeypatch.setattr(eastmoney, "resolve_global_secid", lambda s, m: ("105", "NVDA"))
    monkeypatch.setattr(eastmoney, "_push2his_json", lambda *a, **k: {"data": {"klines": ["2026-10-08,1,2,3,4,5,0.5", "2026-10-09,-,-,-,-,-,-"]}})
    rows = eastmoney.fund_flow_daily_global("NVDA", "US")
    assert rows[-1]["main_net"] is None and rows[-1]["main_pct"] is None
    m = mappers_global.em_fund_flow_global_map(rows, _ctx(symbol="NVDA", market="US", source="eastmoney", ep={"id": "em_fund_flow_global"}))
    assert not [e for e in m["evidence"] if e["field"] in ("main_net_inflow_daily_latest", "main_net_inflow_pct_latest")], "最新一行没给就不出最新值"
    monkeypatch.setattr(eastmoney, "eastmoney_datacenter", lambda *a, **k: [{"DATE": "2026-10-09 00:00:00", "RZMRE": 5.0}])
    r = eastmoney.margin_trading("600000")
    assert r[0]["rzye"] is None
    m = mappers.em_margin(r, _ctx(symbol="600000", market="CN", source="eastmoney", ep={"id": "em_margin_trading"}))
    assert not [e for e in m["evidence"] if e["field"].startswith("margin_financing_balance")  and e["unit"] == "元"]


def test_missing_core_fields_mark_the_result_partial(monkeypatch):
    """源没给的核心字段要记进 missing:只省略证据的话,剩下的条数 / 买入额证据会让结果被判成完整(v2.2.0 审计 Codex 第 5 条)。
    户均持股、分红的转增 / 送股源里本来就常是空的(10-11 实测),不算缺。"""
    from sources import mappers_global
    monkeypatch.setattr(eastmoney, "resolve_global_secid", lambda s, m: ("105", "NVDA"))
    klines = [f"2026-10-0{d},1,2,3,4,5,0.5" for d in range(1, 7)] + ["2026-10-09,-,-,-,-,-,-"]
    monkeypatch.setattr(eastmoney, "_push2his_json", lambda *a, **k: {"data": {"klines": klines}})
    rows = eastmoney.fund_flow_daily_global("NVDA", "US")
    m = mappers_global.em_fund_flow_global_map(rows, _ctx(symbol="NVDA", market="US", source="eastmoney", ep={"id": "em_fund_flow_global"}))
    assert len(rows) >= 5 and m.get("status") is None, "行数够,不靠短序列那条规则"
    assert {x["field"] for x in m["missing"]} == {"main_net_inflow_daily_latest", "main_net_inflow_pct_latest"}

    monkeypatch.setattr(eastmoney, "eastmoney_datacenter", lambda *a, **k: [{"DATE": "2026-10-09 00:00:00", "RZMRE": 5.0}])
    m = mappers.em_margin(eastmoney.margin_trading("600000"), _ctx(symbol="600000", market="CN", source="eastmoney", ep={"id": "em_margin_trading"}))
    assert m["evidence"] and {x["field"] for x in m["missing"]} == {"margin_financing_balance", "margin_short_balance"}

    monkeypatch.setattr(eastmoney, "eastmoney_datacenter", lambda *a, **k: [
        {"END_DATE": "2026-06-30 00:00:00", "HOLDER_NUM_RATIO": 1.5}, {"END_DATE": "2026-03-31 00:00:00", "HOLDER_NUM": 1000, "HOLDER_NUM_RATIO": 2.0}])
    m = mappers.em_holder_num(eastmoney.holder_num_change("600000"), _ctx(symbol="600000", market="CN", source="eastmoney", ep={"id": "em_holder_num"}))
    assert [(x["field"], x["period"]) for x in m["missing"]] == [("shareholder_count", "2026-06-30")], "户均持股空着不算缺"

    monkeypatch.setattr(eastmoney, "eastmoney_datacenter", lambda *a, **k: [{"EX_DIVIDEND_DATE": "2026-06-20 00:00:00", "PRETAX_BONUS_RMB": 280.0}])
    m = mappers.em_dividend(eastmoney.dividend_history("600000"), _ctx(symbol="600000", market="CN", source="eastmoney", ep={"id": "em_dividend"}))
    assert not m["missing"], "只派现、没转增送股是常态,不算缺"
