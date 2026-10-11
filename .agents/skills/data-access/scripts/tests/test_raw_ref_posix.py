"""raw_ref 是交换契约:不论在哪个系统上落盘,都写成 raw/<文件>(审计 B8)。"""
from __future__ import annotations

import ntpath
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parents[4]))          # 仓库根:calc 包

import common  # noqa: E402
from calc import cli  # noqa: E402


def test_save_raw_ref_uses_slash_even_with_windows_paths(monkeypatch, tmp_path):
    """🔴 Windows 上 os.path.join 用反斜杠:以前 raw_ref 写成 raw\\xxx.csv,传给计算库当场报路径参数错。"""
    real_open = os.open
    opened = []
    # 先算好真实落盘路径：下面换掉的是全局 os.path.join，之后 tmp_path / ... 在 Linux 上也会拼成反斜杠
    target = str(tmp_path / "f.bin")

    def fake_open(path, flags, mode=0o777):
        opened.append(path)
        return real_open(target, flags, mode)

    monkeypatch.setattr(common.os.path, "join", ntpath.join)
    monkeypatch.setattr(common.os, "makedirs", lambda *a, **k: None)
    monkeypatch.setattr(common.os, "open", fake_open)
    got = common.save_raw("C:\\run", "tencent", "qt.gtimg.cn/q", b"x", "csv", kind="extracted")
    assert got["raw_ref"].startswith("raw/extracted_tencent_") and "\\" not in got["raw_ref"]
    assert opened and opened[0].startswith("C:\\run\\raw\\"), "真实磁盘路径照系统分隔符"


def test_save_raw_ref_is_readable_by_calc(tmp_path):
    got = common.save_raw(str(tmp_path), "eastmoney", "pe_history", b"date,pe\n2026-01-01,10\n", "csv", kind="extracted")
    target = cli._raw_target(got["raw_ref"], str(tmp_path), "history_csv")
    assert target.read_bytes().startswith(b"date,pe")
