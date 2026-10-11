"""Regressions for independently reported M31 edge cases; no live sources."""
from types import SimpleNamespace

import pandas as pd
import pytest

from backtest.cli import _public_error
from backtest import validation
from datasources.health import endpoint_env


def test_health_only_passes_endpoint_credentials(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-private")
    monkeypatch.setenv("CODEX_HOME", "/test/private")
    monkeypatch.setenv("IWENCAI_API_KEY", "test-endpoint")
    assert "OPENAI_API_KEY" not in endpoint_env({})
    assert "CODEX_HOME" not in endpoint_env({})
    assert "IWENCAI_API_KEY" not in endpoint_env({})
    assert endpoint_env({"auth_env": "IWENCAI_API_KEY"})["IWENCAI_API_KEY"] == "test-endpoint"


def test_actionable_error_without_local_path_or_token():
    result = _public_error(ValueError("端点超时 /Users/test/private/file.json token=test-secret"))
    assert "端点超时" in result
    assert "/Users" not in result and "test-secret" not in result


def test_zero_pnl_trade_retains_entry_and_intraday_time(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    pd.DataFrame([
        dict(timestamp="2026-01-02 10:00:00", code="AAPL", side="buy", price=10, qty=2, pnl=0, holding_bars=0, commission=0.0),
        dict(timestamp="2026-01-02 11:00:00", code="AAPL", side="sell", price=10, qty=2, pnl=0, holding_bars=4, commission=0.0),
    ]).to_csv(artifacts / "trades.csv", index=False)
    trade, = validation._load_trades(tmp_path)
    assert trade.pnl == 0 and trade.entry_price == 10
    assert trade.exit_time - trade.entry_time == pd.Timedelta(hours=1)
    assert trade.holding_bars == 4


def test_trades_csv_fee_unknown_is_not_zero(tmp_path):
    """审计第二轮 D4：旧版 trades.csv 没有手续费列 → 拒绝交易统计、说明原因，夏普区间照算；
    手续费空着 / 不是数字 / 负数 → 文件数据错，不当 0。"""
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    pd.Series([1e6 + i for i in range(40)], index=pd.date_range("2026-01-01", periods=40), name="equity").to_frame().to_csv(artifacts / "equity.csv")
    rows = [dict(timestamp="2026-01-02", code="AAPL", side="buy", price=10, qty=2, pnl=0, holding_bars=0),
            dict(timestamp="2026-01-05", code="AAPL", side="sell", price=10.5, qty=2, pnl=1.0, holding_bars=2)]
    pd.DataFrame(rows * 3).to_csv(artifacts / "trades.csv", index=False)
    with pytest.raises(validation.TradesWithoutFees, match="重新跑"):
        validation._load_trades(tmp_path)
    import contextlib, io
    with contextlib.redirect_stdout(io.StringIO()):
        out = validation.main(tmp_path)
    assert "重新跑" in out["monte_carlo"]["error"] and "重新跑" in out["walk_forward"]["error"]
    assert "error" not in out["bootstrap"], "只看净值的那项照算"
    for bad in ("", "abc", -1):
        pd.DataFrame([{**r, "commission": 0.0 if r["side"] == "buy" else bad} for r in rows]).to_csv(artifacts / "trades.csv", index=False)
        with pytest.raises(ValueError, match="第 3 行的手续费不对"):
            validation._load_trades(tmp_path)


def test_permutation_p_value_cannot_be_zero(monkeypatch):
    calls = 0
    def metrics(*args):
        nonlocal calls
        calls += 1
        return {"sharpe": 100 if calls == 1 else 0, "max_dd": 0 if calls == 1 else -1}
    monkeypatch.setattr(validation, "_path_metrics", metrics)
    result = validation.monte_carlo_test([SimpleNamespace(pnl=x) for x in [1, -1, 2]], 100, n_simulations=9)
    assert result["p_value_sharpe"] == pytest.approx(0.1)
    assert result["p_value_max_dd"] == pytest.approx(0.1)
