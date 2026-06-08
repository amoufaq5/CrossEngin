// Bundles the operate-web-react client hydration entry for the browser. This
// runs ONLY in the `build:client` npm script — it is deliberately OFF the
// `pnpm -r build` (tsc) and vitest paths so the workspace stays hermetic with no
// bundler/browser dependency on CI's offline test path. esbuild resolves react +
// react-dom + the operate-web-react components and inlines them into one IIFE.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const require = createRequire(import.meta.url);

// Resolve the operate-web-react package's client entry (its `./client` export
// points at the canonical .tsx source — the package ships `src`).
const entry = require.resolve("@crossengin/operate-web-react/client");

const outfile = join(appRoot, "dist", "assets", "operate-web-client.js");

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  jsx: "automatic",
  jsxImportSource: "react",
  // Production React: drop the dev-only warning paths.
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "info",
});

const out = Object.entries(result.metafile.outputs).find(([p]) => p.endsWith("operate-web-client.js"));
const bytes = out ? out[1].bytes : 0;
process.stdout.write(`built ${outfile} (${(bytes / 1024).toFixed(1)} KiB)\n`);
