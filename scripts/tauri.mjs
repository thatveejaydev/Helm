import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, CARGO_HOME: resolve(root, ".cache/cargo") },
  stdio: "inherit",
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
