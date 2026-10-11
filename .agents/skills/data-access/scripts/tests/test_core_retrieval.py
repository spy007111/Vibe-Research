"""Core 检索层与 CDP 通道的单测。全程不联网(通道实现一律 monkeypatch)。"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import cdp, retrieval  # noqa: E402


def test_zero_config_default_no_key_needed():
    """没有任何 key 时必须**照常可用** —— 这是"装完就能用"的地基,不是可选特性。"""
    assert retrieval.available_upgrades({}) == []
    assert retrieval._pick_search({}) == "exa_free"
    assert retrieval._pick_page({}) == "jina"


def test_key_detected_upgrades_channel():
    """检测到 key 要如实报"可升级",但**只有该通道已注册时才切过去** ——
    否则就成了"配了 key 反而报未知通道"(见 `test_configured_key_never_breaks_the_free_path`)。"""
    env = {"VRA_TAVILY_API_KEY": "x"}
    assert retrieval.available_upgrades(env) == ["tavily"]
    assert retrieval._pick_search(env) == "exa_free"          # tavily 实现还没接上 → 照旧走免费通道
    retrieval.register_search_provider("tavily_key", lambda q, n, e: [])
    try:
        assert retrieval._pick_search(env) == "tavily_key"
    finally:
        retrieval._SEARCH_IMPL.pop("tavily_key", None)
    # 只配了搜索 key 不该影响取页通道
    assert retrieval._pick_page(env) == "jina"


def test_upgrades_never_echo_the_key_itself():
    """只报通道名,**绝不回显 key** —— 这类函数的返回值会进日志与诊断包。"""
    env = {"VRA_EXA_API_KEY": "sk-super-secret-value"}
    out = retrieval.available_upgrades(env)
    assert out == ["exa"]
    assert "sk-super-secret-value" not in repr(out)


def test_whitespace_only_key_is_not_a_key():
    """空白 key 等于没配 —— 否则用户 export 了个空值就会被切到一条根本用不了的通道。"""
    assert retrieval.available_upgrades({"VRA_EXA_API_KEY": "   "}) == []
    assert retrieval._pick_search({"VRA_EXA_API_KEY": "   "}) == "exa_free"


def test_search_stamps_source_and_time(monkeypatch):
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "fake", lambda q, n, e: [{"title": "T", "url": "https://a/b", "snippet": "S"}])
    rows = retrieval.search("q", provider="fake")
    assert rows[0]["source"] == "fake" and rows[0]["title"] == "T"
    assert rows[0]["fetched_at"].startswith("20")     # 每条都带取回时刻:舆情 / 概率类内容离开时间点就没意义


def test_unknown_provider_fails_loudly():
    """未知通道**当场抛错**,不许静默回落到默认 —— 静默回落会让"我明明配了 Tavily"变成无从排查。"""
    with pytest.raises(retrieval.RetrievalError, match="未知搜索通道"):
        retrieval.search("q", provider="不存在")
    with pytest.raises(retrieval.RetrievalError, match="未知取页通道"):
        retrieval.fetch_page("https://a", provider="不存在")


def test_fetch_page_truncates_and_flags(monkeypatch):
    monkeypatch.setitem(retrieval._PAGE_IMPL, "fake", lambda u, m, e: "x" * 5000)
    r = retrieval.fetch_page("https://a", max_chars=100, provider="fake")
    assert len(r["text"]) == 100 and r["truncated"] is True
    short = retrieval.fetch_page("https://a", max_chars=99999, provider="fake")
    assert short["truncated"] is False


def test_providers_are_registerable():
    """DomainPack / 用户插件能注册自己的通道 —— Core 不写死可用通道清单。"""
    retrieval.register_search_provider("t_search", lambda q, n, e: [{"title": q, "url": "https://x/1", "snippet": ""}])
    retrieval.register_page_provider("t_page", lambda u, m, e: "ok")
    try:
        assert retrieval.search("hello", provider="t_search")[0]["title"] == "hello"
        assert retrieval.fetch_page("https://a", provider="t_page")["text"] == "ok"
    finally:
        retrieval._SEARCH_IMPL.pop("t_search", None)
        retrieval._PAGE_IMPL.pop("t_page", None)


def test_cdp_unavailable_gives_actionable_hint(monkeypatch):
    """CDP 连不上是**常态**(默认就没开调试端口),提示必须能让人知道下一步做什么,
    而不是甩一个 connection refused。"""
    def boom(*_a, **_k):
        raise cdp.CdpError(cdp.endpoint_hint())
    monkeypatch.setattr(cdp, "_http_json", boom)
    assert cdp.is_available() is False
    hint = cdp.endpoint_hint()
    assert "可选增强" in hint and "remote-debugging-port" in hint and str(cdp.DEBUG_PORT) in hint


def test_cdp_refuses_non_local_websocket():
    """只连本机调试端点 —— 不许被一个外部地址牵去别处。

    🔴 初版只查了 `ws://` 前缀就断言"只支持本机",于是 `ws://evil.example.com/` **照连不误**;
    是我自己的测试给了假信心(Codex core-retrieval-r1 P1)。现在两层都要验。
    """
    with pytest.raises(cdp.CdpError, match="只支持本机"):
        cdp._Ws("wss://evil.example.com/devtools")
    with pytest.raises(cdp.CdpError, match="非本机地址"):
        cdp._Ws("ws://evil.example.com:9222/devtools/page/1")
    with pytest.raises(cdp.CdpError, match="非本机地址"):
        cdp._Ws("ws://10.0.0.5:9222/devtools/page/1")      # 内网地址同样拒绝
    # 🔴 不带端口时 urlparse 的 port 是 None —— 初版的 `if p.port and ...` 整条跳过,
    #    于是它会去连 80 端口。端口检查必须把"默认端口"也算进去(r2a P1-3)。
    with pytest.raises(cdp.CdpError, match="端口"):
        cdp._Ws("ws://127.0.0.1/devtools/page/1")


def test_cdp_host_env_must_be_loopback(monkeypatch):
    """`VRA_CDP_HOST` 配成外部主机时,连 HTTP 探测都不许发出去。"""
    monkeypatch.setattr(cdp, "DEBUG_HOST", "attacker.example.com")
    with pytest.raises(cdp.CdpError, match="非本机地址"):
        cdp._http_json("/json/version")


@pytest.mark.parametrize("bad", [
    "file:///etc/passwd", "ftp://x/y", "chrome://settings",
    "http://localhost:8080/admin", "http://127.0.0.1/x", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",              # 云元数据服务:典型 SSRF 目标
    # 审计 B1:Python 3.11 的 is_private 不含运营商共享地址段;IPv4 映射 / NAT64 / 旧式兼容写法包着内网
    "http://100.64.0.1:8080/", "http://100.127.255.254/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:a00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[::10.0.0.1]/",
    "http://[2002:a00:1::]/", "http://[fd00::1]/", "http://192.0.0.8/", "http://[::]/",
])
def test_cdp_url_allowlist_blocks_local_and_nonweb(bad):
    """URL 常常来自**不可信搜索结果** —— 本地文件、内网、云元数据一律拒绝(P1)。"""
    with pytest.raises(cdp.CdpError):
        cdp.assert_fetchable_url(bad)


def test_cdp_url_allowlist_permits_normal_web(monkeypatch):
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))])
    cdp.assert_fetchable_url("https://example.com/a?b=1")
    cdp.assert_fetchable_url("http://8.8.8.8/x")             # 公网 IP 可以


@pytest.mark.parametrize("addr", ["100.64.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1"])
def test_cdp_dns_to_shared_or_mapped_internal_is_blocked(monkeypatch, addr):
    """审计 B1:域名解析到共享地址段 / 映射写法的内网地址,同样拒绝。"""
    fam = 10 if ":" in addr else 2
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda *a, **k: [(fam, 1, 6, "", (addr, 0))])
    with pytest.raises(cdp.CdpError, match="内网地址"):
        cdp.assert_fetchable_url("https://evil.example/a")


def test_cdp_public_v6_and_mapped_public_allowed(monkeypatch):
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda *a, **k: [(10, 1, 6, "", ("2606:4700::1111", 0))])
    cdp.assert_fetchable_url("https://example.com/a")
    cdp.assert_fetchable_url("http://[::ffff:8.8.8.8]/")
    cdp.assert_fetchable_url("http://100.128.0.1/")         # 共享段之外紧邻的公网地址


def test_cdp_fake_ip_resolver_does_not_block_everything(monkeypatch):
    """🔴 本机真实环境:走 fake-IP 代理时 `example.com` 解析成 198.18.0.98。
    照"私有段就拒绝"办会把**所有**网页访问拦死,而这类用户正是主要受众;
    且此时本地解析结果与 Chrome 实际连接无关 —— 没信息就别假装做了检查。"""
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("198.18.0.98", 0))])
    cdp.assert_fetchable_url("https://example.com/a")        # 不许因为 fake-IP 就拒绝
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("240.1.2.3", 0))])
    cdp.assert_fetchable_url("https://example.com/a")
    # 但字面写内网 IP 仍然拒绝 —— 那一道与解析器可信度无关,始终生效
    with pytest.raises(cdp.CdpError):
        cdp.assert_fetchable_url("http://198.18.0.98/admin")


def test_cdp_frame_size_cap_is_enforced():
    """帧长上限:对端(或被劫持的端点)声明一个超大长度不该把内存吃光(P1)。"""
    class FakeSock:
        def settimeout(self, _t): pass
        def recv(self, _n): return b""
    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = FakeSock(), b"\x81\x7f" + (cdp.MAX_FRAME_BYTES + 1).to_bytes(8, "big")
    with pytest.raises(cdp.CdpError, match="超过上限"):
        ws._read_frame()


def test_cdp_reassembles_fragments_and_answers_ping():
    """分片重组 + ping→pong:**页面正文就是大消息,一定会分片**,初版会把半条 JSON 拿去解析(P1)。"""
    sent = []

    class FakeSock:
        def settimeout(self, _t): pass
        def sendall(self, b): sent.append(b)
        def recv(self, _n): return b""

    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = FakeSock(), b""
    frame = lambda fin, op, data: bytes([(0x80 if fin else 0) | op, len(data)]) + data
    ws.buf = (frame(False, 0x1, b'{"id":1,')            # 起始帧(未完)
              + frame(True, 0x9, b"hi")                  # 中间插一个 ping
              + frame(True, 0x0, b'"result":{}}'))       # continuation 收尾
    assert ws.recv_json(deadline=cdp.time.monotonic() + 5) == {"id": 1, "result": {}}
    assert sent and (sent[0][0] & 0x0F) == 0xA           # 回了 pong


def test_cdp_close_frame_raises_not_hangs():
    class FakeSock:
        def settimeout(self, _t): pass
        def sendall(self, _b): pass
        def recv(self, _n): return b""
    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = FakeSock(), bytes([0x88, 0])
    with pytest.raises(cdp.CdpError, match="关闭"):
        ws.recv_json(deadline=cdp.time.monotonic() + 5)


def test_search_drops_urlless_rows_and_fails_when_all_bad(monkeypatch):
    """通道返回畸形记录时明确失败 —— 别让空 URL 静默变成一条"取到了"的证据(P2)。"""
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "bad", lambda q, n, e: [{"title": "T", "url": ""}])
    with pytest.raises(retrieval.RetrievalError, match="没有一条带可用的 http"):
        retrieval.search("q", provider="bad")
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "mixed",
                        lambda q, n, e: [{"title": "A", "url": ""}, {"title": "B", "url": "https://ok/1"}])
    assert [r["title"] for r in retrieval.search("q", provider="mixed")] == ["B"]


def test_fetch_page_empty_body_fails_loudly(monkeypatch):
    """空正文多半是拦截页 / 需登录 —— **宁可当场报错**,不要产出一条"取到了但没内容"的证据(P2)。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "blank", lambda u, m, e: "   \n ")
    with pytest.raises(retrieval.RetrievalError, match="正文为空"):
        retrieval.fetch_page("https://a", provider="blank")


def test_channel_exceptions_are_redacted(monkeypatch):
    """通道异常在 Core 边界统一脱敏 —— 第三方库常把带 key 的 URL 原样抛出来(P3)。"""
    def leaky(*_a):
        raise ValueError("HTTP 401 for https://api.x.com/search?api_key=sk-LEAKED-123&q=a")
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "leaky", leaky)
    with pytest.raises(retrieval.RetrievalError) as ei:
        retrieval.search("q", provider="leaky")
    assert "sk-LEAKED-123" not in str(ei.value)
    assert "leaky 通道失败(ValueError)" in str(ei.value)
    # 链式 __cause__ 也不能把原始异常带出去(它会进 traceback / 日志)
    assert ei.value.__cause__ is None


def test_cdp_is_read_only_by_construction():
    """本模块**只读**:不提供点击 / 填表 / 提交 / 下载。它操作的是用户真实浏览器与登录态,
    要做交互式操作必须另行设计授权与审计,不能从这里悄悄长出来。"""
    api = {n for n in dir(cdp) if not n.startswith("_")}
    for forbidden in ("click", "type_text", "submit", "fill", "download", "screenshot_upload"):
        assert forbidden not in api
    assert {"fetch_rendered", "is_available", "endpoint_hint"} <= api


def test_cdp_rejects_masked_server_frame():
    """服务端按 RFC **不得**加掩码。初版"容错地解掩码"既解错(掩码键不计入长度,会少读 4 字节
    导致此后整条连接错帧)又不该有 —— 正确做法是拒绝(r2a P1-1)。"""
    class FakeSock:
        def settimeout(self, _t): pass
        def recv(self, _n): return b""
    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = FakeSock(), bytes([0x81, 0x84]) + b"\x00\x00\x00\x00" + b"test"
    with pytest.raises(cdp.CdpError, match="掩码"):
        ws._read_frame()


def test_cdp_rejects_new_text_frame_mid_fragment():
    """分片没收完又来一个起始帧 —— 拼下去会得到"能解析但内容错位"的 JSON(r2a P1-1)。"""
    class FakeSock:
        def settimeout(self, _t): pass
        def sendall(self, _b): pass
        def recv(self, _n): return b""
    ws = cdp._Ws.__new__(cdp._Ws)
    frame = lambda fin, op, data: bytes([(0x80 if fin else 0) | op, len(data)]) + data
    ws.s, ws.buf = FakeSock(), frame(False, 0x1, b'{"a":1') + frame(True, 0x1, b'{"b":2}')
    with pytest.raises(cdp.CdpError, match="分片未结束"):
        ws.recv_json(deadline=cdp.time.monotonic() + 5)


def test_cdp_rejects_oversized_control_frame():
    """控制帧必须 FIN=1 且 ≤125 字节,否则会被用来放大 pong 回发。"""
    class FakeSock:
        def settimeout(self, _t): pass
        def recv(self, _n): return b""
    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = FakeSock(), bytes([0x89, 126]) + (200).to_bytes(2, "big") + b"x" * 200
    with pytest.raises(cdp.CdpError, match="控制帧"):
        ws._read_frame()
    ws.buf = bytes([0x09, 3]) + b"abc"                       # FIN=0 的 ping
    with pytest.raises(cdp.CdpError, match="控制帧"):
        ws._read_frame()


def test_cdp_rejects_non_object_json():
    class FakeSock:
        def settimeout(self, _t): pass
        def recv(self, _n): return b""
    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = FakeSock(), bytes([0x81, 2]) + b"[]"
    with pytest.raises(cdp.CdpError, match="不是 JSON 对象"):
        ws.recv_json(deadline=cdp.time.monotonic() + 5)


def test_cdp_domain_resolving_to_private_is_rejected(monkeypatch):
    """DNS 预解析:域名解析到内网就拒绝。⚠️ 这是**纵深防御不是边界** —— Chrome 会自己再解析
    一次,rebinding 挡不住;真正兜底的是导航后对最终 URL 再验一次。"""
    monkeypatch.setattr(cdp.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 0))])
    with pytest.raises(cdp.CdpError, match="解析到内网"):
        cdp.assert_fetchable_url("https://rebind.example.com/x")
    monkeypatch.setattr(cdp.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))])
    cdp.assert_fetchable_url("https://example.com/x")        # 公网解析:放行


def test_cdp_url_length_capped():
    with pytest.raises(cdp.CdpError, match="过长"):
        cdp.assert_fetchable_url("https://example.com/" + "a" * cdp.MAX_URL_CHARS)


def test_fetch_page_records_final_url_after_redirect(monkeypatch):
    """通道返回 (正文, 最终URL) 时,证据记的必须是**最终 URL**,并保留 requested_url 供核对。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "redir",
                        lambda u, m, e: ("正文", "https://final.example/landed"))
    r = retrieval.fetch_page("https://start.example/a", provider="redir")
    assert r["url"] == "https://final.example/landed"
    assert r["requested_url"] == "https://start.example/a"
    monkeypatch.setitem(retrieval._PAGE_IMPL, "same", lambda u, m, e: ("正文", "https://a/b"))
    assert "requested_url" not in retrieval.fetch_page("https://a/b", provider="same")


def test_fake_ip_skip_requires_all_results_to_be_fake(monkeypatch):
    """🔴 上一轮我把"跳过"写成了"任意一条是 fake-IP",攻击者同时返回 198.18.0.10 与 127.0.0.1
    就能让整组检查失效(r3 P1)。必须**全部**结果都是 fake-IP 才允许跳过。"""
    monkeypatch.setattr(cdp.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("198.18.0.10", 0)), (2, 1, 6, "", ("127.0.0.1", 0))])
    with pytest.raises(cdp.CdpError, match="解析到内网"):
        cdp.assert_fetchable_url("https://mixed.example.com/x")


def test_ws_deadline_survives_slow_drip():
    """绝对截止必须贯穿**每一次 recv** —— 对端每次滴几个字节就能让"每次 recv 都不超时",
    而整体远超预算(r3 P2)。"""
    class DripSock:
        def __init__(self): self.n = 0
        def settimeout(self, _t): pass
        def recv(self, _n):
            self.n += 1
            return b"x"
    ws = cdp._Ws.__new__(cdp._Ws)
    ws.s, ws.buf = DripSock(), b""
    ws._deadline = cdp.time.monotonic() - 1        # 预算已耗尽
    with pytest.raises(cdp.CdpError, match="超时"):
        ws._read(10_000)
    assert ws.s.n == 0                             # 一次 recv 都不该发生


class _FakeResp:
    def __init__(self, chunks): self.chunks = list(chunks)
    def read1(self, _n=None): return self.chunks.pop(0) if self.chunks else b""
    def __enter__(self): return self
    def __exit__(self, *_a): return False


def test_http_json_rejects_non_object(monkeypatch):
    monkeypatch.setattr(cdp.urllib.request, "urlopen", lambda *a, **k: _FakeResp([b"[]"]))
    with pytest.raises(cdp.CdpError, match="不是 JSON 对象"):
        cdp._http_json("/json/version")


def test_http_json_absolute_deadline_stops_slow_drip(monkeypatch):
    """🔴 `timeout` 只管**单次**阻塞;对端每次滴一个字节、每次都不超时,就能无限拖住。
    4MB 上限管内存不管时间 —— 两个都要有(r4 P1)。"""
    class Drip:
        def read1(self, _n=None):
            cdp.time.sleep(0.02)
            return b"x"
        def __enter__(self): return self
        def __exit__(self, *_a): return False
    monkeypatch.setattr(cdp.urllib.request, "urlopen", lambda *a, **k: Drip())
    with pytest.raises(cdp.CdpError, match="超时"):
        cdp._http_json("/json/version", timeout=0)


def test_http_json_uses_read1_not_read(monkeypatch):
    """🔴 `read(n)` 在 http.client 内部会循环凑满 n 字节 —— deadline 只能在两次 read 之间检查,
    慢速滴流打不断。必须用 `read1`(单次底层读就返回)(r5)。"""
    used = []

    class Probe:
        def read1(self, _n=None):
            used.append("read1")
            return b'{"ok":1}' if len(used) == 1 else b""
        def read(self, _n=None):
            used.append("read")
            return b'{"ok":1}'
        def __enter__(self): return self
        def __exit__(self, *_a): return False

    monkeypatch.setattr(cdp.urllib.request, "urlopen", lambda *a, **k: Probe())
    assert cdp._http_json("/json/version") == {"ok": 1}
    assert "read" not in used


def test_http_json_keeps_precise_reason(monkeypatch):
    """自己抛的 CdpHttpError 不该被外层 `except Exception` 再包成通用的"连不上"提示。"""
    monkeypatch.setattr(cdp.urllib.request, "urlopen",
                        lambda *a, **k: _FakeResp([b"x" * (cdp.MAX_HTTP_BYTES + 1)]))
    with pytest.raises(cdp.CdpError, match="超过") as ei:
        cdp._http_json("/json/version")
    assert "未连上" not in str(ei.value)


class _ScriptedWs:
    """按 CDP 方法名脚本化应答的假连接,用来端到端测 `fetch_rendered` 的判定逻辑。"""

    def __init__(self, script, events=None):
        self.script, self.pending, self.closed = script, None, False
        self.events = dict(events or {})          # 方法名 → 回应它之前先推送的事件(模拟 Fetch.requestPaused)
        self.queue, self.sent = [], []

    def send_json(self, payload, deadline=None):
        self.sent.append((payload["method"], payload.get("params") or {}))
        if payload["method"].startswith("Fetch.") and payload["method"] != "Fetch.enable":
            return                                 # 对拦截点的回应:Chrome 会回一个不需要等的结果,这里略过
        self.pending = (payload["id"], payload["method"], payload.get("params") or {})
        self.queue = list(self.events.pop(payload["method"], []))

    def recv_json(self, _deadline):
        if self.queue:
            return self.queue.pop(0)
        mid, method, params = self.pending
        expr = str(params.get("expression", ""))
        key = "state" if "readyState" in expr else ("body" if "innerText" in expr else method)
        val = self.script.get(key, {})
        val = val() if callable(val) else val
        return {"id": mid, "result": ({"result": {"value": val}} if key in ("state", "body") else val)}

    def close(self): self.closed = True


def _run_fetch(monkeypatch, script, events=None):
    monkeypatch.setattr(cdp, "_http_json",
                        lambda p, timeout=5, method="GET":
                        {"id": "T1", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/x"} if "new" in p else {})
    ws = _ScriptedWs(script, events)
    monkeypatch.setattr(cdp, "_Ws", lambda *_a, **_k: ws)
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))])
    return ws


def test_fetch_rendered_happy_path(monkeypatch):
    ws = _run_fetch(monkeypatch, {"Page.enable": {}, "Page.navigate": {},
                                  "state": {"readyState": "complete", "href": "https://ok.example/a"},
                                  "body": {"href": "https://ok.example/a", "text": "正文内容"}})
    assert cdp.fetch_rendered("https://ok.example/a") == ("正文内容", "https://ok.example/a")
    assert ws.closed


def test_fetch_rendered_rejects_jump_between_check_and_extract(monkeypatch):
    """🔴 校验完最终 URL、还没取正文时,页面可以用 setTimeout / meta refresh 跳走。
    分两次取就会把**跳转后页面的正文**挂在**跳转前的 URL**名下 —— 一条看着成功的错误证据(r3 P1)。"""
    _run_fetch(monkeypatch, {"Page.enable": {}, "Page.navigate": {},
                             "state": {"readyState": "complete", "href": "https://ok.example/a"},
                             "body": {"href": "http://127.0.0.1:8080/admin", "text": "内网管理页"}})
    with pytest.raises(cdp.CdpError):
        cdp.fetch_rendered("https://ok.example/a")


def test_fetch_rendered_fails_on_navigate_error(monkeypatch):
    """DNS / 连接失败会落到 chrome-error:// 页面,**它是有正文的** —— 不拦就成了错误证据。"""
    _run_fetch(monkeypatch, {"Page.enable": {}, "Page.navigate": {"errorText": "net::ERR_NAME_NOT_RESOLVED"},
                             "state": {}, "body": {}})
    with pytest.raises(cdp.CdpError, match="导航失败"):
        cdp.fetch_rendered("https://nope.example/a")


def _paused(rid, url, rtype="Document"):
    return {"method": "Fetch.requestPaused", "params": {"requestId": rid, "request": {"url": url}, "resourceType": rtype}}


def test_fetch_rendered_blocks_redirect_to_internal_before_request(monkeypatch):
    """🔴 审计 B2:公网地址 302 跳到 127.0.0.1 —— 必须在 Chrome **发出**内网请求之前拒绝(failRequest),
    不能等落地后再查 URL(那时内网接口已经收到请求)。"""
    ws = _run_fetch(monkeypatch,
                    {"Page.navigate": {"errorText": "net::ERR_BLOCKED_BY_CLIENT"},
                     "state": {"readyState": "complete", "href": "chrome-error://chromewebdata/"}, "body": {}},
                    events={"Page.navigate": [_paused("r1", "https://ok.example/a"),
                                              _paused("r2", "http://127.0.0.1:8080/admin")]})
    with pytest.raises(cdp.CdpError, match="被拦截"):
        cdp.fetch_rendered("https://ok.example/a")
    acts = [(m, p.get("requestId")) for m, p in ws.sent if m in ("Fetch.continueRequest", "Fetch.failRequest")]
    assert acts == [("Fetch.continueRequest", "r1"), ("Fetch.failRequest", "r2")]
    enable = [p for m, p in ws.sent if m == "Fetch.enable"]
    assert enable and enable[0]["patterns"] == [{"urlPattern": "*", "requestStage": "Request"}], "所有资源类型都拦,不只页面"
    assert ws.closed


def test_fetch_rendered_blocks_internal_subresources_but_keeps_page(monkeypatch):
    """🔴 审计第二轮 B2:公网页面里的 `<img src=127.0.0.1>`、脚本发起的 XHR / fetch 指向内网 ——
    发包前拒绝;子资源被拦不连累正文。WebSocket 一类拦截管不到的入口在页面脚本运行前关掉。"""
    ws = _run_fetch(monkeypatch,
                    {"state": {"readyState": "complete", "href": "https://ok.example/a"},
                     "body": {"href": "https://ok.example/a", "text": "正文"}},
                    events={"Page.navigate": [_paused("r1", "https://ok.example/a"),
                                              _paused("r2", "http://127.0.0.1:8080/admin?x=1", "Image"),
                                              _paused("r3", "http://10.0.0.5/api", "XHR"),
                                              _paused("r4", "https://cdn.ok.example/app.js", "Script"),
                                              _paused("r5", "http://[::ffff:7f00:1]/f", "Fetch")]})
    assert cdp.fetch_rendered("https://ok.example/a") == ("正文", "https://ok.example/a")
    acts = [(m, p.get("requestId")) for m, p in ws.sent if m in ("Fetch.continueRequest", "Fetch.failRequest")]
    assert acts == [("Fetch.continueRequest", "r1"), ("Fetch.failRequest", "r2"), ("Fetch.failRequest", "r3"),
                    ("Fetch.continueRequest", "r4"), ("Fetch.failRequest", "r5")]
    order = [m for m, _ in ws.sent if not m.startswith("Fetch.") or m == "Fetch.enable"]
    assert order.index("Page.addScriptToEvaluateOnNewDocument") < order.index("Page.navigate")
    src = [p for m, p in ws.sent if m == "Page.addScriptToEvaluateOnNewDocument"][0]["source"]
    for k in ("WebSocket", "RTCPeerConnection", "WebTransport"):
        assert k in src


def test_request_verdict_cache_is_per_host(monkeypatch):
    calls = []
    monkeypatch.setattr(cdp.socket, "getaddrinfo", lambda h, *a, **k: calls.append(h) or [(2, 1, 6, "", ("93.184.216.34", 0))])
    cache = {}
    for i in range(5):
        assert cdp._request_blocked_reason(f"https://img.ok.example/{i}.png", cache) is None
    assert calls == ["img.ok.example"], "同一主机只解析一次"
    assert cdp._request_blocked_reason("http://127.0.0.1/x", cache) and cdp._request_blocked_reason("http://127.0.0.1/y", cache)


def test_fetch_rendered_blocks_late_script_jump(monkeypatch):
    """页面加载完后脚本跳去内网:拦截点在轮询时收到,同样拒绝,不返回正文。"""
    ws = _run_fetch(monkeypatch,
                    {"state": {"readyState": "complete", "href": "https://ok.example/a"},
                     "body": {"href": "https://ok.example/a", "text": "正文"}},
                    events={"Runtime.evaluate": [_paused("r9", "http://[::ffff:169.254.169.254]/latest/")]})
    with pytest.raises(cdp.CdpError, match="被拦截"):
        cdp.fetch_rendered("https://ok.example/a")
    assert ("Fetch.failRequest", "r9") in [(m, p.get("requestId")) for m, p in ws.sent]


def test_fetch_rendered_allows_public_redirect_and_data_urls(monkeypatch):
    ws = _run_fetch(monkeypatch,
                    {"state": {"readyState": "complete", "href": "https://ok.example/b"},
                     "body": {"href": "https://ok.example/b", "text": "正文"}},
                    events={"Page.navigate": [_paused("r1", "https://ok.example/a"), _paused("r2", "https://ok.example/b"),
                                              _paused("r3", "data:text/html,hi")]})
    assert cdp.fetch_rendered("https://ok.example/a") == ("正文", "https://ok.example/b")
    assert [m for m, _ in ws.sent if m.startswith("Fetch.") and m != "Fetch.enable"] == ["Fetch.continueRequest"] * 3


def test_fetch_rendered_ignores_stale_about_blank(monkeypatch):
    """刚 navigate 时读到的可能还是 about:blank 的 complete —— 不能当成导航完成。"""
    seq = iter([{"readyState": "complete", "href": "about:blank"},
                {"readyState": "complete", "href": "https://ok.example/a"}])
    _run_fetch(monkeypatch, {"Page.enable": {}, "Page.navigate": {}, "state": lambda: next(seq),
                             "body": {"href": "https://ok.example/a", "text": "正文"}})
    assert cdp.fetch_rendered("https://ok.example/a")[1] == "https://ok.example/a"


# ---------- 检索层审计后的回归 ----------

def test_search_passes_through_raw_ref(monkeypatch):
    """🔴 上游给的 `raw_ref` 必须透传。曾在 `_exa_free` 映射时丢掉 —— 那等于在 Core 就把
    "每个数字追到 raw 响应"这条链剪断,下游再也追不回来。"""
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "withref",
                        lambda q, n, e: [{"title": "T", "url": "https://a/b", "raw_ref": "raw/exa_1.json"}])
    assert retrieval.search("q", provider="withref")[0]["raw_ref"] == "raw/exa_1.json"


def test_fetch_page_carries_raw_and_checksum(monkeypatch):
    """`text` 是截断的阅读版,**不是证据本体**;调用方要靠 `raw` + `raw_sha256` 落盘。"""
    import hashlib
    monkeypatch.setitem(retrieval._PAGE_IMPL, "big", lambda u, m, e: "内容" * 3000)
    r = retrieval.fetch_page("https://a/b", max_chars=100, provider="big")
    assert len(r["text"]) == 100 and r["truncated"] is True
    assert r["raw"] == "内容" * 3000
    assert r["raw_sha256"] == hashlib.sha256(("内容" * 3000).encode()).hexdigest()


def test_configured_key_never_breaks_the_free_path(monkeypatch):
    """🔴 配了 key 却选中**未注册**的通道 → 报"未知通道",等于"配了 key 反而不能用",
    与"零配置优先、可选升级"完全相反。自动选通道只许选已注册的。"""
    env = {"VRA_EXA_API_KEY": "sk-configured-but-not-wired"}
    assert retrieval._pick_search(env) == "exa_free"
    assert retrieval.available_upgrades(env) == ["exa"]          # 仍如实报告"可升级"
    retrieval.register_search_provider("exa_key", lambda q, n, e: [{"title": "K", "url": "https://k/1"}])
    try:
        assert retrieval._pick_search(env) == "exa_key"          # 接上之后才切过去
    finally:
        retrieval._SEARCH_IMPL.pop("exa_key", None)


def test_firecrawl_not_reported_twice():
    """firecrawl 同时在搜索表和取页表里 —— 不该报两遍。"""
    assert retrieval.available_upgrades({"VRA_FIRECRAWL_API_KEY": "x" * 20}) == ["firecrawl"]


def test_provider_raised_error_is_also_redacted(monkeypatch):
    """provider **自己抛的 RetrievalError** 同样可能拼了 key,不能因为类型对就原样放行。"""
    key = "sk-provider-raised-secret-value"
    def leak(q, n, e):
        raise retrieval.RetrievalError(f"request failed: {e['VRA_EXA_API_KEY']}")
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "leak", leak)
    with pytest.raises(retrieval.RetrievalError) as ei:
        retrieval.search("q", provider="leak", env={"VRA_EXA_API_KEY": key})
    assert key not in str(ei.value)


@pytest.mark.parametrize("msg", [
    "credential sk-exact-value-here-12345 rejected",             # 参数名不匹配任何模式
    "X-Api-Key: sk-exact-value-here-12345",                      # 带前缀
    "https://host/sk-exact-value-here-12345/path",               # 放在 path 里
    'token="sk-exact-value-here-12345 with spaces"',             # 带引号和空格
])
def test_configured_key_redacted_by_exact_value_not_pattern(msg):
    """🔴 正则 denylist 永远能被绕过。但**我们自己配置的 key 手里就有真实值** ——
    按精确值替换,写法怎么变都拦得住。这一档是可靠的,模式匹配那档只是尽力而为。"""
    key = "sk-exact-value-here-12345"
    assert key not in retrieval._redact(msg, {"VRA_EXA_API_KEY": key})


def test_record_url_strips_userinfo_but_keeps_query(monkeypatch):
    """userinfo 是真实凭据载体,必须剥;query 是页面身份的一部分,剥了就毁掉溯源。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "u",
                        lambda url, m, e: ("正文", "https://user:pw@h.example/p?id=7"))
    r = retrieval.fetch_page("https://h.example/start", provider="u")
    assert r["url"] == "https://h.example/p?id=7"
    assert "pw" not in r["url"] and "user" not in r["url"]


@pytest.mark.parametrize("bad", ["javascript:alert(1)", "data:text/html,x", "not a url", "ftp://h/x", "  "])
def test_search_rejects_non_http_urls(monkeypatch, bad):
    """只验非空是不够的 —— `javascript:` / `data:` / 畸形值都做不成可取证的证据。"""
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "weird", lambda q, n, e: [{"title": "T", "url": bad}])
    with pytest.raises(retrieval.RetrievalError, match="http"):
        retrieval.search("q", provider="weird")


def test_blocked_page_fails_by_default_and_needs_explicit_optin(monkeypatch):
    """🔴 默认安全 + 例外可控。只打标不拒绝的话,下游 mapper 忘了看那个字段,就会落盘一份
    "有 URL、有 raw、有校验和"、内容却是登录页的证据 —— 形式完全合规。
    而校验和只能证明保存的拦截页没被改过,证明不了它是目标内容。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "blocked", lambda u, m, e: "Access Denied. Please enable JavaScript.")
    with pytest.raises(retrieval.RetrievalError, match="疑似拦截"):
        retrieval.fetch_page("https://a/b", provider="blocked")
    ok = retrieval.fetch_page("https://a/b", provider="blocked", allow_suspect_block=True)
    assert ok["suspect_block"] is True                                # opt-in 后仍如实标记
    long_article = "本文讨论 CAPTCHA 的历史。" * 200                     # 长正文提到关键词 → 不该误杀
    monkeypatch.setitem(retrieval._PAGE_IMPL, "article", lambda u, m, e: long_article)
    assert retrieval.fetch_page("https://a/b", provider="article")["suspect_block"] is False


def test_url_is_cleaned_before_reaching_provider(monkeypatch):
    """🔴 清洗必须在**调用通道之前**。原来是先把原始 URL 交给通道、之后才清洗 ——
    `_jina` 会把 `user:pass@host` 整个拼给 r.jina.ai,**凭据已经发出去了**,返回值再剥也撤不回。"""
    seen = []
    monkeypatch.setitem(retrieval._PAGE_IMPL, "spy", lambda u, m, e: (seen.append(u), "正文")[1])
    retrieval.fetch_page("https://alice:secret@h.example/report", provider="spy")
    assert seen == ["https://h.example/report"]
    assert "secret" not in seen[0]


@pytest.mark.parametrize("bad", ["file:///etc/passwd", "ftp://h/x", "javascript:alert(1)", "https://h/x\npath"])
def test_non_http_url_never_reaches_provider(monkeypatch, bad):
    called = []
    monkeypatch.setitem(retrieval._PAGE_IMPL, "spy2", lambda u, m, e: (called.append(u), "x")[1])
    with pytest.raises(retrieval.RetrievalError, match="http"):
        retrieval.fetch_page(bad, provider="spy2")
    assert called == []


@pytest.mark.parametrize("bad_final", ["", "   ", "about:blank", "not a url"])
def test_invalid_final_url_fails_instead_of_falling_back(monkeypatch, bad_final):
    """🔴 通道选了元组契约就代表"最终 URL 有溯源意义"。它非法时回退到请求 URL,
    会把登录页 / 错误页的正文挂到目标地址名下,还配一个合法校验和 —— 必须失败。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "badfinal", lambda u, m, e: ("登录页正文", bad_final))
    with pytest.raises(retrieval.RetrievalError, match="最终 URL 不合法"):
        retrieval.fetch_page("https://bank.example/report", provider="badfinal")


def test_presigned_query_credentials_are_redacted_but_identity_kept(monkeypatch):
    """预签名 URL 把凭据放 query 里,会一路进证据 / 日志 / 报告 ⇒ **只抹值、留参数名**,
    普通参数(页面身份)原样保留。"""
    monkeypatch.setitem(retrieval._SEARCH_IMPL, "signed", lambda q, n, e: [
        {"title": "T", "url": "https://s3.example/o?id=42&X-Amz-Signature=abc123&page=2&token=zzz"}])
    url = retrieval.search("q", provider="signed")[0]["url"]
    assert "abc123" not in url and "zzz" not in url
    assert "X-Amz-Signature=***" in url and "token=***" in url
    assert "id=42" in url and "page=2" in url                        # 页面身份不能被毁掉


def test_url_encoded_key_is_also_redacted():
    """通道把 key URL 编码后拼进异常时,精确替换也要命中。"""
    key = "sk-secret/value+with=chars"
    msg = f"failed: {retrieval.urllib.parse.quote(key, safe='')}"
    assert "secret" not in retrieval._redact(msg, {"VRA_EXA_API_KEY": key})


def test_unknown_provider_error_does_not_echo_a_configured_key():
    """guard **外**的错误也会回显入参 —— 调用方误把 token 当 provider 传进来时不能原样写进异常。"""
    key = "sk-mistakenly-passed-as-provider"
    with pytest.raises(retrieval.RetrievalError) as ei:
        retrieval.search("q", provider=key, env={"VRA_EXA_API_KEY": key})
    assert key not in str(ei.value)


@pytest.mark.parametrize("bad", [(), ("only-one",), ("a", "b", "c")])
def test_malformed_tuple_goes_through_error_envelope(monkeypatch, bad):
    """畸形返回值也要走统一错误信封(否则是未包装的 IndexError,绕过脱敏)。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "bad", lambda u, m, e: bad)
    with pytest.raises(retrieval.RetrievalError):
        retrieval.fetch_page("https://a/b", provider="bad")


@pytest.mark.parametrize("bad", [0, -1, "100", None, True])
def test_max_chars_must_be_positive_int(bad):
    with pytest.raises(retrieval.RetrievalError, match="max_chars"):
        retrieval.fetch_page("https://a/b", max_chars=bad, provider="jina")


def test_empty_body_error_does_not_leak_query(monkeypatch):
    """报错消息里的 URL 连 query 一起剥 —— 排障不需要签名参数,日志里也不该有。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "blank", lambda u, m, e: "")
    with pytest.raises(retrieval.RetrievalError) as ei:
        retrieval.fetch_page("https://h.example/p?api_key=SECRETVALUE123", provider="blank")
    assert "SECRETVALUE123" not in str(ei.value)


def test_request_url_keeps_query_intact_so_presigned_urls_still_work(monkeypatch):
    """🔴 发送用与记账用是两种语义。一度共用带脱敏的那个函数,于是预签名 URL 的签名
    **在真正发出去之前**就被改成 `***`,请求必然 403 还可能被判成拦截页(Codex r3 P1)。"""
    seen = []
    signed = "https://bucket.example/f.pdf?X-Amz-Signature=abc123&X-Amz-Credential=cred&id=7"
    monkeypatch.setitem(retrieval._PAGE_IMPL, "spy3", lambda u, m, e: (seen.append(u), "正文")[1])
    r = retrieval.fetch_page(signed, provider="spy3")
    assert seen[0] == signed                                  # 发出去的必须完整可用
    assert "abc123" not in r["url"] and "X-Amz-Signature=***" in r["url"]   # 记下来的才脱敏
    assert "id=7" in r["url"]


def test_record_url_decodes_param_name_before_matching():
    """参数名不先 URL 解码就能被 `%74oken=` 绕过(r3 P2)。"""
    out = retrieval._record_url("https://h.example/?%74oken=secretvalue&X-Amz-%53ignature=sig")
    assert "secretvalue" not in out and "sig" not in out.split("=")[-1]


@pytest.mark.parametrize("bad", ["https://h.example:not-a-port/x", "https://h.example:99999/x"])
def test_invalid_port_does_not_escape_as_valueerror(bad):
    """非法端口在 `p.port` 抛原生 ValueError,且发生在 guard 之外 —— 必须转成 RetrievalError。"""
    assert retrieval._request_url(bad) == ""
    with pytest.raises(retrieval.RetrievalError):
        retrieval.fetch_page(bad, provider="jina")


def test_ipv6_host_keeps_brackets():
    """`p.hostname` 不带方括号,重建 netloc 时不补回去就会拼出非法 URL(r3 P2)。"""
    assert retrieval._request_url("https://[2001:db8::1]:8443/page") == "https://[2001:db8::1]:8443/page"


def test_illegal_url_error_hides_path():
    """未通过校验的 URL 什么都可能是,path 里就可能直接躺着凭据 ⇒ 报错只给 scheme+host。"""
    with pytest.raises(retrieval.RetrievalError) as ei:
        retrieval.fetch_page("ftp://h.example/private/sk-live-SECRETVALUE", provider="jina")
    assert "SECRETVALUE" not in str(ei.value) and "h.example" in str(ei.value)


def test_record_url_redacts_fragment_credentials():
    """🔴 OAuth implicit flow 把 `access_token` 放在 `#` 后面 —— 只处理 query 会漏掉整整一类
    真实场景(Codex r4 P1)。但 SPA 路由 `#/page/2` 不含 `=`,是页面身份,要留着。"""
    out = retrieval._record_url("https://h.example/callback#access_token=SECRETVAL&state=xyz")
    assert "SECRETVAL" not in out and "access_token=***" in out and "state=xyz" in out
    assert retrieval._record_url("https://h.example/app#/page/2").endswith("#/page/2")


def test_provider_illegal_final_url_error_hides_path(monkeypatch):
    """与初始 URL 同一条防线:未通过校验的 URL,path 里就可能躺着凭据。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "badf",
                        lambda u, m, e: ("正文", "ftp://h.example/private/sk-live-SECRETVALUE"))
    with pytest.raises(retrieval.RetrievalError) as ei:
        retrieval.fetch_page("https://h.example/a", provider="badf")
    assert "SECRETVALUE" not in str(ei.value)


def test_final_url_known_flag_marks_provider_capability(monkeypatch):
    """通道报不出最终 URL 时**不要假装知道** —— 把"不知道"标出来,
    和产品里"未接入 ≠ 零""预估"是同一套做法(Codex r4 P2)。"""
    monkeypatch.setitem(retrieval._PAGE_IMPL, "plain", lambda u, m, e: "正文")
    assert retrieval.fetch_page("https://a.example/b", provider="plain")["final_url_known"] is False
    monkeypatch.setitem(retrieval._PAGE_IMPL, "withurl", lambda u, m, e: ("正文", "https://a.example/c"))
    r = retrieval.fetch_page("https://a.example/b", provider="withurl")
    assert r["final_url_known"] is True and r["url"] == "https://a.example/c"


@pytest.mark.parametrize("raw,leaked", [
    ("https://h/cb#access_token=abc;def", "def"),              # `;` 在值里是合法字符,不是分隔符
    ("https://h/#/callback?access_token=SECRETV", "SECRETV"),  # SPA OAuth 回调
    ("https://h/x?a=1;token=SECRETV", "SECRETV"),              # 敏感名不在段首
    ("https://h/x?token=ab&cd", "cd"),                         # 未编码的值被 `&` 切开的后半截
])
def test_redaction_does_not_depend_on_ambiguous_delimiters(raw, leaked):
    """🔴 按分隔符切开再逐段判会漏 —— `;` 可能是值的一部分,敏感名也可能不在段首(Codex r4/r5)。
    改为扫描"分隔符 + 敏感名 =",命中后一直抹到段尾:宁可多抹,不放过。"""
    assert leaked not in retrieval._record_url(raw)


def test_redaction_keeps_page_identity():
    """多抹一点可以,但不能把页面身份也抹掉。"""
    out = retrieval._record_url("https://h/x?id=42&token=SECRETV&page=2#/route/7")
    assert "id=42" in out and "page=2" in out and out.endswith("#/route/7")
    assert "SECRETV" not in out


@pytest.mark.parametrize("raw", [
    "https://h/#/callback%3Faccess_token=SECRETV",              # 编码的 `?`
    "https://h/?redirect=%2Fcallback%3Faccess_token=SECRETV",   # OAuth 回调被塞进 redirect 参数
    "https://h/#/cb%253Faccess_token=SECRETV",                  # 双重编码
])
def test_percent_encoded_delimiters_do_not_bypass_redaction(raw):
    """🔴 分隔符本身可以被百分号编码 —— `%3F` 不是 `?`,按字符扫描看不见(Codex r6)。
    在解码视图上**只做检测**,命中就从原串第一个 `=` 起整段抹掉(绝不输出解码串,那会改 URL 身份)。"""
    assert "SECRETV" not in retrieval._record_url(raw)


def test_encoded_view_detection_does_not_rewrite_normal_urls():
    """解码视图只用于检测:正常的编码 URL 不该被改写,也不该被误抹。"""
    out = retrieval._record_url("https://h/s?q=%E4%B8%AD%E6%96%87&page=2")
    assert out == "https://h/s?q=%E4%B8%AD%E6%96%87&page=2"


@pytest.mark.parametrize("raw", [
    "https://h/?redirect=%2Fcallback%26access_token=SECRETV",   # 编码的 `&`
    "https://h/?redirect=%2Fcallback%23access_token=SECRETV",   # 编码的 `#`
    "https://h/?r=%25%32%36access_token=SECRETV",               # 三重编码
])
def test_encoded_ampersand_hash_and_triple_encoding(raw):
    """🔴 解码视图的分隔符集合必须比原串更宽(`%26`/`%23` 解码后会变回 `&`/`#`),
    且**解到稳定为止** —— 固定轮数是个随意的数字,多编一层就绕过去了(Codex r7)。"""
    assert "SECRETV" not in retrieval._record_url(raw)
