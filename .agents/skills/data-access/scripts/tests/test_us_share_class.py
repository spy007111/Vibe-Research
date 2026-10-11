"""带股份类别的美股（BRK.B）各源写法不同。2026-10-09 实测：腾讯 BRK.B、Yahoo BRK-B（BRK.B 回 404）、
东财 BRK_B（BRK.B 搜不到、公告接口静默回 0 条）、FINRA 日文件 BRK/B、SEC 映射表 BRK-B。全程不联网。"""
from __future__ import annotations

import pytest

from sources import _http as H
from sources import eastmoney as E
from sources import finra as F
from sources import sec as S
from sources import yahoo as Y


@pytest.mark.parametrize("raw,yahoo,em,finra", [
    ("BRK.B", "BRK-B", "BRK_B", "BRK/B"), ("brk-b", "BRK-B", "BRK_B", "BRK/B"), ("AAPL", "AAPL", "AAPL", "AAPL")])
def test_us_ticker_for_each_source(raw, yahoo, em, finra):
    assert (H.us_ticker_for("yahoo", raw), H.us_ticker_for("eastmoney", raw), H.us_ticker_for("finra", raw)) == (yahoo, em, finra)
    assert H.us_ticker_for("tencent", "BRK.B") == "BRK.B"
    assert Y.yahoo_symbol(raw) == yahoo and Y.yahoo_symbol("700", "HK") == "0700.HK"


def test_eastmoney_resolves_brk_b_by_its_own_spelling(monkeypatch):
    seen = []
    monkeypatch.setattr(E, "_GLOBAL_SECID", {})
    monkeypatch.setattr(E, "stock_search", lambda kw, n=10: seen.append(kw) or [{"code": "BRK_B", "mkt_num": 106}])
    assert E.resolve_global_secid("BRK.B", "US") == (106, "BRK_B")
    assert seen == ["BRK_B"]
    assert E._secucode("BRK.B", "US") == "BRK_B.N"


def test_finra_matches_slash_form(monkeypatch):
    monkeypatch.setattr(F, "_recent_weekdays", lambda n: ["20261008"])
    monkeypatch.setattr(F, "short_volume_all", lambda date, market: {"data": {"BRK/B": {"short": 1.0, "short_exempt": 0.0, "total": 2.0, "ratio": 0.5}}, "_raw": None})
    out = F.short_volume_symbol("BRK.B", days=1)
    assert [(r["date"], r["ratio"]) for r in out] == [("20261008", 0.5)]


def test_sec_cik_accepts_dot_or_dash(monkeypatch):
    monkeypatch.setattr(S, "_CIK_CACHE", {"0": {"ticker": "BRK-B", "cik_str": 1067983, "title": "BERKSHIRE HATHAWAY INC"}})
    assert S.ticker_to_cik("BRK.B")["cik"] == "0001067983"
    assert S.ticker_to_cik("brk-b")["cik"] == "0001067983"
    with pytest.raises(S.DataNotAvailable):
        S.ticker_to_cik("BRKB")
