export interface ShortcutCapture {
  accelerator: string;
  display: string;
  complete: boolean;
  error?: string;
}

export function captureShortcut(event: KeyboardEvent): ShortcutCapture | null {
  if (event.key === "Escape") {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");

  const isModifierKey = ["Control", "Alt", "Shift", "Meta"].includes(event.key);

  if (isModifierKey) {
    if (modifiers.length === 0) return null;
    return {
      accelerator: "",
      display: modifiers.join(" + ") + " + …",
      complete: false,
    };
  }

  let mainKey: string | null = null;
  const code = event.code;

  if (code.startsWith("Key") && code.length === 4) {
    mainKey = code.slice(3).toUpperCase();
  } else if (code.startsWith("Digit") && code.length === 6) {
    mainKey = code.slice(5);
  } else if (/^F\d{1,2}$/.test(code)) {
    mainKey = code.toUpperCase();
  } else if (code.startsWith("Numpad") && code.length === 7 && code >= "Numpad0" && code <= "Numpad9") {
    mainKey = "Num" + code.slice(6);
  } else {
    switch (code) {
      case "Space": mainKey = "Space"; break;
      case "Tab": mainKey = "Tab"; break;
      case "Enter": mainKey = "Enter"; break;
      case "Backspace": mainKey = "Backspace"; break;
      case "Delete": mainKey = "Delete"; break;
      case "Insert": mainKey = "Insert"; break;
      case "Home": mainKey = "Home"; break;
      case "End": mainKey = "End"; break;
      case "PageUp": mainKey = "PageUp"; break;
      case "PageDown": mainKey = "PageDown"; break;
      case "ArrowUp": mainKey = "Up"; break;
      case "ArrowDown": mainKey = "Down"; break;
      case "ArrowLeft": mainKey = "Left"; break;
      case "ArrowRight": mainKey = "Right"; break;
      case "Minus": mainKey = "-"; break;
      case "Equal": mainKey = "="; break;
      case "BracketLeft": mainKey = "["; break;
      case "BracketRight": mainKey = "]"; break;
      case "Backslash": mainKey = "\\"; break;
      case "Semicolon": mainKey = ";"; break;
      case "Quote": mainKey = "'"; break;
      case "Comma": mainKey = ","; break;
      case "Period": mainKey = "."; break;
      case "Slash": mainKey = "/"; break;
      case "Backquote": mainKey = "`"; break;
      default:
        if (event.key.length === 1 && !/\s/.test(event.key)) {
          mainKey = event.key.toUpperCase();
        }
        break;
    }
  }

  if (!mainKey) {
    return {
      accelerator: "",
      display: modifiers.length ? modifiers.join(" + ") + " + …" : "",
      complete: false,
      error: "Unsupported key combination.",
    };
  }

  if (modifiers.length === 0 && !/^F\d{1,2}$/.test(mainKey)) {
    return {
      accelerator: "",
      display: mainKey,
      complete: false,
      error: "Shortcut must include Ctrl, Alt, or Shift.",
    };
  }

  const parts = [...modifiers, mainKey];
  return {
    accelerator: parts.join("+"),
    display: parts.join(" + "),
    complete: true,
  };
}
