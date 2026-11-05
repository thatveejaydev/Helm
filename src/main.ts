import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ApplyResult, BridgeSnapshot, CatalogItem, Preset, ProjectMedia, ProjectMediaCatalog, SequenceMarker } from "../shared/protocol";
import { indexEffects, indexProjectMedia, mergeSearchResults, normalize, rankEffects, rankProjectMedia, score, type SearchEntry } from "./search";
import { captureShortcut } from "./shortcut";
import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <section id="palette">
    <div class="search-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><input id="search" placeholder="Search effects, project media, and commands…" aria-label="Search effects, project media, and commands" role="combobox" aria-autocomplete="list" aria-controls="results" aria-expanded="true" autocomplete="off" spellcheck="false" /><kbd>ESC</kbd></div>
    <div class="search-modes" role="group" aria-label="Search mode">
      <button id="all-mode" type="button" aria-pressed="true">All</button>
      <button id="effects-mode" type="button" aria-pressed="false">Effects</button>
      <button id="project-mode" type="button" aria-pressed="false" title="Press Tab from an empty search to switch modes, or type project:">Project</button>
      <button id="commands-mode" type="button" aria-pressed="false">Commands</button>
      <span id="insert-hint" hidden>Enter inserts · Shift+Enter opens item · v2: a2: prefers tracks</span>
    </div>
    <div id="results" role="listbox" aria-label="Palette results"></div>
    <div id="empty" class="empty" hidden><span class="empty-symbol">⌕</span><h2 id="empty-title"></h2><p id="empty-message"></p><button id="setup-button" class="secondary" hidden>Connect to Premiere</button></div>
  </section>
  <section id="settings" hidden>
    <div class="section-heading"><span class="eyebrow">CONNECTION</span><h1>Meet your new shortcut.</h1><p>Connect Helm to Premiere once, then keep your hands on the keyboard.</p></div>
    <ol class="setup-steps"><li><span>1</span><div>Load the Premiere plugin<small>In UXP Developer Tools, add <strong>uxp/dist/manifest.json</strong> and click Load.</small></div></li><li><span>2</span><div>Pair the Helm panel<small>Open Window → UXP Plugins → Helm Bridge. Paste this key and select Connect.</small></div></li></ol>
    <div class="key-row"><code id="pairing-key"></code><button id="copy-key" class="secondary">Copy key</button></div>
    <div class="shortcut-row"><span>Open while editing</span><div class="shortcut-controls"><button id="record-shortcut" class="shortcut-button" type="button" aria-label="Change shortcut" title="Click to record a new shortcut"><kbd id="shortcut">Ctrl + Alt + Space</kbd></button><button id="reset-shortcut" class="shortcut-reset" type="button" aria-label="Reset to default shortcut" title="Reset to default (Ctrl + Alt + Space)">↺</button></div></div>
    <div class="settings-actions"><button id="back" class="secondary">Back to search</button><button id="refresh" class="primary">Refresh effects and presets</button></div>
  </section>
  <footer data-tauri-drag-region>
    <div class="brand"><span class="brand-mark">H</span> HELM</div>
    <div class="footer-info"><span id="status" role="status">Ready when you are.</span></div>
    <div class="footer-actions"><span id="connection" class="connection">Connecting</span><button id="settings-toggle" class="icon-button" aria-label="Connection settings" title="Connection settings">⚙</button></div>
  </footer>
`;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const input = element<HTMLInputElement>("search");
const results = element<HTMLDivElement>("results");
let snapshot: BridgeSnapshot | undefined;
let index: SearchEntry[] = [];
interface CommandItem {
  kind: "command";
  id: string;
  name: string;
  description: string;
  argument?: string;
  value?: string;
}

const commands: CommandItem[] = [
  { kind: "command", id: "copy-attributes", name: "Copy Attributes", description: "Copy source clip in Premiere" },
  { kind: "command", id: "paste-attributes", name: "Paste Attributes", description: "Open Premiere’s paste dialog" },
  { kind: "command", id: "remove-attributes", name: "Remove Attributes", description: "Clear applied effects" },
  { kind: "command", id: "add-marker", name: "Add Marker", description: "Add a marker at the playhead", argument: "Marker name" },
  { kind: "command", id: "go-to-marker", name: "Go to Marker", description: "Find a marker in the active sequence" },
  { kind: "command", id: "set-opacity", name: "Set Opacity", description: "Set static clip opacity", argument: "Opacity (0–100%)" },
  { kind: "command", id: "set-volume", name: "Set Clip Volume", description: "Set static clip volume", argument: "Volume (−100 to +15 dB)" },
];
type PaletteItem = CatalogItem | CommandItem | (ProjectMedia & { kind: "project"; projectId: string });
let visible: PaletteItem[] = [];
const searchModes = ["all", "effects", "project", "commands"] as const;
type SearchMode = typeof searchModes[number];
let searchMode: SearchMode = "all";
let projectId: string | undefined;
let projectIndex: ReturnType<typeof indexProjectMedia> = [];
let projectLoading = false;
let projectError = "";
let presets: Preset[] = [];
let markers: SequenceMarker[] | undefined;
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

function matchingCommands(query: string): CommandItem[] {
  const search = normalize(query);
  if (markers && (search === "go to marker" || search.startsWith("go to marker "))) {
    const filter = search.slice("go to marker".length).trim();
    return markers.filter((marker) => normalize(marker.name).includes(filter)).slice(0, 60).map((marker) => {
      const milliseconds = Math.max(0, Math.floor(marker.seconds * 1000));
      const seconds = Math.floor(milliseconds / 1000);
      const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map((part) => String(part).padStart(2, "0")).join(":") +
        "." + String(milliseconds % 1000).padStart(3, "0");
      return { kind: "command", id: "go-to-marker", name: marker.name || "Untitled marker", description: time, value: marker.id };
    });
  }
  return commands.flatMap((command) => {
    const name = normalize(command.name);
    const aliases = command.id === "set-opacity" ? [name, "opacity"] :
      command.id === "set-volume" ? [name, "set volume", "volume"] : [name];
    const prefix = aliases.find((alias) => search.startsWith(alias + " "));
    if (prefix && (command.argument || command.id === "go-to-marker")) {
      const value = query.trim().slice(prefix.length).trim();
      return [{ ...command, value, name: `${command.name} · ${value}` }];
    }
    return aliases.some((alias) => search.split(/\s+/).every((word) => alias.includes(word))) ? [command] : [];
  });
}

function projectQuery(query: string) {
  let search = query.trimStart();
  const tracks: { videoTrack?: number; audioTrack?: number } = {};
  for (const match of query.trimStart().matchAll(/([va])([1-9]\d*):\s*/gi)) {
    if (match.index !== query.trimStart().length - search.length) break;
    tracks[match[1].toLowerCase() === "v" ? "videoTrack" : "audioTrack"] = Number(match[2]);
    search = search.slice(match[0].length);
  }
  return { search, tracks };
}

function render(): void {
  const query = input.value;
  const currentProject = projectId;
  const limit = query.trim() ? 60 : 9;
  const projectResults = (searchMode === "all" || searchMode === "project") && currentProject !== undefined
    ? rankProjectMedia(projectIndex, projectQuery(query).search, limit)
      .map(({ item, rank }) => ({ item: { ...item, kind: "project" as const, projectId: currentProject }, rank })) : [];
  const effectResults = searchMode === "all" || searchMode === "effects"
    ? rankEffects(index, query, "all", recent, limit) : [];
  const commandResults = searchMode === "all" || searchMode === "commands" ? matchingCommands(query) : [];
  if (searchMode === "all") {
    const markerSearch = markers && /^go to marker(?:\s|$)/i.test(query.trimStart());
    const normalizedQuery = normalize(query);
    const rankedCommands = commandResults.map((item) => {
      const normalized = normalize(item.name);
      const rank = item.value !== undefined ? -1 : Math.min(80, score({
        normalized, words: normalized.split(/\s+/), folderSearch: "",
      }, normalizedQuery));
      return { item, rank };
    });
    visible = markerSearch ? commandResults :
      mergeSearchResults<PaletteItem>([effectResults, projectResults, rankedCommands], query, limit);
  } else {
    visible = [...effectResults.map(({ item }) => item), ...projectResults.map(({ item }) => item), ...commandResults];
  }
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
    icon.textContent = { video: "ƒx", audio: "♫", preset: "◇", command: "⌘", project: "▤" }[effect.kind];
    if (effect.kind === "project") {
      const mediaType = effect.mediaType ?? "other";
      icon.classList.add(`media-${mediaType}`);
      icon.textContent = { video: "▶", audio: "♫", image: "▧", generated: "◈", sequence: "▣", other: "▤" }[mediaType];
      icon.title = { video: "Video", audio: "Audio", image: "Image", generated: "Generated media", sequence: "Sequence", other: "Project media" }[mediaType];
    }
    const name = document.createElement("span");
    name.className = "effect-name";
    name.textContent = effect.name;
    const type = document.createElement("span");
    type.className = "effect-kind";
    if (effect.kind === "preset") {
      type.textContent = effect.folders.slice(-2).join(" › ");
      type.title = `Preset · ${effect.folders.join(" › ")}`;
      row.title = `${effect.name} · ${type.title}`;
    } else if (effect.kind === "project") {
      type.textContent = effect.bins.join(" › ") || "Project root";
      if (effect.mediaType === "sequence") type.textContent = `Sequence · ${type.textContent}`;
      row.title = `${type.textContent} › ${effect.name}`;
    } else if (effect.kind === "command") {
      type.textContent = effect.description;
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
  element("empty").hidden = visible.length > 0;
  if (!visible.length) {
    const connected = snapshot?.connected;
    const noMatches = searchMode === "commands" || index.length;
    element("empty-title").textContent = noMatches ? "No matching results" : connected ? "Getting your effects…" : "Connect to Premiere";
    element("empty-message").textContent = noMatches ? "Try a shorter name." : connected ? "Reading the effects installed in Premiere." : "Connect the Helm Bridge panel in Premiere to get started.";
    element("setup-button").hidden = !!connected;
    if (searchMode === "project" && connected) {
      element("empty-title").textContent = projectLoading ? "Reading project media…" :
        projectError ? "Project search unavailable" : projectIndex.length ? "No matching media" : "No imported media found";
      element("empty-message").textContent = projectError || (projectIndex.length ? "Try a clip name or bin path." : "");
    }
  }
}

async function loadProjectMedia(): Promise<void> {
  if (!snapshot?.connected || projectLoading) return;
  projectLoading = true;
  projectId = undefined;
  projectIndex = [];
  projectError = "";
  render();
  try {
    const catalog = await invoke<ProjectMediaCatalog>("run_palette_command", { action: "list-project-media" });
    if (snapshot?.connected) {
      projectId = catalog.projectId;
      projectIndex = indexProjectMedia(catalog.items);
    }
  } catch (error) {
    projectError = String(error);
  } finally {
    projectLoading = false;
    render();
  }
}

function setSearchMode(mode: SearchMode): void {
  searchMode = mode;
  selected = 0;
  markers = undefined;
  input.placeholder = { all: "Search effects, project media, and commands…", effects: "Find an effect or preset…", project: "Find imported media by name or bin…", commands: "Find a command…" }[mode];
  input.setAttribute("aria-label", input.placeholder);
  for (const option of searchModes) {
    element(`${option}-mode`).setAttribute("aria-pressed", String(option === mode));
  }
  element("insert-hint").hidden = mode !== "project";
  render();
  if (mode === "project" || mode === "all") void loadProjectMedia();
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

async function runCommand(command: CommandItem): Promise<void> {
  const invokeCommand = (action: string, value?: string | number) =>
    invoke<{ message?: string; markers?: SequenceMarker[]; native?: boolean }>("run_palette_command", { action, value });
  if (command.id === "go-to-marker" && !markers) {
    const result = await invokeCommand("list-markers");
    markers = result.markers ?? [];
    input.value = command.value ? `Go to Marker ${command.value}` : "Go to Marker ";
    selected = 0;
    render();
    input.focus();
    setStatus(markers.length ? "Type a marker name, then press Enter to jump." : "This sequence has no markers.");
    return;
  }
  if (command.argument && !command.value) {
    input.value = command.name + " ";
    input.focus();
    setStatus(command.argument);
    return;
  }
  let value: string | number | undefined = command.value;
  if (command.id === "set-opacity" || command.id === "set-volume") {
    const opacity = command.id === "set-opacity";
    const number = value?.replace(opacity ? /\s*%$/ : /\s*dB$/i, "").trim() ?? "";
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(number)) throw new Error(`Enter a numeric value. ${command.argument}.`);
    value = Number(number);
  }
  const result = await invokeCommand(command.id, value);
  setStatus(result.message ?? "Done.");
  if (!result.native) await invoke("dismiss_palette", { restoreFocus: true });
}

async function apply(effect: PaletteItem, openSource = false): Promise<void> {
  if (busy) return;
  if (!snapshot?.connected) { setStatus("Connect the Helm panel in Premiere first.", true); return; }
  busy = true;
  document.body.classList.add("busy");
  const isRevealPreset = effect.kind === "preset" && !effect.directApply;
  setStatus(effect.kind === "project" ? `${openSource ? "Opening" : "Inserting"} ${effect.name}…` :
    isRevealPreset ? `Locating ${effect.name}…` : `Applying ${effect.name}…`);
  try {
    if (effect.kind === "project") {
      const result = await invoke<{ message: string }>("run_palette_command", {
        action: openSource ? "open-project-source" : "insert-project-media",
        value: { projectId: effect.projectId, id: effect.id, ...projectQuery(input.value).tracks },
      });
      setStatus(result.message);
      await invoke("dismiss_palette", { restoreFocus: true });
      return;
    }
    if (effect.kind === "command") {
      await runCommand(effect);
      return;
    }
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
  const wasConnected = snapshot?.connected;
  snapshot = next;
  if (!next.connected) {
    projectId = undefined;
    projectIndex = [];
  }
  rebuildIndex();
  element("connection").textContent = next.connected ? "Premiere connected" : "Premiere offline";
  element("connection").classList.toggle("online", next.connected);
  element("pairing-key").textContent = next.pairingKey;
  if (!recordingShortcut) {
    element("shortcut").textContent = next.shortcut.replaceAll("+", " + ");
  }
  element("reset-shortcut").hidden = next.shortcut === "Ctrl+Alt+Space";
  if (next.error) setStatus(next.error, true);
  else if (!busy) setStatus(next.connected ? "" : "Connect the Premiere panel to load your effects.");
  render();
  if ((searchMode === "project" || searchMode === "all") && next.connected && !wasConnected) void loadProjectMedia();
}

function rebuildIndex(): void {
  index = indexEffects([...(snapshot?.effects ?? []), ...presets.map((preset) => ({ ...preset, kind: "preset" as const }))]);
}

async function loadPresets(refresh = false): Promise<void> {
  presets = await invoke<Preset[]>("get_presets", { refresh });
  rebuildIndex();
  render();
}

input.addEventListener("input", () => {
  if (searchMode !== "project" && !composing && /^\s*project:/i.test(input.value)) {
    input.value = input.value.replace(/^\s*project:\s*/i, "");
    setSearchMode("project");
    return;
  }
  if (!/^go to marker(?:\s|$)/i.test(input.value.trimStart())) markers = undefined;
  selected = 0;
  render();
});
for (const mode of searchModes) {
  element(`${mode}-mode`).addEventListener("click", () => {
    if (busy) return;
    if (searchMode !== mode) input.value = "";
    setSearchMode(mode);
    input.focus();
  });
}
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
  if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
      event.target === input && !input.value) {
    event.preventDefault();
    if (!event.repeat) setSearchMode(searchModes[(searchModes.indexOf(searchMode) + 1) % searchModes.length]);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (visible.length) select((selected + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length);
  }
  if (event.key === "Enter" && event.target === input && visible[selected]) {
    event.preventDefault();
    const item = visible[selected];
    void apply(item, event.shiftKey && item.kind === "project");
  }
});

element("settings-toggle").addEventListener("click", () => openSettings(!settingsOpen));
element("setup-button").addEventListener("click", () => openSettings(true));
element("back").addEventListener("click", () => openSettings(false));
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
    setSearchMode("all");
    openSettings(false);
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
