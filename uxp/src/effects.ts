import type { Action, AudioClipTrackItem, Component, Project, VideoClipTrackItem, premierepro } from "@adobe/premierepro";
import type { ApplyResult, Effect, PresetFilter, PresetParam, PresetParamValue } from "../../shared/protocol";

type Clip = VideoClipTrackItem | AudioClipTrackItem;

export async function discoverEffects(ppro: premierepro): Promise<Effect[]> {
  const [matchNames, displayNames, audioNames] = await Promise.all([
    ppro.VideoFilterFactory.getMatchNames(),
    ppro.VideoFilterFactory.getDisplayNames(),
    ppro.AudioFilterFactory.getDisplayNames(),
  ]);
  const effects = new Map<string, Effect>();
  const pairedNames = matchNames.length === displayNames.length;
  for (const [index, matchName] of matchNames.entries()) {
    if (!matchName) continue;
    // If a host returns unmatched arrays, keep the actual ID visible rather than pairing by guesswork.
    const name = (pairedNames && displayNames[index]) || matchName;
    const id = `video:${matchName}`;
    effects.set(id, { id, name, matchName, kind: "video" });
  }
  for (const name of audioNames) {
    if (!name) continue;
    const id = `audio:${name}`;
    effects.set(id, { id, name, matchName: name, kind: "audio" });
  }
  return Array.from(effects.values());
}

function isVideo(ppro: premierepro, clip: Clip): clip is VideoClipTrackItem {
  return clip instanceof (ppro.VideoClipTrackItem as unknown as { new (): VideoClipTrackItem });
}

function isAudio(ppro: premierepro, clip: Clip): clip is AudioClipTrackItem {
  return clip instanceof (ppro.AudioClipTrackItem as unknown as { new (): AudioClipTrackItem });
}

function toKeyframeValue(ppro: premierepro, paramValue: PresetParamValue): unknown {
  switch (paramValue.kind) {
    case "number":
    case "boolean":
      return paramValue.value;
    case "point":
      try {
        return new (ppro.PointF as unknown as new (x: number, y: number) => unknown)(paramValue.x, paramValue.y);
      } catch {
        return typeof ppro.PointF === "function" ? ppro.PointF(paramValue.x, paramValue.y) : { x: paramValue.x, y: paramValue.y };
      }
    case "color":
      try {
        return new (ppro.Color as unknown as new (r: number, g: number, b: number, a: number) => unknown)(
          paramValue.red,
          paramValue.green,
          paramValue.blue,
          paramValue.alpha,
        );
      } catch {
        return typeof ppro.Color === "function"
          ? ppro.Color(paramValue.red, paramValue.green, paramValue.blue, paramValue.alpha)
          : { red: paramValue.red, green: paramValue.green, blue: paramValue.blue, alpha: paramValue.alpha };
      }
  }
}

function getParamDisplayName(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object") return "";
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.displayName === "string") return obj.displayName;
  if (typeof obj.getDisplayName === "function") {
    try {
      const res = (obj.getDisplayName as () => unknown)();
      if (typeof res === "string") return res;
    } catch {}
  }
  if (typeof obj.name === "string") return obj.name;
  return "";
}

function buildParamActions(ppro: premierepro, component: Component, params: PresetParam[]): Action[] {
  const actions: Action[] = [];
  if (!params.length || typeof component.getParamCount !== "function" || typeof component.getParam !== "function") {
    return actions;
  }
  const count = component.getParamCount();
  for (const presetParam of params) {
    let target: ReturnType<Component["getParam"]> | undefined;
    if (presetParam.name) {
      const needle = presetParam.name.trim().toLowerCase();
      for (let i = 0; i < count; i++) {
        const candidate = component.getParam(i);
        if (getParamDisplayName(candidate).trim().toLowerCase() === needle) {
          target = candidate;
          break;
        }
      }
    }
    if (!target && presetParam.index < count) {
      target = component.getParam(presetParam.index);
    }
    if (!target) {
      console.warn(`[Helm] Parameter "${presetParam.name}" (index ${presetParam.index}) not found on component.`);
      continue;
    }
    try {
      const val = toKeyframeValue(ppro, presetParam.value);
      const kf = target.createKeyframe(val as number);
      const action = target.createSetValueAction(kf, true);
      if (action) actions.push(action);
    } catch (err) {
      console.warn(`[Helm] Could not set parameter "${presetParam.name}" (${presetParam.index}):`, err);
    }
  }
  return actions;
}

async function prepareVideo(ppro: premierepro, clip: VideoClipTrackItem, effect: Effect): Promise<() => Action> {
  const [chain, component] = await Promise.all([
    clip.getComponentChain(), ppro.VideoFilterFactory.createComponent(effect.matchName),
  ]);
  if (!component || !chain) throw new Error(`Premiere could not prepare ${effect.name} for the selected video clip.`);
  return () => chain.createAppendComponentAction(component);
}

async function prepareAudio(ppro: premierepro, clip: AudioClipTrackItem, effect: Effect): Promise<() => Action> {
  const [chain, component] = await Promise.all([
    clip.getComponentChain(), ppro.AudioFilterFactory.createComponentByDisplayName(effect.name, clip),
  ]);
  if (!component || !chain) throw new Error(`Premiere could not prepare ${effect.name} for the selected audio clip.`);
  return () => chain.createAppendComponentAction(component);
}

export async function selectedClips(ppro: premierepro) {
  const project: Project | undefined = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Open a project in Premiere first.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("Open a timeline sequence in Premiere first.");
  const selection = await sequence.getSelection();
  const clips = selection ? await selection.getTrackItems() : [];
  if (!clips.length) throw new Error("Select a timeline clip in Premiere first.");
  return { project, sequence, clips };
}

export async function applyEffect(ppro: premierepro, effect: Effect): Promise<ApplyResult> {
  const { project, sequence, clips } = await selectedClips(ppro);

  const actions: (() => Action)[] = [];
  for (const clip of clips) {
    if (effect.kind === "video" && isVideo(ppro, clip)) actions.push(await prepareVideo(ppro, clip, effect));
    if (effect.kind === "audio" && isAudio(ppro, clip)) actions.push(await prepareAudio(ppro, clip, effect));
  }
  if (!actions.length) throw new Error(`Select a ${effect.kind} clip to apply ${effect.name}.`);
  const activeProject = await ppro.Project.getActiveProject();
  const activeSequence = activeProject && await activeProject.getActiveSequence();
  if (activeProject?.guid.toString() !== project.guid.toString() || activeSequence?.guid.toString() !== sequence.guid.toString()) {
    throw new Error("The active timeline changed while preparing the effect. Try again.");
  }

  let committed = false;
  project.lockedAccess(() => {
    const prepared = actions.map((createAction) => createAction());
    if (prepared.some((action) => !action)) {
      throw new Error(`Premiere could not apply ${effect.name} to this selection.`);
    }
    committed = project.executeTransaction((transaction) => {
      for (const action of prepared) transaction.addAction(action);
    }, `Helm · Apply ${effect.name}`);
  });
  if (!committed) throw new Error(`Premiere rejected ${effect.name}. Check that the clips support it and their tracks are unlocked.`);
  return { applied: actions.length, skipped: clips.length - actions.length };
}

interface PreparedClipFilter {
  chain: {
    createAppendComponentAction(component: unknown): Action;
    getComponentCount(): number;
    getComponentAtIndex(index: number): Component;
  };
  component: unknown;
  params: PresetParam[];
}

export async function applyPreset(
  ppro: premierepro,
  preset: { name: string; filters: PresetFilter[] },
): Promise<ApplyResult> {
  const { project, sequence, clips } = await selectedClips(ppro);
  const clipPlans: PreparedClipFilter[][] = [];

  for (const clip of clips) {
    const forClip: PreparedClipFilter[] = [];
    for (const filter of preset.filters) {
      if (filter.kind === "video" && isVideo(ppro, clip)) {
        const [chain, component] = await Promise.all([
          clip.getComponentChain(),
          ppro.VideoFilterFactory.createComponent(filter.matchName),
        ]);
        if (!component || !chain) {
          throw new Error(`Premiere could not prepare ${filter.name} for the selected video clip.`);
        }
        forClip.push({ chain: chain as unknown as PreparedClipFilter["chain"], component, params: filter.params });
      } else if (filter.kind === "audio" && isAudio(ppro, clip)) {
        const [chain, component] = await Promise.all([
          clip.getComponentChain(),
          ppro.AudioFilterFactory.createComponentByDisplayName(filter.name, clip),
        ]);
        if (!component || !chain) {
          throw new Error(`Premiere could not prepare ${filter.name} for the selected audio clip.`);
        }
        forClip.push({ chain: chain as unknown as PreparedClipFilter["chain"], component, params: filter.params });
      }
    }
    if (forClip.length > 0) clipPlans.push(forClip);
  }

  if (!clipPlans.length) {
    const kinds = Array.from(new Set(preset.filters.map((f) => f.kind)));
    const expected = kinds.length === 1 ? kinds[0] : "compatible";
    throw new Error(`Select a ${expected} clip to apply ${preset.name}.`);
  }

  const activeProject = await ppro.Project.getActiveProject();
  const activeSequence = activeProject && await activeProject.getActiveSequence();
  if (activeProject?.guid.toString() !== project.guid.toString() || activeSequence?.guid.toString() !== sequence.guid.toString()) {
    throw new Error("The active timeline changed while preparing the preset. Try again.");
  }

  const startCounts = clipPlans.map((plan) =>
    typeof plan[0].chain.getComponentCount === "function" ? plan[0].chain.getComponentCount() : 0,
  );

  let committed = false;
  project.lockedAccess(() => {
    const appendActions: Action[] = [];
    for (const plan of clipPlans) {
      for (const item of plan) {
        const action = item.chain.createAppendComponentAction(item.component);
        if (!action) throw new Error(`Premiere could not apply ${preset.name} to this selection.`);
        appendActions.push(action);
      }
    }
    committed = project.executeTransaction((transaction) => {
      for (const action of appendActions) transaction.addAction(action);
    }, `Helm · Apply ${preset.name}`);
  });
  if (!committed) throw new Error(`Premiere rejected ${preset.name}. Check that the clips support it and their tracks are unlocked.`);

  const hasParams = preset.filters.some((f) => f.params.length > 0);
  if (hasParams) {
    const postAttachParamActions: Action[] = [];
    // Re-query the active sequence and selection to get fresh TrackItem handles after the append transaction.
    const freshProject = await ppro.Project.getActiveProject();
    const freshSequence = freshProject && (await freshProject.getActiveSequence());
    const freshSelection = freshSequence && (await freshSequence.getSelection());
    const targetClips = freshSelection ? await freshSelection.getTrackItems() : clips;

    for (const [clipIdx, clip] of targetClips.entries()) {
      const plan = clipPlans[clipIdx];
      if (!plan || !plan.length) continue;
      const chain = isVideo(ppro, clip)
        ? await clip.getComponentChain()
        : isAudio(ppro, clip)
          ? await clip.getComponentChain()
          : null;
      if (!chain) continue;
      const baseCount = startCounts[clipIdx] ?? 0;
      const totalCount = typeof (chain as unknown as PreparedClipFilter["chain"]).getComponentCount === "function"
        ? (chain as unknown as PreparedClipFilter["chain"]).getComponentCount()
        : 0;
      for (const [filterOffset, item] of plan.entries()) {
        if (!item.params.length) continue;
        const targetIndex = baseCount + filterOffset;
        if (
          typeof (chain as unknown as PreparedClipFilter["chain"]).getComponentAtIndex === "function" &&
          targetIndex < totalCount
        ) {
          const attached = (chain as unknown as PreparedClipFilter["chain"]).getComponentAtIndex(targetIndex);
          if (attached) {
            postAttachParamActions.push(...buildParamActions(ppro, attached, item.params));
          }
        }
      }
    }

    if (postAttachParamActions.length > 0) {
      let configureCommitted = false;
      project.lockedAccess(() => {
        configureCommitted = project.executeTransaction((transaction) => {
          for (const action of postAttachParamActions) transaction.addAction(action);
        }, `Helm · Configure ${preset.name}`);
      });
      if (!configureCommitted) {
        console.warn(`[Helm] Could not commit parameter configurations for ${preset.name}`);
      }
    }
  }

  return { applied: clipPlans.length, skipped: clips.length - clipPlans.length };
}
