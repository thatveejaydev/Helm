fn main() {
    #[cfg(all(windows, target_env = "gnu"))]
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
        let crate_dir = std::env::current_dir().expect("Could not find the crate directory");
        let out_dir =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
        // GNU windres misquotes include paths with spaces when it invokes GCC.
        // Tauri can use a relative path for Cargo's in-tree build output.
        if let Ok(relative) = out_dir.strip_prefix(crate_dir) {
            if !relative.to_string_lossy().contains(' ') {
                std::env::set_var("OUT_DIR", relative);
            }
        }
    }

    tauri_build::build();
}
