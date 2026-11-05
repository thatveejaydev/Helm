import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./style.css";

const window = getCurrentWebviewWindow();

await window.listen<{ binTreeBuilds: number; resultRenders: number }>("project-performance-updated", ({ payload }) => {
  document.getElementById("bin-tree-build-count")!.textContent = String(payload.binTreeBuilds);
  document.getElementById("result-render-count")!.textContent = String(payload.resultRenders);
});

await window.listen<{ catalog: string[]; lookup: string[]; presets: string[]; presetLoadCount: number }>("project-log-updated", ({ payload }) => {
  document.getElementById("preset-load-count")!.textContent = String(payload.presetLoadCount);
  for (const section of ["catalog", "lookup", "presets"] as const) {
    const list = document.getElementById(`${section}-log`)!;
    const scroll = list.scrollTop;
    list.replaceChildren(...payload[section].map((message) => {
      const entry = document.createElement("li");
      entry.textContent = message;
      return entry;
    }));
    list.scrollTop = scroll;
  }
});
await emitTo("palette", "project-log-ready");
