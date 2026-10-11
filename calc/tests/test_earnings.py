"""earnings.py 测试:反应日认定(盘前 / 盘中 / 盘后、休市日、合并同一反应日、反应待定、K 线不够早)、
平均绝对涨跌、实际 vs 预期偏差与区间位置。期望值全部手算。"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(ROOT, "calc", "cli.py")
sys.path.insert(0, ROOT)
from calc import earnings  # noqa: E402
from calc.display import attach_display  # noqa: E402
from calc.tests.test_formulas import assert_contract  # noqa: E402

# 收盘价按手算的涨跌一路乘出来:+5% / −2% / +10% / −4% / +3% / 0%
KLINES = [
    {"date": "2026-01-05", "close": 10.0},      # 周一
    {"date": "2026-01-06", "close": 10.5},      # +5%
    {"date": "2026-01-07", "close": 10.29},     # −2%
    {"date": "2026-01-08", "close": 11.319},    # +10%
    {"date": "2026-01-09", "close": 10.86624},  # −4%(周五)
    {"date": "2026-01-12", "close": 11.1922272},  # +3%(周一)
    {"date": "2026-01-13", "close": 11.1922272},  # 0%
]
EVENTS = [
    {"id": "Q1", "date": "2026-01-05", "timing": "after_close"},   # 盘后 → 次日 01-06:+5%
    {"id": "Q2", "date": "2026-01-07", "timing": "before_open"},   # 盘前 → 当天 01-07:−2%
    {"id": "Q3", "date": "2026-01-07", "timing": "after_close"},   # 盘后 → 01-08:+10%
    {"id": "Q4", "date": "2026-01-10", "timing": "before_open"},   # 周六 → 01-12:+3%,隔 2 天
    {"id": "Q4b", "date": "2026-01-11", "timing": "during"},       # 周日 → 也是 01-12 → 和 Q4 合并
    {"id": "Q5", "date": "2026-01-13", "timing": "after_close"},   # K 线只到 01-13 → 反应待定
]
A = pytest.approx


def test_reaction_days_merge_pending_and_mean():
    out = earnings.earnings_reaction(KLINES, EVENTS)
    assert_contract(out)
    assert out["status"] == "ok" and out["unit"] == "小数"
    assert out["value"] == A((0.03 + 0.10 + 0.02 + 0.05) / 4, abs=1e-12)   # 0.05
    d = out["details"]
    rs = d["reactions"]
    assert [r["id"] for r in rs] == ["Q5", "Q4 + Q4b", "Q3", "Q2", "Q1"]
    assert rs[0]["status"] == "not_meaningful" and rs[0]["pending"] is True and "反应待定" in rs[0]["reason"]
    assert rs[0]["reaction_day"] is None and rs[0]["value"] is None
    assert rs[1]["ids"] == ["Q4", "Q4b"] and rs[1]["date"] == "2026-01-10" and rs[1]["reaction_day"] == "2026-01-12"
    assert rs[1]["prev_day"] == "2026-01-09" and rs[1]["gap_days"] == 2 and rs[1]["value"] == A(0.03, abs=1e-12)
    assert [len(r["events"]) for r in rs] == [1, 2, 1, 1, 1]
    assert (rs[2]["reaction_day"], rs[2]["value"]) == ("2026-01-08", A(0.10, abs=1e-12))
    assert (rs[3]["reaction_day"], rs[3]["value"]) == ("2026-01-07", A(-0.02, abs=1e-12))
    assert (rs[4]["reaction_day"], rs[4]["prev_day"], rs[4]["value"]) == ("2026-01-06", "2026-01-05", A(0.05, abs=1e-12))
    assert rs[4]["prev_close"] == 10.0 and rs[4]["close"] == 10.5 and rs[4]["gap_days"] == 1
    assert d["latest_id"] == "Q5" and d["prior_ids"] == ["Q4 + Q4b", "Q3", "Q2", "Q1"] and d["prior_n"] == 4
    assert d["latest_abs_over_mean"]["status"] == "not_meaningful" and d["latest_abs_over_mean"]["value"] is None
    assert d["bars"] == {"first": "2026-01-05", "last": "2026-01-13", "count": 7}


def test_reaction_lookback_and_latest_vs_mean():
    out = earnings.earnings_reaction(KLINES, EVENTS[:5], lookback=2)
    assert_contract(out)
    d = out["details"]
    assert d["latest_id"] == "Q4 + Q4b" and d["prior_ids"] == ["Q3", "Q2"]
    assert out["value"] == A((0.10 + 0.02) / 2, abs=1e-12)                  # 0.06
    assert d["latest_abs_over_mean"]["status"] == "ok"
    assert d["latest_abs_over_mean"]["value"] == A(0.03 / 0.06, abs=1e-9)   # 0.5 倍
    shown = attach_display(out)["details"]
    assert shown["reactions"][0]["display"] == "3.00%" and shown["reactions"][2]["display"] == "-2.00%"
    assert shown["latest_abs_over_mean"]["display"] == "0.5000 倍"
    # 最近一次是跌的:也按绝对值比
    neg = earnings.earnings_reaction(KLINES, EVENTS[:3] + [{"id": "N", "date": "2026-01-09", "timing": "during"}], lookback=2)
    assert neg["details"]["latest_id"] == "N" and neg["details"]["reactions"][0]["value"] == A(-0.04, abs=1e-12)
    assert neg["details"]["latest_abs_over_mean"]["value"] == A(0.04 / 0.06, abs=1e-9)


def test_reaction_order_independent():
    rng = random.Random(7)
    k, e = KLINES[:], EVENTS[:]
    rng.shuffle(k)
    rng.shuffle(e)
    assert earnings.earnings_reaction(k, e) == earnings.earnings_reaction(KLINES, EVENTS)


def test_reaction_too_few_prior_and_too_early():
    # 最近一次 + 此前只有 1 次 → 不算平均,但明细照给
    out = earnings.earnings_reaction(KLINES, [EVENTS[1], EVENTS[2]])
    assert_contract(out)
    assert out["status"] == "not_meaningful" and "少于 2 次" in out["reason"]
    assert out["details"]["prior_n"] == 1 and out["details"]["reactions"][0]["value"] == A(0.10, abs=1e-12)
    assert out["details"]["latest_abs_over_mean"]["status"] == "not_meaningful"
    # 反应日是第一根 K 线 → 没有前一天可比
    early = earnings.earnings_reaction(KLINES, [{"id": "早", "date": "2026-01-05", "timing": "before_open"},
                                                {"id": "更早", "date": "2026-01-01", "timing": "after_close"}])
    assert_contract(early)
    assert all(r["status"] == "not_meaningful" and "不够早" in r["reason"] and r["pending"] is False for r in early["details"]["reactions"])
    assert early["details"]["prior_n"] == 0
    # 盘中发布 = 当天
    during = earnings.earnings_reaction(KLINES, [{"id": "x", "date": "2026-01-09", "timing": "during"}])
    assert during["details"]["reactions"][0]["reaction_day"] == "2026-01-09"
    assert during["details"]["reactions"][0]["value"] == A(-0.04, abs=1e-12)
    # 此前平均为 0 → 倍数无意义
    flat = [{"date": f"2026-02-0{i}", "close": 5.0} for i in range(2, 7)]
    zero = earnings.earnings_reaction(flat, [{"id": "a", "date": "2026-02-03", "timing": "before_open"},
                                             {"id": "b", "date": "2026-02-04", "timing": "before_open"},
                                             {"id": "c", "date": "2026-02-05", "timing": "before_open"}])
    assert zero["status"] == "ok" and zero["value"] == 0.0
    assert zero["details"]["latest_abs_over_mean"]["status"] == "not_meaningful"


@pytest.mark.parametrize("klines,events,kw,frag", [
    (KLINES, [], {}, "events"),
    (KLINES, "x", {}, "events"),
    (KLINES, [{"id": "a", "date": "2026-01-05", "timing": "noon"}], {}, "timing"),
    (KLINES, [{"id": "a", "date": "2026-01-05", "timing": "before_open"}] * 2, {}, "重复 id"),
    (KLINES, [{"id": "", "date": "2026-01-05", "timing": "before_open"}], {}, "id"),
    (KLINES, [{"id": "a", "date": "2026-02-30", "timing": "before_open"}], {}, "日期"),
    (KLINES, [{"id": "a", "date": "2026-01-05", "timing": "before_open"}], {"lookback": 0}, "lookback"),
    (KLINES, [{"id": "a", "date": "2026-01-05", "timing": "before_open"}], {"lookback": 13}, "lookback"),
    (KLINES, [{"id": "a", "date": "2026-01-05", "timing": "before_open"}], {"lookback": True}, "lookback"),
    (KLINES[:1], [{"id": "a", "date": "2026-01-05", "timing": "before_open"}], {}, "至少要 2 根"),
    (KLINES + [KLINES[0]], [{"id": "a", "date": "2026-01-05", "timing": "before_open"}], {}, "重复日期"),
    ([{"date": "2026-01-05", "close": 0}], [{"id": "a", "date": "2026-01-05", "timing": "before_open"}], {}, "须为正"),
    (KLINES, [{"id": f"e{i}", "date": "2026-01-05", "timing": "before_open"} for i in range(41)], {}, "最多"),
])
def test_reaction_errors(klines, events, kw, frag):
    out = earnings.earnings_reaction(klines, events, **kw)
    assert_contract(out)
    assert out["status"] == "error" and frag in out["reason"], out


def test_surprise_point_estimate_and_signs():
    up = earnings.earnings_surprise(1.10, 1.00)
    assert_contract(up)
    assert up["status"] == "ok" and up["value"] == A(0.10, abs=1e-12) and up["details"]["difference"] == A(0.10, abs=1e-12)
    assert "position" not in up["details"] and up["details"]["estimate_is_midpoint"] is False
    assert earnings.earnings_surprise(0.9, 1.2)["value"] == A(-0.25, abs=1e-12)
    # 预期亏损、实际亏得少 → 偏差为正(按 |预期| 做分母)
    assert earnings.earnings_surprise(-0.5, -1.0)["value"] == A(0.5, abs=1e-12)
    zero = earnings.earnings_surprise(0.3, 0)
    assert_contract(zero)
    assert zero["status"] == "not_meaningful" and zero["details"]["difference"] == A(0.3)


def test_surprise_ranges():
    above = earnings.earnings_surprise(110, low=90, high=100, unit="元")
    assert_contract(above)
    assert above["value"] == A(15 / 95, abs=1e-12) and above["details"]["estimate"] == 95.0
    assert above["details"]["estimate_is_midpoint"] is True
    assert (above["details"]["position"], above["details"]["point"], above["details"]["position_label"]) == ("above", False, "高于区间上限")
    assert above["details"]["unit_in"] == "元"
    within = earnings.earnings_surprise(95, 96, low=90, high=100)
    assert within["value"] == A(-1 / 96, abs=1e-12) and within["details"]["position"] == "within"
    assert within["details"]["estimate_is_midpoint"] is False
    below = earnings.earnings_surprise(80, low=90, high=100)
    assert below["details"]["position_label"] == "低于区间下限" and below["value"] == A(-15 / 95, abs=1e-12)
    point = earnings.earnings_surprise(100, low=100, high=100)
    assert point["value"] == 0.0 and point["details"]["point"] is True and point["details"]["position_label"] == "等于预告值"
    assert earnings.earnings_surprise(101, low=100, high=100)["details"]["position_label"] == "高于预告值"
    assert earnings.earnings_surprise(99, low=100, high=100)["details"]["position_label"] == "低于预告值"


@pytest.mark.parametrize("kw,frag", [
    ({"actual": None, "estimate": 1}, "actual"),
    ({"actual": True, "estimate": 1}, "布尔"),
    ({"actual": 1}, "至少给一个"),
    ({"actual": 1, "low": 1}, "都给"),
    ({"actual": 1, "high": 1}, "都给"),
    ({"actual": 1, "low": 2, "high": 1}, "大于"),
    ({"actual": 1, "estimate": "x"}, "不是数值"),
    ({"actual": 1, "estimate": 1, "unit": 3}, "unit"),
])
def test_surprise_errors(kw, frag):
    out = earnings.earnings_surprise(**kw)
    assert_contract(out)
    assert out["status"] == "error" and frag in out["reason"], out


def _cli(*args):
    p = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


def test_cli_and_tool_registration():
    rc, out = _cli("earnings_reaction", "--args", json.dumps({"klines": KLINES, "events": EVENTS}), "--evidence", "ev-aaaaaa")
    assert rc == 0 and out["calc_version"] == "0.5.0"
    assert out["output"]["display"] == "5.00%" and out["output"]["details"]["reactions"][1]["display"] == "3.00%"
    rc, out = _cli("earnings_reaction", "--args", json.dumps({"klines": KLINES, "events": EVENTS[1:3]}))
    assert rc == 2 and out["output"]["display"] is None
    rc, out = _cli("earnings_surprise", "--args", json.dumps({"actual": 2.02, "estimate": 2.0}))
    assert rc == 0 and out["output"]["display"] == "1.00%"
    p = subprocess.run([sys.executable, "-m", "calc.tool"], cwd=ROOT, capture_output=True, timeout=10,
                       input=json.dumps({"fn": "earnings_surprise", "args": {"actual": 110, "low": 90, "high": 100}}).encode())
    payload = json.loads(p.stdout.decode())
    assert payload["ok"] is True and payload["result"]["display"] == "15.79%"
    assert payload["result"]["details"]["position"] == "above"
