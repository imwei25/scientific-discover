# 一体化镜像：Node(网关+OpenCode) + Python(科研技能)
# 构建上下文 = 仓库根目录：  docker build -f deploy/Dockerfile -t sci-agent:latest .
FROM node:20-bookworm-slim

# 系统依赖：python3 + pip + curl(健康检查) + git(部分技能/MCP 需要)
# pandoc + texlive-xetex + CJK 字体 供 render-pdf-doc 技能出版级 PDF 排版
# 两个易漏的包（缺了 md→PDF 直接失败，实测过）：
#   lmodern —— pandoc 默认 latex 模板 \usepackage{lmodern}；它只是 texlive-fonts-recommended 的
#              Recommends，而这里用了 --no-install-recommends，故必须显式装，否则英文稿也报 lmodern.sty not found。
#   texlive-lang-chinese —— 提供 ctex/ctexart；render-pdf-doc 对中文稿自动走 ctexart 文档类，
#              缺了会报 ctexart.cls not found（texlive-lang-cjk 不含 ctex，二者不是一回事）。
#   fontconfig —— xelatex/fontspec 是按【字体名】找字体的，靠 fontconfig 解析；缺了任何
#              \setmonofont/\setmainfont 都会 "font cannot be found"。装完必须 fc-cache 预热。
#   fonts-texgyre —— 提供 TeX Gyre Termes；中文稿的拉丁文正文字体用它，缺了中文稿必失败。
#   fonts-dejavu-core —— 提供 DejaVu Sans Mono；技能拿它作代码框等宽字体（\setmonofont）。
#              注意：它只是 fontconfig-config 的 Recommends，--no-install-recommends 下不会被带进来，
#              必须显式装，否则中文稿报 "DejaVu Sans Mono cannot be found"。
#   fonts-wqy-zenhei —— 提供 WenQuanYi Zen Hei，matplotlib 中文图的主力字体。镜像原有的
#              fonts-noto-cjk 只提供 "Noto Sans/Serif CJK JP"，【不提供 SC】；作图代码请求
#              "Noto Sans CJK SC" 会解析失败并回退 DejaVu Sans → 中文全是豆腐块（实测 28 条缺字警告）。
#              装上本包后 "WenQuanYi Zen Hei" 解析成功，中文图缺字警告 0（实测）。
#   fonts-wqy-microhei —— 同族备用中文字体，一并装以防单一字体缺字。
#   fonts-liberation —— 提供 Liberation Sans（与 Arial 度量兼容的自由字体，2.1M），作 matplotlib
#              中文图里【拉丁字符】的字体。镜像原先 Arial 与 Liberation 【都没装】；链首写没装的
#              字体不影响渲染，但会刷 "findfont: Font family 'Arial' not found." 41 行/图 的假错误
#              噪音（实测），agent 易误读成故障。装上后噪音归 0、拉丁走 LiberationSans-Regular.ttf。
# 以上包缺任何一个，md→PDF 都会 rc=43 无产物（本清单为实测逐个补齐后的最小可用集）。
#   python3-venv —— 建 /app/.venv 用（技能约定「Python 统一走项目根 .venv」，23 个技能文件写死
#              调 .venv/bin/python）。裸镜像 python3 -m venv 会报 "ensurepip is not available.
#              You need to install the python3-venv package"（实测）。用【不带小版本号】的包名，
#              bookworm 下它依赖到 python3.11-venv；将来基础镜像升 Python 小版本不会因包名写死而炸。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv curl git ca-certificates procps lsof \
      pandoc texlive-xetex texlive-fonts-recommended texlive-lang-cjk \
      texlive-lang-chinese lmodern fontconfig fonts-texgyre fonts-dejavu-core fonts-noto-cjk \
      fonts-wqy-zenhei fonts-wqy-microhei fonts-liberation \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# OpenCode（固定版本，避免自动升级带来的意外）
RUN npm install -g opencode-ai@1.17.14

WORKDIR /app

# 科研 Python 环境（装进系统 python，容器本身就是隔离）
COPY deploy/requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /app/requirements.txt

# 项目根 .venv：技能约定「Python 统一走项目根 .venv」，23 个技能文件写死调 .venv/bin/python，
# 不存在则 agent 直接跑不起来。--system-site-packages 让它复用上面已装好的科学栈，
# 不重复装（实测 .venv 仅 25M，且 .venv/bin/python 能 import pandas/matplotlib/numpy/scipy）。
# 必须排在 pip 装依赖【之后】；后续 COPY 层均为具名文件（无 COPY . /app），不会覆盖 /app/.venv。
RUN python3 -m venv --system-site-packages /app/.venv \
    && /app/.venv/bin/python -c "import pandas, numpy, scipy, matplotlib; \
       print('/app/.venv 自检通过: pandas', pandas.__version__, '| matplotlib', matplotlib.__version__)"

# matplotlib 中文兜底：系统级 matplotlibrc + 清字体缓存（必须排在字体安装之后）
#   路径依据：容器以 root 跑，matplotlib.get_configdir() == /root/.config/matplotlib，
#   其搜索顺序为 $MATPLOTLIBRC → $CWD/matplotlibrc → <configdir>/matplotlibrc → 安装目录 mpl-data。
#   放 configdir 既能全局生效（与 agent 的 cwd 无关），又不剥夺 cwd/代码层面覆盖的能力。
#   实测：放此处后 matplotlib.matplotlib_fname() 即返回该文件，中文图缺字警告 0。
#   清缓存原因：matplotlib 会缓存字体列表，装了新字体不清缓存则 WenQuanYi 不可见。
#   两层防御的机制与代价见 deploy/matplotlibrc 内注释。
COPY deploy/matplotlibrc /root/.config/matplotlib/matplotlibrc
# 构建期自检：rc 真被读到 + 链里每个字体都真装了（防噪音回归）+ 两层防御各自都能出中文
# （缺字与 findfont 噪音都必须为 0）。不过即 build 失败，免得再产出「中文全豆腐」却没人发现的镜像。
# os.chdir('/tmp') 是为了验证与 cwd 无关（rc 走 configdir）。
RUN rm -rf /root/.cache/matplotlib \
    && printf '%s\n' \
      "import os, logging, warnings, matplotlib" \
      "matplotlib.use('Agg')" \
      "os.chdir('/tmp')  # 非 cwd 目录：证明 rc 由 configdir 生效，与 agent 工作目录无关" \
      "import matplotlib.pyplot as plt" \
      "from matplotlib.font_manager import findfont, FontProperties" \
      "RC = '/root/.config/matplotlib/matplotlibrc'" \
      "CHAIN = ['Liberation Sans', 'DejaVu Sans', 'WenQuanYi Zen Hei']" \
      "assert matplotlib.matplotlib_fname() == RC, matplotlib.matplotlib_fname()" \
      "assert plt.rcParams['font.family'] == CHAIN, plt.rcParams['font.family']" \
      "assert plt.rcParams['font.sans-serif'][0] == 'WenQuanYi Zen Hei', plt.rcParams['font.sans-serif']" \
      "assert plt.rcParams['axes.unicode_minus'] is False" \
      "# 链里每个字体都必须真的装了：没装也能渲染（跳到下一个），但会刷 findfont 噪音污染日志。" \
      "# fallback_to_default=False 时找不到会抛 ValueError，正好当断言用。" \
      "for name in dict.fromkeys(CHAIN + plt.rcParams['font.sans-serif'][:1]):" \
      "    p = findfont(FontProperties(family=[name]), fallback_to_default=False)" \
      "    print('  字体已装 %-18s -> %s' % (name, os.path.basename(p)))" \
      "class Cap(logging.Handler):" \
      "    def __init__(self): super().__init__(); self.msgs = []" \
      "    def emit(self, r): self.msgs.append(r.getMessage())" \
      "cap = Cap(); lg = logging.getLogger('matplotlib.font_manager')" \
      "lg.addHandler(cap); lg.setLevel(logging.WARNING)" \
      "def draw(tag, setup):" \
      "    plt.rcdefaults(); matplotlib.rc_file(RC); setup(); cap.msgs.clear()" \
      "    with warnings.catch_warnings(record=True) as w:" \
      "        warnings.simplefilter('always')" \
      "        fig, ax = plt.subplots()" \
      "        ax.plot([-1, 0, 1], [-2.5, 0, 2.5], label='实测值 Latin ABC 123')" \
      "        ax.set_title('中文标题：患者血糖质控趋势 (Glucose QC)')" \
      "        ax.set_xlabel('时间（月）'); ax.set_ylabel('浓度 μmol/L'); ax.legend()" \
      "        fig.savefig('/tmp/_selfcheck.png', dpi=100); plt.close(fig)" \
      "    miss = [str(x.message) for x in w if 'missing from font' in str(x.message)]" \
      "    noise = [m for m in cap.msgs if 'not found' in m]" \
      "    assert not miss, ('缺字', tag, miss[:3])" \
      "    assert not noise, ('findfont 噪音', tag, sorted(set(noise))[:3])" \
      "    print('  [%s] 中文图缺字 0、findfont 噪音 0' % tag)" \
      "draw('第一层 font.family 多族回退', lambda: None)" \
      "draw('第二层 font.sans-serif 兜底', lambda: plt.rcParams.__setitem__('font.family', 'sans-serif'))" \
      "print('matplotlib 中文字体自检通过:', matplotlib.matplotlib_fname())" \
      > /tmp/_check.py \
    && python3 /tmp/_check.py \
    && rm -f /tmp/_check.py /tmp/_selfcheck.png

# 网关依赖
COPY web/package.json /app/web/package.json
RUN cd /app/web && npm install --omit=dev

# 应用文件
COPY web/server.mjs web/index.html web/login.html /app/web/
COPY deploy/skills/ /app/.opencode/skills/
COPY deploy/AGENTS.md /app/AGENTS.md
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh \
    && mkdir -p /app/uploads /app/outputs

ENV OC_URL=http://127.0.0.1:4098 \
    OC_MODEL=deepseek/deepseek-v4-pro \
    PORT=3000
EXPOSE 3000
CMD ["/app/entrypoint.sh"]
