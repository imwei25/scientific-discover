import { useEffect, useState } from "react";
import { apiUrl } from "./lib/api";
import { writePersisted, usePersistentState } from "./lib/usePersistentState";
import IdeaModule from "./modules/IdeaModule";
import PlanModule from "./modules/PlanModule";
import AnalyzeModule from "./modules/AnalyzeModule";
import FormatModule from "./modules/FormatModule";

export type ModuleId = "home" | "idea" | "plan" | "analyze" | "format";
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
      <aside className="sidebar">
        <div className="brand" onClick={() => setActive("home")} data-testid="brand">
          <span className="brand-logo">🔬</span>
          <span className="brand-name">科研助手</span>
        </div>
        <nav className="nav">
          {NAV.map((m) => (
            <button
              key={m.id}
              className={`nav-item ${active === m.id ? "active" : ""}`}
              onClick={() => setActive(m.id)}
              data-testid={`nav-${m.id}`}
            >
              <span className="nav-icon">{m.icon}</span>
              <span className="nav-text">
                <span className="nav-title">{m.title}</span>
                <span className="nav-desc">{m.desc}</span>
              </span>
            </button>
          ))}
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
        {active === "home" && <Home onPick={setActive} />}
        {active === "idea" && <IdeaModule goto={goto} />}
        {active === "plan" && <PlanModule />}
        {active === "analyze" && <AnalyzeModule goto={goto} />}
        {active === "format" && <FormatModule />}
      </main>
    </div>
  );
}

function Home({ onPick }: { onPick: (m: ModuleId) => void }) {
  return (
    <div className="home">
      <h1>欢迎使用科研助手</h1>
      <p className="home-sub">
        从找选题到投稿，四步陪你走完科研全流程。选择一个功能开始：
      </p>
      <div className="home-grid">
        {NAV.map((m) => (
          <button key={m.id} className="home-card" onClick={() => onPick(m.id)} data-testid={`card-${m.id}`}>
            <span className="home-card-icon">{m.icon}</span>
            <span className="home-card-title">{m.title}</span>
            <span className="home-card-desc">{m.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
