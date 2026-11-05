import assert from "node:assert/strict";
import { test } from "node:test";
import type { premierepro } from "@adobe/premierepro";
import { indexEffects, searchEffects } from "../src/search";
import { applyEffect, applyPreset, discoverEffects } from "../uxp/src/effects";

const gaussianBlur = { id: "video:blur", name: "Gaussian Blur", matchName: "blur", kind: "video" } as const;
const audioEffect = { id: "audio:Blur", name: "Blur", matchName: "Blur", kind: "audio" } as const;

test("the search finds fuzzy matches, prefers exact names, and respects media filters", () => {
  const index = indexEffects([gaussianBlur, audioEffect]);
  assert.deepEqual(searchEffects(index, "blur", "all", []), [audioEffect, gaussianBlur]);
  assert.deepEqual(searchEffects(index, "gsn bl", "video", []), [gaussianBlur]);
  assert.deepEqual(searchEffects(index, "blur", "audio", []), [audioEffect]);
  assert.deepEqual(searchEffects(index, "", "all", [gaussianBlur.id]), [gaussianBlur, audioEffect]);
});

test("same-named presets can be searched by folder and filtered separately from effects", () => {
  const rotation = { id: "preset:rotation", name: "110", folders: ["Presets", "Rotation Shake"], directApply: false, filters: [], kind: "preset" } as const;
  const standard = { ...rotation, id: "preset:standard", folders: ["Presets", "Standard Shake"] };
  const index = indexEffects([gaussianBlur, { ...rotation, folders: [...rotation.folders] }, standard]);
  assert.deepEqual(searchEffects(index, "rotation 110", "preset", []).map((entry) => entry.id), [rotation.id]);
  assert.deepEqual(searchEffects(index, "110", "preset", []).map((entry) => entry.id), [rotation.id, standard.id]);
  assert.deepEqual(searchEffects(index, "110", "video", []), []);
});

test("catalog entries preserve effect IDs and keep same-named video and audio effects separate", async () => {
  const host = {
    VideoFilterFactory: {
      getMatchNames: async () => ["PR.ADBE Blur"],
      getDisplayNames: async () => ["Blur"],
    },
    AudioFilterFactory: { getDisplayNames: async () => ["Blur", "Blur"] },
  } as unknown as premierepro;
  const effects = await discoverEffects(host);
  assert.deepEqual(effects.map(({ id, name }) => [id, name]), [
    ["video:PR.ADBE Blur", "Blur"], ["audio:Blur", "Blur"],
  ]);
});

function fakeTimeline({ rejectSecondClip = false, sequenceChanges = false } = {}) {
  const applied: string[] = [];
  const transactions: string[] = [];
  let locked = false;
  let sequenceReads = 0;
  class VideoClip {
    constructor(readonly name: string) {}
    async getComponentChain() {
      if (rejectSecondClip && this.name === "second") throw new Error("Clip unavailable");
      return { createAppendComponentAction: () => {
        assert.ok(locked);
        return this.name;
      } };
    }
  }
  class AudioClip {}
  const sequence = {
    guid: "test-sequence",
    getSelection: async () => ({ getTrackItems: async () => [new VideoClip("first"), new AudioClip(), new VideoClip("second")] }),
  };
  const project = {
    guid: "test-project",
    getActiveSequence: async () => ++sequenceReads > 1 && sequenceChanges ? { guid: "other-sequence" } : sequence,
    lockedAccess: (callback: () => void) => {
      locked = true;
      try { callback(); } finally { locked = false; }
    },
    executeTransaction: (callback: (transaction: { addAction: (name: string) => void }) => void, name: string) => {
      assert.ok(locked);
      transactions.push(name);
      callback({ addAction: (clip) => applied.push(clip) });
      return true;
    },
  };
  const host = {
    Project: { getActiveProject: async () => project },
    VideoClipTrackItem: VideoClip,
    AudioClipTrackItem: AudioClip,
    VideoFilterFactory: { createComponent: async () => ({}) },
  } as unknown as premierepro;
  return { host, applied, transactions };
}

test("a video effect applies to compatible selected clips in one undo transaction", async () => {
  const { host, applied, transactions } = fakeTimeline();
  assert.deepEqual(await applyEffect(host, gaussianBlur), { applied: 2, skipped: 1 });
  assert.deepEqual(applied, ["first", "second"]);
  assert.deepEqual(transactions, ["Helm · Apply Gaussian Blur"]);
});

test("failed clip preparation or a changed timeline leaves the project untouched", async () => {
  const unavailable = fakeTimeline({ rejectSecondClip: true });
  await assert.rejects(applyEffect(unavailable.host, gaussianBlur), /Clip unavailable/);
  assert.deepEqual(unavailable.transactions, []);
  const changed = fakeTimeline({ sequenceChanges: true });
  await assert.rejects(applyEffect(changed.host, gaussianBlur), /active timeline changed/);
  assert.deepEqual(changed.transactions, []);
});

test("a static custom preset applies its filters and parameter values directly", async () => {
  const actions: string[] = [];
  const transactions: string[] = [];
  let attachedComponents: { matchName: string }[] = [];
  class VideoClip {
    constructor(readonly name: string) {}
    async getComponentChain() {
      return {
        getComponentCount: () => attachedComponents.length,
        getComponentAtIndex: (index: number) => {
          const comp = attachedComponents[index];
          return {
            getParamCount: () => 2,
            getParam: (paramIdx: number) => ({
              displayName: paramIdx === 0 ? "Blurriness" : "Repeat Edge Pixels",
              createKeyframe: (val: unknown) => ({ val }),
              createSetValueAction: (kf: { val: unknown }) => `set:${comp.matchName}:${paramIdx}:${JSON.stringify(kf.val)}`,
            }),
          };
        },
        createAppendComponentAction: (comp: { matchName: string }) => {
          attachedComponents.push(comp);
          return `append:${this.name}:${comp.matchName}`;
        },
      };
    }
  }
  class AudioClip {}
  const sequence = {
    guid: "seq-1",
    getSelection: async () => ({ getTrackItems: async () => [new VideoClip("clip1"), new AudioClip()] }),
  };
  const project = {
    guid: "proj-1",
    getActiveSequence: async () => sequence,
    lockedAccess: (cb: () => void) => cb(),
    executeTransaction: (cb: (tx: { addAction: (a: string) => void }) => void, name: string) => {
      transactions.push(name);
      cb({ addAction: (a) => actions.push(a) });
      return true;
    },
  };
  const host = {
    Project: { getActiveProject: async () => project },
    VideoClipTrackItem: VideoClip,
    AudioClipTrackItem: AudioClip,
    PointF: (x: number, y: number) => ({ x, y }),
    Color: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }),
    VideoFilterFactory: {
      createComponent: async (matchName: string) => ({ matchName }),
    },
  } as unknown as premierepro;

  const result = await applyPreset(host, {
    name: "Custom Blur",
    filters: [
      {
        kind: "video",
        name: "Gaussian Blur",
        matchName: "AE.ADBE Gaussian Blur 2",
        params: [
          { index: 0, name: "Blurriness", value: { kind: "number", value: 20 } },
          { index: 1, name: "Repeat Edge Pixels", value: { kind: "boolean", value: true } },
        ],
      },
    ],
  });

  assert.deepEqual(result, { applied: 1, skipped: 1 });
  assert.deepEqual(transactions, ["Helm · Apply Custom Blur", "Helm · Configure Custom Blur"]);
  assert.deepEqual(actions, [
    "append:clip1:AE.ADBE Gaussian Blur 2",
    "set:AE.ADBE Gaussian Blur 2:0:20",
    "set:AE.ADBE Gaussian Blur 2:1:true",
  ]);
});
