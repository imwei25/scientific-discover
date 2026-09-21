"""WebVPN 改写与自动识别的离线验证。基准是用户给的南京医科大学真实样例。"""
import sys
sys.path.insert(0, r"D:\projects\scientific-discover\.opencode\skills\fulltext-retrieval")
import fetch_institutional as fi  # noqa: E402

ok = True


def chk(name, got, want):
    global ok
    good = got == want
    ok &= good
    print(("PASS " if good else "FAIL ") + name)
    if not good:
        print(f"   got  {got!r}\n   want {want!r}")


GW = fi.parse_webvpn_gateway("webvpn.njmu.edu.cn:8118")
chk("网关解析（带端口默认 http）", GW, ("http", "webvpn.njmu.edu.cn:8118"))
chk("网关解析（不带端口默认 https）",
    fi.parse_webvpn_gateway("webvpn.abc.edu.cn"), ("https", "webvpn.abc.edu.cn"))
chk("网关解析（整串带 scheme）",
    fi.parse_webvpn_gateway("https://webvpn.x.edu.cn:443/"),
    ("https", "webvpn.x.edu.cn:443"))

# 用户给的真实样例：这是唯一的基准，改写规则必须严格复现它
chk("用户真实样例",
    fi.webvpn_rewrite("https://webofscience.clarivate.cn/wos/woscc/smart-search", GW),
    "http://webofscience-clarivate-cn-s.webvpn.njmu.edu.cn:8118/wos/woscc/smart-search")

chk("http 目标不加 -s",
    fi.webvpn_rewrite("http://example.org/a", GW),
    "http://example-org.webvpn.njmu.edu.cn:8118/a")
chk("保留查询串",
    fi.webvpn_rewrite("https://www.sciencedirect.com/science/article/pii/S1?via=x", GW),
    "http://www-sciencedirect-com-s.webvpn.njmu.edu.cn:8118/science/article/pii/S1?via=x")
chk("已是代理地址不套娃",
    fi.webvpn_rewrite("http://a-b-com-s.webvpn.njmu.edu.cn:8118/x", GW),
    "http://a-b-com-s.webvpn.njmu.edu.cn:8118/x")
chk("非 http(s) 原样返回",
    fi.webvpn_rewrite("ftp://x.org/a", GW), "ftp://x.org/a")
chk("目标带非标准端口 → 不臆造，原样返回",
    fi.webvpn_rewrite("https://x.org:8443/a", GW), "https://x.org:8443/a")

chk("不给网关时入口就是 doi.org",
    fi.entry_url_for("10.1/x", "a@b.com", None), "https://doi.org/10.1/x")


# ---- 自动识别：标签页 ----
class P:
    def __init__(self, url): self.url = url


class Ctx:
    def __init__(self, pages, cookies=None):
        self.pages = pages
        self._cookies = cookies or []
    def cookies(self): return self._cookies


chk("标签页识别（带目标前缀，端口可信）",
    fi.detect_webvpn_gateway(Ctx([
        P("https://www.google.com/"),
        P("http://webofscience-clarivate-cn-s.webvpn.njmu.edu.cn:8118/wos"),
    ])), ("http", "webvpn.njmu.edu.cn:8118"))
chk("标签页识别（只有门户页，作兜底）",
    fi.detect_webvpn_gateway(Ctx([P("https://webvpn.njmu.edu.cn/login")])),
    ("https", "webvpn.njmu.edu.cn"))
chk("标签页识别（优先带前缀那条，不被门户页抢走）",
    fi.detect_webvpn_gateway(Ctx([
        P("https://webvpn.njmu.edu.cn/login"),
        P("http://a-b-com-s.webvpn.njmu.edu.cn:8118/x"),
    ])), ("http", "webvpn.njmu.edu.cn:8118"))
chk("没有 WebVPN 页面时不误报",
    fi.detect_webvpn_gateway(Ctx([P("https://www.bing.com/"), P("about:blank")])),
    None)



# ---- 自动识别：cookie（标签页关了也还在） ----
class Resp:
    def __init__(self, status): self.status = status


class Req:
    def __init__(self, alive): self.alive = alive
    def get(self, url, **kw):
        if url in self.alive:
            return Resp(200)
        raise RuntimeError("unreachable")


class CkCtx:
    def __init__(self, cookies, alive):
        self.pages = []
        self._c = cookies
        self.request = Req(alive)
    def cookies(self): return self._c


ck = [{"domain": ".webvpn.njmu.edu.cn", "name": "wengine_vpn_ticketwebvpn_njmu_edu_cn"}]
# 注意：探的是【改写后的地址】，不是门户根。这是真机教训——南医大门户在 https:443
# 好好的，而改写主机走 443 是 ERR_CERT_COMMON_NAME_INVALID，只有 http:8118 能用。
chk("cookie 识别：改写地址在 http:8118",
    fi.detect_webvpn_from_cookies(
        CkCtx(ck, {"http://example-com-s.webvpn.njmu.edu.cn:8118/"})),
    ("http", "webvpn.njmu.edu.cn:8118"))
chk("cookie 识别：改写地址在 https:443",
    fi.detect_webvpn_from_cookies(
        CkCtx(ck, {"https://example-com-s.webvpn.njmu.edu.cn/"})),
    ("https", "webvpn.njmu.edu.cn"))
chk("cookie 识别：无 webvpn cookie 不误报",
    fi.detect_webvpn_from_cookies(CkCtx([{"domain": ".bing.com"}], set())), None)

# 回归：门户根在 https 可达、但改写地址只有 8118 能用（南医大真实形态）——
# 旧实现探门户根，会选中 https:443，之后所有改写地址都打不开。
NJMU_LIKE = CkCtx(ck, {"https://webvpn.njmu.edu.cn/",
                       "http://example-com-s.webvpn.njmu.edu.cn:8118/"})
chk("回归：门户 443 通但改写地址只在 8118 → 必须选 8118",
    fi.detect_webvpn_from_cookies(NJMU_LIKE), ("http", "webvpn.njmu.edu.cn:8118"))
chk("auto_webvpn：标签页优先于 cookie",
    fi.auto_webvpn(type("C", (), {
        "pages": [P("http://a-b-com-s.webvpn.njmu.edu.cn:8118/x")],
        "cookies": lambda self: ck, "request": Req(set())})()),
    ("http", "webvpn.njmu.edu.cn:8118"))
print("ALL PASS" if ok else "SOME FAILED")

# ---- 真机发现：未登录会被 302 到门户，门户 URL 里内嵌真正的改写地址 ----
PORTAL = ("https://webvpn.njmu.edu.cn/portal/?redirect_uri=http%3A%2F%2F"
          "www-sciencedirect-com-s.webvpn.njmu.edu.cn%3A8118%2Fscience%2F"
          "article%2Fpii%2FS1#!/login")
chk("门户页：取内嵌 redirect_uri 的协议与端口，而不是门户自己的 443",
    fi.detect_webvpn_gateway(Ctx([P(PORTAL)])),
    ("http", "webvpn.njmu.edu.cn:8118"))


class GwPage:
    def __init__(self, url): self.url = url


chk("被弹回网关门户 = 没登录",
    fi.bounced_to_gateway(GwPage(PORTAL), ("http", "webvpn.njmu.edu.cn:8118")), True)
chk("落在改写后的目标上 ≠ 弹回门户",
    fi.bounced_to_gateway(GwPage("http://www-sciencedirect-com-s.webvpn.njmu.edu.cn:8118/x"),
                          ("http", "webvpn.njmu.edu.cn:8118")), False)
chk("没走 WebVPN 时该判据恒为假",
    fi.bounced_to_gateway(GwPage("https://www.sciencedirect.com/x"), None), False)

print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
