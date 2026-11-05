use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};

type Bindings = BTreeMap<String, String>;

pub struct EffectShortcuts {
    path: PathBuf,
    bindings: Mutex<Bindings>,
    pub recording: AtomicBool,
}

impl EffectShortcuts {
    pub fn load(app: &AppHandle, path: PathBuf) -> Vec<String> {
        let mut errors = Vec::new();
        let bindings: Bindings = match fs::read(&path) {
            Ok(data) => serde_json::from_slice(&data).unwrap_or_else(|error| {
                errors.push(format!("Could not read effect shortcuts: {error}"));
                Bindings::new()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Bindings::new(),
            Err(error) => {
                errors.push(format!("Could not read effect shortcuts: {error}"));
                Bindings::new()
            }
        };
        app.manage(Self {
            path,
            bindings: Mutex::new(bindings),
            recording: AtomicBool::new(false),
        });
        if let Err(error) = watch_foreground(app) {
            errors.push(error);
        }
        errors
    }

    pub fn effect_for(&self, shortcut: &Shortcut) -> Option<String> {
        self.bindings
            .try_lock()
            .ok()?
            .iter()
            .find_map(|(id, accelerator)| {
                (accelerator.parse::<Shortcut>().ok()?.id() == shortcut.id()).then(|| id.clone())
            })
    }

    fn save(&self, bindings: &Bindings) -> Result<(), String> {
        let data = serde_json::to_vec_pretty(bindings).map_err(|error| error.to_string())?;
        let temp = self.path.with_extension("tmp");
        fs::write(&temp, data)
            .and_then(|()| fs::rename(&temp, &self.path))
            .map_err(|error| format!("Could not save effect shortcuts: {error}"))
    }
}

fn premiere_is_active() -> bool {
    crate::platform::foreground_premiere().is_some_and(|window| window != 0)
}

fn intercepts_typing(shortcut: Shortcut) -> bool {
    if !shortcut.mods.is_empty() && shortcut.mods != Modifiers::SHIFT {
        return false;
    }
    let code = shortcut.key.to_string();
    code.starts_with("Key")
        || code.starts_with("Digit")
        || code.starts_with("Numpad")
        || matches!(
            code.as_str(),
            "Space"
                | "Minus"
                | "Equal"
                | "BracketLeft"
                | "BracketRight"
                | "Backslash"
                | "IntlBackslash"
                | "IntlRo"
                | "IntlYen"
                | "Semicolon"
                | "Quote"
                | "Comma"
                | "Period"
                | "Slash"
                | "Backquote"
        )
}

#[cfg(windows)]
fn sync_registration(app: &AppHandle) {
    use tauri::Emitter;

    let active = premiere_is_active();
    let palette = app
        .state::<std::sync::Arc<crate::bridge::Bridge>>()
        .shortcut()
        .parse::<Shortcut>()
        .ok();
    let state = app.state::<EffectShortcuts>();
    let bindings = state.bindings.lock().unwrap().clone();
    let manager = app.global_shortcut();
    for accelerator in bindings.values() {
        let Ok(key) = accelerator.parse::<Shortcut>() else {
            continue;
        };
        if palette.is_some_and(|palette| palette.id() == key.id()) {
            continue;
        }
        let result = match (
            active && !intercepts_typing(key),
            manager.is_registered(key),
        ) {
            (true, false) => manager.register(key),
            (false, true) => manager.unregister(key),
            _ => continue,
        };
        if let Err(error) = result {
            let _ = app.emit(
                "effect-shortcut-error",
                format!("Could not update {accelerator}: {error}"),
            );
        }
    }
}

// Install on Tauri's UI thread, which also receives out-of-context foreground events.
#[cfg(windows)]
fn watch_foreground(app: &AppHandle) -> Result<(), String> {
    use std::cell::OnceCell;
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Accessibility::{SetWinEventHook, HWINEVENTHOOK},
            WindowsAndMessaging::{EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT},
        },
    };

    thread_local! {
        static APP: OnceCell<AppHandle> = const { OnceCell::new() };
    }

    unsafe extern "system" fn foreground_changed(
        _: HWINEVENTHOOK,
        _: u32,
        _: HWND,
        _: i32,
        _: i32,
        _: u32,
        _: u32,
    ) {
        APP.with(|app| {
            if let Some(app) = app.get() {
                sync_registration(app);
            }
        });
    }

    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_changed),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        )
    };
    if hook.is_invalid() {
        return Err(format!(
            "Could not monitor Premiere focus: {}",
            std::io::Error::last_os_error()
        ));
    }
    APP.with(|slot| {
        let _ = slot.set(app.clone());
    });
    sync_registration(app);
    Ok(())
}

#[cfg(not(windows))]
fn watch_foreground(_: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn set_effect_shortcut_recording(state: tauri::State<'_, EffectShortcuts>, recording: bool) {
    state.recording.store(recording, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_effect_shortcuts(state: tauri::State<'_, EffectShortcuts>) -> Bindings {
    state.bindings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_effect_shortcut(
    app: AppHandle,
    state: tauri::State<'_, EffectShortcuts>,
    effect_id: String,
    shortcut: Option<String>,
) -> Result<Bindings, String> {
    if effect_id != "command:add-adjustment-layer"
        && !effect_id
            .split_once(':')
            .is_some_and(|(kind, id)| matches!(kind, "video" | "audio") && !id.is_empty())
    {
        return Err("Choose an effect or a supported command.".into());
    }
    let mut bindings = state.bindings.lock().unwrap();
    let previous = bindings
        .get(&effect_id)
        .and_then(|value| value.parse::<Shortcut>().ok());
    let next = shortcut
        .as_deref()
        .map(str::parse::<Shortcut>)
        .transpose()
        .map_err(|error| format!("Invalid shortcut: {error}"))?;
    let manager = app.global_shortcut();
    let same = previous.zip(next).is_some_and(|(a, b)| a.id() == b.id());
    let palette = app
        .state::<std::sync::Arc<crate::bridge::Bridge>>()
        .shortcut();
    if let Some(next) = next {
        if intercepts_typing(next) {
            return Err("Add Ctrl, Alt, or the Windows key to keep this key available for typing in Premiere.".into());
        }
        if palette
            .parse::<Shortcut>()
            .is_ok_and(|key| key.id() == next.id())
            || bindings.iter().any(|(id, value)| {
                id != &effect_id
                    && value
                        .parse::<Shortcut>()
                        .is_ok_and(|key| key.id() == next.id())
            })
        {
            return Err("That shortcut is already assigned in Helm.".into());
        }
        if same {
            return Ok(bindings.clone());
        }
        if premiere_is_active() {
            manager
                .register(next)
                .map_err(|error| format!("Could not register that shortcut: {error}"))?;
        }
    }
    let mut updated = bindings.clone();
    if let Some(shortcut) = shortcut {
        updated.insert(effect_id, shortcut);
    } else {
        updated.remove(&effect_id);
    }
    let previous = previous.filter(|key| {
        !same
            && manager.is_registered(*key)
            && !palette
                .parse::<Shortcut>()
                .is_ok_and(|palette_key| palette_key.id() == key.id())
    });
    if let Some(previous) = previous {
        if let Err(error) = manager.unregister(previous) {
            if let Some(next) = next {
                let _ = manager.unregister(next);
            }
            return Err(format!("Could not remove the previous shortcut: {error}"));
        }
    }
    if let Err(error) = state.save(&updated) {
        if let Some(next) = next {
            let _ = manager.unregister(next);
        }
        if let Some(previous) = previous {
            let _ = manager.register(previous);
        }
        return Err(error);
    }
    *bindings = updated;
    Ok(bindings.clone())
}
