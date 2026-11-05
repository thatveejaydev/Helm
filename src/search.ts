import type { CatalogItem } from "../shared/protocol";

export interface SearchEntry {
  effect: CatalogItem;
  normalized: string;
  words: string[];
  folderSearch: string;
}

export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

export function indexEffects(effects: CatalogItem[]): SearchEntry[] {
  return effects.map((effect) => {
    const normalized = normalize(effect.name);
    const folderSearch = effect.kind === "preset" ? normalize([...effect.folders.slice(1), effect.name].join(" ")) : "";
    return { effect, normalized, words: normalized.split(/[^\p{L}\p{N}]+/u), folderSearch };
  });
}

function score(entry: SearchEntry, query: string): number {
  if (entry.normalized === query) return 0;
  if (entry.normalized.startsWith(query)) return 10;
  if (entry.words.some((word) => word.startsWith(query))) return 20;
  const position = entry.normalized.indexOf(query);
  if (position >= 0) return 30 + position;
  if (entry.folderSearch && query.split(/\s+/).every((word) => entry.folderSearch.includes(word))) return 80;

  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const found = entry.normalized.indexOf(character, cursor);
    if (found < 0) return Infinity;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 100 + gaps;
}

export function searchEffects(
  index: SearchEntry[],
  query: string,
  kind: CatalogItem["kind"] | "all",
  recent: string[],
  limit = 9,
): CatalogItem[] {
  const normalized = normalize(query);
  return index
    .filter(({ effect }) => kind === "all" || effect.kind === kind)
    .map((entry) => {
      const recentIndex = recent.indexOf(entry.effect.id);
      return {
        entry,
        rank: normalized ? score(entry, normalized) : recentIndex < 0 ? 1000 : recentIndex,
      };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank || a.entry.effect.name.localeCompare(b.entry.effect.name))
    .slice(0, limit)
    .map(({ entry }) => entry.effect);
}
