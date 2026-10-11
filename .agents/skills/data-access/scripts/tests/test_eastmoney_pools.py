"""东财涨停 / 炸板 / 跌停池取数(`_em_zt_api`)和旧端点映射的失败语义。全程不联网。

和 Vibe AStock 同一套修正(2026-10-11 审计):上游回落到别的交易日、开盘前、业务错误都不能读成空池,
涨停池为空不写成「0 只」。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from test_registry_sources import _ctx
from sources import eastmoney as em
from sources import mappers as MP

TZ_SH = em.TZ_SH


def test_upstream_fallback_to_an_earlier_session_is_not_a_pool(monkeypatch):
    """周末 / 开盘前请求今天,上游回最近一个交易日的池子;qdate 早于请求日期 = 这一天还没数据 ⇒ 抛错(空池会被读成 0 家)。历史日期照常放行。"""
    resp = {"rc": 0, "data": {"qdate": 20261009, "tc": 1, "pool": [{"c": "600000", "n": "甲"}]}}
    seen = []
    monkeypatch.setattr(em, "em_json", lambda url, params=None, **k: seen.append(params["date"]) or resp)
    monkeypatch.setattr(em, "_now_sh", lambda: datetime(2026, 10, 11, 12, 0, tzinfo=TZ_SH))
    for day in ("20261010", "2026-10-12"):
        with pytest.raises(RuntimeError, match="还没有"):
            em._em_zt_api("getTopicZTPool", "fbt:asc", day)
    assert len(em._em_zt_api("getTopicZTPool", "fbt:asc", "20261009")) == 1
    assert len(em._em_zt_api("getYesterdayZTPool", "zs:desc", "20260930")) == 1, "历史日期的 qdate 也是最新行情日,不能拦"
    resp["data"].pop("qdate")
    assert len(em._em_zt_api("getTopicZTPool", "fbt:asc", "20261010")) == 1, "没有 qdate 时不猜"


@pytest.mark.parametrize("hm, blocked", [((9, 0), True), ((9, 24), True), ((9, 25), False), ((15, 0), False)])
def test_today_before_call_auction_match_is_refused_without_asking(monkeypatch, hm, blocked):
    """开盘前上游什么时候把 qdate 切到今天没实测:要是先切日期、池子还没清,qdate 核对拦不住昨天的池子
    ⇒ 09:25 前请求今天一律不发请求、直接报还没开盘。"""
    resp = {"rc": 0, "data": {"qdate": 20261012, "pool": [{"c": "600000", "n": "昨天的票"}]}}
    seen: list = []
    monkeypatch.setattr(em, "em_json", lambda url, params=None, **k: seen.append(params["date"]) or resp)
    monkeypatch.setattr(em, "_now_sh", lambda: datetime(2026, 10, 12, *hm, tzinfo=TZ_SH))
    if blocked:
        with pytest.raises(RuntimeError, match="09:25"):
            em._em_zt_api("getTopicZTPool", "fbt:asc", "2026-10-12")
        assert seen == []
    else:
        assert len(em._em_zt_api("getTopicZTPool", "fbt:asc", "20261012")) == 1
    assert len(em._em_zt_api("getTopicZTPool", "fbt:asc", "20261009")) == 1, "别的日子不受影响"


def test_business_error_is_a_failure_not_an_empty_pool(monkeypatch):
    """HTTP 200 + rc 非 0 + data null(10-11 实测 rc=102 / 205)= 失败;只有 rc=0 的空列表才是空池。"""
    resp: dict = {"rc": 205, "data": None}
    monkeypatch.setattr(em, "em_json", lambda url, params=None, **k: resp)
    monkeypatch.setattr(em, "_now_sh", lambda: datetime(2026, 10, 11, 12, 0, tzinfo=TZ_SH))
    with pytest.raises(RuntimeError, match="rc=205"):
        em._em_zt_api("getTopicZBPool", "fbt:asc", "20261009")
    resp.update(rc=0, data="坏")
    with pytest.raises(RuntimeError, match="格式不对"):
        em._em_zt_api("getTopicZBPool", "fbt:asc", "20261009")
    resp.update(rc=0, data={"qdate": 20261009, "pool": "坏"})
    with pytest.raises(RuntimeError, match="格式不对"):
        em._em_zt_api("getTopicZBPool", "fbt:asc", "20261009")
    resp.update(rc=0, data={"qdate": 20261009, "pool": []})
    assert em._em_zt_api("getTopicDTPool", "fund:asc", "20261009") == []


def test_legacy_pool_endpoints_never_write_zero_limit_ups():
    """em_zt_pool / em_limit_up_sentiment:涨停池空(超出保留期 / 非交易日)不出「0 只」证据;跌停池空照旧记 0 并标 partial。"""
    for ep in ("em_zt_pool", "em_yzt_pool"):
        r = MP.em_zt_pools([], _ctx(symbol="MARKET", market="CN", source="eastmoney", ep={"id": ep}, args={"date": "20260801"}))
        assert r["status"] == "failed" and not r["evidence"], ep
    r = MP.em_zt_pools([], _ctx(symbol="MARKET", market="CN", source="eastmoney", ep={"id": "em_dt_pool"}, args={"date": "20261009"}))
    assert r["status"] == "partial" and r["evidence"][0]["value"] == 0
    r = MP.em_limit_up_sentiment({"date": "20260801", "zt_count": 0, "zb_count": 3, "dt_count": 0},
                                 _ctx(symbol="MARKET", market="CN", source="eastmoney", ep={"id": "em_limit_up_sentiment"}))
    assert r["status"] == "failed" and not r["evidence"]
