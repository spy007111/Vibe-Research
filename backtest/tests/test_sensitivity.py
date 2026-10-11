"""参数敏感度网格与稳健性检验的输出形状、边界和披露。"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import sensitivity as S  # noqa: E402
from backtest.cli import _result_view, _robustness  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402
from backtest.run import Result  # noqa: E402

PLAN = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2025-12-31", style="swing")


def _fake_run(calls):
    def fake(plan, strategy, run_dir, loader, config_overrides):
        calls.append((strategy.fast, strategy.slow, config_overrides))
        return SimpleNamespace(metrics={"total_return": (strategy.slow - strategy.fast) / 100, "sharpe": 1.0,
                                        "max_drawdown": -0.1, "trade_count": 3})
    return fake


def test_grid_shape_invalid_cells_and_shared_loader(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(S, "run", _fake_run(calls))
    g = S.run_grid(PLAN, "ma_cross", {"fast": 20, "slow": 60}, loader=object(), run_dir=tmp_path)
    assert g["x"] == {"param": "fast", "values": [10, 13, 17, 20, 25, 30, 40]}
    assert g["y"] == {"param": "slow", "values": [30, 40, 50, 60, 75, 90, 120]}
    assert "行对应 y（slow），列对应 x（fast）" in g["layout"]
    assert len(g["total_return"]) == 7 and all(len(r) == 7 for r in g["total_return"])
    invalid = [c for c in g["skipped"] if c[2] == "invalid"]
    assert len(invalid) == g["invalid_cells"] == 3, "fast ≥ slow 的三格不成立（30/30、40/30、40/40）"
    assert g["runs"] == 46 and g["complete"] is True
    assert all(c[2] == {"validation": None} for c in calls), "网格里不重复跑稳健性检验"
    assert g["total_return"][3][3] == pytest.approx(0.4) and g["base"] == {"fast": 20, "slow": 60}
    assert g["summary"]["positive_share"] == 1.0
    assert "best" not in str(g).lower() and "最优" not in str(g), "不标最优格子"


def test_grid_stops_at_budget_and_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "run", _fake_run([]))
    ticks = iter(range(0, 10_000, 30))
    g = S.run_grid(PLAN, "ma_cross", {"fast": 20, "slow": 60}, loader=object(), run_dir=tmp_path,
                   budget_seconds=100, clock=lambda: next(ticks))
    assert g["complete"] is False and any(c[2] == "timeout" for c in g["skipped"])
    assert 0 < g["runs"] < 46


def test_grid_cell_error_does_not_sink_the_rest(monkeypatch, tmp_path):
    def boom(plan, strategy, run_dir, loader, config_overrides):
        if strategy.fast == 20:
            raise RuntimeError("x")
        return SimpleNamespace(metrics={"total_return": 0.1})
    monkeypatch.setattr(S, "run", boom)
    g = S.run_grid(PLAN, "ma_cross", {"fast": 20, "slow": 60}, loader=object(), run_dir=tmp_path)
    assert sum(c[2] == "error" for c in g["skipped"]) == 7 and g["runs"] == 39
    assert g["total_return"][0][3] is None and g["sharpe"][0][0] is None


def test_rsi_axes_stay_in_range_and_buy_and_hold_has_no_grid(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "run", lambda *a, **k: SimpleNamespace(metrics={"total_return": 0.0}))
    g = S.run_grid(PLAN, "rsi_reversion", {"window": 10, "buy_below": 10, "sell_above": 90}, object(), tmp_path)
    assert min(g["x"]["values"]) >= 5 and max(g["y"]["values"]) <= 95 and g["fixed"] == {"window": 10}
    assert S.run_grid(PLAN, "buy_and_hold", {}, object(), tmp_path) is None
    # 审计 D13：合法参数不管在不在常用范围里，网格都围着它取、包含它本身；不成立的组合标 invalid
    g = S.run_grid(PLAN, "rsi_reversion", {"buy_below": 70, "sell_above": 90}, object(), tmp_path)
    assert 70 in g["x"]["values"] and 90 in g["y"]["values"] and len(set(g["x"]["values"])) == 7
    bad = sum(1 for y in g["y"]["values"] for x in g["x"]["values"] if x >= y)
    assert g["invalid_cells"] == bad > 0 and g["runs"] == len(g["x"]["values"]) * len(g["y"]["values"]) - bad
    edge = S.run_grid(PLAN, "rsi_reversion", {"buy_below": 0, "sell_above": 100}, object(), tmp_path)
    assert min(edge["x"]["values"]) == 0 and max(edge["y"]["values"]) == 100
    r = S.run_grid(PLAN, "rsrs", {"threshold": 0.01, "n": 18, "m": 600}, object(), tmp_path)
    assert r["y"]["values"][0] == 0.01 and r["y"]["values"] == sorted(set(r["y"]["values"]))
    assert S._threshold_axis(2.9)[-1] == 3.0 and 2.9 in S._threshold_axis(2.9)
    assert S._threshold_axis(0.01) == [0.01, 0.11, 0.21, 0.31], "往下不凭空塞一个 0.1"


def test_plan_turns_on_bootstrap_and_segments():
    v = PLAN.to_config()["validation"]
    assert set(v) == {"bootstrap", "walk_forward"}, "交易顺序打乱的蒙特卡洛不默认开（结论含义弱）"


def test_robustness_view_drops_samples_and_keeps_errors():
    m = {"validation": {"bootstrap": {"observed_sharpe": 1, "ci_lower": -0.1, "ci_upper": 1.5, "prob_positive": 0.9,
                                      "confidence": 0.95, "n_bootstrap": 1000, "sharpe_samples": [0.1] * 1000},
                        "walk_forward": {"error": "need at least 10 bars for 5 windows"}}}
    out = _robustness(m)
    assert "sharpe_samples" not in out["bootstrap_sharpe"] and out["bootstrap_sharpe"]["ci_lower"] == -0.1
    assert "observed_sharpe" not in out["bootstrap_sharpe"], "不另给一个口径略不同的夏普"
    assert out["bootstrap_sharpe"]["n_valid"] == 1000, "没有剔掉样本：有效数就是抽样次数"
    # 审计 D12：剔掉了算不出夏普的样本，有效数要带出去（比例和区间的分母是它）
    part = _robustness({"validation": {"bootstrap": {**m["validation"]["bootstrap"], "n_valid": 640}}})
    assert part["bootstrap_sharpe"]["n_valid"] == 640 and part["bootstrap_sharpe"]["n_bootstrap"] == 1000
    assert out["segments"] == {"error": "need at least 10 bars for 5 windows"}


def test_worst_case_disclosures_fit_the_guided_tool_contract():
    """编排层要求强制披露 ≤ 12 条、每条 ≤ 500 字；超了整份报告会被拒。"""
    from backtest.strategies import Rsrs
    rsrs = Rsrs()
    rsrs.first_reading = {"600519.SH": None, "300308.SZ": None, "000001.SZ": None}
    notes = list(PLAN.notes) + ["以下标的自身历史不足…" * 5, "指定的基准 沪深300指数（INDEX:sh000300） 没有取到（" + "原" * 80 + "）",
                                "月度 / 年度表没有生成（x），只给出汇总指标"] + rsrs.result_notes({"trade_count": 3})
    r = Result(metrics={"total_return": 0.1, "execution_fees": 12.0, "total_turnover": 0.5,
                        "validation": {"bootstrap": {"ci_lower": 0, "ci_upper": 1}}},
               plan=PLAN, strategy="s", provenance={}, limits=[], notes=notes, run_dir=Path("/tmp"))
    d = _result_view(r, sensitivity={"x": {}})["required_disclosures"]
    assert len(d) <= 12 and all(len(x) <= 500 for x in d), [len(x) for x in d]
    assert any("不代表最优参数" in x for x in d)


def test_flat_or_tradeless_segments_are_undefined_not_zero():
    """某一段一直空仓：夏普、胜率无定义，是 None，不能写成 0（0 会被读成"这一段策略全错"）。"""
    import numpy as np
    import pandas as pd
    from backtest.validation import walk_forward_analysis
    idx = pd.bdate_range("2021-01-01", periods=40)
    rng = np.random.default_rng(0)
    moving = 100_000 * np.cumprod(1 + rng.normal(0.001, 0.01, 20))
    eq = pd.Series(np.concatenate([moving, np.full(20, moving[-1])]), index=idx)   # 后半段净值不动
    trade = SimpleNamespace(entry_time=idx[2], exit_time=idx[5], pnl=50.0)
    wf = walk_forward_analysis(eq, [trade], n_windows=2)
    first, second = wf["windows"]
    assert first["sharpe"] is not None and first["win_rate"] == 1.0
    assert second["sharpe"] is None and second["win_rate"] is None and second["trades"] == 0
    assert second["return"] == 0.0, "没动的那段收益确实是 0，这个数算得出"
    assert wf["sharpe_mean"] == first["sharpe"] and wf["sharpe_std"] == 0.0, "均值只对算得出的段求"


def test_segment_trades_count_by_exit_date_not_entry_date():
    """第四轮审计 D2：第 2 天开仓、最后一天才盈利平仓。按开仓日归段，第一段会拿到最后才知道的盈亏
    （trades=1、胜率 100%），改后面的行情就能改掉第一段的胜率。按平仓日归段：算在最后一段。"""
    import numpy as np
    import pandas as pd
    from backtest.validation import walk_forward_analysis
    idx = pd.bdate_range("2021-01-01", periods=50)
    eq = pd.Series(np.linspace(100.0, 110.0, 50), index=idx)
    held = SimpleNamespace(entry_time=idx[1], exit_time=idx[-1], pnl=80.0)
    wf = walk_forward_analysis(eq, [held], n_windows=5)
    assert [w["trades"] for w in wf["windows"]] == [0, 0, 0, 0, 1]
    assert wf["windows"][0]["win_rate"] is None and wf["windows"][-1]["win_rate"] == 1.0


def test_segments_compound_back_to_the_whole_period_and_keep_boundary_days():
    """审计 D5：前 50 天 100，第 51 天跌到 80 之后不动。以前五段收益、回撤全是 0（边界那天哪段都不算）。
    现在每段从上一段最后一天量起：第二段 -20%，五段连乘还原整段 -20%。"""
    import numpy as np
    import pandas as pd
    from backtest.validation import walk_forward_analysis
    idx = pd.bdate_range("2021-01-01", periods=250)
    eq = pd.Series([100.0] * 50 + [80.0] * 200, index=idx)
    wf = walk_forward_analysis(eq, [], n_windows=5, initial_capital=100.0)
    rets = [w["return"] for w in wf["windows"]]
    assert rets[1] == pytest.approx(-0.2) and wf["windows"][1]["max_dd"] == pytest.approx(-0.2)
    assert float(np.prod([1 + r for r in rets]) - 1) == pytest.approx(eq.iloc[-1] / 100.0 - 1)
    # 第一段从初始资金量起：开头那天的亏损也算进去
    wf0 = walk_forward_analysis(pd.Series([90.0] * 10, index=idx[:10]), [], n_windows=2, initial_capital=100.0)
    assert wf0["windows"][0]["return"] == pytest.approx(-0.1) and wf0["windows"][1]["return"] == 0.0


def test_bootstrap_on_flat_equity_reports_error_not_zero_interval():
    import pandas as pd
    from backtest.validation import bootstrap_sharpe_ci
    flat = pd.Series([100_000.0] * 30, index=pd.bdate_range("2021-01-01", periods=30))
    out = bootstrap_sharpe_ci(flat, n_bootstrap=50)
    assert "error" in out and "ci_lower" not in out
    assert _robustness({"validation": {"bootstrap": out}})["bootstrap_sharpe"] == {"error": out["error"]}
