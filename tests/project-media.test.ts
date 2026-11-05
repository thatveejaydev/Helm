import assert from "node:assert/strict";
import { test } from "node:test";
import type { premierepro } from "@adobe/premierepro";
import { indexEffects, indexProjectMedia, mergeSearchResults, rankEffects, rankProjectMedia, searchProjectMedia } from "../src/search";
import { readProjectCatalog, runCommand } from "../uxp/src/commands";

test("All search ranks a close filename match above a loose preset match", () => {
  const name = "achievement_sfx.mp3";
  const media = indexProjectMedia([{ id: "media", name, bins: ["Sfx"] }]);
  const presets = indexEffects([{
    id: "preset", kind: "preset", name: "Malice White Vignette Mid",
    folders: ["Miscellaneous", "Vignettes"], directApply: false, filters: [],
  }]);
  for (const query of ["achievem", "achive"]) {
    const results = mergeSearchResults<{ name: string }>([
      rankEffects(presets, query, "all", [], 60), rankProjectMedia(media, query, 60),
    ], query, 60);
    assert.equal(results.length, 2);
    assert.equal(results[0].name, name);
  }
});

function fixture(videoRanges: [number, number][][] = [[], []], circular = false) {
  const media = {
    type: 2, name: "Cam B 001.mov", getId: () => "media", isOffline: async () => false, isSequence: async () => false,
    getInPoint: async () => ({ ticks: "0" }), getOutPoint: async () => ({ ticks: "50" }),
    getMediaFilePath: async () => "Cam B 001.mov",
  };
  const sequenceItem = { type: 2, name: "Edit", getId: () => "sequence" };
  const nestItem = { type: 3, name: "Review Cut", getId: () => "nest" };
  const bin = { type: 1, name: "Interviews", getId: () => "interviews", getItems: async () => [media, nestItem] };
  const playhead = { ticks: "100" };
  const sequence = {
    guid: "sequence", getProjectItem: async () => sequenceItem, getPlayerPosition: async () => playhead,
    getVideoTrackCount: async () => videoRanges.length,
    getAudioTrackCount: async () => 2,
    getAudioTrack: async () => ({ getTrackItems: () => [null] }),
    getVideoTrack: async (index: number) => ({
      getTrackItems: (type: number) => type === 1 ? videoRanges[index].map(([start, end]) => ({
        getStartTime: async () => ({ ticks: String(start) }),
        getEndTime: async () => ({ ticks: String(end) }),
      })) : [null],
    }),
  };
  const nest = {
    guid: "nest", getProjectItem: async () => nestItem, getEndTime: async () => ({ ticks: "50" }),
    getVideoTrackCount: async () => 1, getAudioTrackCount: async () => 0,
    getVideoTrack: async () => ({ getTrackItems: () => circular ? [{ getProjectItem: async () => sequenceItem }] : [] }),
  };
  const actions: unknown[] = [];
  const opened: unknown[] = [];
  const openedSequences: unknown[] = [];
  let activeProjectId = "project";
  const project = {
    get guid() { return activeProjectId; },
    getRootItem: async () => ({ getItems: async () => [sequenceItem, bin] }),
    getSequences: async () => [sequence, nest],
    getActiveSequence: async () => sequence,
    openSequence: async (item: unknown) => { openedSequences.push(item); return true; },
    lockedAccess: (callback: () => void) => callback(),
    executeTransaction: (callback: (transaction: { addAction: (action: unknown) => void }) => void) => {
      callback({ addAction: (action) => actions.push(action) });
      return true;
    },
  };
  const host = {
    Constants: { MediaType: { VIDEO: 2, AUDIO: 3 }, TrackItemType: { CLIP: 1, TRANSITION: 2 } },
    Project: { getActiveProject: async () => project },
    ProjectItem: { TYPE_BIN: 1, TYPE_CLIP: 2 },
    FolderItem: { cast: (item: unknown) => item },
    ClipProjectItem: { cast: (item: unknown) => item },
    SourceMonitor: { openProjectItem: async (item: unknown) => {
      opened.push(item);
      return item === media;
    } },
    SequenceEditor: { getEditor: () => ({
      createInsertProjectItemAction: (...args: unknown[]) => args,
    }) },
  } as unknown as premierepro;
  return { host, actions, opened, openedSequences, playhead, media, nest, nestItem, switchProject: () => { activeProjectId = "other"; } };
}

test("opening a project result previews media and opens sequences in the timeline", async () => {
  const { host, actions, opened, openedSequences, media, nest, switchProject } = fixture();
  const selection = { projectId: "project", id: "media" };
  await runCommand(host, "open-project-source", selection);
  await runCommand(host, "open-project-source", { ...selection, id: "nest" });
  switchProject();
  await assert.rejects(runCommand(host, "open-project-source", selection), /active project changed/);
  assert.deepEqual(opened, [media]);
  assert.deepEqual(openedSequences, [nest]);
  assert.deepEqual(actions, []);
});

test("project search indexes media and sequences by name and bin path and excludes the active sequence", async () => {
  const { host } = fixture();
  const catalog = await runCommand(host, "list-project-media", undefined);
  assert.ok("items" in catalog);
  assert.equal(catalog.projectId, "project");
  assert.deepEqual(searchProjectMedia(indexProjectMedia(catalog.items), "interviews cam b"), [
    { id: "media", name: "Cam B 001.mov", bins: ["Interviews"], binIds: ["interviews"], mediaType: "video" },
  ]);
  assert.deepEqual(searchProjectMedia(indexProjectMedia(catalog.items), "edit"), []);
  assert.deepEqual(searchProjectMedia(indexProjectMedia(catalog.items), "interviews review"), [
    { id: "nest", name: "Review Cut", bins: ["Interviews"], binIds: ["interviews"], mediaType: "sequence" },
  ]);
  assert.equal(searchProjectMedia(indexProjectMedia(catalog.items), "interviews")[0].mediaType, "bin");
});

test("project catalog reuses the current revision and rescans on edits or project switches", async () => {
  const { host, media, switchProject } = fixture();
  let scans = 0;
  media.getMediaFilePath = async () => { scans++; return "Cam B 001.mov"; };
  let revision = 0;
  const read = (known?: unknown) => readProjectCatalog(host, known, () => revision);
  const first = await read();
  assert.ok(first.catalog);
  assert.deepEqual(await read(first.key), { key: first.key });
  assert.equal(scans, 1);
  revision++;
  const changed = await read(first.key);
  assert.ok(changed.catalog);
  switchProject();
  assert.equal((await read(changed.key)).catalog?.projectId, "other");
  assert.equal(scans, 3);
});

test("project insert routes a sequence to a free track and rejects circular nesting", async () => {
  const { host, actions, playhead, nestItem } = fixture([[[100, 125]], []]);
  const selection = { projectId: "project", id: "nest" };
  await runCommand(host, "insert-project-media", selection);
  assert.deepEqual(actions, [[nestItem, playhead, 1, 0, true]]);
  await assert.rejects(runCommand(host, "insert-project-media", { ...selection, id: "sequence" }), /into itself/);
  const circular = fixture([[], []], true);
  await assert.rejects(runCommand(circular.host, "insert-project-media", selection), /into itself/);
  assert.deepEqual(circular.actions, []);
});

test("project media inserts at the playhead and rejects results from another project", async () => {
  const { host, actions, playhead, media, switchProject } = fixture();
  const selection = { projectId: "project", id: "media" };
  await runCommand(host, "insert-project-media", selection);
  assert.deepEqual(actions, [[media, playhead, 0, 0, true]]);
  switchProject();
  await assert.rejects(runCommand(host, "insert-project-media", selection), /active project changed/);
  assert.equal(actions.length, 1);
});

test("project insert prefers the requested track and falls back if any of the clip overlaps", async () => {
  const { host, actions, playhead, media } = fixture([[[90, 100]], [[125, 175]], []]);
  const selection = { projectId: "project", id: "media", videoTrack: 3, audioTrack: 2 };
  await runCommand(host, "insert-project-media", selection);
  await runCommand(host, "insert-project-media", { ...selection, videoTrack: 2 });
  assert.deepEqual(actions, [[media, playhead, 2, 1, true], [media, playhead, 0, 1, true]]);
  const full = fixture([[[100, 150]], [[149, 160]]]);
  await assert.rejects(runCommand(full.host, "insert-project-media", selection), /No video track/);
  assert.deepEqual(full.actions, []);
});

test("project insert without a track prefix uses the first track with room", async () => {
  const { host, actions, playhead, media } = fixture([[[100, 150]], [], []]);
  await runCommand(host, "insert-project-media", { projectId: "project", id: "media" });
  assert.deepEqual(actions, [[media, playhead, 1, 0, true]]);
});
