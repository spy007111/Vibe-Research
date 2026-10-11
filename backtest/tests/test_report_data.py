"""补充指标、月度 / 年度表、回撤段、画图序列：手算对照 + 与引擎产物逐行对拍。"""
from __future__ import annotations

import importlib
import math
import os
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import report_data as R  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402

D = pd.to_datetime


def _eq(values, start="2024-01-02", freq="B"):
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq=freq), dtype=float)


def test_underwater_and_episodes_start_from_initial_cash():
    eq = _eq([90, 110, 99, 121])
    assert list(R.underwater(eq, 100).round(6)) == [-0.1, 0.0, -0.1, 0.0], "首根就亏也算回撤（高水位=初始资金）"
    eps = R.drawdown_episodes(eq, 100)
    assert [e["depth"] for e in eps] == pytest.approx([-0.1, -0.1])
    second = eps[1]
    assert (second["start"], second["trough"], second["end"]) == ("2024-01-03", "2024-01-04", "2024-01-05")
    assert (second["bars_to_trough"], second["bars_to_recover"], second["bars"]) == (1, 1, 2)
    unrecovered = R.drawdown_episodes(_eq([100, 120, 90, 100]), 100)[0]
    assert unrecovered["end"] is None and unrecovered["bars_to_recover"] is None
    assert unrecovered["depth"] == pytest.approx(-0.25) and unrecovered["bars"] == 2


def test_period_returns_first_period_against_initial_cash():
    eq = pd.Series([105.0, 110.0, 99.0], index=D(["2024-01-31", "2024-02-29", "2025-03-03"]))
    m = R.period_returns(eq, 100, "M")
    assert list(m.round(6)) == [0.05, round(110 / 105 - 1, 6), 0.1 * -1 + 0.0 if False else round(99 / 110 - 1, 6)]
    y = R.period_returns(eq, 100, "Y")
    assert list(y.round(6)) == [0.1, round(99 / 110 - 1, 6)]
    assert (1 + m).prod() - 1 == pytest.approx(99 / 100 - 1), "各月连乘 = 总收益"


def test_extended_metrics_hand_checked():
    eq = _eq([90, 110, 99, 121])
    trades = [SimpleNamespace(pnl=30.0, pnl_pct=30.0), SimpleNamespace(pnl=-10.0, pnl_pct=-10.0)]
    pos = pd.DataFrame({"A": [0.0, 1.0, 0.5, 0.0], "B": [0.0, 0.0, -0.5, 0.0]}, index=eq.index)
    m = R.extended_metrics(eq, 100, trades, pos, execution_fees=2.5, bars_per_year=252)
    assert m["ulcer_index"] == pytest.approx(math.sqrt(0.005))
    assert m["longest_drawdown_bars"] == 2
    assert m["exposure_time"] == pytest.approx(0.5) and m["avg_gross_exposure"] == pytest.approx(0.5)
    assert m["expectancy"] == pytest.approx(10.0) and m["expectancy_pct"] == pytest.approx(0.10), "百分数换成小数"
    assert m["largest_win"] == 30.0 and m["largest_loss"] == -10.0
    assert m["sqn"] == pytest.approx(math.sqrt(2) * 10 / np.std([30, -10], ddof=1))
    assert m["fees_pct_of_initial"] == pytest.approx(0.025)
    assert m["var_95"] is None and m["cvar_95"] is None, "样本不足 20 不算 VaR"
    ret = eq.pct_change().fillna(0.0)
    assert m["best_day"] == pytest.approx(ret.max()) and m["worst_day"] == pytest.approx(ret.min())
    assert m["annual_volatility"] == pytest.approx(ret.std() * math.sqrt(252))


def test_undefined_values_are_none_not_zero():
    flat = _eq([100.0] * 30)
    m = R.extended_metrics(flat, 100, [], None, execution_fees=None, bars_per_year=252)
    for k in ("expectancy", "expectancy_pct", "sqn", "largest_win", "largest_loss", "skew", "kurtosis",
              "exposure_time", "fees_pct_of_initial"):
        assert m[k] is None, k
    assert m["annual_volatility"] == 0.0 and m["longest_drawdown_bars"] == 0
    only_wins = R.extended_metrics(flat, 100, [SimpleNamespace(pnl=5.0, pnl_pct=5.0)], None, 0.0, 252)
    assert only_wins["largest_loss"] is None and only_wins["sqn"] is None and only_wins["fees_pct_of_initial"] == 0.0


def test_var_is_historical_quantile():
    rng = np.random.default_rng(7)
    eq = _eq(list(100 * np.cumprod(1 + rng.normal(0, 0.01, 60))))
    m = R.extended_metrics(eq, 100, [], None, 0.0, 252)
    ret = eq.pct_change().fillna(0.0).to_numpy()
    q = np.quantile(ret, 0.05)
    assert m["var_95"] == pytest.approx(q) and m["cvar_95"] == pytest.approx(ret[ret <= q].mean())
    assert m["cvar_95"] <= m["var_95"]


def _trend_frames(n, codes):
    idx = pd.date_range("2021-01-04", periods=n, freq="B").astype("datetime64[ns]")
    out = {}
    for k, c in enumerate(codes):
        close = 10 * np.exp(np.cumsum(np.sin(np.arange(n) / (9 + k)) * 0.01 + 0.0005))
        out[c] = pd.DataFrame({"open": close, "high": close * 1.01, "low": close * 0.99, "close": close,
                               "volume": 1e6, "pre_close": np.r_[close[0], close[:-1]]}, index=idx)
    return out


def test_tables_and_charts_match_engine_artifacts(tmp_path, monkeypatch):
    """真引擎跑一遍：画图序列与 equity.csv 逐行一致；最低回撤 = 报告最大回撤；月度连乘 = 总收益；对照是指数。"""
    import backtest.run as RUN
    from backtest.cli import _result_view

    frames = _trend_frames(520, ("600519.SH",))
    idx = frames["600519.SH"].index
    index_close = pd.Series(3000 * np.exp(np.cumsum(np.cos(np.arange(len(idx)) / 13) * 0.004)), index=idx)
    index_frame = pd.DataFrame({"open": index_close, "high": index_close, "low": index_close,
                                "close": index_close, "volume": 1.0}, index=idx)

    class FakeLoader:
        name = "vibe"
        def __init__(self, *a, **k):
            self.failures, self.provenance = {}, {}
            self.benchmark_failures, self.benchmark_provenance = {}, {}
        def fetch(self, codes, *a, **k):
            return {c: (index_frame if c == "INDEX:sh000300" else frames[c]) for c in codes
                    if c == "INDEX:sh000300" or c in frames}

    class Swing:
        name = "摆动"
        def generate(self, dm):
            return {c: (df["close"] > df["close"].rolling(20).mean()).astype(float) for c, df in dm.items()}

    monkeypatch.setattr(RUN, "VibeLoader", FakeLoader)
    plan = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2022-12-31", style="swing")
    try:
        r = RUN.run(plan, Swing(), run_dir=tmp_path)
    finally:
        importlib.reload(RUN)
    csv = pd.read_csv(tmp_path / "artifacts" / "equity.csv", index_col="timestamp", parse_dates=["timestamp"])
    view = _result_view(r, charts=True)
    ch = view["ui_only"]["charts"]
    assert ch["dates"] == [str(t.date()) for t in csv.index]
    assert ch["equity"] == [float(v) for v in csv["equity"]]
    assert ch["drawdown"] == [float(v) for v in csv["drawdown"]], "图的回撤列就是引擎写出的那一列"
    assert ch["benchmark"] == [float(v) for v in csv["benchmark_equity"]]
    m = r.metrics
    assert min(ch["drawdown"]) == pytest.approx(m["max_drawdown"])
    assert m["benchmark_ticker"] == "INDEX:sh000300" and m["benchmark_label"] == "沪深300指数"
    assert m["benchmark_return"] == pytest.approx(index_close.iloc[-1] / index_close.iloc[0] - 1, abs=1e-6)
    monthly = view["tables"]["monthly"]
    rets = [v for row in monthly["ret"] for v in row if v is not None]
    bens = [v for row in monthly["bench"] for v in row if v is not None]
    assert len(rets) == 24 and monthly["years"] == [2021, 2022]
    assert np.prod([1 + x for x in rets]) - 1 == pytest.approx(m["total_return"], abs=2e-3), "表格取整到 0.01%"
    assert np.prod([1 + x for x in bens]) - 1 == pytest.approx(m["benchmark_return"], abs=2e-3)
    yearly = view["tables"]["yearly"]
    assert [(y["year"], y["partial"]) for y in yearly] == [(2021, False), (2022, False)], "2021-01-04 → 2022-12-30 两年都完整"
    assert m["worst_month"] == pytest.approx(min(rets), abs=1e-4)
    assert view["tables"]["drawdowns"][0]["depth"] == pytest.approx(m["max_drawdown"], abs=1e-4)
    assert "ui_only" not in _result_view(r), "默认不带逐日序列（MCP / 命令行）"


def test_partial_years_are_flagged_and_missing_benchmark_is_none(tmp_path):
    idx = pd.date_range("2024-03-01", "2025-05-30", freq="B")
    eq = pd.Series(np.linspace(100, 130, len(idx)), index=idx)
    pd.DataFrame({"ret": eq.pct_change().fillna(0.0), "equity": eq, "drawdown": 0.0,
                  "benchmark_equity": np.nan, "active_ret": 0.0}, index=pd.Index(idx, name="timestamp")).to_csv(tmp_path / "e.csv")
    t = R.report_tables(tmp_path / "e.csv", 100)
    assert [(y["year"], y["partial"]) for y in t["yearly"]] == [(2024, True), (2025, True)]
    assert all(y["bench"] is None and y["excess"] is None for y in t["yearly"])
    assert t["charts"]["benchmark"] is None and t["monthly"]["bench"] is None
    assert t["monthly"]["years"] == [2024, 2025] and t["monthly"]["ret"][0][:2] == [None, None], "1–2 月在区间外"
    assert t["monthly"]["ret"][1][5:] == [None] * 7, "2025 年只到 5 月"


@pytest.mark.parametrize("start,end,want", [
    ("2021-01-15", "2022-12-10", [(2021, True), (2022, True)]),    # 1 月中开始、12 月上旬结束：月份对，年份不完整
    ("2021-01-04", "2022-12-30", [(2021, False), (2022, False)]),
    ("2022-01-04", "2023-12-29", [(2022, False), (2023, False)]),  # 12-29 是 2023 年最后一个交易日
    ("2021-01-06", "2021-12-28", [(2021, True)]),
])
def test_partial_year_looks_at_days_not_only_months(tmp_path, start, end, want):
    idx = pd.date_range(start, end, freq="B")
    eq = pd.Series(np.linspace(100, 110, len(idx)), index=idx)
    pd.DataFrame({"ret": eq.pct_change().fillna(0.0), "equity": eq, "drawdown": 0.0,
                  "benchmark_equity": np.nan, "active_ret": 0.0}, index=pd.Index(idx, name="timestamp")).to_csv(tmp_path / "e.csv")
    assert [(y["year"], y["partial"]) for y in R.report_tables(tmp_path / "e.csv", 100)["yearly"]] == want
