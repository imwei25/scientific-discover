import { useEffect, useRef } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";

export default function PlanModule() {
  const [idea, setIdea] = usePersistentState("plan:idea", "");
  const [field, setField] = usePersistentState("plan:field", "");
  const [resources, setResources] = usePersistentState("plan:resources", "");
  const { text, running, error, start, stop, setText } = useStream("plan:result");

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "plan",
        icon: "🗺️",
        title: idea.slice(0, 40) || "实验规划",
        data: { "plan:idea": idea, "plan:field": field, "plan:resources": resources, "plan:result": text },
      });
    }
  }, [running, text, idea, field, resources]);

  const submit = () => {
    if (!idea.trim() || running) return;
    start("plan", { idea, field, resources });
  };

  const reset = () => {
    if (running) stop();
    setIdea("");
    setField("");
    setResources("");
    setText("");
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>🗺️ 实验规划 · 医学/药学/生物</h1>
        <p>把研究想法变成符合生物医学规范的方案：研究设计、入排标准、样本量与检验效能、统计计划、伦理合规、时间表。</p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">你的研究想法 / 课题 <em>必填</em></span>
          <textarea
            data-testid="input-idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="例如：评估二甲双胍辅助治疗对2型糖尿病合并NAFLD患者肝纤维化的改善作用"
            rows={4}
          />
        </label>
        <label className="field">
          <span className="field-label">学科领域（可选）</span>
          <input
            data-testid="input-field"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="例如：材料化学、临床医学、社会学"
          />
        </label>
        <label className="field">
          <span className="field-label">可用资源 / 条件（可选）</span>
          <textarea
            data-testid="input-resources"
            value={resources}
            onChange={(e) => setResources(e.target.value)}
            placeholder="例如：经费、设备、样本量、时间、团队规模等限制"
            rows={3}
          />
        </label>
        <Dropzone
          testId="upload-doc"
          accept=".docx,.pdf,.txt,.md,.csv,.xlsx,.xls"
          label="附加文档（可选：已有草案/方案/预实验数据）"
          hint="支持 Word/PDF/Excel/CSV/txt；内容会作为补充资料"
          mode="text"
          onText={(t, name) =>
            setResources((prev) => (prev ? prev + "\n\n" : "") + `[附加文档：${name}]\n` + t)
          }
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={!idea.trim() || running} data-testid="run-btn">
            {running ? "生成中…" : "生成实验计划"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      <ResultPanel
        text={text}
        running={running}
        error={error}
        onStop={stop}
        exportName="实验计划"
        placeholder="研究路线、实验设计、里程碑和风险点会显示在这里。"
      />
    </div>
  );
}
