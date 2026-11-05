import type { premierepro } from "@adobe/premierepro";
import type { Effect, PresetFilter } from "../../shared/protocol";
import { applyEffect, applyPreset, discoverEffects, isAudio, isVideo, selectedClips } from "./effects";
import { runCommand } from "./commands";

const ppro = require("premierepro") as premierepro;
const { entrypoints, storage } = require("uxp");

let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let running = false;
let generation = 0;
let retryMs = 750;
let catalog = new Map<string, Effect>();
let busy = false;
let authenticated = false;
let statusText = "Waiting for the Helm desktop app…";
let bindPending = false;

function status(message: string): void {
  statusText = message;
  const label = document.getElementById("status");
  if (label) label.textContent = message;
}

function send(connection: WebSocket, message: object): void {
  if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
}

async function publishCatalog(connection: WebSocket): Promise<number> {
  const effects = await discoverEffects(ppro);
  if (socket !== connection || connection.readyState !== WebSocket.OPEN) throw new Error("Helm disconnected.");
  catalog = new Map(effects.map((effect) => [effect.id, effect]));
  send(connection, { type: "catalog", effects });
  status(`Connected · ${effects.length} effects available`);
  return effects.length;
}

async function handleCommand(connection: WebSocket, message: Record<string, unknown>): Promise<void> {
  if (typeof message.id !== "string") return;
  const id = message.id;
  if (busy) {
    send(connection, { type: "result", id, ok: false, error: "Premiere is already handling a Helm command." });
    return;
  }
  busy = true;
  try {
    if (message.command === "refresh") {
      const count = await publishCatalog(connection);
      send(connection, { type: "result", id, ok: true, result: { count } });
    } else if (message.command === "check-selection") {
      const { clips } = await selectedClips(ppro);
      if (message.single === true && clips.length !== 1 && !(
        clips.length === 2 &&
        clips.some((clip) => isVideo(ppro, clip)) &&
        clips.some((clip) => isAudio(ppro, clip)) &&
        (await clips[0].getProjectItem()).getId() === (await clips[1].getProjectItem()).getId() &&
        (await clips[0].getStartTime()).ticks === (await clips[1].getStartTime()).ticks &&
        (await clips[0].getEndTime()).ticks === (await clips[1].getEndTime()).ticks
      )) throw new Error("Select one source clip to copy.");
      send(connection, { type: "result", id, ok: true, result: {} });
    } else if (message.command === "palette-command") {
      const result = await runCommand(ppro, message.action, message.value);
      send(connection, { type: "result", id, ok: true, result });
    } else if (message.command === "apply") {
      const rawId = String(message.effectId);
      const effect = catalog.get(rawId) ?? (
        rawId.startsWith("video:")
          ? { id: rawId, name: rawId.slice(6), matchName: rawId.slice(6), kind: "video" as const }
          : rawId.startsWith("audio:")
            ? { id: rawId, name: rawId.slice(6), matchName: rawId.slice(6), kind: "audio" as const }
            : undefined
      );
      if (!effect) throw new Error("That effect is unavailable. Refresh the effect list and try again.");
      const result = await applyEffect(ppro, effect);
      send(connection, { type: "result", id, ok: true, result });
    } else if (message.command === "apply-preset") {
      const preset = message.preset as { name?: string; filters?: PresetFilter[] } | undefined;
      if (!preset?.name || !Array.isArray(preset.filters) || !preset.filters.length) {
        throw new Error("That preset cannot be applied directly.");
      }
      const result = await applyPreset(ppro, { name: preset.name, filters: preset.filters });
      send(connection, { type: "result", id, ok: true, result });
    } else if (message.command === "reload") {
      send(connection, { type: "result", id, ok: true, result: { reloading: true } });
      setTimeout(() => {
        window.location.reload();
      }, 50);
      return;
    } else {
      throw new Error("Unsupported Helm command.");
    }
  } catch (error) {
    send(connection, { type: "result", id, ok: false, error: errorMessage(error) });
  } finally {
    busy = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduleReconnect(): void {
  if (!running || reconnect !== undefined) return;
  reconnect = setTimeout(() => {
    reconnect = undefined;
    void connect();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 8000);
}

async function connect(): Promise<void> {
  const attempt = generation;
  let session: { port?: unknown; token?: unknown } | null = null;
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const file = await folder.getEntry("helm-session.json");
    session = JSON.parse(await file.read());
  } catch { /* Helm may start after Premiere creates the data folder. */ }
  if (!running || attempt !== generation) return;
  if (session?.port !== 48139 || typeof session.token !== "string" || !/^[a-f0-9]{32}$/i.test(session.token)) {
    status("Waiting for the Helm desktop app…");
    scheduleReconnect();
    return;
  }
  const { port, token } = session;
  let connection: WebSocket;
  try { connection = new WebSocket(`ws://localhost:${port}`); }
  catch (error) {
    status(`Could not open the Helm bridge. ${errorMessage(error)}`);
    scheduleReconnect();
    return;
  }
  socket = connection;
  authenticated = false;
  let rejected = false;
  connection.onopen = () => {
    if (socket === connection) send(connection, { type: "hello", protocol: 1, key: token });
  };
  connection.onmessage = ({ data }) => {
    if (socket !== connection || typeof data !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === "error") {
      rejected = true;
      status(String(message.error));
      connection.close();
    } else if (message.type === "welcome" && message.protocol === 1 && !authenticated) {
      authenticated = true;
      retryMs = 750;
      void publishCatalog(connection).catch((error) => {
        const detail = `Could not read Premiere effects. ${errorMessage(error)}`;
        status(detail);
        send(connection, { type: "error", error: detail });
      });
    } else if (message.type === "command" && authenticated) {
      void handleCommand(connection, message);
    }
  };
  connection.onerror = () => {
    if (socket === connection && !rejected) status("Waiting for the Helm desktop app…");
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    socket = undefined;
    authenticated = false;
    if (!rejected) status("Waiting for the Helm desktop app…");
    scheduleReconnect();
  };
}

function stop(): void {
  running = false;
  generation++;
  clearTimeout(reconnect);
  reconnect = undefined;
  const connection = socket;
  socket = undefined;
  authenticated = false;
  connection?.close();
}

function bindPanel(): void {
  if (!document.getElementById("status") || bindPending) return;
  bindPending = true;
  status(statusText);
  document.getElementById("refresh")?.addEventListener("click", () => {
    if (!socket || !authenticated) { status("Connect the Helm desktop app first."); return; }
    if (busy) return;
    busy = true;
    void publishCatalog(socket).catch((error) => status(errorMessage(error))).finally(() => { busy = false; });
  });
  document.getElementById("reload")?.addEventListener("click", () => {
    window.location.reload();
  });
}

function start(): void {
  bindPanel();
  if (running) return;
  running = true;
  retryMs = 750;
  void connect();
}

entrypoints.setup({
  plugin: { create: start, destroy: stop },
  panels: { helmBridge: { show: start } },
});
document.addEventListener("DOMContentLoaded", start);
