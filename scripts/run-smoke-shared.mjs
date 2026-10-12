import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const esbuildRequire = createRequire(require.resolve("esbuild-loader"));
const {build} = esbuildRequire("esbuild");

const root = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(root, ".smoke-shared.bundle.mjs");

await build({
    entryPoints: [path.join(root, "smoke-shared-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
});

const result = spawnSync(process.execPath, [outfile], {stdio: "inherit"});
fs.rmSync(outfile, {force: true});
process.exit(result.status ?? 1);
