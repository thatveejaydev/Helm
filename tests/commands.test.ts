import assert from "node:assert/strict";
import { test } from "node:test";
import type { premierepro } from "@adobe/premierepro";
import { runCommand } from "../uxp/src/commands";

function component(match: string, name: string, parameter: string, animated = false) {
  return {
    getMatchName: async () => match,
    getDisplayName: async () => name,
    getParamCount: () => 1,
    getParam: () => ({
      displayName: parameter,
      isTimeVarying: () => animated,
      createKeyframe: (value: number) => value,
      createSetValueAction: (value: number) => ({ parameter, value }),
    }),
  };
}

function timeline() {
  class VideoClip {
    constructor(private components: ReturnType<typeof component>[]) {}
    async getComponentChain() {
      return {
        getComponentCount: () => this.components.length,
        getComponentAtIndex: (index: number) => this.components[index],
        createRemoveComponentAction: (effect: ReturnType<typeof component>) => ({ effect }),
      };
    }
  }
  class AudioClip {
    constructor(private volume: ReturnType<typeof component>) {}
    async getComponentChain() {
      return { getComponentCount: () => 1, getComponentAtIndex: () => this.volume };
    }
  }
  const blur = component("blur", "Blur", "Amount");
  const clips = [
    new VideoClip([component("AE.ADBE Opacity", "Opacity", "Opacity"), blur]),
    new VideoClip([component("AE.ADBE Opacity", "Opacity", "Opacity", true)]),
    new AudioClip(component("Internal Volume Stereo", "Volume", "Level")),
  ];
  const actions: unknown[][] = [];
  const markerTime = { seconds: 2.5 };
  let playhead = { seconds: 5 };
  const sequence = {
    guid: "sequence",
    getSelection: async () => ({ getTrackItems: async () => clips }),
    getPlayerPosition: async () => playhead,
    setPlayerPosition: async (position: typeof playhead) => { playhead = position; return true; },
  };
  const project = {
    guid: "project",
    getActiveSequence: async () => sequence,
    lockedAccess: (callback: () => void) => callback(),
    executeTransaction: (callback: (transaction: { addAction: (action: unknown) => void }) => void) => {
      const batch: unknown[] = [];
      callback({ addAction: (action) => batch.push(action) });
      actions.push(batch);
      return true;
    },
  };
  const host = {
    Project: { getActiveProject: async () => project },
    VideoClipTrackItem: VideoClip,
    AudioClipTrackItem: AudioClip,
    VideoFilterFactory: {
      getMatchNames: async () => ["AE.ADBE Opacity", "blur"],
      getDisplayNames: async () => ["Opacity", "Blur"],
    },
    AudioFilterFactory: { getDisplayNames: async () => ["Volume"] },
    Marker: { MARKER_TYPE_COMMENT: "Comment" },
    Markers: { getMarkers: async () => ({
      getMarkers: () => [{ guid: "review", getName: () => "Review", getStart: () => markerTime }],
      createAddMarkerAction: (name: string, type: string, position: typeof playhead) => ({ name, type, position }),
    }) },
  } as unknown as premierepro;
  return { host, actions, blur, sequence };
}

test("remove attributes preserves built-in components even if the factory lists them", async () => {
  const { host, actions, blur } = timeline();
  await runCommand(host, "remove-attributes", undefined);
  assert.deepEqual(actions, [[{ effect: blur }]]);
});

test("clip values skip keyframed and incompatible clips and reject out-of-range input", async () => {
  const { host, actions } = timeline();
  assert.match((await runCommand(host, "set-opacity", 50)).message ?? "", /2 skipped/);
  await runCommand(host, "set-volume", 0);
  await assert.rejects(runCommand(host, "set-opacity", 101), /between 0 and 100/);
  assert.deepEqual(actions, [[{ parameter: "Opacity", value: 50 }], [{ parameter: "Level", value: 10 ** (-15 / 20) }]]);
});

test("markers are added at the playhead and found by ID in the active sequence", async () => {
  const { host, actions, sequence } = timeline();
  await runCommand(host, "add-marker", "Review VO");
  assert.deepEqual(actions, [[{ name: "Review VO", type: "Comment", position: { seconds: 5 } }]]);
  assert.deepEqual(await runCommand(host, "list-markers", undefined), { markers: [{ id: "review", name: "Review", seconds: 2.5 }] });
  await runCommand(host, "go-to-marker", "review");
  assert.deepEqual(await sequence.getPlayerPosition(), { seconds: 2.5 });
  await assert.rejects(runCommand(host, "go-to-marker", "stale"), /unavailable/);
});
