# Helm

Helm is a keyboard palette for Premiere Pro 25.6 and later. Press **Ctrl + Alt + Space** (or your custom shortcut configured in Settings) while Premiere is in front, type an effect name, use **↑ / ↓** to choose a result, and press **Enter** to apply it to selected timeline clips. Press **Esc** to return to Premiere.

## Set up on Windows

Run `src-tauri/target/release/helm.exe` from the workspace, or use the installer under `src-tauri/target/release/bundle/nsis`. The built app requires WebView2. Helm only runs while Adobe Premiere Pro is open: it automatically launches quietly in the system tray (with the palette hidden until you press your shortcut) whenever Premiere Pro opens, and exits automatically when Premiere Pro closes.

### Automatic Bridge Installation (Recommended)
1. Launch Helm and open **Settings** (⚙).
2. Click **Install to Premiere** under the Premiere Plugin section. Helm automatically installs `helm-bridge.ccx` into Premiere Pro via Adobe's Unified Plugin Installer Agent (UPIA).
3. If using the NSIS setup installer, Helm automatically installs the bridge during setup and removes it on uninstall.
4. Open Premiere Pro and ensure the plugin is enabled under **Window → UXP Plugins → Helm Bridge**.

### Manual Development Setup (UXP Developer Tools)
1. Enable Developer Mode in **Premiere → Edit → Preferences → Plugins**, then restart Premiere if prompted. Open **Adobe UXP Developer Tools** and enable its Developer Mode if prompted.
2. In UXP Developer Tools, choose **Add Plugin**, select `uxp\dist\manifest.json` from this folder, then choose **Load**. Open **Window → UXP Plugins → Helm Bridge** in Premiere.
3. With Helm running and Helm Bridge loaded, wait for the desktop palette to show **Premiere connected**. Helm and the bridge connect automatically. Open the gear in Helm to customize your shortcut.
4. Select a video clip, audio clip, or adjustment layer on the timeline. With Premiere active, invoke the shortcut, search for an effect, and press **Enter**. Premiere groups all compatible clips into one Undo step. Keep the bridge loaded in UXP Developer Tools during development.

The tray menu can reopen or quit Helm. If the shortcut is taken by another program, Helm shows the registration error and the tray menu is still available. You can click the shortcut in Settings to record a new one anytime, or click ↺ to reset back to default.

## Find a saved preset

1. Open **Window → Effects** in Premiere so Helm can find the panel.
2. Invoke your shortcut, choose **Presets** or search from **All**, then press **Enter**. Helm locates the Effects panel, types the preset name to isolate it, and brings Premiere to the front.
3. Drag the preset from the Effects panel onto your clip, adjustment layer, or track.
4. Use **Refresh effects and presets** in Helm settings after importing or creating a preset if it has yet to appear.

Helm reads the most recently updated Premiere profile library under your Documents folder. Folder paths distinguish matching names.

## Build and verify

Install Node.js 22.12 or later and a current Rust toolchain with a Windows linker. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows) for the standard Windows setup.

```powershell
npm ci
npm run build:uxp
npm run desktop
```

```powershell
npm run check
npm test
npm run build
npm run package
```

`npm run build` creates the desktop frontend in `dist` and the loadable Premiere plugin in `uxp/dist`. `npm run package` builds the Windows executable and NSIS installer under `src-tauri/target/release`. The installer bundles the same plugin in `premiere-plugin`; load that manifest separately in UXP Developer Tools. Run the executable from a writable folder so Helm can save its pairing key next to it. Dev builds save the key under `.helm` at the project root.

## Architecture

The Tauri app creates one WebView and reuses it on every shortcut. TypeScript searches the in-memory catalog by name or preset folder. The Rust process registers the shortcut (persisted in `.helm/shortcut`), positions the palette on the monitor containing Premiere, and hosts an authenticated WebSocket on `127.0.0.1:48139`. Only the selected effect ID crosses the bridge when you apply an effect.

The UXP plugin reads the active selection, prepares one component per compatible clip, and submits their append actions in one Premiere transaction. Video and audio effects come from Premiere's UXP factories. Saved presets come from the profile library and are applied through Premiere’s Effects panel. Use **Refresh effects and presets** after installing effects. Third-party effect coverage depends on what the host exposes.

The UI, search, and bridge can be reused on macOS. Premiere foreground detection, focus restoration, shortcut defaults, and packaging are implemented for Windows in this version.
