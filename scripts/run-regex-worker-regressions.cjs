// Execute the release bundle through SiYuan's eval/CommonJS contract and a real worker thread.
// The thread supplies Web Worker messaging only: no module/exports/require inside the worker script.
// This checks the installed package, not an actual SiYuan browser session or HTTP/CSP configuration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {inflateRawSync} = require("node:zlib");
const {Worker: ThreadWorker} = require("node:worker_threads");
const ts = require("typescript");
const repo = path.resolve(__dirname, "..");

// Read the central directory so the test uses the exact scripts shipped in package.zip.
function readPackage() {
    const zip = fs.readFileSync(path.join(repo, "package.zip"));
    let end = zip.length - 22;
    while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
    assert.ok(end >= 0 && zip.readUInt32LE(end) === 0x06054b50, "package has a ZIP central directory");
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const files = new Map();
    for (let i = 0; i < count; i++) {
        assert.equal(zip.readUInt32LE(offset), 0x02014b50);
        const method = zip.readUInt16LE(offset + 10);
        const size = zip.readUInt32LE(offset + 20);
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
        const local = zip.readUInt32LE(offset + 42);
        assert.equal(zip.readUInt32LE(local), 0x04034b50);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const compressed = zip.subarray(start, start + size);
        assert.ok(method === 0 || method === 8, "supported ZIP compression");
        assert.equal(files.has(name), false, "no duplicate package entry");
        files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

const files = readPackage();
const manifest = JSON.parse(files.get("plugin.json").toString("utf8"));
assert.equal(manifest.disabledInPublish, false);
assert.deepEqual(manifest.publish?.resources, ["page-search-regex-worker.js"], "publish declares only the worker");
assert.ok(!manifest.publish?.data?.length, "no plugin data is exposed to publish readers");
for (const file of ["index.js", "page-search-regex-worker.js", "kernel.js", "index.css", "plugin.json"]) {
    assert.ok(files.has(file), `${file} exists at the package root`);
    assert.deepEqual(files.get(file), fs.readFileSync(path.join(repo, "dist", file)), "package matches dist");
}
assert.ok([...files.keys()].every(name => !name.startsWith("dist/") && !name.includes("..")));
const bundle = files.get("index.js").toString("utf8");

// Expose the compiled matcher in memory, without changing its code or the release artifact.
const ast = ts.createSourceFile("index.js", bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const classes = [];
function visit(node) {
    if (
        ts.isClassDeclaration(node) &&
        node.members.some(member => member.name?.getText(ast) === "ensureWorker")
    ) classes.push(node);
    ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(classes.length, 1, "release contains one regex matcher implementation");
const matcherClass = classes[0];
assert.ok(ts.isBlock(matcherClass.parent));
const insert = matcherClass.parent.end - 1;
const executable = bundle.slice(0, insert) +
    `;globalThis.PackagedRegexMatcher = ${matcherClass.name.text};` + bundle.slice(insert);

const threadBootstrap = `
const {parentPort, workerData} = require("node:worker_threads");
const vm = require("node:vm");
const self = {
    addEventListener(type, listener) {
        if (type === "message") parentPort.on("message", data => listener({data}));
    },
    postMessage(data) {parentPort.postMessage(data);},
};
const start = () => vm.runInNewContext(workerData.script, {self}, {filename: workerData.url});
if (workerData.startupDelay) setTimeout(start, workerData.startupDelay);
else start();
`;
const created = [];
const terminations = [];
class PackagedWorker {
    static startupDelay = 0;
    constructor(url) {
        const actual = new URL(String(url));
        assert.equal(actual.origin, new URL(pageUrl).origin, "worker is served by the current kernel");
        const prefix = `/plugins/${encodeURIComponent(manifest.name)}/`;
        assert.ok(actual.pathname.startsWith(prefix), "worker uses SiYuan's plugin resource route");
        const file = decodeURIComponent(actual.pathname.slice(prefix.length));
        assert.ok(files.has(file), `worker URL resolves to a release asset: ${actual.pathname}`);
        this.listeners = new Map();
        this.sent = [];
        this.received = [];
        this.thread = new ThreadWorker(threadBootstrap, {
            eval: true,
            workerData: {
                script: files.get(file).toString("utf8"),
                url: actual.href,
                startupDelay: PackagedWorker.startupDelay,
            },
        });
        this.thread.on("message", data => {
            this.received.push(data);
            this.emit("message", {data});
        });
        this.thread.on(
            "error",
            error => this.emit("error", {message: error.message, filename: actual.href, lineno: 0}),
        );
        created.push(this);
    }
    emit(type, event) {
        for (const listener of this.listeners.get(type) || []) listener({...event, currentTarget: this});
    }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }
    postMessage(data) {
        this.sent.push(data.kind);
        this.thread.postMessage(data);
    }
    terminate() {
        terminations.push(this.thread.terminate());
    }
}

const pageUrl = "https://127.0.0.1:6806/stage/build/app/?r=fixture";
const warnings = [];
const context = vm.createContext({
    URL,
    Worker: PackagedWorker,
    performance,
    document: {baseURI: pageUrl}, // No currentScript or plugin script tag during SiYuan's eval.
    window: {setTimeout, clearTimeout},
    console: {warn: (...args) => warnings.push(args)},
});
context.require = name => {
    assert.equal(name, "siyuan", "entry keeps the host-provided CommonJS API");
    return {Plugin: class {}};
};
const moduleObject = {exports: {}};
vm.runInContext("(function anonymous(require,module,exports){" + executable + "\n})", context)(
    context.require,
    moduleObject,
    moduleObject.exports,
);
assert.equal(typeof moduleObject.exports.default, "function", "plugin entry still exports its class");

const unit = text => ({
    blockId: "b",
    blockType: "NodeParagraph",
    blockIndex: 0,
    text,
    segmentLengths: [text.length],
});
const plain = value => JSON.parse(JSON.stringify(value));
const options = {regex: true};
const matcher = new context.PackagedRegexMatcher();
async function main() {
    try {
        for (
            const [text, query, expected] of [
                ["3 13 333", "3", ["3", "3", "3", "3", "3"]],
                ["号码 13800138000；19912345678；123", "1[3-9]\\d{9}", ["13800138000", "19912345678"]],
                ["😀a", "(?=😀)|a", ["a"]],
            ]
        ) {
            const result = await matcher.match([unit(text)], query, options);
            assert.equal(result.error, "");
            assert.deepEqual(plain(result.hits.map(hit => hit.matchedText)), expected);
            const exportedHits = moduleObject.exports.matchTextUnits([unit(text)], query, options);
            assert.deepEqual(plain(result.hits), plain(exportedHits), "compiled Worker and entry agree");
        }
        assert.equal(created.length, 1, "completed queries reuse the worker");
        const invalid = await matcher.match([unit("abc")], "[", options);
        assert.ok(invalid.error && !invalid.error.includes("Worker"), "syntax errors come from RegExp compilation");
        assert.equal((await matcher.match([unit("3")], "3", options)).error, "", "syntax error does not poison worker");
        for (
            const [text, query, expected] of [
                ["😀", ".", ["\uD83D", "\uDE00"]],
                ["a\nfoo\nb", "^foo$", []],
                ["a\nb", "a.b", []],
            ]
        ) {
            const legacyFlags = {regexUnicode: true, regexMultiline: true, regexDotAll: true};
            const result = await matcher.match([unit(text)], query, {...options, ...legacyFlags});
            assert.equal(result.error, "");
            assert.deepEqual(plain(result.hits.map(hit => hit.matchedText)), expected);
            assert.deepEqual(
                plain(result.hits),
                plain(moduleObject.exports.matchTextUnits([unit(text)], query, options)),
            );
            const expansion = await matcher.expandReplacements(
                [{id: "b", haystack: text, replacements: result.hits}],
                "(" + query + ")",
                "[$1]",
                legacyFlags,
            );
            assert.equal(expansion.error, "");
            assert.deepEqual(
                plain(expansion.expansions.map(hit => hit.replacement)),
                expected.map(text => "[" + text + "]"),
            );
        }
        const pattern = "(1[3-9])(\\d{9})";
        const text = "号码 13800138000";
        const found = await matcher.match([unit(text)], pattern, options);
        const expanded = await matcher.expandReplacements(
            [{
                id: "b",
                haystack: text,
                replacements: found.hits.map(hit => ({...hit})),
            }],
            pattern,
            "$1-[$2]-$&",
            {},
        );
        assert.equal(expanded.error, "");
        assert.equal(expanded.expansions[0].replacement, "13-[800138000]-13800138000");
        assert.equal(expanded.expansions[0].haystack, text);
        const wireExpansion = created.at(-1).received.filter(data => data.kind === "expand").at(-1);
        assert.ok(wireExpansion.result.every(item => !Object.hasOwn(item, "haystack")),
            "Worker wire results omit original text; main-thread snapshots are still restored");

        const request = [{id: "u", haystack: "a", replacements: [{id: "h", start: 0, end: 1, matchedText: "a"}]}];
        const cumulative = {remainingResults: 2, remainingBytes: 6};
        assert.equal((await matcher.expandReplacements(request, "a", "x", {}, undefined, cumulative)).error, "");
        assert.equal(cumulative.remainingBytes, 2);
        const overBudget = await matcher.expandReplacements(request, "a", "x", {}, undefined, cumulative);
        assert.ok(overBudget.error.includes("数据量过大"));
        assert.deepEqual(plain(overBudget.expansions), [], "no partial expansion escapes on budget failure");
        assert.equal((await matcher.expandReplacements(request, "a", "x", {})).error, "", "new operations get a fresh budget");

        const hugeOutput = await matcher.expandReplacements(
            [{id: "u", haystack: "a".repeat(10000), replacements: [{id: "h", start: 0, end: 1, matchedText: "a"}]}],
            "^a", "$'".repeat(4000), {},
        );
        assert.ok(hugeOutput.error.includes("数据量过大"), "fast output expansion is limited independently of regex timeout");
        const tooMany = await matcher.match([unit("a".repeat(250001))], "a", options);
        assert.ok(tooMany.error.includes("数据量过大"));
        assert.equal(tooMany.hits.length, 0, "oversized search never publishes truncated results");
        const sendsBefore = created.reduce((sum, worker) => sum + worker.sent.length, 0);
        const hugeInput = await matcher.match([unit("a".repeat(32 * 1024 * 1024 + 1))], "a", options);
        assert.ok(hugeInput.error.includes("数据量过大"));
        assert.equal(created.reduce((sum, worker) => sum + worker.sent.length, 0), sendsBefore,
            "oversized input is rejected before postMessage serialization");
        assert.equal((await matcher.match([unit("a")], "a", options)).hits.length, 1, "worker recovers after resource rejection");

        const substitutionTemplate =
            "$0|$00|$01|$001|$12|$100|$99|$<known>|$<missing>|$<>|$<missing$1>|$<unclosed$1|$&|$`|$'|$$";
        for (const query of ["(a)|(b)", "(?<known>a)|(?<other>b)"]) {
            const haystack = "left a b right";
            const result = await matcher.match([unit(haystack)], query, options);
            const expansion = await matcher.expandReplacements(
                [{id: "b", haystack, replacements: result.hits}], query, substitutionTemplate, {},
            );
            assert.equal(expansion.error, "");
            let output = "";
            let cursor = 0;
            for (let index = 0; index < result.hits.length; index++) {
                const hit = result.hits[index];
                assert.notEqual(expansion.expansions[index].replacement, null);
                output += haystack.slice(cursor, hit.start) + expansion.expansions[index].replacement;
                cursor = hit.end;
            }
            output += haystack.slice(cursor);
            assert.equal(output, haystack.replace(new RegExp(query, "gi"), substitutionTemplate),
                "packaged Worker retains native GetSubstitution and original context across matches");
        }

        const abort = new AbortController();
        const aborted = matcher.match([unit("a".repeat(35) + "!")], "(a+)+$", options, abort.signal);
        abort.abort();
        assert.equal((await aborted).cancelled, true);
        const stale = matcher.match([unit("a".repeat(35) + "!")], "(a+)+$", options);
        const latest = matcher.match([unit("3")], "3", options);
        assert.equal((await stale).cancelled, true);
        assert.equal((await latest).hits.length, 1);
        const timeout = await matcher.match([unit("a".repeat(35) + "!")], "(a+)+$", options);
        assert.ok(timeout.error.includes("超时"), "catastrophic backtracking is terminated");
        assert.equal((await matcher.match([unit("3")], "3", options)).hits.length, 1, "worker restarts after timeout");

        const count = created.length;
        assert.equal((await matcher.match([unit("foo")], "FOO", {})).hits.length, 1);
        assert.equal(created.length, count, "ordinary search does not create a worker");
        const disposed = matcher.match([unit("a".repeat(35) + "!")], "(a+)+$", options);
        matcher.dispose();
        assert.equal((await disposed).cancelled, true);

        // Real worker startup exceeds the old 2.5-second combined deadline.
        PackagedWorker.startupDelay = 3000;
        const slowMatch = matcher.match([unit("3")], "3", options);
        const slowWorker = created.at(-1);
        assert.equal(slowWorker.sent.length, 0, "no text payload is sent before worker readiness");
        assert.equal((await slowMatch).hits.length, 1, "slow startup does not consume regex execution budget");
        assert.equal(slowWorker.sent.length, 1);
        const workerCount = created.length;
        assert.equal((await matcher.match([unit("3")], "3", options)).hits.length, 1);
        assert.equal(created.length, workerCount, "warm worker needs no second readiness exchange");
        matcher.dispose();
        const slowExpansion = await matcher.expandReplacements(
            [{id: "u", haystack: "3", replacements: [{id: "h", start: 0, end: 1, matchedText: "3"}]}],
            "(3)",
            "[$1]",
            {},
        );
        assert.equal(slowExpansion.error, "");
        assert.equal(slowExpansion.expansions[0].replacement, "[3]", "cold replacement also waits for readiness");
        matcher.dispose();
        PackagedWorker.startupDelay = 0;
        assert.equal(warnings.length, 0, "release worker boots and executes without runtime errors");
        await checkReadinessLifecycle();
        console.log(
            "regex release: publish/eval/ZIP, slow startup and replacement, reuse, cancellation, timeout/retry and cleanup OK",
        );
    } finally {
        matcher.dispose();
        await Promise.allSettled(terminations);
    }
}

// Deterministic time covers a never-ready worker and queued messages from terminated workers,
// without a ten-second wall-clock wait. The actual compiled matcher remains unchanged.
async function checkReadinessLifecycle() {
    let clock = 0;
    let nextTimer = 1;
    const timers = new Map();
    const realWindow = context.window;
    const realWorker = context.Worker;
    const controlled = [];
    context.window = {
        setTimeout(callback, delay) {
            const id = nextTimer++;
            timers.set(id, {callback, at: clock + delay});
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    };
    context.Worker = class {
        constructor() {
            this.listeners = new Map();
            this.sent = [];
            this.terminated = false;
            controlled.push(this);
        }
        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        }
        removeEventListener(type) {
            this.listeners.delete(type);
        }
        emit(data) {
            this.listeners.get("message")?.({data, currentTarget: this});
        }
        postMessage(data) {
            if (this.failPost) throw new Error("fixture postMessage failure");
            this.sent.push(data);
        }
        terminate() {
            this.terminated = true;
        }
    };
    function advance(ms) {
        clock += ms;
        for (const [id, timer] of [...timers]) {
            if (timer.at > clock || !timers.has(id)) continue;
            timers.delete(id);
            timer.callback();
        }
    }
    const subject = new context.PackagedRegexMatcher();
    try {
        const neverReady = subject.match([unit("3")], "3", options);
        const stalled = controlled.at(-1);
        advance(9999);
        assert.equal(stalled.terminated, false);
        advance(1);
        const failure = await neverReady;
        assert.ok(failure.error.includes("加载超时") && !failure.error.includes("简化"));
        assert.equal(stalled.terminated, true);
        assert.equal(stalled.sent.length, 0);
        assert.equal(timers.size, 0, "startup timeout clears pending state");

        const retry = subject.match([unit("3")], "3", options);
        const worker = controlled.at(-1);
        worker.emit({kind: "ready"});
        worker.emit({kind: "ready"});
        assert.equal(worker.sent.length, 1, "duplicate ready never resends or extends execution");
        assert.equal(timers.size, 1);
        assert.equal([...timers.values()][0].at - clock, 2500, "ready swaps startup timer for execution budget");
        advance(2499);
        const request = worker.sent[0];
        worker.emit({id: request.id, kind: request.kind, result: {hits: [], error: ""}});
        assert.equal((await retry).error, "");
        assert.equal(timers.size, 0, "completion clears execution timer");
        subject.dispose();

        const abort = new AbortController();
        const cancelled = subject.match([unit("3")], "3", options, abort.signal);
        const abortWorker = controlled.at(-1);
        abort.abort();
        assert.equal((await cancelled).cancelled, true);
        assert.equal(abortWorker.terminated, true);
        assert.equal(timers.size, 0);

        const old = subject.match([unit("3")], "3", options);
        const oldWorker = controlled.at(-1);
        const oldListener = oldWorker.listeners.get("message");
        const oldErrorListener = oldWorker.listeners.get("error");
        const latest = subject.match([unit("3")], "3", options);
        const newWorker = controlled.at(-1);
        assert.equal((await old).cancelled, true);
        oldListener({data: {kind: "ready"}, currentTarget: oldWorker});
        oldErrorListener({message: "late old failure", currentTarget: oldWorker});
        assert.equal(newWorker.sent.length, 0, "late old readiness cannot start the new worker task");
        assert.equal(newWorker.terminated, false, "late old errors cannot terminate the new worker task");
        newWorker.emit({kind: "ready"});
        const newRequest = newWorker.sent[0];
        newWorker.emit({id: newRequest.id, kind: newRequest.kind, result: {hits: [], error: ""}});
        assert.equal((await latest).error, "");
        assert.equal(timers.size, 0);
        subject.dispose();

        const literal = subject.match([unit("3")], "3", options);
        const literalWorker = controlled.at(-1);
        assert.equal((await subject.match([unit("3")], "3", {})).hits.length, 1);
        assert.equal((await literal).cancelled, true);
        assert.equal(literalWorker.terminated, true);
        assert.equal(timers.size, 0);
        const disposing = subject.expandReplacements([], "3", "", {});
        subject.dispose();
        assert.equal((await disposing).cancelled, true);
        assert.equal(timers.size, 0, "dispose during startup clears both task and worker");

        // Loading/runtime errors settle both search and replacement, release retained text,
        // and leave the matcher able to create a new worker on the next request.
        for (const kind of ["match", "expand"]) {
            for (const ready of [false, true]) {
                const failing = kind === "match" ?
                    subject.match([unit("3")], "3", options) :
                    subject.expandReplacements([], "3", "", {});
                const failingWorker = controlled.at(-1);
                const pending = subject.pending;
                if (ready) failingWorker.emit({kind: "ready"});
                failingWorker.listeners.get("error")({message: "fixture failure", currentTarget: failingWorker});
                assert.equal((await failing).error, "正则 Worker 执行失败");
                assert.equal(failingWorker.terminated, true);
                assert.equal(subject.pending, null);
                assert.equal(pending.message, null, "failure releases the queued payload");
                assert.equal(timers.size, 0, "failure clears startup/execution timer");
            }
        }
        for (const kind of ["match", "expand"]) {
            const failing = kind === "match" ?
                subject.match([unit("3")], "3", options) :
                subject.expandReplacements([], "3", "", {});
            const failingWorker = controlled.at(-1);
            const pending = subject.pending;
            failingWorker.failPost = true;
            failingWorker.emit({kind: "ready"});
            assert.ok((await failing).error, "postMessage failure settles the request");
            assert.equal(failingWorker.terminated, true);
            assert.equal(subject.pending, null);
            assert.equal(pending.message, null);
            assert.equal(timers.size, 0);
        }
        const recovered = subject.match([unit("3")], "3", options);
        const recoveredWorker = controlled.at(-1);
        recoveredWorker.emit({kind: "ready"});
        const recoveredRequest = recoveredWorker.sent[0];
        recoveredWorker.emit({id: recoveredRequest.id, kind: "match", result: {hits: [], error: ""}});
        assert.equal((await recovered).error, "", "requests recover after worker errors and postMessage failure");
        assert.equal(timers.size, 0);
    } finally {
        subject.dispose();
        context.window = realWindow;
        context.Worker = realWorker;
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
