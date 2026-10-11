"""引擎的市场规则测试 —— **不联网**，用构造出来的行情把每条规则单独逼出来。

搬引擎的全部理由就是这些规则（T+1 / 涨跌停 / 整手 / 印花税）。
只跑一遍真实回测证明不了它们在起作用 —— 真实数据里这些条件很少同时出现，
出现了也看不出是哪条生效。所以这里一条一条造场景。
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
from pathlib import Path

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest.engines.china_a import ChinaAEngine, _price_limit  # noqa: E402
from backtest.engines.global_equity import GlobalEquityEngine  # noqa: E402


def frame(closes, opens=None, pre=None):
    """造一段日线。索引一律 datetime64[ns] —— 与取数层出口同口径。"""
    idx = pd.date_range("2024-01-02", periods=len(closes), freq="B").astype("datetime64[ns]")
    o = opens if opens is not None else closes
    df = pd.DataFrame({"open": o, "high": [max(a, b) for a, b in zip(o, closes)],
                       "low": [min(a, b) for a, b in zip(o, closes)],
                       "close": closes, "volume": [1e7] * len(closes)}, index=idx)
    if pre is not None:
        df["pre_close"] = pre
    return df


class FrameLoader:
    """把现成的 DataFrame 直接喂进去 —— 引擎那条缝只要 fetch()。"""
    name = "test"

    def __init__(self, frames): self.frames = frames
    def fetch(self, codes, start, end, fields=None, interval="1D"):
        return {c: self.frames[c] for c in codes if c in self.frames}


class Signals:
    def __init__(self, sig): self.sig = sig
    def generate(self, data_map): return self.sig


def run_engine(engine, frames, signals, cash=1_000_000.0, adjustment="rebalance"):
    cfg = {"codes": list(frames), "initial_cash": cash, "start_date": "2024-01-02",
           "end_date": "2025-12-31", "interval": "1D", "position_adjustment": adjustment}
    eng = engine({**cfg})
    with contextlib.redirect_stdout(io.StringIO()):   # 引擎会往 stdout 打 metrics JSON
        m = eng.run_backtest(config=cfg, loader=FrameLoader(frames), signal_engine=Signals(signals),
                             run_dir=Path(tempfile.mkdtemp()), bars_per_year=252)
    return eng, m


# ── T+1 ──

@pytest.mark.parametrize("adjustment", ["hold", "rebalance"])
@pytest.mark.parametrize("weight", [0.0, 0.5])
def test_execution_fee_metrics_match_fills_and_cash(adjustment, weight):
    df = frame([100.0] * 8)
    eng, metrics = run_engine(
        ChinaAEngine, {"600519.SH": df},
        {"600519.SH": pd.Series(weight, index=df.index)},
        adjustment=adjustment,
    )
    fees = sum(fill.fee for fill in eng.fill_records)
    assert metrics["execution_fees"] == pytest.approx(fees)
    assert metrics["fill_count"] == len(eng.fill_records)
    if weight:
        assert fees > 0 and metrics["fill_count"] >= 2
        # Constant prices: realized price P&L minus actual execution fees
        # must reconcile to terminal cash, including forced liquidation.
        pnl = sum(trade.pnl for trade in eng.trades)
        assert eng.capital == pytest.approx(1_000_000 + pnl - fees)
    else:
        assert fees == 0 and metrics["fill_count"] == 0

@pytest.mark.parametrize("adjustment", ["hold", "rebalance"])
@pytest.mark.parametrize("operation", ["open", "close"])
def test_execution_errors_abort_instead_of_emitting_success(adjustment, operation):
    class BrokenEngine(GlobalEquityEngine):
        def _plan_open_order(self, *args, **kwargs):
            if operation == "open":
                raise ValueError("synthetic execution failure")
            return super()._plan_open_order(*args, **kwargs)

        def _close_position(self, *args, **kwargs):
            if operation == "close":
                raise ValueError("synthetic execution failure")
            return super()._close_position(*args, **kwargs)

    df = frame([100.] * 6)
    sig = pd.Series([1., 1., 0., 0., 0., 0.], index=df.index)
    with pytest.raises(ValueError, match="synthetic execution failure"):
        run_engine(BrokenEngine, {"AAPL": df}, {"AAPL": sig}, adjustment=adjustment)

def test_default_benchmark_holds_initial_equal_shares_without_daily_rebalancing():
    a, b = frame([100., 200., 100.]), frame([100., 100., 100.])
    _, metrics = run_engine(GlobalEquityEngine, {"A": a, "B": b},
                            {"A": pd.Series(0., index=a.index), "B": pd.Series(0., index=b.index)})
    assert metrics["benchmark_return"] == pytest.approx(0), "daily rebalancing incorrectly yields 12.5%"


def test_a_share_cannot_sell_on_the_day_it_bought():
    """信号第 2 天叫买、第 3 天叫卖。买入在第 3 天开盘成交（信号后移一根），
    卖出信号落在第 4 天开盘 —— 这里验的是引擎**不会**把两者压到同一天。"""
    px = [100.0] * 8
    df = frame(px)
    sig = pd.Series([0, 1, 0, 0, 0, 0, 0, 0], index=df.index, dtype=float)
    eng, _ = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig})
    entries = [t for t in eng.trades]
    assert entries, "应当有一笔完整交易"
    t = entries[0]
    assert t.entry_time.date() != t.exit_time.date(), "A股 T+1：买入与卖出不能在同一天"


def test_us_may_round_trip_same_day():
    """对照组：美股 T+0。同样的信号，规则不同结论就该不同 ——
    否则"T+1 生效了"这个结论其实没被证明（可能只是信号本来就跨天）。"""
    eng = GlobalEquityEngine({"initial_cash": 1e6})
    bar = pd.Series({"open": 100.0, "close": 100.0})
    assert eng.can_execute("AAPL", 1, bar) is True


# ── 整手 ──

@pytest.mark.parametrize("raw,expect", [(1234.0, 1200), (99.0, 0), (100.0, 100), (250.5, 200)])
def test_a_share_rounds_down_to_100_lots(raw, expect):
    assert ChinaAEngine({}).round_size(raw, 10.0) == expect


def test_us_allows_fractional_shares():
    assert GlobalEquityEngine({}).round_size(1234.56, 10.0) > 1234


def test_us_fractional_sizing_never_exceeds_target():
    assert GlobalEquityEngine({}).round_size(123.456, 10.0) == 123.45


@pytest.mark.parametrize("market,code,price", [
    ("us", "AAPL", 123.456), ("hk", "00700.HK", 100.0),
    ("cn", "600519.SH", 100.0),
])
def test_full_target_reserves_real_fees_without_negative_cash(market, code, price):
    df = frame([price] * 8)
    sig = pd.Series([1.0] * 8, index=df.index)
    engine = (lambda cfg: ChinaAEngine({**cfg, "slippage": 0})) if market == "cn" else (
        lambda cfg: GlobalEquityEngine({**cfg, "slippage_hk": 0, "slippage_us": 0}, market))
    eng, _ = run_engine(engine, {code: df}, {code: sig}, cash=100_000)
    assert eng.fill_records
    assert all(s.capital >= -1e-8 for s in eng.equity_snapshots)
    assert eng.capital <= 100_000, "恒定行情不能因忽略费用而产生收益"


def test_fee_budget_is_shared_by_basket_not_symbol_order():
    df = frame([100.0] * 6)
    sig = pd.Series([0.5] * 6, index=df.index)
    filled = []
    for codes in [("A", "B"), ("B", "A")]:
        eng, _ = run_engine(lambda cfg: GlobalEquityEngine({**cfg, "slippage_hk": 0}, "hk"),
                            {c: df for c in codes}, {c: sig for c in codes}, cash=100_000)
        first = {f.symbol: f.signed_quantity for f in eng.fill_records if f.bar_idx == 1}
        assert first["A"] == first["B"]
        filled.append(first)
    assert filled[0] == filled[1]


# ── 费用：印花税只在卖出 ──

def test_stamp_tax_only_on_sell():
    eng = ChinaAEngine({})
    size, price = 10_000, 100.0
    buy = eng.calc_commission(size, price, 1, is_open=True)
    sell = eng.calc_commission(size, price, -1, is_open=False)
    notional = size * price
    assert sell - buy == pytest.approx(notional * 0.0005, rel=1e-9), "卖出应恰好多一道万5 印花税"


def test_commission_floor_of_five_yuan():
    """小额交易按最低 5 元收 —— 不设下限的话，小资金高频回测的费用会被系统性低估。"""
    eng = ChinaAEngine({})
    assert eng.calc_commission(100, 1.0, 1, is_open=True) >= 5.0


# ── 涨跌停 ──

@pytest.mark.parametrize("code,limit", [
    ("600519.SH", 0.10), ("000001.SZ", 0.10), ("300308.SZ", 0.20),
    ("688981.SH", 0.20), ("689009.SH", 0.20), ("830799.BJ", 0.30),
    ("301001.SZ", 0.20), ("302001.SZ", 0.20), ("430047.BJ", 0.30), ("920001.BJ", 0.30),
])
def test_price_limit_by_board(code, limit):
    assert _price_limit(code) == limit


@pytest.mark.parametrize("code,day,opening,allowed", [
    ("300308.SZ", "2020-08-21", 115, False),
    ("300308.SZ", "2020-08-24", 115, True),
    ("301001.SZ", "2025-01-02", 115, True),
    ("301001.SZ", "2025-01-02", 120, False),
    ("430047.BJ", "2025-01-02", 125, True),
    ("920001.BJ", "2025-01-02", 130, False),
])
def test_actual_fill_uses_board_and_historical_date(code, day, opening, allowed):
    bar = pd.Series({"open": opening, "close": opening, "pre_close": 100}, name=pd.Timestamp(day))
    assert ChinaAEngine({"slippage": 0}).can_execute(code, 1, bar) is allowed


def test_limit_up_bar_blocks_the_buy():
    """开盘就一字涨停（开=前收×1.1）时买不进去。
    ⚠️ 判据用**前收**，不是当日收盘 —— 用收盘判就是未来函数。"""
    eng = ChinaAEngine({})
    bar = pd.Series({"open": 110.0, "close": 110.0, "pre_close": 100.0})
    assert eng.can_execute("600519.SH", 1, bar) is False, "涨停封死应当买不进"
    normal = pd.Series({"open": 101.0, "close": 110.0, "pre_close": 100.0})
    # 开盘没封死、只是收盘涨停 —— 这一档必须能成交，否则就是拿收盘价做决策
    assert eng.can_execute("600519.SH", 1, normal) is True


def _raw_bar(raw_open, raw_pre, scale=1.0):
    """前复权价 = 不复权价 × scale；涨跌停只能按不复权价算（交易所四舍五入到分）。"""
    return pd.Series({"open": raw_open * scale, "close": raw_open * scale, "pre_close": raw_pre * scale,
                      "raw_open": raw_open, "raw_pre_close": raw_pre})


@pytest.mark.parametrize("raw_open,raw_pre,direction,cfg,allowed", [
    # 前收 10.04 → 涨停 11.044 四舍五入为 11.04；零滑点开在 11.04 以前低于未取整的带上沿，被当成能买
    (11.04, 10.04, 1, {"slippage": 0}, False),
    # 前收 3.04 → 涨停 3.34；默认滑点下成交价 3.34334 仍低于 3.344，以前照买
    (3.34, 3.04, 1, {}, False),
    # 前收 3.05 → 跌停 2.745 四舍五入为 2.75；一字跌停开在 2.75，以前照卖
    (2.75, 3.05, 0, {}, False),
    (9.04, 10.04, 0, {"slippage": 0}, False),
    # 低一分不算封板；零滑点能成交，默认滑点会越过涨停价 → 不成交（永远不在涨跌停价以外记成交）
    (11.03, 10.04, 1, {"slippage": 0}, True),
    (11.03, 10.04, 1, {}, False),
    (3.33, 3.04, 1, {}, True),
    # 1.15 × 1.1 用浮点是 1.26499…，交易所四舍五入是 1.27：开在 1.26 不是涨停
    (1.26, 1.15, 1, {"slippage": 0}, True),
    (1.27, 1.15, 1, {"slippage": 0}, False),
])
def test_limit_price_follows_exchange_cent_rounding(raw_open, raw_pre, direction, cfg, allowed):
    """第四轮审计 D2：涨跌停价 = 不复权前收 ×(1±限幅) 四舍五入到分，开盘就在涨跌停价视为封板。"""
    eng = ChinaAEngine(cfg)
    for scale in (1.0, 0.37):   # 前复权缩放不影响判定
        assert eng.can_execute("600519.SH", direction, _raw_bar(raw_open, raw_pre, scale)) is allowed, scale


def test_missing_unadjusted_prices_fall_back_to_the_adjusted_band():
    eng = ChinaAEngine({"slippage": 0})
    bar = pd.Series({"open": 110.0, "close": 110.0, "pre_close": 100.0, "raw_open": float("nan"), "raw_pre_close": 50.0})
    assert eng.can_execute("600519.SH", 1, bar) is False
    assert eng.can_execute("600519.SH", 1, bar.drop(["raw_open", "raw_pre_close"]).replace({110.0: 109.0})) is True


def test_zero_cost_rerun_blocks_the_same_locked_limit_up():
    """扣费对照：一字涨停那天，实际那次和不计成本那次都买不进，两次成交笔数一致。"""
    df = frame([10.04, 11.04, 11.20, 11.30], opens=[10.04, 11.04, 11.10, 11.25], pre=[10.0, 10.04, 11.04, 11.20])
    df["raw_open"], df["raw_pre_close"] = df["open"], df["pre_close"]
    sig = {"600000.SH": pd.Series([1.0, 1.0, 1.0, 1.0], index=df.index)}
    from backtest.cost_compare import ZERO_COST
    real, _ = run_engine(ChinaAEngine, {"600000.SH": df}, sig)
    free, _ = run_engine(lambda cfg: ChinaAEngine({**cfg, **ZERO_COST}), {"600000.SH": df}, sig)
    days = lambda e: [str(f.timestamp)[:10] for f in e.fill_records]
    assert days(real) == days(free) and days(real), "封板那天两次都不该成交"
    assert str(df.index[1].date()) not in days(free)


def test_a_share_refuses_short():
    assert ChinaAEngine({}).can_execute("600519.SH", -1, pd.Series({"open": 10.0, "close": 10.0})) is False


# ── 未来函数 ──

def test_signal_is_shifted_by_one_bar():
    """第 1 天就给满仓信号，成交必须落在第 2 天开盘 ——
    若能在第 1 天成交，就是拿当天收盘算出来的信号在当天成交，回测会凭空变好看。"""
    # ⚠️ 涨幅要在涨跌停带以内。第一版这里写了 100 → 200（一天翻倍），
    #    引擎按前收算出带 [90,110] 正确拒了单 —— 是**测试数据不合法**，不是引擎错。
    df = frame([100.0, 103.0, 103.0, 103.0, 103.0])
    sig = pd.Series([1.0, 1.0, 1.0, 1.0, 1.0], index=df.index)
    eng, _ = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig})
    assert eng.fill_records, "应当有成交"
    first = eng.fill_records[0]
    assert first.timestamp.date() == df.index[1].date(), "首笔成交应在第 2 根 bar"
    # 100 → 103 那一段不能被吃到：在第 2 根的价位买入，赚不到这 3%
    assert first.execution_price >= 103.0


def test_limit_band_blocks_an_impossible_gap():
    """上一条的副产品，单独立起来：第 2 根直接翻倍时应当买不进 ——
    这正是「用前收判涨跌停」在起作用的证据。"""
    df = frame([100.0, 200.0, 200.0, 200.0, 200.0])
    sig = pd.Series([1.0, 1.0, 1.0, 1.0, 1.0], index=df.index)
    eng, _ = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig})
    assert not any(f.bar_idx == 1 for f in eng.fill_records), "一字涨停那根不该有成交"


# ── 策略参数校验（Codex 审计 r2 · P2）──

@pytest.mark.parametrize("kw", [dict(fast=0, slow=60), dict(fast=-5, slow=60),
                                dict(fast=20, slow=20), dict(fast=60, slow=20)])
def test_ma_cross_rejects_bad_windows(kw):
    from backtest.strategies import MaCross
    with pytest.raises(ValueError):
        MaCross(**kw)


@pytest.mark.parametrize("kw", [dict(window=0), dict(window=1),
                                dict(buy_below=70, sell_above=30), dict(buy_below=-1),
                                dict(sell_above=101), dict(buy_below=50, sell_above=50)])
def test_rsi_rejects_bad_params(kw):
    """阈值反了不会报错，只会静默生成一个「永不进场」的策略 —— 回测跑完给零成交。"""
    from backtest.strategies import RsiReversion
    with pytest.raises(ValueError):
        RsiReversion(**kw)


# ── 长停牌的估值 ──

def test_long_halt_marks_at_last_close_not_entry_price():
    """A 买入后涨到 110,随后停牌 8 个共同交易日(B 照常交易):停牌期间按 110 估值,
    不能在补齐额度(5 天)用完后退回买入价(Codex 审计 2026-10-09 D3)。"""
    n = 16
    b = frame([100.0] * n)
    a = frame([100.0, 100.0] + [104.0, 108.0, 110.0] + [110.0] * (n - 5))
    halt = a.index[5:13]
    a = a.drop(halt)
    sig_a = pd.Series(0.5, index=b.index)
    sig_b = pd.Series(0.0, index=b.index)
    eng, met = run_engine(lambda cfg: ChinaAEngine({**cfg, "slippage": 0}), {"600519.SH": a, "000001.SZ": b},
                          {"600519.SH": sig_a, "000001.SZ": sig_b})
    eq = {s.timestamp: s.equity for s in eng.equity_snapshots}
    before = eq[a.index[4]]
    during = [eq[t] for t in halt]
    assert all(abs(x - before) < 1e-6 for x in during), (before, during)
    pos = eng.positions.get("600519.SH")
    assert pos is None or pos.entry_price < 110, "买入价确实低于停牌前的收盘价,否则测不出退回"
    assert any(f.symbol == "600519.SH" and f.execution_price < 105 for f in eng.fill_records), "确实是在 110 以下买入的"
    # 🔴 沿用旧价的日子要披露(审计第二轮,D3 修复引入):8 天停牌、补齐 5 天 ⇒ 后 3 天按最后收盘价估值
    marks = met["stale_price_marks"]
    assert marks == {"600519.SH": {"from": str(halt[5].date()), "to": str(halt[7].date()), "bars": 3}}, marks
    from backtest.cli import _result_view
    from backtest.run import Result
    from backtest.tests.test_cost_compare import A
    view = _result_view(Result(metrics=met, plan=A, strategy="s", provenance={}, limits=[], notes=[], run_dir=Path("/tmp")))
    assert any("600519.SH" in d and "最后一个收盘价" in d and "3 个交易日" in d for d in view["required_disclosures"])


def test_fees_turn_a_tiny_price_gain_into_a_losing_trade(tmp_path):
    """价差赚一点、手续费更多：这笔交易是亏的。胜率、期望、分股票盈亏、
    写进 trades.csv 再读回（蒙特卡洛 / 分段检验用）都要按扣费后的盈亏算（审计 D4）。"""
    from backtest.metrics import net_pnl
    from backtest.validation import _load_trades
    df = frame([100.0, 100.0, 100.01, 100.01, 100.01, 100.01])
    sig = pd.Series([1., 1., 1., 0., 0., 0.], index=df.index)
    cfg = {"codes": ["600519.SH"], "initial_cash": 1_000_000.0, "start_date": "2024-01-02",
           "end_date": "2025-12-31", "interval": "1D", "position_adjustment": "rebalance", "slippage": 0}
    eng = ChinaAEngine({**cfg})
    with contextlib.redirect_stdout(io.StringIO()):
        m = eng.run_backtest(config=cfg, loader=FrameLoader({"600519.SH": df}), signal_engine=Signals({"600519.SH": sig}),
                             run_dir=tmp_path, bars_per_year=252)
    assert len(eng.trades) == 1
    t = eng.trades[0]
    assert 0 < t.pnl < t.commission, "前提：价差赚钱、手续费更多"
    assert m["win_rate"] == 0.0 and m["max_consecutive_loss"] == 1
    assert m["expectancy"] == pytest.approx(t.pnl - t.commission) and m["expectancy"] < 0
    assert m["expectancy_pct"] < 0 and m["largest_win"] is None and m["largest_loss"] < 0
    assert m["by_symbol"]["600519.SH"]["total_pnl"] < 0 and m["by_symbol"]["600519.SH"]["win_rate"] == 0.0
    loaded = _load_trades(tmp_path)
    assert net_pnl(loaded[0]) == pytest.approx(net_pnl(t), abs=1e-3), "trades.csv 读回来也要带上手续费"


def test_base_price_lookup_survives_the_end_of_run_cleanup():
    """一次运行结束时引擎把收盘价表清成 None：之后再查前收价要走兜底，不能因为 None.get 崩掉（类型检查发现）。"""
    eng = ChinaAEngine({})
    eng._close_arr = None
    eng._code_to_col = None
    assert eng.historical_base_price("600519.SH", pd.Series({"close": 10.0})) is None
    assert eng.historical_base_price("600519.SH", pd.Series({"close": 11.0, "pct_chg": 10.0})) == pytest.approx(10.0)


# ── 期末结算（审计 D2）：卖不出去的不编一笔成交 ──

def _end_fills(eng):
    return [f for f in eng.fill_records if f.reason == "end_of_backtest"]


def _view(met):
    from backtest.cli import _result_view
    from backtest.run import Result
    from backtest.tests.test_cost_compare import A
    return _result_view(Result(metrics=met, plan=A, strategy="s", provenance={}, limits=[], notes=[], run_dir=Path("/tmp")))


def test_bought_on_the_last_day_is_held_at_close_not_sold():
    """最后一天开盘才买进的（T+1 当天不能卖）：不记卖出、不扣卖出费用，按收盘价留在期末净值里并点名。"""
    df = frame([100.0] * 5 + [101.0], opens=[100.0] * 6)
    sig = pd.Series([0, 0, 0, 0, 1, 1], index=df.index, dtype=float)
    eng, met = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig}, adjustment="hold")
    pos = eng.positions["600000.SH"]
    assert pos.entry_time.date() == df.index[-1].date(), "确实是最后一天买的"
    assert not _end_fills(eng) and not eng.trades
    assert met["unsettled_positions"] == {"600000.SH": "最后一天才买入，按 T+1 当天不能卖"}
    last = eng.equity_snapshots[-1]
    assert last.positions == 1
    assert last.equity == pytest.approx(eng.capital + pos.size * 101.0)
    assert eng.actual_position_snapshots[-1][1]["600000.SH"] > 0
    lines = [d for d in _view(met)["required_disclosures"] if d.startswith("回测最后一天有")]
    assert len(lines) == 1 and "600000.SH" in lines[0] and "T+1" in lines[0], lines


def test_increase_on_the_last_day_only_sells_the_shares_held_before():
    """调仓模式下最后一天加仓：原有部分照常按收盘价平掉，当天加仓买进的按 T+1 留着、按收盘价计入净值并点名
    （v2.2.0 审计 Codex 第 3 条：加仓保留首次买入日，原来整笔连新买的一起编成卖出）。"""
    df = frame([100.0] * 6, opens=[100.0] * 6)
    sig = pd.Series([0.2, 0.2, 0.2, 0.2, 0.8, 0.8], index=df.index)
    eng, met = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig}, adjustment="rebalance")
    (inc,) = [f for f in eng.fill_records if f.action == "increase" and f.timestamp == df.index[-1]]
    added = abs(inc.signed_quantity)
    (sold,) = _end_fills(eng)
    assert sold.action == "reduce"
    held_before = abs(sold.signed_quantity)
    assert held_before > 0 and added > 0
    pos = eng.positions["600000.SH"]
    assert pos.size == pytest.approx(added), "留下的正好是当天加仓的股数"
    assert met["unsettled_positions"] == {"600000.SH": "最后一天加仓买进的部分按 T+1 当天不能卖（原有部分已按收盘价平掉）"}
    (trade,) = [t for t in eng.trades if t.exit_reason == "end_of_backtest"]
    assert trade.size == pytest.approx(held_before)
    last = eng.equity_snapshots[-1]
    assert last.positions == 1 and last.equity == pytest.approx(eng.capital + added * 100.0)
    lines = [d for d in _view(met)["required_disclosures"] if d.startswith("回测最后一天有")]
    assert len(lines) == 1 and "600000.SH" in lines[0] and "T+1" in lines[0], lines


@pytest.mark.parametrize("last_close, held", [(90.0, True), (90.5, False)])
def test_limit_down_close_on_the_last_day_is_not_sold(last_close, held):
    """最后一天收盘封在跌停价（前收 100 × 0.9）：卖不出去；高出跌停价一截则照常按收盘平仓。"""
    df = frame([100.0] * 5 + [last_close], opens=[100.0] * 5 + [95.0])
    sig = pd.Series(1.0, index=df.index)
    eng, met = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig}, adjustment="hold")
    if held:
        assert met["unsettled_positions"] == {"600000.SH": "最后一天收盘跌停，卖不出去"}
        assert not _end_fills(eng) and "600000.SH" in eng.positions
        assert eng.equity_snapshots[-1].equity == pytest.approx(eng.capital + eng.positions["600000.SH"].size * last_close)
    else:
        assert "unsettled_positions" not in met and not eng.positions
        (fill,) = _end_fills(eng)
        assert fill.execution_price == pytest.approx(last_close * (1 - 0.001))
        assert eng.equity_snapshots[-1].equity == pytest.approx(eng.capital)
        assert eng.equity_snapshots[-1].positions == 0


@pytest.mark.parametrize("with_raw, held", [(True, True), (False, False)])
def test_limit_down_close_uses_the_exchange_cent_band(with_raw, held):
    """低价股：不复权前收 1.15 × 0.9 = 1.035，交易所四舍五入到 1.04；收盘 1.04 就是跌停。
    复权尺度的近似带（0.575 × 0.9 = 0.5175）看不出来 —— 有不复权价时必须按分取整比较。"""
    df = frame([0.575] * 5 + [0.52], opens=[0.575] * 5 + [0.55])
    if with_raw:
        df["raw_open"] = [1.15] * 5 + [1.10]
        df["raw_pre_close"] = [1.15] * 6
    sig = pd.Series(1.0, index=df.index)
    eng, met = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig}, adjustment="hold")
    assert ("600000.SH" in met.get("unsettled_positions", {})) is held
    assert bool(_end_fills(eng)) is not held


def test_no_bar_on_the_last_day_is_held_at_the_last_close():
    """最后一天停牌 / 来源缺行：不按沿用的旧价编一笔卖出；有行情的那只照常平仓（基类默认规则，美股也适用）。"""
    a = frame([100.0] * 6)
    b = frame([50.0] * 5 + [55.0]).iloc[:-1]
    sig = {"AAPL": pd.Series(0.4, index=a.index), "MSFT": pd.Series(0.4, index=a.index)}
    eng, met = run_engine(GlobalEquityEngine, {"AAPL": a, "MSFT": b}, sig, adjustment="hold")
    assert met["unsettled_positions"] == {"MSFT": "最后一天没有行情（停牌或数据源缺行）"}
    assert [f.symbol for f in _end_fills(eng)] == ["AAPL"]
    assert list(eng.positions) == ["MSFT"]
    last = eng.equity_snapshots[-1]
    assert last.timestamp == a.index[-1] and last.positions == 1
    assert last.equity == pytest.approx(eng.capital + eng.positions["MSFT"].size * 50.0)
    weights = eng.actual_position_snapshots[-1][1]
    assert weights["AAPL"] == 0.0 and weights["MSFT"] > 0


def test_unsettled_disclosure_is_one_bounded_line():
    """很多只卖不出去时并成一条（工具披露最多 12 条、每条 500 字以内）。"""
    df = frame([100.0] * 5 + [101.0], opens=[100.0] * 6)
    sig = pd.Series([0, 0, 0, 0, 1, 1], index=df.index, dtype=float)
    _, met = run_engine(ChinaAEngine, {"600000.SH": df}, {"600000.SH": sig}, adjustment="hold")
    met["unsettled_positions"] = {
        **{f"60000{i}.SH": "最后一天才买入，按 T+1 当天不能卖" for i in range(8)},
        **{f"00000{i}.SZ": "最后一天没有行情（停牌或数据源缺行）" for i in range(1, 4)},
    }
    view = _view(met)
    # 披露只列前 5 只，完整清单原样在 metrics 里（v2.1.0 合并审计 Codex 第 3 条）
    assert view["metrics"]["unsettled_positions"] == met["unsettled_positions"]
    disclosures = view["required_disclosures"]
    lines = [d for d in disclosures if d.startswith("回测最后一天有")]
    assert len(lines) == 1 and len(lines[0]) <= 500, lines
    assert "11 只持仓" in lines[0] and "等 8 只" in lines[0] and "000003.SZ" in lines[0]
    assert len(disclosures) <= 12
