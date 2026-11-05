#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod effect_shortcuts;
mod platform;
#[cfg(windows)]
mod preset_windows;
mod presets;

use std::sync::{
    atomic::{AtomicIsize, Ordering},
    Arc,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";
const PALETTE_WIDTH: f64 = 640.0;
const COMPACT_HEIGHT: f64 = 126.0;
const EXPANDED_HEIGHT: f64 = 566.0;

struct FocusTarget(AtomicIsize);

fn show_palette(app: &tauri::AppHandle, target: Option<isize>) {
    let Some(window) = app.get_webview_window("palette") else {
        return;
    };
    if let Ok(hwnd) = window.hwnd() {
        platform::style_window(hwnd.0 as _);
    }
    app.state::<FocusTarget>().0.store(target.unwrap_or(0), Ordering::Relaxed);
    let monitor = target
        .and_then(platform::window_center)
        .and_then(|(x, y)| window.monitor_from_point(x.into(), y.into()).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let p = monitor.position();
        let s = monitor.size();
        let scale = monitor.scale_factor();
        let width = (PALETTE_WIDTH * scale) as i32;
        let height = (EXPANDED_HEIGHT * scale) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(
            p.x + (s.width as i32 - width) / 2,
            p.y + (s.height as i32 - height) / 2,
        ));
    } else {
        let _ = window.center();
    }
    let _ = window.set_size(tauri::LogicalSize::new(PALETTE_WIDTH, COMPACT_HEIGHT));
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("palette-opened", ());
}

#[tauri::command]
fn resize_palette(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    let window = app.get_webview_window("palette").ok_or("Helm's palette is unavailable.")?;
    let height = if expanded { EXPANDED_HEIGHT } else { COMPACT_HEIGHT };
    window.set_size(tauri::LogicalSize::new(PALETTE_WIDTH, height)).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_project_log_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let log = app.get_webview_window("project-log").ok_or("Helm's debug log is unavailable.")?;
    if !visible {
        return log.hide().map_err(|error| error.to_string());
    }
    let monitor = app.get_webview_window("palette")
        .and_then(|palette| palette.current_monitor().ok().flatten())
        .or_else(|| log.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let margin = (12.0 * scale).round() as u32;
        let width = ((400.0 * scale).round() as u32).min(area.size.width.saturating_sub(2 * margin).max(1));
        let height = ((430.0 * scale).round() as u32).min(area.size.height.saturating_sub(2 * margin).max(1));
        log.set_size(tauri::PhysicalSize::new(width, height)).map_err(|error| error.to_string())?;
        log.set_position(tauri::PhysicalPosition::new(
            area.position.x + area.size.width.saturating_sub(width + margin) as i32,
            area.position.y + margin as i32,
        )).map_err(|error| error.to_string())?;
    }
    log.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn dismiss_palette(app: tauri::AppHandle, restore_focus: bool) {
    if let Some(window) = app.get_webview_window("palette") {
        let was_focused = window.is_focused().unwrap_or(false);
        let _ = window.hide();
        if restore_focus && was_focused {
            platform::restore_focus(app.state::<FocusTarget>().0.load(Ordering::Relaxed));
        }
    }
}

#[tauri::command]
async fn open_effect_controls(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let target = app.state::<FocusTarget>().0.load(Ordering::Relaxed);
        let window = app.get_webview_window("palette").ok_or("Helm's palette is unavailable.")?;
        if target == 0 || !window.is_focused().unwrap_or(false) {
            return Err("Open Helm with its shortcut from Premiere to focus Effect Controls.".into());
        }
        window.hide().map_err(|error| error.to_string())?;
        platform::restore_focus(target);
        let result = tauri::async_runtime::spawn_blocking(move || preset_windows::effect_controls_shortcut(target))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
        if result.is_err() && platform::foreground_premiere() == Some(target) {
            let _ = window.show();
            let _ = window.set_focus();
        }
        result
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Focusing Effect Controls is available on Windows.".into())
    }
}

#[tauri::command]
fn get_snapshot(state: tauri::State<'_, Arc<bridge::Bridge>>) -> bridge::Snapshot {
    state.snapshot()
}

#[tauri::command]
async fn apply_effect(
    effect_id: String,
    state: tauri::State<'_, Arc<bridge::Bridge>>,
) -> Result<serde_json::Value, String> {
    state
        .request("apply", serde_json::json!({ "effectId": effect_id }))
        .await
}

#[tauri::command]
async fn refresh_catalog(
    state: tauri::State<'_, Arc<bridge::Bridge>>,
) -> Result<serde_json::Value, String> {
    state.request("refresh", serde_json::json!({})).await
}

#[tauri::command]
async fn run_palette_command(
    app: tauri::AppHandle,
    action: String,
    value: Option<serde_json::Value>,
    state: tauri::State<'_, Arc<bridge::Bridge>>,
) -> Result<serde_json::Value, String> {
    match action.as_str() {
        "copy-attributes" | "paste-attributes" => {
            #[cfg(windows)]
            {
                let paste = action == "paste-attributes";
                let target = app.state::<FocusTarget>().0.load(Ordering::Relaxed);
                if target == 0 {
                    return Err("Open Helm with its shortcut from the Premiere timeline.".into());
                }
                state.request("check-selection", serde_json::json!({ "single": !paste })).await?;
                let window = app.get_webview_window("palette").ok_or("Helm's palette is unavailable.")?;
                if !window.is_focused().unwrap_or(false)
                    || app.state::<FocusTarget>().0.load(Ordering::Relaxed) != target
                {
                    return Err("Helm lost focus. Open the palette and try again.".into());
                }
                window.hide().map_err(|error| error.to_string())?;
                platform::restore_focus(target);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    preset_windows::attributes_shortcut(target, paste)
                }).await.map_err(|error| error.to_string()).and_then(|result| result);
                if result.is_err() && platform::foreground_premiere() == Some(target) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                result?;
                Ok(serde_json::json!({
                    "message": if paste { "Sent Paste Attributes to Premiere." } else { "Sent Copy to Premiere." },
                    "native": true
                }))
            }
            #[cfg(not(windows))]
            {
                let _ = app;
                Err("Copy and Paste Attributes are available on Windows.".into())
            }
        }
        "list-project-media" => {
            state.request("project-catalog", serde_json::json!({ "value": value })).await
        }
        "remove-attributes" | "set-opacity" | "set-volume" | "add-marker" | "list-markers" | "go-to-marker"
        | "insert-project-media" | "open-project-source" => {
            state.request("palette-command", serde_json::json!({ "action": action, "value": value })).await
        }
        _ => Err("Unsupported Helm command.".into()),
    }
}

#[tauri::command]
async fn get_presets(app: tauri::AppHandle, refresh: bool) -> Result<Vec<presets::Preset>, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<presets::PresetLibrary>()
            .load(&documents, refresh)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn apply_preset(
    app: tauri::AppHandle,
    preset_id: String,
    state: tauri::State<'_, Arc<bridge::Bridge>>,
) -> Result<serde_json::Value, String> {
    let preset = app.state::<presets::PresetLibrary>().find(&preset_id)?;
    if preset.direct_apply && !preset.filters.is_empty() {
        return state
            .request(
                "apply-preset",
                serde_json::json!({
                    "preset": {
                        "name": preset.name,
                        "filters": preset.filters,
                    }
                }),
            )
            .await;
    }

    #[cfg(not(windows))]
    {
        let _ = (app, state);
        Err("Locating presets is available on Windows.".into())
    }
    #[cfg(windows)]
    {
        let target = app.state::<FocusTarget>().0.load(Ordering::Relaxed);
        let window = app
            .get_webview_window("palette")
            .ok_or("Helm's palette is unavailable.")?;
        if !window.is_focused().unwrap_or(false) {
            return Err("Helm lost focus. Open the palette and try again.".into());
        }
        dismiss_palette(app.clone(), true);
        let result = tauri::async_runtime::spawn_blocking(move || {
            preset_windows::reveal(target, &preset)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        if result.is_err() {
            let _ = window.show();
            let _ = window.set_focus();
        }
        result.map(|()| serde_json::json!({ "revealed": true }))
    }
}

#[tauri::command]
fn set_shortcut(
    app: tauri::AppHandle,
    shortcut: String,
    state: tauri::State<'_, Arc<bridge::Bridge>>,
) -> Result<String, String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("Shortcut cannot be empty.".into());
    }
    let current = state.snapshot().shortcut;
    if shortcut == current {
        return Ok(shortcut);
    }
    let key = shortcut.parse::<Shortcut>().map_err(|error| error.to_string())?;
    if app.state::<effect_shortcuts::EffectShortcuts>().effect_for(&key).is_some() {
        return Err("That shortcut is already assigned to an effect.".into());
    }

    let _ = app.global_shortcut().unregister(current.as_str());

    if let Err(err) = app.global_shortcut().register(shortcut.as_str()) {
        let _ = app.global_shortcut().register(current.as_str());
        return Err(format!("Could not register shortcut '{shortcut}': {err}"));
    }

    state
        .update_shortcut(&app, shortcut.clone())
        .map_err(|e| format!("Failed to save shortcut: {e}"))?;

    Ok(shortcut)
}

#[tauri::command]
fn reset_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<bridge::Bridge>>,
) -> Result<String, String> {
    set_shortcut(app, DEFAULT_SHORTCUT.to_string(), state)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_palette(app, platform::foreground_premiere())
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, key, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let Some(bridge) = app.try_state::<Arc<bridge::Bridge>>() else { return };
                    let bindings = app.try_state::<effect_shortcuts::EffectShortcuts>();
                    if bindings.as_ref().is_some_and(|bindings| bindings.recording.load(Ordering::Relaxed))
                        && app.get_webview_window("palette").is_some_and(|window| window.is_focused().unwrap_or(false))
                    {
                        let _ = app.emit("effect-shortcut-conflict", ());
                        return;
                    }
                    let palette_key = bridge.shortcut().parse::<Shortcut>();
                    if !palette_key.is_ok_and(|palette_key| palette_key.id() == key.id()) {
                        let Some(effect_id) = bindings.and_then(|bindings| bindings.effect_for(key)) else { return };
                        let bridge = bridge.inner().clone();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if !platform::foreground_premiere().is_some_and(|window| window != 0) {
                                return;
                            }
                            if let Err(error) = bridge.request("apply", serde_json::json!({ "effectId": effect_id })).await {
                                let _ = app.emit("effect-shortcut-error", error);
                            }
                        });
                        return;
                    }
                    if let Some(window) = app.get_webview_window("palette") {
                        if window.is_focused().unwrap_or(false) {
                            dismiss_palette(app.clone(), true);
                        } else if let Some(target) = platform::foreground_premiere() {
                            show_palette(app, Some(target));
                        }
                    }
                })
                .build(),
        )
        .manage(FocusTarget(AtomicIsize::new(0)))
        .manage(presets::PresetLibrary::default())
        .invoke_handler(tauri::generate_handler![
            dismiss_palette,
            set_project_log_visible,
            resize_palette,
            open_effect_controls,
            get_snapshot,
            apply_effect,
            effect_shortcuts::get_effect_shortcuts,
            effect_shortcuts::set_effect_shortcut,
            effect_shortcuts::set_effect_shortcut_recording,
            refresh_catalog,
            run_palette_command,
            get_presets,
            apply_preset,
            set_shortcut,
            reset_shortcut
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("palette") {
                if let Ok(hwnd) = window.hwnd() {
                    platform::style_window(hwnd.0 as _);
                }
            }
            let data = if cfg!(debug_assertions) {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.helm")
            } else {
                std::env::current_exe()?.with_file_name(".helm")
            };
            let bindings_path = data.join("effect-shortcuts.json");
            let bridge = Arc::new(bridge::Bridge::new(DEFAULT_SHORTCUT, data)?);
            app.manage(bridge.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(bridge::serve(handle, bridge.clone()));
            if let Ok(documents) = app.path().document_dir() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        let app = handle.clone();
                        let documents = documents.clone();
                        let changed = tauri::async_runtime::spawn_blocking(move || {
                            app.state::<presets::PresetLibrary>().has_changed(&documents)
                        }).await;
                        if matches!(changed, Ok(true)) {
                            let _ = handle.emit("preset-library-changed", ());
                        }
                    }
                });
            }
            let shortcut = bridge.snapshot().shortcut;
            if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
                let mut reset_fallback = false;
                if shortcut != DEFAULT_SHORTCUT {
                    if app.global_shortcut().register(DEFAULT_SHORTCUT).is_ok() {
                        let _ = bridge.update_shortcut(app.handle(), DEFAULT_SHORTCUT.to_string());
                        reset_fallback = true;
                    }
                }
                let message = if reset_fallback {
                    format!("Could not register '{shortcut}': {error}. Reset to {DEFAULT_SHORTCUT}.")
                } else {
                    format!("Could not register {shortcut}: {error}. Open Helm from the tray.")
                };
                bridge.set_error(app.handle(), message);
            }
            let errors = effect_shortcuts::EffectShortcuts::load(app.handle(), bindings_path);
            if !errors.is_empty() {
                bridge.set_error(app.handle(), errors.join(" · "));
            }
            let show = MenuItem::with_id(app, "show", "Open Helm", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Helm", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Helm · Premiere effect palette")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_palette(app, platform::foreground_premiere()),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "palette" {
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Focused(false) => {
                if window.label() == "palette" && window.is_visible().unwrap_or(false) {
                    let win = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        if let Ok(visible) = win.is_visible() {
                            if visible && !win.is_focused().unwrap_or(false) {
                                let _ = win.hide();
                            }
                        }
                    });
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("Helm could not start");
}
