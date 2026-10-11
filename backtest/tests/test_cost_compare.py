"""扣费前后对照（cost_compare.py）与港美股引擎按市场选规则（run.make_engine）。不联网。"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import cost_compare as C  # noqa: E402
from backtest.cli import _catalog, _result_view  # noqa: E402
from backtest.engines.china_a import ChinaAEngine  # noqa: E402
from backtest.engines.global_equity import GlobalEquityEngine  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402
from backtest.run import Result, make_engine  # noqa: E402
from backtest.tests.test_engine_rules import frame, run_engine  # noqa: E402

A = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2025-12-31", style="swing")
HK = plan_backtest(codes=["00700.HK"], start="2021-01-01", end="2025-12-31", style="swing")
US = plan_backtest(codes=["AAPL"], start="2021-01-01", end="2025-12-31", style="swing")

ENGINES = [("A", lambda cfg: ChinaAEngine(cfg)), ("us", lambda cfg: GlobalEquityEngine(cfg, "us")),
           ("hk", lambda cfg: GlobalEquityEngine(cfg, "hk")), ("ca", lambda cfg: GlobalEquityEngine(cfg, "ca"))]


@pytest.mark.parametrize("name,build", ENGINES)
def test_zero_cost_really_zeroes_every_engine(name, build):
    eng = build(dict(C.ZERO_COST))
    for direction, is_open in ((1, True), (-1, False)):
        assert eng.calc_commission(1000, 50.0, direction, is_open) == 0, f"{name} 还有费用"
        assert eng.apply_slippage(50.0, direction) == 50.0, f"{name} 还有滑点"
    default = build({})
    assert default.apply_slippage(50.0, 1) > 50.0, f"{name} 默认有滑点（不然这条测试是空的）"


def test_default_fees_exist_where_markets_charge_them():
    assert ChinaAEngine({}).calc_commission(1000, 50.0, -1, False) > 0
    assert GlobalEquityEngine({}, "hk").calc_commission(1000, 50.0, 1, True) > 0
    assert GlobalEquityEngine({}, "us").calc_commission(1000, 50.0, 1, True) == 0, "美股零佣金"


def test_make_engine_uses_the_plans_market_rules():
    """🔴 港股之前漏传 market，一直按美股规则（碎股、零费用）在跑。"""
    assert isinstance(make_engine(A, A.to_config()), ChinaAEngine)
    hk, us = make_engine(HK, HK.to_config()), make_engine(US, US.to_config())
    assert isinstance(hk, GlobalEquityEngine) and hk.market == "hk"
    assert us.market == "us"
    assert hk.round_size(150.7, 10.0) == 100, "港股按 100 股一手"
    assert hk.calc_commission(100, 400.0, 1, True) > 0, "港股有印花税和征费"


def test_hk_zero_cost_run_keeps_more_than_actual():
    """同一段行情、同一套信号：港股实际扣费，不计成本那次一分不扣、期末钱更多。"""
    df = frame([100.0, 101, 99, 102, 98, 103, 100, 104])
    sig = {"00700.HK": pd.Series([1, 0, 1, 0, 1, 0, 1, 0], index=df.index, dtype=float)}
    real, m_real = run_engine(lambda cfg: GlobalEquityEngine(cfg, "hk"), {"00700.HK": df}, sig)
    free, m_free = run_engine(lambda cfg: GlobalEquityEngine({**cfg, **C.ZERO_COST}, "hk"), {"00700.HK": df}, sig)
    assert m_real["execution_fees"] > 0 and m_free["execution_fees"] == 0
    assert m_free["total_return"] > m_real["total_return"]
    assert real.fill_records and all(abs(f.signed_quantity) % 100 == 0 for f in real.fill_records), "港股整手"


def _fake(calls, metrics):
    def fake(plan, strategy, run_dir, loader, config_overrides):
        calls.append((strategy, loader, config_overrides))
        return SimpleNamespace(metrics=metrics)
    return fake


def test_compare_reports_drag_on_the_same_loader(monkeypatch, tmp_path):
    calls: list = []
    loader = object()
    monkeypatch.setattr(C, "run", _fake(calls, {"total_return": 0.30, "annual_return": 0.06, "max_drawdown": -0.2,
                                                "sharpe": 0.9, "fill_count": 41, "execution_fees": 0.0}))
    out = C.compare(A, "ma_cross", {"fast": 20, "slow": 60}, loader, tmp_path, {"total_return": 0.22, "annual_return": 0.045})
    strategy, used, cfg = calls[0]
    assert used is loader and (strategy.fast, strategy.slow) == (20, 60)
    assert cfg["validation"] is None and all(cfg[k] == 0 for k in C.ZERO_COST)
    assert out["cost_free"] == {"total_return": 0.30, "annual_return": 0.06, "max_drawdown": -0.2, "sharpe": 0.9, "fill_count": 41}
    assert out["drag"]["total_return"] == pytest.approx(0.08) and out["drag"]["annual_return"] == pytest.approx(0.015)
    assert "做不到零成本" in out["note"]


def test_compare_unknown_actual_is_none_not_zero(monkeypatch, tmp_path):
    monkeypatch.setattr(C, "run", _fake([], {"total_return": 0.1, "annual_return": None}))
    out = C.compare(A, "buy_and_hold", {}, object(), tmp_path, {"total_return": None, "annual_return": 0.02})
    assert out["drag"] == {"total_return": None, "annual_return": None}


def test_compare_failure_or_leaking_fees_gives_no_comparison(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(C, "run", boom)
    assert "没有跑出来" in C.compare(A, "buy_and_hold", {}, object(), tmp_path, {})["error"]
    monkeypatch.setattr(C, "run", _fake([], {"total_return": 0.1, "execution_fees": 3.0}))
    out = C.compare(A, "buy_and_hold", {}, object(), tmp_path, {"total_return": 0.05})
    assert "对照不成立" in out["error"] and "drag" not in out


def test_result_view_and_catalog_carry_the_comparison():
    r = Result(metrics={"total_return": 0.1}, plan=A, strategy="s", provenance={}, limits=[], notes=[], run_dir=Path("/tmp"))
    costs = {"cost_free": {"total_return": 0.12}, "drag": {"total_return": 0.02, "annual_return": 0.004}, "note": C.NOTE}
    assert _result_view(r, costs=costs)["cost_compare"] == costs
    assert _result_view(r)["cost_compare"] is None
    assert "drag" in _catalog()["outputs"]["cost_compare"]
