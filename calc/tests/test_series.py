"""series.py 测试:累计→单季、TTM、同比、环比的手算 fixture + 缺失 / 非法输入 / 非有限数 / 重复期。"""
from __future__ import annotations

import json
import math
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from calc import series  # noqa: E402

# 2025 年累计:Q1 100 / H1 250 / Q3 450 / FY 700 → 单季 100 / 150 / 200 / 250
CUM_2025 = [{"period": "2025-03-31", "value": 100}, {"period": "2025-06-30", "value": 250},
            {"period": "2025-09-30", "value": 450}, {"period": "2025-12-31", "value": 700}]
# 8 季单季:2024Q1..2025Q4 = 10,20,30,40,50,60,70,80
SINGLE_8 = [{"period": p, "value": v} for p, v in zip(
    ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"],
    [10, 20, 30, 40, 50, 60, 70, 80])]


def _vals(out):
    return [s["value"] for s in out["details"]["series"]]


def _contract(out):
    assert set(out) == {"status", "value", "unit", "reason", "details"}
    if out["status"] != "ok":
        assert out["value"] is None and out["reason"]
    json.dumps(out, allow_nan=False)


def test_quarterize_basic():
    out = series.quarterize(CUM_2025, unit="元")
    _contract(out)
    assert out["status"] == "ok" and out["value"] == 4 and out["details"]["value_unit"] == "元"
    assert _vals(out) == [100, 150, 200, 250]
    assert [s["quarter"] for s in out["details"]["series"]] == [1, 2, 3, 4]


def test_quarterize_unordered_input_is_sorted():
    assert _vals(series.quarterize(list(reversed(CUM_2025)))) == [100, 150, 200, 250]


def test_quarterize_missing_prior_period_yields_none_with_reason():
    cum = [c for c in CUM_2025 if c["period"] != "2025-06-30"]
    out = series.quarterize(cum)
    s = {x["period"]: x for x in out["details"]["series"]}
    assert s["2025-09-30"]["value"] is None and "缺失" in s["2025-09-30"]["reason"]
    assert s["2025-12-31"]["value"] == 250  # FY − Q3 YTD 仍可算
    assert out["value"] == 2  # 去掉 H1 后只剩 Q1 / Q3 / FY 三期,可拆出 Q1 与 Q4 两个单季


def test_quarterize_null_value_is_missing_not_error():
    cum = [dict(c) for c in CUM_2025]
    cum[1]["value"] = None
    out = series.quarterize(cum)
    assert out["status"] == "ok" and _vals(out) == [100, None, None, 250]


def test_quarterize_cross_year_q1_uses_ytd_not_diff():
    out = series.quarterize([{"period": "2024-12-31", "value": 999}, {"period": "2025-03-31", "value": 100}])
    assert {x["period"]: x["value"] for x in out["details"]["series"]}["2025-03-31"] == 100


@pytest.mark.parametrize("bad", [
    [{"period": "2025-05-15", "value": 1}],            # 非季末
    [{"period": "2025-03-31junk", "value": 1}],        # 带尾缀
    [{"period": "2025/03/31", "value": 1}],            # 格式错
    [{"period": "2025-03-31", "value": float("nan")}],  # NaN
    [{"period": "2025-03-31", "value": float("inf")}],  # inf
    [{"period": "2025-03-31", "value": True}],         # 布尔
    [{"period": "2025-03-31", "value": "x"}],          # 非数
    [{"period": "2025-03-31", "value": 1}, {"period": "2025-03-31", "value": 2}],  # 重复期
    ["not a dict"],
    "not a list",
])
def test_quarterize_rejects_bad_input(bad):
    out = series.quarterize(bad)
    _contract(out)
    assert out["status"] == "error"


def test_quarterize_empty_and_bad_unit():
    assert series.quarterize([])["status"] == "error"
    assert series.quarterize(CUM_2025, unit="")["status"] == "error"


def test_ttm_sum_ok():
    out = series.ttm_sum(SINGLE_8, "2025-12-31", unit="元")
    _contract(out)
    assert out["status"] == "ok" and out["value"] == 260 and out["unit"] == "元"
    assert out["details"]["periods"] == ["2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31"]


def test_ttm_sum_missing_quarter_not_meaningful():
    single = [s for s in SINGLE_8 if s["period"] != "2025-06-30"]
    out = series.ttm_sum(single, "2025-12-31")
    assert out["status"] == "not_meaningful" and "2025-06-30" in out["reason"]


def test_ttm_yoy():
    out = series.ttm_yoy(SINGLE_8, "2025-12-31")
    _contract(out)
    assert out["status"] == "ok" and math.isclose(out["value"], 260 / 100 - 1, abs_tol=1e-12)


def test_ttm_yoy_needs_eight_quarters():
    assert series.ttm_yoy(SINGLE_8[1:], "2025-12-31")["status"] == "not_meaningful"


def test_ttm_yoy_base_nonpositive():
    single = [dict(s) for s in SINGLE_8]
    for s in single[:4]:
        s["value"] = -1
    assert series.ttm_yoy(single, "2025-12-31")["status"] == "not_meaningful"


def test_ttm_yoy_current_negative_base_positive_is_reported():
    single = [dict(s) for s in SINGLE_8]
    for s in single[4:]:
        s["value"] = -5
    out = series.ttm_yoy(single, "2025-12-31")
    assert out["status"] == "ok" and out["value"] < -1  # 事实类输出照实报告


def test_ttm_yoy_bad_end_period():
    assert series.ttm_yoy(SINGLE_8, "2025-12-30")["status"] == "error"


def test_qoq():
    out = series.qoq(SINGLE_8, "2025-12-31")
    assert out["status"] == "ok" and math.isclose(out["value"], 80 / 70 - 1, abs_tol=1e-12)
    assert "拐点" in out["details"]["note"]


def test_qoq_prev_nonpositive_and_year_boundary():
    single = [dict(s) for s in SINGLE_8]
    single[6]["value"] = 0
    assert series.qoq(single, "2025-12-31")["status"] == "not_meaningful"
    out = series.qoq(SINGLE_8, "2025-03-31")
    assert out["status"] == "ok" and math.isclose(out["value"], 50 / 40 - 1, abs_tol=1e-12)


def test_latest_quarter_with_unit_passthrough():
    out = series.latest_quarter(SINGLE_8, unit="万元")
    assert out["status"] == "ok" and out["value"] == 80 and out["unit"] == "万元"
    assert out["details"]["period"] == "2025-12-31" and out["details"]["quarter"] == 4


def test_latest_quarter_missing_latest_is_unknown_not_previous_quarter():
    """第四轮审计 B1:最新一季拆不出(None)就是不知道,不退回上一季的 70 —— 否则年化市盈率拿旧季度照算。"""
    single = [dict(s) for s in SINGLE_8]
    single[-1]["value"] = None
    out = series.latest_quarter(single)
    assert out["status"] == "not_meaningful" and out["value"] is None
    assert out["details"]["period"] == "2025-12-31" and "缺失" in out["reason"]
    # 链路:拆季缺上一期累计值 → 最新单季未知
    cum = [{"period": "2025-03-31", "value": 10}, {"period": "2025-09-30", "value": 40}]
    q = series.quarterize(cum)
    assert q["details"]["series"][-1]["value"] is None
    assert series.latest_quarter(q["details"]["series"])["status"] == "not_meaningful"
    # 更早的季度空着不影响取最新
    single = [dict(s) for s in SINGLE_8]
    single[0]["value"] = None
    assert series.latest_quarter(single)["value"] == 80
    out = series.latest_quarter([{"period": "2025-03-31", "value": None}])
    assert out["status"] == "not_meaningful"
    assert series.latest_quarter([])["status"] == "not_meaningful"


def test_money_unit_validation_flag():
    assert series.quarterize(CUM_2025, unit="日元", money=True)["status"] == "error"
    assert series.quarterize(CUM_2025, unit="美元", money=True)["status"] == "ok"  # 0.5.0 起美元 / 港元是金额单位
    assert series.quarterize(CUM_2025, unit="元/股", money=False)["status"] == "ok"
    assert series.latest_quarter(SINGLE_8, unit="亿元", money=True)["unit"] == "亿元"
    assert series.ttm_yoy(SINGLE_8, "2025-12-31", unit="千元", money=True)["status"] == "error"
