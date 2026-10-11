"""formulas.py 数据驱动测试:fixture 中每条 case 都是人工按 研究宪法 §3 口径手算的期望值。"""
from __future__ import annotations

import json
import math
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from calc import formulas  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "formulas_cases.json")
with open(FIXTURE, encoding="utf-8") as f:
    CASES = json.load(f)["cases"]


def _walk(obj):
    """递归遍历返回树中的所有浮点数。"""
    if isinstance(obj, bool):
        return
    if isinstance(obj, float):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk(v)


def assert_contract(out):
    assert set(out.keys()) == {"status", "value", "unit", "reason", "details"}, "返回结构必须固定"
    assert out["status"] in ("ok", "not_meaningful", "error")
    if out["status"] != "ok":
        assert out["value"] is None and out["reason"], "非 ok 必须 value=null 且有 reason"
    assert all(math.isfinite(x) for x in _walk(out)), "返回树任何位置不得有 inf/NaN"
    json.dumps(out, allow_nan=False)  # 必须可严格 JSON 序列化


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture_case(case):
    fn = getattr(formulas, case["function"])
    out = fn(**case["args"])
    assert_contract(out)
    assert out["status"] == case["expect_status"], out
    if "expect_value" in case:
        assert out["value"] is not None
        assert math.isclose(out["value"], case["expect_value"], rel_tol=0, abs_tol=1e-6), out
    for k, v in case.get("expect_details", {}).items():
        assert k in out["details"], f"details 缺 {k}"
        if isinstance(v, float):
            assert math.isclose(out["details"][k], v, abs_tol=1e-6)
        else:
            assert out["details"][k] == v


@pytest.mark.parametrize("probe", [
    lambda: formulas.forward_pe(100, 1e-300),
    lambda: formulas.peg(1e6, 1e-9),
    lambda: formulas.pe_digestion_years(1e9, 1e-9, 30),
    lambda: formulas.forward_cagr(1e-300, 1e300),
    lambda: formulas.growth_rate(1e300, 1e-300),
    lambda: formulas.pe_deducted_annualized(1e300, "亿元", 1, "元"),
    lambda: formulas.pe_ttm_from_parts(1, "亿元", 1e305, "亿元"),
    lambda: formulas.percentile_rank([float("inf")] * 30 + [1] * 30, float("inf")),
])
def test_extreme_inputs_never_leak_nonfinite(probe):
    """极端输入:要么有限数 ok,要么 error;返回树任何位置不得有 inf/NaN(对撞 P3-3:可复算可审计)。"""
    out = probe()
    assert_contract(out)
    for x in _walk(out):
        assert math.isfinite(x)


def test_pe_digestion_scenarios_fixed_expectations():
    """四锚期望为预先用 Decimal(30 位)独立核算并冻结的常数(pe=60, cagr=0.5)。"""
    out = formulas.pe_digestion_scenarios(60, 0.5)
    assert_contract(out)
    assert out["status"] == "ok"
    sc = out["details"]["scenarios"]
    assert set(sc) == {"景气延续", "中性减速", "周期重定级_上沿", "周期重定级_下沿"}
    assert math.isclose(sc["景气延续"]["value"], 1.7095112913514547, abs_tol=1e-9)
    assert math.isclose(sc["中性减速"]["value"], 2.1591715781382463, abs_tol=1e-9)
    assert math.isclose(sc["周期重定级_上沿"]["value"], 2.474447464900328, abs_tol=1e-9)
    assert math.isclose(sc["周期重定级_下沿"]["value"], 2.969362295916118, abs_tol=1e-9)


def test_pe_digestion_scenarios_all_not_meaningful_when_cagr_zero():
    out = formulas.pe_digestion_scenarios(60, 0.0)
    assert out["status"] == "not_meaningful"
    assert all(r["status"] == "not_meaningful" for r in out["details"]["scenarios"].values())


def test_pe_digestion_scenarios_error_propagates():
    out = formulas.pe_digestion_scenarios(60, 50)  # 百分数误传
    assert out["status"] == "error"


def test_to_yuan_units_and_missing():
    assert formulas.to_yuan(1, "亿元") == 1e8
    assert formulas.to_yuan(1, "万元") == 1e4
    assert formulas.to_yuan(1, "元") == 1
    for bad in ((1, "千元"), (None, "元"), ("x", "元"), (True, "元"), (float("nan"), "元")):
        with pytest.raises(formulas.CalcInputError):
            formulas.to_yuan(*bad)


def test_bool_nan_inf_rejected_as_error_not_exception():
    for out in (formulas.forward_pe(True, 2), formulas.forward_pe(float("nan"), 2), formulas.peg(float("inf"), 0.2),
                formulas.forward_pe("abc", 2), formulas.consensus_dispersion(None, 1, 2)):
        assert_contract(out)
        assert out["status"] == "error"


def test_res_rejects_nonfinite_in_details():
    out = formulas._res("ok", 1.0, "倍", nested={"x": [1.0, float("nan")]})
    assert out["status"] == "error" and out["value"] is None


def test_calc_version_is_semver():
    parts = formulas.CALC_VERSION.split(".")
    assert len(parts) == 3 and all(p.isdigit() for p in parts)


def test_percentile_rank_non_iterable_history_is_error_not_exception():
    for bad in (None, 5, "12345", {"a": 1}):
        out = formulas.percentile_rank(bad, 1)
        assert_contract(out)
        assert out["status"] == "error"
