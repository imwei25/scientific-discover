// 视觉模型(VLM)配置区: 用于「学术海报」的排版审阅(看渲染出的海报图找排版问题)。
// 主文本模型(如 DeepSeek)没有视觉能力, 需单独配一个多模态模型(硅基流动 GLM-4.5V / Qwen-VL 等)。
// 内嵌在设置向导里, 自成一体: 填 key/模型/地址 → 测试 → 保存(/api/config/save-vlm)。

import { useEffect, useState } from "react";
import { apiUrl } from "../lib/api";

type TestStatus = "idle" | "testing" | "ok" | "fail";

// 硅基流动上可用的多模态模型建议(第一个为默认)。
const VLM_MODEL_SUGGESTIONS = [
  "THUDM/GLM-4.1V-9B-Thinking",
  "zai-org/GLM-4.5V",
  "Qwen/Qwen2.5-VL-72B-Instruct",
  "Qwen/Qwen2.5-VL-32B-Instruct",
];
const DEFAULT_VLM_BASE = "https://api.siliconflow.cn/v1";

export default function VlmSettings() {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(VLM_MODEL_SUGGESTIONS[0]);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_VLM_BASE);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMsg, setTestMsg] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // 拉当前是否已配置 VLM(展示"当前: xxx")
  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((r) => r.json())
      .then((d) => setCurrentModel(d?.vlm_configured ? (d.vlm_model || "已配置") : null))
      .catch(() => setCurrentModel(null));
  }, []);

  const refreshHealth = () => {
    const fn = (window as unknown as { __refreshHealth?: () => void }).__refreshHealth;
    if (fn) fn();
  };

  const doTest = async () => {
    if (!key.trim()) {
      setTestStatus("fail");
      setTestMsg("请先粘贴视觉模型的 API key");
      return;
    }
    setTestStatus("testing");
    setTestMsg("正在测试连接…");
    try {
      const resp = await fetch(apiUrl("/api/config/test-key"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "siliconflow",
          key: key.trim(),
          base_url: baseUrl.trim() || undefined,
          model: model.trim() || undefined,
        }),
      });
      const data = await resp.json();
      setTestStatus(data.ok ? "ok" : "fail");
      setTestMsg(data.msg || (data.ok ? "连接成功" : "测试失败"));
    } catch (e) {
      setTestStatus("fail");
      setTestMsg(`测试出错: ${(e as Error).message}`);
    }
  };

  const doSave = async () => {
    if (!key.trim()) {
      setSaveMsg("请先填写 API key");
      return;
    }
    setBusy(true);
    setSaveMsg("");
    try {
      const resp = await fetch(apiUrl("/api/config/save-vlm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "siliconflow",
          key: key.trim(),
          base_url: baseUrl.trim() || undefined,
          model: model.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        setSaveMsg("✓ 已保存视觉模型配置，「学术海报」现在可以做排版审阅了。");
        setCurrentModel(model.trim() || "已配置");
        refreshHealth();
      } else {
        setSaveMsg(`保存失败: ${data.error || "未知错误"}`);
      }
    } catch (e) {
      setSaveMsg(`保存出错: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doClear = async () => {
    setBusy(true);
    setSaveMsg("");
    try {
      const resp = await fetch(apiUrl("/api/config/save-vlm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "siliconflow", key: "" }),
      });
      const data = await resp.json();
      if (data.ok) {
        setSaveMsg("已清除视觉模型配置（停用海报排版审阅）。");
        setCurrentModel(null);
        setKey("");
        refreshHealth();
      } else {
        setSaveMsg(`清除失败: ${data.error || "未知错误"}`);
      }
    } catch (e) {
      setSaveMsg(`清除出错: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="onboarding-advanced vlm-settings" data-testid="vlm-settings">
      <summary>🖼 视觉模型（可选）· 用于「学术海报」排版审阅</summary>
      <p className="vlm-hint">
        主模型（如 DeepSeek）只有文字能力，看不了图。配一个<strong>多模态模型</strong>（如硅基流动的
        GLM-4.5V / Qwen-VL），海报生成后就能让 AI「看」渲染效果、指出并修复排版问题。
        {currentModel && <span className="vlm-current" data-testid="vlm-current"> 当前已配置：{currentModel}</span>}
      </p>

      <div className="vlm-field">
        <label>API key（多模态模型）</label>
        <input
          data-testid="vlm-key-input"
          value={key}
          onChange={(e) => { setKey(e.target.value); setTestStatus("idle"); setTestMsg(""); }}
          placeholder="sk-..."
          spellCheck={false}
        />
      </div>

      <div className="vlm-field">
        <label>模型</label>
        <div className="onboarding-model-chips">
          {VLM_MODEL_SUGGESTIONS.map((m) => (
            <button
              key={m}
              type="button"
              className={`onboarding-model-chip${model.trim() === m ? " on" : ""}`}
              onClick={() => { setModel(m); setTestStatus("idle"); }}
              data-testid={`vlm-model-chip-${m}`}
            >
              {m}
            </button>
          ))}
        </div>
        <input
          data-testid="vlm-model-input"
          value={model}
          onChange={(e) => { setModel(e.target.value); setTestStatus("idle"); }}
          placeholder={VLM_MODEL_SUGGESTIONS[0]}
          spellCheck={false}
        />
      </div>

      <div className="vlm-field">
        <label>base_url（默认硅基流动）</label>
        <input
          data-testid="vlm-baseurl-input"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={DEFAULT_VLM_BASE}
          spellCheck={false}
        />
      </div>

      <div className="onboarding-actions">
        <button className="onboarding-btn-secondary" onClick={doTest} disabled={testStatus === "testing" || busy} data-testid="vlm-test">
          {testStatus === "testing" ? "测试中…" : "测试连接"}
        </button>
        <button className="onboarding-btn-primary" onClick={doSave} disabled={busy} data-testid="vlm-save">
          {busy ? "保存中…" : "保存"}
        </button>
        {currentModel && (
          <button className="onboarding-btn-secondary" onClick={doClear} disabled={busy} data-testid="vlm-clear">
            清除
          </button>
        )}
      </div>

      {testStatus !== "idle" && (
        <div className={`onboarding-test-msg test-${testStatus}`} data-testid="vlm-test-msg">
          {testStatus === "ok" && "✓ "}
          {testStatus === "fail" && "✗ "}
          {testMsg}
        </div>
      )}
      {saveMsg && <div className="vlm-save-msg" data-testid="vlm-save-msg">{saveMsg}</div>}
    </details>
  );
}
