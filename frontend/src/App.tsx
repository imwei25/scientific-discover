import { useEffect, useState } from "react";
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

function HeroArt() {
  return (
    <svg viewBox="0 0 500 500" className="hero-svg" role="img">
      <defs>
        <radialGradient id="hero-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.18" />
          <stop offset="55%" stopColor="var(--teal)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hero-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--paper-warm)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--petrol)" stopOpacity="1" />
        </radialGradient>
      </defs>

      {/* halo glow */}
      <circle cx="250" cy="250" r="230" fill="url(#hero-halo)" />

      {/* rotating constellation */}
      <g className="hero-spin">
        {/* concentric rings */}
        <circle
          cx="250"
          cy="250"
          r="228"
          fill="none"
          stroke="var(--line)"
          strokeWidth="0.6"
          strokeDasharray="1 7"
        />
        <circle
          cx="250"
          cy="250"
          r="178"
          fill="none"
          stroke="var(--line)"
          strokeWidth="0.8"
        />
        <circle
          cx="250"
          cy="250"
          r="118"
          fill="none"
          stroke="var(--teal)"
          strokeWidth="0.8"
          opacity="0.5"
          strokeDasharray="3 4"
        />

        {/* sparse network */}
        <g
          stroke="var(--teal)"
          strokeWidth="0.7"
          opacity="0.4"
          fill="none"
          strokeLinecap="round"
        >
          <line x1="250" y1="118" x2="376" y2="232" />
          <line x1="376" y1="232" x2="316" y2="386" />
          <line x1="316" y1="386" x2="158" y2="354" />
          <line x1="158" y1="354" x2="108" y2="198" />
          <line x1="108" y1="198" x2="250" y2="118" />
          <line x1="250" y1="250" x2="376" y2="232" />
          <line x1="250" y1="250" x2="158" y2="354" />
          <line x1="250" y1="250" x2="108" y2="198" />
        </g>

        {/* outer particles */}
        <g className="hero-particles" fill="var(--teal)">
          <circle cx="250" cy="118" r="5.5" />
          <circle cx="376" cy="232" r="7" />
          <circle cx="316" cy="386" r="4.5" />
          <circle cx="158" cy="354" r="6" />
          <circle cx="108" cy="198" r="5" />
        </g>

        {/* faint inner particles */}
        <g className="hero-particles-soft" fill="var(--petrol)" opacity="0.45">
          <circle cx="206" cy="180" r="3" />
          <circle cx="320" cy="172" r="3.5" />
          <circle cx="294" cy="324" r="3" />
          <circle cx="178" cy="266" r="2.6" />
        </g>
      </g>

      {/* central anchor (no rotation) */}
      <g className="hero-anchor">
        <circle
          cx="250"
          cy="250"
          r="28"
          fill="none"
          stroke="var(--petrol)"
          strokeWidth="1"
          opacity="0.25"
        />
        <circle cx="250" cy="250" r="18" fill="url(#hero-core)" />
        <circle cx="250" cy="250" r="6" fill="var(--paper-warm)" />
      </g>
    </svg>
  );
}
