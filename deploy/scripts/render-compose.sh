#!/usr/bin/env bash
# 从 deploy/users/*.env 生成 deploy/docker-compose.yml：每用户一个隔离容器 + 三个数据卷 + 仅回环发布端口。
# 生成物 docker-compose.yml 含明文密码，已 gitignore；改用户后由 user-add/user-del 自动调用。
#
# 关键：用户 env 里的 PORT 是"宿主发布端口"，绝不能整体注入容器（会覆盖网关内部 PORT=3000）。
#       所以这里只把 LAN_* 显式写进 environment，PORT 只用于 ports 映射。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

OUT=docker-compose.yml
# 每容器内存上限。整机 3.4G + 2G zram + 2G 磁盘 swap、WARM_CAP=5（见 sci-manager.service）：
# 1400m 是"单容器不许超"的硬顶而非预算分配——空闲容器实测仅 ~300M，5 路名义上限 7G 靠
# 实际用量小 + zram 压冷页扛住；重任务冲高先压进 zram(内存级速度)，再溢出磁盘 swap(变慢不崩)。
# zram 由 bootstrap-host.sh 配置；容器内 Node/Bun 堆上限见下方 environment 注入。
# 想更宽/更紧：MEM_LIMIT=1600m scripts/render-compose.sh（或改此默认），随后重建容器生效。
MEM_LIMIT="${MEM_LIMIT:-1400m}"
CPUS="${CPUS:-1.5}"
tmp="$(mktemp)"

field() { sed -n "s/^$1=//p" "$2" | head -1; }
# 从 tiers.env 取某档位的第 col 列（2=每日USD，3=存储MB）；无 tiers.env 或档位未定义则空
tier_field() { [ -f tiers.env ] || return 0; awk -v t="$1" -v c="$2" '!/^[[:space:]]*#/ && NF>=3 && $1==t {print $c; exit}' tiers.env; }

{
  echo "# ⚠ 自动生成，勿手改。改 users/*.env 后运行 scripts/render-compose.sh。"
  echo "# 每个用户：独立容器 agent-<name> + uploads/outputs/ocdata 三卷 + 仅回环(127.0.0.1)发布端口。"
  echo "services:"
  shopt -s nullglob
  had=0
  for f in users/*.env; do
    name=$(field NAME "$f"); port=$(field PORT "$f")
    luser=$(field LAN_USER "$f"); lpass=$(field LAN_PASSWORD "$f")
    # LAN_USER/LAN_PASSWORD 是自由文本（用户可手改 users/*.env）。它们写进 compose 的双引号 YAML，
    # 且 docker compose 会对整个文件做变量插值：未转义的 " 破坏 YAML、$ 被当插值吃掉 → 实际密码与登记不符。
    # 转义顺序：\ → \\（YAML 双引号转义）、" → \"、$ → $$（compose 里 $$ 表示字面 $）。纯 bash 替换，不依赖 sed。
    yaml_esc() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//\$/\$\$}; printf '%s' "$s"; }
    luser=$(yaml_esc "$luser"); lpass=$(yaml_esc "$lpass")
    lauth=$(field LAN_AUTH "$f"); lauth=${lauth:-1}
    # 额度按档位解析：用户 .env 里若有非空 DAILY_COST_LIMIT/STORAGE_LIMIT_MB 则以其为准（个别覆盖），
    # 否则按 TIER 从 tiers.env 取；都没有则回落到 0（不限）。
    tier=$(field TIER "$f")
    if [ -n "$tier" ] && [ -z "$(tier_field "$tier" 2)$(tier_field "$tier" 3)" ]; then
      echo "!! $f 的 TIER=$tier 在 tiers.env 未定义，回落到不限额" >&2
    fi
    dlimit=$(field DAILY_COST_LIMIT "$f"); dlimit=${dlimit:-$(tier_field "$tier" 2)}
    slimit=$(field STORAGE_LIMIT_MB "$f"); slimit=${slimit:-$(tier_field "$tier" 3)}
    # 额度 fail-closed（B3 治本入口）：额度值只允许【空】或【非负数字】。空=故意不限额（设计如此），
    # 保留原行为；一旦是非空却非法的值（手改 users/*.env 或 tiers.env 填了 abc/负数/乱码），下游
    # Number(x)=NaN → `x>0` 恒 false → 被静默当成"不限额"可无限烧钱。故在生成阶段就响亮中止，
    # 一个畸形数值都别让它流进 compose/容器（仿上面 openssl 失败即 exit 1 的范式）。
    if [ -n "$dlimit" ] && ! [[ "$dlimit" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      echo "!! $f 的 DAILY_COST_LIMIT 非法：'$dlimit'（须为非负数字，空=不限额）。请修正 users/*.env 或 tiers.env 后重跑。" >&2; exit 1; fi
    if [ -n "$slimit" ] && ! [[ "$slimit" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      echo "!! $f 的 STORAGE_LIMIT_MB 非法：'$slimit'（须为非负数字，空=不限额）。请修正 users/*.env 或 tiers.env 后重跑。" >&2; exit 1; fi
    # 功能模块授权：users/<名>.env 的 MODULES=chat,grant,...（逗号分隔；空/缺省=全部模块）。
    # 只允许小写字母/数字/逗号/连字符——它要写进 YAML 又是自由文本，畸形值宁可在生成阶段响亮中止；
    # 具体模块 id 是否存在由容器网关校验（非法 id 会被忽略，一个都不剩时 fail-closed 到仅 chat）。
    modules=$(field MODULES "$f")
    if [ -n "$modules" ] && ! [[ "$modules" =~ ^[a-z0-9,-]+$ ]]; then
      echo "!! $f 的 MODULES 非法：'$modules'（仅小写字母/数字/逗号/连字符，空=全部模块）。请修正后重跑。" >&2; exit 1; fi
    # 分级模型：用户 .env 显式 OC_MODEL 覆盖 > 档位 tiers.env 第4列 > 缺省 deepseek-v4-pro（走网关时即请求这个模型名）
    tmodel=$(field OC_MODEL "$f"); tmodel=${tmodel:-$(tier_field "$tier" 4)}; tmodel=${tmodel:-deepseek-v4-pro}
    # B4：tmodel/tier 与 luser/lpass 同样是自由文本，写进双引号 YAML 且被 compose 变量插值；未转义的
    # "/$ 会破坏 YAML 或被当插值吃掉。过一遍 yaml_esc（tmodel 转义后斜杠结构不变，仍是 deepseek/<名>）。
    # 注意：tier 的【原值】上面已用于 tier_field 查表，这里只对写进 YAML 的副本转义，不动查表用的 $tier。
    tmodel_esc=$(yaml_esc "$tmodel"); tier_esc=$(yaml_esc "$tier")
    if [ -z "$name" ] || [ -z "$port" ]; then echo "!! $f 缺 NAME/PORT，跳过" >&2; continue; fi
    # 宿主记账令牌：容器网关向 manager 记账端点（QUOTA_LISTEN）上报成本的每用户凭据。
    # 端点只收正增量，令牌泄露（容器 env 对 agent 不设防）也只能给自己多记账。
    # 老用户 env 没这行 → 在此幂等补发一次并落盘（user-add 对新用户已直接生成）。
    qtok=$(field QUOTA_TOKEN "$f")
    if [ -z "$qtok" ]; then
      qtok=$(openssl rand -hex 24)
      # 空令牌会让记账 /report 与 /llm 转发【双双静默失效】（manager 两处都要求令牌非空），
      # 容器起来却调不到模型也记不了账，且很难排查 —— 宁可在这里响亮中止。
      if [ -z "$qtok" ]; then echo "!! 生成 QUOTA_TOKEN 失败（openssl 不可用？），中止渲染以免写出哑令牌。请装 openssl 后重跑。" >&2; exit 1; fi
      printf 'QUOTA_TOKEN=%s\n' "$qtok" >> "$f"
      echo ">> $f 补发 QUOTA_TOKEN（宿主记账凭据）" >&2
    fi
    had=1
    cat <<YAML
  agent-${name}:
    image: sci-agent:latest
    container_name: agent-${name}
    environment:
      # ⚠ 刻意【不再】注入 DEEPSEEK_API_KEY：那是全体用户共用的上游 key，而容器里跑的 agent
      # 一句 env 命令就能读走。真实 key 只留宿主（deploy/.env / sci-manager.env），容器统一走
      # manager 的 /llm 转发通道，凭据是每用户的 QUOTA_TOKEN（泄露只废该用户自己的通道，可单独换发）。
      # 在 deploy/.env 显式配 OC_GATEWAY_URL+OC_GATEWAY_KEY 可整体改走别的网关（恢复旧直连行为）。
      OC_MODEL: "deepseek/${tmodel_esc}"
      OC_GATEWAY_URL: \${OC_GATEWAY_URL-http://host.docker.internal:8091/llm}
      OC_GATEWAY_KEY: \${OC_GATEWAY_KEY-${qtok}}
      OC_COST_INPUT: \${OC_COST_INPUT:-0.27}
      OC_COST_OUTPUT: \${OC_COST_OUTPUT:-1.10}
      OC_COST_CACHE_READ: \${OC_COST_CACHE_READ:-0.07}
      # 堆上限（防单进程膨胀吃满 mem_limit 被 OOM kill -9，长会话宁可多 GC 也别猝死）：
      #   NODE_OPTIONS 管容器里所有 Node 进程（网关 server.mjs 实测常驻仅 ~60M，512M 硬顶很宽裕）；
      #   opencode 是 Bun 编译的原生二进制（JavaScriptCore 引擎，不认 NODE_OPTIONS），
      #   用 BUN_JSC_forceRAMSize（字节，768MiB）让 JSC 按小内存假设提前 GC——软启发式，超了只是更勤快地收，不 abort。
      NODE_OPTIONS: "--max-old-space-size=512"
      BUN_JSC_forceRAMSize: "805306368"
      # 文献检索源的联系邮箱 + API key（都从 deploy/.env 插值，空=免费匿名档，填了=更高限额/更稳）。
      # 换服务器只需搬 deploy/.env 这一个文件，所有用户容器自动继承，无需逐个配置。
      SCI_CONTACT_EMAIL: \${SCI_CONTACT_EMAIL:-}
      NCBI_API_KEY: \${NCBI_API_KEY:-}
      S2_API_KEY: \${S2_API_KEY:-}
      OPENALEX_API_KEY: \${OPENALEX_API_KEY:-}
      CROSSREF_PLUS_TOKEN: \${CROSSREF_PLUS_TOKEN:-}
      # OCR.space 图片识字 key（ocr 技能用；免费可重置，风险同检索 key 一档，故与其一并注入。
      # 全体用户共用这一个 key 的月度配额；空=ocr 技能报错提示未配置）。
      OCR_SPACE_API_KEY: \${OCR_SPACE_API_KEY:-}
      LAN_AUTH: "${lauth}"
      LAN_USER: "${luser}"
      LAN_PASSWORD: "${lpass}"
      BASE_PATH: "/${name}"
      USER_TIER: "${tier_esc:-}"
      ALLOWED_MODULES: "${modules:-}"
      DAILY_COST_LIMIT: "${dlimit:-0}"
      STORAGE_LIMIT_MB: "${slimit:-0}"
      # 宿主账本：额度权威记在 manager 侧（deploy/data/quota/），容器内 quota.json 仅作回退缓存，
      # agent 改不到账本。要禁用（回落容器本地记账）在 deploy/.env 写一行空的 QUOTA_API_URL=。
      # 注意 \${VAR-默认} 是【无冒号】写法：显式置空才算关，没写这行才用默认。
      QUOTA_API_URL: \${QUOTA_API_URL-http://host.docker.internal:8091}
      QUOTA_TOKEN: "${qtok}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    # 租户隔离：每个用户容器只挂在自己的专属 bridge 网络 net-${name}（顶层定义见文件末尾）。
    # 不同 bridge 网络之间 docker 默认不路由容器间流量 → 用户容器彼此不可达（防探端口/盲试邻居登录）。
    # 不影响访问宿主：host.docker.internal 经 host-gateway 解析到【本容器所在 bridge 的宿主网关 IP】，
    # 每张 per-user bridge 各有自己的网关通向宿主 8091（/llm 转发 + 记账），与容器落在哪张网无关。
    networks:
      - net-${name}
    volumes:
      - ${name}-uploads:/app/uploads
      - ${name}-outputs:/app/outputs
      - ${name}-ocdata:/root/.local/share/opencode
      # 内置技能 + 主控指令【只读】挂载（内核级写保护，连容器内 root+bash 都写不动，实测 EROFS）。
      # 为什么不靠 opencode 的 permission 配置：实测 opencode 1.17 的 edit/read 路径规则只作用于会话
      # 工作目录(cwd)以内，而 cwd=/app/outputs/<会话id>/，这些文件在 cwd 之外、归 external_directory(=allow)
      # 管，配置层护不住（见 web/server.mjs enforceOcTools 注释）。只读挂载才是真边界。
      # 源用相对路径（compose 相对 deploy/ 解析）：宿主仓库根即镜像构建源，零漂移；镜像里的同名内容被
      # 原样覆盖成只读。产物/上传/会话数据仍是可写卷，不受影响。
      - ../.opencode/skills:/app/.opencode/skills:ro
      - ../AGENTS.md:/app/AGENTS.md:ro
    ports:
      - "127.0.0.1:${port}:3000"
    restart: "no"
    mem_limit: ${MEM_LIMIT}
    cpus: ${CPUS}
YAML
  done
  if [ "$had" = 1 ]; then
    echo "volumes:"
    for f in users/*.env; do
      name=$(field NAME "$f"); [ -n "$name" ] || continue
      for v in uploads outputs ocdata; do
        printf '  %s-%s:\n    name: %s-%s\n' "$name" "$v" "$name" "$v"
      done
    done
    # 每用户一张独立 bridge 网络（租户隔离，见各 service 的 networks 段注释）。
    # compose key = net-<name>（与 service 里引用一致）；实际 docker 网络名固定为 <name>-net（稳定、唯一）。
    echo "networks:"
    for f in users/*.env; do
      name=$(field NAME "$f"); [ -n "$name" ] || continue
      printf '  net-%s:\n    name: %s-net\n' "$name" "$name"
    done
  fi
} > "$tmp"
mv "$tmp" "$OUT"
echo "已生成 $OUT（$(grep -c 'container_name:' "$OUT" || echo 0) 个用户）"
