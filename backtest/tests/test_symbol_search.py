"""找标的：候选只留三地可处理的品种、港股按港交所号段去掉权证牛熊证、批量只在唯一时替用户选、接口不通的提示。

联想接口的返回样本取自 2026-10-08 实测（searchapi.eastmoney.com/api/suggest/get，type=14）。
"""
from __future__ import annotations

import io
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest import symbol_search as S  # noqa: E402
import sources.eastmoney as em  # noqa: E402  (symbol_search 导入时已把取数层脚本目录放进 sys.path)


def row(code, name, mkt, stype, classify="", pinyin=""):
    return {"Code": code, "Name": name, "MktNum": mkt, "SecurityTypeName": stype, "Classify": classify, "PinYin": pinyin}


TENCENT = [
    row("00700", "腾讯控股", "116", "港股", "HK", "TXKG"),
    row("80700", "腾讯控股-R", "116", "港股", "HK", "TXKGR"),          # 人民币柜台
    row("01698", "腾讯音乐-SW", "116", "港股", "HK", "TXYYSW"),
    row("TME", "腾讯音乐", "106", "美股", "UsStock", "TXYY"),
    row("000847", "腾讯济安", "1", "指数", "Index", "TXJA"),          # 指数
    row("BK1189", "腾讯云", "90", "板块", "BK", "TXY"),               # 板块
    row("13005", "腾讯法兴七三购A", "116", "港股", "HK", "TXFXQSGA"),  # 衍生权证
    row("TCTZF", "腾讯控股", "153", "粉单", "OTCBB", "TXKG"),          # 美国粉单
    row("TCHV6", "腾讯控股期货2610", "130", "期货", "HKSTOCKF", "TXKGQH"),
]

SAMPLES = {
    "腾讯": TENCENT,
    "gzmt": [row("600519", "贵州茅台", "1", "沪A", "AStock", "GZMT")],
    "茅台": [row("600519", "贵州茅台", "1", "沪A", "AStock", "GZMT"), row("BK0999", "茅指数", "90", "板块", "BK", "MZS")],
    "430047": [row("920047", "诺思兰德", "0", "京A", "NEEQ", "NSLD")],
    "中国平安": [row("601318", "中国平安", "1", "沪A", "AStock", "ZGPA"), row("02318", "中国平安", "116", "港股", "HK", "ZGPA"),
               row("82318", "中国平安-R", "116", "港股", "HK", "ZGPAR")],
    "ndsd": [row("300750", "宁德时代", "0", "深A", "AStock", "NDSD"), row("03750", "宁德时代", "116", "港股", "HK", "NDSD"),
             row("IBCA", "iShares iBonds Dec 2035 Term Co", "107", "美股", "UsStock", "ISHARESIBONDSDEC2035TERMCO")],
    "AAPL": [row("AAPL", "苹果", "105", "美股", "UsStock", "PG"), row("AAPL22", "Apple Inc Notes 2022", "105", "美股", "UsStock", "")],
    "伯克希尔": [row("BRK_A", "伯克希尔哈撒韦-A", "106", "美股", "UsStock", "BKXEHSWA"), row("BRK_B", "伯克希尔哈撒韦-B", "106", "美股", "UsStock", "BKXEHSWB")],
    "pa": [row("4766", "PA", "176", "日股", "JPX", "PA"), row("000001", "平安银行", "0", "深A", "AStock", "PAYH"),
           row("601318", "中国平安", "1", "沪A", "AStock", "ZGPA"), row("835688", "平安环保", "0", "三板", "NEEQ", "PAHB")],
}


@pytest.fixture
def fake(monkeypatch):
    calls = []

    def suggest(keyword, count=10):
        calls.append((keyword, count))
        return [dict(r) for r in SAMPLES.get(keyword, [])]
    monkeypatch.setattr(em, "suggest_rows", suggest)
    return calls


def test_candidates_keep_only_three_markets_and_drop_hk_derivatives(fake):
    got = S.search("腾讯")
    assert [m["symbol"] for m in got] == ["00700.HK", "01698.HK", "TME"], "指数 / 板块 / 权证 / 人民币柜台 / 粉单 / 期货都不进候选"
    assert got[0] == {"symbol": "00700.HK", "name": "腾讯控股", "market": "HK", "kind": "港股", "board": "港股", "pinyin": "TXKG"}
    assert fake == [("腾讯", S.FETCH_COUNT)], "向接口多要一些，筛掉之后才够数"


@pytest.mark.parametrize("r, want", [
    (row("688981", "中芯国际", "1", "科创板", "23"), ("688981", "CN", "股票")),
    (row("300750", "宁德时代", "0", "深A", "AStock"), ("300750", "CN", "股票")),
    (row("920047", "诺思兰德", "0", "京A", "NEEQ"), ("920047", "CN", "股票")),
    (row("510300", "沪深300ETF华泰柏瑞", "1", "基金", "Fund"), ("510300", "CN", "场内基金")),
    (row("02800", "盈富基金", "116", "港股", "HK"), ("02800.HK", "HK", "港股")),
    (row("09988", "阿里巴巴-W", "116", "港股", "HK"), ("09988.HK", "HK", "港股")),
    (row("BRK_B", "伯克希尔哈撒韦-B", "106", "美股", "UsStock"), ("BRK.B", "US", "美股")),
    (row("SPY", "标普500ETF-SPDR", "107", "美股", "UsStock"), ("SPY", "US", "美股")),
])
def test_kept_rows(r, want):
    m = S._match_of(r)
    assert (m["symbol"], m["market"], m["kind"]) == want


@pytest.mark.parametrize("r", [
    row("833700", "阿斯克", "0", "三板", "NEEQ"),                 # 新三板
    row("028004", "鑫元金鑫回报混合A", "150", "基金", "OTCFUND"),   # 场外基金
    row("500700", "鑫驰5A3", "0", "债券", "Bond"),
    row("10011443", "300ETF购12月4400", "10", "期权", "Option"),
    row("14203", "盈富麦银七五购A", "116", "港股", "HK"),            # 衍生权证 10000–29999
    row("47001", "某界内证", "116", "港股", "HK"),                  # 界内证 47000–48999
    row("55555", "某牛熊证", "116", "港股", "HK"),                  # 牛熊证 49500–69999
    row("89988", "阿里巴巴-WR", "116", "港股", "HK"),               # 人民币柜台 80000–89999
    row("BRK", "布鲁克斯麦克唐纳集团", "155", "英股", "LSE"),
    row("3153", "八洲电机", "176", "日股", "JPX"),
    row("AP610", "苹果610", "115", "期货", "Futures"),
    row("", "空代码", "1", "沪A", "AStock"),
])
def test_dropped_rows(r):
    assert S._match_of(r) is None


def test_limit_and_dedupe(fake, monkeypatch):
    monkeypatch.setitem(SAMPLES, "dup", [row("600519", "贵州茅台", "1", "沪A")] * 3 + [row("000001", "平安银行", "0", "深A")])
    assert [m["symbol"] for m in S.search("dup")] == ["600519", "000001"]
    assert len(S.search("腾讯", limit=1)) == 1


def test_api_failure_says_type_the_code(monkeypatch, capsys):
    def boom(*_a, **_k):
        raise ConnectionError("reset")
    monkeypatch.setattr(em, "suggest_rows", boom)
    with pytest.raises(S.SearchError, match="直接输入代码"):
        S.search("茅台")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"query": "茅台"})))
    S.main()
    d = json.loads(capsys.readouterr().out)
    assert d["ok"] is False and "直接输入代码" in d["error"]


@pytest.mark.parametrize("q, pick, reason", [
    ("AAPL", "AAPL", "代码一致"),
    ("gzmt", "600519", "拼音一致"),
    ("茅台", "600519", "只有一个候选"),
    ("430047", "920047", "代码已变更：430047 → 920047"),
])
def test_resolve_picks_when_unique(fake, q, pick, reason):
    it = S.resolve(q, S.search(q))
    assert it["pick"]["symbol"] == pick
    assert it["reason"] == reason


def test_resolve_exact_pinyin_beats_partial(fake, monkeypatch):
    monkeypatch.setitem(SAMPLES, "txkg", [row("00700", "腾讯控股", "116", "港股", "HK", "TXKG"), row("01698", "腾讯音乐-SW", "116", "港股", "HK", "TXYYSW")])
    it = S.resolve("txkg", S.search("txkg"))
    assert it["pick"]["symbol"] == "00700.HK" and it["reason"] == "拼音一致"
    name = S.resolve("腾讯控股", S.search("腾讯"))
    assert name["pick"]["symbol"] == "00700.HK" and name["reason"] == "名称一致"


@pytest.mark.parametrize("q, reason", [
    ("中国平安", "名称一致的有 2 个，请选一个"),   # A 股和港股同名
    ("ndsd", "拼音一致的有 2 个，请选一个"),
    ("pa", "有 2 个可能，请选一个"),
    ("伯克希尔", "有 2 个可能，请选一个"),
])
def test_resolve_leaves_ambiguity_to_user(fake, q, reason):
    it = S.resolve(q, S.search(q))
    assert it["pick"] is None and it["reason"] == reason


def test_ambiguous_rule_narrows_candidates(fake):
    it = S.build({"queries": ["ndsd", "pa"]})["items"]
    assert [m["symbol"] for m in it[0]["matches"]] == ["300750", "03750.HK"], "拼音一致的两个宁德时代，美股债券 ETF 不列"
    assert len(it[1]["matches"]) == 2, "没有规则命中时交回全部候选"


def test_resolve_explicit_codes_survive_empty_search(fake):
    it = S.resolve("BRK.B", [])
    assert it["pick"]["symbol"] == "BRK.B" and it["pick"]["market"] == "US"
    assert "按代码原样使用" in it["reason"]
    assert S.resolve("hk700", [])["pick"]["symbol"] == "00700.HK"
    assert S.resolve("600519", [])["pick"]["market"] == "CN"
    letters = S.resolve("zzzqqq", [])
    assert letters["pick"] is None and letters["reason"] == "没找到", "纯字母搜不到不能自动当美股代码（可能是拼错的拼音）"
    assert S.resolve("茅台啊", [])["pick"] is None


# 和前端 lib/marketSymbol.ts 的 normalizeMarketSymbol 同一张表（desktop/test/symbol_search.test.ts 直接读这张表，改格式要两边一起看）
NORMALIZE = [
    ("600519", "600519"), ("sh600519", "600519"), ("600519.SZ", "600519"), ("bj920047", "920047"),
    ("700", "00700.HK"), ("hk700", "00700.HK"), ("HK:00700", "00700.HK"), ("00700.hk", "00700.HK"),
    ("AAPL", "AAPL"), ("usAAPL", "AAPL"), ("US:aapl", "AAPL"), ("brk.b", "BRK.B"), ("USB", "USB"),
    ("gzmt", "GZMT"), ("茅台", None), ("", None), ("600519x", None), ("1234567", None),
]


@pytest.mark.parametrize("text, want", NORMALIZE)
def test_normalize_code_matches_frontend(text, want):
    assert S.normalize_code(text) == want


def test_batch(fake):
    out = S.build({"queries": ["茅台", "中国平安", "BRK.B", "zzzqqq"]})
    items = out["items"]
    assert [(i["query"], (i["pick"] or {}).get("symbol")) for i in items] == [
        ("茅台", "600519"), ("中国平安", None), ("BRK.B", "BRK.B"), ("zzzqqq", None)]
    assert [m["symbol"] for m in items[1]["matches"]] == ["601318", "02318.HK"], "有歧义时候选交回去"
    assert items[3]["code"] == "ZZZQQQ", "界面可以问用户「就按美股代码加？」"
    assert items[0]["code"] is None


@pytest.mark.parametrize("req, msg", [
    ({}, "搜索词要是文字"),
    ({"query": "  "}, "空的"),
    ({"query": 600519}, "要是文字"),
    ({"query": "茅" * 31}, "太长"),
    ({"query": "茅台", "limit": 0}, "limit"),
    ({"query": "茅台", "limit": True}, "limit"),
    ({"query": "茅台", "limit": 21}, "limit"),
    ({"queries": []}, "非空列表"),
    ({"queries": "茅台"}, "非空列表"),
    ({"queries": ["a"] * 31}, "最多"),
    ({"queries": ["茅台", ""]}, "空的"),
])
def test_bad_requests(fake, req, msg):
    with pytest.raises(S.SearchError, match=msg):
        S.build(req)


def test_main_catalog(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"action": "catalog"})))
    S.main()
    d = json.loads(capsys.readouterr().out)
    assert d["ok"] is True and "拼音" in d["catalog"]["description"]
