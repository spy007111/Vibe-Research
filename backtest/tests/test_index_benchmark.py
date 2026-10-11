"""对照指数：取数走本产品端点、按收盘价对齐、取不到如实写明。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import loader as L  # noqa: E402
from backtest.benchmark import align_benchmark_close  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402

D = pd.to_datetime


def test_halted_day_return_is_not_lost():
    """策略剔掉停牌日时，指数那天的涨跌不能丢：旧做法 reindex(收益率).fillna(0) 只剩 +10%。"""
    close = pd.Series([100.0, 110.0, 121.0], index=D(["2024-01-02", "2024-01-03", "2024-01-04"]))
    dates = D(["2024-01-02", "2024-01-04"])
    curve, info = align_benchmark_close(close, dates)
    assert curve.iloc[-1] == pytest.approx(1.21)
    old = close.pct_change().reindex(dates).fillna(0.0)
    assert (1 + old).prod() == pytest.approx(1.10), "对照组：旧算法确实少算"
    assert info["filled_bars"] == 0


def test_missing_benchmark_bar_uses_previous_close_only():
    close = pd.Series([100.0, 105.0, 120.0], index=D(["2024-01-02", "2024-01-03", "2024-01-08"]))
    dates = D(["2024-01-02", "2024-01-03", "2024-01-05", "2024-01-08"])
    curve, info = align_benchmark_close(close, dates)
    assert list(curve.round(4)) == [1.0, 1.05, 1.05, 1.2], "01-05 只能用 01-03 的收盘，不能偷看 01-08"
    assert info["filled_bars"] == 1


def test_benchmark_starting_late_or_going_stale_is_a_gap():
    dates = D(["2024-01-02", "2024-01-03", "2024-03-01"])
    late = pd.Series([1.0, 2.0], index=D(["2024-01-03", "2024-03-01"]))
    curve, info = align_benchmark_close(late, dates)
    assert curve is None and "晚于回测首日" in info["gap"]
    stale = pd.Series([1.0, 2.0], index=D(["2024-01-02", "2024-01-03"]))
    curve, info = align_benchmark_close(stale, dates)
    assert curve is None and "早 7 天以上" in info["gap"]
    curve, info = align_benchmark_close(pd.Series(dtype=float), dates)
    assert curve is None and info["gap"]


@pytest.mark.parametrize("codes,ticker", [(["600519.SH"], "INDEX:sh000300"), (["AAPL"], "INDEX:SPY"), (["00700.HK"], "INDEX:02800.HK")])
def test_plan_asks_for_the_market_index(codes, ticker):
    plan = plan_backtest(codes=codes, start="2021-01-01", end="2025-12-31", style="long")
    assert plan.to_config()["benchmark"] == ticker


def _fake_fetch(tmp_path: Path, payload: dict, name: str):
    raw = tmp_path / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / name).write_text(json.dumps(payload), encoding="utf-8")
    refs = ["raw/page1.html", f"raw/{name}"] if name.startswith("extracted_") else [f"raw/{name}"]
    return lambda *a, **k: {"status": "ok", "extra": {"raw_files": refs}}


def _tx_rows(code: str):
    return [{"code": code, "date": d, "open": c, "high": c, "low": c, "close": c, "volume": 1.0}
            for d, c in (("2024-01-02", 3400.0), ("2024-01-03", 3420.0))]


def test_index_goes_to_its_own_ledger_not_user_failures(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "_run_fetch", _fake_fetch(tmp_path, {"rows": _tx_rows("sh000300")}, "extracted_x.json"))
    ld = L.VibeLoader(out_dir=tmp_path)
    out = ld.fetch(["INDEX:sh000300"], "2024-01-01", "2024-01-31")
    df = out["INDEX:sh000300"]
    assert list(df["close"]) == [3400.0, 3420.0] and df.index.dtype == "datetime64[ns]"
    assert "INDEX:sh000300" in ld.benchmark_provenance and not ld.provenance and not ld.failures
    assert ld.benchmark_provenance["INDEX:sh000300"].note == "沪深300指数"


def test_wrong_instrument_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "_run_fetch", _fake_fetch(tmp_path, {"rows": _tx_rows("sz399001")}, "extracted_x.json"))
    ld = L.VibeLoader(out_dir=tmp_path)
    assert ld.fetch(["INDEX:sh000300"], "2024-01-01", "2024-01-31") == {}
    assert "不是同一个指数" in ld.benchmark_failures["INDEX:sh000300"] and not ld.failures

    yahoo = {"chart": {"result": [{"meta": {"symbol": "0700.HK"}, "timestamp": [1704153600],
                                   "indicators": {"quote": [{"open": [1], "high": [1], "low": [1], "close": [1], "volume": [1]}]}}]}}
    monkeypatch.setattr(L, "_run_fetch", _fake_fetch(tmp_path, yahoo, "y.json"))
    assert ld.fetch(["INDEX:02800.HK"], "2024-01-01", "2024-01-31") == {}
    assert "不是同一只 ETF" in ld.benchmark_failures["INDEX:02800.HK"]
    assert ld.fetch(["INDEX:000001"], "2024-01-01", "2024-01-31") == {}
    assert "不认识的对照指数" in ld.benchmark_failures["INDEX:000001"]


def test_failed_index_note_names_index_and_reason(monkeypatch):
    import importlib
    import backtest.run as RUN

    class FakeLoader:
        failures, provenance, benchmark_provenance = {}, {}, {}
        benchmark_failures = {"INDEX:sh000300": "tx_kline 取 sh000300 超时（120s）"}
        def __init__(self, *a, **k): pass

    class FakeEngine:
        def __init__(self, cfg): pass
        def run_backtest(self, **kw): return {"total_return": 0.1, "benchmark_return": -0.2, "benchmark_kind": "self_hold"}

    class Flat:
        def generate(self, data_map): return {}

    plan = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2025-12-31", style="long")
    monkeypatch.setattr(RUN, "VibeLoader", FakeLoader)
    monkeypatch.setattr(RUN, "ENGINES", {**RUN.ENGINES, "ChinaAEngine": FakeEngine})
    try:
        r = RUN.run(plan, Flat())
    finally:
        importlib.reload(RUN)
    note = next(n for n in r.notes if "没有取到" in n)
    assert "沪深300指数" in note and "超时" in note and "等权买入持有" in note
    assert r.missing == {} and r.benchmark is None


def test_failed_fetch_is_not_retried_within_one_loader(tmp_path):
    """敏感度网格复用同一个 loader：取不到的指数 / 标的不能每一格再等一次超时，失败原因也要留着。"""
    ld = L.VibeLoader(out_dir=tmp_path)
    calls = []

    def boom(kind):
        def f(*a, **k):
            calls.append(kind)
            raise L.LoaderError("超时")
        return f
    ld._fetch_index = boom("index")
    ld._fetch_one = boom("stock")
    for _ in range(3):
        assert ld.fetch(["INDEX:sh000300", "600519.SH"], "2024-01-01", "2024-01-31") == {}
    assert calls == ["index", "stock"], calls
    assert ld.benchmark_failures["INDEX:sh000300"] == "超时" and ld.failures["600519.SH"] == "超时"
    ld.fetch(["600519.SH"], "2024-01-01", "2024-02-29")
    assert calls[-1] == "stock" and len(calls) == 3, "换了区间是另一份数据，照常去取"
