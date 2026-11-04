const esbuild = require("esbuild");

Promise.all([
  esbuild.build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    external: ["vscode", "sql.js"],
    format: "cjs",
    platform: "node",
    sourcemap: true,
    outfile: "out/extension.js",
  }),
  esbuild.build({
    entryPoints: ["webview/index.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    sourcemap: true,
    outfile: "out/webview.js",
  }),
]).catch(() => process.exit(1));
