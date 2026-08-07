#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机制示意图：把 build_prompt.py 编译好的 prompt 送给生图模型，出图并落盘。

【与 ppt-master 的关系】ppt-master 里已有一整套 image_gen.py + 十几个后端，功能更全，
但它的 generate() 不接 negative_prompt —— 而本技能的排版可靠性【全靠】负面词
（"别在左边画一个巨大的竖细胞"那一串），所以这里自己发这一次 HTTP。
故意读【同名环境变量】(QWEN_API_KEY / DASHSCOPE_API_KEY / QWEN_MODEL / QWEN_BASE_URL)：
已经为 ppt-master 配过 key 的用户不用再配第二遍。

【为什么每张图都写复现记录】科研图要能回答"这张图怎么来的"。出图同时落一份
<名>.meta.json（模型、prompt、负面词、尺寸、时间、标签清单），审稿问起来、或者半年后
要改一版，照着重跑就行 —— 图片 URL 是会过期的，只存链接等于没存。

用法：
  # 先编译（离线，不花钱）
  python build_prompt.py --spec fig1.spec.json --source ms.md --json fig1.built.json
  # 再出图
  python render_figure.py --built fig1.built.json --name fig1 --n 2
  # 只想看会发什么，不真发
  python render_figure.py --built fig1.built.json --dry-run
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：请先运行 install.ps1 / install.sh（或 env-setup 技能）")


DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
DEFAULT_MODEL = "qwen-image-2.0"

# 尺寸表按 DashScope 的 size 参数写法（宽*高）。2K 档足够投稿前的构思稿与汇报；
# 真要 300dpi 出版尺寸请走矢量重绘（见 SKILL.md「交付路径」），放大生图只会放大糊字。
SIZES = {
    "1:1": "2048*2048", "4:3": "2368*1728", "3:4": "1728*2368",
    "16:9": "2688*1536", "9:16": "1536*2688", "3:2": "2048*1536", "2:3": "1536*2048",
}

RETRIES = 3
RETRY_BASE = 8          # 秒；429/5xx 退避起点
TIMEOUT = 300           # 单次请求上限：生图慢是常态，但不能挂死


def resolve_out_dir(explicit):
    """产物目录：默认当前工作目录（= 会话产物目录）。拦住 outputs/ 前缀的错误写法。"""
    cwd = Path.cwd()
    in_session = cwd.parent.name == "outputs"
    if not explicit:
        return cwd
    p = Path(explicit)
    if in_session and not p.is_absolute() and p.parts and p.parts[0] == "outputs":
        sys.exit("\n".join([
            "!! --outdir 写法有误，已中止。",
            "   当前工作目录已经【就是】本会话的产物目录： " + str(cwd),
            "   再拼 outputs/ 前缀会多套一层，界面“产出”侧栏只递归一层、看不见它。",
            "   正确写法：不传（默认当前目录），或传 figures（一层子目录会被列出）。",
        ]))
    return p


# 允许从 key 文件里读的变量，白名单写死。
# 【为什么不整份 env 都灌进来】key 文件是给"放 key"用的，不是通用配置注入点：
# 整份灌等于让一个文本文件能改本进程任何环境变量（PATH、代理…），没必要也不安全。
ENV_FILE_KEYS = ("QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_MODEL", "QWEN_BASE_URL")

# key 文件的查找顺序。全部在【仓库之外】—— 这是刻意的：放仓库里的 key 迟早会被
# `git add -A` 带进历史，而 key 一进 git 历史就等于已泄露（改密码式的补救只能换 key）。
def _key_file_candidates():
    home = Path.home()
    explicit = (os.environ.get("SCI_IMAGE_ENV") or "").strip()
    cands = []
    if explicit:
        cands.append(Path(explicit))
    cands.append(home / ".sci-agent" / "image.env")     # 本套件推荐位置
    cands.append(home / ".ppt-master" / ".env")         # ppt-master 已有的位置：配过一次就别再配第二遍
    return cands


def _repo_root():
    """本脚本所在仓库的根。按标志文件向上找，不数目录层数——

    数层数（parents[N]）会在技能被拷到别处（安装镜像、容器内不同布局）时静默指错，
    而这里指错的后果是"仓库内的 key 文件没被拦住"，也就是这道守卫白写了。第一版就是这么错的。
    """
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / ".git").exists() or (p / "AGENTS.md").is_file():
            return p
    return here.parents[-1]


def load_key_file():
    """把 key 文件里的白名单变量补进 os.environ（【已存在的进程环境变量优先】，不覆盖）。

    进程环境优先的理由：服务器上 key 由容器 env 注入（见 deploy/scripts/render-compose.sh），
    那是权威来源；key 文件只是本机自用时的便利层。
    """
    for f in _key_file_candidates():
        try:
            if not f.is_file():
                continue
            # 放在仓库里的 key 文件必须响亮拦掉：这正是"key 进 git 历史"的唯一入口。
            repo = _repo_root()
            try:
                f.resolve().relative_to(repo)
                sys.exit("\n".join([
                    "!! key 文件在仓库目录内，已中止：" + str(f),
                    "   仓库里的文件迟早会被 git add -A 带进历史，而 key 一进历史就只能换 key。",
                    "   请把它移到仓库外，例如 " + str(Path.home() / ".sci-agent" / "image.env") + "。",
                ]))
            except ValueError:
                pass   # 不在仓库内 —— 正常情况
            # utf-8-sig：Windows PowerShell 的 Set-Content/Out-File 写的是【带 BOM】的 UTF-8，
            # 而用 utf-8 读会把 BOM 留在第一行行首 → 键名变成 "﻿QWEN_API_KEY" → 不在白名单里
            # → 【静默忽略】，用户明明照着说明写好了 key 却报"没找到 key"，且毫无线索。
            for line in f.read_text(encoding="utf-8-sig", errors="replace").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip("'\"")
                if k in ENV_FILE_KEYS and v and not (os.environ.get(k) or "").strip():
                    os.environ[k] = v
            return f
        except SystemExit:
            raise
        except Exception as e:
            print(f"[warn] 读 key 文件 {f} 失败（忽略）：{e}")
    return None


# 平台生图代理的地址：网关起 opencode 时注入（见 web/server.mjs）。
#
# 【为什么优先走它】技能是在【用户自己那台机器】上跑的，把生图 key 发到每台机器上，就等于
# 把一把共享密钥散出去：用户看得到、没法按人限额、泄了要全员换。走代理则 key 只留在服务器，
# 客户端一个字节都拿不到，张数限额与审计也都在服务端做——与平台对 LLM key 的既有原则一致。
# 没有这个变量（自设 API 形态 / 本机自用）才回退到本机 key，老用法不受影响。
def proxy_url():
    return (os.environ.get("SCI_IMAGE_URL") or "").strip()


class QuotaUsedUp(Exception):
    """今天的张数用完了。重试毫无意义，必须立刻停——别把剩下的候选张也一张张撞上去。"""


class PlatformSaidNo(Exception):
    """平台侧明确拒绝（没配生图 / 平台自己的上游额度没了）。同样不该重试。"""


def api_key():
    src = load_key_file()
    for k in ("QWEN_API_KEY", "DASHSCOPE_API_KEY"):
        v = (os.environ.get(k) or "").strip()
        if v:
            if src:
                print(f"[key] 取自 {src}")
            return v
    home_env = Path.home() / ".sci-agent" / "image.env"
    sys.exit("\n".join([
        "!! 既没有平台生图通道，也没找到本机 key，已中止。",
        "   登录平台账号后本来【不需要你配任何 key】（服务器会代你出图）；现在走到这里，",
        "   说明没登录平台账号，或平台还没配生图服务（可让管理员看一眼）。",
        "   本机自用的话，任选一种（两种都不会把 key 写进仓库）：",
        "",
        "   ① 本机自用（推荐，一次配好长期有效）：把 key 写进仓库【外】的这个文件——",
        "        " + str(home_env),
        "      文件内容一行即可： QWEN_API_KEY=sk-xxxx",
        "",
        "   ② 只在这一个 shell 里临时用：",
        "        PowerShell:  $env:QWEN_API_KEY = 'sk-xxxx'",
        "        bash:        export QWEN_API_KEY=sk-xxxx",
        "",
        "   平台（服务器）部署由管理员在 deploy/.env 里配一次、所有用户容器自动继承，",
        "   见 deploy/.env.example 的「生图 API key」一节。",
        "",
        "   变量名与 ppt-master 相同（也认 DASHSCOPE_API_KEY），配过一次两个技能都能用。",
        "   还没配 key 也能先用 --dry-run 把提示词做完、检查完，那条不需要 key。",
    ]))


def post_once(url, key, payload):
    """发一次生图请求。key=None 表示走平台代理（本机网关贴登录票据，不需要 key）。"""
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    r = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT)
    if r.status_code != 200:
        body = (r.text or "")[:400].replace("\n", " ")
        # 平台侧的结构化错误值得单独翻一下：张数用完 / 平台没配 / 平台自己的上游额度没了，
        # 三种情况用户该做的事完全不同，甩一句 HTTP 429 等于没说。
        try:
            e = r.json().get("error") or {}
            code, msg = e.get("code") or "", (e.get("message") or "").strip()
            if code == "IMAGE_QUOTA_EXCEEDED":
                raise QuotaUsedUp(msg or "今天的生图张数已用完")
            if code in ("IMAGE_UNCONFIGURED", "IMAGE_UPSTREAM_QUOTA", "IMAGE_UPSTREAM_ERROR", "IMAGE_NO_RESULT"):
                raise PlatformSaidNo(msg or f"平台生图失败（{code}）")
        except (QuotaUsedUp, PlatformSaidNo):
            raise
        except Exception:
            pass
        raise RuntimeError(f"HTTP {r.status_code}：{body}")
    return r.json()


def extract_image_urls(data):
    """从 DashScope 多模态响应里取图片 URL。结构变过，所以宽松地找。"""
    urls = []
    for ch in ((data.get("output") or {}).get("choices") or []):
        for c in ((ch.get("message") or {}).get("content") or []):
            if isinstance(c, dict) and c.get("image"):
                urls.append(c["image"])
    if not urls:
        # 部分模型走 output.results[].url
        for it in ((data.get("output") or {}).get("results") or []):
            if isinstance(it, dict) and (it.get("url") or it.get("image")):
                urls.append(it.get("url") or it.get("image"))
    return urls


def download(url, dest):
    r = requests.get(url, timeout=TIMEOUT, stream=True)
    if r.status_code != 200:
        raise RuntimeError(f"下载图片失败 HTTP {r.status_code}")
    ct = (r.headers.get("content-type") or "").lower()
    if "image" not in ct:
        raise RuntimeError(f"返回的不是图片（content-type={ct!r}），可能是链接已过期")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "wb") as f:
        for chunk in r.iter_content(65536):
            if chunk:
                f.write(chunk)
    return dest


def main():
    ap = argparse.ArgumentParser(description="机制示意图：prompt → 生图 → 落盘 + 复现记录")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--built", help="build_prompt.py --json 产出的 .built.json（推荐）")
    src.add_argument("--prompt-file", help="纯文本 prompt 文件（负面词用 --negative 另给）")
    ap.add_argument("--negative", default=None, help="负面词（--prompt-file 模式下用）")
    ap.add_argument("--name", default=None, help="输出文件名主干（默认取 built 文件名）")
    ap.add_argument("--outdir", default=None, help="输出目录，默认当前目录；建议 figures")
    ap.add_argument("--aspect-ratio", default=None, help=f"默认取 spec 里的值或 1:1。可选 {sorted(SIZES)}")
    ap.add_argument("--n", type=int, default=1, help="出几张候选（默认 1）。构图不稳时出 2–3 张挑一张")
    ap.add_argument("--model", default=None, help=f"默认 {DEFAULT_MODEL}，或 QWEN_MODEL 环境变量")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要发送的请求，不调用 API、不需要 key")
    args = ap.parse_args()

    if args.built:
        try:
            built = json.loads(Path(args.built).read_text(encoding="utf-8"))
        except FileNotFoundError:
            sys.exit(f"!! 找不到 --built 文件：{args.built}")
        except json.JSONDecodeError as e:
            sys.exit(f"!! --built 不是合法 JSON：{e.msg}")
        prompt = built.get("prompt") or ""
        negative = built.get("negative_prompt") or ""
        labels = built.get("labels") or []
        ratio = args.aspect_ratio or (built.get("spec") or {}).get("aspect_ratio") or "1:1"
        stem = args.name or re.sub(r"\.built\.json$|\.json$", "", Path(args.built).name)
    else:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
        negative = args.negative or ""
        labels = []
        ratio = args.aspect_ratio or "1:1"
        stem = args.name or Path(args.prompt_file).stem
    if not prompt.strip():
        sys.exit("!! prompt 是空的，没什么可画的")
    if ratio not in SIZES:
        sys.exit(f"!! 不支持的比例 {ratio!r}，可选：{sorted(SIZES)}")
    if not (1 <= args.n <= 4):
        sys.exit("!! --n 取 1–4（再多纯属烧额度，构图不稳靠改 spec 而不是靠抽卡）")

    model = args.model or (os.environ.get("QWEN_MODEL") or "").strip() or DEFAULT_MODEL
    url = (os.environ.get("QWEN_BASE_URL") or "").strip() or DEFAULT_ENDPOINT
    if not url.endswith("/generation"):
        url = url.rstrip("/") + "/api/v1/services/aigc/multimodal-generation/generation"
    size = SIZES[ratio]

    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        "parameters": {
            "size": size,
            "watermark": False,
            # prompt_extend 会让模型自己"润色"提示词 —— 对机制图是灾难：它会往里加没有的
            # 细胞器和装饰性分子，把上一步锁死的构图与标签集重新打散，等于绕开反编造闸。必须关。
            "prompt_extend": False,
            "negative_prompt": negative,
        },
    }

    # 走平台代理时，请求体是我们自己那个小协议（服务端来定模型、贴 key、扣张数），
    # 不是 DashScope 的原生结构；模型名也由服务端说了算，客户端点名无效（防自选价格）。
    via = proxy_url()
    proxy_payload = {"prompt": prompt, "negative_prompt": negative, "size": size}

    print(f"[图] 通道 {'平台代理（key 在服务器）' if via else '本机 key 直连'}"
          f" | 模型 {model if not via else '由平台指定'} | 比例 {ratio} ({size}) | 候选 {args.n} 张")
    print(f"[图] prompt {len(prompt)} 字符，负面词 {len(negative)} 字符")
    if args.dry_run:
        print("\n---- 将要发送的 payload（--dry-run，未调用 API）----")
        print(json.dumps(proxy_payload if via else payload, ensure_ascii=False, indent=2)[:4000])
        return 0

    # 平台代理这条路【不需要任何 key】：本机网关会贴上你的登录票据转给服务器。
    key = None if via else api_key()
    outdir = resolve_out_dir(args.outdir)
    saved = []
    stopped = None      # 被平台明确拒绝 → 记下原因并停掉后续候选张
    quota = None        # 平台回的张数余额，收尾时报给用户
    for i in range(1, args.n + 1):
        if stopped:
            break
        name = stem if args.n == 1 else f"{stem}_v{i}"
        last = None
        for attempt in range(RETRIES):
            try:
                t0 = time.time()
                data = post_once(url, key, proxy_payload if via else payload)
                # 平台代理回的是 {ok,images[],quota{}}；直连回的是 DashScope 原生结构
                urls = data.get("images") if via else extract_image_urls(data)
                if via and isinstance(data.get("quota"), dict):
                    quota = data["quota"]
                if not urls:
                    raise RuntimeError(f"响应里没有图片 URL：{json.dumps(data, ensure_ascii=False)[:300]}")
                dest = download(urls[0], outdir / (name + ".png"))
                print(f"[ok] {dest}（{time.time() - t0:.1f}s）"
                      + (f"　今日已用 {quota['used']}/{quota['limit']} 张" if quota and not quota.get("unlimited") else ""))
                saved.append(dest)
                last = None
                break
            except (QuotaUsedUp, PlatformSaidNo) as e:
                # 【绝不重试、且立刻停掉后面的候选张】张数用完了还一张张撞上去，只会把同一句
                # "已用完"打印 N 遍，用户还以为是网络在抖。
                last = e
                stopped = e
                break
            except Exception as e:
                last = e
                msg = str(e)
                retryable = ("HTTP 429" in msg or "HTTP 5" in msg or "Timeout" in msg
                             or "timed out" in msg.lower() or "Connection" in msg)
                if attempt < RETRIES - 1 and retryable:
                    wait = RETRY_BASE * (2 ** attempt)
                    print(f"[retry] 第 {i} 张第 {attempt + 1} 次失败（{msg[:120]}），{wait}s 后重试")
                    time.sleep(wait)
                    continue
                break
        if last is not None:
            # 一张失败不拖累其它张：已经出来的图是有价值的，如实报告失败那张。
            print(f"[fail] 第 {i} 张没出来：{last}", file=sys.stderr)
    if stopped:
        print(f"\n[停] {stopped}", file=sys.stderr)
        if isinstance(stopped, QuotaUsedUp):
            print("     张数每天 0 点(UTC)重置；需要更多请联系管理员调整档位。", file=sys.stderr)
            print("     提示词已经做好了，明天直接用同一份 .built.json 重跑即可，不用重来。", file=sys.stderr)

    if not saved:
        sys.exit("!! 一张也没生成成功（上面有原因）。key/额度/网络排查后重试；prompt 本身可用 --dry-run 检查。")

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "backend": "dashscope-qwen", "model": model, "endpoint": url,
        "aspect_ratio": ratio, "size": size,
        "prompt": prompt, "negative_prompt": negative,
        "labels": labels, "files": [p.name for p in saved],
        "ai_generated": True,
        "disclosure_note": ("本图由文本生成图像模型生成，未经人工重绘。用于投稿前请核对目标期刊的"
                           "AI 生成图政策（多数刊物禁用或要求披露），并按 SKILL.md「交付路径」重绘为矢量图。"),
    }
    mp = outdir / (stem + ".meta.json")
    mp.parent.mkdir(parents=True, exist_ok=True)
    mp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] 复现记录 {mp}")

    if labels:
        print("\n[必核] 逐个核对图上这些标签有没有被画错/画糊/画漏（生图模型必然拼错一部分）：")
        for lb in labels:
            print("  □ " + lb)
    print("\n[提醒] 这是 AI 生成图。正式投稿前请核对目标期刊政策并按需重绘为矢量图（见 SKILL.md）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
