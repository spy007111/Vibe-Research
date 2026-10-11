"""每日复盘新增的 5 个端点:涨跌分布 / 主要指数中长线 / 全市场两融 / 新浪成交额榜 / 新浪板块资金流。全程不联网。

重点测备源路径 —— 东财 push2 / push2his 被风控时整段断连(10-09 实测),复盘页靠这些备源才不空。
"""
from __future__ import annotations

import pandas as pd
import pytest

from test_registry_sources import _ctx
from sources import eastmoney, mappers, mappers_cn, sina
from sources import astock_ported, baostock_src, tencent


def _mctx(ep_id: str, **kw):
    return _ctx(symbol="MARKET", market="CN", ep={"id": ep_id}, **kw)


def _boom(*_a, **_k):
    raise ConnectionError("Remote end closed connection without response")


# ---------- 涨跌分布 ----------
_FENBU = {"data": {"qdate": 20261009, "fenbu": [{"11": 38, "-11": 6, "10": 12, "3": 400, "-3": 380, "0": 90, "1": 700, "-1": 650, "99": 1, "x": 2}]}}


def test_breadth_labels_and_exchange_counts(monkeypatch):
    monkeypatch.setattr(eastmoney, "em_json", lambda *_a, **_k: _FENBU)
    monkeypatch.setattr(eastmoney, "_push2_json", lambda *_a, **_k: {"data": {"diff": [
        {"f12": "000001", "f104": 1200, "f105": 1000, "f106": 80, "f6": 6.4e11},
        {"f12": "399106", "f104": 1500, "f105": 1300, "f106": 90, "f6": 7.3e11},
        {"f12": "899050", "f104": 150, "f105": "-", "f106": 10, "f6": 1.1e10}]}})
    r = eastmoney.market_breadth()
    assert r["date"] == "2026-10-09"
    labels = {b["key"]: b["label"] for b in r["buckets"]}
    assert labels[11] == "涨停" and labels[-11] == "跌停" and labels[10] == "涨超 9%(未涨停)"
    assert labels[3] == "涨 2~3%" and labels[-3] == "跌 2~3%" and labels[1] == "涨 0~1%" and labels[0] == "平盘"
    assert 99 not in labels, "越界档位不收"
    assert [b["key"] for b in r["buckets"]] == sorted(labels, reverse=True), "从涨停排到跌停"
    bj = next(x for x in r["exchanges"] if x["market"] == "BJ")
    assert bj["down"] is None, "上游缺值是 '-',要留空不能当 0"
    out = mappers.em_market_breadth_map(r, _mctx("em_market_breadth"))
    assert "status" not in out and out["missing"] == [], "全拿到时不标部分"
    assert not any(e["field"] == "market_down_count" and e["record_key"] == "exchange|BJ" for e in out["evidence"])
    assert out["extra"]["bucket_total"] == 38 + 6 + 12 + 400 + 380 + 90 + 700 + 650


def test_breadth_falls_back_to_tencent_amount_when_push2_refused(monkeypatch):
    monkeypatch.setattr(eastmoney, "em_json", lambda *_a, **_k: _FENBU)
    monkeypatch.setattr(eastmoney, "_push2_json", _boom)
    monkeypatch.setattr(tencent, "tencent_quotes", lambda codes: {c: {"amount_wan": 1000.0 * (i + 1), "quote_time": "20261009133000"} for i, c in enumerate(codes)})
    r = eastmoney.market_breadth()
    assert [x["source"] for x in r["exchanges"]] == ["tencent"] * 3
    assert r["exchanges"][0]["amount"] == 1000.0 * 1e4, "腾讯给的是万元"
    assert all(x["up"] is None for x in r["exchanges"]), "腾讯没有家数,不能编"
    out = mappers.em_market_breadth_map(r, _mctx("em_market_breadth"))
    assert out["status"] == "partial"
    assert not any(e["field"] == "market_up_count" for e in out["evidence"])
    amt = [e for e in out["evidence"] if e["field"] == "market_turnover_amount"]
    assert len(amt) == 3 and all(e["source"] == "tencent" for e in amt)
    assert any("腾讯" in m["reason"] for m in out["missing"])


def test_breadth_takes_date_from_tencent_when_distribution_also_missing(monkeypatch):
    monkeypatch.setattr(eastmoney, "em_json", _boom)
    monkeypatch.setattr(eastmoney, "_push2_json", _boom)
    monkeypatch.setattr(tencent, "tencent_quotes", lambda codes: {c: {"amount_wan": 1.0, "quote_time": "20260930150003"} for c in codes})
    r = eastmoney.market_breadth()
    assert r["buckets"] == [] and r["date"] == "2026-09-30", "节假日里腾讯成交时间停在上一个交易日,日期跟着它"
    out = mappers.em_market_breadth_map(r, _mctx("em_market_breadth"))
    assert out["status"] == "partial" and all(e["period"] == "2026-09-30" for e in out["evidence"])


def test_breadth_blank_exchanges_and_zero_amount_are_missing_not_values(monkeypatch):
    """东财三所全是「-」(盘前)不算取到、要报缺口;腾讯缺字段读成 0 的成交额不写「0 亿」;都没给日期时按交易所日历标。"""
    from sources import astock_defaults
    monkeypatch.setattr(eastmoney, "em_json", _boom)
    monkeypatch.setattr(eastmoney, "_push2_json", lambda *_a, **_k: {"data": {"diff": [
        {"f12": c, "f104": "-", "f105": "-", "f106": "-", "f6": "-"} for c in ("000001", "399106", "899050")]}})
    with pytest.raises(RuntimeError, match="都没取到"):
        eastmoney.market_breadth()
    monkeypatch.setattr(eastmoney, "_push2_json", lambda *_a, **_k: {"data": {"diff": [
        {"f12": "000001", "f104": 1200, "f105": 1000, "f106": 80, "f6": 6.4e11},
        {"f12": "399106", "f104": "-", "f105": "-", "f106": "-", "f6": "-"}]}})
    monkeypatch.setattr(astock_defaults, "latest_trading_day", lambda after_hour: "2026-09-30")
    r = eastmoney.market_breadth()
    assert [x["market"] for x in r["exchanges"]] == ["SH"] and r["date"] == "2026-09-30", "没有数据日时按交易所日历,不标本机今天"
    out = mappers.em_market_breadth_map(r, _mctx("em_market_breadth"))
    assert out["status"] == "partial" and any("空值" in m["reason"] for m in out["missing"])
    monkeypatch.setattr(eastmoney, "_push2_json", _boom)
    monkeypatch.setattr(tencent, "tencent_quotes", lambda codes: {c: {"amount_wan": 0.0 if c == "sz399106" else 500.0, "quote_time": "20261009100000"} for c in codes})
    r = eastmoney.market_breadth()
    assert {x["market"] for x in r["exchanges"]} == {"SH", "BJ"}, "成交额读成 0 的那家当没取到"


def test_breadth_raises_when_everything_missing(monkeypatch):
    monkeypatch.setattr(eastmoney, "em_json", _boom)
    monkeypatch.setattr(eastmoney, "_push2_json", _boom)
    monkeypatch.setattr(tencent, "tencent_quotes", _boom)
    with pytest.raises(RuntimeError, match="都没取到"):
        eastmoney.market_breadth()


# ---------- 主要指数中长线 ----------
def _days(n: int, start="2025-07-01"):
    return [d.strftime("%Y-%m-%d") for d in pd.bdate_range(start, periods=n)]


def _tx_frame(n: int, base=3000.0):
    ds = _days(n)
    return pd.DataFrame({"date": ds, "close": [base + i for i in range(n)]})


def test_trend_prefers_tencent_and_uses_eastmoney_for_bse(monkeypatch):
    seen = []
    monkeypatch.setattr(astock_ported, "tencent_kline", lambda code, **_k: seen.append(code) or _tx_frame(300))
    ds = _days(300)
    em_calls = []

    def fake_daily(secid, days):
        em_calls.append(secid)
        return [{"date": d, "close": 1000.0 + i, "amount": 1e11 + i, "_raw": None} for i, d in enumerate(ds[-days:])]

    monkeypatch.setattr(eastmoney, "_index_daily", fake_daily)
    r = eastmoney.market_index_trend(300)
    assert "sz899050" not in seen and "bj899050" not in seen, "北证50 腾讯没有历史,不该去腾讯取"
    src = {it["code"]: it["source"] for it in r["indices"]}
    assert src["899050"] == "eastmoney" and src["000001"] == "tencent" and len(src) == 8
    assert em_calls == ["0.899050", "1.000001", "0.399106"], "东财只用于北证50 和两市成交额"
    assert len(r["amount_rows"]) == 130 and r["amount_rows"][-1]["source"] == "eastmoney"
    assert r["amount_rows"][-1]["total"] == r["amount_rows"][-1]["sh"] + r["amount_rows"][-1]["sz"]
    assert r["failed"] == []


class _FakeBs:
    def __init__(self):
        self.codes = []

    def query_history_k_data_plus(self, code, fields, **_k):
        self.codes.append(code)
        return code


def test_trend_amount_falls_back_to_baostock_and_single_index_failure_is_partial(monkeypatch):
    def tx(code, **_k):
        if code == "sz399006":
            raise ConnectionError("tx down")
        return _tx_frame(300)

    monkeypatch.setattr(astock_ported, "tencent_kline", tx)
    monkeypatch.setattr(eastmoney, "_index_daily", _boom)
    fake = _FakeBs()

    class _Sess:
        def __enter__(self):
            return fake

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(baostock_src, "bs_session", lambda: _Sess())
    ds = _days(130)
    monkeypatch.setattr(baostock_src, "_rs_rows", lambda code: [{"date": d, "amount": str(8e11 if code == "sh.000001" else 9e11)} for d in ds] + [{"date": "x", "amount": ""}])
    r = eastmoney.market_index_trend(300)
    names = {f["name"] for f in r["failed"]}
    assert names == {"创业板指", "北证50"}, names
    assert fake.codes == ["sh.000001", "sz.399106"]
    assert len(r["amount_rows"]) == 130 and {x["source"] for x in r["amount_rows"]} == {"baostock"}
    assert r["amount_rows"][0]["total"] == 8e11 + 9e11
    out = mappers.em_market_trend_map(r, _mctx("em_market_trend"))
    assert out["status"] == "partial"
    assert sum(1 for e in out["evidence"] if e["field"] == "market_amount_total") == 60, "只放近 60 天"
    ma20 = next(e for e in out["evidence"] if e["field"] == "market_amount_ma20")
    assert ma20["value"] == round(1.7e12) and ma20["source"] == "baostock"
    assert "收盘前还没收完" not in ma20["note"], "最后一天不是今天,就不该说没收完"
    assert {m["field"] for m in out["missing"]} == {"index_close"}


def test_trend_amount_prior_averages_exclude_todays_partial_bar(monkeypatch):
    ds = _days(70)
    rows = [{"date": d, "sh": 1e12, "sz": 1e12, "total": 2e12, "source": "eastmoney"} for d in ds[:-1]]
    rows.append({"date": ds[-1], "sh": 4e11, "sz": 4e11, "total": 8e11, "source": "eastmoney"})  # 今天盘中,只有半天的量
    r = {"indices": [], "amount_rows": rows, "failed": []}
    monkeypatch.setattr(mappers, "today_str", lambda: ds[-1])
    from datetime import datetime
    from common import TZ_SH
    monkeypatch.setattr(mappers, "_now_sh", lambda: datetime(2026, 10, 9, 10, 30, tzinfo=TZ_SH))
    ev = {e["field"]: e for e in mappers.em_market_trend_map(r, _mctx("em_market_trend"))["evidence"] if e["field"].startswith("market_amount_ma")}
    assert ev["market_amount_ma20"]["value"] == round((19 * 2e12 + 8e11) / 20), "原来那组仍含今天"
    assert ev["market_amount_ma20_prior"]["value"] == round(2e12) and ev["market_amount_ma60_prior"]["value"] == round(2e12)
    assert ev["market_amount_ma20_prior"]["period"] == ds[-2] and "不含今天" in ev["market_amount_ma20_prior"]["note"]
    # 今天已经收盘(15:05 以后):最后一根收完了,不给 prior、也不写「还没收完」
    monkeypatch.setattr(mappers, "_now_sh", lambda: datetime(2026, 10, 9, 15, 30, tzinfo=TZ_SH))
    after = {e["field"]: e for e in mappers.em_market_trend_map(r, _mctx("em_market_trend"))["evidence"] if e["field"].startswith("market_amount_ma")}
    assert "market_amount_ma20_prior" not in after and "还没收完" not in after["market_amount_ma20"]["note"]
    # 最后一根不是今天:不给 prior(那组均值本来就全是收完的日子)
    monkeypatch.setattr(mappers, "_now_sh", lambda: datetime(2026, 10, 9, 10, 30, tzinfo=TZ_SH))
    monkeypatch.setattr(mappers, "today_str", lambda: "2099-01-01")
    fields = {e["field"] for e in mappers.em_market_trend_map(r, _mctx("em_market_trend"))["evidence"]}
    assert "market_amount_ma20_prior" not in fields and "market_amount_ma20" in fields


def test_trend_amount_missing_on_both_sources_is_reported_once(monkeypatch):
    monkeypatch.setattr(astock_ported, "tencent_kline", lambda *_a, **_k: _tx_frame(300))
    monkeypatch.setattr(eastmoney, "_index_daily", _boom)

    def no_session():
        raise RuntimeError("baostock 登录失败")

    monkeypatch.setattr(baostock_src, "bs_session", no_session)
    r = eastmoney.market_index_trend(300)
    out = mappers.em_market_trend_map(r, _mctx("em_market_trend"))
    amount_missing = [m for m in out["missing"] if m["field"] == "market_amount_total"]
    assert len(amount_missing) == 1 and "baostock" in amount_missing[0]["reason"]
    assert not any(e["field"].startswith("market_amount") for e in out["evidence"])


def test_trend_raises_when_no_index_at_all(monkeypatch):
    monkeypatch.setattr(astock_ported, "tencent_kline", _boom)
    monkeypatch.setattr(eastmoney, "_index_daily", _boom)
    with pytest.raises(RuntimeError, match="一条都没取到"):
        eastmoney.market_index_trend(300)
    with pytest.raises(ValueError):
        eastmoney.market_index_trend(10)


def test_trend_map_formulas():
    ds = _days(300, start="2025-08-01")
    closes = [3000.0 + i for i in range(300)]
    closes[100] = 5000.0  # 250 日窗口里的最高点
    rows = [{"date": d, "close": c, "_raw": None} for d, c in zip(ds, closes)]
    out = mappers.em_market_trend_map({"indices": [{"code": "000001", "name": "上证指数", "rows": rows, "source": "tencent"}], "amount_rows": [], "failed": []},
                                      _mctx("em_market_trend"))
    got = {e["field"]: e for e in out["evidence"]}
    last = closes[-1]
    assert got["index_close"]["value"] == last
    assert got["index_return_5d"]["value"] == round((last / closes[-6] - 1) * 100, 2)
    assert got["index_return_250d"]["value"] == round((last / closes[-251] - 1) * 100, 2)
    assert got["index_ma20"]["value"] == round(sum(closes[-20:]) / 20, 2)
    assert got["index_high_250d"]["value"] == 5000.0 and ds[100] in got["index_high_250d"]["note"]
    assert got["index_off_high_250d_pct"]["value"] == round((last / 5000.0 - 1) * 100, 2)
    prev = [(d, c) for d, c in zip(ds, closes) if d[:4] < ds[-1][:4]][-1]
    assert got["index_return_ytd"]["value"] == round((last / prev[1] - 1) * 100, 2) and prev[0] in got["index_return_ytd"]["note"]
    assert got["index_close"]["source"] == "tencent"
    assert out["status"] == "partial", "成交额没有就是部分"


def test_trend_map_short_history_skips_long_windows():
    rows = [{"date": d, "close": 100.0 + i, "_raw": None} for i, d in enumerate(_days(30))]
    out = mappers.em_market_trend_map({"indices": [{"code": "899050", "name": "北证50", "rows": rows, "source": "eastmoney"}],
                                       "amount_rows": [], "failed": []}, _mctx("em_market_trend"))
    fields = {e["field"] for e in out["evidence"]}
    assert "index_return_20d" in fields and "index_ma20" in fields
    assert not fields & {"index_return_60d", "index_ma60", "index_ma250", "index_high_250d", "index_return_250d"}, "历史不够就不算,不拿短窗口冒充"


# ---------- 全市场两融 ----------
def test_margin_history_and_map(monkeypatch):
    rows = [{"DIM_DATE": f"2026-10-0{d} 00:00:00", "RZRQYE": 2.5e12 + d, "RZYE": 2.48e12, "RQYE": 2e10, "RZMRE": 1.5e11, "RZJME": -3e9 + d, "RZYEZB": 2.4}
            for d in (8, 7, 6)]
    seen = {}
    monkeypatch.setattr(eastmoney, "_dc_strict", lambda name, flt, **k: seen.update(name=name, **k) or rows)
    r = eastmoney.market_margin_history(5)
    assert seen["name"] == "RPTA_RZRQ_LSHJ" and seen["page_size"] == 5
    assert r[0]["date"] == "2026-10-08"
    out = mappers.em_market_margin_map(r, _mctx("em_market_margin"))
    bal = [e for e in out["evidence"] if e["field"] == "market_margin_balance"]
    assert [e["period"] for e in bal] == ["2026-10-06", "2026-10-07", "2026-10-08"]
    latest = {e["field"]: e for e in out["evidence"] if e["record_key"] == "margin|latest"}
    assert set(latest) == {"market_financing_balance", "market_short_balance", "market_financing_buy", "market_financing_float_pct"}
    assert all(e["period"] == "2026-10-08" for e in latest.values())
    with pytest.raises(ValueError):
        eastmoney.market_margin_history(1)
    assert mappers.em_market_margin_map([], _mctx("em_market_margin"))["status"] == "failed"


# ---------- 新浪备源 ----------
class _Resp:
    def __init__(self, text):
        self.text = text


def test_sina_turnover_rank_units_and_total(monkeypatch):
    payload = '[{"code":"300750","name":"宁德时代","trade":"400.1","changepercent":"2.5","amount":"12000000000","mktcap":"180000000","nmc":"150000000","turnoverratio":"0.8"},' \
              '{"code":"bad","name":"x"},{"code":"600519","name":"贵州茅台","trade":"","changepercent":"-1","amount":"9000000000","mktcap":"","nmc":null,"turnoverratio":"0.3"}]'

    def fake(url, **_k):
        return _Resp('"5432"' if url.endswith("getHQNodeStockCount") else payload)

    monkeypatch.setattr(sina, "http_get", fake)
    r = sina.sina_turnover_rank(3)
    assert r["total"] == 5432 and r["returned"] == 2
    top = r["rows"][0]
    assert top["amount"] == 1.2e10 and top["mcap"] == 1.8e8 * 1e4, "新浪市值是万元,要换成元"
    assert r["rows"][1]["price"] is None and r["rows"][1]["mcap"] is None, "空值留空,不当 0"
    out = mappers_cn.sina_turnover_rank_map(r, _mctx("sina_turnover_rank"))
    rank = [e for e in out["evidence"] if e["field"] == "turnover_rank"]
    assert [e["value"] for e in rank] == [1, 3] and "新浪沪深京 A 股,共 5432 只" in rank[0]["note"]
    assert not any(e["field"] == "last_price" and e["record_key"] == "stock|600519" for e in out["evidence"])
    with pytest.raises(ValueError):
        sina.sina_turnover_rank(0)


def test_sina_turnover_rank_rejects_non_list(monkeypatch):
    monkeypatch.setattr(sina, "http_get", lambda *_a, **_k: _Resp("null"))
    with pytest.raises(RuntimeError):
        sina.sina_turnover_rank(5)


def test_sina_board_flow_converts_fractions(monkeypatch):
    payload = '[{"category":"new_dzxx","name":"电子信息","avg_changeratio":"0.0123","netamount":"1500000000","inamount":"9e9","outamount":"7.5e9","ratioamount":"0.05",' \
              '"ts_name":"某股","ts_changeratio":"0.1"},{"category":"x"}]'
    monkeypatch.setattr(sina, "http_get", lambda *_a, **_k: _Resp(payload))
    r = sina.sina_board_flow("industry")
    assert len(r["rows"]) == 1
    row = r["rows"][0]
    assert row["change_pct"] == 1.23 and row["net_ratio"] == 5.0 and row["leader_pct"] == 10.0, "新浪给小数,要乘 100"
    out = mappers_cn.sina_board_flow_map(r, _mctx("sina_board_flow"))
    fields = {e["field"] for e in out["evidence"]}
    assert fields == {"board_net_sina", "board_inflow_sina", "board_outflow_sina", "board_change_pct_sina", "board_net_ratio_sina"}
    assert all("不是东财主力净额" in e["note"] for e in out["evidence"])
    with pytest.raises(ValueError):
        sina.sina_board_flow("area")


# ---------- 打板池明细不被截断 ----------
def test_zt_pool_keeps_all_rows_by_default_and_flags_truncation():
    rows = [{"code": f"{600000 + i}", "name": f"股{i}", "pct": 10.0, "limit_days": 1, "seal_fund": 1e8, "break_times": 0, "turnover": 5.0,
             "price": 11.39, "amount": 6.4e7, "float_cap": 1.19e10} for i in range(260)]
    out = mappers.em_zt_pools(rows, _mctx("em_zt_pool", args={"date": "20261009"}))
    assert len({e.get("record_key") for e in out["evidence"] if e.get("record_key")}) == 260, "火热的日子涨停两三百只,默认要放全"
    assert "status" not in out
    # 那一天的价格 / 成交额 / 流通市值跟池子一起给 —— 页面不再另拉实时行情补(看上一个交易日时那是今天的价)
    one = {e["field"]: (e["value"], e["unit"]) for e in out["evidence"] if e.get("record_key") == "600000"}
    assert one["pool_price"] == (11.39, "元") and one["pool_amount"] == (6.4e7, "元") and one["pool_float_cap"] == (1.19e10, "元")
    cut = mappers.em_zt_pools(rows, _mctx("em_zt_pool", args={"date": "20261009", "limit": 100}))
    assert cut["status"] == "partial" and "只放了前 100 只" in cut["missing"][0]["reason"]


def test_trend_end_cuts_bars_after_review_day(monkeypatch):
    """盘中看上一个交易日:end 之后那根(今天没收完的)不能算进「当日 / 5 日涨跌」,成交额也一样截。"""
    asked = []
    monkeypatch.setattr(astock_ported, "tencent_kline", lambda code, count=0, **_k: asked.append(count) or _tx_frame(count))
    ds = _days(320)

    def fake_daily(secid, days):
        return [{"date": d, "close": 1000.0 + i, "amount": 1e11 + i, "_raw": None} for i, d in enumerate(ds[:days])]

    monkeypatch.setattr(eastmoney, "_index_daily", fake_daily)
    cut = _days(310)[-2]  # 腾讯那份的倒数第二天
    r = eastmoney.market_index_trend(300, end=cut.replace("-", ""))
    assert asked and set(asked) == {310}, "截掉几根要多取几根,250 日窗口才凑得满"
    for it in r["indices"]:
        assert it["rows"][-1]["date"] <= cut, it["code"]
    sh = next(it for it in r["indices"] if it["code"] == "000001")
    assert sh["rows"][-1]["date"] == cut and len(sh["rows"]) == 309
    assert r["amount_rows"] and all(a["date"] <= cut for a in r["amount_rows"])
    out = mappers.em_market_trend_map(r, _mctx("em_market_trend"))
    close = next(e for e in out["evidence"] if e["record_key"] == "index|000001" and e["field"] == "index_close")
    assert close["period"] == cut and close["value"] == 3000.0 + 308
    # 不传 end:原样用到最新一根
    asked.clear()
    r2 = eastmoney.market_index_trend(300)
    assert set(asked) == {300}
    assert next(it for it in r2["indices"] if it["code"] == "000001")["rows"][-1]["date"] == _days(300)[-1]
    with pytest.raises(ValueError, match="end"):
        eastmoney.market_index_trend(300, end="2026/10/08")
