import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./lib/api";
import { writePersisted, usePersistentState } from "./lib/usePersistentState";
import { useSidebar } from "./lib/sidebar";
import IdeaModule from "./modules/IdeaModule";
import PlanModule from "./modules/PlanModule";
import AnalyzeModule from "./modules/AnalyzeModule";
import FormatModule from "./modules/FormatModule";
import HistoryView from "./modules/HistoryView";
import ThemeSwitcher from "./components/ThemeSwitcher";

export type ModuleId = "home" | "idea" | "plan" | "analyze" | "format" | "history";
// 跨模块传递: 把数据写入目标模块的持久化字段, 再切换过去。
export type Goto = (target: ModuleId, patch?: Record<string, unknown>) => void;

const NAV: { id: ModuleId; icon: string; title: string; desc: string }[] = [
  { id: "idea", icon: "💡", title: "找选题", desc: "发现研究方向与创新点" },
  { id: "plan", icon: "🗺️", title: "实验规划", desc: "把想法变成可执行的计划" },
  { id: "analyze", icon: "📊", title: "数据分析与写作", desc: "上传数据，分析并成文" },
  { id: "format", icon: "📄", title: "期刊排版", desc: "按目标期刊要求重排" },
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
  const [balance, setBalance] = useState<{ available: boolean; provider?: string; currency?: string; balance?: string } | null>(null);
  const sidebar = useSidebar();

  const goto: Goto = (target, patch) => {
    if (patch) {
      for (const [key, value] of Object.entries(patch)) writePersisted(key, value);
    }
    setActive(target);
  };

  // 拉取余额(切换模块时刷新, 接近实时反映额度变化)
  useEffect(() => {
    fetch(apiUrl("/api/usage"))
      .then((r) => r.json())
      .then(setBalance)
      .catch(() => setBalance(null));
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
          <ThemeSwitcher />
        </div>
        {/* 折叠态指示条：24px 内的 ticks，用 CSS 在 expanded 下隐藏 */}
        <div className="rail-ticks" aria-hidden="true">
          <span className={`rail-tick ${active === "idea" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "plan" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "analyze" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "format" ? "active" : ""}`} />
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
          {active === "format" && <FormatModule />}
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

// 缓慢自转 + 鼠标拖拽旋转的咖啡因分子骨架（C8H10N4O2）
// 不用 React state 驱动角度，直接 ref + setAttribute 避免每帧重 render。
function HeroArt() {
  const containerRef = useRef<HTMLDivElement>(null);
  const spinRef = useRef<SVGGElement>(null);
  const stateRef = useRef({
    angle: 0,
    dragging: false,
    lastCursorAngle: 0,
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // 不在拖拽中时缓慢自转（2.5°/sec ≈ 一圈 144 秒）
      if (!stateRef.current.dragging) {
        stateRef.current.angle += 2.5 * dt;
      }
      if (spinRef.current) {
        spinRef.current.setAttribute(
          "transform",
          `rotate(${stateRef.current.angle} 250 250)`,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cursorAngleFromCenter = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    stateRef.current.dragging = true;
    stateRef.current.lastCursorAngle = cursorAngleFromCenter(e.clientX, e.clientY);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!stateRef.current.dragging) return;
    const cur = cursorAngleFromCenter(e.clientX, e.clientY);
    // 跨越 ±180° 时归一化，避免突然回弹
    let delta = cur - stateRef.current.lastCursorAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    stateRef.current.lastCursorAngle = cur;
    stateRef.current.angle += delta;
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
        viewBox="0 0 500 500"
        className="hero-svg"
        role="img"
        aria-label="caffeine molecule, C8H10N4O2"
      >
        <defs>
          <radialGradient id="hero-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.18" />
            <stop offset="55%" stopColor="var(--teal)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* halo glow */}
        <circle cx="250" cy="250" r="230" fill="url(#hero-halo)" />

        {/* 远景同心轨道 */}
        <g className="hero-rings" fill="none">
          <circle cx="250" cy="250" r="228" stroke="var(--line)" strokeWidth="0.6" strokeDasharray="1 7" />
          <circle cx="250" cy="250" r="195" stroke="var(--line-soft)" strokeWidth="0.7" />
        </g>

        {/* 分子骨架（拖拽 + 自转） */}
        <g ref={spinRef} transform="rotate(0 250 250)">
          <Molecule />
        </g>

        {/* 角标：化学式 */}
        <g className="hero-caption">
          <text x="250" y="450" textAnchor="middle" className="hero-formula">
            C₈H₁₀N₄O₂
          </text>
          <text x="250" y="472" textAnchor="middle" className="hero-formula-sub">
            CAFFEINE · 1,3,7-TRIMETHYLXANTHINE
          </text>
        </g>
      </svg>
    </div>
  );
}

// 咖啡因分子骨架。位置基于标准 2D 表达，自洽即可。
function Molecule() {
  return (
    <g
      className="molecule"
      stroke="var(--ink)"
      strokeWidth="1.7"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 6-mem pyrimidine ring 单键 */}
      <line x1="157" y1="225" x2="200" y2="200" />
      <line x1="200" y1="200" x2="243" y2="225" />
      <line x1="243" y1="225" x2="243" y2="275" />
      <line x1="200" y1="300" x2="157" y2="275" />
      <line x1="157" y1="275" x2="157" y2="225" />

      {/* C4=C5 共享双键 */}
      <line x1="243" y1="275" x2="200" y2="300" />
      <line x1="237" y1="270" x2="194" y2="295" />

      {/* 5-mem imidazole ring 单键 */}
      <line x1="200" y1="300" x2="210" y2="349" />
      <line x1="210" y1="349" x2="260" y2="354" />
      <line x1="280" y1="308" x2="243" y2="275" />

      {/* C8=N9 双键 */}
      <line x1="260" y1="354" x2="280" y2="308" />
      <line x1="265" y1="356" x2="285" y2="310" />

      {/* 取代基单键 */}
      <line x1="157" y1="225" x2="127" y2="207" />
      <line x1="243" y1="225" x2="273" y2="207" />
      <line x1="210" y1="349" x2="190" y2="371" />
      <line x1="260" y1="354" x2="275" y2="380" />

      {/* C2=O 双键 */}
      <line x1="200" y1="200" x2="200" y2="165" />
      <line x1="206" y1="200" x2="206" y2="165" />

      {/* C6=O 双键 */}
      <line x1="157" y1="275" x2="127" y2="293" />
      <line x1="161" y1="282" x2="131" y2="300" />

      {/* 原子标签底色（遮住键的末端，呈现 "标签贴在键上" 的效果） */}
      <g className="atom-halo" stroke="none">
        <circle cx="157" cy="225" r="9" />
        <circle cx="243" cy="225" r="9" />
        <circle cx="210" cy="349" r="9" />
        <circle cx="280" cy="308" r="9" />
        <circle cx="200" cy="165" r="9" />
        <circle cx="127" cy="293" r="9" />
        <circle cx="127" cy="207" r="13" />
        <circle cx="273" cy="207" r="13" />
        <circle cx="190" cy="371" r="13" />
        <circle cx="275" cy="380" r="9" />
      </g>

      {/* 原子标签 */}
      <g className="atom-label" stroke="none" textAnchor="middle" dominantBaseline="central">
        <text x="157" y="225">N</text>
        <text x="243" y="225">N</text>
        <text x="210" y="349">N</text>
        <text x="280" y="308">N</text>
        <text x="200" y="165" className="atom-o">O</text>
        <text x="127" y="293" className="atom-o">O</text>
        <text x="127" y="207" className="atom-r">CH₃</text>
        <text x="273" y="207" className="atom-r">CH₃</text>
        <text x="190" y="371" className="atom-r">CH₃</text>
        <text x="275" y="380">H</text>
      </g>
    </g>
  );
}
