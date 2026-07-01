import { useEffect, useState, type ReactNode } from "react";
import {
  Lightbulb, Map, ClipboardList, BarChart3, FileText,
  Target, FileType, CheckSquare, MessageSquareReply, ScrollText, FileSignature,
} from "lucide-react";
import { apiUrl } from "./lib/api";
import { writePersisted, usePersistentState } from "./lib/usePersistentState";
import { useSidebar } from "./lib/sidebar";
import IdeaModule from "./modules/IdeaModule";
import PlanModule from "./modules/PlanModule";
import EthicsModule from "./modules/EthicsModule";
import AnalyzeModule from "./modules/AnalyzeModule";
import ImradModule from "./modules/ImradModule";
import GrantModule from "./modules/GrantModule";
import JournalMatchModule from "./modules/JournalMatchModule";
import FormatModule from "./modules/FormatModule";
import ChecklistModule from "./modules/ChecklistModule";
import RebuttalModule from "./modules/RebuttalModule";
import HistoryView from "./modules/HistoryView";
import ThemeSwitcher from "./components/ThemeSwitcher";
import FontSizeSwitcher, { useFontSize } from "./components/FontSizeSwitcher";
import ProjectPicker from "./components/ProjectPicker";
import OnboardingWizard from "./components/OnboardingWizard";
import ToastContainer from "./components/Toast";
import CommandPalette, { restoreHistoryEntry } from "./components/CommandPalette";
import { CanvasProvider } from "./components/Canvas";
import { showToast } from "./lib/toast";
import { useProjects } from "./lib/projects";

export type ModuleId = "home" | "idea" | "grant" | "plan" | "ethics" | "analyze" | "imrad" | "journal" | "format" | "checklist" | "rebuttal" | "history";
// 产出文稿的阶段: 进入这些模块时, 屏幕一分为二, 右半屏固定为「画布」展示最终产出。
const STAGE_CANVAS = new Set<ModuleId>(["idea", "grant", "plan", "ethics", "analyze", "imrad", "rebuttal"]);
// 跨模块传递: 把数据写入目标模块的持久化字段, 再切换过去。
export type Goto = (target: ModuleId, patch?: Record<string, unknown>) => void;

// W2-4-c: 用 Lucide 图标替代 emoji; W2-4-h: 导航 desc 白话化
const ICON_PROPS = { size: 18, strokeWidth: 1.75 } as const;
const NAV: { id: ModuleId; icon: ReactNode; title: string; desc: string; hidden?: boolean }[] = [
  { id: "idea",     icon: <Lightbulb {...ICON_PROPS} />,           title: "找选题",       desc: "发现研究方向与创新点" },
  { id: "grant",    icon: <FileSignature {...ICON_PROPS} />,       title: "写标书",       desc: "把选题写成中文基金申请书初稿" },
  { id: "plan",     icon: <Map {...ICON_PROPS} />,                 title: "实验规划",     desc: "把研究想法变成可执行方案 + 样本量" },
  { id: "ethics",   icon: <ClipboardList {...ICON_PROPS} />,       title: "伦理材料",     desc: "知情同意/方案/CRF" },
  { id: "analyze",  icon: <BarChart3 {...ICON_PROPS} />,           title: "数据分析与写作", desc: "上传数据自动分析 + 出图（数字本地算）" },
  { id: "imrad",    icon: <FileText {...ICON_PROPS} />,            title: "论文初稿",     desc: "把材料拼成医学论文（IMRaD 结构）" },
  { id: "journal",  icon: <Target {...ICON_PROPS} />,              title: "智能选刊",     desc: "AI 推荐适合你研究的期刊" },
  { id: "format",   icon: <FileType {...ICON_PROPS} />,            title: "期刊排版",     desc: "按期刊要求重排 + 参考文献格式化" },
  // 暂时隐藏「报告规范核对」，意义待明确，以后再说（hidden 过滤掉，模块代码保留）
  { id: "checklist", icon: <CheckSquare {...ICON_PROPS} />,        title: "报告规范核对", desc: "按医学研究报告规范逐条自查", hidden: true },
  { id: "rebuttal", icon: <MessageSquareReply {...ICON_PROPS} />,  title: "回复审稿",     desc: "AI 帮你逐条回应审稿人" },
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
  // 右画布的 Portal 目标节点; 用 ref 回调 setState 拿到, 拿到后触发一次 re-render 让 CanvasSlot 归位。
  const [canvasEl, setCanvasEl] = useState<HTMLElement | null>(null);
  // 右画布是否收起(记忆用户偏好); 收起时缩成右侧窄条, 左工作区占满, 只留一个展开按钮。
  const [canvasCollapsed, setCanvasCollapsed] = usePersistentState<boolean>("canvas:collapsed", false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  // W2-4-f 免责声明: 用时间戳代替布尔, 7 天后自动重现
  const [disclaimerDismissedAt, setDisclaimerDismissedAt] = usePersistentState<number>("disclaimer:lastDismissed", 0);
  const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
  const disclaimerDismissed = disclaimerDismissedAt > 0 && Date.now() - disclaimerDismissedAt < SEVEN_DAYS_MS;
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [balance, setBalance] = useState<{
    available: boolean;
    provider?: string;
    currency?: string;
    balance?: string;
    tokens?: { total_tokens: number; requests: number };
  } | null>(null);
  const sidebar = useSidebar();
  const { current: currentProject, syncStatus } = useProjects();
  // W2-4-a: 副作用 — 注入 data-font-size 到 <html>
  useFontSize();

  const goto: Goto = (target, patch) => {
    if (patch) {
      for (const [key, value] of Object.entries(patch)) writePersisted(key, value);
    }
    setActive(target);
  };

  // 当前模块是否走「左工作区 + 右画布」分屏
  const hasCanvas = STAGE_CANVAS.has(active);
  const canvasTitle = NAV.find((n) => n.id === active)?.title ?? "";

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
        // 触发首次配置向导: configured=false 且尚未完成 onboarding
        try {
          const done = localStorage.getItem("onboarding:done") === "1";
          if (!done && data && data.configured === false && !data.mock) {
            setOnboardingOpen(true);
          }
        } catch {
          /* localStorage 可能被禁用; 忽略 */
        }
      } catch {
        if (cancelled) return;
        setHealthErr(true);
        timer = setTimeout(probe, 2000); // 未连接则 2 秒后重试
      }
    };
    probe();
    // 暴露给子组件: 完成 wizard 后可以触发重新拉取
    (window as unknown as { __refreshHealth?: () => void }).__refreshHealth = probe;
    return () => {
      cancelled = true;
      clearTimeout(timer);
      delete (window as unknown as { __refreshHealth?: () => void }).__refreshHealth;
    };
  }, []);

  // 允许其他组件(Toast 的"重新配置"按钮)调起 wizard
  useEffect(() => {
    const onReopen = () => setOnboardingOpen(true);
    window.addEventListener("onboarding:reopen", onReopen);
    return () => window.removeEventListener("onboarding:reopen", onReopen);
  }, []);

  // W2-4-g: Cmd/Ctrl+K 唤出命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // W2-2: syncStatus 持续 error 超 5 秒, 弹 Toast 提示
  useEffect(() => {
    if (syncStatus !== "error") return;
    const tm = setTimeout(() => {
      showToast({
        kind: "warn",
        message: "项目数据未同步到本地数据库, 正在自动重试; 网络若仍不通可能丢失本次改动",
      });
    }, 5000);
    return () => clearTimeout(tm);
  }, [syncStatus]);

  return (
    <div className="app">
      <ToastContainer />
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        modules={NAV.map((m) => ({ id: m.id, title: m.title, desc: m.desc, icon: m.icon }))}
        onPickModule={(id) => setActive(id as ModuleId)}
        onPickHistory={(entry) => restoreHistoryEntry(entry, (m) => setActive(m as ModuleId))}
      />
      {onboardingOpen && (
        <OnboardingWizard
          onClose={() => {
            setOnboardingOpen(false);
            // 重新拉取 health 让 UI 立刻反映新配置 (mock 标志、configured 等)
            const refresh = (window as unknown as { __refreshHealth?: () => void }).__refreshHealth;
            if (refresh) refresh();
          }}
        />
      )}
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
            <span className="brand-name brand-name-niuma">niuma-research</span>
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
            {NAV.filter((m) => !m.hidden).map((m, i) => (
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
            <span className="nav-num aux"><ScrollText size={16} strokeWidth={1.75} /></span>
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
            <button
              className="status-warn status-warn-btn"
              data-testid="status-warn"
              onClick={() => setOnboardingOpen(true)}
            >
              ⚠ 未配置密钥 · 点此设置
            </button>
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
          {syncStatus !== "idle" && (
            <span
              className={`sync-badge ${syncStatus}`}
              data-testid="sync-badge"
              title={syncStatus === "error" ? "未同步到本地数据库；将自动重试，或点击立即重试" : undefined}
            >
              {syncStatus === "saving" ? "… 保存中" : "⚠ 未同步"}
            </span>
          )}
          <ThemeSwitcher />
        </div>
        {/* 折叠态指示条：24px 内的 ticks，用 CSS 在 expanded 下隐藏 */}
        <div className="rail-ticks" aria-hidden="true">
          <span className={`rail-tick ${active === "idea" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "grant" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "plan" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "ethics" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "analyze" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "imrad" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "journal" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "format" ? "active" : ""}`} />
          <span className={`rail-tick ${active === "rebuttal" ? "active" : ""}`} />
        </div>
      </aside>

      <main className="content">
        {/* 右上角工具栏: 项目选择器 + 字号 + 设置 并排 */}
        <div className="content-topbar">
          <NiumaMark onClick={() => setActive("home")} />
          <ProjectPicker />
          <FontSizeSwitcher />
          <button
            className="settings-btn"
            data-testid="open-settings"
            onClick={() => setOnboardingOpen(true)}
            title="设置 API key / 模型"
            aria-label="设置 API key / 模型"
          >
            ⚙ 设置
          </button>
        </div>
        <CanvasProvider target={hasCanvas ? canvasEl : null}>
        <div className={`content-body ${hasCanvas ? "has-canvas" : ""}`}>
        <div className="work-pane">
        {/* W2-4-e 演示模式横条 */}
        {health?.mock && (
          <div className="demo-banner" data-testid="demo-banner">
            <span className="demo-banner-icon" aria-hidden="true">⚠</span>
            <span>
              <strong>演示模式</strong> — 所有结果都是假数据, 仅供试用。配置真实 API key 后将自动消失。
            </span>
            <button
              className="demo-banner-action"
              data-testid="demo-banner-configure"
              onClick={() => {
                try { localStorage.removeItem("onboarding:done"); } catch { /* ignore */ }
                setOnboardingOpen(true);
              }}
            >
              现在配置
            </button>
          </div>
        )}
        {!disclaimerDismissed && (
          <div className="disclaimer" data-testid="disclaimer">
            <span>
              ⚠ 本工具由 AI 辅助：所有生成内容（数字、引用、结论）请务必<strong>人工核对</strong>后使用；
              按 ICMJE / 期刊规范，论文中应<strong>声明 AI 使用情况</strong>。
            </span>
            <button
              className="disclaimer-close"
              data-testid="disclaimer-close"
              onClick={() => setDisclaimerDismissedAt(Date.now())}
            >
              我已知晓
            </button>
          </div>
        )}
        <div className="page" key={`${currentProject?.id ?? "boot"}::${active}`}>
          {active === "home" && <Home onPick={setActive} />}
          {active === "idea" && <IdeaModule goto={goto} />}
          {active === "grant" && <GrantModule />}
          {active === "plan" && <PlanModule />}
          {active === "ethics" && <EthicsModule />}
          {active === "analyze" && <AnalyzeModule goto={goto} />}
          {active === "imrad" && <ImradModule goto={goto} />}
          {active === "journal" && <JournalMatchModule />}
          {active === "format" && <FormatModule />}
          {active === "checklist" && <ChecklistModule />}
          {active === "rebuttal" && <RebuttalModule />}
          {active === "history" && <HistoryView goto={goto} />}
        </div>
        </div>
        {hasCanvas && (
          <aside className={`canvas-pane${canvasCollapsed ? " collapsed" : ""}`} data-testid="canvas-pane">
            {canvasCollapsed ? (
              <button
                className="canvas-expand"
                data-testid="canvas-expand"
                onClick={() => setCanvasCollapsed(false)}
                title="展开产出"
              >
                ◂ 产出
              </button>
            ) : (
              <div className="canvas-head">
                <span>{canvasTitle} · 产出</span>
                <button
                  className="canvas-collapse"
                  data-testid="canvas-collapse"
                  onClick={() => setCanvasCollapsed(true)}
                  title="收起产出，让左侧占满"
                >
                  收起 ▸
                </button>
              </div>
            )}
            <div className="canvas-body">
              {/* Portal 目标; 模块的最终产出渲染进这里 */}
              <div className="canvas-target" data-testid="canvas-body" ref={setCanvasEl} />
              {/* 目标为空(尚无产出)时显示占位; 用 :empty 兄弟选择器切换 */}
              <div className="canvas-empty" data-testid="canvas-empty">
                <p>结果会显示在这里</p>
                <p className="canvas-empty-sub">在左侧填好信息并点击生成，产出会出现在右侧画布。</p>
              </div>
            </div>
          </aside>
        )}
        </div>
        </CanvasProvider>
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
          <h1 className="home-title-niuma">niuma-research</h1>
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
          <Niuma3D />
        </div>
      </div>

      <div className="home-overview">
        <p className="eyebrow">覆盖选题到投稿 · 每个工具都能单独用</p>
        <div className="home-cards">
          {NAV.filter((m) => !m.hidden).map((m, i) => (
            <button
              key={m.id}
              className="home-card"
              onClick={() => onPick(m.id)}
              data-testid={`home-card-${m.id}`}
            >
              <span className="home-card-num">{String(i + 1).padStart(2, "0")}</span>
              <span className="home-card-icon" aria-hidden="true">{m.icon}</span>
              <span className="home-card-body">
                <span className="home-card-title">{m.title}</span>
                <span className="home-card-desc">{m.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── niuma-research · 手绘 3D「牛马」装饰 ──────────────────────────
// 一只手绘的低多边形（low-poly / 纸艺感）牛马：牛头双角 + 马鬃马尾,
// 背上驮着一叠稿纸——「科研牛马」的自嘲。纯 inline SVG, 分面着色出
// 立体感（顶面亮 / 正面中 / 侧面暗）, 配色全走主题 token, 轻微漂浮。
function Niuma3D() {
  return (
    <div className="niuma3d" data-testid="hero-art" aria-hidden="true">
      <svg viewBox="0 0 340 300" className="niuma3d-svg" role="img" aria-hidden="true">
        <g className="n3">
          {/* 地面虚线 + 柔和投影（不随身体漂浮）*/}
          <line className="n3-ground" x1="42" y1="248" x2="300" y2="248" />
          <ellipse className="n3-shadow" cx="180" cy="250" rx="116" ry="15" />

          {/* 会漂浮的牛马本体 */}
          <g className="n3-creature">
            {/* 马尾（从后臀垂到身体左侧, 上端掖在身后）*/}
            <path
              className="n3-side"
              d="M120 92 C96 96 78 116 74 146 C70 172 80 190 92 198 C82 182 82 156 96 134 C106 118 116 104 128 96 Z"
            />
            <line className="n3-text" x1="88" y1="190" x2="80" y2="166" />
            <line className="n3-text" x1="95" y1="180" x2="87" y2="156" />

            {/* 远侧两腿（暗面）*/}
            <rect className="n3-side" x="222" y="176" width="16" height="64" rx="7" />
            <rect className="n3-dark" x="222" y="232" width="16" height="10" rx="4" />
            <rect className="n3-side" x="126" y="178" width="16" height="62" rx="7" />
            <rect className="n3-dark" x="126" y="232" width="16" height="10" rx="4" />

            {/* 躯干：侧面（暗）/ 顶面（亮）/ 正面（中）分面出 3D */}
            <polygon className="n3-side" points="210,190 210,104 245,82 245,168" />
            <polygon className="n3-top" points="90,104 210,104 245,82 125,82" />
            <polygon className="n3-front" points="90,104 210,104 210,190 90,190" />
            <polygon className="n3-dark" points="90,190 210,190 210,183 90,183" />

            {/* 背上驮的一叠稿纸 */}
            <polygon className="n3-paper" points="152,101 198,101 216,90 170,90" />
            <polygon className="n3-paper" points="148,105 194,105 212,94 166,94" />
            <line className="n3-text" x1="168" y1="100" x2="200" y2="94" />
            <line className="n3-text" x1="164" y1="103" x2="196" y2="97" />
            <line className="n3-text" x1="160" y1="106" x2="184" y2="101" />

            {/* 稿纸上立着一只锥形瓶（科研信号）*/}
            <path className="n3-paper" d="M196 72 L200 72 L200 80 L206 93 L190 93 L196 80 Z" />
            <polygon className="n3-front" points="193,89 203,89 206,93 190,93" />
            <line className="n3-text" x1="197" y1="72" x2="199" y2="72" />

            {/* 近侧两腿（亮面, 压在身前）*/}
            <rect className="n3-front" x="190" y="182" width="19" height="64" rx="8" />
            <rect className="n3-dark" x="190" y="238" width="19" height="10" rx="5" />
            <rect className="n3-front" x="96" y="184" width="19" height="62" rx="8" />
            <rect className="n3-dark" x="96" y="238" width="19" height="10" rx="5" />

            {/* 颈 */}
            <polygon className="n3-front" points="200,148 208,112 234,86 254,104 240,132 214,150" />

            {/* 马鬃：沿颈背的一排鬃毛 */}
            <polygon className="n3-mane" points="236,84 246,92 232,96" />
            <polygon className="n3-mane" points="230,96 240,104 226,108" />
            <polygon className="n3-mane" points="224,108 234,116 220,120" />
            <polygon className="n3-mane" points="218,120 228,128 214,132" />
            <polygon className="n3-mane" points="213,132 223,140 209,144" />

            {/* 牛头（朝右）*/}
            <path
              className="n3-front"
              d="M234 92 C232 74 246 64 264 64 C282 64 296 72 298 88 C300 100 292 110 276 112 C260 114 244 110 238 104 C234 100 234 96 234 92 Z"
            />
            {/* 耳 */}
            <polygon className="n3-front" points="244,74 236,60 250,66" />
            {/* 双角（骨白）*/}
            <path className="n3-horn" d="M250 66 C244 52 246 40 256 34 C254 44 254 56 260 66 Z" />
            <path className="n3-horn" d="M276 64 C286 52 300 48 308 52 C300 54 290 60 284 68 Z" />
            {/* 口鼻 + 鼻孔 + 眼 */}
            <ellipse className="n3-top" cx="286" cy="97" rx="11" ry="9" />
            <circle className="n3-nostril" cx="290" cy="99" r="1.8" />
            <circle className="n3-eye" cx="266" cy="84" r="3" />
            <circle className="n3-spark" cx="267" cy="83" r="1" />
            {/* 学究圆框眼镜（科研信号）*/}
            <circle className="n3-specs" cx="264" cy="85" r="8" />
            <circle className="n3-specs" cx="283" cy="86" r="7" />
            <line className="n3-specs" x1="272" y1="85" x2="276" y2="85" />
            <line className="n3-specs" x1="257" y1="83" x2="248" y2="79" />
          </g>
        </g>
      </svg>
    </div>
  );
}

// 顶栏「牛马」手绘 mark：窄长横幅, 一匹马 + 一头牛的侧影剪影, 点击回首页。
function NiumaMark({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      className="niuma-mark"
      onClick={onClick}
      data-testid="niuma-mark"
      aria-label="niuma-research · 返回首页"
      title="niuma-research"
    >
      <svg viewBox="0 0 150 40" className="niuma-mark-svg" role="img" aria-hidden="true">
        {/* 地面虚线 */}
        <line className="nm-ground" x1="6" y1="34.5" x2="144" y2="34.5" />
        {/* 马（左, 朝右）：圆身 + 四腿 + 上扬颈头 + 飘尾 */}
        <g className="nm-fig">
          <rect x="16" y="18" width="4" height="16" rx="1.6" />
          <rect x="22" y="19" width="3.6" height="15" rx="1.6" />
          <rect x="36" y="19" width="3.6" height="15" rx="1.6" />
          <rect x="41" y="18" width="4" height="16" rx="1.6" />
          <ellipse cx="30" cy="17" rx="15" ry="7.5" />
          <path d="M16 12 C9 14 7 22 9 31 C12 23 13 19 19 16 Z" />
          <polygon points="40,15 49,3 55,5 46,17" />
          <polygon points="51,2 64,2 67,7 63,12 55,13 49,11" />
          <polygon points="54,3 56,0 59,4.5" />
        </g>
        {/* 牛（右, 朝右）：圆身 + 四腿 + 低头 + 双角 + 尾穗 */}
        <g className="nm-fig" transform="translate(80,0)">
          <rect x="10" y="19" width="4" height="15" rx="1.6" />
          <rect x="16" y="20" width="3.6" height="14" rx="1.6" />
          <rect x="32" y="20" width="3.6" height="14" rx="1.6" />
          <rect x="38" y="19" width="4" height="15" rx="1.6" />
          <ellipse cx="24" cy="18" rx="16" ry="8" />
          <polygon points="40,16 46,16 47,10 53,10 54,16 61,17 63,22 57,27 44,26 40,21" />
          <polygon points="46,12 43,4 44.8,4 48,12" />
          <polygon points="54,12 57,4 58.8,4 56,12" />
          <polygon points="41,16 37,12.5 42,12.5" />
          <path d="M9 13 C6 19 8 27 7 33 L9.5 33 C10.5 27 9.5 20 12 15 Z" />
          <circle cx="8" cy="33" r="2" />
        </g>
      </svg>
    </button>
  );
}
