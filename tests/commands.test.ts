import assert from "node:assert/strict";
import { test } from "node:test";
import type { premierepro } from "@adobe/premierepro";
import { runCommand } from "../uxp/src/commands";

for (const [scenario, neighborStart, neighborEnd, track] of [
  ["skips an occupied track", "170", "240", 2],
  ["preserves a layer to the right and uses the closest track", "220", "240", 1],
  ["preserves a layer to the left and uses the closest track", "80", "140", 1],
  ["spans multiple clips above the highest selected track", "210", "230", 2],
  ["creates a track when every track above is occupied", "170", "240", 2],
] as const) {
  test(`adjustment layer ${scenario}`, async (t) => {
    const storage = new Map<string, string>();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value),
    } });
    t.after(() => {
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });
    const tick = (ticks: string) => ({ ticks });
    const multiple = scenario.startsWith("spans");
    const createsTrack = scenario.startsWith("creates");
    let sourceOut = tick("100");
    let direct = false;
    const source = {
      type: 2, name: "Adjustment Layer", getId: () => "layer",
      getInPoint: async () => tick("0"), getOutPoint: async () => sourceOut,
      createSetInOutPointsAction: (_start: ReturnType<typeof tick>, end: ReturnType<typeof tick>) =>
        () => { sourceOut = end; },
    };
    class Clip {
      constructor(private adjustment: boolean, private start: string, private end: string, private track = 0) {}
      async getStartTime() { return tick(this.start); }
      async getEndTime() { return tick(this.end); }
      async getTrackIndex() { return this.track; }
      async isAdjustmentLayer() { return this.adjustment; }
      async getProjectItem() { return source; }
      createSetEndAction(end: ReturnType<typeof tick>) { return () => { this.end = end.ticks; }; }
      cloneAt(offset: ReturnType<typeof tick>) {
        return new Clip(this.adjustment, String(BigInt(this.start) + BigInt(offset.ticks)),
          String(BigInt(this.end) + BigInt(offset.ticks)));
      }
    }
    let selected = new Clip(true, "0", "100");
    const laterClip = new Clip(false, "210", "230", 1);
    let selection = [selected];
    const tracks = [[selected], [new Clip(true, neighborStart, neighborEnd)], [] as Clip[]];
    if (createsTrack) tracks.pop();
    const sequence = {
      guid: "timeline",
      getSelection: async () => ({ getTrackItems: async () => selection }),
      getVideoTrackCount: async () => tracks.length,
      getEndTime: async () => tick("240"),
      getVideoTrack: async (index: number) => ({ getTrackItems: (kind: number) => kind === 1 ? tracks[index] : [] }),
    };
    const project = {
      guid: "project",
      getActiveSequence: async () => sequence,
      getSequences: async () => [],
      getRootItem: async () => ({ getItems: async () => [source] }),
      lockedAccess: (callback: () => void) => callback(),
      executeTransaction: (callback: (tx: { addAction: (action: () => void) => void }) => void) => {
        callback({ addAction: (action) => action() });
        return true;
      },
    };
    const host = {
      Project: { getActiveProject: async () => project },
      VideoClipTrackItem: Clip,
      ProjectItem: { TYPE_CLIP: 2, TYPE_BIN: 1 },
      ClipProjectItem: { cast: (item: unknown) => item },
      TickTime: { createWithTicks: tick },
      Constants: { MediaType: { VIDEO: 2 }, TrackItemType: { CLIP: 1, TRANSITION: 2 } },
      TrackItemSelection: { createEmptySelection: (callback: (selection: { addItem: (item: Clip) => boolean; items: Clip[] }) => void) => {
        const items: Clip[] = [];
        callback({ addItem: (item) => Boolean(items.push(item)), items });
      } },
      SequenceEditor: { getEditor: () => ({
        createOverwriteItemAction: (item: unknown, position: ReturnType<typeof tick>, track: number) => () => {
          assert.equal(item, source);
          assert.equal(position.ticks, "150");
          direct = true;
          tracks[track].push(new Clip(true, position.ticks, String(BigInt(position.ticks) + BigInt(sourceOut.ticks))));
        },
        createInsertProjectItemAction: (item: unknown, position: ReturnType<typeof tick>, track: number) => () => {
          assert.equal(item, source);
          assert.equal(position.ticks, "240", "never ripple-insert into the destination gap");
          if (track === tracks.length) tracks.push([]);
          tracks[track].push(new Clip(true, position.ticks, String(BigInt(position.ticks) + 100n)));
        },
        createCloneTrackItemAction: (item: Clip, offset: ReturnType<typeof tick>, videoOffset: number,
          audioOffset: number, alignToVideo: boolean, isInsert: boolean) => () => {
          assert.deepEqual([videoOffset, audioOffset, alignToVideo, isInsert], [0, 0, true, false]);
          const track = tracks.find((entries) => entries.includes(item));
          assert.ok(track);
          track.push(item.cloneAt(offset));
        },
        createRemoveItemsAction: ({ items }: { items: Clip[] }, ripple: boolean) => () => {
          assert.equal(ripple, false);
          for (const item of items) {
            const track = tracks.find((entries) => entries.includes(item));
            assert.ok(track);
            track.splice(track.indexOf(item), 1);
          }
        },
      }) },
    } as unknown as premierepro;
    await runCommand(host, "set-adjustment-layer-source", undefined);
    selected = new Clip(false, "150", "200");
    selection = multiple ? [laterClip, selected] : [selected];
    assert.deepEqual(await runCommand(host, "add-adjustment-layer", undefined),
      { message: `Added a matching adjustment layer on V${track + 1}.` });
    assert.deepEqual(await tracks[track].at(-1)?.getStartTime(), tick("150"));
    assert.deepEqual(await tracks[track].at(-1)?.getEndTime(), tick(multiple ? "230" : "200"));
    assert.equal(direct, neighborStart !== "220" && !createsTrack);
    assert.equal(tracks.length, 3);
    assert.deepEqual(sourceOut, tick("100"));
    assert.deepEqual(await tracks[1][0].getStartTime(), tick(neighborStart));
    assert.deepEqual(await tracks[1][0].getEndTime(), tick(neighborEnd));
    assert.equal(tracks[1].length, track === 2 ? 1 : 2);
  });
}

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
