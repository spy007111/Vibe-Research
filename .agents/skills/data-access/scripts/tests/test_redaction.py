"""
错误 / 诊断文本的脱敏(全审 r3-P1-5 / P2-6)。

信封的 `errors` 与 `extra.traceback_tail` **原样进产物、并经 MCP / API 回传** ——
其中真的漏过 `VRA_SEC_CONTACT` 里的姓名邮箱(SEC 拒绝时会把它拼进错误消息),
以及第三方 SDK traceback 里的 URL token / 代理地址 / 主目录路径。
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from common import record_error, redact_text  # noqa: E402


def test_四类敏感信息都被替换():
    cases = [
        ("SEC 拒绝 (VRA_SEC_CONTACT='Alice alice@company.com')", "[REDACTED_EMAIL]", "alice@company.com"),
        ('File "/Users/alice/x/y.py", line 3', "[USER]", "/Users/alice"),
        ("proxy http://10.0.0.8:3128 failed", "[PRIVATE_IP]", "10.0.0.8"),
        ("https://user:pw@api.example.com/v1", "[REDACTED_USERINFO]", "user:pw@"),
        ("key=sk-abcdefghijklmnop12", "[REDACTED_KEY]", "sk-abcdefghijklmnop12"),
    ]
    for text, marker, leaked in cases:
        out = redact_text(text)
        assert marker in out, f"{text!r} 应含 {marker}:{out!r}"
        assert leaked not in out, f"{text!r} 仍泄露 {leaked!r}:{out!r}"


def test_正常文本不被改动():
    for text in ["", "HTTP 404 Not Found", "东财返回空数组", "https://push2.eastmoney.com/api/qt/get?secid=0.300308"]:
        assert redact_text(text) == text


def test_record_error_走脱敏():
    """⚠️ 必须走 record_error 真实路径 —— 只测 redact_text 的话,把 record_error 里的调用删掉测试照样绿。"""
    res = {"errors": []}
    record_error(res, "sec", "submissions", RuntimeError("拒绝 alice@company.com from /Users/alice/x"))
    err = res["errors"][0]["error"]
    assert "alice@company.com" not in err and "/Users/alice" not in err, err
    assert "[REDACTED_EMAIL]" in err and "[USER]" in err, err


@pytest.mark.parametrize("path", [
    r"C:\Users\alice\probe.py", r"D:\Users\alice\probe.py",
    r"c:\users\alice\probe.py", r"C:\\Users\\alice\\probe.py",
    r"D:\Users\alice smith\probe.py",
    "D:/Users/alice/probe.py", "/home/alice/probe.py", "/Users/alice/probe.py",
])
def test_real_and_escaped_home_paths_redacted_in_error_envelope(path):
    res = {"errors": []}
    record_error(res, "synthetic", "test", RuntimeError(f'File "{path}", line 7'))
    text = res["errors"][0]["error"]
    assert "alice" not in text
    assert "[USER]" in text and "probe.py" in text and "line 7" in text


def test_填的_SEC_联系方式整串遮掉_连姓名一起(monkeypatch):
    """只遮邮箱的话姓名还在;按环境变量的原样、并空白后、转义后三种写法整串遮。"""
    monkeypatch.setenv("VRA_SEC_CONTACT", "Zhang San\nZhang zhangsan@example.com")
    for text in ["header value: 'Zhang San\\nZhang zhangsan@example.com'",      # requests 报错里的转义写法
                 "UA Zhang San Zhang zhangsan@example.com rejected",            # 并空白后的写法
                 "raw Zhang San\nZhang zhangsan@example.com"]:
        out = redact_text(text)
        assert "Zhang" not in out and "zhangsan@example.com" not in out and "[REDACTED_CONTACT]" in out, out
    monkeypatch.setenv("VRA_SEC_CONTACT", "a")
    assert redact_text("a cat and a dog") == "a cat and a dog", "太短的不遮，免得误伤正文"
