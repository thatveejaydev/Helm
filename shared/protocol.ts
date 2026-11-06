export type EffectKind = "video" | "audio";

export interface Effect {
  id: string;
  name: string;
  kind: EffectKind;
  matchName: string;
}

export type PresetParamValue =
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "point"; x: number; y: number }
  | { kind: "color"; red: number; green: number; blue: number; alpha: number };

export interface PresetParam {
  index: number;
  name: string;
  value: PresetParamValue;
}

export interface PresetFilter {
  kind: EffectKind;
  name: string;
  matchName: string;
  params: PresetParam[];
}

export interface Preset {
  id: string;
  name: string;
  folders: string[];
  directApply: boolean;
  filters: PresetFilter[];
}

export type CatalogItem = Effect | (Preset & { kind: "preset" });

export interface BridgeSnapshot {
  connected: boolean;
  effects: Effect[];
  error: string | null;
  port: number;
  shortcut: string;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
}

export interface SequenceMarker {
  id: string;
  name: string;
  seconds: number;
}

export interface ProjectMedia {
  mediaType?: "video" | "audio" | "image" | "generated" | "sequence" | "bin" | "other";
  binIds?: string[];
  id: string;
  name: string;
  bins: string[];
}

export interface ProjectMediaCatalog {
  projectId: string;
  items: ProjectMedia[];
}

export interface ProjectCatalogKey {
  projectId: string;
  sequenceId: string | null;
  revision: number;
  catalogVersion?: number;
}

export interface ProjectCatalogReply {
  key: ProjectCatalogKey;
  catalog?: ProjectMediaCatalog;
  incremental?: { added: number; reused: number; metadataReads: number };
}

export interface ProjectItemLookup {
  source: "cache" | "scan";
  elapsedMs: number;
}
