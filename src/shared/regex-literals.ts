/**
 * 从正则里抽出「每次命中都必然出现」的字面量，供 SQL instr 预筛。
 * 抽不出、或某个分支可以不包含这些字时返回 null，调用方保持全文抽块。
 * 前瞻、后顾和反向引用不贡献字面量；遇到无法确定的写法就放弃预筛。
 */

const MAX_GROUPS = 32;
const MAX_REPEAT = 8;
const MAX_LITERAL = 64;

type Node =
    | {kind: "lit"; text: string}
    | {kind: "eps"}
    | {kind: "wild"}
    | {kind: "seq"; items: Node[]}
    | {kind: "alt"; items: Node[]}
    | {kind: "rep"; node: Node; min: number};

/** 空 alts 表示这一支提不出必现字面量。 */
type Requirement = {alts: string[][]};

function noConstraint(): Requirement {
    return {alts: []};
}

function usableLiteral(text: string): boolean {
    if (text.length >= 2) {
        return true;
    }
    return text.length === 1 && text.charCodeAt(0) > 127;
}

/** SQLite lower() 只折叠 ASCII。这类字母交给全文抽块，避免漏掉未加载命中。 */
function needsUnicodeCaseFold(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (char.charCodeAt(0) <= 127) {
            continue;
        }
        if (char.toLowerCase() !== char.toUpperCase()) {
            return true;
        }
    }
    return false;
}

function litRequirement(text: string): Requirement {
    if (!usableLiteral(text)) {
        return noConstraint();
    }
    return {alts: [[text]]};
}

function unionRequirements(left: Requirement, right: Requirement): Requirement {
    if (left.alts.length === 0 || right.alts.length === 0) {
        return noConstraint();
    }
    return {alts: left.alts.concat(right.alts)};
}

function intersectRequirements(left: Requirement, right: Requirement): Requirement {
    if (left.alts.length === 0) {
        return right;
    }
    if (right.alts.length === 0) {
        return left;
    }
    if (left.alts.length * right.alts.length > MAX_GROUPS) {
        return left.alts.length <= right.alts.length ? left : right;
    }
    const alts: string[][] = [];
    for (const group of left.alts) {
        for (const extra of right.alts) {
            alts.push(group.concat(extra));
        }
    }
    return {alts};
}

function pureLiteral(node: Node): string | null {
    if (node.kind === "lit") {
        return node.text;
    }
    if (node.kind === "seq") {
        let text = "";
        for (const item of node.items) {
            const part = pureLiteral(item);
            if (part === null) {
                return null;
            }
            text += part;
            if (text.length > MAX_LITERAL) {
                return text.slice(0, MAX_LITERAL);
            }
        }
        return text;
    }
    if (node.kind === "rep" && node.min >= 1) {
        const inner = pureLiteral(node.node);
        if (inner === null || !inner) {
            return null;
        }
        const times = Math.min(node.min, MAX_REPEAT);
        return inner.repeat(times).slice(0, MAX_LITERAL);
    }
    return null;
}

function summarize(node: Node): Requirement {
    if (node.kind === "lit") {
        return litRequirement(node.text);
    }
    if (node.kind === "eps" || node.kind === "wild") {
        return noConstraint();
    }
    if (node.kind === "alt") {
        if (node.items.length === 0) {
            return noConstraint();
        }
        let requirement = summarize(node.items[0]);
        for (let index = 1; index < node.items.length; index += 1) {
            requirement = unionRequirements(requirement, summarize(node.items[index]));
        }
        return requirement;
    }
    if (node.kind === "rep") {
        if (node.min < 1) {
            return noConstraint();
        }
        const text = pureLiteral(node);
        if (text) {
            return litRequirement(text);
        }
        return summarize(node.node);
    }
    return summarizeSequence(node.items);
}

function summarizeSequence(items: Node[]): Requirement {
    let requirement = noConstraint();
    let buffer = "";
    const flush = () => {
        if (!buffer) {
            return;
        }
        const text = buffer;
        buffer = "";
        requirement = intersectRequirements(requirement, litRequirement(text));
    };
    for (const item of items) {
        if (item.kind === "lit") {
            buffer += item.text;
            continue;
        }
        if (item.kind === "eps") {
            continue;
        }
        if (item.kind === "rep" && item.min >= 1) {
            const text = pureLiteral(item);
            if (text) {
                buffer += text;
                continue;
            }
            flush();
            requirement = intersectRequirements(requirement, summarize(item));
            continue;
        }
        if (item.kind === "wild" || (item.kind === "rep" && item.min < 1)) {
            flush();
            continue;
        }
        flush();
        requirement = intersectRequirements(requirement, summarize(item));
    }
    flush();
    return requirement;
}

function normalizeRequirement(requirement: Requirement): string[][] | null {
    if (requirement.alts.length === 0 || requirement.alts.length > MAX_GROUPS) {
        return null;
    }
    const seen = new Set<string>();
    const groups: string[][] = [];
    for (const alt of requirement.alts) {
        const literals: string[] = [];
        const local = new Set<string>();
        for (const literal of alt) {
            if (!usableLiteral(literal) || local.has(literal)) {
                continue;
            }
            local.add(literal);
            literals.push(literal);
        }
        if (literals.length === 0) {
            return null;
        }
        literals.sort();
        const key = literals.join("\0");
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        groups.push(literals);
    }
    if (groups.length === 0 || groups.length > MAX_GROUPS) {
        return null;
    }
    return groups;
}

class PatternParser {
    private index = 0;
    private depth = 0;

    constructor(private readonly source: string) {}

    parse(): Node | null {
        const node = this.parseAlt();
        if (!node || this.index !== this.source.length) {
            return null;
        }
        return node;
    }

    private peek(offset = 0): string {
        return this.source.charAt(this.index + offset);
    }

    private parseAlt(): Node | null {
        const first = this.parseSeq();
        if (!first) {
            return null;
        }
        if (this.peek() !== "|") {
            return first;
        }
        const items = [first];
        while (this.peek() === "|") {
            this.index += 1;
            const next = this.parseSeq();
            if (!next) {
                return null;
            }
            items.push(next);
        }
        return {kind: "alt", items};
    }

    private parseSeq(): Node | null {
        const items: Node[] = [];
        while (this.index < this.source.length && this.peek() !== "|" && this.peek() !== ")") {
            const atom = this.parseAtom();
            if (!atom) {
                return null;
            }
            const quantified = this.wrapQuantifier(atom);
            if (!quantified) {
                return null;
            }
            items.push(quantified);
        }
        if (items.length === 1) {
            return items[0];
        }
        return {kind: "seq", items};
    }

    private parseAtom(): Node | null {
        const current = this.peek();
        if (!current || current === "*" || current === "+" || current === "?") {
            return null;
        }
        if (current === "(") {
            return this.parseGroup();
        }
        if (current === "[") {
            return this.parseClass();
        }
        if (current === "\\") {
            return this.parseEscape();
        }
        if (current === ".") {
            this.index += 1;
            return {kind: "wild"};
        }
        if (current === "^" || current === "$") {
            this.index += 1;
            return {kind: "eps"};
        }
        this.index += 1;
        return {kind: "lit", text: current};
    }

    private parseGroup(): Node | null {
        this.index += 1;
        this.depth += 1;
        if (this.depth > 40) {
            return null;
        }
        let inner: Node | null;
        let ignore = false;
        if (this.peek() === "?") {
            this.index += 1;
            if (this.peek() === ":") {
                this.index += 1;
            } else if (this.peek() === "=" || this.peek() === "!") {
                this.index += 1;
                ignore = true;
            } else if (this.source.startsWith("<=", this.index) || this.source.startsWith("<!", this.index)) {
                this.index += 2;
                ignore = true;
            } else if (this.peek() === "<") {
                const close = this.source.indexOf(">", this.index);
                if (close < 0) {
                    return null;
                }
                this.index = close + 1;
            } else {
                return null;
            }
        }
        inner = this.parseAlt();
        this.depth -= 1;
        if (!inner || this.peek() !== ")") {
            return null;
        }
        this.index += 1;
        return ignore ? {kind: "eps"} : inner;
    }

    private parseClass(): Node | null {
        this.index += 1;
        const negated = this.peek() === "^";
        if (negated) {
            this.index += 1;
        }
        const chars: string[] = [];
        let wild = negated;
        let first = true;
        while (this.index < this.source.length && !(this.peek() === "]" && !first)) {
            first = false;
            if (this.peek() === "\\") {
                const escaped = this.parseClassEscape();
                if (escaped === null) {
                    return null;
                }
                if (escaped === "wild") {
                    wild = true;
                } else {
                    chars.push(escaped);
                }
                continue;
            }
            const start = this.peek();
            this.index += 1;
            if (this.peek() === "-" && this.peek(1) && this.peek(1) !== "]") {
                wild = true;
                this.index += 1;
                if (this.peek() === "\\") {
                    const escaped = this.parseClassEscape();
                    if (escaped === null) {
                        return null;
                    }
                } else if (this.peek() && this.peek() !== "]") {
                    this.index += 1;
                }
                continue;
            }
            chars.push(start);
        }
        if (this.peek() !== "]") {
            return null;
        }
        this.index += 1;
        if (wild || chars.length !== 1) {
            return {kind: "wild"};
        }
        return {kind: "lit", text: chars[0]};
    }

    private parseClassEscape(): string | "wild" | null {
        this.index += 1;
        const current = this.peek();
        if (!current) {
            return null;
        }
        this.index += 1;
        if ("dDwWsS".indexOf(current) >= 0) {
            return "wild";
        }
        if (current === "b") {
            return "\u0008";
        }
        return this.finishEscape(current);
    }

    private parseEscape(): Node | null {
        this.index += 1;
        const current = this.peek();
        if (!current) {
            return null;
        }
        this.index += 1;
        if (current === "b" || current === "B") {
            return {kind: "eps"};
        }
        if ("dDwWsS".indexOf(current) >= 0 || current === "p" || current === "P") {
            if ((current === "p" || current === "P") && this.peek() === "{") {
                const close = this.source.indexOf("}", this.index);
                if (close < 0) {
                    return null;
                }
                this.index = close + 1;
            }
            return {kind: "wild"};
        }
        if (current === "k" && this.peek() === "<") {
            const close = this.source.indexOf(">", this.index);
            if (close < 0) {
                return null;
            }
            this.index = close + 1;
            return {kind: "wild"};
        }
        if (current >= "1" && current <= "9") {
            while (this.peek() >= "0" && this.peek() <= "9") {
                this.index += 1;
            }
            return {kind: "wild"};
        }
        const text = this.finishEscape(current);
        if (text === null) {
            return null;
        }
        return {kind: "lit", text};
    }

    /** 反斜杠后的那个字符已经读过。 */
    private finishEscape(current: string): string | null {
        if (current === "n") {
            return "\n";
        }
        if (current === "r") {
            return "\r";
        }
        if (current === "t") {
            return "\t";
        }
        if (current === "f") {
            return "\f";
        }
        if (current === "v") {
            return "\v";
        }
        if (current === "0") {
            if (this.peek() >= "0" && this.peek() <= "7") {
                return null;
            }
            return "\0";
        }
        if (current === "x") {
            return this.readHex(2);
        }
        if (current === "u") {
            if (this.peek() === "{") {
                this.index += 1;
                const close = this.source.indexOf("}", this.index);
                if (close < 0) {
                    return null;
                }
                const hex = this.source.slice(this.index, close);
                this.index = close + 1;
                if (!/^[0-9a-fA-F]+$/.test(hex)) {
                    return null;
                }
                const code = parseInt(hex, 16);
                if (code > 0x10FFFF) {
                    return null;
                }
                return String.fromCodePoint(code);
            }
            return this.readHex(4);
        }
        if (current === "c") {
            const letter = this.peek();
            if (!letter) {
                return null;
            }
            this.index += 1;
            return String.fromCharCode(letter.toUpperCase().charCodeAt(0) & 31);
        }
        return current;
    }

    private readHex(length: number): string | null {
        const hex = this.source.slice(this.index, this.index + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) {
            return null;
        }
        this.index += length;
        return String.fromCharCode(parseInt(hex, 16));
    }

    private wrapQuantifier(atom: Node): Node | null {
        const current = this.peek();
        if (current === "*" || current === "+" || current === "?") {
            this.index += 1;
            if (this.peek() === "?") {
                this.index += 1;
            }
            return {kind: "rep", node: atom, min: current === "+" ? 1 : 0};
        }
        if (current !== "{") {
            return atom;
        }
        const start = this.index;
        const brace = this.tryBrace();
        if (brace === null) {
            this.index = start;
            return atom;
        }
        if (brace === "bad") {
            return null;
        }
        return {kind: "rep", node: atom, min: brace.min};
    }

    private tryBrace(): {min: number} | "bad" | null {
        const matched = /^\{(\d+)(,(\d+)?)?\}/.exec(this.source.slice(this.index));
        if (!matched) {
            return null;
        }
        const min = parseInt(matched[1], 10);
        if (!Number.isFinite(min)) {
            return null;
        }
        if (matched[3] !== undefined && parseInt(matched[3], 10) < min) {
            return "bad";
        }
        this.index += matched[0].length;
        if (this.peek() === "?") {
            this.index += 1;
        }
        return {min};
    }
}

/**
 * 外层是「或」，内层是「且」。null 表示不能安全预筛。
 * caseSensitive 为 false 时，字面量里若有 SQLite 无法折叠的字母，也返回 null。
 */
export function extractRegexLiteralGroups(pattern: string, caseSensitive = true): string[][] | null {
    if (!pattern || pattern.length > 2000) {
        return null;
    }
    try {
        // 与搜索使用的标志一致：不额外打开 unicode，避免抽出搜索引擎认不出的字面量。
        new RegExp(pattern);
    } catch {
        return null;
    }
    const node = new PatternParser(pattern).parse();
    if (!node) {
        return null;
    }
    const groups = normalizeRequirement(summarize(node));
    if (!groups) {
        return null;
    }
    if (!caseSensitive && groups.some((group) => group.some(needsUnicodeCaseFold))) {
        return null;
    }
    return groups;
}
