import type { Action, Component, Project, premierepro } from "@adobe/premierepro";
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
