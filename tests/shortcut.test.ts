import assert from "node:assert/strict";
import { test } from "node:test";
import { captureShortcut } from "../src/shortcut";

function mockKeyEvent(init: {
  key: string;
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.code,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
  } as unknown as KeyboardEvent;
}

test("captureShortcut previews held modifiers", () => {
  const ctrlOnly = captureShortcut(mockKeyEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }));
  assert.deepEqual(ctrlOnly, { accelerator: "", display: "Ctrl + …", complete: false });

  const ctrlAlt = captureShortcut(mockKeyEvent({ key: "Alt", code: "AltLeft", ctrlKey: true, altKey: true }));
  assert.deepEqual(ctrlAlt, { accelerator: "", display: "Ctrl + Alt + …", complete: false });
});

test("captureShortcut captures Ctrl+Alt+Space combo", () => {
  const spaceCombo = captureShortcut(mockKeyEvent({ key: " ", code: "Space", ctrlKey: true, altKey: true }));
  assert.deepEqual(spaceCombo, { accelerator: "Ctrl+Alt+Space", display: "Ctrl + Alt + Space", complete: true });
});

test("captureShortcut captures other modifier combinations", () => {
  const altSpace = captureShortcut(mockKeyEvent({ key: " ", code: "Space", altKey: true }));
  assert.deepEqual(altSpace, { accelerator: "Alt+Space", display: "Alt + Space", complete: true });

  const ctrlShiftP = captureShortcut(mockKeyEvent({ key: "p", code: "KeyP", ctrlKey: true, shiftKey: true }));
  assert.deepEqual(ctrlShiftP, { accelerator: "Ctrl+Shift+P", display: "Ctrl + Shift + P", complete: true });

  const ctrlDigit = captureShortcut(mockKeyEvent({ key: "1", code: "Digit1", ctrlKey: true }));
  assert.deepEqual(ctrlDigit, { accelerator: "Ctrl+1", display: "Ctrl + 1", complete: true });
});

test("captureShortcut supports function keys without modifiers", () => {
  const f8 = captureShortcut(mockKeyEvent({ key: "F8", code: "F8" }));
  assert.deepEqual(f8, { accelerator: "F8", display: "F8", complete: true });
});

test("captureShortcut rejects bare keys without modifiers", () => {
  const bareK = captureShortcut(mockKeyEvent({ key: "k", code: "KeyK" }));
  assert.ok(bareK && !bareK.complete && bareK.error?.includes("Ctrl, Alt, or Shift"));
});

test("captureShortcut returns null on Escape for cancellation", () => {
  const esc = captureShortcut(mockKeyEvent({ key: "Escape", code: "Escape" }));
  assert.equal(esc, null);
});
