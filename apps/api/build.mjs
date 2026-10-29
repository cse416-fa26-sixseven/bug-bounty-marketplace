/* global console */
// Bundles the API for production: `node dist/index.js` / `node dist/migrate-cli.js`.
// The workspace package @bbm/shared (raw TS) is inlined together with its own
// dependencies (e.g. zod), since pnpm does not expose those to apps/api at
// runtime. The API's own npm dependencies (fastify, @fastify/multipart, pg)
// stay external and are resolved from apps/api/node_modules at runtime.
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, "src") + path.sep;
const outdir = path.join(root, "dist");
const inlined = new Set(["@bbm/shared"]);

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Externalizes bare specifiers imported from apps/api/src, except the
 * workspace packages we inline. Bare imports made by inlined code (anything
 * outside apps/api/src) are bundled. */
const externalizeDeps = {
  name: "externalize-deps",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (path.isAbsolute(args.path) || args.path.startsWith("node:")) return undefined;
      if (!args.importer.startsWith(srcDir)) return undefined;
      return inlined.has(packageName(args.path)) ? undefined : { path: args.path, external: true };
    });
  },
};

await rm(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", "migrate-cli": "src/db/migrate-cli.ts" },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [externalizeDeps],
  // Lets any inlined CJS-style code call require() inside the ESM bundle.
  banner: {
    js: "import { createRequire as __bbmCreateRequire } from 'node:module'; const require = __bbmCreateRequire(import.meta.url);",
  },
});

const srcMigrations = path.join(root, "src/db/migrations");
const outMigrations = path.join(outdir, "migrations");
await mkdir(outMigrations, { recursive: true });
const sqlFiles = (await readdir(srcMigrations)).filter((f) => f.endsWith(".sql"));
for (const file of sqlFiles) {
  await copyFile(path.join(srcMigrations, file), path.join(outMigrations, file));
}
console.log(`copied ${sqlFiles.length} migration(s) to dist/migrations`);
