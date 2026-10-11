"""港美股业绩发布日(hkex.hk_results_announcements / eastmoney.us_earnings_8k / sec.earnings_8k_dates / mappers_global.results_dates_map)离线测试:
代码精确匹配、跨分类去重、取不全的标记、翻页停止条件、栏目筛选、映射层的 partial 与证据字段。"""
import json

import pytest
from test_registry_sources import _ctx

from sources import eastmoney as em
from sources import hkex
from sources import mappers_global as mg
from sources import sec
from sources._http import DataNotAvailable


class _Resp:
    def __init__(self, text=None, obj=None):
        self.text = text if text is not None else json.dumps(obj)
        self._obj = obj

    def raise_for_status(self):
        pass

    def json(self):
        return self._obj


def _prefix(*stocks):
    return _Resp(text="callback(" + json.dumps({"stockInfo": [{"stockId": sid, "code": code, "name": name} for sid, code, name in stocks]}) + ");")


def _search(items, has_next=False):
    return _Resp(obj={"result": json.dumps(items), "hasNextRow": has_next})


def _item(nid, when, title="业绩公告", link="/listedco/x.pdf"):
    return {"NEWS_ID": nid, "DATE_TIME": when, "TITLE": title, "FILE_LINK": link}


def _fake_hkex(monkeypatch, prefix, by_type):
    seen = []

    def fake(url, params=None, **kw):
        seen.append(params)
        if url.endswith("prefix.do"):
            return prefix
        return by_type[params["t2code"]]
    monkeypatch.setattr(hkex, "http_get", fake)
    return seen


# ---------- 港交所披露易 ----------
def test_hkex_only_exact_code_and_merges_across_categories(monkeypatch):
    prefix = _prefix((1, "00700", "腾讯控股"), (2, "07000", "近似代码"), (3, "70000", "另一只"))
    seen = _fake_hkex(monkeypatch, prefix, {
        "13300": _search([_item("A", "18/03/2026 16:31", "2025 年末期业绩")]),
        "13400": _search([_item("B", "12/08/2025 16:30", "2025 中期")]),
        "13600": _search([_item("A", "18/03/2026 16:31", "同一份挂在季度下"), _item("C", "13/11/2025 12:00", "第三季")], has_next=True),
    })
    r = hkex.hk_results_announcements("700")
    assert r["code"] == "00700" and r["name"] == "腾讯控股"
    assert all(p["stockId"] == "1" for p in seen[1:])                          # 用的是完全相同那只的编号
    assert [x["news_id"] for x in r["rows"]] == ["A", "C", "B"]                # 新到旧,A 只留一次
    assert r["rows"][0] == {"date": "2026-03-18", "time": "16:31", "category": "末期业绩", "title": "2025 年末期业绩",
                            "url": "https://www1.hkexnews.hk/listedco/x.pdf", "news_id": "A"}
    assert r["truncated"] == ["季度业绩"]


def test_hkex_no_exact_match_is_not_available(monkeypatch):
    _fake_hkex(monkeypatch, _prefix((2, "07000", "近似代码")), {})
    with pytest.raises(DataNotAvailable, match="查不到 00700"):
        hkex.hk_results_announcements("00700")


def test_hkex_bad_time_kept_without_date_and_offsite_link_dropped(monkeypatch):
    _fake_hkex(monkeypatch, _prefix((1, "00005", "汇丰")), {
        "13300": _search([_item("X", "not a time"), _item("Y", "01/02/2026 12:00", link="https://evil.example/x.pdf")]),
        "13400": _search([]), "13600": _search([]),
    })
    rows = hkex.hk_results_announcements("00005")["rows"]
    assert rows[0]["news_id"] == "Y" and rows[0]["url"] is None and rows[0]["time"] == "12:00"
    assert rows[1] == {"date": None, "time": None, "category": "末期业绩", "title": "业绩公告", "url": None, "news_id": "X"}


def test_hkex_changed_shape_raises(monkeypatch):
    _fake_hkex(monkeypatch, _prefix((1, "00700", "腾讯")), {"13300": _Resp(obj={"oops": 1})})
    with pytest.raises(RuntimeError, match="没有 result"):
        hkex.hk_results_announcements("00700")


@pytest.mark.parametrize("empty", [{"result": "[]", "recordCnt": 0}, {"result": "null"}, {"result": ""}, {"result": None},
                                   {"recordCnt": 0}, {"result": []}])
def test_hkex_empty_category_shapes_mean_no_rows(monkeypatch, empty):
    _fake_hkex(monkeypatch, _prefix((1, "00700", "腾讯")), {t: _Resp(obj=empty) for t in ("13300", "13400", "13600")})
    r = hkex.hk_results_announcements("00700")
    assert r["rows"] == [] and r["truncated"] == []


@pytest.mark.parametrize("bad,msg", [({"result": "{\"a\": 1}"}, "不是列表"), ({"result": "oops"}, "不是 JSON"),
                                     ({"result": None, "recordCnt": 3}, "说有 3 条"), ({"result": {"a": 1}}, "不是列表"), (["x"], "没有 result")])
def test_hkex_unreadable_result_raises(monkeypatch, bad, msg):
    _fake_hkex(monkeypatch, _prefix((1, "00700", "腾讯")), {"13300": _Resp(obj=bad)})
    with pytest.raises(RuntimeError, match=msg):
        hkex.hk_results_announcements("00700")


# ---------- 东财美股 8-K 2.02 ----------
def _ann(date, code, art):
    return {"notice_date": f"{date} 00:00:00", "title": f"8-K {art}", "art_code": art, "columns": [{"column_code": code}]}


def _fake_em(monkeypatch, pages, total):
    calls = []

    def fake(url, params=None, **kw):
        calls.append(int(params["page_index"]))
        return {"data": {"list": pages[int(params["page_index"]) - 1], "total_hits": total}}
    monkeypatch.setattr(em, "em_json", fake)
    return calls


def test_us_8k_filters_item_202_and_stops_on_short_page(monkeypatch):
    full = [_ann("2026-07-30", em.US_8K_202, "E1")] + [_ann("2026-07-01", "012131001", f"O{i}") for i in range(99)]
    calls = _fake_em(monkeypatch, [full, [_ann("2025-10-30", em.US_8K_202, "E2"), _ann("2025-10-01", "012131005", "O")]], total=None)
    r = em.us_earnings_8k("aapl")
    assert calls == [1, 2] and r["truncated"] is False and r["pages"] == 2 and r["symbol"] == "AAPL"
    assert r["rows"] == [{"date": "2026-07-30", "title": "8-K E1", "art_code": "E1"}, {"date": "2025-10-30", "title": "8-K E2", "art_code": "E2"}]


def test_us_8k_stops_when_total_reached_even_on_full_page(monkeypatch):
    full = [_ann("2026-01-01", "012131001", f"O{i}") for i in range(100)]
    calls = _fake_em(monkeypatch, [full, full, full], total=200)
    r = em.us_earnings_8k("JPM")
    assert calls == [1, 2] and r["truncated"] is False and r["rows"] == []


def test_us_8k_marks_truncated_at_page_cap(monkeypatch):
    full = [_ann("2026-01-01", "012131001", f"O{i}") for i in range(100)]
    calls = _fake_em(monkeypatch, [full] * 5, total=5000)
    r = em.us_earnings_8k("JPM", max_pages=3)
    assert calls == [1, 2, 3] and r["truncated"] is True and r["pages"] == 3


def test_us_8k_short_page_before_total_is_truncated(monkeypatch):
    full = [_ann("2026-01-01", "012131001", f"O{i}") for i in range(100)]
    for short in ([], full[:40]):
        calls = _fake_em(monkeypatch, [full, short, full], total=5000)
        r = em.us_earnings_8k("JPM")
        assert calls == [1, 2] and r["truncated"] is True and r["pages"] == 2


def test_us_8k_changed_shape_raises(monkeypatch):
    monkeypatch.setattr(em, "em_json", lambda *a, **k: {"data": None})
    with pytest.raises(RuntimeError, match="没有 data"):
        em.us_earnings_8k("AAPL")


# ---------- SEC 全文检索 8-K 2.02 ----------
def _hit(acc, day, items=("2.02", "9.01"), form="8-K", desc="8-K"):
    return {"_source": {"adsh": acc, "file_date": day, "items": list(items), "form": form, "file_description": desc}}


def _fake_fts(monkeypatch, pages, total):
    calls = []
    monkeypatch.setattr(sec, "ticker_to_cik", lambda t: {"ticker": t.upper(), "cik": "0000019617", "company": "JPMORGAN CHASE & CO"})

    def fake(params):
        calls.append(params)
        n = params["from"] // sec.FTS_PAGE
        return {"hits": {"total": {"value": total, "relation": "eq"}, "hits": pages[n]}}
    monkeypatch.setattr(sec, "_fts_page", fake)
    return calls


def test_sec_keeps_only_8k_with_item_202_dedupes_and_sorts_by_date(monkeypatch):
    page = [_hit("A", "2024-01-12"), _hit("B", "2025-04-11"), _hit("A", "2024-01-12"),
            _hit("C", "2025-04-15", form="8-K/A"), _hit("D", "2025-03-01", items=("7.01", "9.01")),
            _hit("E", "bad", desc=""), {"_source": {"adsh": "F", "form": "8-K"}}, "junk"]
    calls = _fake_fts(monkeypatch, [page], total=len(page))
    r = sec.earnings_8k_dates("jpm")
    assert calls == [{"q": '"Item 2.02"', "forms": "8-K", "ciks": "0000019617", "from": 0}]
    assert r["rows"] == [{"date": "2025-04-11", "title": "8-K", "accession": "B"}, {"date": "2024-01-12", "title": "8-K", "accession": "A"},
                         {"date": None, "title": None, "accession": "E"}]
    assert (r["symbol"], r["cik"], r["pages"], r["total"], r["truncated"]) == ("JPM", "0000019617", 1, 8, False)


def test_sec_paging_stops_on_total_short_page_or_cap(monkeypatch):
    full = [_hit(f"X{i}", "2020-01-01", items=("8.01",)) for i in range(100)]
    calls = _fake_fts(monkeypatch, [full, full, full], total=200)
    r = sec.earnings_8k_dates("JPM")
    assert [c["from"] for c in calls] == [0, 100] and r["truncated"] is False and r["pages"] == 2
    for short in ([], full[:30]):
        calls = _fake_fts(monkeypatch, [full, short, full], total=900)
        r = sec.earnings_8k_dates("JPM")
        assert len(calls) == 2 and r["truncated"] is True and r["pages"] == 2, "总数说还有、这页却不满,不能当取完"
    calls = _fake_fts(monkeypatch, [full] * 5, total=900)
    r = sec.earnings_8k_dates("JPM", max_pages=3)
    assert len(calls) == 3 and r["truncated"] is True and r["pages"] == 3 and r["total"] == 900


@pytest.mark.parametrize("bad,msg", [({"oops": 1}, "没有 hits"), ({"hits": {"hits": None}}, "没有 hits"), (["x"], "没有 hits"),
                                     ({"hits": {"hits": [], "total": 3}}, "没有总数"), ({"hits": {"hits": []}}, "没有总数")])
def test_sec_changed_shape_raises(monkeypatch, bad, msg):
    monkeypatch.setattr(sec, "ticker_to_cik", lambda t: {"ticker": t, "cik": "0000000001", "company": None})
    monkeypatch.setattr(sec, "_fts_page", lambda params: bad)
    with pytest.raises(RuntimeError, match=msg):
        sec.earnings_8k_dates("JPM")


def test_sec_fts_retries_5xx_only(monkeypatch):
    slept = []
    monkeypatch.setattr(sec.time, "sleep", slept.append)
    errs = [RuntimeError("HTTP 500 efts.sec.gov"), RuntimeError("HTTP 503 efts.sec.gov")]

    def flaky(url, params=None, as_json=False):
        if errs:
            raise errs.pop(0)
        return {"ok": url}
    monkeypatch.setattr(sec, "official_get", flaky)
    assert sec._fts_page({"q": "x"}) == {"ok": "https://efts.sec.gov/LATEST/search-index"} and slept == [1.5, 3.0]

    n = []
    def always(url, params=None, as_json=False):
        n.append(1)
        raise RuntimeError("HTTP 502 efts.sec.gov")
    monkeypatch.setattr(sec, "official_get", always)
    with pytest.raises(RuntimeError, match="HTTP 502"):
        sec._fts_page({"q": "x"})
    assert len(n) == 3

    n.clear()
    def forbidden(url, params=None, as_json=False):
        n.append(1)
        raise RuntimeError("HTTP 403 efts.sec.gov")
    monkeypatch.setattr(sec, "official_get", forbidden)
    with pytest.raises(RuntimeError, match="HTTP 403"):
        sec._fts_page({"q": "x"})
    assert len(n) == 1, "403 之类不是临时故障,不重试"


# ---------- 映射层 ----------
def _map(monkeypatch, result, market, source="test"):
    saved = {}
    monkeypatch.setattr(mg, "extracted", lambda ctx, obj, ext="json": saved.update(obj) or "raw/extracted_x.json")
    sym = "00700" if market == "HK" else "AAPL"
    return mg.results_dates_map(result, _ctx(market=market, symbol=sym, script="ep_x", source=source, raws=[{"raw_ref": "raw/t.json"}])), saved


def test_map_hk_counts_lists_and_keeps_full_rows_in_extracted(monkeypatch):
    rows = [{"date": "2026-03-18", "time": "16:31", "category": "末期业绩", "title": "末期‮业绩", "news_id": "A"},
            {"date": None, "time": None, "category": "中期业绩", "title": "坏时间", "news_id": "X"}]
    r, saved = _map(monkeypatch, {"rows": rows, "truncated": []}, "HK")
    assert "status" not in r and "degraded" not in r
    assert saved["rows"] == rows and saved["transport_raw_refs"] == ["raw/t.json"]
    count = next(e for e in r["evidence"] if e["field"] == "results_release_count")
    assert count["value"] == 1 and count["unit"] == "次" and count["period"] == "2026-03-18..2026-03-18"
    item = next(e for e in r["evidence"] if e["field"] == "results_release")
    assert item["value"].startswith("2026-03-18 16:31 · 末期业绩 · ") and "‮" not in item["value"] and item["raw_ref"] == "raw/extracted_x.json"
    assert r["missing"] == [{"field": "results_release", "period": None, "reason": "有 1 条没有日期"}]


def test_map_hk_truncated_is_partial(monkeypatch):
    r, _ = _map(monkeypatch, {"rows": [{"date": "2026-03-18", "time": "16:31", "category": "季度业绩", "title": "t", "news_id": "A"}],
                              "truncated": ["季度业绩"]}, "HK")
    assert r["status"] == "partial" and "季度业绩超过一次能取的 500 条" in r["degraded"]


def test_map_us_empty_mentions_adr_and_cut(monkeypatch):
    r, _ = _map(monkeypatch, {"rows": [], "truncated": False}, "US")
    assert r["status"] == "partial" and "ADR" in r["degraded"]
    r2, _ = _map(monkeypatch, {"rows": [], "truncated": True, "pages": 30}, "US")
    assert "只取到最近 30 页申报" in r2["degraded"]


def test_map_us_truncated_is_partial_and_caps_listed_rows(monkeypatch):
    rows = [{"date": f"20{10 + i // 4:02d}-0{1 + i % 4}-15", "title": f"t{i}", "art_code": f"a{i}"} for i in range(50)]
    r, saved = _map(monkeypatch, {"rows": rows, "truncated": True, "pages": 30}, "US")
    assert r["status"] == "partial" and len(saved["rows"]) == 50
    assert len([e for e in r["evidence"] if e["field"] == "results_release"]) == mg.EV_ROWS
    assert next(e for e in r["evidence"] if e["field"] == "results_release_count")["value"] == 50


def test_map_sec_wording_total_and_accession(monkeypatch):
    rows = [{"date": "2025-04-11", "title": "8-K", "accession": "0000019617-25-000123"}]
    r, saved = _map(monkeypatch, {"rows": rows, "truncated": False, "pages": 1, "total": 47}, "US", source="sec")
    assert "status" not in r and saved["total"] == 47 and saved["pages"] == 1
    count = next(e for e in r["evidence"] if e["field"] == "results_release_count")
    assert count["note"].startswith("SEC EDGAR 全文检索") and "8-K/A 不算" in count["note"]
    assert next(e for e in r["evidence"] if e["field"] == "results_release")["record_key"] == "0000019617-25-000123"
    r2, _ = _map(monkeypatch, {"rows": rows, "truncated": True, "pages": 5, "total": 612}, "US", source="sec")
    assert r2["status"] == "partial" and "全文检索命中 612 条(含附件和更正版),只取了前 5 页" in r2["degraded"] and "最近" not in r2["degraded"]
    r3, _ = _map(monkeypatch, {"rows": rows, "truncated": False}, "US", source="eastmoney")
    assert "东财转载" in next(e for e in r3["evidence"] if e["field"] == "results_release_count")["note"]
