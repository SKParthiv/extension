const esbuild = require("esbuild");

esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  outfile: "out/extension.js",
}).catch(() => process.exit(1));

