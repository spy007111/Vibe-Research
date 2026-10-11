"""RSS / Atom 解析离线测试:标题与摘要里的 HTML 实体要解开。不访问网络。"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from sources import headlines, rss  # noqa: E402

# The Verge 的原样写法:Atom 标题标 type="html",CDATA 里还是实体
ATOM = ('<feed xmlns="http://www.w3.org/2005/Atom"><entry>'
        '<title type="html"><![CDATA[&#8216;Pure insanity&#8217;: OpenAI&#8217;s latest drop]]></title>'
        '<link rel="alternate" href="https://v.com/1"/><published>2026-10-09T12:00:00Z</published>'
        '<summary type="html"><![CDATA[<p>R&amp;D &#8212; 3 &lt; 5</p>]]></summary></entry></feed>')
# RSS 2.0 里多转义一层的写法:XML 解析后剩下 &#8217;
RSS = ('<rss><channel><item><title>Nvidia&amp;#8217;s racks ship to AT&amp;T</title>'
       '<link>https://r.com/1</link><pubDate>Fri, 09 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>')


def test_atom_html_title_and_summary_are_unescaped():
    [it] = rss.parse_feed(ATOM.encode())
    assert it["title"] == "‘Pure insanity’: OpenAI’s latest drop"
    # 先去标签再解实体:原文里转义过的 "<" 是正文,不能当标签删掉
    assert it["summary"] == "R&D — 3 < 5"


def test_double_escaped_rss_title_is_unescaped():
    [it] = rss.parse_feed(RSS.encode())
    assert it["title"] == "Nvidia’s racks ship to AT&T"


def test_techmeme_rss_fallback_matches_river_text():
    [it] = headlines._parse_rss(RSS)
    assert it["title"] == "Nvidia’s racks ship to AT&T"
