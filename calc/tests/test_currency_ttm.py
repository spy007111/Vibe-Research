"""0.5.0:美元 / 港元金额单位、汇率换算、按累计值(起止日期)算近四季合计与同比。"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from calc import display, formulas, series  # noqa: E402

CLI = os.path.join(ROOT, "calc", "cli.py")


# ---------------------------------------------------------------- 金额单位与汇率
@pytest.mark.parametrize("unit,ccy,amount", [
    ("元", "CNY", 1.0), ("万元", "CNY", 1e4), ("亿元", "CNY", 1e8),
    ("美元", "USD", 1.0), ("万美元", "USD", 1e4), ("亿美元", "USD", 1e8),
    ("港元", "HKD", 1.0), ("万港元", "HKD", 1e4), ("亿港元", "HKD", 1e8),
])
def test_to_base_units(unit, ccy, amount):
    assert formulas.to_base(1, unit) == (amount, ccy)


@pytest.mark.parametrize("unit", ["人民币", "日元", "千元", "美元/股", "", None, "USD"])
def test_to_base_rejects_unknown(unit):
    with pytest.raises(formulas.CalcInputError):
        formulas.to_base(1, unit)


def test_to_yuan_stays_cny_only():
    with pytest.raises(formulas.CalcInputError):
        formulas.to_yuan(1, "美元")


def test_pe_cny_details_unchanged():
    out = formulas.pe_ttm_from_parts(1000, "亿元", 50, "亿元")
    assert out["status"] == "ok" and out["value"] == 20
    assert set(out["details"]) == {"mcap_yuan", "denominator_yuan", "denominator_label", "ttm_yuan"}


def test_pe_usd_same_currency():
    out = formulas.pe_ttm_from_parts(36000, "亿美元", 1124.8e8, "美元")
    assert out["status"] == "ok" and out["value"] == pytest.approx(36000 / 1124.8)
    d = out["details"]
    assert d["currency"] == "USD" and d["mcap_usd"] == 36000e8 and d["ttm_usd"] == 1124.8e8
    assert "mcap_yuan" not in d


def test_pe_currency_mismatch_requires_fx():
    out = formulas.pe_ttm_from_parts(50000, "亿港元", 2000e8, "元")
    assert out["status"] == "error" and "币种不同" in out["reason"] and "CNY/HKD" in out["reason"]


@pytest.mark.parametrize("fx_unit,rate", [("CNY/HKD", 0.8538), ("HKD/CNY", 1 / 0.8538)])
def test_pe_converts_denominator_to_cap_currency(fx_unit, rate):
    # 市值 5 万亿港元,利润 2000 亿元人民币;1 港元 = 0.8538 元 → 利润 = 2000 / 0.8538 亿港元
    out = formulas.pe_ttm_from_parts(50000, "亿港元", 2000e8, "元", fx_rate=rate, fx_unit=fx_unit)
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(50000 / (2000 / 0.8538), rel=1e-12)
    d = out["details"]
    assert d["currency"] == "HKD" and d["denominator_original_currency"] == "CNY" and d["fx_unit"] == fx_unit


@pytest.mark.parametrize("kw,needle", [
    ({"fx_rate": 0.85, "fx_unit": "CNY/USD"}, "不能把"),
    ({"fx_rate": 0, "fx_unit": "CNY/HKD"}, "正数"),
    ({"fx_rate": -1, "fx_unit": "CNY/HKD"}, "正数"),
    ({"fx_rate": 0.85, "fx_unit": "HKD/HKD"}, "fx_unit"),
    ({"fx_rate": 0.85, "fx_unit": "港元/人民币"}, "fx_unit"),
    ({"fx_rate": 0.85}, "fx_unit"),
])
def test_pe_bad_fx(kw, needle):
    out = formulas.pe_ttm_from_parts(50000, "亿港元", 2000e8, "元", **kw)
    assert out["status"] == "error" and needle in out["reason"], out


def test_pe_same_currency_rejects_fx():
    out = formulas.pe_ttm_from_parts(1000, "亿元", 50, "亿元", fx_rate=1.0, fx_unit="CNY/HKD")
    assert out["status"] == "error" and "不要传汇率" in out["reason"]


def test_pe_deducted_usd_keys():
    out = formulas.pe_deducted_annualized(400, "亿美元", 10e8, "美元")
    assert out["status"] == "ok" and out["value"] == 10
    assert out["details"]["annualized_profit_usd"] == 40e8 and out["details"]["quarter_profit_usd"] == 10e8


def test_pe_not_meaningful_keeps_currency():
    out = formulas.pe_ttm_from_parts(36000, "亿美元", -1, "美元")
    assert out["status"] == "not_meaningful" and out["details"]["currency"] == "USD"


def test_forward_pe_legacy_unchanged():
    out = formulas.forward_pe(100, 5)
    assert out["value"] == 20 and out["details"] == {"price": 100.0, "eps": 5.0}


def test_forward_pe_units_same_currency():
    out = formulas.forward_pe(250, 8.82, price_unit="美元", eps_unit="美元/股")
    assert out["status"] == "ok" and out["value"] == pytest.approx(250 / 8.82)
    assert out["details"]["currency"] == "USD"


def test_forward_pe_mismatch_needs_fx_then_converts():
    bad = formulas.forward_pe(500, 28.99, price_unit="港元", eps_unit="元/股")
    assert bad["status"] == "error" and "币种不同" in bad["reason"]
    out = formulas.forward_pe(500, 28.99, price_unit="港元", eps_unit="元/股", fx_rate=0.8538, fx_unit="CNY/HKD")
    assert out["status"] == "ok"
    assert out["details"]["eps_converted"] == pytest.approx(28.99 / 0.8538)
    assert out["value"] == pytest.approx(500 / (28.99 / 0.8538))


@pytest.mark.parametrize("kw,needle", [
    ({"price_unit": "美元"}, "都给"),
    ({"eps_unit": "美元/股"}, "都给"),
    ({"price_unit": "万美元", "eps_unit": "美元/股"}, "不支持"),
    ({"price_unit": "美元", "eps_unit": "美元"}, "每股"),
    ({"price_unit": "美元/股", "eps_unit": "美元/股"}, "价格写"),
    ({"price_unit": "美元", "eps_unit": "美元/股", "fx_rate": 7.0, "fx_unit": "CNY/USD"}, "不要传汇率"),
    ({"fx_rate": 7.0, "fx_unit": "CNY/USD"}, "price_unit"),
])
def test_forward_pe_unit_errors(kw, needle):
    out = formulas.forward_pe(250, 8.82, **kw)
    assert out["status"] == "error" and needle in out["reason"], out


def test_forward_pe_negative_eps_after_conversion():
    out = formulas.forward_pe(500, -2, price_unit="港元", eps_unit="元/股", fx_rate=0.85, fx_unit="CNY/HKD")
    assert out["status"] == "not_meaningful"


def test_fx_convert_both_directions():
    a = formulas.fx_convert(100, "亿元", 0.8538, "CNY/HKD")
    assert a["status"] == "ok" and a["unit"] == "港元" and a["value"] == pytest.approx(100e8 / 0.8538)
    b = formulas.fx_convert(10, "美元", 6.7036, "CNY/USD")
    assert b["unit"] == "元" and b["value"] == pytest.approx(67.036)
    c = formulas.fx_convert(-5, "亿港元", 0.8538, "CNY/HKD")
    assert c["status"] == "ok" and c["value"] == pytest.approx(-5e8 * 0.8538)
    assert formulas.fx_convert(1, "美元", 0.85, "CNY/HKD")["status"] == "error"
    assert formulas.fx_convert(1, "人民币", 0.85, "CNY/HKD")["status"] == "error"


def test_display_usd_hkd_amounts():
    assert display.format_display({"status": "ok", "value": 1124.8e8, "unit": "美元"}) == "1124.80 亿美元"
    assert display.format_display({"status": "ok", "value": 3.25, "unit": "万港元"}) == "3.25 万港元"
    assert display.format_display({"status": "ok", "value": 943, "unit": "港元"}) == "943.00 港元"
    assert display.format_display({"status": "ok", "value": 8.82, "unit": "美元/股"}) == "8.82 美元/股"
    assert display.format_display({"status": "ok", "value": 2e8, "unit": "亿元"}) == "200000000.00 亿元"


# ---------------------------------------------------------------- 按累计值算近四季
# 自然年财年、季报公司(单位 亿元):FY2023 400 / FY2024 500;2024 年累计 Q1 110 H1 230 9M 360;2025 年累计 Q1 130 H1 270
CAL = [
    {"period": "2023-01-01..2023-12-31", "value": 400},
    {"period": "2023-01-01..2023-03-31", "value": 90},
    {"period": "2023-01-01..2023-06-30", "value": 190},
    {"period": "2023-01-01..2023-09-30", "value": 290},
    {"period": "2024-01-01..2024-03-31", "value": 110},
    {"period": "2024-01-01..2024-06-30", "value": 230},
    {"period": "2024-01-01..2024-09-30", "value": 360},
    {"period": "2024-01-01..2024-12-31", "value": 500},
    {"period": "2025-01-01..2025-03-31", "value": 130},
    {"period": "2025-01-01..2025-06-30", "value": 270},
]
# 苹果式 52 / 53 周财年(单位 美元):FY2024 2023-10-01..2024-09-28,FY2025 2024-09-29..2025-09-27(53 周不在这两年,但跨度照样 ≈12 个月)
APPLE = [
    {"period": "2023-10-01..2024-09-28", "value": 391.0},
    {"period": "2023-10-01..2023-12-30", "value": 119.6},
    {"period": "2024-09-29..2025-09-27", "value": 416.2},
    {"period": "2024-09-29..2024-12-28", "value": 124.3},
    {"period": "2025-09-28..2025-12-27", "value": 140.0},
]


def test_ttm_full_year_is_full_year():
    out = series.ttm_from_ytd(CAL, "2024-01-01..2024-12-31", "亿元", money=True)
    assert out["status"] == "ok" and out["value"] == 500 and out["details"]["method"] == "full_year"


def test_ttm_ytd_bridge_calendar():
    out = series.ttm_from_ytd(CAL, "2025-01-01..2025-06-30", "亿元", money=True)
    assert out["status"] == "ok" and out["value"] == 270 + 500 - 230
    assert out["details"]["periods"] == {"current": "2025-01-01..2025-06-30", "prior_full_year": "2024-01-01..2024-12-31",
                                         "prior_same_period": "2024-01-01..2024-06-30"}


def test_ttm_apple_fiscal_year():
    out = series.ttm_from_ytd(APPLE, "2025-09-28..2025-12-27", "亿美元", money=True)
    assert out["status"] == "ok" and out["value"] == pytest.approx(140.0 + 416.2 - 124.3)


def test_ttm_missing_prior_pieces():
    no_fy = [x for x in CAL if x["period"] != "2024-01-01..2024-12-31"]
    out = series.ttm_from_ytd(no_fy, "2025-01-01..2025-06-30", "亿元", money=True)
    assert out["status"] == "not_meaningful" and "上一完整财年" in out["reason"]
    no_same = [x for x in CAL if x["period"] != "2024-01-01..2024-06-30"]
    out = series.ttm_from_ytd(no_same, "2025-01-01..2025-06-30", "亿元", money=True)
    assert out["status"] == "not_meaningful" and "上年同期" in out["reason"]
    nulled = [dict(x, value=None) if x["period"] == "2024-01-01..2024-06-30" else x for x in CAL]
    assert series.ttm_from_ytd(nulled, "2025-01-01..2025-06-30", "亿元", money=True)["status"] == "not_meaningful"


@pytest.mark.parametrize("cum,end,needle", [
    (CAL, "2025-06-30", "起始日..截止日"),
    (CAL, "2025-01-01..2025-05-31", "不在 cumulative"),
    (CAL + [{"period": "2025-01-01..2025-06-30", "value": 1}], "2025-01-01..2025-06-30", "重复"),
    ([{"period": "2025-06-30..2025-01-01", "value": 1}], "2025-06-30..2025-01-01", "截止日"),
    ([{"period": "2025-02-30..2025-06-30", "value": 1}], "2025-02-30..2025-06-30", "合法日期"),
    ([{"period": "2025-01-01..2025-06-30", "value": True}], "2025-01-01..2025-06-30", "布尔"),
])
def test_ttm_input_errors(cum, end, needle):
    out = series.ttm_from_ytd(cum, end, "亿元", money=True)
    assert out["status"] == "error" and needle in out["reason"], out


def test_ttm_money_unit_check():
    assert series.ttm_from_ytd(CAL, "2024-01-01..2024-12-31", "人民币", money=True)["status"] == "error"
    assert series.ttm_from_ytd(CAL, "2024-01-01..2024-12-31", "美元/股", money=False)["status"] == "ok"


def test_ttm_odd_span_not_meaningful():
    cum = [{"period": "2025-01-01..2025-02-28", "value": 1}]
    out = series.ttm_from_ytd(cum, "2025-01-01..2025-02-28", "亿元", money=True)
    assert out["status"] == "not_meaningful" and "2 个月" in out["reason"]


def test_ttm_yoy_from_ytd_half_year():
    # 当期 TTM = 270 + 500 − 230 = 540;一年前 TTM = 230 + 400 − 190 = 440
    out = series.ttm_yoy_from_ytd(CAL, "2025-01-01..2025-06-30", "亿元", money=True)
    assert out["status"] == "ok" and out["value"] == pytest.approx(540 / 440 - 1)
    assert out["details"]["base_period"] == "2024-01-01..2024-06-30"
    assert out["details"]["current"]["value"] == 540 and out["details"]["base"]["value"] == 440


def test_ttm_yoy_from_ytd_full_year():
    out = series.ttm_yoy_from_ytd(CAL, "2024-01-01..2024-12-31", "亿元", money=True)
    assert out["status"] == "ok" and out["value"] == pytest.approx(500 / 400 - 1)


def test_ttm_yoy_from_ytd_gaps():
    # 2023 年同期齐了,但 2022 年全年缺 → 2024H1 的一年前(2023H1)算不出 TTM
    out = series.ttm_yoy_from_ytd(CAL, "2024-01-01..2024-06-30", "亿元", money=True)
    assert out["status"] == "not_meaningful" and "基期 TTM" in out["reason"]
    out = series.ttm_yoy_from_ytd(CAL, "2023-01-01..2023-12-31", "亿元", money=True)
    assert out["status"] == "not_meaningful" and "一年前" in out["reason"]
    neg = [dict(x, value=-x["value"]) if x["period"].startswith("2023") else x for x in CAL]
    out = series.ttm_yoy_from_ytd(neg, "2024-01-01..2024-12-31", "亿元", money=True)
    assert out["status"] == "not_meaningful" and "≤ 0" in out["reason"]


def test_cli_ttm_from_ytd_display():
    args = json.dumps({"cumulative": APPLE, "end_period": "2025-09-28..2025-12-27", "unit": "亿美元", "money": True})
    p = subprocess.run([sys.executable, CLI, "ttm_from_ytd", "--args", args, "--evidence", "ev-aaaaaa"], capture_output=True, text=True)
    out = json.loads(p.stdout)
    assert p.returncode == 0 and out["calc_version"] == "0.5.0"
    assert out["output"]["display"] == "431.90 亿美元"
