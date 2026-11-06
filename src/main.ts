import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ApplyResult, BridgeSnapshot, CatalogItem, Effect, Preset, ProjectMedia, ProjectCatalogKey, ProjectCatalogReply, ProjectItemLookup, SequenceMarker } from "../shared/protocol";
import { indexEffects, indexProjectMedia, mergeSearchResults, normalize, rankEffects, rankProjectMedia, score, type SearchEntry } from "./search";
import { captureShortcut, isTypingShortcut } from "./shortcut";
import helmIcon from "../src-tauri/icons/icon.png";
import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <section id="palette">
    <div class="search-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><input id="search" placeholder="Search effects, project media, and actions…" aria-label="Search effects, project media, and actions" role="combobox" aria-autocomplete="list" aria-controls="results" aria-expanded="true" autocomplete="off" spellcheck="false" /><kbd>ESC</kbd></div>
    <div class="search-modes" role="group" aria-label="Search mode">
      <button id="all-mode" type="button" aria-pressed="true">All</button>
      <button id="effects-mode" type="button" aria-pressed="false">Effects</button>
      <button id="project-mode" type="button" aria-pressed="false" title="Press Tab from an empty search to switch modes, or type project:">Project</button>
      <button id="actions-mode" type="button" aria-pressed="false">Actions</button>
      <button id="commands-mode" type="button" aria-pressed="false">Commands</button>
      <span id="insert-hint" hidden>Enter inserts · Shift+Enter opens item · v2: a2: prefers tracks</span>
    </div>
    <div id="results" role="listbox" aria-label="Palette results"></div>
    <div id="project-skeleton" aria-hidden="true" hidden>
      ${Array.from({ length: 3 }, () => `
        <div class="effect-row skeleton-row">
          <span class="effect-icon"></span>
          <span class="skeleton-title"></span>
          <span class="skeleton-subtitle"></span>
        </div>
      `).join("")}
    </div>
    <div id="empty" class="empty" hidden><span class="empty-symbol">⌕</span><h2 id="empty-title"></h2><p id="empty-message"></p><button id="setup-button" class="secondary" hidden>Connect to Premiere</button></div>
  </section>
  <section id="settings" aria-labelledby="settings-title" hidden>
    <button id="back" type="button"><span aria-hidden="true">←</span> Back to search</button>
    <h1 id="settings-title">Settings</h1>
    <section class="settings-group">
      <h2>Premiere connection</h2>
      <div class="settings-row">
        <div>
          <div class="plugin-install-status"><span id="plugin-status-dot" class="status-dot" aria-hidden="true"></span><span id="plugin-status-text">Checking plugin status…</span></div>
          <p id="plugin-status-hint">Helm connects automatically when Premiere loads the bridge.</p>
        </div>
        <button id="install-plugin-btn" class="secondary" type="button">Install to Premiere</button>
      </div>
    </section>
    <section class="settings-group">
      <h2>Keyboard shortcut</h2>
      <div class="settings-row">
        <span>Open Helm floating palette</span>
        <div class="shortcut-controls"><button id="record-shortcut" class="shortcut-button" type="button" aria-label="Change shortcut" title="Click to record a new shortcut"><kbd id="shortcut">Ctrl + Alt + Space</kbd></button><button id="reset-shortcut" class="shortcut-reset" type="button" aria-label="Reset to default shortcut" title="Reset to default (Ctrl + Alt + Space)">↺</button></div>
      </div>
    </section>
    <section class="settings-group">
      <h2>Audio preview</h2>
      <div class="settings-row">
        <div><label for="auto-preview-audio">Auto-preview audio</label><p id="auto-preview-description">Play the highlighted audio result after a short pause. Press Alt + P to play or stop a preview manually.</p></div>
        <input id="auto-preview-audio" type="checkbox" role="switch" aria-describedby="auto-preview-description" />
      </div>
    </section>
    <section class="settings-group">
      <h2>Catalogs</h2>
      <div class="settings-row">
        <div>Refresh catalogs<p>Update the items available in search.</p></div>
        <button id="refresh" class="primary" type="button" aria-label="Refresh catalogs">Refresh</button>
      </div>
    </section>
    <section class="settings-group">
      <h2>Diagnostics</h2>
      <div class="settings-row">
        <div><label for="show-project-log">Project debug log</label><p id="project-log-description">Show a separate window with project logs.</p></div>
        <input id="show-project-log" type="checkbox" role="switch" aria-describedby="project-log-description" />
      </div>
    </section>
  </section>
  <footer id="palette-footer" data-tauri-drag-region hidden>
    <div class="brand"><img class="brand-mark" src="${helmIcon}" alt="" /> HELM <span id="connection" class="connection" role="img" aria-label="Connecting to Premiere"></span></div>
    <div class="footer-info"><span id="status" role="status">Ready when you are.</span></div>
    <div class="footer-actions">
      <button id="settings-toggle" class="icon-button" aria-label="Connection settings" title="Connection settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m10 3-.7 2.3-2 .9-2.2-1-2 3.5 1.8 1.6v3.4l-1.8 1.6 2 3.5 2.2-1 2 .9L10 21h4l.7-2.3 2-.9 2.2 1 2-3.5-1.8-1.6v-3.4l1.8-1.6-2-3.5-2.2 1-2-.9L14 3z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  </footer>
  <button id="effect-shortcut-menu" class="effect-shortcut-menu" type="button" hidden>Assign shortcut…</button>
  <dialog id="effect-shortcut-dialog" aria-labelledby="effect-shortcut-name">
    <div class="shortcut-dialog-heading">
      <span id="effect-shortcut-icon" class="effect-icon video" aria-hidden="true">ƒx</span>
      <div><div id="shortcut-dialog-label" class="eyebrow">EFFECT SHORTCUT</div><h2 id="effect-shortcut-name"></h2></div>
    </div>
    <div id="effect-shortcut-keys" class="shortcut-key-preview" aria-live="polite"></div>
    <p class="shortcut-warning">This combination may override a Premiere shortcut. Windows reserves it while Helm is running.</p>
    <p id="effect-shortcut-error" class="shortcut-error" role="alert"></p>
    <div class="shortcut-dialog-actions">
      <button id="remove-effect-shortcut" class="secondary" type="button" hidden>Remove</button>
      <button id="cancel-effect-shortcut" class="secondary" type="button" autofocus>Cancel</button>
      <button id="save-effect-shortcut" class="primary" type="button" disabled>Save shortcut</button>
    </div>
  </dialog>
`;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const input = element<HTMLInputElement>("search");
const results = element<HTMLDivElement>("results");
let snapshot: BridgeSnapshot | undefined;
let index: SearchEntry[] = [];
let effectShortcuts: Record<string, string> = {};
type ShortcutTarget = Pick<Effect, "id" | "name"> & { kind: Effect["kind"] | "action" };
let shortcutEffect: ShortcutTarget | undefined;
let pendingAccelerator = "";
let savingEffectShortcut = false;
const shortcutMenu = element<HTMLButtonElement>("effect-shortcut-menu");
const shortcutDialog = element<HTMLDialogElement>("effect-shortcut-dialog");
const saveEffectShortcut = element<HTMLButtonElement>("save-effect-shortcut");

function previewEffectShortcut(parts: string[]): void {
  const preview = element("effect-shortcut-keys");
  preview.replaceChildren();
  if (!parts.length) preview.textContent = "Press a shortcut";
  for (const part of parts) {
    const key = document.createElement("kbd");
    key.textContent = part;
    preview.append(key);
  }
}

function showEffectShortcutMenu(effect: ShortcutTarget, event: MouseEvent): void {
  event.preventDefault();
  if (busy) return;
  shortcutEffect = effect;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  shortcutMenu.textContent = effectShortcuts[effect.id] ? "Change shortcut…" : "Assign shortcut…";
  shortcutMenu.hidden = false;
  shortcutMenu.style.left = `${Math.max(0, Math.min(event.clientX || rect.left, innerWidth - shortcutMenu.offsetWidth - 8))}px`;
  shortcutMenu.style.top = `${Math.max(0, Math.min(event.clientY || rect.bottom, innerHeight - shortcutMenu.offsetHeight - 8))}px`;
  shortcutMenu.focus();
}

function openEffectShortcutRecorder(): void {
  if (!shortcutEffect) return;
  shortcutMenu.hidden = true;
  pendingAccelerator = "";
  saveEffectShortcut.disabled = true;
  element("effect-shortcut-error").textContent = "";
  element("effect-shortcut-name").textContent = shortcutEffect.name;
  element("shortcut-dialog-label").textContent = shortcutEffect.kind === "action" ? "COMMAND SHORTCUT" : "EFFECT SHORTCUT";
  const icon = element("effect-shortcut-icon");
  icon.className = `effect-icon ${shortcutEffect.kind}`;
  icon.textContent = { video: "ƒx", audio: "♫", action: "▱" }[shortcutEffect.kind];
  const current = effectShortcuts[shortcutEffect.id];
  if (current && isTypingShortcut(current)) {
    element("effect-shortcut-error").textContent = "This shortcut is paused so you can type in Premiere. Add Ctrl, Alt, or the Windows key to reassign it.";
  }
  element("remove-effect-shortcut").hidden = !current;
  previewEffectShortcut(current ? current.split("+") : []);
  shortcutDialog.showModal();
  void invoke("set_effect_shortcut_recording", { recording: true }).catch((error) => {
    element("effect-shortcut-error").textContent = String(error);
  });
}

async function updateEffectShortcut(shortcut: string | null): Promise<void> {
  if (!shortcutEffect || savingEffectShortcut) return;
  savingEffectShortcut = true;
  saveEffectShortcut.disabled = true;
  try {
    effectShortcuts = await invoke<Record<string, string>>("set_effect_shortcut", {
      effectId: shortcutEffect.id, shortcut,
    });
    shortcutDialog.close();
    render();
    setStatus(shortcut ? "Shortcut saved." : "Shortcut removed.");
  } catch (error) {
    element("effect-shortcut-error").textContent = String(error);
  } finally {
    savingEffectShortcut = false;
    saveEffectShortcut.disabled = !pendingAccelerator;
  }
}
interface ActionItem {
  shortcutId?: string;
  kind: "action";
  id: string;
  name: string;
  description: string;
  argument?: string;
  value?: string;
}

const actionIconPaths: Record<string, string> = {
  "lock-cursor-horizontally": "M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4",
  "add-adjustment-layer": "M3 12l9-5 9 5-9 5z M3 16l9 5 9-5 M12 2v5m-2-3h4",
  "set-adjustment-layer-source": "M3 10l9-5 9 5-9 5z M3 14l9 5 9-5",
  "copy-attributes": "M9 9h11v11H9z M15 6V4H4v11h2",
  "paste-attributes": "M9 5H6v15h12V5h-3 M9 4h6v4H9z M9 12h6m-6 4h6",
  "remove-attributes": "M4 7h16m-14 0 1 13h10l1-13M9 7V4h6v3m-5 4v5m4-5v5",
  "add-marker": "M6 20V4h9l3 3-3 3H6m11 3v6m-3-3h6",
  "go-to-marker": "M6 20V4h9l3 3-3 3H6m6 6h8m-3-3 3 3-3 3",
  "set-opacity": "M12 3c-2 4-6 7-6 11a6 6 0 0 0 12 0c0-4-4-7-6-11Zm-5 13h10",
  "set-volume": "M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10",
};

const actions: ActionItem[] = [
  { kind: "action", id: "copy-attributes", name: "Copy Attributes", description: "Copy source clip in Premiere" },
  { kind: "action", id: "paste-attributes", name: "Paste Attributes", description: "Open Premiere’s paste dialog" },
  { kind: "action", id: "remove-attributes", name: "Remove Attributes", description: "Clear applied effects" },
  { kind: "action", id: "add-marker", name: "Add Marker", description: "Add a marker at the playhead", argument: "Marker name" },
  { kind: "action", id: "go-to-marker", name: "Go to Marker", description: "Find a marker in the active sequence" },
  { kind: "action", id: "set-opacity", name: "Set Opacity", description: "Set static clip opacity", argument: "Opacity (0–100%)" },
  { kind: "action", id: "set-volume", name: "Set Clip Volume", description: "Set static clip volume", argument: "Volume (−100 to +15 dB)" },
];
const horizontalCursorLock: ActionItem = {
  kind: "action", id: "lock-cursor-horizontally", shortcutId: "command:lock-cursor-horizontally",
  name: "Hold to Lock Cursor Horizontally", description: "Hold your assigned shortcut in Premiere to move the pointer only left and right",
};
const commands: ActionItem[] = [
  { kind: "action", id: "add-adjustment-layer", shortcutId: "command:add-adjustment-layer", name: "Add Adjustment Layer Above Clip", description: "Span selected video clips · Right-click to assign a shortcut" },
  { kind: "action", id: "set-adjustment-layer-source", name: "Set Adjustment Layer Source", description: "Select an existing adjustment layer in the timeline first" },
  horizontalCursorLock,
];
type PaletteItem = CatalogItem | ActionItem | (ProjectMedia & { kind: "project"; projectId: string });
let visible: PaletteItem[] = [];
const searchModes = ["all", "effects", "project", "actions", "commands"] as const;
type SearchMode = typeof searchModes[number];
let searchMode: SearchMode = "all";
let binStack: ProjectMedia[] = [];
const expandedBins = new Set<string>();
let projectId: string | undefined;
let projectIndex: ReturnType<typeof indexProjectMedia> = [];
let projectLoading = false;
let projectCacheKey: ProjectCatalogKey | undefined;
let projectScannedAt = 0;
let projectCacheGeneration = 0;
let projectRefreshPending: "check" | "force" | undefined;
let projectRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let projectScanCount = 0;
let projectError = "";
let presets: Preset[] = [];
let markers: SequenceMarker[] | undefined;
let selected = 0;
let busy = false;
let settingsOpen = false;
let composing = false;
let recordingShortcut = false;

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

let expanded = false;
let resizePending = Promise.resolve();

function showsResults(): boolean {
  return Boolean(input.value.trim()) || searchMode === "project" || searchMode === "actions" || searchMode === "commands";
}

function updatePaletteSize(): void {
  const next = settingsOpen || showsResults();
  element("palette-footer").hidden = !next;
  if (expanded === next) return;
  expanded = next;
  resizePending = resizePending
    .then(() => invoke<void>("resize_palette", { expanded: next }))
    .catch((error) => { console.error("Could not resize Helm:", error); });
}

function openSettings(open: boolean): void {
  if (open) stopAudioPreview();
  if (!open && recordingShortcut) stopRecordingShortcut();
  settingsOpen = open;
  element("palette").hidden = open;
  element("settings").hidden = !open;
  element("settings-toggle").hidden = open;
  updatePaletteSize();
  if (open) {
    element("back").focus();
    void refreshPluginStatus();
  }
  if (!open) input.focus();
}

function matchingActions(query: string): ActionItem[] {
  const search = normalize(query);
  if (markers && (search === "go to marker" || search.startsWith("go to marker "))) {
    const filter = search.slice("go to marker".length).trim();
    return markers.filter((marker) => normalize(marker.name).includes(filter)).slice(0, 60).map((marker) => {
      const milliseconds = Math.max(0, Math.floor(marker.seconds * 1000));
      const seconds = Math.floor(milliseconds / 1000);
      const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map((part) => String(part).padStart(2, "0")).join(":") +
        "." + String(milliseconds % 1000).padStart(3, "0");
      return { kind: "action", id: "go-to-marker", name: marker.name || "Untitled marker", description: time, value: marker.id };
    });
  }
  return actions.flatMap((action) => {
    const name = normalize(action.name);
    const aliases = action.id === "set-opacity" ? [name, "opacity"] :
      action.id === "set-volume" ? [name, "set volume", "volume"] : [name];
    const prefix = aliases.find((alias) => search.startsWith(alias + " "));
    if (prefix && (action.argument || action.id === "go-to-marker")) {
      const value = query.trim().slice(prefix.length).trim();
      return [{ ...action, value, name: `${action.name} · ${value}` }];
    }
    return aliases.some((alias) => search.split(/\s+/).every((word) => alias.includes(word))) ? [action] : [];
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

function browsingProjectTree(): boolean {
  return searchMode === "project" && !input.value.trim();
}

const projectChildren = new Map<string | undefined, ReturnType<typeof rankProjectMedia>>();
let inputRenderFrame: number | undefined;

function rebuildProjectTree(): void {
  projectPerformance.binTreeBuilds++;
  projectChildren.clear();
  for (const entry of rankProjectMedia(projectIndex, "", projectIndex.length)) {
    const parent = entry.item.binIds?.at(-1);
    const siblings = projectChildren.get(parent) ?? [];
    siblings.push(entry);
    projectChildren.set(parent, siblings);
  }
}

function projectTree(root: ProjectMedia | undefined) {
  function branch(parent: string | undefined): ReturnType<typeof rankProjectMedia> {
    return (projectChildren.get(parent) ?? []).flatMap((entry) => {
      const { item } = entry;
      if (item.mediaType !== "bin") return parent === undefined ? [] : [entry];
      return expandedBins.has(item.id) ? [entry, ...branch(item.id)] : [entry];
    });
  }
  return branch(root?.id);
}

function render(): void {
  if (inputRenderFrame !== undefined) {
    cancelAnimationFrame(inputRenderFrame);
    inputRenderFrame = undefined;
  }
  projectPerformance.resultRenders++;
  scheduleProjectPerformanceUpdate();
  const query = input.value;
  const connected = snapshot?.connected;
  const currentProject = projectId;
  const showProjectSkeleton = searchMode === "project" && connected === true && currentProject === undefined && !projectError;
  element("project-skeleton").hidden = !showProjectSkeleton;
  results.setAttribute("aria-busy", String(showProjectSkeleton));
  const bin = binStack.at(-1);
  const hasQuery = Boolean(query.trim());
  const tree = browsingProjectTree();
  updatePaletteSize();
  element("insert-hint").hidden = searchMode !== "project";
  element("insert-hint").textContent = bin
    ? `${[...bin.bins, bin.name].join(" › ")} · ← Back`
    : hasQuery ? "Enter inserts · Shift+Enter opens item · v2: a2: prefers tracks" : "→ Expand · ← Collapse";
  if (!showsResults()) {
    visible = [];
    selected = 0;
    results.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    element("empty").hidden = true;
    syncAudioPreview();
    return;
  }
  const limit = 60;
  const projectEntries = !tree && bin ? projectIndex.filter(({ item }) => item.binIds?.includes(bin.id)) : projectIndex;
  const projectResults = (searchMode === "all" || searchMode === "project") && currentProject !== undefined
    ? (tree ? projectTree(bin) : rankProjectMedia(projectEntries, projectQuery(query).search, limit))
      .map(({ item, rank }) => ({ item: { ...item, kind: "project" as const, projectId: currentProject }, rank })) : [];
  const effectResults = searchMode === "all" || searchMode === "effects"
    ? rankEffects(index, query, "all", [], limit) : [];
  const actionResults = searchMode === "commands"
    ? commands.filter((item) => normalize(query).split(/\s+/).every((word) => normalize(item.name).includes(word)))
    : searchMode === "all" || searchMode === "actions" ? matchingActions(query) : [];
  if (searchMode === "all") {
    const markerSearch = markers && /^go to marker(?:\s|$)/i.test(query.trimStart());
    const normalizedQuery = normalize(query);
    const rankedActions = actionResults.map((item) => {
      const normalized = normalize(item.name);
      const rank = item.value !== undefined ? -1 : Math.min(80, score({
        normalized, words: normalized.split(/\s+/), folderSearch: "",
      }, normalizedQuery));
      return { item, rank };
    });
    visible = markerSearch ? actionResults :
      mergeSearchResults<PaletteItem>([effectResults, projectResults, rankedActions], query, limit);
  } else {
    visible = [...effectResults.map(({ item }) => item), ...projectResults.map(({ item }) => item), ...actionResults];
  }
  selected = Math.min(selected, Math.max(0, visible.length - 1));
  const previousRows = Array.from(results.children) as HTMLElement[];
  const reusableRows = new Map(previousRows.map((row) => [row.dataset.resultKey, row]));
  const rows: HTMLElement[] = [];
  for (const [position, effect] of visible.entries()) {
    const treeState = tree && effect.kind === "project" ? [
      binStack.length, projectChildren.has(effect.id), expandedBins.has(effect.id),
    ] : null;
    const details = effect.kind === "project" ? [effect.projectId, effect.mediaType, effect.bins, effect.binIds?.length] :
      effect.kind === "preset" ? effect.folders : effect.kind === "action"
        ? [effect.description, effect.value, effect.shortcutId && effectShortcuts[effect.shortcutId]]
        : effectShortcuts[effect.id];
    const key = JSON.stringify([effect.kind, effect.id, effect.name, details, treeState]);
    const row = reusableRows.get(key) ?? createResultRow(effect, tree);
    reusableRows.delete(key);
    row.dataset.resultKey = key;
    const option = resultOption(row);
    option.id = `effect-${position}`;
    option.classList.toggle("selected", position === selected);
    option.setAttribute("aria-selected", String(position === selected));
    rows.push(row);
  }
  const retained = new Set(rows);
  for (const row of previousRows) {
    if (!retained.has(row)) row.remove();
  }
  for (const [position, row] of rows.entries()) {
    const current = results.children[position] ?? null;
    if (current !== row) results.insertBefore(row, current);
  }
  input.setAttribute("aria-activedescendant", visible.length ? `effect-${selected}` : "");
  syncAudioPreview();
  updateAudioPreviewButtons();
  const showEmpty = !visible.length && !showProjectSkeleton;
  element("empty").hidden = !showEmpty;
  if (showEmpty) {
    const noMatches = searchMode === "actions" || searchMode === "commands" || index.length;
    element("empty-title").textContent = noMatches ? "No matching results" : connected ? "Getting your effects…" : "Connect to Premiere";
    element("empty-message").textContent = noMatches ? "Try a shorter name." : connected ? "Reading the effects installed in Premiere." : "Connect the Helm Bridge panel in Premiere to get started.";
    element("setup-button").hidden = !!connected;
    if (searchMode === "project" && connected) {
      element("empty-title").textContent = projectError ? "Project search unavailable" :
        !hasQuery ? bin ? "This bin is empty" : "No project bins" :
        projectIndex.length ? "No matching media" : "No imported media found";
      element("empty-message").textContent = projectError || (hasQuery && projectIndex.length ? "Try a clip name or bin path." : "");
    }
  }
}

function resultOption(row: Element): HTMLElement {
  return (row.matches(".effect-row") ? row : row.firstElementChild) as HTMLElement;
}

type AudioResult = Extract<PaletteItem, { kind: "project" }>;
const autoPreviewAudio = element<HTMLInputElement>("auto-preview-audio");
try { autoPreviewAudio.checked = localStorage.getItem("helm-auto-preview-audio") === "true"; } catch { /* Use the default. */ }
autoPreviewAudio.addEventListener("change", () => {
  try { localStorage.setItem("helm-auto-preview-audio", String(autoPreviewAudio.checked)); } catch { /* Keep the session setting. */ }
});

const audioPlayer = new Audio();
let audioUrl: string | undefined;
let audioTimer: ReturnType<typeof setTimeout> | undefined;
let audioHighlight: string | undefined;
let audioPlaying: string | undefined;
let audioGeneration = 0;
let audioProgress: HTMLProgressElement | undefined;
let audioProgressFrame: number | undefined;

function isAudioResult(item: PaletteItem | undefined): item is AudioResult {
  return item?.kind === "project" && item.mediaType === "audio";
}

function audioResultKey(item: AudioResult): string {
  return JSON.stringify([item.projectId, item.id]);
}

function updateAudioPreviewButtons(): void {
  audioProgress = undefined;
  for (const button of results.querySelectorAll<HTMLButtonElement>("[data-audio-preview]")) {
    const active = button.dataset.audioPreview === audioPlaying;
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? "Stop preview (Alt + P)" : "Preview audio (Alt + P)";
    const progress = button.parentElement?.querySelector<HTMLProgressElement>(".audio-preview-progress");
    if (progress) {
      progress.hidden = !active || audioProgressFrame === undefined;
      if (progress.hidden) progress.value = 0;
      if (active) audioProgress = progress;
    }
  }
}

function stopAudioPreview(): void {
  clearTimeout(audioTimer);
  audioTimer = undefined;
  audioHighlight = undefined;
  audioPlaying = undefined;
  audioGeneration++;
  if (audioProgressFrame !== undefined) cancelAnimationFrame(audioProgressFrame);
  audioProgressFrame = undefined;
  if (audioUrl) {
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    URL.revokeObjectURL(audioUrl);
    audioUrl = undefined;
  }
  updateAudioPreviewButtons();
}

async function playAudioPreview(item: AudioResult): Promise<void> {
  stopAudioPreview();
  audioHighlight = audioPlaying = audioResultKey(item);
  const generation = audioGeneration;
  updateAudioPreviewButtons();
  try {
    const bytes = await invoke<ArrayBuffer | number[]>("preview_project_audio", { projectId: item.projectId, id: item.id });
    if (generation !== audioGeneration) return;
    if (!document.hasFocus()) {
      stopAudioPreview();
      return;
    }
    audioUrl = URL.createObjectURL(new Blob([Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes]));
    audioPlayer.src = audioUrl;
    await audioPlayer.play();
    if (generation !== audioGeneration) return;
    const paintProgress = () => {
      if (audioProgress && Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
        audioProgress.value = audioPlayer.currentTime / audioPlayer.duration;
      }
      audioProgressFrame = requestAnimationFrame(paintProgress);
    };
    paintProgress();
    updateAudioPreviewButtons();
  } catch (error) {
    if (generation !== audioGeneration) return;
    stopAudioPreview();
    audioHighlight = audioResultKey(item);
    setStatus(`Could not preview audio: ${error}`, true);
  }
}

audioPlayer.addEventListener("ended", () => {
  const highlight = audioHighlight;
  stopAudioPreview();
  audioHighlight = highlight;
});

function syncAudioPreview(): void {
  const item = visible[selected];
  if (!isAudioResult(item) || settingsOpen || busy || !document.hasFocus()) {
    if (audioHighlight !== undefined) stopAudioPreview();
    return;
  }
  const key = audioResultKey(item);
  if (key === audioHighlight) return;
  stopAudioPreview();
  audioHighlight = key;
  if (autoPreviewAudio.checked) {
    audioTimer = setTimeout(() => {
      if (document.hasFocus() && !busy) void playAudioPreview(item);
    }, 250);
  }
}

function toggleAudioPreview(): void {
  const item = visible[selected];
  if (!isAudioResult(item)) return;
  const key = audioResultKey(item);
  if (key === audioPlaying) {
    stopAudioPreview();
    audioHighlight = key;
  } else {
    void playAudioPreview(item);
  }
}

function createResultRow(effect: PaletteItem, tree: boolean): HTMLElement {
  const row = document.createElement("button");
  row.className = "effect-row";
  row.role = "option";
  const icon = document.createElement("span");
  icon.className = `effect-icon ${effect.kind}`;
  icon.textContent = { video: "ƒx", audio: "♫", preset: "◇", action: "", project: "▤" }[effect.kind];
  if (effect.kind === "action") {
    icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${actionIconPaths[effect.id]}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (effect.kind === "project") {
    const mediaType = effect.mediaType ?? "other";
    icon.classList.add(`media-${mediaType}`);
    icon.textContent = { video: "▶", audio: "♫", image: "▧", generated: "◈", sequence: "▣", bin: "▱", other: "▤" }[mediaType];
    icon.title = { video: "Video", audio: "Audio", image: "Image", generated: "Generated media", sequence: "Sequence", bin: "Bin", other: "Project media" }[mediaType];
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
    if (effect.mediaType === "bin") type.textContent = `Bin · ${type.textContent}`;
    row.title = `${type.textContent} › ${effect.name}`;
  } else if (effect.kind === "action") {
    type.textContent = effect.description;
  } else {
    type.textContent = effect.kind === "video" ? "Video effect" : "Audio effect";
  }
  const enter = document.createElement("span");
  enter.className = "row-enter";
  enter.textContent = effect.kind === "project" && effect.mediaType === "bin" ? "" : "↵";
  row.append(icon, name, type, enter);
  const shortcutTarget = effect.kind === "video" || effect.kind === "audio" ? effect
    : effect.kind === "action" && effect.shortcutId ? { ...effect, id: effect.shortcutId } : undefined;
  if (shortcutTarget) {
    const accelerator = effectShortcuts[shortcutTarget.id];
    if (accelerator && !isTypingShortcut(accelerator)) {
      const badge = document.createElement("kbd");
      badge.className = "effect-shortcut-badge";
      badge.textContent = accelerator.replaceAll("+", " + ");
      row.classList.add("has-effect-shortcut");
      row.append(badge);
    }
    row.addEventListener("contextmenu", (event) => showEffectShortcutMenu(shortcutTarget, event));
  }
  if (tree && effect.kind === "project") {
    row.classList.add("project-tree-row");
    const depth = Math.max(0, (effect.binIds?.length ?? 0) - binStack.length);
    row.style.setProperty("--bin-depth", String(depth));
    if (effect.mediaType === "bin") {
      icon.textContent = "";
      if (projectChildren.has(effect.id)) {
        const open = expandedBins.has(effect.id);
        enter.classList.add("bin-chevron");
        enter.classList.toggle("expanded", open);
        enter.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        enter.setAttribute("aria-hidden", "true");
        row.setAttribute("aria-label", `${effect.name}, ${open ? "expanded" : "collapsed"} bin`);
      } else {
        row.setAttribute("aria-label", `${effect.name}, empty bin`);
      }
    }
  }
  row.addEventListener("pointermove", () => {
    if (inputRenderFrame === undefined) select(Number(row.id.slice("effect-".length)));
  });
  row.addEventListener("click", () => {
    if (inputRenderFrame !== undefined) render();
    if (results.contains(row)) {
      const current = visible[Number(row.id.slice("effect-".length))];
      if (current) void apply(current);
    }
  });
  if (isAudioResult(effect)) {
    const wrapper = document.createElement("div");
    wrapper.className = "audio-result";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "audio-preview-button icon-button";
    preview.dataset.audioPreview = audioResultKey(effect);
    preview.setAttribute("aria-label", `Preview ${effect.name}`);
    preview.title = "Preview audio (Alt + P)";
    preview.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 6h3l3-3v10l-3-3H2z M10 6a3 3 0 0 1 0 4m2-6a6 6 0 0 1 0 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    preview.addEventListener("click", () => {
      if (inputRenderFrame !== undefined) render();
      if (!results.contains(wrapper) || busy) return;
      select(Number(row.id.slice("effect-".length)));
      toggleAudioPreview();
    });
    const progress = document.createElement("progress");
    progress.className = "audio-preview-progress";
    progress.max = 1;
    progress.value = 0;
    progress.hidden = true;
    progress.setAttribute("aria-hidden", "true");
    wrapper.append(row, preview, progress);
    return wrapper;
  }
  return row;
}

const projectLog = { catalog: [] as { message: string }[], lookup: [] as { message: string }[], presets: [] as { message: string }[] };
let presetLoadCount = 0;
const projectPerformance = { binTreeBuilds: 0, resultRenders: 0 };
let projectPerformanceTimer: ReturnType<typeof setTimeout> | undefined;

function publishProjectPerformance(): void {
  if (!projectLogToggle.checked) return;
  void emitTo("project-log", "project-performance-updated", projectPerformance)
    .catch((error) => setStatus(String(error), true));
}

function scheduleProjectPerformanceUpdate(): void {
  if (!projectLogToggle.checked || projectPerformanceTimer !== undefined) return;
  projectPerformanceTimer = setTimeout(() => {
    projectPerformanceTimer = undefined;
    publishProjectPerformance();
  }, 150);
}

function publishProjectLog(): void {
  if (!projectLogToggle.checked) return;
  void emitTo("project-log", "project-log-updated", {
    catalog: projectLog.catalog.map(({ message }) => message),
    lookup: projectLog.lookup.map(({ message }) => message),
    presets: projectLog.presets.map(({ message }) => message),
    presetLoadCount,
  }).catch((error) => setStatus(String(error), true));
}

function appendProjectLog(section: keyof typeof projectLog, message: string): (message: string) => void {
  const entry = { message };
  const entries = projectLog[section];
  entries.unshift(entry);
  if (entries.length > 30) entries.pop();
  publishProjectLog();
  return (updated) => {
    entry.message = updated;
    publishProjectLog();
  };
}

function clearProjectCache(): void {
  projectCacheGeneration++;
  projectCacheKey = undefined;
  projectId = undefined;
  projectIndex = [];
  projectChildren.clear();
  binStack = [];
  expandedBins.clear();
}

async function loadProjectMedia(force = false, recheckPending = false): Promise<void> {
  if (!snapshot?.connected) return;
  if (projectLoading) {
    if (force) projectRefreshPending = "force";
    else if (recheckPending) projectRefreshPending ??= "check";
    return;
  }
  projectLoading = true;
  const generation = projectCacheGeneration;
  // Older bridges only compare the dirty revision. New bridges also check the item inventory.
  const key = !force && (projectCacheKey?.catalogVersion !== undefined || performance.now() - projectScannedAt < 30_000)
    ? projectCacheKey : undefined;
  projectError = "";
  render();
  const startedAt = performance.now();
  const label = `#${++projectScanCount} · ${new Date().toLocaleTimeString()}`;
  const entry = appendProjectLog("catalog", `${label} · Checking project…`);
  try {
    const { key: currentKey, catalog, incremental } = await invoke<ProjectCatalogReply>("run_palette_command", {
      action: "list-project-media", value: key,
    });
    const elapsed = Math.round(performance.now() - startedAt);
    const summary = incremental
      ? `Incremental refresh · ${incremental.added} added · ${incremental.reused} reused · ${incremental.metadataReads} metadata reads`
      : catalog ? `Full scan · ${catalog.items.length} items` : "Cache hit";
    entry(`${label} · ${summary} · ${elapsed} ms`);
    if (generation === projectCacheGeneration && snapshot?.connected) {
      if (catalog) {
        if (projectId !== undefined && projectId !== catalog.projectId) clearProjectCache();
        projectId = catalog.projectId;
        projectIndex = indexProjectMedia(catalog.items);
        rebuildProjectTree();
        projectScannedAt = performance.now();
      }
      projectCacheKey = currentKey;
    }
  } catch (error) {
    if (generation === projectCacheGeneration) projectError = String(error);
    entry(`${label} · Request failed · ${String(error)}`);
  } finally {
    projectLoading = false;
    render();
    if (projectRefreshPending) {
      const pending = projectRefreshPending;
      projectRefreshPending = undefined;
      void loadProjectMedia(pending === "force");
    }
  }
}

function setSearchMode(mode: SearchMode, recheckPending = false): void {
  if (searchMode !== mode) stopAudioPreview();
  searchMode = mode;
  selected = 0;
  markers = undefined;
  binStack = [];
  expandedBins.clear();
  input.placeholder = { all: "Search effects, project media, and actions…", effects: "Find an effect or preset…", project: "Find media, sequences, or bins…", actions: "Find an action…", commands: "Find a shortcut command…" }[mode];
  input.setAttribute("aria-label", input.placeholder);
  for (const option of searchModes) {
    element(`${option}-mode`).setAttribute("aria-pressed", String(option === mode));
  }
  render();
  if (mode === "project" || mode === "all") void loadProjectMedia(false, recheckPending);
}

function select(position: number): void {
  selected = position;
  for (const [i, row] of Array.from(results.children).entries()) {
    const option = resultOption(row);
    option.classList.toggle("selected", i === selected);
    option.setAttribute("aria-selected", String(i === selected));
  }
  input.setAttribute("aria-activedescendant", visible.length ? `effect-${selected}` : "");
  results.children[selected]?.scrollIntoView({ block: "nearest" });
  syncAudioPreview();
}

function enterBin(bin: ProjectMedia): void {
  const parents = (bin.binIds ?? []).flatMap((id) => {
    const parent = projectIndex.find(({ item }) => item.id === id)?.item;
    return parent ? [parent] : [];
  });
  input.value = "";
  if (searchMode !== "project") setSearchMode("project");
  binStack = [...parents, bin];
  selected = 0;
  render();
  input.focus();
}

function leaveBin(): void {
  const bin = binStack.pop();
  input.value = "";
  selected = 0;
  render();
  const previous = visible.findIndex((item) => item.kind === "project" && item.id === bin?.id);
  if (previous >= 0) select(previous);
}

async function runAction(action: ActionItem): Promise<void> {
  const invokeAction = (action: string, value?: string | number) =>
    invoke<{ message?: string; markers?: SequenceMarker[]; native?: boolean }>("run_palette_command", { action, value });
  if (action.id === "go-to-marker" && !markers) {
    const result = await invokeAction("list-markers");
    markers = result.markers ?? [];
    input.value = action.value ? `Go to Marker ${action.value}` : "Go to Marker ";
    selected = 0;
    render();
    input.focus();
    setStatus(markers.length ? "Type a marker name, then press Enter to jump." : "This sequence has no markers.");
    return;
  }
  if (action.argument && !action.value) {
    input.value = action.name + " ";
    input.focus();
    setStatus(action.argument);
    return;
  }
  let value: string | number | undefined = action.value;
  if (action.id === "set-opacity" || action.id === "set-volume") {
    const opacity = action.id === "set-opacity";
    const number = value?.replace(opacity ? /\s*%$/ : /\s*dB$/i, "").trim() ?? "";
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(number)) throw new Error(`Enter a numeric value. ${action.argument}.`);
    value = Number(number);
  }
  const result = await invokeAction(action.id, value);
  setStatus(result.message ?? "Done.");
  if (!result.native) await invoke("dismiss_palette", { restoreFocus: true });
}

async function apply(effect: PaletteItem, alternate = false): Promise<void> {
  if (busy) return;
  stopAudioPreview();
  if (effect.kind === "action" && effect.id === horizontalCursorLock.id && effect.shortcutId) {
    shortcutEffect = { ...effect, id: effect.shortcutId };
    openEffectShortcutRecorder();
    return;
  }
  if (!snapshot?.connected) { setStatus("Connect the Helm panel in Premiere first.", true); return; }
  if (effect.kind === "project" && effect.mediaType === "bin") {
    if (browsingProjectTree()) {
      if (!projectChildren.has(effect.id)) return;
      selected = visible.findIndex((item) => item.kind === "project" && item.id === effect.id);
      if (expandedBins.has(effect.id)) expandedBins.delete(effect.id);
      else expandedBins.add(effect.id);
      render();
      input.focus();
    } else {
      enterBin(effect);
    }
    return;
  }
  busy = true;
  document.body.classList.add("busy");
  const isRevealPreset = effect.kind === "preset" && !effect.directApply;
  setStatus(effect.kind === "project" ? `${alternate ? "Opening" : "Inserting"} ${effect.name}…` :
    isRevealPreset ? `Locating ${effect.name}…` : `Applying ${effect.name}…`);
  try {
    if (effect.kind === "project") {
      const action = effect.mediaType === "sequence"
        ? alternate ? "Open Timeline" : "Nest"
        : alternate ? "Source Monitor" : "Insert";
      const label = `${new Date().toLocaleTimeString()} · ${action} · ${effect.name}`;
      const result = await invoke<{ message: string; lookup?: ProjectItemLookup }>("run_palette_command", {
        action: alternate ? "open-project-source" : "insert-project-media",
        value: { projectId: effect.projectId, id: effect.id, ...projectQuery(input.value).tracks },
      }).catch((error) => {
        appendProjectLog("lookup", `${label} · ${String(error)}`);
        throw error;
      });
      if (result.lookup) {
        const source = result.lookup.source === "cache" ? "Lookup hit" : "Fresh lookup";
        appendProjectLog("lookup", `${label} · ${source} · ${result.lookup.elapsedMs} ms`);
      }
      setStatus(result.message);
      await invoke("dismiss_palette", { restoreFocus: true });
      return;
    }
    if (effect.kind === "action") {
      await runAction(effect);
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
      if (alternate) {
        try {
          await invoke("open_effect_controls");
        } catch (error) {
          setStatus(`Applied ${effect.name}. Could not open Effect Controls. ${error}`, true);
        }
      } else {
        await invoke("dismiss_palette", { restoreFocus: true });
      }
    }
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
    clearProjectCache();
  }
  rebuildIndex();
  const connection = element("connection");
  connection.setAttribute("aria-label", next.connected ? "Premiere connected" : "Premiere offline");
  connection.classList.toggle("online", next.connected);
  if (!recordingShortcut) {
    element("shortcut").textContent = next.shortcut.replaceAll("+", " + ");
  }
  element("reset-shortcut").hidden = next.shortcut === "Ctrl+Alt+Space";
  if (next.error) setStatus(next.error, true);
  else if (!busy) setStatus(next.connected ? "" : "Connect the Premiere panel to load your effects.");
  render();
  if ((searchMode === "project" || searchMode === "all") && next.connected && !wasConnected) void loadProjectMedia(true);
}

function rebuildIndex(): void {
  index = indexEffects([...(snapshot?.effects ?? []), ...presets.map((preset) => ({ ...preset, kind: "preset" as const }))]);
}

type PresetLoadReason = "Startup" | "Library changed" | "Manual refresh";
let presetLoadPending: Promise<void> | undefined;

function loadPresets(reason: PresetLoadReason): Promise<void> {
  const load = (presetLoadPending ?? Promise.resolve())
    .catch(() => { /* A later refresh can recover from an earlier read error. */ })
    .then(() => readPresets(reason))
    .finally(() => {
      if (presetLoadPending === load) presetLoadPending = undefined;
    });
  presetLoadPending = load;
  return load;
}

async function readPresets(reason: PresetLoadReason): Promise<void> {
  const startedAt = performance.now();
  const label = `#${++presetLoadCount} · ${new Date().toLocaleTimeString()} · ${reason}`;
  const entry = appendProjectLog("presets", `${label} · Loading…`);
  try {
    presets = await invoke<Preset[]>("get_presets", { refresh: reason === "Manual refresh" });
    entry(`${label} · ${presets.length} presets · ${Math.round(performance.now() - startedAt)} ms`);
  } catch (error) {
    entry(`${label} · Load failed · ${String(error)}`);
    throw error;
  }
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
  if (inputRenderFrame === undefined) inputRenderFrame = requestAnimationFrame(render);
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
shortcutMenu.addEventListener("click", openEffectShortcutRecorder);
document.addEventListener("pointerdown", (event) => {
  if (event.target !== shortcutMenu) shortcutMenu.hidden = true;
});
element("cancel-effect-shortcut").addEventListener("click", () => {
  if (!savingEffectShortcut) shortcutDialog.close();
});
element("remove-effect-shortcut").addEventListener("click", () => void updateEffectShortcut(null));
saveEffectShortcut.addEventListener("click", () => {
  if (pendingAccelerator) void updateEffectShortcut(pendingAccelerator);
});
shortcutDialog.addEventListener("cancel", (event) => {
  if (savingEffectShortcut) event.preventDefault();
});
shortcutDialog.addEventListener("close", () => {
  void invoke("set_effect_shortcut_recording", { recording: false }).catch((error) => setStatus(String(error), true));
  input.focus();
});

document.addEventListener("keydown", async (event) => {
  if (shortcutDialog.open) {
    if (event.isComposing || event.key === "Escape" || (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey)) return;
    if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      if (pendingAccelerator && event.target !== element("remove-effect-shortcut")) {
        event.preventDefault();
        if (!event.repeat) void updateEffectShortcut(pendingAccelerator);
      }
      return;
    }
    event.preventDefault();
    if (savingEffectShortcut || event.repeat) return;
    const captured = captureShortcut(event);
    if (!captured) return;
    const error = captured.error || (isTypingShortcut(captured.accelerator)
      ? "Add Ctrl, Alt, or the Windows key to keep this key available for typing in Premiere."
      : "");
    pendingAccelerator = captured.complete && !error ? captured.accelerator : "";
    saveEffectShortcut.disabled = !pendingAccelerator;
    previewEffectShortcut(captured.display ? captured.display.split(" + ") : []);
    element("effect-shortcut-error").textContent = error;
    return;
  }
  if (!shortcutMenu.hidden && event.key === "Escape") {
    event.preventDefault();
    shortcutMenu.hidden = true;
    input.focus();
    return;
  }
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
  if (event.key === "," && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && !busy) {
    event.preventDefault();
    if (!event.repeat) openSettings(!settingsOpen);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (settingsOpen) openSettings(false);
    else if (!busy && binStack.length) leaveBin();
    else if (!busy) void invoke("dismiss_palette", { restoreFocus: true });
    return;
  }
  if (settingsOpen || busy) return;
  const focusedRow = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>(".effect-row") : null;
  const focusedIndex = focusedRow ? Number(focusedRow.id.slice("effect-".length)) : undefined;
  const previewSpace = event.code === "Space" && !event.altKey && !event.shiftKey &&
    focusedIndex !== undefined && isAudioResult(visible[focusedIndex]);
  const previewShortcut = event.altKey && !event.shiftKey && event.code === "KeyP";
  if (!event.ctrlKey && !event.metaKey && (previewSpace || previewShortcut)) {
    if (inputRenderFrame !== undefined) render();
    const previewIndex = previewSpace ? focusedIndex : selected;
    if (previewIndex !== undefined && isAudioResult(visible[previewIndex])) {
      event.preventDefault();
      if (!event.repeat) {
        if (previewSpace) select(previewIndex);
        toggleAudioPreview();
      }
      return;
    }
  }
  if (inputRenderFrame !== undefined && ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    render();
  }
  if (searchMode === "project" && event.target === input &&
      !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const item = visible[selected];
    if (event.key === "ArrowRight" && input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length && item?.kind === "project" && item.mediaType === "bin") {
      event.preventDefault();
      if (!event.repeat) {
        if (!browsingProjectTree()) enterBin(item);
        else if (!expandedBins.has(item.id)) void apply(item);
        else {
          const child = visible[selected + 1];
          if (child?.kind === "project" && child.binIds?.at(-1) === item.id) select(selected + 1);
        }
      }
      return;
    }
    if (event.key === "ArrowLeft" && browsingProjectTree() && item?.kind === "project") {
      if (expandedBins.has(item.id)) {
        event.preventDefault();
        if (!event.repeat) void apply(item);
        return;
      }
      const parent = visible.findIndex((entry) => entry.kind === "project" && entry.id === item.binIds?.at(-1));
      if (parent >= 0) {
        event.preventDefault();
        if (!event.repeat) select(parent);
        return;
      }
    }
    if (event.key === "ArrowLeft" && !input.value && binStack.length) {
      event.preventDefault();
      if (!event.repeat) leaveBin();
      return;
    }
  }
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
    if (!event.repeat) void apply(visible[selected], event.shiftKey);
  }
});

element("settings-toggle").addEventListener("click", () => openSettings(!settingsOpen));
const projectLogToggle = element<HTMLInputElement>("show-project-log");
try { projectLogToggle.checked = localStorage.getItem("helm-show-project-log") === "true"; } catch { /* Use the default. */ }
projectLogToggle.addEventListener("change", async () => {
  const visible = projectLogToggle.checked;
  projectLogToggle.disabled = true;
  try {
    await invoke("set_project_log_visible", { visible });
    publishProjectLog();
    publishProjectPerformance();
    try { localStorage.setItem("helm-show-project-log", String(visible)); } catch { /* Visibility still works for this session. */ }
  } catch (error) {
    projectLogToggle.checked = !visible;
    setStatus(String(error), true);
  } finally {
    projectLogToggle.disabled = false;
  }
});
interface PluginStatus {
  upia_available: boolean;
  installed: boolean;
  ccx_found: boolean;
  message: string;
}

interface InstallResult {
  success: boolean;
  message: string;
}

async function refreshPluginStatus(): Promise<void> {
  const dot = element("plugin-status-dot");
  const text = element("plugin-status-text");
  const hint = element("plugin-status-hint");
  const btn = element<HTMLButtonElement>("install-plugin-btn");

  try {
    const status = await invoke<PluginStatus>("get_premiere_plugin_status");
    if (status.installed) {
      dot.className = "status-dot online";
      text.textContent = "Installed in Premiere Pro";
      hint.textContent = "Helm Bridge is registered. Open Window → UXP Plugins in Premiere.";
      btn.textContent = "Reinstall Plugin";
      btn.disabled = false;
    } else if (status.upia_available) {
      dot.className = "status-dot";
      text.textContent = "Not installed in Premiere Pro";
      hint.textContent = "Install Helm Bridge automatically with one click.";
      btn.textContent = "Install to Premiere";
      btn.disabled = false;
    } else {
      dot.className = "status-dot offline";
      text.textContent = "Adobe UPIA not found";
      hint.textContent = "Ensure Adobe Creative Cloud is installed, or use Developer Tools below.";
      btn.textContent = "Install to Premiere";
      btn.disabled = true;
    }
  } catch (e) {
    console.error("Failed to check plugin status:", e);
  }
}

async function handleInstallPlugin(): Promise<void> {
  const btn = element<HTMLButtonElement>("install-plugin-btn");
  const text = element("plugin-status-text");
  const hint = element("plugin-status-hint");
  const dot = element("plugin-status-dot");

  btn.disabled = true;
  btn.textContent = "Installing…";
  text.textContent = "Installing into Premiere…";
  hint.textContent = "Running Adobe Unified Plugin Installer Agent (UPIA)…";

  try {
    const res = await invoke<InstallResult>("install_premiere_plugin");
    if (res.success) {
      dot.className = "status-dot online";
      text.textContent = "Installed successfully!";
      hint.textContent = "Helm Bridge is installed in Premiere Pro. Open Premiere to use.";
      btn.textContent = "Reinstall Plugin";
      setStatus("Helm Bridge installed into Premiere Pro.");
    }
  } catch (err) {
    dot.className = "status-dot offline";
    text.textContent = "Installation failed";
    hint.textContent = String(err);
    btn.textContent = "Retry Install";
  } finally {
    btn.disabled = false;
  }
}

element("install-plugin-btn").addEventListener("click", () => void handleInstallPlugin());
element("setup-button").addEventListener("click", () => openSettings(true));
element("back").addEventListener("click", () => openSettings(false));
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
    await loadPresets("Manual refresh");
    if (snapshot?.connected) {
      await Promise.all([invoke("refresh_catalog"), loadProjectMedia(true)]);
    }
    setStatus(`Catalog refreshed · ${presets.length} presets.`);
  }
  catch (error) { setStatus(String(error), true); }
  finally { busy = false; }
});

async function start(): Promise<void> {
  await listen<string>("effect-shortcut-error", ({ payload }) => setStatus(payload, true));
  await listen("effect-shortcut-conflict", () => {
    if (!shortcutDialog.open || savingEffectShortcut) return;
    pendingAccelerator = "";
    saveEffectShortcut.disabled = true;
    previewEffectShortcut([]);
    element("effect-shortcut-error").textContent = "That shortcut is already assigned in Helm.";
  });
  await getCurrentWebviewWindow().listen("project-log-ready", () => {
    publishProjectLog();
    publishProjectPerformance();
  });
  if (projectLogToggle.checked) {
    try {
      await invoke("set_project_log_visible", { visible: true });
      publishProjectLog();
      publishProjectPerformance();
    } catch (error) {
      projectLogToggle.checked = false;
      setStatus(String(error), true);
    }
  }
  await listen<BridgeSnapshot>("bridge-changed", ({ payload }) => update(payload));
  await listen("preset-library-changed", () => {
    if (!presetLoadPending) void loadPresets("Library changed").catch((error) => setStatus(String(error), true));
  });
  await listen<boolean>("project-catalog-changed", ({ payload: reset }) => {
    if (reset) {
      clearProjectCache();
      render();
    }
    clearTimeout(projectRefreshTimer);
    projectRefreshTimer = setTimeout(() => void loadProjectMedia(false, true), 300);
  });
  await listen("palette-opened", () => {
    stopAudioPreview();
    if (busy) return;
    shortcutMenu.hidden = true;
    if (shortcutDialog.open && !savingEffectShortcut) shortcutDialog.close();
    input.value = "";
    setSearchMode("all", true);
    openSettings(false);
    input.focus();
  });
  await listen("palette-closed", stopAudioPreview);
  window.addEventListener("blur", () => {
    stopAudioPreview();
    if (recordingShortcut) stopRecordingShortcut();
  });
  update(await invoke<BridgeSnapshot>("get_snapshot"));
  effectShortcuts = await invoke<Record<string, string>>("get_effect_shortcuts");
  void refreshPluginStatus();
  render();
  input.focus();
  await loadPresets("Startup");
}

void start().catch((error) => setStatus(`Could not initialize Helm: ${error}`, true));
