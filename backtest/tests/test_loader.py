"""取数适配层测试 —— 全部离线。

这一层踩过的坑有个共同形状：**不报错，给一个看着正常的结果**。
所以每条测试针对的都是「静默错」，而不是「会不会抛异常」。
"""
from __future__ import annotations

import os
import sys
import pathlib
import json
from types import SimpleNamespace
from datetime import date, timedelta

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest.loader import (  # noqa: E402
    LoaderError, VibeLoader, _assert_same_instrument, _frame_from_baostock,
    SymbolProvenance, _frame_from_yahoo, _to_ns_index, _yahoo_range, assert_a_share_stock,
    canonical_code, market_of,
)


def test_failed_fetch_preserves_stdout_error_envelope(tmp_path, monkeypatch):
    import backtest.loader as loader
    envelope = {"status": "failed", "errors": [{"source": "fixture", "endpoint": "test", "error": "HTTP 429 请求过快"}]}
    monkeypatch.setattr(loader.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=3, stdout=json.dumps(envelope), stderr=""))
    with pytest.raises(LoaderError, match="HTTP 429 请求过快"):
        loader._run_fetch("fixture", "AAPL", {}, tmp_path, sys.executable, 3)


@pytest.mark.parametrize("stdout", ["not JSON", "[]", '{"errors":null}', '{"errors":[null,7,{"error":42}]}'])
def test_failed_fetch_malformed_envelope_keeps_stderr_cause(tmp_path, monkeypatch, stdout):
    import backtest.loader as loader
    monkeypatch.setattr(loader.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=3, stdout=stdout, stderr="fixture interpreter failed"))
    with pytest.raises(LoaderError, match="fixture interpreter failed"):
        loader._run_fetch("fixture", "AAPL", {}, tmp_path, sys.executable, 3)


@pytest.mark.parametrize("raw,want", [
    ("600519", "600519.SH"), ("601127", "601127.SH"), ("688981", "688981.SH"),
    ("000001", "000001.SZ"), ("002050", "002050.SZ"), ("300308", "300308.SZ"),
    ("430139", "430139.BJ"), ("870204", "870204.BJ"),
    ("sz.300308", "300308.SZ"), ("sh.600519", "600519.SH"),
    ("aapl", "AAPL"), ("00700.hk", "00700.HK"),
])
def test_canonical_code(raw, want):
    assert canonical_code(raw) == want


def test_bare_code_without_a_known_range_is_refused():
    """认不出就报错，不猜 —— 猜错的后果是整只票用错市场规则，而结果看着正常。"""
    with pytest.raises(LoaderError):
        canonical_code("999999")


@pytest.mark.parametrize("code,mkt", [
    ("600519.SH", "a_share"), ("300308.SZ", "a_share"),
    ("AAPL", "us_equity"), ("NVDA", "us_equity"), ("00700.HK", "hk_equity"),
])
def test_market_of(code, mkt):
    assert market_of(code) == mkt


@pytest.mark.parametrize("bad", [
    "^HSI", "BTC/USDT", "RB2410.SHFE", "RELIANCE.NS", "EURUSD=X",
    # 👇 这四个是测试自己抓出来的：形状守卫原本写得太宽（美股放到 10 位字母），
    #    它们通过了形状检查，然后被上游的兜底判成 a_share 拿去查 baostock，
    #    而闸口**放行**。「我以为堵上了」的地方恰恰没堵。
    "EURUSD", "BTCUSDT", "RELIANCE", "BRK.B",
])
def test_market_of_refuses_instead_of_defaulting_to_a_share(bad):
    """🔴 上游 `_detect_market` 认不出时一律回落 a_share。
    在只支持三个市场的这一版里，那个回落会把「不支持」变成「用错规则跑完」。"""
    with pytest.raises(LoaderError):
        market_of(bad)


@pytest.mark.parametrize("code", ["510300.SH", "159915.SZ", "113050.SH", "128036.SZ"])
def test_non_stock_a_share_codes_refused(code):
    """ETF / 指数 / 可转债：baostock 那个端点对它们返回**空序列而不报错**。"""
    with pytest.raises(LoaderError, match="不是个股"):
        assert_a_share_stock(code)


@pytest.mark.parametrize("code", ["900901.SH", "200002.SZ", "900901"])
def test_b_share_codes_refused(code):
    """第四轮审计 C1：B 股按美元、港元计价，号段表认不出就放行，会按人民币 A 股跑完。"""
    with pytest.raises(LoaderError, match="B 股"):
        assert_a_share_stock(code)


@pytest.mark.parametrize("code", ["600519.SH", "300308.SZ", "000001.SZ", "430139.BJ", "600900.SH", "002000.SZ"])
def test_stock_codes_pass(code):
    assert_a_share_stock(code) is None


def test_pre_bse_history_refused_before_fetch(tmp_path, monkeypatch):
    import backtest.loader as loader
    monkeypatch.setattr(loader, "_run_fetch", lambda *a: pytest.fail("unsupported history must not fetch"))
    ld = VibeLoader(out_dir=tmp_path)
    with pytest.raises(LoaderError, match="2021-11-15"):
        ld._fetch_one("430047.BJ", "2020-01-01", "2024-01-01")


# ── 时间分辨率：最重要的一条 ──

@pytest.mark.parametrize("unit", ["s", "us", "ms", "ns"])
def test_index_is_normalised_to_nanoseconds(unit):
    """🔴 pandas 3 保留原始分辨率，而上游 `_align` 把 `asi8` 一律当纳秒解释。
    秒被当纳秒 → 所有 bar 掉到 1970 年 → 与信号完全对不上 → **一笔都不成交**，
    而且**不抛异常**：产出的是一份「总收益 0.00%」的完整报告。"""
    idx = pd.to_datetime(["2024-01-02", "2024-01-03"]).astype(f"datetime64[{unit}]")
    df = pd.DataFrame({"close": [1.0, 2.0]}, index=idx)
    out = _to_ns_index(df)
    assert out.index.dtype == "datetime64[ns]"
    assert out.index[0].year == 2024, "归一后日期必须还是 2024，不能掉到 1970"


def test_to_ns_index_rejects_a_non_time_index():
    with pytest.raises(LoaderError):
        _to_ns_index(pd.DataFrame({"close": [1.0]}, index=[0]))


# ── 拿回来的是不是同一只票 ──

def test_instrument_mismatch_is_caught():
    """实测过：要 000001.SH（上证综指）会拿到 sz.000001（平安银行），全程不报错。"""
    with pytest.raises(LoaderError, match="不是同一只票"):
        _assert_same_instrument("000001.SH", {"query": {"code": "sz.000001"}})


def test_instrument_match_passes():
    assert _assert_same_instrument("600519.SH", {"query": {"code": "sh.600519"}}) is None


def test_missing_query_is_an_error_not_a_pass():
    """🔴 核对不了 ≠ 核对通过。

    第一版这里写的是「没记下查询串就放行」。Codex 指出：这道校验防的正是
    「拿到另一只票、回测照常跑完」，一旦上游不再落 query.code，它就悄悄变成空操作，
    而**失效本身没人看得出来**。⇒ 跑不起来的校验必须报错。
    """
    with pytest.raises(LoaderError, match="无法核对"):
        _assert_same_instrument("600519.SH", {"rows": []})


# ── 解析 ──

def test_baostock_parser_drops_halted_bars_and_says_how_many():
    payload = {"rows": [
        {"date": "2024-01-02", "open": 10, "high": 11, "low": 9, "close": 10.5,
         "preclose": 10, "volume": 1, "turn": 1, "tradestatus": "1"},
        {"date": "2024-01-03", "open": 0, "high": 0, "low": 0, "close": 0,
         "preclose": 10.5, "volume": 0, "turn": 0, "tradestatus": "0"},   # 停牌
    ]}
    df, halted = _frame_from_baostock(payload)
    assert len(df) == 1 and halted == 1
    assert "pre_close" in df.columns, "引擎找的是 pre_close，名字对不上会静默回退到上一根收盘"
    assert "tradestatus" not in df.columns


def test_yahoo_parser_drops_rows_without_a_close():
    payload = {"chart": {"result": [{
        "timestamp": [1704153600, 1704240000, 1704326400],
        "indicators": {"quote": [{"open": [1, 2, 3], "high": [1, 2, 3], "low": [1, 2, 3],
                                  "close": [1.0, None, 3.0], "volume": [10, 20, 30]}]},
    }]}}
    df, dropped = _frame_from_yahoo(payload)
    assert len(df) == 2 and dropped == 1


def test_yahoo_parser_on_empty_result():
    df, dropped = _frame_from_yahoo({"chart": {"result": [{}]}})
    assert df.empty and dropped == 0


# ── Yahoo 窗口关键字 ──

def test_yahoo_range_covers_the_requested_start():
    today = date.today()
    for days, expect_at_least in [(20, "1mo"), (200, "1y"), (900, "5y")]:
        start = (today - timedelta(days=days)).isoformat()
        got = _yahoo_range(start, today.isoformat())
        assert got, f"{days} 天应当有对应窗口"
    # 覆盖不住就该往大了取，不能给一个短窗口然后静默少几年数据
    old = (today - timedelta(days=3000)).isoformat()
    assert _yahoo_range(old, today.isoformat()) == "10y"


def test_yahoo_range_rejects_reversed_window():
    with pytest.raises(LoaderError):
        _yahoo_range("2025-01-01", "2024-01-01")


# ── 粒度 ──

@pytest.mark.parametrize("interval", ["1m", "5m", "15m", "1H", "4H"])
def test_non_daily_interval_refused(interval, tmp_path):
    """拿日线顶替分钟线，回测结果看着完全正常，但它测的不是日内。"""
    with pytest.raises(LoaderError, match="日线"):
        VibeLoader(out_dir=tmp_path).fetch(["600519.SH"], "2024-01-01", "2024-02-01", interval=interval)


def test_gate_refuses_everything_market_of_refuses():
    """闸口与取数层必须口径一致 —— 取数层拒绝的，闸口不能放行（反过来也一样）。
    这两处分开写就会漂移，而漂移的表现是「闸口说能跑，跑到一半取数说不认识」。"""
    from backtest.gate import Refusal, plan_backtest
    for code in ["EURUSD", "BTCUSDT", "BRK.B", "^HSI", "RELIANCE", "999999"]:
        with pytest.raises(LoaderError):
            market_of(code)
        got = plan_backtest(codes=[code], start="2021-01-01", end="2025-12-31", style="long")
        assert isinstance(got, Refusal), f"{code} 取数层拒绝了，闸口却放行"
    # 👇 非个股这条第一版漏了覆盖：闸口放行、取数层拒绝，
    #    结果是跑到一半以「一只标的的数据都没取到」中止，说的不是真正的原因。
    for code in ["510300.SH", "159915.SZ", "113050.SH", "128036.SZ"]:
        with pytest.raises(LoaderError):
            assert_a_share_stock(code)
        got = plan_backtest(codes=[code], start="2021-01-01", end="2025-12-31", style="long")
        assert isinstance(got, Refusal), f"{code} 取数层拒绝了，闸口却放行"
        assert "不是个股" in got.reason, f"{code} 的拒绝理由要说到点子上"


def test_ambiguous_ticker_shapes_are_refused():
    """`BRK.B` 这类带类别后缀的写法：本层不认，直接拒 —— 不猜成美股也不兜底成 A股。"""
    for code in ["BRK.B", "BF.A", "RDS.A"]:
        with pytest.raises(LoaderError):
            market_of(code)


def test_cross_check_branch_rejects_a_disagreement(monkeypatch):
    """交叉核对分支本身的测试。

    ⚠️ **诚实地说清楚**：在当前的形状（美股 1-5 位纯字母）下，这个分支
    **不可达** —— 上游对 1-5 位纯字母同样判 us_equity，两边永远一致。
    它是第二层：只有将来形状被放宽（比如放到 10 位、把 EURUSD 收进来）时才承重。
    实测过：把形状放宽后，正是这一层把 EURUSD / BTCUSDT 拦下来的。
    ⇒ 所以这里直接把上游判定打桩成不一致，验分支本身是通的。
    """
    import backtest.loader as L
    monkeypatch.setattr(L, "_detect_market", lambda c: "kr_equity")
    with pytest.raises(LoaderError, match="歧义"):
        L.market_of("AAPL")


def test_both_layers_independently_refuse_a_forex_pair(monkeypatch):
    """两层各自都拦得住 EURUSD —— 冗余是真的，不是一层掩着另一层。"""
    import backtest.loader as L
    # 只留形状这一层（把交叉核对变成永远一致）
    monkeypatch.setattr(L, "_detect_market", lambda c: "us_equity")
    with pytest.raises(LoaderError, match="认不出"):
        L.market_of("EURUSD")


# ── 以下针对 Codex 审计指出的问题（每条都做过变异验证）──

def test_yahoo_parser_requires_all_four_prices():
    """只 dropna(close) 会留下 open=NaN 的行 —— 撮合价取的就是 open，
    那一根不会报错，表现是「少成交了一笔」而不是「数据有问题」。"""
    payload = {"chart": {"result": [{
        "timestamp": [1704153600, 1704240000, 1704326400, 1704412800],
        "indicators": {"quote": [{
            "open":  [1.0, None, 3.0, 4.0],      # 第 2 行缺开盘
            "high":  [1.0, 2.0, 3.0, 4.0],
            "low":   [1.0, 2.0, 3.0, 0.0],       # 第 4 行 low=0，非正价格
            "close": [1.0, 2.0, 3.0, 4.0],
            "volume": [10, 20, 30, 40]}]},
    }]}}
    df, dropped = _frame_from_yahoo(payload)
    assert len(df) == 2 and dropped == 2
    assert df[["open", "high", "low", "close"]].notna().all().all()


def test_ns_guard_survives_python_dash_O():
    """分辨率守卫不能用 assert —— `python -O` 会把 assert 整条删掉，
    而这正是最不能被关掉的一道（它防的是那个不抛异常的静默错）。"""
    src = (pathlib.Path(__file__).resolve().parents[1] / "loader.py").read_text()
    body = src[src.index("def _fetch_one"):]
    assert "assert df.index.dtype" not in body, "关键守卫不能写成 assert"
    assert "datetime64[ns]" in body and "raise LoaderError" in body


def test_success_clears_a_previous_failure_for_the_same_code(tmp_path, monkeypatch):
    """同一只票不能既在 failures 又在 provenance —— 报告层会同时看到「成功」和「失败」。"""
    ld = VibeLoader(out_dir=tmp_path)
    ld.failures["600519.SH"] = "上一次超时"
    df = pd.DataFrame({"open": [1.0], "high": [1.0], "low": [1.0], "close": [1.0], "volume": [1.0]},
                      index=pd.to_datetime(["2024-01-02"]).astype("datetime64[ns]"))
    prov = SymbolProvenance(code="600519.SH", market="a_share", endpoint="x", rows=1)
    monkeypatch.setattr(ld, "_fetch_one", lambda c, s, e: (df, prov))
    ld.fetch(["600519.SH"], "2024-01-01", "2024-02-01")
    assert "600519.SH" not in ld.failures
    assert "600519.SH" in ld.provenance


def test_failure_clears_a_previous_success_for_the_same_code(tmp_path, monkeypatch):
    ld = VibeLoader(out_dir=tmp_path)
    ld.provenance["600519.SH"] = SymbolProvenance(code="600519.SH", market="a_share", endpoint="x", rows=9)
    def boom(c, s, e): raise LoaderError("这次挂了")
    monkeypatch.setattr(ld, "_fetch_one", boom)
    ld.fetch(["600519.SH"], "2024-01-01", "2024-02-01")
    assert "600519.SH" in ld.failures and "600519.SH" not in ld.provenance


def test_unexpected_parse_error_lands_in_failures(tmp_path, monkeypatch):
    """解析层的意外不该炸穿整次回测 —— 那样看不出是哪只票、哪个端点出的问题。"""
    ld = VibeLoader(out_dir=tmp_path)
    def boom(c, s, e): raise ValueError("数组长度不齐")
    monkeypatch.setattr(ld, "_fetch_one", boom)
    out = ld.fetch(["600519.SH", "AAPL"], "2024-01-01", "2024-02-01")
    assert out == {} and set(ld.failures) == {"600519.SH", "AAPL"}
    assert "数组长度不齐" in ld.failures["600519.SH"]


# ── 港美股只认日线：超过 10 年拒取，返回的粒度不是 1d 也拒 ──

def test_yahoo_range_refuses_starts_older_than_ten_years():
    from backtest.loader import YAHOO_DAILY_MAX_DAYS, yahoo_daily_earliest
    today = date.today()
    edge = (today - timedelta(days=YAHOO_DAILY_MAX_DAYS)).isoformat()
    assert _yahoo_range(edge, today.isoformat()) == "10y", "正好 10 年还能取日线"
    old = (today - timedelta(days=YAHOO_DAILY_MAX_DAYS + 1)).isoformat()
    with pytest.raises(LoaderError, match=r"最早只能取到 .*月线"):
        _yahoo_range(old, today.isoformat())
    assert yahoo_daily_earliest().isoformat() == edge


def _yahoo_payload(symbol, granularity, days=3):
    d0 = date.today() - timedelta(days=30)
    ts = [int(pd.Timestamp(d0 + timedelta(days=i)).timestamp()) + 14 * 3600 for i in range(days)]
    meta = {"symbol": symbol}
    if granularity is not None:
        meta["dataGranularity"] = granularity
    one = [10.0] * days
    return {"chart": {"result": [{"meta": meta, "timestamp": ts,
                                   "indicators": {"quote": [{"open": one, "high": one, "low": one, "close": one, "volume": one}]}}]}}


def _serve(monkeypatch, tmp_path, payload):
    import backtest.loader as loader
    raw = tmp_path / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "y.json").write_text(json.dumps(payload), encoding="utf-8")
    seen = []
    def fake(endpoint, symbol, args, *rest):
        seen.append((endpoint, symbol, args))
        return {"status": "ok", "extra": {"raw_files": ["raw/y.json"]}}
    monkeypatch.setattr(loader, "_run_fetch", fake)
    return seen


@pytest.mark.parametrize("granularity", ["1mo", "1wk", None])
def test_yahoo_non_daily_payload_is_refused(granularity, tmp_path, monkeypatch):
    _serve(monkeypatch, tmp_path, _yahoo_payload("AAPL", granularity))
    ld = VibeLoader(out_dir=tmp_path)
    start = (date.today() - timedelta(days=60)).isoformat()
    assert ld.fetch(["AAPL"], start, date.today().isoformat()) == {}
    assert "不是日线" in ld.failures["AAPL"] and "AAPL" not in ld.provenance
    _serve(monkeypatch, tmp_path, _yahoo_payload("0700.HK", granularity))
    assert ld.fetch(["INDEX:02800.HK"], start, date.today().isoformat()) == {}
    # 对照指数的 meta.symbol 对不上会先报「不是同一只 ETF」，这里专门测粒度
    _serve(monkeypatch, tmp_path, _yahoo_payload("2800.HK", granularity))
    ld2 = VibeLoader(out_dir=tmp_path)
    assert ld2.fetch(["INDEX:02800.HK"], start, date.today().isoformat()) == {}
    assert "不是日线" in ld2.benchmark_failures["INDEX:02800.HK"]


def test_yahoo_daily_payload_passes_and_old_start_never_fetches(tmp_path, monkeypatch):
    seen = _serve(monkeypatch, tmp_path, _yahoo_payload("AAPL", "1d"))
    ld = VibeLoader(out_dir=tmp_path)
    start = (date.today() - timedelta(days=60)).isoformat()
    out = ld.fetch(["AAPL"], start, date.today().isoformat())
    assert len(out["AAPL"]) == 3 and seen[-1][2] == {"interval": "1d", "range_": "3mo"}
    seen.clear()
    old = (date.today() - timedelta(days=4000)).isoformat()
    assert ld.fetch(["MSFT"], old, date.today().isoformat()) == {}
    assert "月线" in ld.failures["MSFT"] and not seen, "超过 10 年不该去取"


def test_fetch_output_and_raw_files_decode_as_utf8_whatever_the_locale(tmp_path, monkeypatch):
    """审计 D10：中文 Windows 默认 GBK。子进程输出、raw 文件都要显式按 UTF-8 读，子进程也开 UTF-8 模式。"""
    import backtest.loader as loader
    seen = {}
    def run(cmd, **kw):
        seen.update(kw)
        return SimpleNamespace(returncode=0, stdout='{"status":"ok","note":"贵州茅台"}', stderr="")
    monkeypatch.setattr(loader.subprocess, "run", run)
    assert loader._run_fetch("tx_kline", "600519", {}, tmp_path, sys.executable, 3)["note"] == "贵州茅台"
    assert seen["encoding"] == "utf-8" and "text" not in seen
    assert seen["env"]["PYTHONUTF8"] == "1" and seen["env"]["PYTHONIOENCODING"] == "utf-8"
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "x.json").write_bytes(json.dumps({"rows": [{"name": "贵州茅台"}]}, ensure_ascii=False).encode("utf-8"))
    real = pathlib.Path.read_text
    monkeypatch.setattr(pathlib.Path, "read_text", lambda self, encoding="gbk", errors=None: real(self, encoding=encoding, errors=errors))
    assert loader._read_raw(tmp_path, "raw/x.json")["rows"][0]["name"] == "贵州茅台"
    payload, _ = loader._raw_rows({"extra": {"raw_files": ["raw/x.json"]}}, tmp_path)
    assert payload["rows"][0]["name"] == "贵州茅台"


def test_raw_file_that_is_not_a_json_object_is_a_loader_error(tmp_path):
    """raw 顶层是列表 / null / 字符串：报 LoaderError（进 failures、说是哪个文件），不是 AttributeError 炸穿整次回测（类型检查发现）。"""
    import backtest.loader as loader
    (tmp_path / "raw").mkdir()
    for body in ("[]", "null", '"oops"'):
        (tmp_path / "raw" / "x.json").write_text(body, encoding="utf-8")
        with pytest.raises(LoaderError, match="顶层应是 JSON 对象"):
            loader._raw_rows({"extra": {"raw_files": ["raw/x.json"]}}, tmp_path)
        with pytest.raises(LoaderError, match="raw/x.json"):
            loader._read_raw(tmp_path, "raw/x.json")


def test_sec_contact_goes_only_to_endpoints_that_declare_it(tmp_path, monkeypatch):
    """事件回看会顺带取东财、Yahoo、基准指数：SEC 联系方式只交给注册表里声明了它的端点。"""
    import backtest.loader as loader
    seen = {}
    def run(cmd, **kw):
        seen[cmd[cmd.index("--endpoint") + 1]] = kw["env"]
        return SimpleNamespace(returncode=0, stdout='{"status":"ok"}', stderr="")
    monkeypatch.setattr(loader.subprocess, "run", run)
    monkeypatch.setenv("VRA_SEC_CONTACT", "Zhang San zhangsan@example.com")
    for ep in ["sec_earnings_8k_dates", "us_earnings_8k_dates", "yahoo_kline", "tx_kline"]:
        loader._run_fetch(ep, "JPM", {}, tmp_path, sys.executable, 3)
    assert seen["sec_earnings_8k_dates"]["VRA_SEC_CONTACT"] == "Zhang San zhangsan@example.com"
    for ep in ["us_earnings_8k_dates", "yahoo_kline", "tx_kline"]:
        assert "VRA_SEC_CONTACT" not in seen[ep], ep
    assert seen["yahoo_kline"].get("PATH") == os.environ.get("PATH"), "其余环境照常带上"


@pytest.mark.parametrize("raw,want", [
    ("Zhang San zhangsan@example.com", "Zhang San zhangsan@example.com"),
    (" Zhang\r\n San\tzhangsan@example.com ", "Zhang San zhangsan@example.com"),
    ("张三 zhangsan@example.com", ""), ("Zhang San", ""), ("", ""),
])
def test_sec_contact_same_rule_as_fetch_layer(monkeypatch, raw, want):
    import backtest.loader as loader
    monkeypatch.setenv("VRA_SEC_CONTACT", raw)
    assert loader.sec_contact() == want


def _bs_payload(adjustflag, rows):
    return {"query": {"code": "sh.600519", "adjustflag": adjustflag}, "rows": rows}


def _serve_a(monkeypatch, tmp_path, unadjusted):
    """前复权一份、不复权一份；``unadjusted`` 为 Exception 时第二次取数失败。"""
    import backtest.loader as loader
    qfq = _bs_payload("2", [
        {"date": "2024-01-02", "open": 5.0, "high": 5.2, "low": 4.9, "close": 5.1, "preclose": 5.0, "volume": 1e6, "turn": 1.0, "tradestatus": "1"},
        {"date": "2024-01-03", "open": 5.5, "high": 5.6, "low": 5.4, "close": 5.5, "preclose": 5.1, "volume": 1e6, "turn": 1.0, "tradestatus": "1"},
    ])
    for sub in ("", "unadjusted"):
        (tmp_path / sub / "raw").mkdir(parents=True, exist_ok=True)
    (tmp_path / "raw" / "q.json").write_text(json.dumps(qfq), encoding="utf-8")
    if isinstance(unadjusted, dict):
        (tmp_path / "unadjusted" / "raw" / "u.json").write_text(json.dumps(unadjusted), encoding="utf-8")
    seen = []

    def fake(endpoint, symbol, args, out_dir, *rest):
        seen.append(dict(args))
        if args.get("adjustflag") == "3":
            if isinstance(unadjusted, Exception):
                raise unadjusted
            return {"status": "ok", "extra": {"raw_files": ["raw/u.json"]}}
        return {"status": "ok", "extra": {"raw_files": ["raw/q.json"]}}
    monkeypatch.setattr(loader, "_run_fetch", fake)
    return seen


def test_a_share_adds_unadjusted_open_and_pre_close_for_limit_prices(tmp_path, monkeypatch):
    """第四轮审计 D2：涨跌停价要按不复权前收四舍五入到分算，前复权日线旁边补两列不复权价。"""
    raw = _bs_payload("3", [
        {"date": "2024-01-02", "open": 10.0, "preclose": 10.0, "tradestatus": "1"},
        {"date": "2024-01-03", "open": 11.0, "preclose": 10.2, "tradestatus": "1"},
    ])
    seen = _serve_a(monkeypatch, tmp_path, raw)
    ld = VibeLoader(out_dir=tmp_path)
    df = ld.fetch(["600519.SH"], "2024-01-01", "2024-01-31")["600519.SH"]
    assert df["raw_open"].tolist() == [10.0, 11.0] and df["raw_pre_close"].tolist() == [10.0, 10.2]
    assert df["open"].tolist() == [5.0, 5.5], "撮合仍用前复权价"
    assert [a.get("adjustflag") for a in seen] == [None, "3"] and seen[1]["fields"] == "date,open,preclose,tradestatus"
    prov = ld.provenance["600519.SH"]
    assert prov.raw_refs == ["raw/q.json", "unadjusted/raw/u.json"] and prov.note == ""

    # 少一天：那天退回近似判定，并写出来
    _serve_a(monkeypatch, tmp_path, _bs_payload("3", raw["rows"][:1]))
    ld = VibeLoader(out_dir=tmp_path)
    df = ld.fetch(["600519.SH"], "2024-01-01", "2024-01-31")["600519.SH"]
    assert df["raw_open"].isna().tolist() == [False, True]
    assert "1 根没有不复权价" in ld.provenance["600519.SH"].note


@pytest.mark.parametrize("unadjusted,why", [
    (None, "超时"),
    ({"query": {"code": "sh.600519", "adjustflag": "2"}, "rows": [{"date": "2024-01-02", "open": 5.0, "preclose": 5.0, "tradestatus": "1"}]}, "不是不复权价"),
    ({"query": {"code": "sz.000001", "adjustflag": "3"}, "rows": [{"date": "2024-01-02", "open": 5.0, "preclose": 5.0, "tradestatus": "1"}]}, "不是同一只票"),
    ({"query": {"code": "sh.600519", "adjustflag": "3"}, "rows": []}, "没有开盘价或前收"),
])
def test_unadjusted_prices_missing_never_block_the_backtest(tmp_path, monkeypatch, unadjusted, why):
    import backtest.loader as loader
    _serve_a(monkeypatch, tmp_path, loader.LoaderError("bs_kline_qfq 取 600519.SH 超时（120s）") if unadjusted is None else unadjusted)
    ld = VibeLoader(out_dir=tmp_path)
    df = ld.fetch(["600519.SH"], "2024-01-01", "2024-01-31")["600519.SH"]
    assert "raw_open" not in df.columns and len(df) == 2
    note = ld.provenance["600519.SH"].note
    assert why in note and "涨跌停按复权价近似判定" in note
    assert ld.provenance["600519.SH"].raw_refs == ["raw/q.json"]


def test_close_only_callers_skip_the_unadjusted_fetch(tmp_path, monkeypatch):
    seen = _serve_a(monkeypatch, tmp_path, AssertionError("不该取"))
    df = VibeLoader(out_dir=tmp_path, limit_prices=False).fetch(["600519.SH"], "2024-01-01", "2024-01-31")["600519.SH"]
    assert len(seen) == 1 and "raw_open" not in df.columns
    src = (pathlib.Path(__file__).resolve().parents[1] / "scenario_replay.py").read_text()
    assert "limit_prices=False" in src, "持仓回放只要收盘价"
