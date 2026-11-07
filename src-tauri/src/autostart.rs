use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

pub const WATCH_ARG: &str = "--watch-premiere";
pub const AUTOSTART_ARG: &str = "--autostart";
pub const SHOW_ARG: &str = "--show";

const BRIDGE_PORT: u16 = 48139;
const DEV_SERVER_PORT: u16 = 1420;

#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WatcherConfig {
    executable: String,
    watcher_id: String,
}

pub fn watcher_mode_from_args() -> Option<Option<String>> {
    parse_watcher_mode(std::env::args().skip(1))
}

fn parse_watcher_mode<I, S>(args: I) -> Option<Option<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg.as_ref() == WATCH_ARG {
            return Some(iter.next().map(|next| next.as_ref().to_owned()));
        }
    }
    None
}

pub fn should_show_palette_on_activation(args: &[String]) -> bool {
    args.iter().any(|arg| arg == SHOW_ARG)
}

fn is_port_bound(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

pub fn is_helm_running() -> bool {
    is_port_bound(BRIDGE_PORT)
}

fn state_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("Helm"))
        .unwrap_or_else(|| std::env::temp_dir().join("helm"))
}

fn resolve_launch_executable(candidate: &Path) -> PathBuf {
    let normalized = candidate.to_string_lossy().to_ascii_lowercase();
    if (normalized.contains("\\target\\debug\\") || normalized.contains("/target/debug/"))
        && !is_port_bound(DEV_SERVER_PORT)
    {
        if let Some(release_candidate) = candidate
            .parent()
            .and_then(Path::parent)
            .map(|target| target.join("release").join("helm.exe"))
        {
            if release_candidate.is_file() {
                return release_candidate;
            }
        }
        let installed = state_dir().join("helm.exe");
        if installed.is_file() {
            return installed;
        }
    }
    if candidate.is_file() {
        return candidate.to_path_buf();
    }
    let installed = state_dir().join("helm.exe");
    if installed.is_file() {
        return installed;
    }
    std::env::current_exe().unwrap_or_else(|_| candidate.to_path_buf())
}

pub fn preferred_helm_executable() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    Some(resolve_launch_executable(&current))
}

#[cfg(windows)]
fn register_windows_integration(exe: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let Some(exe_str) = exe.to_str() else { return };
    let watch_cmd = format!("\"{exe_str}\" {WATCH_ARG}");
    let protocol_cmd = format!("\"{exe_str}\" {AUTOSTART_ARG} \"%1\"");

    let _ = Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "Helm",
            "/t",
            "REG_SZ",
            "/d",
            &watch_cmd,
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let _ = Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Classes\helm",
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            "URL:Helm Protocol",
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let _ = Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Classes\helm",
            "/v",
            "URL Protocol",
            "/t",
            "REG_SZ",
            "/d",
            "",
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let _ = Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Classes\helm\shell\open\command",
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            &protocol_cmd,
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn register_windows_integration(_: &Path) {}

#[cfg(windows)]
fn spawn_detached(exe: &Path, args: &[&str]) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;

    let mut command = Command::new(exe);
    command.args(args).creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    let _ = command.spawn();
}

#[cfg(not(windows))]
fn spawn_detached(exe: &Path, args: &[&str]) {
    let _ = Command::new(exe).args(args).spawn();
}

#[cfg(windows)]
fn is_watcher_locked(lock_path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(lock_path)
        .is_err()
}

#[cfg(not(windows))]
fn is_watcher_locked(_: &Path) -> bool {
    false
}

pub fn setup(app: &tauri::AppHandle, bridge: Arc<crate::bridge::Bridge>) {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(current_exe) = std::env::current_exe().ok() else { return };
        let launch_exe = resolve_launch_executable(&current_exe);
        let dir = state_dir();
        let _ = fs::create_dir_all(&dir);
        let config_path = dir.join("watcher-config.json");
        let lock_path = dir.join("watcher.lock");
        let target_exe_str = launch_exe.to_string_lossy().into_owned();

        register_windows_integration(&launch_exe);

        if is_watcher_locked(&lock_path)
            && read_config(&config_path).is_some_and(|cfg| cfg.executable == target_exe_str)
        {
            return;
        }

        let watcher_id = uuid::Uuid::new_v4().to_string();
        let config = WatcherConfig {
            executable: target_exe_str,
            watcher_id: watcher_id.clone(),
        };
        if let Ok(json) = serde_json::to_vec(&config) {
            let temp_path = dir.join("watcher-config.tmp");
            let _ = fs::write(&temp_path, json).and_then(|()| fs::rename(&temp_path, &config_path));
        }
        spawn_detached(&launch_exe, &[WATCH_ARG, &watcher_id]);
    });

    let app = app.clone();
    let started_from_autostart = std::env::args().any(|arg| arg == AUTOSTART_ARG || arg.starts_with("helm://"));
    tauri::async_runtime::spawn(async move {
        let mut seen_pids = crate::platform::premiere_pids();
        let mut had_premiere = !seen_pids.is_empty();
        let mut had_bridge = bridge.snapshot().connected;
        let mut empty_ticks: u32 = 0;
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            let app_handle = app.clone();
            let previous = seen_pids.clone();
            let Ok((current_pids, has_visible_window, launched)) = tauri::async_runtime::spawn_blocking(move || {
                let visible_pids = crate::platform::premiere_pids();
                let has_visible_window = !visible_pids.is_empty();
                let mut current = visible_pids;
                for &pid in &previous {
                    if crate::platform::is_premiere_process_alive(pid) {
                        current.insert(pid);
                    }
                }
                let launched = current.iter().any(|pid| !previous.contains(pid));
                (current, has_visible_window, launched)
            })
            .await
            else {
                continue;
            };
            let bridge_connected = bridge.snapshot().connected;
            if !current_pids.is_empty() || bridge_connected {
                had_premiere = true;
                empty_ticks = 0;
            } else {
                empty_ticks = empty_ticks.saturating_add(1);
            }
            if bridge_connected {
                had_bridge = true;
            }
            if should_exit_when_premiere_closes(
                had_premiere,
                current_pids.is_empty(),
                had_bridge,
                bridge_connected,
                has_visible_window,
                started_from_autostart,
                empty_ticks,
            ) {
                shutdown_helm(&app_handle);
                break;
            }
            seen_pids = current_pids;
            if launched {
                bridge.publish_session_now();
                crate::effect_shortcuts::sync_registration(&app_handle);
            }
        }
    });
}

fn should_exit_when_premiere_closes(
    had_premiere: bool,
    current_pids_empty: bool,
    had_bridge: bool,
    bridge_connected: bool,
    has_visible_window: bool,
    started_from_autostart: bool,
    empty_ticks: u32,
) -> bool {
    if had_premiere && current_pids_empty {
        return true;
    }
    if had_bridge && !bridge_connected && !has_visible_window {
        return true;
    }
    if started_from_autostart && !had_premiere && empty_ticks >= 20 {
        return true;
    }
    false
}

fn shutdown_helm(app: &tauri::AppHandle) {
    use tauri::Manager;
    #[cfg(windows)]
    crate::cursor_lock::release();
    for label in ["palette", "project-log"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
    let _ = app.remove_tray_by_id("helm-tray");
    app.exit(0);
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(300));
        std::process::exit(0);
    });
}

fn read_config(config_path: &Path) -> Option<WatcherConfig> {
    let bytes = fs::read(config_path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn should_exit_for_newer_watcher(config_path: &Path, watcher_id: Option<&str>) -> bool {
    let Some(my_id) = watcher_id else { return false };
    let Some(config) = read_config(config_path) else { return false };
    !config.watcher_id.is_empty() && config.watcher_id != my_id
}

fn spawn_helm(config_path: &Path) {
    let configured = read_config(config_path)
        .map(|cfg| PathBuf::from(cfg.executable))
        .filter(|path| !path.as_os_str().is_empty());
    let candidate = configured
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_else(|| state_dir().join("helm.exe"));
    let exe = resolve_launch_executable(&candidate);
    spawn_detached(&exe, &[AUTOSTART_ARG]);
}

#[cfg(windows)]
fn acquire_watcher_lock(lock_path: &Path) -> Option<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    for _ in 0..35 {
        if let Ok(file) = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(lock_path)
        {
            return Some(file);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

#[cfg(not(windows))]
fn acquire_watcher_lock(lock_path: &Path) -> Option<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .ok()
}

pub fn run_watcher(watcher_id: Option<String>) {
    let dir = state_dir();
    let _ = fs::create_dir_all(&dir);
    let config_path = dir.join("watcher-config.json");
    let lock_path = dir.join("watcher.lock");
    let Some(_lock) = acquire_watcher_lock(&lock_path) else {
        return;
    };

    // If spawned with a watcher_id by a running Helm instance, record any currently open
    // Premiere PIDs so quitting Helm while Premiere is open does not immediately relaunch it.
    let mut seen_pids = if watcher_id.is_some() || is_helm_running() {
        crate::platform::premiere_pids()
    } else {
        HashSet::new()
    };

    loop {
        std::thread::sleep(Duration::from_millis(750));
        if should_exit_for_newer_watcher(&config_path, watcher_id.as_deref()) {
            break;
        }
        let mut current_pids = crate::platform::premiere_pids();
        for &pid in &seen_pids {
            if crate::platform::is_premiere_process_alive(pid) {
                current_pids.insert(pid);
            }
        }
        let launched = current_pids.iter().any(|pid| !seen_pids.contains(pid));
        seen_pids = current_pids;
        if launched && !is_helm_running() {
            spawn_helm(&config_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_watcher_mode_arguments() {
        assert_eq!(parse_watcher_mode(["--autostart"]), None);
        assert_eq!(
            parse_watcher_mode(["--watch-premiere"]),
            Some(None)
        );
        assert_eq!(
            parse_watcher_mode(["--watch-premiere", "abc-123"]),
            Some(Some("abc-123".to_string()))
        );
    }

    #[test]
    fn palette_stays_hidden_unless_show_flag_passed() {
        assert!(!should_show_palette_on_activation(&[]));
        assert!(!should_show_palette_on_activation(&[
            "helm.exe".to_string(),
            "--autostart".to_string()
        ]));
        assert!(!should_show_palette_on_activation(&[
            "helm.exe".to_string(),
            "helm://launch".to_string()
        ]));
        assert!(should_show_palette_on_activation(&[
            "helm.exe".to_string(),
            "--show".to_string()
        ]));
    }

    #[test]
    fn exits_when_premiere_closes() {
        // Exits as soon as all Premiere processes exit after Premiere was seen.
        assert!(should_exit_when_premiere_closes(true, true, false, false, false, false, 1));
        // Exits immediately when both the UXP bridge disconnects and Premiere's visible window closes.
        assert!(should_exit_when_premiere_closes(true, false, true, false, false, false, 0));
        // Does not exit during splash-to-main-window transition before bridge connects while process is alive.
        assert!(!should_exit_when_premiere_closes(true, false, false, false, false, true, 0));
        // Does not exit when bridge reloads while Premiere window is still visible.
        assert!(!should_exit_when_premiere_closes(true, false, true, false, true, false, 0));
        // Exits if started via --autostart and Premiere never appeared within grace window.
        assert!(!should_exit_when_premiere_closes(false, true, false, false, false, true, 5));
        assert!(should_exit_when_premiere_closes(false, true, false, false, false, true, 20));
    }
}
