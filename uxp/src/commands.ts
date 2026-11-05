import type { Action, AudioTrack, ClipProjectItem, Component, FolderItem, Project, ProjectItem, Sequence, VideoTrack, premierepro } from "@adobe/premierepro";
import type { ProjectCatalogKey, ProjectCatalogReply, ProjectItemLookup, ProjectMedia, ProjectMediaCatalog } from "../../shared/protocol";
import { discoverEffects, isAudio, isVideo, selectedClips } from "./effects";

function commit(project: Project, label: string, createActions: () => Action[]): void {
  project.lockedAccess(() => {
    const actions = createActions();
    if (actions.some((action) => !action) || !project.executeTransaction((transaction) => {
      for (const action of actions) transaction.addAction(action);
    }, `Helm · ${label}`)) throw new Error(`Premiere rejected ${label.toLowerCase()}.`);
  });
}

async function activeTimeline(ppro: premierepro) {
  const project = await ppro.Project.getActiveProject();
  const sequence = await project?.getActiveSequence();
  if (!project || !sequence) throw new Error("Open a timeline sequence in Premiere first.");
  return { project, sequence };
}

async function* projectClips(
  ppro: premierepro,
  folder: FolderItem,
  sequences: ReadonlyMap<string, Sequence>,
  bins: string[] = [],
  binIds: string[] = [],
): AsyncGenerator<{ item: ProjectItem; bins: string[]; binIds: string[]; parent: FolderItem }> {
  for (const item of await folder.getItems()) {
    if (item.type === ppro.ProjectItem.TYPE_BIN) {
      yield { item, bins, binIds, parent: folder };
      yield* projectClips(ppro, ppro.FolderItem.cast(item), sequences, [...bins, item.name], [...binIds, item.getId()]);
    } else if (item.type === ppro.ProjectItem.TYPE_CLIP || sequences.has(item.getId())) {
      yield { item, bins, binIds, parent: folder };
    }
  }
}

const projectLookups = new WeakMap<premierepro, { projectId: string; parents: Map<string, FolderItem> }>();

export function clearProjectLookup(ppro: premierepro): void {
  projectLookups.delete(ppro);
}

async function findProjectItem(ppro: premierepro, project: Project, id: string) {
  const start = performance.now();
  const sequences = await projectSequences(project);
  const lookup = projectLookups.get(ppro);
  const parents = lookup?.projectId === project.guid.toString() ? lookup.parents : undefined;
  const result = (item: ProjectItem, source: ProjectItemLookup["source"]) => ({
    item, sequences, lookup: { source, elapsedMs: Math.round(performance.now() - start) },
  });
  const parent = parents?.get(id);
  if (parent) {
    try {
      // Resolve a live handle in its last known bin, so moved or deleted items fall through.
      const item = (await parent.getItems()).find((child) => child.type !== ppro.ProjectItem.TYPE_BIN && child.getId() === id);
      if (item) return result(item, "cache");
    } catch { /* Premiere may have invalidated the bin handle. */ }
    parents?.delete(id);
  }
  for await (const { item, parent } of projectClips(ppro, await project.getRootItem(), sequences)) {
    if (item.type === ppro.ProjectItem.TYPE_BIN || item.getId() !== id) continue;
    parents?.set(id, parent);
    return result(item, "scan");
  }
  throw new Error("This item is no longer in the project. Search the project again.");
}

async function projectSequences(project: Project): Promise<Map<string, Sequence>> {
  return new Map(await Promise.all((await project.getSequences()).map(async (sequence) =>
    [(await sequence.getProjectItem()).getId(), sequence] as const)));
}

async function checkNesting(
  ppro: premierepro, source: Sequence, destination: Sequence, sequences: ReadonlyMap<string, Sequence>,
): Promise<void> {
  const pending = [source];
  const visited = new Set<string>();
  const destinationId = destination.guid.toString();
  for (const sequence of pending) {
    const id = sequence.guid.toString();
    if (id === destinationId) throw new Error("This insert would nest the active sequence into itself.");
    if (visited.has(id)) continue;
    visited.add(id);
    const [videoCount, audioCount] = await Promise.all([sequence.getVideoTrackCount(), sequence.getAudioTrackCount()]);
    const tracks = await Promise.all([
      ...Array.from({ length: videoCount }, (_, index) => sequence.getVideoTrack(index)),
      ...Array.from({ length: audioCount }, (_, index) => sequence.getAudioTrack(index)),
    ]);
    for (const track of tracks) {
      for (const clip of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) ?? []) {
        if (!clip) continue;
        const item = await clip.getProjectItem();
        const nested = item && sequences.get(item.getId());
        if (nested) pending.push(nested);
      }
    }
  }
}

async function listProjectMedia(ppro: premierepro, parents?: Map<string, FolderItem>): Promise<ProjectMediaCatalog> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Open a Premiere project first.");
  const sequences = await projectSequences(project);
  const active = await project.getActiveSequence();
  const items: ProjectMediaCatalog["items"] = [];
  for await (const { item, bins, binIds, parent } of projectClips(ppro, await project.getRootItem(), sequences)) {
    const id = item.getId();
    if (item.type === ppro.ProjectItem.TYPE_BIN) {
      items.push({ id, name: item.name, bins, binIds, mediaType: "bin" });
      continue;
    }
    parents?.set(id, parent);
    const sequence = sequences.get(id);
    if (sequence) {
      if (sequence.guid.toString() !== active?.guid.toString()) {
        items.push({ id, name: item.name, bins, binIds, mediaType: "sequence" });
      }
      continue;
    }
    const clip = ppro.ClipProjectItem.cast(item);
    let mediaType: ProjectMedia["mediaType"] = "other";
    try {
      const path = await clip.getMediaFilePath();
      if (!path && !await clip.isOffline()) mediaType = "generated";
      else if (/\.(wav|mp3|aac|m4a|aif|aiff|flac|ogg|opus|wma|ac3)$/i.test(path)) mediaType = "audio";
      else if (/\.(png|jpe?g|gif|bmp|tiff?|webp|psd|heic|exr|dpx|tga|svg|ai)$/i.test(path)) mediaType = "image";
      else if (/\.(mp4|mov|mxf|avi|mkv|webm|mts|m2ts|m4v|mpg|mpeg|wmv|r3d|braw|crm|ari)$/i.test(path)) mediaType = "video";
    } catch {
      // Unavailable media metadata should not hide a searchable project item.
    }
    items.push({ id, name: item.name, bins, binIds, mediaType });
  }
  return { projectId: project.guid.toString(), items };
}

export async function readProjectCatalog(
  ppro: premierepro, known: unknown, revision: () => number,
): Promise<ProjectCatalogReply> {
  const getKey = async (): Promise<ProjectCatalogKey> => {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Open a Premiere project first.");
    const sequence = await project.getActiveSequence();
    return { projectId: project.guid.toString(), sequenceId: sequence?.guid.toString() ?? null, revision: revision() };
  };
  const key = await getKey();
  const matches = (other?: Partial<ProjectCatalogKey> | null) =>
    key.projectId === other?.projectId && key.sequenceId === other.sequenceId && key.revision === other.revision;
  if (matches(known as Partial<ProjectCatalogKey> | null)) return { key };
  const parents = new Map<string, FolderItem>();
  const catalog = await listProjectMedia(ppro, parents);
  if (catalog.projectId !== key.projectId || !matches(await getKey())) {
    throw new Error("The Premiere project changed during the scan.");
  }
  projectLookups.set(ppro, { projectId: key.projectId, parents });
  return { key, catalog };
}

async function openProjectSource(ppro: premierepro, value: unknown) {
  const selection = value as { projectId?: unknown; id?: unknown } | null | undefined;
  const project = await ppro.Project.getActiveProject();
  if (!project || selection?.projectId !== project.guid.toString() || typeof selection.id !== "string") {
    throw new Error("The active project changed. Search the project again.");
  }
  const { item, sequences, lookup } = await findProjectItem(ppro, project, selection.id);
  const sequence = sequences.get(selection.id);
  if (!sequence && await ppro.ClipProjectItem.cast(item).isOffline()) {
    throw new Error("Relink this clip in Premiere before opening it.");
  }
  if ((await ppro.Project.getActiveProject())?.guid.toString() !== selection.projectId) {
    throw new Error("The active project changed. Search the project again.");
  }
  if (sequence) {
    if (!await project.openSequence(sequence)) throw new Error(`Premiere could not open ${item.name} in the timeline.`);
    return { lookup, message: `Opened ${item.name} in the timeline.` };
  }
  if (!await ppro.SourceMonitor.openProjectItem(item)) {
    throw new Error(`${item.name} cannot be viewed in the Source Monitor.`);
  }
  return { lookup, message: `Opened ${item.name} in the Source Monitor.` };
}

async function availableTrack(
  ppro: premierepro,
  sequence: Sequence,
  media: "video" | "audio",
  preferred: number | undefined,
  start: bigint,
  duration: bigint,
  firstTrack = 0,
  allowNewTrack = false,
): Promise<number> {
  const video = media === "video";
  const count = await (video ? sequence.getVideoTrackCount() : sequence.getAudioTrackCount());
  if (count === 0 && firstTrack === 0) return 0;
  const order = Array.from({ length: Math.max(0, count - firstTrack) }, (_, index) => firstTrack + index)
    .filter((index) => index !== preferred);
  if (preferred !== undefined && preferred < count) order.unshift(preferred);
  for (const index of order) {
    const track: VideoTrack | AudioTrack = await (video ? sequence.getVideoTrack(index) : sequence.getAudioTrack(index));
    if (await trackHasRoom(ppro, track, start, duration)) return index;
  }
  if (allowNewTrack) return count;
  if (firstTrack > 0) throw new Error("No video track above the selected clip has enough room. Add a video track above it.");
  throw new Error(`No ${media} track has enough room at the playhead. Add a track or move the playhead.`);
}

async function trackHasRoom(ppro: premierepro, track: VideoTrack | AudioTrack, start: bigint, duration?: bigint) {
  const items = [
    ...(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) ?? []),
    ...(track.getTrackItems(ppro.Constants.TrackItemType.TRANSITION, false) ?? []),
  ].filter((item) => item != null);
  if (duration !== undefined && duration <= 0n) return items.length === 0;
  const end = duration === undefined ? undefined : start + duration;
  const occupied = await Promise.all(items.map(async (item) => {
    if (typeof item.getStartTime !== "function" || typeof item.getEndTime !== "function") return true;
    const [inPoint, outPoint] = await Promise.all([item.getStartTime(), item.getEndTime()]);
    if (!inPoint || !outPoint) return true;
    return (end === undefined || BigInt(inPoint.ticks) < end) && BigInt(outPoint.ticks) > start;
  }));
  return !occupied.some(Boolean);
}

async function adjustmentLayerCommand(ppro: premierepro, configure: boolean) {
  const { project, sequence, clips } = await selectedClips(ppro);
  const videoClips = clips.filter((clip) => isVideo(ppro, clip));
  if (!videoClips.length) throw new Error("Select at least one video clip in the timeline.");
  const projectId = project.guid.toString();
  const sourceKey = `helm-adjustment-layer:${projectId}`;
  if (configure) {
    if (videoClips.length !== 1) throw new Error("Select exactly one adjustment layer as the source.");
    const target = videoClips[0];
    if (!await target.isAdjustmentLayer()) throw new Error("Select an adjustment layer in the timeline to use as the source.");
    const item = await target.getProjectItem();
    localStorage.setItem(sourceKey, item.getId());
    return { message: `Set ${item.name} as this project's adjustment layer source.` };
  }
  const sourceId = localStorage.getItem(sourceKey);
  if (!sourceId) throw new Error("Run Set Adjustment Layer Source in Commands for this project first.");
  const { item } = await findProjectItem(ppro, project, sourceId);
  const spans = await Promise.all(videoClips.map(async (clip) => {
    const [start, end, track] = await Promise.all([clip.getStartTime(), clip.getEndTime(), clip.getTrackIndex()]);
    return { start, end, track };
  }));
  const start = spans.reduce((first, span) => BigInt(span.start.ticks) < BigInt(first.ticks) ? span.start : first, spans[0].start);
  const end = spans.reduce((last, span) => BigInt(span.end.ticks) > BigInt(last.ticks) ? span.end : last, spans[0].end);
  const targetTrack = Math.max(...spans.map(({ track }) => track));
  const startTicks = BigInt(start.ticks);
  const duration = BigInt(end.ticks) - startTicks;
  if (duration <= 0n) throw new Error("The selected clip has no duration.");
  const video = ppro.Constants.MediaType.VIDEO;
  const trackIndex = await availableTrack(ppro, sequence, "video", undefined, startTicks, duration, targetTrack + 1, true);
  const newTrack = trackIndex === await sequence.getVideoTrackCount();
  const existingTrack = newTrack ? undefined : await sequence.getVideoTrack(trackIndex);
  const active = await activeTimeline(ppro);
  if (active.project.guid.toString() !== projectId || active.sequence.guid.toString() !== sequence.guid.toString()) {
    throw new Error("The active timeline changed. Try again.");
  }
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const clipType = ppro.Constants.TrackItemType.CLIP;
  const findLayer = async (track: VideoTrack, ticks: string) => {
    const candidates = await Promise.all((track.getTrackItems(clipType, false) ?? []).filter(Boolean).map(async (clip) => {
      const position = await clip.getStartTime();
      return position?.ticks === ticks && (await clip.getProjectItem())?.getId() === sourceId ? clip : undefined;
    }));
    const matches = candidates.filter((clip) => clip !== undefined);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const removeLayer = (layer: NonNullable<Awaited<ReturnType<typeof findLayer>>>) => {
    let action: Action | undefined;
    ppro.TrackItemSelection.createEmptySelection((selection) => {
      if (selection.addItem(layer)) action = editor.createRemoveItemsAction(selection, false, video, false);
    });
    if (!action) throw new Error("Could not select the prepared layer for removal.");
    return action;
  };
  const message = { message: `Added a matching adjustment layer on V${trackIndex + 1}.` };
  const source = ppro.ClipProjectItem.cast(item);
  const [sourceIn, sourceOut] = await Promise.all([source.getInPoint(video), source.getOutPoint(video)]).catch(() => []);
  // Generated media can ignore source marks. Only try a direct overwrite when no later edit is at risk.
  if (existingTrack && sourceIn && sourceOut && BigInt(sourceOut.ticks) > BigInt(sourceIn.ticks) &&
      await trackHasRoom(ppro, existingTrack, startTicks)) {
    const sourceEnd = ppro.TickTime.createWithTicks(String(BigInt(sourceIn.ticks) + duration));
    const needsMarks = sourceEnd.ticks !== sourceOut.ticks;
    let inserted = false;
    if (needsMarks) commit(project, "Set adjustment layer source duration", () => [source.createSetInOutPointsAction(sourceIn, sourceEnd)]);
    try {
      const [markedIn, markedOut] = await Promise.all([source.getInPoint(video), source.getOutPoint(video)]);
      if (markedIn?.ticks === sourceIn.ticks && markedOut?.ticks === sourceEnd.ticks &&
          await trackHasRoom(ppro, existingTrack, startTicks)) {
        const current = await activeTimeline(ppro);
        if (current.project.guid.toString() !== projectId || current.sequence.guid.toString() !== sequence.guid.toString()) {
          throw new Error("The active timeline changed. Try again.");
        }
        commit(project, "Place adjustment layer above clips", () => [editor.createOverwriteItemAction(item, start, trackIndex, 0)]);
        inserted = true;
      }
    } finally {
      if (needsMarks) commit(project, "Restore adjustment layer source marks", () => [source.createSetInOutPointsAction(sourceIn, sourceOut)]);
    }
    if (inserted) {
      const layer = await findLayer(existingTrack, start.ticks);
      if (!layer) throw new Error("Could not identify the placed layer. Check the timeline before retrying.");
      if ((await layer.getEndTime()).ticks === end.ticks) return message;
      commit(project, "Remove unmatched adjustment layer", () => [removeLayer(layer)]);
    }
  }
  // Prepare the exact length away from existing edits when direct placement is unsafe.
  const insertStart = await sequence.getEndTime();
  const insertTicks = BigInt(insertStart.ticks);
  if (insertTicks < BigInt(end.ticks)) throw new Error("The sequence end changed. Try again.");
  const trimEnd = ppro.TickTime.createWithTicks(String(insertTicks + duration));
  // Premiere creates the track when the insert targets the next unused index.
  commit(project, "Prepare adjustment layer", () => [editor.createInsertProjectItemAction(item, insertStart, trackIndex, 0, true)]);
  const track = existingTrack ?? await sequence.getVideoTrack(trackIndex);
  const layer = await findLayer(track, insertStart.ticks);
  if (!layer) throw new Error("Could not identify the prepared layer. Check the timeline and undo the insert before retrying.");
  try {
    if ((await layer.getEndTime()).ticks !== trimEnd.ticks) {
      commit(project, "Match adjustment layer duration", () => [layer.createSetEndAction(trimEnd)]);
    }
    if ((await layer.getStartTime()).ticks !== insertStart.ticks || (await layer.getEndTime()).ticks !== trimEnd.ticks) {
      throw new Error("Premiere could not match the clip's duration.");
    }
    if (!await trackHasRoom(ppro, track, startTicks, duration)) throw new Error("The destination track is no longer free.");
    const offset = ppro.TickTime.createWithTicks(String(startTicks - insertTicks));
    commit(project, "Place adjustment layer above clip", () => [
      editor.createCloneTrackItemAction(layer, offset, 0, 0, true, false),
      removeLayer(layer),
    ]);
  } catch (error) {
    try {
      if (await findLayer(track, insertStart.ticks)) commit(project, "Remove prepared adjustment layer", () => [removeLayer(layer)]);
    } catch {
      throw new Error("Premiere could not match or remove the adjustment layer. Check the timeline before retrying.");
    }
    throw error;
  }
  const placed = await findLayer(track, start.ticks);
  if (!placed || (await placed.getEndTime()).ticks !== end.ticks) {
    throw new Error("Premiere did not place the layer at the expected time. Check the timeline and undo placement before retrying.");
  }
  return message;
}

async function insertProjectMedia(ppro: premierepro, value: unknown) {
  const selection = value as { projectId?: unknown; id?: unknown; videoTrack?: unknown; audioTrack?: unknown } | null | undefined;
  const { project, sequence } = await activeTimeline(ppro);
  if (selection?.projectId !== project.guid.toString() || typeof selection.id !== "string") {
    throw new Error("The active project changed. Switch to Project search again.");
  }
  const { item, sequences, lookup } = await findProjectItem(ppro, project, selection.id);
  const sourceSequence = sequences.get(selection.id);
  const clip = sourceSequence ? undefined : ppro.ClipProjectItem.cast(item);
  if (sourceSequence) await checkNesting(ppro, sourceSequence, sequence, sequences);
  if (clip && await clip.isOffline()) throw new Error("Relink this clip in Premiere before inserting it.");
  const position = await sequence.getPlayerPosition();
  const start = BigInt(position.ticks);
  const preferred = (track: unknown) => typeof track === "number" && Number.isSafeInteger(track) && track > 0 ? track - 1 : undefined;
  const range = async (type: Parameters<ClipProjectItem["getInPoint"]>[0]) => {
    if (!clip) return 0n;
    try {
      const [inPoint, outPoint] = await Promise.all([clip.getInPoint(type), clip.getOutPoint(type)]);
      return BigInt(outPoint.ticks) - BigInt(inPoint.ticks);
    } catch {
      return 0n;
    }
  };
  const [videoDuration, audioDuration] = await Promise.all([
    range(ppro.Constants.MediaType.VIDEO), range(ppro.Constants.MediaType.AUDIO),
  ]);
  let fallbackDuration = 0n;
  if (sourceSequence) {
    fallbackDuration = BigInt((await sourceSequence.getEndTime()).ticks);
    if (fallbackDuration <= 0n) throw new Error("The source sequence is empty.");
  } else if (clip && videoDuration <= 0n && audioDuration <= 0n) {
    try { fallbackDuration = BigInt((await clip.getMedia()).getDuration().ticks); } catch { /* Require empty tracks when duration is unknown. */ }
  }
  const [videoTrack, audioTrack] = await Promise.all([
    videoDuration > 0n || audioDuration <= 0n
      ? availableTrack(ppro, sequence, "video", preferred(selection.videoTrack), start, videoDuration || fallbackDuration) : 0,
    audioDuration > 0n || videoDuration <= 0n
      ? availableTrack(ppro, sequence, "audio", preferred(selection.audioTrack), start, audioDuration || fallbackDuration) : 0,
  ]);
  const active = await activeTimeline(ppro);
  if (active.project.guid.toString() !== selection.projectId || active.sequence.guid.toString() !== sequence.guid.toString()) {
    throw new Error("The active timeline changed. Try again.");
  }
  const editor = ppro.SequenceEditor.getEditor(sequence);
  // Insert remains non-destructive if Premiere changes the timeline after the occupancy reads.
  commit(project, `Insert ${item.name}`, () => [editor.createInsertProjectItemAction(item, position, videoTrack, audioTrack, true)]);
  return { lookup, message: `Inserted ${item.name} at the playhead.` };
}

async function editClips(ppro: premierepro, command: string, value: unknown) {
  const { project, sequence, clips } = await selectedClips(ppro);
  const remove = command === "remove-attributes";
  const opacity = command === "set-opacity";
  if (!remove && (typeof value !== "number" || !Number.isFinite(value) ||
    (opacity ? value < 0 || value > 100 : value < -100 || value > 15))) {
    throw new Error(opacity ? "Enter an opacity between 0 and 100%." : "Enter a volume between −100 and +15 dB.");
  }
  // The factory catalog identifies applied filters while protecting intrinsic and graphics components.
  const catalog = remove ? await discoverEffects(ppro) : [];
  const videoFilters = new Set(catalog.filter((effect) => effect.kind === "video").map((effect) => effect.matchName));
  const audioFilters = new Set(catalog.filter((effect) => effect.kind === "audio").map((effect) => effect.name));
  const plans: (() => Action[])[] = [];
  for (const clip of clips) {
    const video = isVideo(ppro, clip);
    if (!video && !isAudio(ppro, clip)) continue;
    if (!remove && video !== opacity) continue;
    const chain = await clip.getComponentChain();
    if (!chain) continue;
    const actions: (() => Action)[] = [];
    for (let index = 0; index < chain.getComponentCount(); index++) {
      const component: Component = chain.getComponentAtIndex(index);
      const match = await component.getMatchName();
      const name = await component.getDisplayName();
      const fixed = /^(?:ae\.adbe )?(?:motion|opacity|time remapping|volume|channel volume|panner|balance)$/i;
      const internal = /^internal\b/i.test(match);
      if (remove) {
        if (!internal && !fixed.test(match) && !fixed.test(name) && (video ? videoFilters.has(match) : audioFilters.has(name))) {
          actions.push(() => chain.createRemoveComponentAction(component));
        }
        continue;
      }
      const target = opacity ? /^ae\.adbe opacity$/i.test(match) : /^(?:internal volume\b|audiovolume$)/i.test(match);
      if (!target) continue;
      for (let position = 0; position < component.getParamCount(); position++) {
        const param = component.getParam(position);
        if (param.displayName !== (opacity ? "Opacity" : "Level")) continue;
        // Premiere's normalized Volume Level uses 1 at +15 dB.
        const level = opacity ? Number(value) : Math.pow(10, (Number(value) - 15) / 20);
        if (!param.isTimeVarying()) actions.push(() => {
          if (param.isTimeVarying()) throw new Error("The clip became keyframed. Try again.");
          return param.createSetValueAction(param.createKeyframe(level), true);
        });
        break;
      }
      break;
    }
    if (actions.length) {
      actions.reverse();
      plans.push(() => actions.map((create) => create()));
    }
  }
  if (!plans.length) throw new Error(remove ? "No removable effects were found on the selected clips." :
    opacity ? "Select a video clip with static opacity." : "Select an audio clip with static volume.");
  const active = await activeTimeline(ppro);
  if (active.project.guid.toString() !== project.guid.toString() || active.sequence.guid.toString() !== sequence.guid.toString()) {
    throw new Error("The active timeline changed. Try again.");
  }
  const label = remove ? "Remove applied effects" : opacity ? "Set opacity" : "Set clip volume";
  commit(project, label, () => plans.flatMap((create) => create()));
  const skipped = clips.length - plans.length;
  return { message: `${label} · ${plans.length} clip${plans.length === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped` : ""}` };
}

export async function runCommand(ppro: premierepro, command: unknown, value: unknown) {
  switch (command) {
    case "set-adjustment-layer-source":
    case "add-adjustment-layer":
      return adjustmentLayerCommand(ppro, command === "set-adjustment-layer-source");
    case "list-project-media":
      return listProjectMedia(ppro);
    case "insert-project-media":
      return insertProjectMedia(ppro, value);
    case "open-project-source":
      return openProjectSource(ppro, value);
    case "remove-attributes":
    case "set-opacity":
    case "set-volume":
      return editClips(ppro, command, value);
    case "add-marker":
    case "list-markers":
    case "go-to-marker": {
      const { project, sequence } = await activeTimeline(ppro);
      const markers = await ppro.Markers.getMarkers(sequence);
      if (command === "list-markers") {
        return { markers: markers.getMarkers().map((marker) => ({
          id: marker.guid.toString(), name: marker.getName(), seconds: marker.getStart().seconds,
        })) };
      }
      if (command === "go-to-marker") {
        const marker = markers.getMarkers().find((entry) => entry.guid.toString() === value);
        if (!marker) throw new Error("That marker is unavailable in the active sequence.");
        if (!await sequence.setPlayerPosition(marker.getStart())) throw new Error("Premiere could not move the playhead.");
        return { message: `Jumped to ${marker.getName() || "marker"}.` };
      }
      if (typeof value !== "string" || !value.trim()) throw new Error("Enter a marker name.");
      const position = await sequence.getPlayerPosition();
      commit(project, "Add marker", () => [markers.createAddMarkerAction(
        value.trim(), ppro.Marker.MARKER_TYPE_COMMENT, position,
      )]);
      return { message: `Added marker “${value.trim()}”.` };
    }
    default:
      throw new Error("Unsupported Helm command.");
  }
}
