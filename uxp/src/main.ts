import type { premierepro } from "@adobe/premierepro";
import type { Effect, PresetFilter } from "../../shared/protocol";
import { applyEffect, applyPreset, discoverEffects, selectedClips } from "./effects";

const ppro = require("premierepro") as premierepro;
const { entrypoints } = require("uxp");
const address = "ws://localhost:48139";
const storageKey = "helm-pairing-key";

let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let key = "";
let retryMs = 750;
let catalog = new Map<string, Effect>();
let busy = false;
let authenticated = false;
let statusText = "Open Helm on your desktop to pair.";
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
      await selectedClips(ppro);
      send(connection, { type: "result", id, ok: true, result: {} });
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
  if (!key || reconnect !== undefined) return;
  reconnect = setTimeout(() => {
    reconnect = undefined;
    connect();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 8000);
}

function connect(): void {
  if (!key || socket) return;
  status("Connecting to Helm…");
  let connection: WebSocket;
  try { connection = new WebSocket(address); }
  catch (error) {
    status(`Could not open the Helm bridge. ${errorMessage(error)}`);
    scheduleReconnect();
    return;
  }
  socket = connection;
  authenticated = false;
  let rejected = false;
  connection.onopen = () => send(connection, { type: "hello", protocol: 1, key });
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
      try { localStorage.setItem(storageKey, key); } catch { /* Pair again if storage is unavailable. */ }
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
    if (!rejected) {
      status("Waiting for the Helm desktop app…");
      scheduleReconnect();
    }
  };
}

function stop(): void {
  clearTimeout(reconnect);
  reconnect = undefined;
  const connection = socket;
  socket = undefined;
  authenticated = false;
  connection?.close();
}

function bindPanel(): void {
  const input = document.getElementById("key") as HTMLInputElement | null;
  if (!input || bindPending) return;
  bindPending = true;
  input.value = key;
  status(statusText);
  document.getElementById("connect")?.addEventListener("click", () => {
    const candidate = input.value.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(candidate)) { status("Paste the 32-character pairing key from Helm settings."); return; }
    stop();
    key = candidate;
    retryMs = 750;
    connect();
  });
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
  try { key ||= localStorage.getItem(storageKey) || ""; } catch { /* The panel can still pair for this session. */ }
  bindPanel();
  connect();
}

entrypoints.setup({
  plugin: { create: start, destroy: stop },
  panels: { helmBridge: { show: start } },
});
document.addEventListener("DOMContentLoaded", start);
