// Bundles src/ into dist/ (load dist/ as an unpacked extension).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const STATIC = [
  "manifest.json", "theme.css", "theme-init.js", "icons", "offscreen.html",
  "sidepanel.html", "sidepanel.css", "options.html", "options.css", "report.html", "report.css",
];

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const f of STATIC) cpSync(`src/${f}`, `dist/${f}`, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ["src/background.js", "src/offscreen.js", "src/sidepanel.js", "src/options.js", "src/report.js", "src/meet.js", "src/overlay.js"],
  bundle: true,
  format: "esm", // meet.js and overlay.js have no imports/exports, so they stay valid classic content scripts
  target: "chrome116",
  outdir: "dist",
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
