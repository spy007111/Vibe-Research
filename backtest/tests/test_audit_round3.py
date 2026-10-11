"""Codex 审计第三轮（2026-10-10）回测那几条的回归测试；不连真实来源。"""
import contextlib
import io
import json

import numpy as np
import pandas as pd
import pytest

from backtest import sensitivity, validation
from backtest.tests.test_portfolio_perf import bdays, only, run, tr


def _artifacts(tmp_path, cash, wiggle=0.0):
    """一份在 cash 上下（wiggle=0 就是全程持平）的净值 + 三笔不赚不亏的交易（带手续费列）。"""
    art = tmp_path / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    pd.Series([float(cash) + wiggle * ((i % 3) - 1) for i in range(60)], index=pd.date_range("2026-01-01", periods=60), name="equity").to_frame().to_csv(art / "equity.csv")
    rows = []
    for d in ("2026-01-05", "2026-01-20", "2026-02-10"):
        rows += [dict(timestamp=d, code="AAPL", side="buy", price=10, qty=2, pnl=0, holding_bars=0, commission=0.0),
                 dict(timestamp=d, code="AAPL", side="sell", price=10, qty=2, pnl=0, holding_bars=1, commission=0.0)]
    pd.DataFrame(rows).to_csv(art / "trades.csv", index=False)


def _main(run_dir):
    with contextlib.redirect_stdout(io.StringIO()):
        return validation.main(run_dir)


def test_d1_standalone_validation_uses_the_runs_own_capital(tmp_path):
    """run() 只写 run_card.json：独立检验要读它记下的 10 万，不能按 100 万把持平算成 −90%。"""
    _artifacts(tmp_path, 100_000)
    (tmp_path / "run_card.json").write_text(json.dumps({"backtest": {"initial_cash": 100_000}}), encoding="utf-8")
    out = _main(tmp_path)
    first = out["walk_forward"]["windows"][0]
    assert first["return"] == 0 and first["max_dd"] == 0, first
    assert out["monte_carlo"]["actual_max_dd"] == 0
    # 有 config.json 时以它为准（引擎读的就是它）
    (tmp_path / "config.json").write_text(json.dumps({"initial_cash": 100_000}), encoding="utf-8")
    assert _main(tmp_path)["walk_forward"]["windows"][0]["return"] == 0


@pytest.mark.parametrize("card", [None, {"backtest": {}}, {"backtest": {"initial_cash": 0}},
                                  {"backtest": {"initial_cash": "abc"}}, {"backtest": {"initial_cash": True}}])
def test_d1_unknown_capital_is_refused_not_guessed(tmp_path, card):
    _artifacts(tmp_path, 100_000, wiggle=500)
    if card is not None:
        (tmp_path / "run_card.json").write_text(json.dumps(card), encoding="utf-8")
    out = _main(tmp_path)
    assert "初始资金" in out["monte_carlo"]["error"] and out["monte_carlo"]["p_value_sharpe"] is None
    assert "初始资金" in out["walk_forward"]["error"]
    assert "error" not in out["bootstrap"], "只看净值的那项不需要本金，照算"


def test_d3_first_trade_loss_counts_in_drawdown_and_returns():
    m = validation._path_metrics(np.array([-20_000.0, 10_000.0, 10_000.0]), 100_000.0)
    assert m["max_dd"] == pytest.approx(-0.2)
    # 三步收益 −20%、+12.5%、+11.1%：第一步也在里面，均值不是只看后两步的正数
    r = np.array([-0.2, 10_000 / 80_000, 10_000 / 90_000])
    assert m["sharpe"] == pytest.approx(r.mean() / (r.std() + 1e-10) * np.sqrt(252))


def test_d6_grid_keeps_the_users_own_small_ma_params():
    xk, xs, yk, ys, _ = sensitivity._axes("ma_cross", {"fast": 1, "slow": 2})
    assert (xk, yk) == ("fast", "slow")
    assert 1 in xs and 2 in ys, (xs, ys)
    n_axis = sensitivity._axes("rsrs", {"n": 2, "threshold": 0.7})[1]
    assert 2 in n_axis
    # 常用范围里的参数不受影响
    assert sensitivity._axes("ma_cross", {"fast": 20, "slow": 60})[1] == [10, 13, 17, 20, 25, 30, 40]


def test_d2_held_symbol_with_stale_quotes_is_flagged(monkeypatch, tmp_path):
    days = bdays("2026-03-02", "2026-03-31")
    series = {"AAPL": {days[0]: 100}, "MSFT": dict.fromkeys(days, 100)}
    trades = [tr("AAPL", "buy", days[0], shares=10, price=100, name="苹果"), tr("MSFT", "buy", days[0], shares=10, price=100)]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1]))
    assert g["stale_prices"] == [{"symbol": "AAPL", "last_price_date": days[0], "trading_days_after": len(days) - 1,
                                  "weekdays_after": len(days) - 1}]
    w = [x for x in g["warnings"] if "只取到" in x]
    assert len(w) == 1 and "苹果" in w[0] and days[0] in w[0] and "不确定" in w[0]
    assert "1000" not in w[0], "只说日期和天数，不说金额（隐私模式遮不到提醒文字）"


def test_r4_d1_whole_group_quotes_stopped_is_flagged(monkeypatch, tmp_path):
    """第四轮审计 D1：只有一只、报价只到 3 月 2 日，3 月 31 日又到了一笔分红。计算日期只有两天，
    按交易日数只差 1 天；按工作日数到截止日差 21 天 —— 要提醒期末价格不确定。"""
    days = bdays("2026-03-02", "2026-03-31")
    trades = [tr("AAPL", "buy", days[0], shares=10, price=100, name="苹果"),
              {**tr("AAPL", "dividend", days[-1]), "amount": 10.0}]
    g = only(run(monkeypatch, tmp_path, trades, {"AAPL": {days[0]: 100}}, days[-1]))
    assert g["stale_prices"] == [{"symbol": "AAPL", "last_price_date": days[0], "trading_days_after": 1, "weekdays_after": len(days) - 1}]
    assert any("只取到" in x and "不确定" in x for x in g["warnings"])
    # 没有分红、报价也一起停：区间只算到最后一个价格那天，照样要提醒
    g2 = only(run(monkeypatch, tmp_path, trades[:1], {"AAPL": {days[0]: 100}}, days[-1]))
    assert [x["symbol"] for x in g2["stale_prices"]] == ["AAPL"]


def test_r4_d1_holiday_gap_is_not_flagged(monkeypatch, tmp_path):
    """国庆休市：9 月 30 日之后 10 月 8 日盘中还没有新价格，6 个工作日不算断。"""
    trades = [tr("600519", "buy", "2026-09-30", shares=100, price=100)]
    g = only(run(monkeypatch, tmp_path, trades, {"600519.SH": {"2026-09-30": 100}}, "2026-10-08"))
    assert g["stale_prices"] == []


def test_d2_short_suspension_and_sold_out_symbols_are_not_flagged(monkeypatch, tmp_path):
    days = bdays("2026-03-02", "2026-03-31")
    # AAPL 断了 5 个交易日（不超过上限）；MSFT 断得早但已经卖光
    series = {"AAPL": dict.fromkeys(days[:-5], 100), "MSFT": dict.fromkeys(days[:3], 100), "NVDA": dict.fromkeys(days, 100)}
    trades = [tr("AAPL", "buy", days[0], shares=10, price=100), tr("MSFT", "buy", days[0], shares=10, price=100),
              tr("MSFT", "sell", days[2], shares=10, price=100), tr("NVDA", "buy", days[0], shares=1, price=100)]
    g = only(run(monkeypatch, tmp_path, trades, series, days[-1]))
    assert g["stale_prices"] == []
    assert not any("只取到" in x for x in g["warnings"])


def test_flat_trades_leave_sharpe_and_its_p_value_unknown(tmp_path):
    """Codex 审计 2026-10-11 4.6：三笔不赚不亏 → 收益没有波动，夏普无定义；不能输出 0 再配一个 p 值。"""
    _artifacts(tmp_path, 100_000)
    (tmp_path / "run_card.json").write_text(json.dumps({"backtest": {"initial_cash": 100_000}}), encoding="utf-8")
    mc = _main(tmp_path)["monte_carlo"]
    assert mc["actual_sharpe"] is None and mc["p_value_sharpe"] is None, mc
    assert mc["n_sharpe_defined"] == 0 and mc["sharpe_samples"] == [] and mc["simulated_sharpe_mean"] is None
    assert mc["actual_max_dd"] == 0 and mc["p_value_max_dd"] is not None, "回撤照常算"
    # 太少的交易：没检验就是不知道，不给 1.0
    assert validation.monte_carlo_test([], 100_000)["p_value_sharpe"] is None
    # 有波动的路径照常：有效样本 = 模拟次数，p 值分母跟着有效样本走
    live = validation.monte_carlo_test([type("T", (), {"pnl": x})() for x in [1_000, -500, 2_000]], 100_000, n_simulations=50)
    assert live["actual_sharpe"] is not None and live["n_sharpe_defined"] == 50
    assert 0 < live["p_value_sharpe"] <= 1


def test_sharpe_undefined_paths_are_left_out_of_the_permutation_sample():
    """每笔都赚 1%（复利等比）收益恒定，夏普同样无定义；打乱顺序后的路径有波动，可以算。"""
    trades = lambda xs: [type("T", (), {"pnl": x})() for x in xs]
    steady = validation.monte_carlo_test(trades([1_000, 1_010, 1_020.1]), 100_000, n_simulations=60)
    assert steady["actual_sharpe"] is None and steady["p_value_sharpe"] is None, "实际夏普无定义就不给 p 值"
    assert 0 < steady["n_sharpe_defined"] < 60
    # 实际有定义、部分模拟路径无定义：分母是有效样本，不是模拟次数
    mixed = validation.monte_carlo_test(trades([1_010, 1_000, 1_020.1]), 100_000, n_simulations=60)
    n = mixed["n_sharpe_defined"]
    assert 0 < n < 60 and len(mixed["sharpe_samples"]) == n
    # p = (胜过次数 + 1) / (有效样本 + 1)：乘回分母应是整数（按 61 算就不是）
    k = mixed["p_value_sharpe"] * (n + 1)
    assert k == pytest.approx(round(k)) and 1 <= round(k) <= n + 1, (mixed["p_value_sharpe"], n)
    assert mixed["p_value_sharpe"] * 61 != pytest.approx(round(mixed["p_value_sharpe"] * 61))
