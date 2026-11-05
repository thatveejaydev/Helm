import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

await mkdir("uxp/dist/icons", { recursive: true });
await build({
  entryPoints: ["uxp/src/main.ts"],
  outfile: "uxp/dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "neutral",
  target: "es2020",
  external: ["premierepro", "uxp"],
  sourcemap: true,
});
await Promise.all([
  copyFile("uxp/manifest.json", "uxp/dist/manifest.json"),
  copyFile("uxp/index.html", "uxp/dist/index.html"),
  copyFile("uxp/style.css", "uxp/dist/style.css"),
  copyFile("uxp/icons/icon.png", "uxp/dist/icons/icon.png"),
]);

const filesToPack = ["manifest.json", "index.html", "main.js", "style.css", "icons/icon.png"];
try {
  execFileSync("tar", ["--format", "zip", "-cf", "helm-bridge.ccx", ...filesToPack], {
    cwd: resolve("uxp/dist"),
    stdio: "inherit",
  });
  console.log("Premiere CCX plugin packaged at uxp/dist/helm-bridge.ccx");
} catch (err) {
  console.warn("Could not create .ccx archive with tar:", err);
}

console.log("Premiere plugin built at uxp/dist/manifest.json");
