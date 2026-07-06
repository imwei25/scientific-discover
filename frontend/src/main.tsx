import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { ProjectProvider } from "./lib/projects";
import { initApiBase } from "./lib/api";

// 桌面版先向外壳问到 sidecar 端口再渲染, 保证首个健康检查/请求就打对端口。
// 非 Tauri 时 initApiBase 立即返回, 不增加启动延迟。
initApiBase().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ProjectProvider>
        <App />
      </ProjectProvider>
    </React.StrictMode>,
  );
});
