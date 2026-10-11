import pytest
from test_registry_sources import _ctx
from sources import mappers_global as m

@pytest.mark.parametrize("currency,expected", [("CNY", "CNY"), ("人民币", "CNY"), ("USD", "USD"), ("HKD", "HKD")])
def test_report_currency_not_listing_currency(currency, expected):
    ctx = _ctx(market="HK", symbol="00700", ep={"id": "financials"}, args={"statement": "income"})
    out = m.em_financials_global_map([{"ITEM_NAME": "营业收入", "AMOUNT": 100, "CURRENCY": currency, "REPORT_DATE": "2026-06-30"}], ctx)
    assert out["evidence"][0]["currency"] == expected

def test_unknown_currency_does_not_invent_money():
    ctx = _ctx(market="HK", symbol="00700", ep={"id": "ind"})
    out = m.em_key_indicators_global_map([{"OPERATE_INCOME": 100, "ROE_AVG": 5, "CURRENCY": "UNKNOWN", "REPORT_DATE": "2026-06-30"}], ctx)
    assert not any(e["field"] == "revenue" for e in out["evidence"])
    assert any(e["field"] == "roe" for e in out["evidence"])
    assert out["status"] == "partial"

def test_kline_missing_extremes_preserves_close():
    ctx = _ctx(market="US", symbol="AAPL", ep={"id": "kline"})
    out = m.kline_map([{"date": "2026-09-01", "close": 10, "high": None, "low": None}], ctx)
    assert out["evidence"]
    assert out["status"] == "partial"

def test_missing_flow_pct_is_not_null_numeric_evidence():
    ctx = _ctx(market="HK", symbol="00700", ep={"id": "flow"})
    out = m.em_fund_flow_global_map([{"date": "2026-09-01", "main_net": 10, "main_pct": None}], ctx)
    assert not any(e["field"] == "main_net_inflow_pct_latest" for e in out["evidence"])


def test_yahoo_outputs_no_target_price_or_single_firm_rating(monkeypatch):
    """产品红线：Yahoo 端点映射后不出现目标价、单一共识评级标签和逐家升降级；机构评级聚合篇数保留。"""
    from sources import mappers_global as mg
    from sources import yahoo

    raw = {
        "financialData": {"currentPrice": {"raw": 200.0}, "targetHighPrice": {"raw": 300.0}, "targetLowPrice": {"raw": 150.0},
                          "targetMeanPrice": {"raw": 250.0}, "recommendationKey": "buy", "numberOfAnalystOpinions": {"raw": 40},
                          "financialCurrency": "USD"},
        "defaultKeyStatistics": {"forwardPE": {"raw": 28.0}},
        "summaryDetail": {"trailingPE": {"raw": 30.0}, "marketCap": {"raw": 3.0e12}},
        "earningsTrend": {"trend": [{"period": "0q", "endDate": "2026-12-31", "earningsEstimate": {"avg": {"raw": 1.5}, "numberOfAnalysts": {"raw": 30}}}]},
        "recommendationTrend": {"trend": [{"period": "0m", "strongBuy": 10, "buy": 20, "hold": 8, "sell": 1, "strongSell": 0}]},
        "upgradeDowngradeHistory": {"history": [{"epochGradeDate": 1760000000, "firm": "SomeBank", "toGrade": "Buy", "fromGrade": "Hold", "action": "up"}]},
        "earningsHistory": {"history": []},
        "earnings": {"financialCurrency": "USD"},  # 分析师预期从这里读报告币种;缺了金额项按审计 B6 不出
    }
    asked = []

    def fake_summary(sym, modules):
        asked.append(list(modules))
        return raw

    monkeypatch.setattr(yahoo, "yahoo_quote_summary", fake_summary)
    ctx = _ctx(market="US", symbol="AAPL", ep={"id": "yahoo"})
    ks = yahoo.key_statistics("AAPL", "US")
    banned = {"target_high", "target_low", "target_mean", "recommendation", "num_analyst_opinions"}
    assert banned.isdisjoint(ks), banned & set(ks)
    ks_fields = {e["field"] for e in mg.yahoo_key_statistics_map(ks, ctx)["evidence"]}
    assert ks_fields and not any(f.startswith("analyst_") for f in ks_fields), ks_fields

    est = yahoo.analyst_estimates("AAPL", "US")
    assert "upgradeDowngradeHistory" not in asked[-1] and "upgrade_downgrade" not in est
    est_ev = mg.yahoo_analyst_map(est, ctx)["evidence"]
    fields = {e["field"] for e in est_ev}
    assert "analyst_rating_change" not in fields
    assert {"rating_buy", "rating_strong_buy", "eps_estimate_avg"} <= fields, "评级聚合篇数与 EPS 预期应保留"
    assert not any("SomeBank" in str(e["value"]) for e in est_ev)
