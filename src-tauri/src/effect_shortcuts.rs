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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

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
        for accelerator in bindings.values() {
            if let Err(error) = app.global_shortcut().register(accelerator.as_str()) {
                errors.push(format!(
                    "Could not register effect shortcut {accelerator}: {error}"
                ));
            }
        }
        app.manage(Self {
            path,
            bindings: Mutex::new(bindings),
            recording: AtomicBool::new(false),
        });
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
    if !effect_id
        .split_once(':')
        .is_some_and(|(kind, id)| matches!(kind, "video" | "audio") && !id.is_empty())
    {
        return Err("Choose an audio or video effect.".into());
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
        if !same || !manager.is_registered(next) {
            manager
                .register(next)
                .map_err(|error| format!("Could not register that shortcut: {error}"))?;
        } else {
            return Ok(bindings.clone());
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
