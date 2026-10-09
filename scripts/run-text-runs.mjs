import fs from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {
    pathToFileURL,
    fileURLToPath,
} from "node:url";

const require = createRequire(import.meta.url);
const esbuildRequire = createRequire(require.resolve("esbuild-loader"));
const {build} = esbuildRequire("esbuild");
const {JSDOM} = require("../../analysis/node_modules/jsdom");

const root = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(root, ".text-runs.bundle.mjs");
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Text = dom.window.Text;
globalThis.ShadowRoot = dom.window.ShadowRoot;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

await build({
    entryPoints: [path.join(root, "text-runs-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
});

try {
    await import(pathToFileURL(outfile).href);
} finally {
    fs.rmSync(outfile, {force: true});
}
