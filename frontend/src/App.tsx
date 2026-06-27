import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./lib/api";
import { writePersisted, usePersistentState } from "./lib/usePersistentState";
import { useSidebar } from "./lib/sidebar";
import IdeaModule from "./modules/IdeaModule";
import PlanModule from "./modules/PlanModule";
import AnalyzeModule from "./modules/AnalyzeModule";
import ImradModule from "./modules/ImradModule";
import JournalMatchModule from "./modules/JournalMatchModule";
import FormatModule from "./modules/FormatModule";
import ChecklistModule from "./modules/ChecklistModule";
import RebuttalModule from "./modules/RebuttalModule";
import HistoryView from "./modules/HistoryView";
import ThemeSwitcher from "./components/ThemeSwitcher";

export type ModuleId = "home" | "idea" | "plan" | "analyze" | "imrad" | "journal" | "format" | "checklist" | "rebuttal" | "history";
// 跨模块传递: 把数据写入目标模块的持久化字段, 再切换过去。
export type Goto = (target: ModuleId, patch?: Record<string, unknown>) => void;

const NAV: { id: ModuleId; icon: string; title: string; desc: string }[] = [
  { id: "idea", icon: "💡", title: "找选题", desc: "发现研究方向与创新点" },
  { id: "plan", icon: "🗺️", title: "实验规划", desc: "把想法变成可执行的计划" },
  { id: "analyze", icon: "📊", title: "数据分析与写作", desc: "上传数据，分析并成文" },
  { id: "imrad", icon: "📝", title: "论文初稿", desc: "装配 IMRaD 初稿与摘要" },
  { id: "journal", icon: "🎯", title: "智能选刊", desc: "匹配适合投稿的期刊" },
  { id: "format", icon: "📄", title: "期刊排版", desc: "按目标期刊要求重排" },
  { id: "checklist", icon: "✅", title: "报告规范核对", desc: "STROBE/CONSORT/PRISMA 自查" },
  { id: "rebuttal", icon: "✍️", title: "回复审稿", desc: "逐条回应审稿意见" },
];

interface Health {
  status: string;
  provider: string;
  model: string;
  mock: boolean;
  configured?: boolean;
}

export default function App() {
  const [active, setActive] = useState<ModuleId>("home");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const [disclaimerDismissed, setDisclaimerDismissed] = usePersistentState("ui:disclaimerDismissed", false);
  const [balance, setBalance] = useState<{
    available: boolean;
    provider?: string;
    currency?: string;
    balance?: string;
    tokens?: { total_tokens: number; requests: number };
  } | null>(null);
  const sidebar = useSidebar();

  const goto: Goto = (target, patch) => {
    if (patch) {
      for (const [key, value] of Object.entries(patch)) writePersisted(key, value);
    }
    setActive(target);
  };

  // 拉取余额/用量(切换模块时刷新; 任务完成时也刷新, 接近实时反映额度与 token 消耗)
  useEffect(() => {
    const refresh = () =>
      fetch(apiUrl("/api/usage"))
        .then((r) => r.json())
        .then(setBalance)
        .catch(() => setBalance(null));
    refresh();
    window.addEventListener("usage-updated", refresh);
    return () => window.removeEventListener("usage-updated", refresh);
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // 自动轮询健康检查, 直到本地服务就绪(应对“浏览器先开、服务后启动”)。
    const probe = async () => {
      try {
        const r = await fetch(apiUrl("/api/health"));
        const data = await r.json();
        if (cancelled) return;
        setHealth(data);
        setHealthErr(false);
      } catch {
        if (cancelled) return;
        setHealthErr(true);
        timer = setTimeout(probe, 2000); // 未连接则 2 秒后重试
      }
    };
    probe();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="app">
      {/* 折叠态下，点击侧栏空白区（非 nav-item / sidebar-toggle）= 锁定展开 */}
      <aside
        className="sidebar"
        data-state={sidebar.state}
        onMouseEnter={sidebar.onPeekEnter}
        onMouseLeave={sidebar.onPeekLeave}
        onClick={(e) => {
          if (sidebar.mode === "collapsed") {
            const t = e.target as HTMLElement;
            if (!t.closest(".nav-item") && !t.closest(".sidebar-toggle")) {
              sidebar.toggle();
            }
          }
        }}
      >
        <div className="brand-row">
          <div className="brand" onClick={() => setActive("home")} data-testid="brand">
            <span className="brand-logo">🔬</span>
            <span className="brand-name">科研助手</span>
          </div>
          <button
            className="sidebar-toggle"
            onClick={sidebar.toggle}
            data-testid="sidebar-toggle"
            aria-label={sidebar.mode === "expanded" ? "收起侧栏" : "展开侧栏"}
          >
            {sidebar.mode === "expanded" ? "«" : "»"}
          </button>
        </div>
        <nav className="nav">
          <div className="pipeline">
            {NAV.map((m, i) => (
              <button
                key={m.id}
                className={`nav-item ${active === m.id ? "active" : ""}`}
                onClick={() => setActive(m.id)}
                data-testid={`nav-${m.id}`}
              >
                <span className="nav-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="nav-text">
                  <span className="nav-title">{m.title}</span>
                  <span className="nav-desc">{m.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <button
            className={`nav-item nav-aux ${active === "history" ? "active" : ""}`}
            onClick={() => setActive("history")}
            data-testid="nav-history"
          >
            <span className="nav-num aux">📜</span>
            <span className="nav-text">
              <span className="nav-title">历史记录</span>
              <span className="nav-desc">回看与恢复过往结果</span>
            </span>
          </button>
        </nav>
        <div className="sidebar-foot">
          {health ? (
            <span className="status-ok" data-testid="status">
              ● 已就绪 · {health.mock ? "演示模式" : health.model}
            </span>
          ) : healthErr ? (
            <span className="status-wait" data-testid="status">
              ○ 正在连接本地服务…请稍候
            </span>
          ) : (
            <span className="status-wait" data-testid="status">
              ○ 连接中…
            </span>
          )}
          {health && !health.mock && health.configured === false && (
            <span className="status-warn" data-testid="status-warn">
              ⚠ 未配置密钥，请在 backend/.env 填写
            </span>
          )}
          {balance?.available && (
            <span className="status-balance" data-testid="balance">
              💰 {balance.provider} 余额 ¥{balance.balance}
            </span>
          )}
          {balance?.tokens && balance.tokens.total_tokens > 0 && (
            <span className="status-tokens" data-testid="token-usage">
              🔢 本次已用 {balance.tokens.total_tokens.toLocaleString()} tokens · {balance.tokens.requests} 次调用
            </span>
          )}
          <ThemeSwitcher />
        </div>
        {/* 折叠态指示条：24px 内的 ticks，用 CSS 在 expanded 下隐藏 */}
        <div className="rail-ticks" aria-hidden="true">
          <span className={`rail-tick ${active === "idea" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "plan" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "analyze" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "imrad" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "journal" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "format" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "checklist" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "rebuttal" ? "active" : ""}`} />
        </div>
      </aside>

      <main className="content">
        {!disclaimerDismissed && (
          <div className="disclaimer" data-testid="disclaimer">
            <span>
              ⚠ 本工具由 AI 辅助：所有生成内容（数字、引用、结论）请务必<strong>人工核对</strong>后使用；
              按 ICMJE / 期刊规范，论文中应<strong>声明 AI 使用情况</strong>。
            </span>
            <button
              className="disclaimer-close"
              data-testid="disclaimer-close"
              onClick={() => setDisclaimerDismissed(true)}
            >
              我已知晓
            </button>
          </div>
        )}
        <div className="page" key={active}>
          {active === "home" && <Home onPick={setActive} />}
          {active === "idea" && <IdeaModule goto={goto} />}
          {active === "plan" && <PlanModule />}
          {active === "analyze" && <AnalyzeModule goto={goto} />}
          {active === "imrad" && <ImradModule />}
          {active === "journal" && <JournalMatchModule />}
          {active === "format" && <FormatModule />}
          {active === "checklist" && <ChecklistModule />}
          {active === "rebuttal" && <RebuttalModule />}
          {active === "history" && <HistoryView goto={goto} />}
        </div>
      </main>
    </div>
  );
}

function Home({ onPick }: { onPick: (m: ModuleId) => void }) {
  return (
    <div className="home">
      <div className="home-stage">
        <div className="home-text">
          <p className="eyebrow">A Quiet Workbench · 专注的工作台</p>
          <h1>
            把直觉，<br />
            写成可被复现的方法。
          </h1>
          <p className="home-sub">
            从一个粗糙的想法，到经得起评议的论文。<br />
            一个安静的工作台，给一项需要专注的工作。
          </p>
          <div className="home-actions">
            <button
              className="home-cta"
              onClick={() => onPick("idea")}
              data-testid="home-cta"
            >
              从一个选题开始 <span aria-hidden="true">→</span>
            </button>
            <span className="home-meta">面向医学 · 药学 · 生物医学研究者</span>
          </div>
        </div>
        <div className="home-art" aria-hidden="true">
          <HeroArt />
        </div>
      </div>
    </div>
  );
}

// ── 3D 球棍分子模型：咖啡因（C8H10N4O2）─────────────────────────
// 数据：原子的 3D 坐标（埃，源自标准晶体结构）+ 键连接关系
type AtomEl = "C" | "N" | "O" | "H";
const ATOMS_3D: readonly { el: AtomEl; pos: readonly [number, number, number] }[] = [
  { el: "N", pos: [-1.83,  1.41,  0.02] }, // 0  N1
  { el: "C", pos: [-0.55,  2.00,  0.04] }, // 1  C2
  { el: "N", pos: [ 0.55,  1.20,  0.04] }, // 2  N3
  { el: "C", pos: [ 0.31, -0.16,  0.02] }, // 3  C4
  { el: "C", pos: [-0.97, -0.79,  0.00] }, // 4  C5
  { el: "C", pos: [-2.13, -0.05,  0.02] }, // 5  C6
  { el: "N", pos: [-0.86, -2.18,  0.00] }, // 6  N7
  { el: "C", pos: [ 0.52, -2.36,  0.04] }, // 7  C8
  { el: "N", pos: [ 1.27, -1.16,  0.04] }, // 8  N9
  { el: "O", pos: [-0.34,  3.21,  0.06] }, // 9  O on C2
  { el: "O", pos: [-3.30, -0.45,  0.02] }, // 10 O on C6
  { el: "C", pos: [-3.06,  2.22,  0.50] }, // 11 CH3 on N1
  { el: "C", pos: [ 1.91,  1.69, -0.50] }, // 12 CH3 on N3
  { el: "C", pos: [-1.94, -3.16,  0.55] }, // 13 CH3 on N7
  { el: "H", pos: [ 1.05, -3.27,  0.06] }, // 14 H on C8
];
const BONDS_3D: readonly { a: number; b: number }[] = [
  { a: 0,  b: 1 },  { a: 1,  b: 2 },  { a: 2,  b: 3 },
  { a: 3,  b: 4 },  { a: 4,  b: 5 },  { a: 5,  b: 0 },
  { a: 4,  b: 6 },  { a: 6,  b: 7 },  { a: 7,  b: 8 }, { a: 8, b: 3 },
  { a: 1,  b: 9 },  { a: 5,  b: 10 },
  { a: 0,  b: 11 }, { a: 2,  b: 12 }, { a: 6,  b: 13 }, { a: 7, b: 14 },
];
const ATOM_RADIUS: Record<AtomEl, number> = { C: 11, N: 12, O: 13, H: 7 };
const ATOM_STICK_COLOR: Record<AtomEl, string> = {
  C: "#42504e", N: "#0c5e58", O: "#9b1c14", H: "#a8b3b1",
};

const VIEW = 500;
const CENTER = VIEW / 2;
const SCALE = 38;       // 像素 / 埃
const PERSP_K = 0.18;   // 透视强度（越大越夸张）
const PERSP_D = 8;      // 焦距

function project3D(
  pos: readonly [number, number, number],
  rx: number,
  ry: number,
) {
  const [x, y, z] = pos;
  // X 轴旋转（屏幕上下倾斜）
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const y1 = y * cosX - z * sinX;
  const z1 = y * sinX + z * cosX;
  // Y 轴旋转（屏幕水平转）
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const x2 = x * cosY + z1 * sinY;
  const z2 = -x * sinY + z1 * cosY;
  // 透视（远小近大）
  const persp = PERSP_D / (PERSP_D + z2 * PERSP_K);
  return {
    x: CENTER + x2 * SCALE * persp,
    y: CENTER - y1 * SCALE * persp,
    z: z2,
    persp,
  };
}

// 3D 球棍模型 hero。自转 + 鼠标拖拽双轴旋转。
function HeroArt() {
  const containerRef = useRef<HTMLDivElement>(null);
  const atomRefs = useRef<(SVGCircleElement | null)[]>([]);
  const bondARefs = useRef<(SVGLineElement | null)[]>([]);
  const bondBRefs = useRef<(SVGLineElement | null)[]>([]);

  const stateRef = useRef({
    rx: -0.35,            // 初始向下倾，避免正面看像贴片
    ry: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const draw = () => {
      const { rx, ry } = stateRef.current;
      const projected = ATOMS_3D.map((a) => project3D(a.pos, rx, ry));

      // 原子球（位置 + 半径透视缩放）
      for (let i = 0; i < ATOMS_3D.length; i++) {
        const ref = atomRefs.current[i];
        if (!ref) continue;
        const p = projected[i];
        const r = ATOM_RADIUS[ATOMS_3D[i].el] * p.persp;
        ref.setAttribute("cx", p.x.toFixed(2));
        ref.setAttribute("cy", p.y.toFixed(2));
        ref.setAttribute("r", r.toFixed(2));
      }

      // 化学键：每根拆成两半，各取所连原子的颜色
      for (let i = 0; i < BONDS_3D.length; i++) {
        const { a, b } = BONDS_3D[i];
        const pa = projected[a];
        const pb = projected[b];
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        const sw = (3.4 * (pa.persp + pb.persp)) / 2;
        const refA = bondARefs.current[i];
        const refB = bondBRefs.current[i];
        if (refA) {
          refA.setAttribute("x1", pa.x.toFixed(2));
          refA.setAttribute("y1", pa.y.toFixed(2));
          refA.setAttribute("x2", mx.toFixed(2));
          refA.setAttribute("y2", my.toFixed(2));
          refA.setAttribute("stroke-width", sw.toFixed(2));
        }
        if (refB) {
          refB.setAttribute("x1", mx.toFixed(2));
          refB.setAttribute("y1", my.toFixed(2));
          refB.setAttribute("x2", pb.x.toFixed(2));
          refB.setAttribute("y2", pb.y.toFixed(2));
          refB.setAttribute("stroke-width", sw.toFixed(2));
        }
      }
    };

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!stateRef.current.dragging) {
        stateRef.current.ry += 0.18 * dt; // 约 10.3°/sec，一圈 ~35s
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    stateRef.current.dragging = true;
    stateRef.current.lastX = e.clientX;
    stateRef.current.lastY = e.clientY;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!stateRef.current.dragging) return;
    const dx = e.clientX - stateRef.current.lastX;
    const dy = e.clientY - stateRef.current.lastY;
    stateRef.current.ry += dx * 0.012;  // 横向 → Y 轴（左右转）
    stateRef.current.rx += dy * 0.012;  // 纵向 → X 轴（上下倾）
    // 限制 X 倾不超过 ±80° 避免上下翻飞
    const max = Math.PI / 2 - 0.1;
    if (stateRef.current.rx > max) stateRef.current.rx = max;
    if (stateRef.current.rx < -max) stateRef.current.rx = -max;
    stateRef.current.lastX = e.clientX;
    stateRef.current.lastY = e.clientY;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    stateRef.current.dragging = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      className="home-art-wrap"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-testid="hero-art"
    >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="hero-svg"
        role="img"
        aria-label="caffeine 3D ball-and-stick model"
      >
        <defs>
          <radialGradient id="hero-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.18" />
            <stop offset="55%" stopColor="var(--teal)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
          </radialGradient>
          {/* 各元素的 3D 球面径向渐变：高光在左上 */}
          <radialGradient id="atom-c" cx="32%" cy="28%" r="68%">
            <stop offset="0%" stopColor="#c8d2d0" />
            <stop offset="55%" stopColor="#6c7876" />
            <stop offset="100%" stopColor="#1f2928" />
          </radialGradient>
          <radialGradient id="atom-n" cx="32%" cy="28%" r="68%">
            <stop offset="0%" stopColor="#9bebe2" />
            <stop offset="55%" stopColor="#1d8e85" />
            <stop offset="100%" stopColor="#062927" />
          </radialGradient>
          <radialGradient id="atom-o" cx="32%" cy="28%" r="68%">
            <stop offset="0%" stopColor="#ffb3a8" />
            <stop offset="55%" stopColor="#c84030" />
            <stop offset="100%" stopColor="#5c1009" />
          </radialGradient>
          <radialGradient id="atom-h" cx="28%" cy="22%" r="74%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="60%" stopColor="#c5cecc" />
            <stop offset="100%" stopColor="#6a7674" />
          </radialGradient>
        </defs>

        {/* 背景光晕 + 远景同心轨道（不旋转） */}
        <circle cx={CENTER} cy={CENTER} r="230" fill="url(#hero-halo)" />
        <g className="hero-rings" fill="none">
          <circle cx={CENTER} cy={CENTER} r="228" stroke="var(--line)" strokeWidth="0.6" strokeDasharray="1 7" />
          <circle cx={CENTER} cy={CENTER} r="195" stroke="var(--line-soft)" strokeWidth="0.7" />
        </g>

        {/* 化学键：每根拆成两段，按所连原子着色 */}
        <g className="bonds-group" strokeLinecap="round">
          {BONDS_3D.map((bond, i) => (
            <g key={`bond-${i}`}>
              <line
                ref={(el) => {
                  bondARefs.current[i] = el;
                }}
                stroke={ATOM_STICK_COLOR[ATOMS_3D[bond.a].el]}
              />
              <line
                ref={(el) => {
                  bondBRefs.current[i] = el;
                }}
                stroke={ATOM_STICK_COLOR[ATOMS_3D[bond.b].el]}
              />
            </g>
          ))}
        </g>

        {/* 原子球 */}
        <g className="atoms-group">
          {ATOMS_3D.map((atom, i) => (
            <circle
              key={`atom-${i}`}
              ref={(el) => {
                atomRefs.current[i] = el;
              }}
              fill={`url(#atom-${atom.el.toLowerCase()})`}
            />
          ))}
        </g>

        {/* 角标 */}
        <g className="hero-caption">
          <text x={CENTER} y="450" textAnchor="middle" className="hero-formula">
            C₈H₁₀N₄O₂
          </text>
          <text x={CENTER} y="472" textAnchor="middle" className="hero-formula-sub">
            CAFFEINE · DRAG TO ROTATE
          </text>
        </g>
      </svg>
    </div>
  );
}
