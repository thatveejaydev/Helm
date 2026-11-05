import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ApplyResult, BridgeSnapshot, CatalogItem, Preset } from "../shared/protocol";
import { indexEffects, searchEffects, type SearchEntry } from "./search";
import { captureShortcut } from "./shortcut";
import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar" data-tauri-drag-region>
    <div class="brand"><span class="brand-mark">H</span> HELM <span class="brand-description">PREMIERE PRO</span></div>
    <div class="top-actions"><span id="connection" class="connection">Connecting</span><button id="settings-toggle" class="icon-button" aria-label="Connection settings" title="Connection settings">⚙</button><button id="close" class="icon-button" aria-label="Hide palette" title="Hide palette">×</button></div>
  </header>
  <section id="palette">
    <div class="search-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><input id="search" placeholder="Find an effect or preset…" aria-label="Search Premiere effects and presets" role="combobox" aria-autocomplete="list" aria-controls="results" aria-expanded="true" autocomplete="off" spellcheck="false" /><kbd>ESC</kbd></div>
    <div class="filterbar"><div class="filters" aria-label="Result type"><button class="filter active" data-kind="all" aria-pressed="true">All</button><button class="filter" data-kind="video" aria-pressed="false">Video</button><button class="filter" data-kind="audio" aria-pressed="false">Audio</button><button class="filter" data-kind="preset" aria-pressed="false">Presets</button></div><span id="count"></span></div>
    <div id="results" role="listbox" aria-label="Effects"></div>
    <div id="empty" class="empty" hidden><span class="empty-symbol">⌕</span><h2 id="empty-title"></h2><p id="empty-message"></p><button id="setup-button" class="secondary" hidden>Connect to Premiere</button></div>
  </section>
  <section id="settings" hidden>
    <div class="section-heading"><span class="eyebrow">CONNECTION</span><h1>Meet your new shortcut.</h1><p>Connect Helm to Premiere once, then keep your hands on the keyboard.</p></div>
    <ol class="setup-steps"><li><span>1</span><div>Load the Premiere plugin<small>In UXP Developer Tools, add <strong>uxp/dist/manifest.json</strong> and click Load.</small></div></li><li><span>2</span><div>Pair the Helm panel<small>Open Window → UXP Plugins → Helm Bridge. Paste this key and select Connect.</small></div></li></ol>
    <div class="key-row"><code id="pairing-key"></code><button id="copy-key" class="secondary">Copy key</button></div>
    <div class="shortcut-row"><span>Open while editing</span><div class="shortcut-controls"><button id="record-shortcut" class="shortcut-button" type="button" aria-label="Change shortcut" title="Click to record a new shortcut"><kbd id="shortcut">Ctrl + Alt + Space</kbd></button><button id="reset-shortcut" class="shortcut-reset" type="button" aria-label="Reset to default shortcut" title="Reset to default (Ctrl + Alt + Space)">↺</button></div></div>
    <div class="settings-actions"><button id="back" class="secondary">Back to search</button><button id="refresh" class="primary">Refresh effects and presets</button></div>
  </section>
  <footer><span id="status" role="status">Ready when you are.</span><span class="key-hints"><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> apply</span></footer>
`;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const input = element<HTMLInputElement>("search");
const results = element<HTMLDivElement>("results");
let snapshot: BridgeSnapshot | undefined;
let index: SearchEntry[] = [];
let visible: CatalogItem[] = [];
let presets: Preset[] = [];
let kind: CatalogItem["kind"] | "all" = "all";
let selected = 0;
let busy = false;
let settingsOpen = false;
let composing = false;
let recordingShortcut = false;
let recent: string[] = [];
try { recent = JSON.parse(localStorage.getItem("helm-recent") || "[]").filter((id: unknown) => typeof id === "string").slice(0, 30); } catch { /* Start with an empty history if storage is unavailable. */ }

function setStatus(message: string, error = false): void {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
}

function startRecordingShortcut(): void {
  recordingShortcut = true;
  element("record-shortcut").classList.add("recording");
  element("shortcut").textContent = "Press keys…";
  setStatus("Press your desired shortcut (e.g. Ctrl + Space), or Esc to cancel.");
}

function stopRecordingShortcut(): void {
  recordingShortcut = false;
  element("record-shortcut").classList.remove("recording");
  if (snapshot) {
    element("shortcut").textContent = snapshot.shortcut.replaceAll("+", " + ");
  }
}

function openSettings(open: boolean): void {
  if (!open && recordingShortcut) stopRecordingShortcut();
  settingsOpen = open;
  element("palette").hidden = open;
  element("settings").hidden = !open;
  if (!open) input.focus();
}

function render(): void {
  visible = searchEffects(index, input.value, kind, recent, input.value.trim() ? 60 : 9);
  selected = Math.min(selected, Math.max(0, visible.length - 1));
  results.replaceChildren();
  for (const [position, effect] of visible.entries()) {
    const row = document.createElement("button");
    row.className = `effect-row${position === selected ? " selected" : ""}`;
    row.id = `effect-${position}`;
    row.role = "option";
    row.setAttribute("aria-selected", String(position === selected));
    const icon = document.createElement("span");
    icon.className = `effect-icon ${effect.kind}`;
    icon.textContent = { video: "ƒx", audio: "♫", preset: "◇" }[effect.kind];
    const name = document.createElement("span");
    name.className = "effect-name";
    name.textContent = effect.name;
    const type = document.createElement("span");
    type.className = "effect-kind";
    if (effect.kind === "preset") {
      type.textContent = effect.folders.slice(-2).join(" › ");
      type.title = `Preset · ${effect.folders.join(" › ")}`;
      row.title = `${effect.name} · ${type.title}`;
    } else {
      type.textContent = effect.kind === "video" ? "Video effect" : "Audio effect";
    }
    const enter = document.createElement("span");
    enter.className = "row-enter";
    enter.textContent = "↵";
    row.append(icon, name, type, enter);
    row.addEventListener("pointermove", () => select(position));
    row.addEventListener("click", () => void apply(effect));
    results.append(row);
  }
  input.setAttribute("aria-activedescendant", visible.length ? `effect-${selected}` : "");
  element("count").textContent = kind === "preset" ? `${presets.length} presets` : `${index.length} available`;
  element("empty").hidden = visible.length > 0;
  if (!visible.length) {
    const connected = snapshot?.connected;
    element("empty-title").textContent = index.length ? "No matching results" : connected ? "Getting your effects…" : "Connect to Premiere";
    element("empty-message").textContent = index.length ? "Try a shorter name or a different filter." : connected ? "Reading the effects installed in Premiere." : "Connect the Helm Bridge panel in Premiere to get started.";
    element("setup-button").hidden = !!connected;
  }
}

function select(position: number): void {
  selected = position;
  for (const [i, row] of Array.from(results.children).entries()) {
    row.classList.toggle("selected", i === selected);
    row.setAttribute("aria-selected", String(i === selected));
  }
  input.setAttribute("aria-activedescendant", visible.length ? `effect-${selected}` : "");
  results.children[selected]?.scrollIntoView({ block: "nearest" });
}

async function apply(effect: CatalogItem): Promise<void> {
  if (busy) return;
  if (!snapshot?.connected) { setStatus("Connect the Helm panel in Premiere first.", true); return; }
  busy = true;
  document.body.classList.add("busy");
  const isRevealPreset = effect.kind === "preset" && !effect.directApply;
  setStatus(isRevealPreset ? `Locating ${effect.name}…` : `Applying ${effect.name}…`);
  try {
    if (effect.kind === "preset") {
      const result = await invoke<ApplyResult & { revealed?: boolean }>("apply_preset", { presetId: effect.id });
      if (result?.revealed) {
        setStatus(`Located ${effect.name} in Premiere's Effects panel.`);
      } else {
        setStatus(`Applied to ${result.applied} clip${result.applied === 1 ? "" : "s"}${result.skipped ? ` · ${result.skipped} incompatible skipped` : ""}`);
        await invoke("dismiss_palette", { restoreFocus: true });
      }
    } else {
      const result = await invoke<ApplyResult>("apply_effect", { effectId: effect.id });
      setStatus(`Applied to ${result.applied} clip${result.applied === 1 ? "" : "s"}${result.skipped ? ` · ${result.skipped} incompatible skipped` : ""}`);
      await invoke("dismiss_palette", { restoreFocus: true });
    }
    recent = [effect.id, ...recent.filter((id) => id !== effect.id)].slice(0, 30);
    try { localStorage.setItem("helm-recent", JSON.stringify(recent)); } catch { /* History is optional. */ }
  } catch (error) {
    setStatus(String(error), true);
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}

function update(next: BridgeSnapshot): void {
  snapshot = next;
  rebuildIndex();
  element("connection").textContent = next.connected ? "Premiere connected" : "Premiere offline";
  element("connection").classList.toggle("online", next.connected);
  element("pairing-key").textContent = next.pairingKey;
  if (!recordingShortcut) {
    element("shortcut").textContent = next.shortcut.replaceAll("+", " + ");
  }
  element("reset-shortcut").hidden = next.shortcut === "Ctrl+Alt+Space";
  if (next.error) setStatus(next.error, true);
  else if (!busy) setStatus(next.connected ? "Select a timeline clip, find an effect, press Enter." : "Connect the Premiere panel to load your effects.");
  render();
}

function rebuildIndex(): void {
  index = indexEffects([...(snapshot?.effects ?? []), ...presets.map((preset) => ({ ...preset, kind: "preset" as const }))]);
}

async function loadPresets(refresh = false): Promise<void> {
  presets = await invoke<Preset[]>("get_presets", { refresh });
  rebuildIndex();
  render();
}

input.addEventListener("input", () => { selected = 0; render(); });
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", () => { composing = false; });
document.addEventListener("keydown", async (event) => {
  if (recordingShortcut) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecordingShortcut();
      setStatus("Shortcut change cancelled.");
      return;
    }
    const captured = captureShortcut(event);
    if (!captured) return;
    if (captured.error) {
      setStatus(captured.error, true);
      return;
    }
    if (!captured.complete) {
      element("shortcut").textContent = captured.display;
      return;
    }
    stopRecordingShortcut();
    setStatus(`Registering ${captured.display}…`);
    try {
      const registered = await invoke<string>("set_shortcut", { shortcut: captured.accelerator });
      setStatus(`Shortcut updated to ${registered.replaceAll("+", " + ")}.`);
    } catch (error) {
      setStatus(String(error), true);
    }
    return;
  }

  if (event.isComposing || composing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (settingsOpen) openSettings(false);
    else if (!busy) void invoke("dismiss_palette", { restoreFocus: true });
  }
  if (settingsOpen || busy) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (visible.length) select((selected + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length);
  }
  if (event.key === "Enter" && event.target === input && visible[selected]) {
    event.preventDefault();
    void apply(visible[selected]);
  }
});

for (const filter of document.querySelectorAll<HTMLButtonElement>("[data-kind]")) {
  filter.addEventListener("click", () => {
    kind = filter.dataset.kind as CatalogItem["kind"] | "all";
    for (const button of document.querySelectorAll("[data-kind]")) {
      button.classList.toggle("active", button === filter);
      button.setAttribute("aria-pressed", String(button === filter));
    }
    selected = 0;
    render();
    if (kind === "preset") setStatus("Select a preset to locate it in Premiere's Effects panel.");
    input.focus();
  });
}

element("settings-toggle").addEventListener("click", () => openSettings(!settingsOpen));
element("setup-button").addEventListener("click", () => openSettings(true));
element("back").addEventListener("click", () => openSettings(false));
element("close").addEventListener("click", () => { if (!busy) void invoke("dismiss_palette", { restoreFocus: true }); });
element("copy-key").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(snapshot?.pairingKey || "");
    element("copy-key").textContent = "Copied";
    setTimeout(() => { element("copy-key").textContent = "Copy key"; }, 1500);
  } catch { setStatus("Select and copy the pairing key manually.", true); }
});
element("record-shortcut").addEventListener("click", () => {
  if (recordingShortcut) {
    stopRecordingShortcut();
    setStatus("Shortcut change cancelled.");
  } else {
    startRecordingShortcut();
  }
});
element("reset-shortcut").addEventListener("click", async () => {
  if (recordingShortcut) stopRecordingShortcut();
  setStatus("Resetting shortcut to default…");
  try {
    const registered = await invoke<string>("reset_shortcut");
    setStatus(`Shortcut reset to default (${registered.replaceAll("+", " + ")}).`);
  } catch (error) {
    setStatus(String(error), true);
  }
});
element("refresh").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setStatus("Refreshing Premiere effects and presets…");
  try {
    await loadPresets(true);
    if (snapshot?.connected) await invoke("refresh_catalog");
    setStatus(`Catalog refreshed · ${presets.length} presets.`);
  }
  catch (error) { setStatus(String(error), true); }
  finally { busy = false; }
});

async function start(): Promise<void> {
  await listen<BridgeSnapshot>("bridge-changed", ({ payload }) => update(payload));
  await listen("palette-opened", () => {
    if (busy) return;
    input.value = "";
    selected = 0;
    openSettings(false);
    render();
    input.focus();
    void loadPresets().catch((error) => setStatus(String(error), true));
  });
  window.addEventListener("blur", () => {
    if (recordingShortcut) stopRecordingShortcut();
  });
  update(await invoke<BridgeSnapshot>("get_snapshot"));
  input.focus();
  await loadPresets();
}

void start().catch((error) => setStatus(`Could not initialize Helm: ${error}`, true));
