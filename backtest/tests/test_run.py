"""Result 的呈现纪律 —— 报告里每一句都得对得上事实。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest.gate import plan_backtest  # noqa: E402
from backtest.loader import SymbolProvenance  # noqa: E402
from backtest.run import Result, run  # noqa: E402
from backtest.cli import _result_view  # noqa: E402

PLAN = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2025-12-31", style="long")
BASE = dict(total_return=0.1, annual_return=0.02, max_drawdown=-0.3, sharpe=0.5,
            calmar=0.1, sortino=0.4, trade_count=3, win_rate=0.66, profit_loss_ratio=1.2)


def test_no_loss_ratios_are_unavailable_not_zero():
    from types import SimpleNamespace
    from backtest.metrics import win_rate_and_stats
    for pnls in ([], [100], [0], [100, 0]):
        stats = win_rate_and_stats([SimpleNamespace(pnl=p, holding_bars=2) for p in pnls])
        assert stats["profit_loss_ratio"] is None
        assert stats["profit_factor"] is None
    mixed = win_rate_and_stats([SimpleNamespace(pnl=p, holding_bars=2) for p in [100, -50]])
    assert mixed["profit_loss_ratio"] == 2
    assert mixed["profit_factor"] == 2


def make(metrics=None, missing=None, prov=None) -> Result:
    return Result(metrics={**BASE, **(metrics or {})}, plan=PLAN, strategy="测试策略",
                  provenance=prov or {}, limits=list(PLAN.limits), notes=list(PLAN.notes),
                  run_dir=Path("/tmp"), missing=missing or {})


def test_limits_always_appear_in_the_summary():
    """限制不是附注，是结果的一部分 —— 回测最容易被误读的不是数字算错，
    而是读的人不知道它在什么约束下算出来的。"""
    text = make().summary()
    for line in PLAN.limits:
        assert line in text


def test_self_benchmark_is_labelled_as_such():
    """`benchmark_return` 在没配指数时是**等权买入持有这几只标的本身**。
    名字叫 benchmark，不说清楚就会被当成沪深300 / 标普 —— 那是完全不同的结论。"""
    text = make({"benchmark_return": -0.24}).summary()
    assert "-24.00%" in text and "不是指数" in text


def test_agent_result_forces_self_benchmark_and_cash_drag_disclosures():
    view = _result_view(make({"benchmark_return": -0.24, "total_turnover": 0.874}))
    lines = view["required_disclosures"]
    assert any("不是独立外部基准" in line for line in lines)
    assert any("总换手率为 0.874" in line and "未投入现金" in line for line in lines)


def test_agent_result_preserves_execution_fees_and_currency():
    view = _result_view(make({"execution_fees": 123.456, "fill_count": 4}))
    assert view["metrics"]["execution_fees"] == 123.456
    assert view["metrics"]["fill_count"] == 4
    assert view["plan"]["currency"] == "CNY"
    assert any("平仓记录" in line and "fill_count" in line for line in view["required_disclosures"])
    assert any("滑点" in line and "execution_fees" in line for line in view["required_disclosures"])
    assert any("滑点通过引擎成交价格模型反映在净值中" in line for line in view["required_disclosures"])


def test_legacy_result_does_not_invent_zero_execution_fees():
    view = _result_view(make())
    assert "execution_fees" not in view["metrics"]
    assert "fill_count" not in view["metrics"]


def test_external_benchmark_and_full_turnover_do_not_claim_those_limitations():
    view = _result_view(make({"benchmark_return": -0.1, "benchmark_ticker": "000300.SH", "total_turnover": 1.2}))
    assert not any("不是独立外部基准" in n or "未投入现金" in n for n in view["required_disclosures"])
    assert any("前复权" in n and "不单独记现金分红" in n and "重述" in n for n in view["required_disclosures"])


def test_runtime_notes_reach_required_disclosures_without_truncation():
    r = make()
    note = "以下标的自身历史不足：" + "300308.SZ 仅 400 根；" * 40
    r.notes.extend([note, note])
    view = _result_view(r)
    assert view["required_disclosures"].count(note) == 1
    assert all(n not in view["required_disclosures"] for n in PLAN.notes if "不单独记现金分红" not in n)
    assert view["plan"]["notes"] == PLAN.notes


@pytest.mark.parametrize("code", ["AAPL", "00700.HK"])
def test_yahoo_price_basis_is_forced_even_without_runtime_notes(code):
    result = make()
    result.plan = plan_backtest(codes=[code], start="2021-01-01", end="2025-12-31", style="long")
    result.notes = []
    disclosures = _result_view(result)["required_disclosures"]
    assert any("indicators.quote" in n and "adjclose" in n and "不单独记现金分红" in n and "重述" in n for n in disclosures)


def test_real_run_thin_history_reaches_tool_result(tmp_path, monkeypatch):
    import backtest.run as RUN

    frames = _frames(600, ("600519.SH",))
    frames.update(_frames(400, ("300308.SZ",)))

    class FakeLoader:
        failures, provenance = {}, {}
        def __init__(self, *args, **kwargs): pass
        def fetch(self, *args, **kwargs): return frames

    monkeypatch.setattr(RUN, "VibeLoader", FakeLoader)
    plan = plan_backtest(codes=list(frames), start="2021-01-01", end="2025-12-31", style="long")
    result = RUN.run(plan, _Flat(), run_dir=tmp_path)
    notes = _result_view(result)["required_disclosures"]
    assert any("300308.SZ" in n and "400 根" in n and "仍参与" in n for n in notes)


def test_real_index_benchmark_is_named():
    text = make({"benchmark_return": -0.1, "benchmark_ticker": "000300.SH"}).summary()
    assert "000300.SH" in text and "不是指数" not in text


def test_no_benchmark_line_when_absent():
    assert "对照" not in make().summary()


def test_missing_symbols_are_reported():
    """取不到的票要说出来 —— 引擎只是把它们漏掉，结果照样算得出来，
    读的人会以为三只都在里面。"""
    text = make(missing={"300308.SZ": "区间内一根 bar 都没有"}).summary()
    assert "300308.SZ" in text and "未参与回测" in text


def test_provenance_is_shown():
    p = SymbolProvenance(code="600519.SH", market="a_share", endpoint="bs_kline_qfq",
                         rows=969, first_bar="2022-01-04", last_bar="2025-12-31",
                         halted_bars=2, note="停牌 / 无成交 2 根已剔除")
    text = make(prov={"600519.SH": p}).summary()
    assert "bs_kline_qfq" in text and "969 根" in text and "停牌" in text


def test_run_refuses_a_refusal():
    """调用方本该先看闸口的结论；把 Refusal 传进来要立刻炸，不能当成没事跑。"""
    bad = plan_backtest(codes=["600519.SH", "AAPL"], start="2021-01-01", end="2025-12-31", style="long")
    with pytest.raises(ValueError, match="闸口拒绝"):
        run(bad, object())


def test_missing_only_counts_symbols_the_user_asked_for():
    """同一个 loader 实例还会被 benchmark 那条路用到（base.py 一起传过去）。
    不过滤的话，基准取数失败会被写成「你的某只标的没参与回测」。"""
    import backtest.run as RUN

    class FakeLoader:
        failures = {"600519.SH": "真失败", "SPY": "基准没取到"}
        provenance = {"600519.SH": SymbolProvenance(code="600519.SH", market="a_share",
                                                    endpoint="x", rows=1),
                      "SPY": SymbolProvenance(code="SPY", market="us_equity", endpoint="y", rows=1)}
        def __init__(self, *a, **k): pass

    class FakeEngine:
        def __init__(self, cfg): pass
        def run_backtest(self, **kw): return dict(BASE)

    RUN.VibeLoader = FakeLoader
    RUN.ENGINES = {**RUN.ENGINES, "ChinaAEngine": FakeEngine}
    try:
        r = run(PLAN, object())
    finally:
        import importlib
        importlib.reload(RUN)
    assert set(r.missing) == {"600519.SH"}, "基准的失败不该算成用户标的的失败"
    assert set(r.provenance) == {"600519.SH"}


# ── 运行期守卫（Codex 审计 r2 指出的两条 P1）──

def _guard(codes=("600519.SH",), style="long", allow_short=False, inner=None):
    from backtest.run import _Guarded
    plan = plan_backtest(codes=list(codes), start="2021-01-01", end="2025-12-31",
                         style=style, allow_short=allow_short)
    return _Guarded(inner or _Flat(), plan)


class _Flat:
    name = "全仓不动"
    def generate(self, dm):
        return {c: pd.Series(1.0, index=df.index) for c, df in dm.items()}


class _Shorting:
    name = "会做空的策略"
    def generate(self, dm):
        return {c: pd.Series(-1.0, index=df.index) for c, df in dm.items()}


def _frames(n, codes=("600519.SH",)):
    idx = pd.date_range("2021-01-04", periods=n, freq="B").astype("datetime64[ns]")
    return {c: pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0},
                            index=idx) for c in codes}


def test_guard_refuses_when_actual_bars_fall_short():
    """闸口按日历估算放行，实际数据可能远少于估算（次新股 / 长期停牌）。
    这时报告仍会写着「长线」，而它跑在几十根 bar 上。"""
    from backtest.run import BacktestNotValid
    with pytest.raises(BacktestNotValid, match="480"):
        _guard().generate(_frames(40))


def test_guard_passes_when_bars_suffice():
    assert _guard().generate(_frames(600))


def test_guard_flags_any_symbol_below_the_style_minimum():
    """判据与整体用**同一个门槛**（长线 480 根）。

    ⚠️ 第一版写的是「不足最长的一半才提示」——那是自己发明的门槛，留了洞：
       A 600 根、B 400 根时，整体过关、B 也够不上一半线，于是 B 带着不足的历史
       参与回测而报告一个字都不说。这条测的就是那个洞。
    """
    g = _guard(codes=("600519.SH", "300308.SZ"))
    dm = _frames(600, ("600519.SH",))
    dm.update(_frames(400, ("300308.SZ",)))     # 400 > 600 的一半，但 < 480
    g.generate(dm)
    assert "300308.SZ" in g.note and "400 根" in g.note
    assert "600519.SH" not in g.note, "够数的那只不该被点名"


def test_guard_says_nothing_when_every_symbol_has_enough():
    g = _guard(codes=("600519.SH", "300308.SZ"))
    dm = _frames(600, ("600519.SH",)); dm.update(_frames(520, ("300308.SZ",)))
    g.generate(dm)
    assert g.note == ""


def test_guard_aborts_on_short_signals_in_a_no_short_market():
    """引擎会把做空单**静默拒掉**，报告描述的就成了另一个策略。"""
    from backtest.run import BacktestNotValid
    with pytest.raises(BacktestNotValid, match="做空"):
        _guard(inner=_Shorting()).generate(_frames(600))


def test_guard_allows_shorts_where_the_market_allows_them():
    """对照组：美股允许做空，同样的策略必须放行 ——
    否则「拦住了」这个结论证明不了是市场规则在起作用。"""
    assert _guard(codes=("AAPL",), allow_short=True, inner=_Shorting()).generate(_frames(600, ("AAPL",)))


def test_guard_refuses_an_empty_data_map():
    from backtest.run import BacktestNotValid
    with pytest.raises(BacktestNotValid, match="一只标的的数据都没取到"):
        _guard().generate({})


def test_short_check_keyed_on_market_not_on_the_callers_declaration():
    """判据只看市场。

    ⛔ 带上 `and not allow_short` 会留洞：手搓 Plan 绕过闸口时，
       (A股 + allow_short=True) 会跳过检查、做空单被引擎静默拒掉。
    ⛔ 改成 `or` 又会误杀「美股 + 调用方没声明」—— 美股本来就能做空，没有静默丢弃。
    """
    import dataclasses
    from backtest.run import BacktestNotValid, _Guarded
    p = plan_backtest(codes=["600519.SH"], start="2021-01-01", end="2025-12-31", style="long")
    forged = dataclasses.replace(p, allow_short=True)      # 手搓出闸口不会产出的组合
    with pytest.raises(BacktestNotValid, match="做空"):
        _Guarded(_Shorting(), forged).generate(_frames(600))
    # 对照：美股 + 没声明做空，必须放行
    us = plan_backtest(codes=["AAPL"], start="2021-01-01", end="2025-12-31", style="long")
    assert _Guarded(_Shorting(), us).generate(_frames(600, ("AAPL",)))


def test_failed_index_benchmark_is_surfaced_in_notes():
    """日志在服务端 / 界面里对用户不可见 —— 基准没接上必须进结果本身，
    否则报告只是少一行，看起来仍然完整。"""
    import backtest.run as RUN

    class FakeLoader:
        failures, provenance = {}, {}
        def __init__(self, *a, **k): pass

    class FakeEngine:
        def __init__(self, cfg): pass
        def run_backtest(self, **kw): return {**BASE, "benchmark_return": -0.2}   # 没有 benchmark_ticker

    RUN.VibeLoader, RUN.ENGINES = FakeLoader, {**RUN.ENGINES, "ChinaAEngine": FakeEngine}
    base_to_config = type(PLAN).to_config
    try:
        # Plan 是 frozen 的（不可变），只能在类上替换
        type(PLAN).to_config = lambda self: {**base_to_config(self), "benchmark": "000300.SH"}
        r = RUN.run(PLAN, _Flat())
    finally:
        type(PLAN).to_config = base_to_config
        import importlib; importlib.reload(RUN)
    assert any("000300.SH" in n and "没有取到" in n for n in r.notes)


def test_note_does_not_promise_a_comparison_that_will_not_render():
    """声称「下面的对照是…」之前要确认对照那行真的会出现 —— 否则是注释替代码许愿。"""
    import backtest.run as RUN

    class FakeLoader:
        failures, provenance = {}, {}
        def __init__(self, *a, **k): pass

    class NoBench:
        def __init__(self, cfg): pass
        def run_backtest(self, **kw): return dict(BASE)          # 连 benchmark_return 都没有

    RUN.VibeLoader, RUN.ENGINES = FakeLoader, {**RUN.ENGINES, "ChinaAEngine": NoBench}
    base_to_config = type(PLAN).to_config
    try:
        type(PLAN).to_config = lambda self: {**base_to_config(self), "benchmark": "000300.SH"}
        r = RUN.run(PLAN, _Flat())
    finally:
        type(PLAN).to_config = base_to_config
        import importlib; importlib.reload(RUN)
    assert any("没有任何对照" in n for n in r.notes)
    assert not any("下面的对照是" in n for n in r.notes)
    # 说明说「没有对照」，摘要里就真的不能有对照行 —— 两者必须一致
    assert "    对照 " not in r.summary()


def test_tradeless_flat_run_has_undefined_ratios_not_zero():
    """一直空仓：没有平仓交易 ⇒ 胜率无定义；净值不动 ⇒ 夏普、信息比率无定义。都是 None，不是 0。"""
    from backtest.metrics import calc_metrics, win_rate_and_stats
    assert win_rate_and_stats([])["win_rate"] is None
    idx = pd.bdate_range("2021-01-01", periods=30)
    flat = pd.Series([100_000.0] * 30, index=idx)
    bench = pd.Series([0.001, -0.002] * 15, index=idx)
    m = calc_metrics(flat, [], 100_000.0, bench_ret=bench)
    assert m["win_rate"] is None and m["sharpe"] is None
    assert m["information_ratio"] is not None, "相对基准有波动，信息比率算得出"
    m2 = calc_metrics(flat, [], 100_000.0, bench_ret=pd.Series([0.0] * 30, index=idx))
    assert m2["information_ratio"] is None, "和基准完全一样：跟踪误差 0，信息比率无定义"
    assert m2["tracking_error"] == 0.0
    # 审计 D6：没有交易 ⇒ 平均持有期无定义；基准不动（方差 0）⇒ Beta 无定义。都不是 0
    assert m["avg_holding_days"] is None and m2["avg_holding_days"] is None
    assert m2["benchmark_beta"] is None
    assert m["benchmark_beta"] == 0.0, "基准有波动、组合不动：协方差 0，Beta 真的是 0"
    assert calc_metrics(flat, [], 100_000.0)["benchmark_beta"] is None, "没有基准"
