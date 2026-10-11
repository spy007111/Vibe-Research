"""港美股六阶段研究取数(global_research.py + mappers_global 研究段)离线测试:交易时段、报价时效字段、按公告日过滤、期间归类、币种单位。"""
import re
from datetime import datetime, timezone

import pytest
from test_registry_sources import _ctx

from sources import global_research as gr
from sources import mappers_global as mg

# 与编排器 hardtest judgeArtifacts 同一套语义判据(期间格式 + 币种 ↔ 单位配对)
_PERIOD = re.compile(r"^(\d{4}-\d{2}-\d{2}|\d{4}Q[1-4]|\d{4}H[12]|FY\d{4}|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}|\d{4})$")
_MONEY_FIELDS = re.compile(r"(^|_)(revenue|net_profit|total_market_cap|price|eps_consensus|eps_basic|cash|asset|liabilit)(?!.*count)")


def _semantic_ok(e: dict) -> bool:
    money = bool(_MONEY_FIELDS.search(e["field"])) or e["currency"] != "n/a"
    if money:
        u, c = e["unit"], e["currency"]
        cur_ok = (c == "CNY" and re.search(r"元", u) and not re.search(r"美元|新台币|港元", u)) or (c == "USD" and "美元" in u) or (c == "HKD" and "港元" in u)
    else:
        cur_ok = e["currency"] in ("CNY", "n/a", "USD", "HKD", "TWD")
    return bool(_PERIOD.match(e["period"])) and bool(e["unit"]) and bool(cur_ok)


def _utc(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)


# ---------- 交易时段 ----------
@pytest.mark.parametrize("now,bday,want", [
    ("2026-07-15 13:35", "2026-07-15", "trading"),          # 夏令时 09:35 EDT
    ("2026-01-14 13:35", "2026-01-13", "pre_open"),         # 冬令时 08:35 EST,基准仍是昨天
    ("2026-07-15 20:30", "2026-07-15", "post_close"),       # 16:30 EDT
    ("2026-07-18 15:00", "2026-07-17", "non_trading_day"),  # 周六
    ("2026-07-03 15:00", "2026-07-02", "non_trading_day"),  # 周五 11:00 EDT 基准仍是前一天 → 当地假期
    ("2026-07-15 13:40", "2026-07-14", "pre_open"),         # 开盘 10 分钟内基准还没更新:不急着判休市
])
def test_us_session_phase(now, bday, want):
    assert gr.session_phase("US", _utc(now), bday) == want


@pytest.mark.parametrize("now,bday,want", [
    ("2026-10-08 01:00", "2026-10-07", "pre_open"),    # 09:00 HKT
    ("2026-10-08 04:30", "2026-10-08", "trading"),     # 12:30 午休仍记 trading
    ("2026-10-08 08:05", "2026-10-08", "trading"),     # 16:05 收盘竞价
    ("2026-10-08 08:15", "2026-10-08", "post_close"),  # 16:15
    ("2026-10-01 03:00", "2026-09-30", "non_trading_day"),  # 国庆假期,基准停在前一天
])
def test_hk_session_phase(now, bday, want):
    assert gr.session_phase("HK", _utc(now), bday) == want


# ---------- 报价 + 基准 ----------
def _tx_line(key: str, n: int, vals: dict) -> str:
    f = [""] * n
    for i, v in vals.items():
        f[i] = str(v)
    return f'v_{key}="' + "~".join(f) + '";'


class _R:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        return None


def test_quote_ref_hk_parses_benchmark_day_and_stale(monkeypatch):
    stock = _tx_line("r_hk00700", 78, {1: "腾讯控股", 2: "00700", 3: "420.6", 4: "420.6", 6: "0", 30: "2026/10/07 16:08:24", 39: "15.0", 45: "37000", 46: "TENCENT", 75: "HKD"})
    bench = _tx_line("hkHSI", 78, {1: "恒生指数", 2: "HSI", 3: "23785.79", 30: "2026/10/08 16:08:00"})
    asked = []
    monkeypatch.setattr(gr, "http_get", lambda url, **k: asked.append(url) or _R(stock + "\n" + bench))
    q = gr.global_quote_ref("700", "HK", now=_utc("2026-10-08 09:00"))
    assert asked == ["https://qt.gtimg.cn/q=r_hk00700,hkHSI"]
    assert q["quote_date"] == "2026-10-07" and q["reference_quote_day"] == "2026-10-08"
    assert q["is_stale"] is True and q["session_phase"] == "post_close"
    out = mg.global_quote_ref_map(q, _ctx(market="HK", symbol="00700", ep={"id": "global_quote_ref"}))
    assert out["status"] == "partial" and "is_stale" in out["degraded"]
    x = out["extra"]
    assert (x["quote_date"], x["reference_quote_day"], x["last_trading_day"], x["is_stale"]) == ("2026-10-07", "2026-10-08", "2026-10-08", True)
    cap = next(e for e in out["evidence"] if e["field"] == "total_market_cap")
    assert (cap["unit"], cap["currency"]) == ("亿港元", "HKD")
    assert all(_semantic_ok(e) for e in out["evidence"]), [e for e in out["evidence"] if not _semantic_ok(e)]


def test_quote_ref_missing_stock_is_empty(monkeypatch):
    bench = _tx_line("usINX", 73, {1: "标普500", 3: "7700", 30: "2026-10-08 11:00:00"})
    monkeypatch.setattr(gr, "http_get", lambda url, **k: _R('v_usZZZZ="1";\n' + bench))
    assert gr.global_quote_ref("ZZZZ", "US") == {}
    assert mg.global_quote_ref_map({}, _ctx(market="US", symbol="ZZZZ"))["status"] == "failed"


def test_quote_ref_without_benchmark_reports_missing_reference(monkeypatch):
    stock = _tx_line("usAAPL", 73, {1: "苹果", 3: "337.7", 4: "336.6", 6: "100", 30: "2026-10-08 11:00:00", 35: "USD", 45: "49000", 46: "Apple Inc."})
    monkeypatch.setattr(gr, "http_get", lambda url, **k: _R(stock))
    q = gr.global_quote_ref("AAPL", "US", now=_utc("2026-10-08 15:00"))
    assert q["reference_quote_day"] == "" and q["session_phase"] == ""
    out = mg.global_quote_ref_map(q, _ctx(market="US", symbol="AAPL"))
    assert out["status"] == "partial" and any(m["field"] == "reference_quote_day" for m in out["missing"])


# ---------- 期间归类 ----------
@pytest.mark.parametrize("code,start,end,want", [
    ("001", "2022-09-25", "2023-09-30", "ytd"),     # AAPL 财年 371 天
    ("002", "2026-01-01", "2026-06-30", "ytd"),
    ("003", "2026-01-01", "2026-03-31", "ytd"),
    ("004", "2025-09-28", "2026-06-27", "ytd"),
    ("006", "2026-03-29", "2026-06-27", "quarter"),
    ("008", "2025-12-28", "2026-03-28", "quarter"),
    ("002", "2026-01-01", "2026-09-30", None),      # 代码说半年、实际 9 个月:不猜
    ("005", "2026-01-01", "2026-03-31", None),      # 不认识的代码
    ("001", "2026-12-31", "2026-01-01", None),      # 起止倒置
])
def test_classify_row(code, start, end, want):
    kind, why = gr.classify_row({"DATE_TYPE_CODE": code, "START_DATE": start + " 00:00:00", "REPORT_DATE": end + " 00:00:00"})
    assert kind == want, why


def _row(code, start, end, notice, rev, ccy="人民币", np_key="HOLDER_PROFIT"):
    return {"DATE_TYPE_CODE": code, "START_DATE": start, "REPORT_DATE": end, "NOTICE_DATE": notice, "CURRENCY": ccy, "OPERATE_INCOME": rev, np_key: rev / 4, "BASIC_EPS": 1.5}


def test_financials_point_in_time_filter(monkeypatch):
    from sources import eastmoney
    rows = [
        _row("002", "2026-01-01", "2026-06-30", "2026-08-25", 400),   # 研究日之后才公告 → 丢
        _row("003", "2026-01-01", "2026-03-31", "2026-05-13", 200),
        _row("003", "2026-01-01", "2026-03-31", "2026-05-13", 999),   # 同一起止期重复行 → 只留第一条
        _row("001", "2025-01-01", "2025-12-31", None, 750),           # 缺公告日 → 丢
        _row("004", "2025-01-01", "2025-09-30", "2025-11-13", 550),
        _row("002", "2025-01-01", "2025-09-30", "2025-11-13", 1),     # 代码与长度不符 → 不归类
        _row("001", "2021-01-01", "2021-12-31", "2022-03-20", 500),   # 早于 3 年 → 丢
    ]
    monkeypatch.setattr(eastmoney, "key_indicators_global", lambda symbol, market, page_size: rows)
    d = gr.global_financials_pit("00700", "HK", as_of="2026-06-30")
    assert [r["period"] for r in d["rows"]] == ["2026-01-01..2026-03-31", "2025-01-01..2025-09-30"]
    assert d["rows"][0]["revenue"] == 200 and d["rows"][0]["net_profit_parent"] == 50 and d["rows"][0]["currency"] == "CNY"
    assert (d["dropped_after_as_of"], d["dropped_no_notice"], d["dropped_too_old"]) == (1, 1, 1)
    assert len(d["unclassified"]) == 1 and "9 个月" in d["unclassified"][0]["reason"]
    assert all(r["notice_date"] <= "2026-06-30" for r in d["rows"])
    with pytest.raises(ValueError):
        gr.global_financials_pit("00700", "HK", as_of="2026/06/30")


def test_financials_map_cum_and_quarter_fields():
    res = {"as_of": "2026-10-08", "fetched_rows": 3, "rows": [
        {"period": "2025-12-28..2026-03-28", "start": "2025-12-28", "end": "2026-03-28", "kind": "quarter", "months": 3, "code": "008", "notice_date": "2026-05-01", "currency": "USD", "revenue": 111, "net_profit_parent": 29, "eps_basic": 2.02},
        {"period": "2025-09-28..2025-12-27", "start": "2025-09-28", "end": "2025-12-27", "kind": "ytd", "months": 3, "code": "003", "notice_date": "2026-01-30", "currency": "USD", "revenue": 143, "net_profit_parent": 42, "eps_basic": 2.85},
        {"period": "2024-09-29..2025-09-27", "start": "2024-09-29", "end": "2025-09-27", "kind": "ytd", "months": 12, "code": "001", "notice_date": "2025-10-31", "currency": "USD", "revenue": 416, "net_profit_parent": 112, "eps_basic": 7.49},
        {"period": "2024-06-30..2024-09-28", "start": "2024-06-30", "end": "2024-09-28", "kind": "quarter", "months": 3, "code": "007", "notice_date": "2025-10-30", "currency": None, "currency_raw": "欧元", "revenue": 1},
    ]}
    out = mg.global_financials_pit_map(res, _ctx(market="US", symbol="AAPL", ep={"id": "global_financials_pit"}))
    by = {}
    for e in out["evidence"]:
        by.setdefault(e["field"], []).append(e["period"])
    assert by["revenue_quarter"] == ["2025-12-28..2026-03-28", "2025-09-28..2025-12-27"]   # 一季度既是累计也是单季
    assert by["revenue_cum"] == ["2025-09-28..2025-12-27", "2024-09-29..2025-09-27"]
    eps = next(e for e in out["evidence"] if e["field"] == "eps_basic_cum")
    assert (eps["unit"], eps["currency"], eps["as_of"]) == ("美元/股", "USD", "2026-01-30")
    assert out["status"] == "partial" and out["missing"] and "欧元" in out["missing"][0]["reason"]
    assert out["extra"]["latest_fy_period"] == "2024-09-29..2025-09-27" and out["extra"]["fiscal_year_end_mmdd"] == "09-27"
    assert all(_semantic_ok(e) for e in out["evidence"])


def test_financials_map_cny_units_for_hk_listing():
    res = {"as_of": "2026-10-08", "fetched_rows": 1, "rows": [
        {"period": "2025-01-01..2025-12-31", "start": "2025-01-01", "end": "2025-12-31", "kind": "ytd", "months": 12, "code": "001", "notice_date": "2026-04-09", "currency": "CNY", "revenue": 7.5e11, "net_profit_parent": 2.3e11, "eps_basic": 24.7}]}
    out = mg.global_financials_pit_map(res, _ctx(market="HK", symbol="00700"))
    units = {e["field"]: (e["unit"], e["currency"]) for e in out["evidence"]}
    assert units == {"revenue_cum": ("元", "CNY"), "net_profit_parent_cum": ("元", "CNY"), "eps_basic_cum": ("元/股", "CNY")}
    assert out["status"] == "ok" and all(_semantic_ok(e) for e in out["evidence"])


def test_financials_map_empty_reasons():
    ctx = _ctx(market="HK", symbol="00005")
    assert "研究日" in mg.global_financials_pit_map({"rows": [], "fetched_rows": 5, "as_of": "2020-01-01"}, ctx)["reason"]
    assert "为空" in mg.global_financials_pit_map({"rows": [], "fetched_rows": 0}, ctx)["reason"]


# ---------- 一致预期 ----------
def _trend(pid, end, avg, lo, hi, n):
    return {"period": pid, "end_date": end, "eps_estimate": avg, "eps_low": lo, "eps_high": hi, "num_analysts": n, "revenue_estimate": 1e11}


def test_consensus_fy_labels_and_report_currency():
    res = {"financial_currency": "CNY", "eps_trend": [_trend("0q", "2026-12-31", 7, 6, 8, 12), _trend("0y", "2026-12-31", 29, 25, 30, 32), _trend("+1y", "2027-12-31", 31, 27, 34, 30)]}
    out = mg.global_consensus_map(res, _ctx(market="HK", symbol="00700", ep={"id": "yahoo_consensus"}))
    assert out["status"] == "ok" and out["extra"]["current_fy"] == "FY2026" and out["extra"]["fiscal_year_end"] == "2026-12-31"
    mean = {e["period"]: (e["value"], e["unit"], e["currency"]) for e in out["evidence"] if e["field"] == "eps_consensus_mean"}
    assert mean == {"FY2026": (29.0, "元/股", "CNY"), "FY2027": (31.0, "元/股", "CNY")}
    assert all(_semantic_ok(e) for e in out["evidence"])


def test_consensus_fiscal_year_by_end_date_and_gaps():
    res = {"financial_currency": "USD", "eps_trend": [_trend("0y", "2026-09-30", 8.8, 8.3, 8.9, 2)]}
    out = mg.global_consensus_map(res, _ctx(market="US", symbol="AAPL"))
    assert out["extra"]["current_fy"] == "FY2026" and out["status"] == "partial"
    assert any(m["period"] == "+1y" for m in out["missing"])
    assert out["extra"]["warnings"] and "3 家" in out["extra"]["warnings"][0]
    assert mg.global_consensus_map({"eps_trend": res["eps_trend"]}, _ctx(market="US", symbol="AAPL"))["status"] == "failed"   # 没有报告币种不猜


def test_yahoo_estimates_report_currency_not_listing(monkeypatch):
    from sources import yahoo
    raw = {"earningsTrend": {"trend": [{"period": "0y", "endDate": "2026-12-31", "earningsEstimate": {"avg": {"raw": 29.0}, "numberOfAnalysts": {"raw": 30}}}]},
           "recommendationTrend": {"trend": []}, "earnings": {}, "earningsHistory": {"history": [{"quarter": {"raw": 1782777600}, "epsActual": {"raw": 7.0}, "epsEstimate": {"raw": 6.8}, "currency": "CNY"}]}}
    monkeypatch.setattr(yahoo, "yahoo_quote_summary", lambda sym, modules: raw)
    est = yahoo.analyst_estimates("00700", "HK")
    assert est["financial_currency"] == "CNY"   # earnings.financialCurrency 缺 → 退到 earningsHistory 行内币种
    out = mg.yahoo_analyst_map(est, _ctx(market="HK", symbol="00700"))
    money = [e for e in out["evidence"] if e["field"] in ("eps_estimate_avg", "eps_actual")]
    assert money and all((e["unit"], e["currency"]) == ("元/股", "CNY") for e in money)
    assert mg.global_consensus_map(est, _ctx(market="HK", symbol="00700"))["extra"]["current_fy"] == "FY2026"


# ---------- 汇率 ----------
def test_fx_rates_map_units(monkeypatch):
    lines = "\n".join(_tx_line(k, 22, {1: k, 3: r, 5: "20261008232725", 21: "2026-10-08"}) for k, r in (("whUSDCNY", "6.7036"), ("whHKDCNY", "0.8538"), ("whUSDHKD", "")))
    monkeypatch.setattr(gr, "http_get", lambda url, **k: _R(lines))
    out = mg.fx_rates_map(gr.fx_rates(), _ctx(market="US", symbol="MARKET"))
    got = {e["field"]: (e["value"], e["unit"], e["currency"]) for e in out["evidence"]}
    assert got == {"fx_usd_cny": (6.7036, "CNY/USD", "n/a"), "fx_hkd_cny": (0.8538, "CNY/HKD", "n/a")}
    assert [m["field"] for m in out["missing"]] == ["fx_usd_hkd"]
    assert all(_semantic_ok(e) for e in out["evidence"])


def test_yahoo_estimates_without_report_currency_drop_money_not_guess(monkeypatch):
    """🔴 审计 B6:earnings.financialCurrency 和历史记录的 currency 都缺 —— 以前按上市地标成港元(腾讯的预期其实是人民币)。
    现在金额项不出、列进 missing;分析师人数、增长率、评级分布、超预期比例照出。"""
    from sources import yahoo
    raw = {"earningsTrend": {"trend": [{"period": "0y", "endDate": "2026-12-31", "earningsEstimate": {"avg": {"raw": 29.0}, "numberOfAnalysts": {"raw": 30}, "growth": {"raw": 0.12}},
                                        "revenueEstimate": {"avg": {"raw": 700000000}}}]},
           "recommendationTrend": {"trend": [{"period": "0m", "strongBuy": 5, "buy": 10, "hold": 2, "sell": 0, "strongSell": 0}]}, "earnings": {},
           "earningsHistory": {"history": [{"quarter": {"raw": 1782777600}, "epsActual": {"raw": 7.0}, "epsEstimate": {"raw": 6.8}, "surprisePercent": {"raw": 0.03}}]}}
    monkeypatch.setattr(yahoo, "yahoo_quote_summary", lambda sym, modules: raw)
    est = yahoo.analyst_estimates("00700", "HK")
    assert not est.get("financial_currency")
    got = mg.yahoo_analyst_map(est, _ctx(market="HK", symbol="00700"))
    fields = {e["field"] for e in got["evidence"]}
    assert not fields & {"eps_estimate_avg", "revenue_estimate_avg", "eps_actual", "eps_estimate_at_report"}, "金额不猜币种"
    assert all(e["currency"] != "HKD" for e in got["evidence"])
    assert {"analyst_count", "rating_buy"} <= fields
    assert {"eps_estimate_avg", "revenue_estimate_avg", "eps_actual"} <= {m["field"] for m in got["missing"]}


@pytest.mark.parametrize("market,symbol,ccy", [("HK", "00700", "HKD"), ("US", "BABA", "USD")])
def test_yahoo_key_stats_without_report_currency_drop_fin_money(market, symbol, ccy):
    """🔴 审计第三轮 B4:financial_currency 缺失时,营收 / 现金 / 负债以前按上市地标成港元 / 美元。
    现在这三项不出、进缺口(结果算部分);价格、市值这些上市地口径的照出。"""
    res = {"symbol": symbol, "current_price": 500.0, "market_cap": 4.6e12, "trailing_pe": 20.0, "total_revenue": 100.0, "total_cash": 50.0, "total_debt": 30.0, "financial_currency": None}
    got = mg.yahoo_key_statistics_map(res, _ctx(market=market, symbol=symbol))
    fields = {e["field"]: e for e in got["evidence"]}
    assert fields["price"]["currency"] == ccy and fields["market_cap"]["currency"] == ccy
    assert not {"revenue_ttm", "total_cash", "total_debt"} & set(fields)
    assert sorted(m["field"] for m in got["missing"]) == ["revenue_ttm", "total_cash", "total_debt"]
    with_ccy = mg.yahoo_key_statistics_map({**res, "financial_currency": "CNY"}, _ctx(market=market, symbol=symbol))
    rev = next(e for e in with_ccy["evidence"] if e["field"] == "revenue_ttm")
    assert (rev["value"], rev["currency"], rev["unit"]) == (100.0, "CNY", "人民币") and with_ccy["missing"] == []
