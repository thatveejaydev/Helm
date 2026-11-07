use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

pub fn find_upia() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let candidates = [
            std::env::var("ProgramFiles").ok().map(|p| {
                PathBuf::from(p).join("Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe")
            }),
            std::env::var("ProgramFiles(x86)").ok().map(|p| {
                PathBuf::from(p).join("Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe")
            }),
        ];
        for candidate in candidates.into_iter().flatten() {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn find_ccx(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let res_path = resource_dir.join("premiere-plugin").join("helm-bridge.ccx");
            if res_path.exists() {
                return res_path.canonicalize().ok().or(Some(res_path));
            }
        }
    }

    if let Ok(exe_dir) = std::env::current_exe().map(|e| e.parent().unwrap_or_else(|| Path::new("")).to_path_buf()) {
        let exe_res = exe_dir.join("premiere-plugin").join("helm-bridge.ccx");
        if exe_res.exists() {
            return exe_res.canonicalize().ok().or(Some(exe_res));
        }
        let direct_res = exe_dir.join("helm-bridge.ccx");
        if direct_res.exists() {
            return direct_res.canonicalize().ok().or(Some(direct_res));
        }
    }

    let dev_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../uxp/dist/helm-bridge.ccx");
    if dev_path.exists() {
        return dev_path.canonicalize().ok().or(Some(dev_path));
    }

    None
}

#[derive(serde::Serialize, Default)]
pub struct PluginStatus {
    pub upia_available: bool,
    pub installed: bool,
    pub ccx_found: bool,
    pub message: String,
}

pub fn check_plugin_status(app: &tauri::AppHandle) -> PluginStatus {
    let upia = find_upia();
    let ccx = find_ccx(Some(app));
    let mut status = PluginStatus {
        upia_available: upia.is_some(),
        ccx_found: ccx.is_some(),
        installed: false,
        message: String::new(),
    };

    if let Some(upia_path) = upia {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            if let Ok(output) = Command::new(&upia_path)
                .args(["/list", "all"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout);
                if text.contains("Helm Bridge") || text.contains("is.helm.palette.bridge") {
                    status.installed = true;
                    status.message = "Helm Bridge is installed in Premiere Pro.".into();
                    return status;
                }
            }
        }
    }

    if !status.upia_available {
        status.message = "Adobe Unified Plugin Installer Agent (UPIA) not found. Is Creative Cloud installed?".into();
    } else if !status.installed {
        status.message = "Helm Bridge is not yet installed in Premiere Pro.".into();
    }

    status
}

#[derive(serde::Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub message: String,
}

pub fn install_plugin(app: &tauri::AppHandle) -> Result<InstallResult, String> {
    install_plugin_inner(Some(app))
}

fn install_plugin_inner(app: Option<&tauri::AppHandle>) -> Result<InstallResult, String> {
    let upia_path = find_upia().ok_or_else(|| {
        "Adobe Unified Plugin Installer Agent (UPIA) was not found. Please ensure Adobe Creative Cloud is installed.".to_string()
    })?;

    let ccx_path = find_ccx(app).ok_or_else(|| {
        "helm-bridge.ccx was not found. Please run 'npm run build:uxp' first.".to_string()
    })?;

    let ccx_abs = ccx_path.to_str().ok_or("Invalid CCX path")?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let _ = Command::new(&upia_path)
            .args(["/remove", "Helm Bridge"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let output = Command::new(&upia_path)
            .args(["/install", ccx_abs])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to execute UPIA installer: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() || stdout.to_lowercase().contains("successful") {
            if let Some(app) = app {
                if let Some(bridge) = app.try_state::<std::sync::Arc<crate::bridge::Bridge>>() {
                    bridge.publish_session_now();
                }
            }
            Ok(InstallResult {
                success: true,
                message: "Helm Bridge successfully installed into Premiere Pro.".into(),
            })
        } else {
            Err(format!(
                "UPIA install exited with code {:?}. Output: {stdout} {stderr}",
                output.status.code()
            ))
        }
    }

    #[cfg(not(windows))]
    {
        Err("Automated UPIA install is currently supported on Windows.".to_string())
    }
}

pub fn ensure_latest_plugin_installed(app: &tauri::AppHandle) {
    ensure_latest_plugin_installed_inner(Some(app));
}

pub fn ensure_latest_plugin_installed_headless() {
    ensure_latest_plugin_installed_inner(None);
}

fn ensure_latest_plugin_installed_inner(app: Option<&tauri::AppHandle>) {
    #[cfg(windows)]
    {
        let Some(ccx_path) = find_ccx(app) else {
            return;
        };
        let bundled_version = ccx_path
            .parent()
            .map(|dir| dir.join("manifest.json"))
            .and_then(|manifest| std::fs::read_to_string(manifest).ok())
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|val| val.get("version").and_then(serde_json::Value::as_str).map(String::from))
            .unwrap_or_else(|| "0.1.5".to_string());

        if let Ok(appdata) = std::env::var("APPDATA") {
            let installed_manifest = PathBuf::from(appdata)
                .join("Adobe")
                .join("UXP")
                .join("Plugins")
                .join("External")
                .join(format!("is.helm.palette.bridge_{bundled_version}"))
                .join("manifest.json");
            if installed_manifest.exists() {
                return;
            }
        }

        let _ = install_plugin_inner(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}
