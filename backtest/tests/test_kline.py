"""个股 K 线工具：复权换算、成交量单位、均线、北交所与代码核对、Yahoo 周期线的日期与重复行。"""
from __future__ import annotations

import io
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import kline as K  # noqa: E402


def _days(n, start=date(2025, 12, 1)):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _tx_rows(code="sh600519", n=70, adjust="none"):
    return [{"code": code, "adjust": adjust, "date": d, "open": 100.0 + i, "high": 102.0 + i, "low": 99.0 + i,
             "close": 101.0 + i, "volume": 1000.0 + i} for i, d in enumerate(_days(n))]


def _fake_fetch(calls, *, rows=None, unit="手", factors=None, factor_status="ok", yahoo=None):
    """按端点写一份 raw 文件并返回信封，记下每次调用的参数。"""
    def fake(endpoint, symbol, args, out_dir, python, timeout):
        calls.append((endpoint, symbol, dict(args)))
        raw = Path(out_dir) / "raw"
        raw.mkdir(parents=True, exist_ok=True)
        if endpoint == "tx_kline":
            (raw / "extracted_tx.json").write_text(json.dumps({"rows": rows if rows is not None else _tx_rows()}))
            return {"status": "ok", "fetched_at": "2026-10-08T15:31:00+08:00",
                    "evidence": [{"field": "kline_volume", "unit": unit}],
                    "extra": {"raw_files": ["raw/tencent_page.html", "raw/extracted_tx.json"]}}
        if endpoint == "sina_adjust_factor":
            data = factors if factors is not None else [{"d": "2026-01-05", "f": "1.0"}, {"d": "1900-01-01", "f": "2.0"}]
            (raw / "f.js").write_text("var qfq=" + json.dumps({"total": len(data), "data": data}))
            return {"status": factor_status, "extra": {"raw_files": ["raw/f.js"]}}
        if endpoint == "yahoo_kline":
            (raw / "y.json").write_text(json.dumps(yahoo))
            return {"status": "ok", "fetched_at": "2026-10-08T10:00:00+08:00", "extra": {"raw_files": ["raw/y.json"]}}
        raise AssertionError(f"没想到会调 {endpoint}")
    return fake


def test_a_share_qfq_is_proportional_via_factors_and_volume_in_shares(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch(calls))
    r = K.build({"symbol": "600519", "period": "day", "adjust": "qfq", "charts": True}, tmp_path)
    tx = next(c for c in calls if c[0] == "tx_kline")
    assert tx[1] == "600519.SH" and tx[2]["adjust"] == "", "取腾讯不复权价，复权自己按因子换算"
    assert ("sina_adjust_factor", "600519.SH", {"kind": "qfq"}) in calls
    s = r["ui_only"]["series"]
    i = s["dates"].index("2026-01-05")
    assert s["close"][i - 1] == pytest.approx((101.0 + i - 1) / 2), "除权日之前按因子 2.0 等比折半"
    assert s["close"][i] == pytest.approx(101.0 + i), "除权日起因子 1.0，价格不变"
    assert s["volume"][0] == 100_000, "手 × 100 = 股"
    assert r["volume_unit"] == "股" and r["adjust"] == "qfq" and "等比" in r["adjust_label"]
    assert "新浪复权因子" in r["source"] and r["market_label"] == "A 股"


def test_star_market_volume_is_already_shares(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], rows=_tx_rows("sh688981"), unit="股"))
    r = K.build({"symbol": "688981", "adjust": "none", "charts": True}, tmp_path)
    assert r["ui_only"]["series"]["volume"][0] == 1000, "科创板信封写的是股，不再乘 100"
    assert r["adjust"] == "none" and r["adjust_label"] == "不复权"


def test_unknown_volume_unit_draws_no_volume(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], unit="张"))
    r = K.build({"symbol": "600519", "adjust": "none", "charts": True}, tmp_path)
    assert r["volume_unit"] is None and set(r["ui_only"]["series"]["volume"]) == {None}
    assert any("成交量单位没法确认" in n for n in r["notes"])


def test_moving_averages_and_change(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([]))
    r = K.build({"symbol": "600519", "adjust": "none", "charts": True}, tmp_path)
    s = r["ui_only"]["series"]
    assert s["ma"]["5"][:4] == [None] * 4, "不够 5 根的位置是空，不拿更短的窗口凑"
    assert s["ma"]["5"][4] == pytest.approx(103.0)
    assert s["ma"]["60"][58] is None and s["ma"]["60"][59] == pytest.approx(101.0 + 29.5)
    assert s["change"][0] is None and s["change"][1] == pytest.approx(102 / 101 - 1, abs=1e-6)
    assert r["latest"]["close"] == s["close"][-1] and r["ma_latest"]["5"] == s["ma"]["5"][-1]
    assert r["window_high"] == {"value": s["high"][-1], "date": s["dates"][-1]}
    assert r["window_low"] == {"value": s["low"][0], "date": s["dates"][0]}


def test_beijing_rejected_before_any_fetch(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch(calls))
    with pytest.raises(K.KlineError, match="北交所"):
        K.build({"symbol": "920001"}, tmp_path)
    assert calls == []


def test_wrong_instrument_and_wrong_adjust_are_rejected(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], rows=_tx_rows("sz000001")))
    with pytest.raises(K.KlineError, match="不是同一只"):
        K.build({"symbol": "600519"}, tmp_path)
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], rows=_tx_rows(adjust="qfq")))
    with pytest.raises(K.KlineError, match="不是不复权价"):
        K.build({"symbol": "600519"}, tmp_path)


def test_missing_factors_fail_for_stocks_but_etf_shows_raw_with_label(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], factors=[]))
    with pytest.raises(K.KlineError, match="复权因子没有取到"):
        K.build({"symbol": "600519", "adjust": "qfq"}, tmp_path)
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], rows=_tx_rows("sh510300"), factors=[]))
    r = K.build({"symbol": "510300", "adjust": "qfq"}, tmp_path)
    assert r["adjust"] == "none" and "没有复权因子" in r["adjust_label"], "ETF 没因子时明说是原始价，不标成复权"
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], factor_status="failed"))
    with pytest.raises(K.KlineError, match="复权因子没有取到"):
        K.build({"symbol": "600519", "adjust": "hfq"}, tmp_path)


def test_factor_not_covering_early_bars_is_an_error_not_raw_prices(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], factors=[{"d": "2026-01-05", "f": "1.0"}]))
    with pytest.raises(K.KlineError, match="换算失败"):
        K.build({"symbol": "600519", "adjust": "qfq"}, tmp_path)


@pytest.mark.parametrize("req, msg", [
    ({"symbol": ""}, "请给一个代码"),
    ({"symbol": "600519", "period": "m5"}, "period"),
    ({"symbol": "600519", "adjust": "xx"}, "adjust"),
    ({"symbol": "EURUSD"}, "认不出"),
])
def test_bad_requests(monkeypatch, tmp_path, req, msg):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([]))
    with pytest.raises(K.KlineError, match=msg):
        K.build(req, tmp_path)


def test_series_only_with_charts_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([]))
    r = K.build({"symbol": "600519", "adjust": "none"}, tmp_path)
    assert "ui_only" not in r, "Agent 那条路不带整段序列"
    assert r["bars"] == 70 and r["first"] == "2025-12-01"


def _hk_weekly(symbol="0700.HK"):
    # 港股周线的时间戳是当地周一 0 点 = 周日 16:00 UTC；末尾再跟一行「当前报价」快照
    mondays = [datetime(2026, 9, 14, tzinfo=timezone.utc) + timedelta(weeks=i) for i in range(4)]
    ts = [int((m - timedelta(hours=8)).timestamp()) for m in mondays]
    ts.append(int(datetime(2026, 10, 8, 5, 50, tzinfo=timezone.utc).timestamp()))
    q = {"open": [400, 410, 420, 430, 431], "high": [405, 415, 425, 435, 432],
         "low": [395, 405, 415, 425, 429], "close": [402, 412, 422, 432, 430], "volume": [9, 9, 9, 9, 3]}
    return {"chart": {"result": [{"meta": {"symbol": symbol, "exchangeTimezoneName": "Asia/Hong_Kong"},
                                  "timestamp": ts, "indicators": {"quote": [q]}}]}}


def test_yahoo_weekly_uses_local_dates_and_drops_trailing_snapshot(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch(calls, yahoo=_hk_weekly()))
    r = K.build({"symbol": "00700.HK", "period": "week", "adjust": "hfq", "charts": True}, tmp_path)
    assert calls == [("yahoo_kline", "00700.HK", {"interval": "1wk", "range_": "10y"})]
    s = r["ui_only"]["series"]
    assert s["dates"] == ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"], "按香港当地日期，不落到周日"
    assert s["close"][-1] == 432, "末尾那行报价快照去掉"
    assert r["adjust"] == "split" and r["volume_unit"] == "股"
    assert any("复权选项不适用" in n for n in r["notes"]) and any("周期第一天" in n for n in r["notes"])


def test_yahoo_wrong_symbol_rejected(monkeypatch, tmp_path):
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch([], yahoo=_hk_weekly("9988.HK")))
    with pytest.raises(K.KlineError, match="不是同一只"):
        K.build({"symbol": "00700.HK", "period": "week"}, tmp_path)


def test_main_catalog_and_error_are_json(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"action":"catalog"}'))
    K.main()
    cat = json.loads(capsys.readouterr().out)
    assert cat["ok"] is True and "北交所" in cat["catalog"]["description"]
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"symbol":"920001"}'))
    K.main()
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False and "北交所" in out["error"]
    blob = json.dumps(cat, ensure_ascii=False)
    assert not any(w in blob for w in ("目标价", "买入信号", "卖出信号", "评级")), "只给行情，不给买卖建议"


def test_a_share_request_ends_on_beijing_today_whatever_the_local_timezone(monkeypatch, tmp_path):
    """北京时间 3 月 3 日 16:00 已收盘，本机在檀香山还是 3 月 2 日：请求截止日要写 3 月 3 日（2026-10-11 审计 4.9）。"""
    instant = datetime(2026, 3, 3, 8, 0, tzinfo=timezone.utc)

    class LocalDate(date):
        @classmethod
        def today(cls):
            return date(2026, 3, 2)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz) if tz else datetime(2026, 3, 2, 22, 0)

    monkeypatch.setattr(K, "date", LocalDate)
    monkeypatch.setattr(K, "datetime", Clock)
    calls = []
    monkeypatch.setattr(K, "_run_fetch", _fake_fetch(calls))
    K.build({"symbol": "600519", "period": "day", "adjust": "qfq"}, tmp_path)
    args = next(c for c in calls if c[0] == "tx_kline")[2]
    assert args["end"] == "2026-03-03", args
    assert args["start"] == (date(2026, 3, 3) - timedelta(days=K.A_SHARE_SPAN_DAYS["day"])).isoformat()
