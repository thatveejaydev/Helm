import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("uxp/dist", { recursive: true });
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
await Promise.all(["manifest.json", "index.html", "style.css"].map((file) =>
  copyFile(`uxp/${file}`, `uxp/dist/${file}`),
));
console.log("Premiere plugin built at uxp/dist/manifest.json");
