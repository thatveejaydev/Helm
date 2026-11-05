import type { CatalogItem, ProjectMedia } from "../shared/protocol";

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

export function score(entry: Omit<SearchEntry, "effect">, query: string): number {
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

export function indexProjectMedia(items: ProjectMedia[]) {
  return items.map((item) => {
    const normalized = normalize(item.name);
    return {
      item, normalized, words: normalized.split(/[^\p{L}\p{N}]+/u),
      folderSearch: normalize([...item.bins, item.name].join(" ")),
    };
  });
}

export function searchProjectMedia(index: ReturnType<typeof indexProjectMedia>, query: string, limit = 60): ProjectMedia[] {
  return rankProjectMedia(index, query, limit).map(({ item }) => item);
}

export function rankProjectMedia(index: ReturnType<typeof indexProjectMedia>, query: string, limit: number) {
  const normalized = normalize(query);
  return index
    .map((entry) => ({ item: entry.item, rank: normalized ? score(entry, normalized) : 0 }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name) ||
      a.item.bins.join("/").localeCompare(b.item.bins.join("/")))
    .slice(0, limit);
}

export function searchEffects(
  index: SearchEntry[],
  query: string,
  kind: CatalogItem["kind"] | "all",
  recent: string[],
  limit = 9,
): CatalogItem[] {
  return rankEffects(index, query, kind, recent, limit).map(({ item }) => item);
}

export function rankEffects(
  index: SearchEntry[], query: string, kind: CatalogItem["kind"] | "all", recent: string[], limit: number,
) {
  const normalized = normalize(query);
  return index
    .filter(({ effect }) => kind === "all" || effect.kind === kind)
    .map((entry) => {
      const recentIndex = recent.indexOf(entry.effect.id);
      return {
        item: entry.effect,
        rank: normalized ? score(entry, normalized) : recentIndex < 0 ? 1000 : recentIndex,
      };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name))
    .slice(0, limit);
}

export function mergeSearchResults<T extends { name: string }>(
  groups: { item: T; rank: number }[][], query: string, limit: number,
): T[] {
  const mixed = Array.from({ length: limit }, (_, index) =>
    groups.flatMap((group) => group.slice(index, index + 1))).flat();
  if (normalize(query)) mixed.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
  return mixed.slice(0, limit).map(({ item }) => item);
}
