// W2-1 首次配置向导
// 全屏覆盖式弹窗, 在 /api/health 返回 configured=false 且 localStorage 无 onboarding:done 时弹出。
// 步骤: 选供应商 → 粘 key + 测试 → 保存 → 标记完成 + 刷新页面。
// 演示模式跳过测试与 key 输入, 直接 save(mock=true)。

import { useState } from "react";
import { apiUrl } from "../lib/api";

export type WizardProvider =
  | "deepseek"
  | "siliconflow"
  | "openai"
  | "anthropic"
  | "mock";

interface ProviderCard {
  id: WizardProvider;
  title: string;
  tag: string;
  desc: string;
}

const PROVIDERS: ProviderCard[] = [
  { id: "deepseek", title: "DeepSeek", tag: "推荐", desc: "便宜好用 · 国内可直接访问 · 无需梯子" },
  { id: "siliconflow", title: "硅基流动", tag: "推荐", desc: "模型选择多 · 国内可直接访问" },
  { id: "openai", title: "OpenAI", tag: "需要梯子", desc: "GPT-4o 系列 · 海外服务" },
  { id: "anthropic", title: "Claude (Anthropic)", tag: "需要梯子", desc: "Claude 3.5 Sonnet · 海外服务" },
  { id: "mock", title: "演示模式", tag: "试用", desc: "用假数据试一遍流程 · 不消耗 API 额度" },
];

type Step = "pick" | "key" | "saving" | "done";

type TestStatus = "idle" | "testing" | "ok" | "fail";

export interface OnboardingWizardProps {
  /** 完成后回调; 父组件应清理 onboarding 状态或重新 fetch health。 */
  onClose: () => void;
}

export default function OnboardingWizard({ onClose }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("pick");
  const [provider, setProvider] = useState<WizardProvider | null>(null);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");  // 选填, 留空用预设
  const [model, setModel] = useState("");  // 选填, 留空用该 provider 预设默认 model
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMsg, setTestMsg] = useState("");
  const [saveErr, setSaveErr] = useState("");

  const pick = (p: WizardProvider) => {
    setProvider(p);
    setTestStatus("idle");
    setTestMsg("");
    if (p === "mock") {
      // 演示模式跳过 key 直接 save
      doSave(p, "", "", "");
    } else {
      // 预填该 provider 的推荐默认 model, 用户可改选/自填
      setModel(defaultModel(p));
      setStep("key");
    }
  };

  const doTest = async () => {
    if (!provider || provider === "mock") return;
    if (!key.trim()) {
      setTestStatus("fail");
      setTestMsg("请先粘贴 API key");
      return;
    }
    setTestStatus("testing");
    setTestMsg("正在测试连接 …");
    try {
      const resp = await fetch(apiUrl("/api/config/test-key"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          key: key.trim(),
          base_url: baseUrl.trim() || undefined,
          model: model.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        setTestStatus("ok");
        setTestMsg(data.msg || "连接成功");
      } else {
        setTestStatus("fail");
        setTestMsg(data.msg || "测试失败");
      }
    } catch (e) {
      setTestStatus("fail");
      setTestMsg(`测试出错: ${(e as Error).message}`);
    }
  };

  const doSave = async (p: WizardProvider, k: string, b: string, m: string) => {
    setStep("saving");
    setSaveErr("");
    try {
      const resp = await fetch(apiUrl("/api/config/save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: p,
          key: k.trim(),
          base_url: b.trim() || undefined,
          model: m.trim() || undefined,
          mock: p === "mock",
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        // 标记完成
        try {
          localStorage.setItem("onboarding:done", "1");
        } catch {
          /* 配额溢出忽略 */
        }
        setStep("done");
        // 给用户一秒看到"成功"反馈再刷新, 避免页面瞬切让人困惑
        setTimeout(() => {
          onClose();
        }, 600);
      } else {
        setSaveErr(data.error || "保存失败");
        // 退回到 key 输入步骤(或 mock 直接退回 pick)
        setStep(p === "mock" ? "pick" : "key");
      }
    } catch (e) {
      setSaveErr(`保存出错: ${(e as Error).message}`);
      setStep(p === "mock" ? "pick" : "key");
    }
  };

  const onSubmitKey = () => {
    if (!provider || provider === "mock") return;
    if (testStatus !== "ok") {
      // 强制先测一下
      doTest();
      return;
    }
    doSave(provider, key, baseUrl, model);
  };

  const back = () => {
    setStep("pick");
    setProvider(null);
    setKey("");
    setBaseUrl("");
    setModel("");
    setTestStatus("idle");
    setTestMsg("");
    setSaveErr("");
  };

  return (
    <div className="onboarding-overlay" data-testid="onboarding-wizard">
      <div className="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <button
          className="onboarding-close"
          onClick={() => {
            // 标记已处理, 否则未配置时父组件刷新 health 会立刻把向导又弹回来。
            try { localStorage.setItem("onboarding:done", "1"); } catch { /* 配额溢出忽略 */ }
            onClose();
          }}
          aria-label="关闭"
          title="关闭"
          data-testid="onboarding-close"
        >
          ×
        </button>
        <h1 id="onboarding-title" className="onboarding-title">
          欢迎使用科研助手 · 先做一个 1 分钟配置
        </h1>
        <p className="onboarding-sub">
          所有数据都在你的电脑本地处理; AI 调用走你自己的 API key, 不经我们服务器。
        </p>

        {step === "pick" && (
          <div className="onboarding-providers" data-testid="onboarding-step-pick">
            <div className="onboarding-step-hint">第 1 步 · 选一个 AI 供应商</div>
            <div className="onboarding-grid">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className="onboarding-card"
                  onClick={() => pick(p.id)}
                  data-testid={`onboarding-provider-${p.id}`}
                >
                  <div className="onboarding-card-head">
                    <span className="onboarding-card-title">{p.title}</span>
                    <span className={`onboarding-card-tag tag-${p.id}`}>{p.tag}</span>
                  </div>
                  <div className="onboarding-card-desc">{p.desc}</div>
                </button>
              ))}
            </div>
            {saveErr && <div className="onboarding-error" data-testid="onboarding-save-err">{saveErr}</div>}
          </div>
        )}

        {step === "key" && provider && provider !== "mock" && (
          <div className="onboarding-keyform" data-testid="onboarding-step-key">
            <div className="onboarding-step-hint">第 2 步 · 粘贴你的 {labelOf(provider)} API key</div>
            <textarea
              className="onboarding-keyinput"
              data-testid="onboarding-key-input"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setTestStatus("idle");
                setTestMsg("");
              }}
              placeholder={placeholderOf(provider)}
              rows={3}
              spellCheck={false}
              autoFocus
            />

            <div className="onboarding-model" data-testid="onboarding-model">
              <div className="onboarding-model-label">
                模型（可改选或自填 · 留空用默认 {defaultModel(provider)}）
              </div>
              {modelSuggestions(provider).length > 0 && (
                <div className="onboarding-model-chips">
                  {modelSuggestions(provider).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`onboarding-model-chip${model.trim() === m ? " on" : ""}`}
                      onClick={() => {
                        setModel(m);
                        setTestStatus("idle");
                        setTestMsg("");
                      }}
                      data-testid={`onboarding-model-chip-${m}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="onboarding-input"
                data-testid="onboarding-model-input"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setTestStatus("idle");
                  setTestMsg("");
                }}
                placeholder={`默认: ${defaultModel(provider)}`}
                spellCheck={false}
              />
            </div>

            <details className="onboarding-advanced">
              <summary>高级 · 自定义 base_url(选填)</summary>
              <input
                className="onboarding-input"
                data-testid="onboarding-baseurl-input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={`留空使用默认: ${defaultBaseUrl(provider)}`}
              />
            </details>

            <div className="onboarding-actions">
              <button
                className="onboarding-btn-secondary"
                onClick={back}
                data-testid="onboarding-back"
              >
                ← 重选供应商
              </button>
              <button
                className="onboarding-btn-secondary"
                onClick={doTest}
                disabled={testStatus === "testing"}
                data-testid="onboarding-test"
              >
                {testStatus === "testing" ? "测试中…" : "测试连接"}
              </button>
              <button
                className="onboarding-btn-primary"
                onClick={onSubmitKey}
                disabled={testStatus !== "ok"}
                data-testid="onboarding-save"
                title={testStatus !== "ok" ? "请先测试连接成功后再保存" : ""}
              >
                保存并开始
              </button>
            </div>

            {testStatus !== "idle" && (
              <div
                className={`onboarding-test-msg test-${testStatus}`}
                data-testid="onboarding-test-msg"
              >
                {testStatus === "ok" && "✓ "}
                {testStatus === "fail" && "✗ "}
                {testMsg}
              </div>
            )}
            {saveErr && <div className="onboarding-error">{saveErr}</div>}
          </div>
        )}

        {step === "saving" && (
          <div className="onboarding-saving" data-testid="onboarding-step-saving">
            正在保存配置 …
          </div>
        )}

        {step === "done" && (
          <div className="onboarding-done" data-testid="onboarding-step-done">
            ✓ 配置完成, 即将进入工作台 …
          </div>
        )}
      </div>
    </div>
  );
}

function labelOf(p: WizardProvider): string {
  switch (p) {
    case "deepseek":
      return "DeepSeek";
    case "siliconflow":
      return "硅基流动";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic Claude";
    default:
      return p;
  }
}

function placeholderOf(p: WizardProvider): string {
  switch (p) {
    case "anthropic":
      return "sk-ant-...";
    case "openai":
      return "sk-...";
    case "deepseek":
      return "sk-...";
    case "siliconflow":
      return "sk-...";
    default:
      return "";
  }
}

function defaultBaseUrl(p: WizardProvider): string {
  switch (p) {
    case "deepseek":
      return "https://api.deepseek.com";
    case "siliconflow":
      return "https://api.siliconflow.cn/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    default:
      return "";
  }
}

// 各 provider 的常用模型建议(第一个即默认); 与后端 PROVIDER_PRESETS 默认保持一致。
// 留空传给后端时后端仍会用预设默认, 这里只是给用户快捷选项。
const MODEL_SUGGESTIONS: Record<WizardProvider, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  siliconflow: [
    "deepseek-ai/DeepSeek-V3",
    "deepseek-ai/DeepSeek-R1",
    "Qwen/Qwen2.5-72B-Instruct",
  ],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  mock: [],
};

function modelSuggestions(p: WizardProvider): string[] {
  return MODEL_SUGGESTIONS[p] ?? [];
}

function defaultModel(p: WizardProvider): string {
  return MODEL_SUGGESTIONS[p]?.[0] ?? "";
}
