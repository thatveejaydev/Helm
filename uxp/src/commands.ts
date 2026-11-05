import type { Action, AudioTrack, ClipProjectItem, Component, FolderItem, Project, ProjectItem, Sequence, VideoTrack, premierepro } from "@adobe/premierepro";
import type { ProjectMedia, ProjectMediaCatalog } from "../../shared/protocol";
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
): AsyncGenerator<{ item: ProjectItem; bins: string[]; binIds: string[] }> {
  for (const item of await folder.getItems()) {
    if (item.type === ppro.ProjectItem.TYPE_BIN) {
      yield { item, bins, binIds };
      yield* projectClips(ppro, ppro.FolderItem.cast(item), sequences, [...bins, item.name], [...binIds, item.getId()]);
    } else if (item.type === ppro.ProjectItem.TYPE_CLIP || sequences.has(item.getId())) {
      yield { item, bins, binIds };
    }
  }
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

async function listProjectMedia(ppro: premierepro): Promise<ProjectMediaCatalog> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Open a Premiere project first.");
  const sequences = await projectSequences(project);
  const active = await project.getActiveSequence();
  const items: ProjectMediaCatalog["items"] = [];
  for await (const { item, bins, binIds } of projectClips(ppro, await project.getRootItem(), sequences)) {
    const id = item.getId();
    if (item.type === ppro.ProjectItem.TYPE_BIN) {
      items.push({ id, name: item.name, bins, binIds, mediaType: "bin" });
      continue;
    }
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

async function openProjectSource(ppro: premierepro, value: unknown) {
  const selection = value as { projectId?: unknown; id?: unknown } | null | undefined;
  const project = await ppro.Project.getActiveProject();
  if (!project || selection?.projectId !== project.guid.toString() || typeof selection.id !== "string") {
    throw new Error("The active project changed. Search the project again.");
  }
  const sequences = await projectSequences(project);
  for await (const { item } of projectClips(ppro, await project.getRootItem(), sequences)) {
    if (item.type === ppro.ProjectItem.TYPE_BIN || item.getId() !== selection.id) continue;
    const sequence = sequences.get(selection.id);
    if (!sequence && await ppro.ClipProjectItem.cast(item).isOffline()) {
      throw new Error("Relink this clip in Premiere before opening it.");
    }
    if ((await ppro.Project.getActiveProject())?.guid.toString() !== selection.projectId) {
      throw new Error("The active project changed. Search the project again.");
    }
    if (sequence) {
      if (!await project.openSequence(sequence)) throw new Error(`Premiere could not open ${item.name} in the timeline.`);
      return { message: `Opened ${item.name} in the timeline.` };
    }
    if (!await ppro.SourceMonitor.openProjectItem(item)) {
      throw new Error(`${item.name} cannot be viewed in the Source Monitor.`);
    }
    return { message: `Opened ${item.name} in the Source Monitor.` };
  }
  throw new Error("This item is no longer in the project. Search the project again.");
}

async function availableTrack(
  ppro: premierepro,
  sequence: Sequence,
  media: "video" | "audio",
  preferred: number | undefined,
  start: bigint,
  duration: bigint,
): Promise<number> {
  const video = media === "video";
  const count = await (video ? sequence.getVideoTrackCount() : sequence.getAudioTrackCount());
  if (count === 0) return 0;
  const order = Array.from({ length: count }, (_, index) => index).filter((index) => index !== preferred);
  if (preferred !== undefined && preferred < count) order.unshift(preferred);
  const end = start + duration;
  for (const index of order) {
    const track: VideoTrack | AudioTrack = await (video ? sequence.getVideoTrack(index) : sequence.getAudioTrack(index));
    const items = [
      ...(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) ?? []),
      ...(track.getTrackItems(ppro.Constants.TrackItemType.TRANSITION, false) ?? []),
    ].filter((item) => item != null);
    if (duration <= 0n && items.length) continue;
    const occupied = await Promise.all(items.map(async (item) => {
      if (typeof item.getStartTime !== "function" || typeof item.getEndTime !== "function") return true;
      const [inPoint, outPoint] = await Promise.all([item.getStartTime(), item.getEndTime()]);
      if (!inPoint || !outPoint) return true;
      return BigInt(inPoint.ticks) < end && BigInt(outPoint.ticks) > start;
    }));
    if (!occupied.some(Boolean)) return index;
  }
  throw new Error(`No ${media} track has enough room at the playhead. Add a track or move the playhead.`);
}

async function insertProjectMedia(ppro: premierepro, value: unknown) {
  const selection = value as { projectId?: unknown; id?: unknown; videoTrack?: unknown; audioTrack?: unknown } | null | undefined;
  const { project, sequence } = await activeTimeline(ppro);
  if (selection?.projectId !== project.guid.toString() || typeof selection.id !== "string") {
    throw new Error("The active project changed. Switch to Project search again.");
  }
  const sequences = await projectSequences(project);
  for await (const { item } of projectClips(ppro, await project.getRootItem(), sequences)) {
    if (item.type === ppro.ProjectItem.TYPE_BIN || item.getId() !== selection.id) continue;
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
    return { message: `Inserted ${item.name} at the playhead.` };
  }
  throw new Error("This clip is no longer in the project. Switch to Project search again.");
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
