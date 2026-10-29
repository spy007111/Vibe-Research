"""Legacy JSON 输出编码回归；子进程只调用公共输出函数，不联网。"""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize("title", ["襄阳轴承：2026年三季度报告", "襄阳轴承：2026年\xa0三季度报告"])
def test_legacy_finish_emits_utf8_when_parent_stdio_is_gbk(tmp_path, title):
    script = f"""
import sys
sys.path.insert(0, sys.argv[1])
from common import finish, quiet_stdout

with quiet_stdout():
    print("SDK diagnostic")
finish({{"status": "ok", "title": {ascii(title)}}})
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(Path(__file__).resolve().parents[1])],
        cwd=tmp_path, capture_output=True,
        env={**os.environ, "PYTHONIOENCODING": "gbk"}, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    output = result.stdout.decode("utf-8", errors="strict")
    assert title in output
    assert json.loads(output) == {"status": "ok", "title": title}
    assert result.stderr.strip() == b"SDK diagnostic"
