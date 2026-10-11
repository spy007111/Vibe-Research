"""RSRS 择时模板：斜率与标准分按公式手算对得上、预热期不持有、阈值之间保留前值、样本不够时拒绝、口径写清楚。"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import sensitivity as S  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402
from backtest.strategies import BUILTIN, Rsrs  # noqa: E402


def _ohlc(n: int, seed: int = 0, start: str = "2015-01-05") -> pd.DataFrame:
    """随机游走收盘价，最高 / 最低在收盘价上下随机加减（保证 high ≥ close ≥ low）。"""
    rng = np.random.default_rng(seed)
    close = 20 * np.cumprod(1 + rng.normal(0.0003, 0.015, n))
    high = close * (1 + rng.uniform(0.001, 0.03, n))
    low = close * (1 - rng.uniform(0.001, 0.03, n))
    idx = pd.date_range(start, periods=n, freq="B").astype("datetime64[ns]")
    return pd.DataFrame({"open": close, "high": high, "low": low, "close": close, "volume": 1e6}, index=idx)


def test_slope_matches_least_squares_by_hand():
    df = _ohlc(60, seed=1)
    r = Rsrs(n=18, m=20)
    beta = r.slope(df["high"], df["low"])
    assert beta.iloc[:17].isna().all(), "不足 18 天没有斜率"
    for i in (17, 30, 59):
        lo, hi = df["low"].iloc[i - 17:i + 1].to_numpy(), df["high"].iloc[i - 17:i + 1].to_numpy()
        assert beta.iloc[i] == pytest.approx(np.polyfit(lo, hi, 1)[0], rel=1e-9)


def test_exact_line_gives_its_slope():
    low = pd.Series(np.linspace(10, 12, 30) + np.sin(np.arange(30)))
    r = Rsrs(n=5, m=20)
    beta = r.slope(2 + 1.5 * low, low)
    assert beta.dropna().to_numpy() == pytest.approx(np.full(26, 1.5))
    # 斜率一直不变：标准分无定义，不能被浮点误差放大成假读数
    assert r.zscore(2 + 1.5 * low, low).isna().all()


def test_zscore_matches_hand_computation():
    df = _ohlc(120, seed=2)
    r = Rsrs(n=10, m=30)
    beta = r.slope(df["high"], df["low"]).to_numpy()
    z = r.zscore(df["high"], df["low"])
    first = 10 + 30 - 2                       # 第 n+m-1 根（0 起算是 n+m-2）才有第一个读数
    assert z.iloc[:first].isna().all() and not np.isnan(z.iloc[first])
    for i in (first, 80, 119):
        w = beta[i - 29:i + 1]
        assert z.iloc[i] == pytest.approx((beta[i] - w.mean()) / w.std(ddof=1), rel=1e-9)


def test_flat_low_is_undefined_and_does_not_blank_the_next_m_days():
    """最低价连续 n 天不变：斜率无定义（NaN，不是 0）；标准化往前多取几天凑满 m 个，之后照常有读数。"""
    df = _ohlc(200, seed=3)
    df.iloc[100:110, df.columns.get_loc("low")] = df["low"].iloc[100]
    r = Rsrs(n=5, m=30)
    beta = r.slope(df["high"], df["low"])
    assert beta.iloc[104:110].isna().all() and beta.iloc[103] == beta.iloc[103]
    z = r.zscore(df["high"], df["low"])
    assert z.iloc[110:140].notna().all(), "一小段无定义不该让之后 m 天都没有读数"
    assert z.iloc[104:110].isna().all()


def test_positions_hold_between_thresholds_and_split_across_codes(monkeypatch):
    idx = pd.date_range("2020-01-01", periods=10, freq="B")
    zs = pd.Series([np.nan, np.nan, 0.8, 0.5, -0.5, -0.8, 0.7, 0.71, -0.7, 0.7], index=idx)
    r = Rsrs(n=3, m=20, threshold=0.7)
    monkeypatch.setattr(r, "zscore", lambda h, l: zs)
    frame = pd.DataFrame({"high": 1.0, "low": 1.0}, index=idx)
    out = r.generate({"A": frame, "B": frame})
    assert out["A"].tolist() == [0, 0, 0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5], "正好等于 ±阈值不算越过，保留前值"
    assert r.first_reading == {"A": idx[2], "B": idx[2]}


def test_warmup_bars_are_never_held():
    df = _ohlc(700, seed=4)
    r = Rsrs(n=18, m=600)
    pos = r.generate({"X": df})["X"]
    assert r.warmup_bars == 617
    assert (pos.iloc[:616] == 0).all(), "第 617 根收盘才有第一个读数，引擎再后移一根成交"
    assert r.first_reading["X"] == df.index[616]


@pytest.mark.parametrize("kw", [
    {"n": 2}, {"n": True}, {"n": 18.0}, {"m": 19}, {"m": 600.0}, {"threshold": 0}, {"threshold": -0.7},
    {"threshold": 3.5}, {"threshold": True}, {"threshold": "0.7"},
])
def test_rejects_bad_params(kw):
    with pytest.raises(ValueError):
        Rsrs(**kw)


def test_accepts_boundaries_and_names_the_params():
    assert Rsrs(n=3, m=20, threshold=3).warmup_bars == 22
    assert Rsrs(threshold=1).name == "RSRS 择时（回归 18 日 / 标准化 600 日 / 阈值 ±1）"
    assert BUILTIN["rsrs"] is Rsrs


# ── 运行期守卫：预热期要算进样本 ──

def _guard(n_bars_by_code, inner):
    from backtest.run import _Guarded
    plan = plan_backtest(codes=list(n_bars_by_code), start="2015-01-01", end="2025-12-31", style="swing")
    dm = {c: _ohlc(n, seed=i) for i, (c, n) in enumerate(n_bars_by_code.items())}
    return _Guarded(inner, plan), dm


def test_guard_refuses_when_warmup_eats_the_sample():
    from backtest.run import BacktestNotValid
    g, dm = _guard({"600519.SH": 250}, Rsrs(n=3, m=20))          # 预热 22 根，波段要 240 根能持有的
    with pytest.raises(BacktestNotValid) as e:
        g.generate(dm)
    msg = str(e.value)
    assert "前 22 根日线只用来算指标" in msg and "一共至少 262 根" in msg and "还差 12 根" in msg
    assert "标准化窗口 m 调短" in msg
    # 连波段本身的 240 根都不够：第一次就说清合计 262 根，不先只报 240（E3 审查 P2-1）
    g, dm = _guard({"600519.SH": 200}, Rsrs(n=3, m=20))
    with pytest.raises(BacktestNotValid) as e:
        g.generate(dm)
    assert "一共至少 262 根" in str(e.value) and "还差 62 根（约 3 个月）" in str(e.value)


def test_guard_passes_and_names_thin_symbols_with_the_warmup():
    g, dm = _guard({"600519.SH": 262}, Rsrs(n=3, m=20))
    assert g.generate(dm) and g.note == ""
    g, dm = _guard({"600519.SH": 300, "300308.SZ": 250}, Rsrs(n=3, m=20))
    g.generate(dm)
    assert "300308.SZ 仅 250 根" in g.note and "合计要 262 根" in g.note and "600519.SH" not in g.note


def test_strategies_without_warmup_keep_the_old_threshold():
    class Flat:
        name = "全仓不动"
        def generate(self, dm):
            return {c: pd.Series(1.0, index=df.index) for c, df in dm.items()}
    g, dm = _guard({"600519.SH": 240}, Flat())
    assert g.generate(dm) and g.note == ""


# ── 结果口径 ──

def _notes(r: Rsrs, **metrics) -> str:
    notes = r.result_notes(metrics)
    assert len(notes) == 1, "合成一条，不挤占强制披露的条数上限"
    return notes[0]


def test_result_note_discloses_method_warmup_and_first_reading():
    r = Rsrs()
    r.first_reading = {"600519.SH": pd.Timestamp("2019-03-05")}
    t = _notes(r, trade_count=12)
    assert "光大证券 2017 年" in t and "沪深300 指数 2005–2017 年" in t and "R² 修正版和右偏版没有做" in t
    assert "前 617 根日线只用来算指标、不持有" in t and "对照基准这段时间是持有的" in t
    assert "第一个读数在 2019-03-05。" in t
    assert "平仓记录" not in t, "够 10 条不写这句"
    assert len(t) <= 500


@pytest.mark.parametrize("tc,expect", [
    (9, "本次只有 9 条平仓记录，少于 10 条"), (0, "本次没有一条平仓记录"),
])
def test_result_note_flags_too_few_trades(tc, expect):
    t = _notes(Rsrs(), trade_count=tc)
    assert expect in t and "说明不了这个方法有效还是无效" in t


@pytest.mark.parametrize("tc", [None, "9", True, 10])
def test_unknown_or_enough_trades_are_not_flagged(tc):
    assert "平仓记录" not in _notes(Rsrs(), trade_count=tc)


def test_result_note_for_several_codes():
    r = Rsrs()
    r.first_reading = {"A": pd.Timestamp("2019-03-05"), "B": pd.Timestamp("2020-01-02"), "C": None}
    t = _notes(r)
    assert "各标的第一个读数在 2019-03-05 到 2020-01-02 之间。" in t and "C 整段没有读数，始终不持有。" in t


def test_result_note_avoids_product_gate_words():
    """强制披露会原样拼进报告正文、再过产品红线；里面有「空仓」这类词，整份报告会被拦掉。"""
    sys.path.insert(0, os.path.join(ROOT, ".agents", "skills", "data-access", "scripts", "sources"))
    from textsafe import GATE_WORDS
    r = Rsrs()
    r.first_reading = {"A": pd.Timestamp("2019-03-05"), "B": None}
    from backtest.cli import _catalog
    catalog_note = next(s["note"] for s in _catalog()["strategies"] if s["key"] == "rsrs")
    for text in (_notes(r, trade_count=0), _notes(r, trade_count=3), catalog_note):
        assert not [w for w in GATE_WORDS if w in text], text


# ── 真引擎跑一遍（离线：假取数）──

def test_real_engine_run_keeps_warmup_flat_and_reports_the_note(tmp_path, monkeypatch):
    import backtest.run as RUN
    from backtest.cli import _result_view

    frames = {"600519.SH": _ohlc(1000, seed=7)}

    class FakeLoader:
        failures, provenance = {}, {}
        def __init__(self, *args, **kwargs): pass
        def fetch(self, *args, **kwargs): return frames

    monkeypatch.setattr(RUN, "VibeLoader", FakeLoader)
    plan = plan_backtest(codes=list(frames), start="2015-01-01", end="2025-12-31", style="swing")
    result = RUN.run(plan, Rsrs(n=18, m=600), run_dir=tmp_path)
    assert result.strategy.startswith("RSRS 择时")
    eq = pd.read_csv(tmp_path / "artifacts" / "equity.csv", index_col=0)
    col = eq.select_dtypes("number").iloc[:, 0]
    assert col.iloc[:617].nunique() == 1, "预热期不持有，净值不动"
    assert col.iloc[617:].nunique() > 1, "预热期之后有持仓"
    disclosures = _result_view(result)["required_disclosures"]
    assert sum("RSRS 择时按光大证券" in d for d in disclosures) == 1
    assert len(disclosures) <= 12 and all(len(d) <= 500 for d in disclosures)


# ── 参数敏感度 ──

def test_sensitivity_axes_for_rsrs(monkeypatch, tmp_path):
    calls = []

    def fake(plan, strategy, run_dir, loader, config_overrides):
        calls.append((strategy.n, strategy.m, strategy.threshold))
        return SimpleNamespace(metrics={"total_return": 0.0})

    monkeypatch.setattr(S, "run", fake)
    plan = plan_backtest(codes=["600519.SH"], start="2015-01-01", end="2025-12-31", style="swing")
    g = S.run_grid(plan, "rsrs", {}, object(), tmp_path)
    assert g["x"] == {"param": "n", "values": [9, 12, 15, 18, 22, 27, 36]}
    assert g["y"] == {"param": "threshold", "values": [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]}
    assert g["fixed"] == {"m": 600} and g["base"] == {"n": 18, "threshold": 0.7}
    assert g["runs"] == 49 and {c[1] for c in calls} == {600}
    low = S.run_grid(plan, "rsrs", {"n": 4, "m": 100, "threshold": 0.2}, object(), tmp_path)
    assert low["y"]["values"] == [0.1, 0.2, 0.3, 0.4, 0.5] and min(low["x"]["values"]) == 3
    high = S.run_grid(plan, "rsrs", {"threshold": 2.5}, object(), tmp_path)
    assert high["y"]["values"] == [2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8], "阈值上限跟构造一致是 3，不是 2"
    top = S.run_grid(plan, "rsrs", {"threshold": 3}, object(), tmp_path)
    assert top["y"]["values"] == [2.7, 2.8, 2.9, 3.0]
    assert all(c[2] <= 3 for c in calls), "网格里每一格都能构造出来"


def test_catalog_lists_rsrs_with_the_constructor_defaults():
    import inspect
    from backtest.cli import _catalog
    entry = next(s for s in _catalog()["strategies"] if s["key"] == "rsrs")
    sig = inspect.signature(Rsrs.__init__).parameters
    assert {k: v["default"] for k, v in entry["params"].items()} == {k: sig[k].default for k in ("n", "m", "threshold")}
    assert "857 根" in entry["note"] and "1097 根" in entry["note"], "默认参数下波段 240+617、长线 480+617"
    assert {s["key"] for s in _catalog()["strategies"]} == set(BUILTIN), "选项表与实际策略一一对应"


def test_every_catalog_param_has_a_chinese_axis_name_in_the_ui():
    """参数敏感度图的轴名是前端写死的一张表；漏一个，图上就显示英文参数名。"""
    import re
    from backtest.cli import _catalog
    src = open(os.path.join(ROOT, "desktop", "src", "verticals", "finance", "lib", "backtestView.ts"), encoding="utf-8").read()
    block = re.search(r"const PARAM_LABEL[^{]*\{(.*?)\};", src, re.S).group(1)
    labelled = set(re.findall(r"(\w+):\s*\"", block))
    wanted = {p for s in _catalog()["strategies"] for p in s["params"]}
    assert wanted <= labelled, wanted - labelled
