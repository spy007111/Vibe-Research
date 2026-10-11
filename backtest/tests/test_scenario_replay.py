"""历史情景回放：买入持有的加权涨跌 / 回撤 / 最差单日手算对照、缺口（没上市 / 到结束还停牌 / 没取到）、
起点停牌、开始后才上市、覆盖率不足不给组合数字、港美股 10 年限制、A 股逐只取、baostock 挤掉登录重取一次、入参校验。全部离线。"""
from __future__ import annotations

import io
import json
import threading
import time
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from backtest import scenario_replay as S

A_SCN = {"id": "t", "label": "测试时期", "start": "2020-03-02", "end": "2020-03-13"}


def _ser(pairs):
    return pd.Series([p for _, p in pairs], index=pd.to_datetime([d for d, _ in pairs]), dtype="float64")


def _days(start="2020-02-24", n=20):
    return [d.date().isoformat() for d in pd.bdate_range(start, periods=n)]


def _replay(positions, series, gaps=None, bench=None, scn=A_SCN):
    return S._replay_one(scn, positions, series, gaps or {}, bench, None)


def _pos(*items):
    return [{"symbol": s, "name": s, "value": v} for s, v in items]


def test_weighted_buy_and_hold_matches_hand_calculation():
    d = _days()
    # 2020-03-02 是 d[5]，2020-03-13 是 d[14]
    a = _ser([(x, 10.0) for x in d[:5]] + list(zip(d[5:15], [10, 11, 9, 9, 10, 8, 8, 9, 9, 12])))
    b = _ser([(x, 20.0) for x in d[:5]] + list(zip(d[5:15], [20, 20, 22, 18, 18, 18, 16, 16, 20, 20])))
    bench = _ser([(x, 100.0) for x in d[:5]] + list(zip(d[5:15], [100, 98, 95, 97, 90, 92, 93, 91, 94, 96])))
    out, path = _replay(_pos(("A", 6000), ("B", 4000)), {"A": a, "B": b}, bench=bench)
    p = out["portfolio"]
    # 买入持有：组合 = Σ 权重 × 各自涨跌
    assert p["return"] == pytest.approx(0.6 * 0.2 + 0.4 * 0.0)
    assert p["value_change"] == pytest.approx(10000 * 0.12)
    # 逐日净值：0.6×A/10 + 0.4×B/20
    want = [0.6 * x / 10 + 0.4 * y / 20 for x, y in zip([10, 11, 9, 9, 10, 8, 8, 9, 9, 12], [20, 20, 22, 18, 18, 18, 16, 16, 20, 20])]
    assert path["portfolio"] == pytest.approx(want)
    peak = max(want[:6])          # 回撤最低点在 d[10]/d[11]（0.8 / 0.8×0.6+0.4×0.8）
    trough = min(want)
    assert p["max_drawdown"] == pytest.approx(trough / peak - 1)
    daily = [want[i] / want[i - 1] - 1 for i in range(1, len(want))]
    assert p["worst_day"] == pytest.approx(min(daily))
    assert p["worst_day_date"] == d[5 + 1 + daily.index(min(daily))]
    assert out["coverage"] == 1 and out["portfolio_note"] is None
    b_ = out["benchmark"]
    assert b_["return"] == pytest.approx(-0.04) and b_["max_drawdown"] == pytest.approx(-0.10)
    assert b_["max_drawdown_trough"] == d[9]
    # 拖累最大的排在前面
    assert [h["symbol"] for h in out["holdings"]] == ["B", "A"]
    assert {h["symbol"]: h["contribution"] for h in out["holdings"]} == {"A": pytest.approx(0.12), "B": pytest.approx(0.0)}
    json.dumps(out, allow_nan=False)
    json.dumps(path, allow_nan=False)


def test_gaps_not_listed_halted_through_end_fetch_failed_are_not_zero():
    d = _days()
    ok = _ser([(x, 10.0 + i) for i, x in enumerate(d)])
    late = _ser([(x, 5.0) for x in d[14:]])                      # 03-13 才有价格（晚于起点 10 天以上）：当时还没上市
    stuck = _ser([(x, 7.0) for x in d[:6]])                       # 03-02 以后没有价格：到结束还在停牌
    out, _ = _replay(_pos(("OK", 1000), ("LATE", 1000), ("STUCK", 1000), ("ERR", 1000)),
                     {"OK": ok, "LATE": late, "STUCK": stuck}, gaps={"ERR": "超时"},
                     scn={**A_SCN, "end": "2020-03-20"})
    reasons = {g["symbol"]: g["reason"] for g in out["gaps"]}
    assert "还没有价格" in reasons["LATE"] and "可能当时还没上市" in reasons["LATE"]
    assert "最后一个价格在 2020-03-02" in reasons["STUCK"] and "算不准" in reasons["STUCK"]
    assert reasons["ERR"] == "历史价格没取到：超时"
    assert [h["symbol"] for h in out["holdings"]] == ["OK"]
    # 只剩一只有价格、只占 25%：不给组合数字，但各只的涨跌照列
    assert out["coverage"] == pytest.approx(0.25)
    assert out["portfolio"] is None and "不到一半" in out["portfolio_note"]
    assert out["holdings"][0]["weight"] == pytest.approx(1.0)


def test_coverage_at_half_still_gives_portfolio_and_says_how_weights_were_split():
    d = _days()
    ok = _ser([(x, 10.0) for x in d])
    out, _ = _replay(_pos(("OK", 1000), ("ERR", 1000)), {"OK": ok}, gaps={"ERR": "x"})
    assert out["coverage"] == pytest.approx(0.5) and out["portfolio"] is not None
    assert "只在这段时期有价格的 1 只之间分配" in out["portfolio_note"]
    assert out["portfolio"]["included_value"] == pytest.approx(1000)


def test_halted_on_start_uses_last_close_before_and_counts_halted_days():
    d = _days()
    # 2020-02-28（d[4]）收 10，03-02 到 03-04 停牌，03-05 复牌 8
    s = _ser([(x, 10.0) for x in d[:5]] + [(x, 8.0) for x in d[8:]])
    bench = _ser([(x, 100.0) for x in d])           # 指数那几天照常交易：日历里要有这几天
    out, path = _replay(_pos(("H", 1000)), {"H": s}, bench=bench)
    h = out["holdings"][0]
    assert h["first_date"] == "2020-02-28" and h["return"] == pytest.approx(-0.2)
    assert h["halted_days"] == 3
    assert path["portfolio"][:4] == pytest.approx([1.0, 1.0, 1.0, 0.8]), "停牌那几天按停牌前收盘价计"


def test_listed_a_few_days_after_start_is_a_gap_not_backfilled_as_flat():
    """审计第二轮 D8：起点之前没有价格（03-04 才上市）→ 进缺口，不拿 03-04 的价格往前补成「持平」。"""
    d = _days()
    s = _ser([(x, 4.0 + i) for i, x in enumerate(d[7:])])        # 03-04 上市
    out, path = _replay(_pos(("N", 1000)), {"N": s})
    assert out["holdings"] == [] and out["portfolio"] is None and path is None
    assert [g["symbol"] for g in out["gaps"]] == ["N"] and "开始时还没有价格" in out["gaps"][0]["reason"]
    # 和一只起点前就有价格的放在一起：只按那一只算，覆盖率 50%，新股不进路径
    ok = _ser([(x, 10.0) for x in d])
    out, path = _replay(_pos(("OK", 1000), ("N", 1000)), {"OK": ok, "N": s})
    assert [h["symbol"] for h in out["holdings"]] == ["OK"] and out["coverage"] == pytest.approx(0.5)
    assert "按持平计" not in (out["portfolio_note"] or "")


def test_no_holding_has_prices():
    out, path = _replay(_pos(("ERR", 1000)), {}, gaps={"ERR": "x"})
    assert out["portfolio"] is None and path is None and "没有一只" in out["portfolio_note"]


def test_benchmark_missing_or_too_short_is_reported_not_faked():
    d = _days()
    ok = _ser([(x, 10.0) for x in d])
    out, path = S._replay_one(A_SCN, _pos(("OK", 1)), {"OK": ok}, {}, None, "超时")
    assert out["benchmark"] is None and out["benchmark_error"] == "超时" and path["benchmark"] is None
    short = _ser([(x, 1.0) for x in d[:3]])
    out, _ = _replay(_pos(("OK", 1)), {"OK": ok}, bench=short)
    assert out["benchmark"] is None and out["benchmark_error"].startswith("对照指数最后一个价格在")


def test_hk_us_periods_older_than_ten_years_are_marked_unavailable():
    ok, off = S._available("us_equity", earliest=date(2019, 1, 1))
    assert [s["id"] for s in off] == ["us_2018q4"] and "取不到" in off[0]["reason"]
    assert "us_2018q4" not in [s["id"] for s in ok]
    ok, off = S._available("a_share", earliest=date(2030, 1, 1))
    assert not off, "A 股走 baostock，没有 10 年限制"
    # 起点前要多取 LEAD_DAYS 天：起点离限制不到这么多天也算取不到
    edge = date.fromisoformat("2018-09-20")
    _, off = S._available("us_equity", earliest=edge)
    assert "us_2018q4" in [s["id"] for s in off]


def test_scenario_table_is_well_formed():
    seen = set()
    for market, scns in S.SCENARIOS.items():
        assert market in S.GROUPS and scns
        for s in scns:
            assert s["id"] not in seen and s["label"]
            seen.add(s["id"])
            assert date.fromisoformat(s["start"]) < date.fromisoformat(s["end"])


class _Fake:
    """假的取数：按代码给序列，记录并发数。"""

    def __init__(self, series, fail=()):
        self.series, self.fail = series, set(fail)
        self.calls, self.live, self.peak = [], 0, 0
        self.lock = threading.Lock()

    def closes(self, code, start, end, out_dir):
        with self.lock:
            self.calls.append((code, start, end))
            self.live += 1
            self.peak = max(self.peak, self.live)
        time.sleep(0.02)
        with self.lock:
            self.live -= 1
        if code in self.fail:
            return None, f"{code} 取不到", None
        return self.series(code), None, "fake_kline"


def _long_series(code):
    idx = pd.bdate_range("2015-01-01", "2025-12-31")
    return pd.Series(10.0, index=idx, dtype="float64")


def test_build_groups_by_currency_and_fetches_a_share_one_at_a_time(monkeypatch, tmp_path):
    fake = _Fake(_long_series, fail={"MSFT"})
    monkeypatch.setattr(S, "_closes", fake.closes)
    monkeypatch.setattr(S, "_benchmark", lambda m, a, b, o: (_long_series("x"), None))
    monkeypatch.setattr(S, "yahoo_daily_earliest", lambda: date(2018, 1, 1))
    req = {"positions": [{"symbol": "600519", "value": 1}, {"symbol": "300308", "value": 1}, {"symbol": "000001", "value": 1},
                         {"symbol": "AAPL", "value": 1}, {"symbol": "NVDA", "value": 1}, {"symbol": "MSFT", "value": 1},
                         {"symbol": "00700.HK", "value": None}], "charts": True}
    a_codes = {"600519.SH", "300308.SZ", "000001.SZ"}
    peaks = {}
    orig = fake.closes

    def tracking(code, start, end, out_dir):
        r = orig(code, start, end, out_dir)
        peaks.setdefault("a" if code in a_codes else "us", []).append(fake.peak)
        return r
    monkeypatch.setattr(S, "_closes", tracking)
    out = S.build(req, tmp_path)
    assert [g["currency"] for g in out["groups"]] == ["CNY", "USD"]
    assert out["gaps"][0]["symbol"] == "00700.HK", "没有市值的进总缺口"
    cny, usd = out["groups"]
    # A 股取数区间覆盖最早时期前 LEAD_DAYS 天到最晚时期的结束
    a_calls = [c for c in fake.calls if c[0] in a_codes]
    assert {c[1] for c in a_calls} == {"2015-05-09"} and {c[2] for c in a_calls} == {"2024-02-02"}
    assert max(peaks["a"]) == 1, "A 股逐只取，不同时开几个 baostock 会话"
    assert len(cny["scenarios"]) == 5 and all(s["portfolio"] for s in cny["scenarios"])
    assert [s["id"] for s in usd["scenarios"] if s["unavailable"]] == [], "限制放到 2018-01-01 时四段都取得到"
    assert all("MSFT" in [g["symbol"] for g in s["gaps"]] for s in usd["scenarios"])
    assert cny["benchmark_label"] == "沪深300指数" and cny["sources"] == ["fake_kline", "腾讯 K 线"], "端点名换成看得懂的名字，没列的照原样"
    assert set(out["ui_only"]["paths"]["CNY"]) == {s["id"] for s in S.SCENARIOS["a_share"]}
    json.dumps(out, allow_nan=False)
    assert "ui_only" not in S.build({**req, "charts": False}, tmp_path)


def test_unavailable_periods_stay_in_time_order(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "_closes", _Fake(_long_series).closes)
    monkeypatch.setattr(S, "_benchmark", lambda m, a, b, o: (_long_series("x"), None))
    monkeypatch.setattr(S, "yahoo_daily_earliest", lambda: date(2019, 6, 1))
    scns = S.build({"positions": [{"symbol": "AAPL", "value": 1}]}, tmp_path)["groups"][0]["scenarios"]
    assert [s["id"] for s in scns] == ["us_2018q4", "us_2020", "us_2022", "us_2025"]
    assert scns[0]["unavailable"] and not any(s["unavailable"] for s in scns[1:])


def test_build_when_every_period_is_too_old_skips_fetching(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "_closes", lambda *a: pytest.fail("全部时期都取不到时不该去取"))
    monkeypatch.setattr(S, "_benchmark", lambda *a: pytest.fail("全部时期都取不到时不该去取"))
    monkeypatch.setattr(S, "yahoo_daily_earliest", lambda: date(2030, 1, 1))
    out = S.build({"positions": [{"symbol": "AAPL", "value": 1}]}, tmp_path)
    scns = out["groups"][0]["scenarios"]
    assert len(scns) == 4 and all(s["unavailable"] for s in scns)


class _Loader:
    """VibeLoader 替身：按顺序给结果。"""
    script: list = []
    made = 0

    def __init__(self, out_dir, limit_prices=True):
        assert limit_prices is False, "回放只要收盘价，不多取不复权价"
        type(self).made += 1
        self.failures, self.provenance = {}, {}

    def fetch(self, codes, start, end):
        code = codes[0]
        r = type(self).script.pop(0)
        if r is not None:       # 字符串 = 失败原因；None = 取到了
            self.failures[code] = r
            return {}
        return {code: pd.DataFrame({"close": [1.0, 2.0]}, index=pd.to_datetime(["2020-01-02", "2020-01-03"]))}


@pytest.mark.parametrize("first,retried", [
    ("bs_kline_qfq 取 600519.SH 退出码 3：RuntimeError: baostock 翻页失败: 10001001 用户未登录（只取到 2000 行，不完整）", True),
    ("bs_kline_qfq 取 600519.SH 退出码 3：RuntimeError: baostock 登录失败: 10002007 网络错误", True),
    ("区间内一根 bar 都没有", False),
])
def test_baostock_session_clash_is_retried_once(first, retried, monkeypatch, tmp_path):
    monkeypatch.setattr(S, "VibeLoader", _Loader)
    monkeypatch.setattr(S, "RETRY_SLEEP", 0)
    _Loader.made = 0
    _Loader.script = [first, None]
    ser, why, _ = S._closes("600519.SH", "2020-01-01", "2020-02-01", tmp_path)
    assert _Loader.made == (2 if retried else 1)
    assert (ser is not None) == retried and (why is None) == retried
    _Loader.made = 0
    _Loader.script = [first, first]
    ser, why, _ = S._closes("600519.SH", "2020-01-01", "2020-02-01", tmp_path)
    assert ser is None and why and _Loader.made == (2 if retried else 1), "重取最多一次"


def test_plain_reasons_for_etf_and_bj():
    assert "ETF" in S._plain("510300.SH 不是个股（ETF / 指数 / 可转债 号段）—— …")
    assert "2021 年 11 月才开市" in S._plain("北交所仅支持 2021-11-15 起的区间；此前精选层/新三板规则未建模")
    assert S._plain("超时") == "超时"


def _main(monkeypatch, capsys, stdin):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    S.main()
    return json.loads(capsys.readouterr().out)


def test_main_validates_input_and_serves_catalog(monkeypatch, capsys):
    assert _main(monkeypatch, capsys, "{")["ok"] is False
    assert _main(monkeypatch, capsys, "[]")["error"] == "入参必须是对象"
    r = _main(monkeypatch, capsys, json.dumps({"positions": []}))
    assert r == {"ok": False, "error": "没有持仓可以回放：positions 要是一个非空列表"}
    r = _main(monkeypatch, capsys, json.dumps({"positions": [{"symbol": "AAPL", "value": 1}] * 61}))
    assert r["error"] == "一次最多回放 60 只"
    cat = _main(monkeypatch, capsys, json.dumps({"action": "catalog"}))
    assert cat["ok"] and "不提供任何操作建议" in cat["catalog"]["description"]


def test_source_names_are_readable_and_skip_empty():
    assert S.source_names(["tx_kline", "", None, "some_new_endpoint", "tx_kline"]) == ["some_new_endpoint", "腾讯 K 线"]
