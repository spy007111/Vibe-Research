"""a-stock-data v3.8–v3.10 移植端点:生成文件的联网入口全部落盘 / 默认日期 / 映射证据形状 / 失效的通达信行情命令。全部离线。"""
from __future__ import annotations

import ast
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
import requests

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[3]
sys.path.insert(0, str(SCRIPTS))
from common import TZ_SH  # noqa: E402
from sources import _http, astock_defaults as D, astock_ported as P, mappers_astock as M, mappers_cn, mootdx_src  # noqa: E402

PORTED = SCRIPTS / "sources" / "astock_ported.py"


def _reg() -> dict:
    return json.loads((REPO / "datasources" / "registry.json").read_text(encoding="utf-8"))


def _response(body: bytes, url: str = "https://example.invalid/a", ctype: str = "application/json", status: int = 200):
    r = requests.Response()
    r.status_code, r.url, r._content = status, url, body
    r.headers["Content-Type"] = ctype
    return r


# ---------- 生成文件:联网入口 ----------
def test_ported_network_calls_all_go_through_recording_wrappers():
    """生成文件里直接发请求的只能是两个落盘包装;上游新增的请求入口没走包装会在这里变红(否则证据指不到原文)。"""
    tree = ast.parse(PORTED.read_text(encoding="utf-8"))
    hits = []

    class V(ast.NodeVisitor):
        stack: list = []

        def visit_FunctionDef(self, n):
            self.stack.append(n.name)
            self.generic_visit(n)
            self.stack.pop()

        def visit_Call(self, n):
            f = n.func
            if isinstance(f, ast.Attribute) and f.attr in ("get", "post", "request", "put", "head", "urlopen"):
                base = ast.unparse(f.value)
                if any(k in base for k in ("requests", "session", "Session", "urllib")):
                    hits.append((self.stack[-1] if self.stack else "<module>", ast.unparse(f)))
            self.generic_visit(n)

    V().visit(tree)
    assert sorted(hits) == [("_v39_http", "(session or requests).request"), ("_vra_requests_get", "requests.get")]
    src = PORTED.read_text(encoding="utf-8")
    assert src.count("_vra_rec(response)  # VRA: 响应原文落盘") == 1
    assert src.count("_vra_call(session.get, ") == 2 and src.count("_vra_call(session.post, ") == 2
    assert P.UPSTREAM_VERSION == "3.10.1" and "勿手改" in src


def test_v39_http_records_raw_inside_capture(tmp_path, monkeypatch):
    monkeypatch.setattr(requests, "request", lambda method, url, **kw: _response(b'{"a": 1}', url))
    with _http.capture(str(tmp_path), "fixture", "probe") as cap:
        r = P._v39_http("https://example.invalid/x")
    assert r._vra_raw_ref == cap.last_raw_ref
    assert (tmp_path / cap.last_raw_ref).read_bytes() == b'{"a": 1}'
    assert cap.last_raw_ref.endswith(".json")


def test_zip_body_saved_with_zip_extension(tmp_path):
    with _http.capture(str(tmp_path), "fixture", "probe") as cap:
        P._vra_rec(_response(b"PK\x03\x04data", "https://example.invalid/20260930.zip", "application/octet-stream"))
    assert cap.last_raw_ref.endswith(".zip")


def test_em_get_routes_to_product_eastmoney_entry(monkeypatch):
    seen = {}
    monkeypatch.setattr(P, "_vra_em", lambda url, **kw: seen.update(url=url, **kw) or "resp")
    assert P.em_get("https://push2.eastmoney.com/x", params={"a": 1}, timeout=7) == "resp"
    assert seen == {"url": "https://push2.eastmoney.com/x", "params": {"a": 1}, "headers": None, "timeout": 7}
    with pytest.raises(TypeError):
        P.em_get("https://push2.eastmoney.com/x", verify=False)


# ---------- 默认日期 ----------
def _calendar(open_days: dict):
    def cal(year, month):
        days = pd.date_range(f"{year}-{month:02d}-01", periods=pd.Period(f"{year}-{month:02d}").days_in_month).strftime("%Y-%m-%d")
        return pd.DataFrame({"date": list(days), "is_open": [d in open_days.get((year, month), ()) for d in days]})
    return cal


OPEN = {(2026, 9): ("2026-09-29", "2026-09-30"), (2026, 10): ("2026-10-09", "2026-10-12")}


@pytest.mark.parametrize("now,after_hour,expected", [
    ("2026-10-09 18:00", 17, "2026-10-09"),   # 交易日收盘文件已发布
    ("2026-10-09 17:00", 17, "2026-10-09"),   # 整点即算已发布
    ("2026-10-09 10:00", 17, "2026-09-30"),   # 未到发布时间 → 上一个交易日(跨月回看)
    ("2026-10-09 10:00", 0, "2026-10-09"),    # 盘中快照
    ("2026-10-09 18:00", None, "2026-09-30"), # 次日才发布的数据永远不取今天
    ("2026-10-10 18:00", 17, "2026-10-09"),   # 周末
])
def test_latest_trading_day(monkeypatch, now, after_hour, expected):
    monkeypatch.setattr(P, "trading_calendar", _calendar(OPEN))
    monkeypatch.setattr(D, "_now", lambda: datetime.strptime(now, "%Y-%m-%d %H:%M").replace(tzinfo=TZ_SH))
    assert D.latest_trading_day(after_hour) == expected


def test_latest_trading_day_without_any_past_day_raises(monkeypatch):
    monkeypatch.setattr(P, "trading_calendar", _calendar({}))
    monkeypatch.setattr(D, "_now", lambda: datetime(2026, 10, 9, 18, tzinfo=TZ_SH))
    with pytest.raises(RuntimeError, match="日历"):
        D.latest_trading_day(17)


@pytest.mark.parametrize("hour,expected", [(19, "2026-10-08"), (21, "2026-10-09")])
def test_cctv_default_date_follows_broadcast_time(monkeypatch, hour, expected):
    seen = {}
    monkeypatch.setattr(D, "_now", lambda: datetime(2026, 10, 9, hour, tzinfo=TZ_SH))
    monkeypatch.setattr(P, "cctv_news", lambda date, with_content: seen.setdefault("date", date))
    D.cctv_news()
    assert seen["date"] == expected


def test_explicit_dates_are_passed_through_unchanged(monkeypatch):
    monkeypatch.setattr(D, "latest_trading_day", lambda h: pytest.fail("显式日期不应再查日历"))
    seen = []
    monkeypatch.setattr(P, "futures_daily", lambda d, ex: seen.append(("fd", d, ex)))
    monkeypatch.setattr(P, "margin_trading_backup", lambda d, ex, code: seen.append(("mg", d, ex, code)))
    D.futures_daily("2026-09-30", "CFFEX")
    D.margin_trading_backup("600519", market="SH", trade_date="2026-09-30")
    assert seen == [("fd", "2026-09-30", "CFFEX"), ("mg", "2026-09-30", "SH", "600519")]


def test_etf_shares_default_date_per_exchange(monkeypatch):
    seen = []
    monkeypatch.setattr(D, "latest_trading_day", lambda h: {None: "2026-09-30", 0: "2026-10-09"}[h])
    monkeypatch.setattr(P, "etf_shares", lambda d, ex: seen.append((d, ex)) or pd.DataFrame({"code": ["510300", "510500"], "shares_10k": [1.0, 2.0]}))
    D.etf_shares(exchange="SH")
    picked = D.etf_shares(exchange="SZ", codes="510300,159915")
    assert seen == [("2026-09-30", "SH"), ("2026-10-09", "SZ")]  # 上交所次日归档;深交所先试今天的快照
    assert list(picked["code"]) == ["510300"] and picked.attrs["unmatched_codes"] == ["159915"] and picked.attrs["total_rows"] == 2


def test_sz_etf_morning_falls_back_to_previous_day_snapshot(monkeypatch):
    # 交易日早上深交所快照还是上一交易日的确认值:今天对不上 → 用上一个交易日;显式日期不回退
    monkeypatch.setattr(D, "latest_trading_day", lambda h: {None: "2026-09-30", 0: "2026-10-09"}[h])
    seen = []

    def sz(d, ex):
        seen.append(d)
        if d != "2026-09-30":
            raise ValueError("深交所当前规模快照日期是 2026-09-30,不是 " + d)
        return pd.DataFrame({"code": ["159915"], "shares_10k": [1.0]})
    monkeypatch.setattr(P, "etf_shares", sz)
    assert list(D.etf_shares(exchange="SZ")["code"]) == ["159915"] and seen == ["2026-10-09", "2026-09-30"]
    with pytest.raises(ValueError, match="快照日期"):
        D.etf_shares("2026-10-09", "SZ")


def test_explicit_falsy_args_are_not_replaced_by_defaults(monkeypatch):
    monkeypatch.setattr(D, "latest_trading_day", lambda h: pytest.fail("显式参数不应再查日历"))
    seen = []
    monkeypatch.setattr(P, "futures_daily", lambda d, ex: seen.append(("fd", d)))
    monkeypatch.setattr(P, "chinabond_yield_curve", lambda start, end, curve: seen.append(("cb", start)))
    D.futures_daily("")
    D.chinabond_yield_curve("")
    assert seen == [("fd", ""), ("cb", "")]  # 交给上游校验并报错,不悄悄换成默认值
    monkeypatch.setattr(P, "tdx_daily_package", lambda d: pd.DataFrame({"market": ["sh"], "code": ["000001"]}))
    with pytest.raises(ValueError, match="codes"):
        D.tdx_daily_package("2026-09-30", codes="")


def test_tdx_package_filter_keeps_market_counts(monkeypatch):
    frame = pd.DataFrame({"market": ["sh", "sz", "sz", "bj"], "code": ["000001", "000001", "300308", "920982"], "close": [1.0, 2.0, 3.0, 4.0]})
    monkeypatch.setattr(P, "tdx_daily_package", lambda d: frame)
    picked = D.tdx_daily_package("2026-09-30", codes="sh000001,300308,sh600000")
    assert list(picked["close"]) == [1.0, 3.0]  # 带前缀只认该市场:sh000001 不会捞到 sz000001
    assert picked.attrs["market_counts"] == {"sz": 2, "sh": 1, "bj": 1} and picked.attrs["total_rows"] == 4
    assert picked.attrs["unmatched_codes"] == ["sh600000"]


# ---------- 映射 ----------
def _run(tmp_path, mapper, frame, *, symbol="MARKET", args=None, script="t_ep"):
    ctx = {"script": script, "symbol": symbol, "market": "CN", "source": "fixture", "endpoint": "ep", "as_of": None, "args": args or {}, "ep": {"id": script}}
    with _http.capture(str(tmp_path), "fixture", "ep") as cap:
        cap.record(b"transport", "json", "https://example.invalid/t")
        ctx["raw_ref"], ctx["raws"] = cap.last_raw_ref, cap.raws
        res = mapper(frame, ctx)
    for e in res["evidence"]:
        assert e["raw_ref"] and (tmp_path / e["raw_ref"]).exists(), e
        assert e["raw_ref"].split("/")[-1].startswith("extracted_"), e["raw_ref"]
    return res


def _rows_file(tmp_path, res) -> dict:
    return json.loads((tmp_path / res["evidence"][0]["raw_ref"]).read_text(encoding="utf-8"))


def test_extracted_rows_are_json_safe_and_list_transport(tmp_path):
    frame = pd.DataFrame({"date": ["2026-09-29", "2026-09-30"], "lpr_1y": [3.0, float("nan")], "lpr_5y": pd.array([3.5, None], dtype="Float64")})
    frame.attrs["n"] = pd.Series([1]).iloc[0]  # numpy int
    res = _run(tmp_path, M.lpr_history_map, frame)
    doc = _rows_file(tmp_path, res)
    assert doc["rows"][1] == {"date": "2026-09-30", "lpr_1y": None, "lpr_5y": None}
    assert doc["attrs"] == {"n": 1} and len(doc["transport_raw_refs"]) == 1
    assert not any(isinstance(v, float) and math.isnan(v) for r in doc["rows"] for v in r.values())


def _kline(code, adjust="qfq"):
    return pd.DataFrame({"code": [code] * 3, "adjust": [adjust] * 3, "date": ["2026-09-28", "2026-09-29", "2026-09-30"],
                         "open": [1.0, 2.0, 3.0], "high": [1.0, 2.0, 3.0], "low": [1.0, 2.0, 3.0], "close": [1.5, 2.5, 3.5], "volume": [10, 20, 30]})


@pytest.mark.parametrize("code,adjust,price_unit,vol_unit,adj", [
    ("sz300308", "qfq", "元", "手", "qfq"),
    ("sh688981", "hfq", "元", "股", "hfq"),    # 科创板成交量是股
    ("sh000001", "", "点", "手", "none"),      # 指数报点位
])
def test_tencent_kline_units_and_adjustment(tmp_path, code, adjust, price_unit, vol_unit, adj):
    res = _run(tmp_path, M.tencent_kline_map, _kline(code, adjust), symbol=code, args={"period": "day"})
    by = {e["field"]: e for e in res["evidence"]}
    close = by[f"kline_close_{adj}"]
    assert close["value"] == 3.5 and close["unit"] == price_unit and close["adjustment"] == adj and close["period"] == "2026-09-30"
    assert close["currency"] == ("CNY" if price_unit == "元" else "n/a")
    assert by["kline_volume"]["unit"] == vol_unit and by["kline_volume"]["currency"] == "n/a"
    hint = res["extra"]["calc_hint"]["history_json"]
    assert hint["rows_path"] == "rows" and _rows_file(tmp_path, res)["rows"][-1][hint["columns"]["close"]] == 3.5


def test_tencent_minute_kline_is_unadjusted(tmp_path):
    frame = pd.DataFrame({"code": ["sz300308"] * 2, "datetime": ["2026-09-30 14:59", "2026-09-30 15:00"], "open": [1.0, 2.0], "high": [1.0, 2.0],
                          "low": [1.0, 2.0], "close": [1.0, 2.0], "volume": [5, 6], "turnover_rate_pct": [0.1, 0.2]})
    res = _run(tmp_path, M.tencent_kline_map, frame, args={"period": "m1"})
    close = next(e for e in res["evidence"] if e["field"] == "kline_close_none")
    assert close["adjustment"] == "none" and close["as_of"] == "2026-09-30"


def test_tdx_package_volume_unit_only_stocks_are_shares(tmp_path):
    keys = [("sh", "999999"), ("sz", "300308"), ("sh", "510300"), ("sh", "688981"), ("bj", "920982"), ("sz", "159915"), ("sh", "113050")]
    n = len(keys)
    frame = pd.DataFrame({"date": ["2026-09-30"] * n, "market": [m for m, _ in keys], "code": [c for _, c in keys], "name": ["x"] * n,
                          "prev_close": [1.0] * n, "open": [1.0] * n, "high": [1.0] * n, "low": [1.0] * n, "close": [3300.0] + [8.0] * (n - 1),
                          "volume": [1] * n, "amount": [1.0] * n})
    frame.attrs.update(total_rows=51977, market_counts={"sh": 4, "sz": 2, "bj": 1}, unmatched_codes=[])
    res = _run(tmp_path, M.tdx_daily_package_map, frame)
    vol = {e["record_key"]: e["unit"] for e in res["evidence"] if e["field"] == "volume"}
    close = {e["record_key"]: e for e in res["evidence"] if e["field"] == "close"}
    # 上游只保证个股是股;指数 / ETF / 可转债按通达信原值标注
    assert vol == {"sh999999": "通达信原值", "sz300308": "股", "sh510300": "通达信原值", "sh688981": "股", "bj920982": "股",
                   "sz159915": "通达信原值", "sh113050": "通达信原值"}
    assert close["sh999999"]["unit"] == "点" and close["sz300308"]["unit"] == "元"
    assert res.get("status") is None


@pytest.mark.parametrize("complete,missing,status,phrase", [
    (True, [], None, None),                         # 15:31 后核对完整
    (False, [], "partial", "有缺笔"),                # 盘后金额对不上(末尾缺笔)
    (False, [5, 6, 7, 9], "partial", "中间缺 4 个序号"),  # 上游给逐个缺失序号的扁平列表
    (None, [], "partial", "未核对完整"),             # 盘中 / 15:31 前没法核对
])
def test_ticks_completeness_three_states(tmp_path, complete, missing, status, phrase):
    frame = pd.DataFrame({"date": ["2026-09-30"] * 2, "code": ["sz300308"] * 2, "time": ["09:25:00", "15:00:00"], "seq": [1, 2],
                          "price": [1.0, 1.1], "change": [0.0, 0.1], "volume": [10, 20], "amount": [100.0, 220.0], "side": ["B", "S"]})
    frame.attrs.update(complete=complete, missing_seq=missing)
    res = _run(tmp_path, M.tencent_ticks_map, frame)
    assert res.get("status") == status
    if phrase:
        assert phrase in res["degraded"]
    fields = {e["field"]: e["value"] for e in res["evidence"]}
    assert fields["tick_count"] == 2 and fields["tick_last_amount"] == 220.0
    assert not any(f.endswith("_sum") for f in fields)  # 合计属派生量,取数层不算


def test_etf_shares_map_has_no_totals(tmp_path):
    frame = pd.DataFrame({"date": ["2026-09-30"] * 2, "exchange": ["SZ"] * 2, "code": ["159915", "159919"], "name": ["a", "b"], "shares_10k": [1.0, 2.0]})
    res = _run(tmp_path, M.etf_shares_map, frame, args={"exchange": "SZ"})
    assert {e["field"] for e in res["evidence"]} == {"etf_count", "etf_shares"}
    assert all("预估" in (e.get("note") or "") for e in res["evidence"])


def _survey_detail(orgs, types, people, dates=None):
    n = len(orgs)
    dates = dates or ["2026-09-28"] * n
    return pd.DataFrame({"code": ["300308"] * n, "name": ["中际旭创"] * n, "notice_date": ["2026-09-30"] * n, "survey_date": dates,
                         "survey_end": [None] * n, "org_count": [2] * n, "survey_way": ["电话会议"] * n, "place": ["深圳"] * n,
                         "receptionist": ["董秘"] * n, "org_name": orgs, "org_type": types, "investigators": people})


def test_institution_survey_detail_counts_events_and_keeps_every_row(tmp_path):
    long_a, long_b = "长" * 200 + "甲资产管理", "长" * 200 + "乙资产管理"  # 只在很靠后的位置不同
    orgs = ["甲:乙", "甲", long_a, long_b, "丁基金", "丁基金", "丁基金", "戊基金"]
    people = ["丙", "乙:丙", None, None, "王", "赵", "赵", "钱"]      # 拼接有歧义的两行、同名不同人员、完全重复的一行
    types = ["基金", "基金", "基金", "基金", "基金", "基金", "基金", None]
    dates = ["2026-09-28"] * 2 + ["2026-09-18"] * 6
    res = _run(tmp_path, M.institution_survey_map, _survey_detail(orgs, types, people, dates), symbol="300308")
    by = {e["field"]: e for e in res["evidence"] if e["field"] in ("survey_count", "survey_org_rows")}
    assert by["survey_count"]["value"] == 2 and by["survey_org_rows"]["value"] == len(orgs)
    names = sorted(e["value"] for e in res["evidence"] if e["field"] == "survey_org_name")
    assert names == sorted(orgs)  # 每行都出证据,一行不丢
    assert len({e["id"] for e in res["evidence"]}) == len(res["evidence"]) and res["extra"]["duplicate_rows"] == 1
    for e in res["evidence"]:  # 记录键与本行字段对得上(键没有错位到别的行)
        if e["field"] == "survey_org_name":
            assert json.loads(M._rk_base(e["record_key"]))[3] == e["value"]
    types = [e["value"] for e in res["evidence"] if e["field"] == "survey_org_type"]
    assert types.count("基金") == 7  # 机构类型照样出证据;空类型那行不出


def test_institution_survey_duplicates_beyond_cap_are_counted(tmp_path):
    n = M.EV_CAP + 5
    orgs = [f"机构{i}" for i in range(n - 2)] + ["机构0", "机构0"]   # 两行重复落在上限之外
    res = _run(tmp_path, M.institution_survey_map, _survey_detail(orgs, ["基金"] * n, ["张"] * n), symbol="300308")
    assert res["extra"]["duplicate_rows"] == 2


@pytest.mark.parametrize("n,limit,partial", [(3, 3, True), (2, 3, False), (3, None, False)])
def test_event_rows_reaching_limit_are_partial(tmp_path, n, limit, partial):
    frame = pd.DataFrame({"code": ["300308"] * n, "name": ["x"] * n, "holder": [f"股东{i}" for i in range(n)], "direction": ["减持"] * n,
                          "change_shares_10k": [-1.0] * n, "change_pct_total": [0.1] * n, "after_pct_total": [1.0] * n, "avg_price": [None] * n,
                          "channel": ["二级市场"] * n, "start_date": ["2026-09-01"] * n, "end_date": ["2026-09-02"] * n, "notice_date": ["2026-09-03"] * n})
    res = _run(tmp_path, M.holder_trades_map, frame, symbol="300308", args={"limit": limit} if limit else {})
    assert (res.get("status") == "partial") is partial
    count = next(e for e in res["evidence"] if e["field"] == "holder_trade_count")
    assert ("上限" in (count.get("note") or "")) is partial
    detail = _survey_detail([f"机构{i}" for i in range(n)], ["基金"] * n, ["张"] * n)
    res = _run(tmp_path, M.institution_survey_map, detail, symbol="300308", args={"limit": limit, "detail": True} if limit else {})
    assert (res.get("status") == "partial") is partial


def test_ipo_calendar_full_page_is_not_partial(tmp_path):
    frame = pd.DataFrame({"code": ["001234", "301234"], "name": ["甲", "乙"], "apply_date": ["2026-10-09", "2026-10-10"], "issue_price": [10.0, 20.0],
                          "issue_pe": [20.0, 30.0], "win_rate_pct": [0.02, 0.03], "listing_date": [None, None], "exchange": ["SZ", "SZ"],
                          "board": ["主板", "创业板"], "apply_code": ["001234", "301234"]})
    res = _run(tmp_path, M.ipo_calendar_map, frame, args={"limit": 2})
    assert res.get("status") is None and "上限" in next(e for e in res["evidence"] if e["field"] == "ipo_count")["note"]


def test_unique_keys_never_collide_with_real_keys():
    keys = M._unique_keys(["k", "k", "k#2", "k"])
    assert len(set(keys)) == 4 and keys[0] == "k" and keys[2] == "k#2"


@pytest.mark.parametrize("n", [M.EV_CAP - 1, M.EV_CAP, M.EV_CAP + 1])
def test_institution_survey_detail_respects_evidence_cap(tmp_path, n):
    res = _run(tmp_path, M.institution_survey_map, _survey_detail([f"机构{i}" for i in range(n)], ["基金"] * n, ["张"] * n), symbol="300308")
    assert sum(1 for e in res["evidence"] if e["field"] == "survey_org_name") == min(n, M.EV_CAP)


def test_event_and_macro_rows_with_long_or_identical_keys_all_kept(tmp_path):
    long = "某某" * 100
    holders = pd.DataFrame({"code": ["300308"] * 3, "name": ["x"] * 3, "holder": [long + "甲", long + "乙", long + "乙"], "direction": ["减持"] * 3,
                            "change_shares_10k": [-1.0, -2.0, -3.0], "change_pct_total": [0.1, 0.2, 0.3], "after_pct_total": [1.0, 2.0, 3.0],
                            "avg_price": [None] * 3, "channel": ["二级市场"] * 3, "start_date": ["2026-09-01"] * 3, "end_date": ["2026-09-02"] * 3,
                            "notice_date": ["2026-09-03"] * 3})
    res = _run(tmp_path, M.holder_trades_map, holders, symbol="300308")
    assert sorted(e["value"] for e in res["evidence"] if e["field"] == "holder_change_shares") == [-3.0, -2.0, -1.0]
    assert len({e["id"] for e in res["evidence"]}) == len(res["evidence"])
    cal = pd.DataFrame({"time": ["2026-10-09 20:30"] * 3, "country": ["美国"] * 3, "title": ["长" * 150 + "A", "长" * 150 + "B", "长" * 150 + "B"],
                        "importance": [3, 3, 3], "actual": [1.0, 2.0, 2.0], "forecast": [None] * 3, "previous": [None] * 3, "unit": ["%"] * 3})
    res = _run(tmp_path, M.macro_calendar_map, cal)
    assert sorted(e["value"][-1] for e in res["evidence"] if e["field"] == "macro_event") == ["A", "B", "B"]
    assert len({e["id"] for e in res["evidence"]}) == len(res["evidence"])


@pytest.mark.parametrize("symbol,exchange,unit,currency", [
    ("IF2610", "CFFEX", "点", "n/a"), ("T2612", "CFFEX", "元/百元面值", "CNY"), ("rb2601", "SHFE", "元/交易所计价单位", "CNY"),
    ("IO2610-C-4000", "CFFEX", "点", "n/a"),
])
def test_futures_price_units(symbol, exchange, unit, currency):
    assert M._fut_price_unit(symbol, exchange) == (unit, currency)


@pytest.mark.parametrize("anomaly,partial", [(["2026-09-30"], True), (["2026-09-29"], False)])
def test_sge_silver_unit_and_anomaly_only_degrades_latest_day(tmp_path, anomaly, partial):
    frame = pd.DataFrame({"date": ["2026-09-29", "2026-09-30"], "instrument": ["Ag(T+D)"] * 2, "open": [1.0, 2.0], "high": [1.0, 2.0], "low": [1.0, 2.0], "close": [1.0, 2.1]})
    frame.attrs["ohlc_anomaly_dates"] = anomaly
    res = _run(tmp_path, M.sge_spot_map, frame, symbol="Ag(T+D)")
    close = next(e for e in res["evidence"] if e["field"] == "sge_close")
    assert close["unit"] == "元/千克" and close["currency"] == "CNY"
    assert (res.get("status") == "partial") is partial
    assert _rows_file(tmp_path, res)["attrs"]["ohlc_anomaly_dates"] == anomaly


def test_st_list_fallback_is_partial(tmp_path):
    frame = pd.DataFrame({"code": ["600001"], "market": ["SH"], "name": ["*ST 甲"], "st_type": ["*ST"], "price": [None], "pct_change": [None]})
    frame.attrs.update(coverage="沪深", fallback_reason="东财不可达")
    res = _run(tmp_path, M.st_stock_list_map, frame)
    assert res["status"] == "partial" and "baostock" in res["degraded"]


# 每个新映射在上游返回空表时都不抛错:要么 failed 给原因,要么 partial 给一条计数 0 的证据(raw_ref 指向 extracted 文件)
ASTOCK_MAPPERS = sorted({e["mapper"] for e in _reg()["endpoints"] if e.get("mapper_module") == "mappers_astock"})


@pytest.mark.parametrize("name", ASTOCK_MAPPERS)
def test_every_mapper_handles_empty_frame(tmp_path, name):
    empty = pd.DataFrame(columns=["date", "code", "name", "symbol", "exchange"])
    empty.attrs.update(total_rows=0, market_counts={}, unmatched_codes=["sh000001"])
    res = _run(tmp_path, getattr(M, name), empty, symbol="600519")
    assert res.get("status") in ("failed", "partial"), (name, res)
    if res["status"] == "failed":
        assert res.get("reason") and not res["evidence"]
    else:
        assert res["evidence"] and res["evidence"][0]["value"] == 0


# ---------- 注册表 ----------
def test_ported_endpoints_stay_out_of_research_stage_plan():
    eps = [e for e in _reg()["endpoints"] if e.get("mapper_module") == "mappers_astock"]
    assert len(eps) == 34  # 2026-10-10 删掉和在用源重复的新浪研报、深交所交易日历
    assert all(e["stages"] == {} and e["compliance"] == "cn-public" and e["module"] in ("astock_ported", "astock_defaults", "em_events") for e in eps)


def test_dead_tdx_market_commands_stay_removed():
    # 2026-10-10 删掉通达信 K 线 / 五档 / 逐笔(2026-09 起服务器不给数,上游 #52);上游 a-stock-data 仍留档,对账时别重新登记
    by = {e["id"]: e for e in _reg()["endpoints"]}
    assert not {"tdx_bars", "tdx_quotes", "tdx_transaction"} & set(by)
    assert {"tx_kline", "tdx_daily_package", "tx_ticks"} <= set(by)
    assert by["tdx_finance"]["enabled"] is True and by["tdx_f10"]["enabled"] is True


# ---------- 通达信:财务 / F10 按财务命令验活 ----------
class FakeTdx:
    """模拟 2026-09 以后的公开服务器:K 线 / 盘口 / 逐笔返回空,财务与 F10「最新提示」正常。"""

    def bars(self, **kw):
        return pd.DataFrame()

    def finance(self, **kw):
        return pd.DataFrame([{"code": kw["symbol"], "meigujingzichan": 200.99, "zongguben": 1.25e9, "liutongguben": 1.25e9, "updated_date": 20260815}])

    def F10C(self, **kw):
        return [{"name": "最新提示", "filename": "x.txt", "start": 0, "length": 10}]

    def F10(self, symbol, name):
        return "最新提示☆ 正文" if name == "最新提示" else {name: ""}  # 不存在的类别 mootdx 返回 dict 而不报错


@pytest.fixture
def fake_tdx(monkeypatch):
    from mootdx import quotes
    monkeypatch.setattr(mootdx_src, "_CLIENTS", {})
    monkeypatch.setattr(mootdx_src, "_probe", lambda ip, port, timeout=2.0: True)
    monkeypatch.setattr(quotes.Quotes, "factory", staticmethod(lambda **kw: FakeTdx()))


def test_finance_check_survives_dead_market_commands(fake_tdx):
    # FakeTdx 的 K 线返回空:验活要是改回拿 K 线验,这里就取不到客户端
    assert isinstance(mootdx_src.tdx_client(), FakeTdx)


def test_f10_uses_server_offered_categories(fake_tdx):
    assert mootdx_src.tdx_f10("600519") == {"最新提示": "最新提示☆ 正文"}
    out = mootdx_src.tdx_f10("600519", categories=["最新提示", "公司概况"])
    assert out["最新提示"] == "最新提示☆ 正文" and out["公司概况"].startswith("[取数失败] 服务器未提供该类别")


def test_f10_map_partial_when_some_categories_fail():
    ctx = {"script": "tdx_f10", "symbol": "600519", "market": "SH", "source": "mootdx", "endpoint": "tdx F10", "raw_ref": "raw/x.json", "raws": [], "as_of": None, "args": {}, "ep": {}}
    res = mappers_cn.tdx_f10_map({"最新提示": "正文", "公司概况": "[取数失败] 服务器未提供该类别"}, ctx)
    assert res["status"] == "partial" and "公司概况" in res["degraded"]
    assert [m["field"] for m in res["missing"]] == ["f10_text"] and "公司概况" in res["missing"][0]["reason"]
    assert mappers_cn.tdx_f10_map({"最新提示": "正文"}, ctx).get("status") is None
    assert mappers_cn.tdx_f10_map({"公司概况": "[取数失败] x", "最新提示": ""}, ctx)["status"] == "failed"


def test_tdx_finance_map_reads_bvps_and_update_date(fake_tdx):
    snap = mootdx_src.tdx_finance("600519")
    ctx = {"script": "tdx_finance", "symbol": "600519", "market": "SH", "source": "mootdx", "endpoint": "tdx finance", "raw_ref": "raw/x.json", "raws": [], "as_of": None, "args": {}, "ep": {}}
    res = mappers_cn.tdx_finance_map(snap, ctx)
    by = {e["field"]: e for e in res["evidence"]}
    assert by["bvps"]["value"] == 200.99 and by["bvps"]["period"] == "2026-08-15" and not res["missing"]
