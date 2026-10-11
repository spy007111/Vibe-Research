"""港美股行业（持仓体检的 GICS 行业暴露读它）：只取行业两列、东财没有公司资料 → {}、回了别的代码报错。全程不联网。"""
from __future__ import annotations

import pytest

from sources import eastmoney


def _fake(monkeypatch, rows, seen):
    monkeypatch.setattr(eastmoney, "_secucode", lambda s, m: f"{s}.HK" if m == "HK" else f"{s}.O")
    monkeypatch.setattr(eastmoney, "_dc_strict", lambda name, flt, **k: seen.append((name, flt)) or rows)


def test_global_industry_reads_industry_and_gics_path(monkeypatch):
    seen: list = []
    _fake(monkeypatch, [{"SECUCODE": "00700.HK", "BELONG_INDUSTRY": "软件服务", "INDUSTRY_TYPE": "通讯服务-媒体与娱乐-互动媒体与服务-互动媒体与服务",
                         "ORG_PROFILE": "很长的简介"}], seen)
    got = eastmoney.global_industry("00700", "HK")
    assert seen == [("RPT_HKF10_INFO_ORGPROFILE", '(SECUCODE="00700.HK")')]
    assert got == {"secucode": "00700.HK", "industry": "软件服务", "gics_path": "通讯服务-媒体与娱乐-互动媒体与服务-互动媒体与服务"}
    seen.clear()
    _fake(monkeypatch, [{"SECUCODE": "AAPL.O", "BELONG_INDUSTRY": "电脑硬件、储存设备及电脑周边", "INDUSTRY_TYPE": ""}], seen)
    assert eastmoney.global_industry("AAPL", "US") == {"secucode": "AAPL.O", "industry": "电脑硬件、储存设备及电脑周边", "gics_path": None}
    assert seen[0][0] == "RPT_USF10_INFO_ORGPROFILE"


def test_global_industry_empty_and_wrong_code(monkeypatch):
    _fake(monkeypatch, [], [])
    assert eastmoney.global_industry("SPY", "US") == {}, "ETF 这类东财没有公司资料：空，不是失败"
    _fake(monkeypatch, [{"SECUCODE": "MSFT.O", "BELONG_INDUSTRY": "系统软件"}], [])
    with pytest.raises(RuntimeError, match="请求 AAPL.O,却返回了 MSFT.O"):
        eastmoney.global_industry("AAPL", "US")
