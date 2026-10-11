"""东财取数层的单测。全程不联网(`_push2_json` 一律 monkeypatch)。"""
from __future__ import annotations

import os
import json
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sources import eastmoney  # noqa: E402


def test_global_symbol_resolution_falls_back_when_search_returns_no_quotes(monkeypatch):
    """Issue #26 回归：搜索接口返回空结构时，美股代码仍须逐市场直查，不能整块失效。"""
    eastmoney._GLOBAL_SECID.clear()
    monkeypatch.setattr(eastmoney, "stock_search", lambda *_a, **_k: [])
    calls = []

    def fake(_path, params=None, headers=None, timeout=None):
        secid = (params or {}).get("secid")
        calls.append(secid)
        return {"data": {"f57": "AAPL", "f58": "Apple"}} if secid == "106.AAPL" else {"data": None}

    monkeypatch.setattr(eastmoney, "_push2_json", fake)
    assert eastmoney.resolve_global_secid("aapl", "US") == (106, "AAPL")
    assert calls == ["105.AAPL", "106.AAPL"]


def test_hk_short_symbol_resolution_does_not_depend_on_search(monkeypatch):
    """Issue #26 回归：港股短码直接补足五位，不依赖全球搜索接口。"""
    eastmoney._GLOBAL_SECID.clear()
    monkeypatch.setattr(eastmoney, "stock_search", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("不应调用搜索")))
    assert eastmoney.resolve_global_secid("700", "HK") == (116, "00700")


def test_cross_process_eastmoney_lock_serializes_on_this_platform(tmp_path):
    """两个真实 Python 进程同时起跑，临界区不得重叠（Windows 走 msvcrt，Unix 走 flock）。"""
    script = '''
import json
from pathlib import Path
import sys
import time
import common

lock_file, ready_file, go_file, result_file = sys.argv[1:]
common.EM_LOCK_PATH = lock_file
common.EM_MIN_INTERVAL = 0
Path(ready_file).write_text("ready", encoding="utf-8")
while not Path(go_file).exists():
    time.sleep(0.005)

def critical():
    started = time.monotonic()
    time.sleep(0.3)
    return {"started": started, "finished": time.monotonic()}

Path(result_file).write_text(json.dumps(common._em_serial(critical)), encoding="utf-8")
'''
    lock_file = tmp_path / "eastmoney.lock"
    go_file = tmp_path / "go"
    ready = [tmp_path / f"ready-{i}" for i in range(2)]
    results = [tmp_path / f"result-{i}.json" for i in range(2)]
    env = {**os.environ, "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", script, str(lock_file), str(ready[i]), str(go_file), str(results[i])],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        for i in range(2)
    ]
    deadline = time.monotonic() + 10
    while not all(p.exists() for p in ready) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert all(p.exists() for p in ready), "两个子进程必须先同时抵达起跑线"
    go_file.write_text("go", encoding="utf-8")
    for proc in procs:
        stdout, stderr = proc.communicate(timeout=10)
        assert proc.returncode == 0, f"stdout={stdout}\nstderr={stderr}"
    spans = sorted((json.loads(p.read_text(encoding="utf-8")) for p in results), key=lambda x: x["started"])
    assert spans[1]["started"] >= spans[0]["finished"], spans



def test_windows_eastmoney_lock_never_writes_before_locking(tmp_path, monkeypatch):
    """Windows 字节锁是强制的:上锁前往文件写东西,碰上别的进程正锁着就 PermissionError。空文件也要先锁、不补写。"""
    import common

    lock_file = tmp_path / "eastmoney.lock"
    lock_file.write_text("", encoding="utf-8")
    calls = []

    class FakeMsvcrt:
        LK_LOCK, LK_UNLCK = 1, 0

        @staticmethod
        def locking(fd, mode, nbytes):
            calls.append((mode, os.lseek(fd, 0, os.SEEK_CUR), nbytes, lock_file.read_bytes()))

    monkeypatch.setattr(common.sys, "platform", "win32")
    monkeypatch.setattr(common, "msvcrt", FakeMsvcrt, raising=False)
    with open(lock_file, "a+") as lf:
        common._lock_em_file(lf)
        common._unlock_em_file(lf)
    assert calls == [(FakeMsvcrt.LK_LOCK, 0, 1, b""), (FakeMsvcrt.LK_UNLCK, 0, 1, b"")], calls


def test_board_fund_flow_paging_does_not_assume_requested_page_size(monkeypatch):
    """🔴 别假设上游认你请求的页大小。

    实测:代码请求 pz=200,东财每页只给 100 ⇒ 原来的 `len(more) < 200 就停` 在第 2 页就断了,
    上游 total=496 而我们只拿 200,**界面上完全看不出来**(看着像"就这么多板块"),
    于是"净流出最多"那一栏里全是净流入的板块 —— 标题在撒谎。
    """
    TOTAL = 496
    PAGE = 100          # 上游真实页大小,**小于**代码请求的 pz
    calls = []

    def fake(_path, params=None, headers=None, timeout=None):
        pn = int((params or {}).get("pn", 1))
        calls.append(pn)
        start = (pn - 1) * PAGE
        diff = [{"f12": f"B{i:04d}", "f14": f"板块{i}", "f3": 1.0, "f62": (TOTAL // 2 - i) * 1e8, "f184": 1.0}
                for i in range(start, min(start + PAGE, TOTAL))]
        return {"data": {"diff": diff, "total": TOTAL}}

    monkeypatch.setattr(eastmoney, "_push2_json", fake)
    r = eastmoney.board_fund_flow("industry", "today", 500)
    assert len(r["rows"]) == TOTAL, f"该取全 {TOTAL} 个,实际 {len(r['rows'])}(第一版只拿到一页 {PAGE})"
    assert r["total"] == TOTAL
    # 尾部必须真的是负数 —— 这正是"净流出最多"那一栏要用的
    assert r["rows"][-1]["main_net"] < 0, "取全之后才看得到净流出侧"
    assert len(calls) >= 5, f"应当翻够页,实际只请求了 {calls}"


def test_board_fund_flow_stops_on_empty_page(monkeypatch):
    """空页要停,不能无限翻(上游少给了 total 时的兜底)。"""
    def fake(_path, params=None, headers=None, timeout=None):
        pn = int((params or {}).get("pn", 1))
        diff = [{"f12": "B1", "f14": "x", "f3": 1.0, "f62": 1e8, "f184": 1.0}] * 100 if pn == 1 else []
        return {"data": {"diff": diff, "total": 0}}

    monkeypatch.setattr(eastmoney, "_push2_json", fake)
    r = eastmoney.board_fund_flow("industry", "today", 500)
    assert len(r["rows"]) == 100
