"""baostock 翻页失败不能当成完整序列：SDK 每页 2000 行，翻下一页失败只改 error_code、next() 返回 False。

2026-10-09 实测：同时开 4 个 baostock 会话取 2015–2024 的前复权日 K，有的只回 2000 行（停在 2023-07-26）而不报错，
有的直接「10001001 用户未登录」。另一种更隐蔽：取下一页时网络异常，SDK 只打印、error_code 还是 "0"（E3 审查 P2-5），
用真 SDK 的 ResultData.next() 复现。全部离线。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[3]
sys.path.insert(0, str(SCRIPTS))
import fetch_profile  # noqa: E402
from sources import astock_ported, baostock_src  # noqa: E402


class PagedRS:
    """第一页正常给完，翻第二页时服务端回「用户未登录」—— 与 SDK 的 ResultData.next 行为一致。"""

    def __init__(self, rows, fail_next_page=True):
        self.fields = ["date", "close"]
        self.error_code, self.error_msg = "0", "success"
        self._rows, self._i, self._fail = list(rows), 0, fail_next_page

    def next(self):
        if self._i < len(self._rows):
            return True
        if self._fail:
            self.error_code, self.error_msg = "10001001", "用户未登录"
        return False

    def get_row_data(self):
        r = self._rows[self._i]
        self._i += 1
        return r


ROWS = [["2023-07-25", "1"], ["2023-07-26", "2"]]


@pytest.mark.parametrize("read", [
    baostock_src._rs_rows,
    astock_ported._rs_to_df,
    lambda rs: fetch_profile._bs_rows(rs, "基本信息"),
])
def test_page_failure_after_first_page_raises_instead_of_returning_partial(read):
    with pytest.raises(RuntimeError, match="翻页失败.*10001001.*只取到 2 行"):
        read(PagedRS(ROWS))
    got = read(PagedRS(ROWS, fail_next_page=False))
    assert len(got) == 2, "正常读完照常返回"


def _sdk_rs(n_rows):
    """真 SDK 的 ResultData，第一页已经拿到 n_rows 行。"""
    pytest.importorskip("baostock")
    from baostock.common import contants as cons
    from baostock.data.resultset import ResultData
    rs = ResultData()
    rs.error_code, rs.error_msg = "0", "success"
    rs.fields = ["date", "close"]
    rs.data = [[f"d{i}", "1"] for i in range(n_rows)]
    rs.cur_page_num = "1"
    rs.msg_type = cons.MESSAGE_TYPE_GETKDATAPLUS_REQUEST
    rs.msg_body = cons.MESSAGE_SPLIT.join(["query_history_k_data_plus", "anonymous", "1", "2000", "sh.600519"])
    return rs


class _ResetSocket:
    def send(self, _data):
        raise ConnectionResetError("对端重置连接")


READERS = [
    baostock_src._rs_rows,
    astock_ported._rs_to_df,
    lambda rs: fetch_profile._bs_rows(rs, "基本信息"),
]


@pytest.mark.parametrize("read", READERS)
def test_network_error_on_next_page_is_not_a_complete_series(read, monkeypatch):
    """满页 2000 行后取下一页时网络异常：SDK 的 send_msg 打印后返回 None，next() 返回 False、error_code 还是 "0"。"""
    from baostock.common import context
    rs = _sdk_rs(2000)
    monkeypatch.setattr(context, "default_socket", _ResetSocket(), raising=False)
    with pytest.raises(RuntimeError, match="翻页失败.*下一页没有回应.*只取到 2000 行"):
        read(rs)


@pytest.mark.parametrize("read", READERS)
def test_full_page_followed_by_an_empty_page_is_complete(read, monkeypatch):
    """正好 2000 行时 SDK 也会去取第二页；服务端回空页 ⇒ rs.data 变成 []，是读完了，不能误报。"""
    import baostock.util.socketutil as sock
    from baostock.common import contants as cons
    from baostock.data.messageheader import to_message_header
    body = cons.MESSAGE_SPLIT.join(["0", "success", "query_history_k_data_plus", "anonymous", "2", "2000", ""])
    header = to_message_header(cons.MESSAGE_TYPE_GETKDATAPLUS_RESPONSE, len(body))
    assert len(header) == cons.MESSAGE_HEADER_LENGTH
    monkeypatch.setattr(sock, "send_msg", lambda msg: header + body + "\n")
    rs = _sdk_rs(2000)
    assert len(read(rs)) == 2000 and rs.data == []
    assert len(read(_sdk_rs(1999))) == 1999, "不满一页不会去取下一页"


def test_paging_error_reasons():
    assert baostock_src.bs_paging_error(PagedRS(ROWS, fail_next_page=False)) is None, "假对象没有 data，只看错误码"
    rs = PagedRS(ROWS)
    while rs.next():
        rs.get_row_data()
    assert baostock_src.bs_paging_error(rs) == "10001001 用户未登录"
    full = PagedRS(ROWS, fail_next_page=False)
    full.data = [["d", "1"]] * 2000
    assert baostock_src.bs_paging_error(full) == "下一页没有回应(网络异常,SDK 没有报错)"
    full.data = [["d", "1"]] * 2001
    assert baostock_src.bs_paging_error(full) is None, "一次给完、超过一页的不翻页"
    full.data = []
    assert baostock_src.bs_paging_error(full) is None


def test_every_baostock_read_loop_checks_the_error_after_paging():
    """以后新写的 `while rs.next()` 也要在循环后用 bs_paging_error 查（含移植模板）：只查 error_code 漏掉网络异常。"""
    files = [p for p in SCRIPTS.rglob("*.py") if "tests" not in p.parts] + [REPO / "datasources" / "port_astock.py"]
    loops = 0
    for f in files:
        lines = f.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if re.search(r"while\s+rs\.next\(\)\s*:", line):
                loops += 1
                tail = "\n".join(lines[i + 1:i + 5])
                assert re.search(r'bs_paging_error\(rs\)', tail), f"{f.relative_to(REPO)}:{i + 1} 翻页后没有用 bs_paging_error 检查"
    assert loops >= 6, f"只找到 {loops} 处读取循环，扫描范围可能不对"
