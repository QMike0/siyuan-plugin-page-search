/**
 * 从正则里抽出「每次命中都必然出现」的 SQL 条件。
 * 字面量用 instr，数字和单词类用 GLOB。
 * 抽不出、或某个分支可以什么都不含时返回 null，调用方保持全文抽块。
 */

const MAX_GROUPS = 32;
const MAX_REPEAT = 8;
const MAX_LITERAL = 64;

export type RegexPrefilterAtom =
    | {kind: "lit"; text: string}
    | {kind: "digit"}
    | {kind: "word"};

type Node =
    | {kind: "lit"; text: string}
    | {kind: "digit"}
    | {kind: "word"}
    | {kind: "eps"}
    | {kind: "wild"}
    | {kind: "seq"; items: Node[]}
    | {kind: "alt"; items: Node[]}
    | {kind: "rep"; node: Node; min: number};

/** 空 alts 表示这一支提不出必现条件。 */
type Requirement = {alts: RegexPrefilterAtom[][]};

function noConstraint(): Requirement {
    return {alts: []};
}

function usableLiteral(text: string): boolean {
    if (text.length >= 2) {
        return true;
    }
    return text.length === 1 && text.charCodeAt(0) > 127;
}

const FINAL_SIGMA = "\u03C2";
const CAPITAL_I_WITH_DOT = "\u0130";
const LATIN_I_WITH_COMBINING_DOT = "i\u0307";

/**
 * 不区分大小写的字面量预筛使用思源 search_normalize，也就是 Go strings.ToLower
 * （hanSensitive=1，不做简繁折叠）。最终匹配用 JS toLowerCase。
 * 二者在 İ（展开成 i + 组合点）和词尾 Σ（JS 变成 ς，Go 始终是 σ）上不是超集。
 * 返回 false 时调用方必须丢掉内容谓词，退回同一范围内的全部块。
 * ASCII、汉字，以及一对一且无上下文的小写仍可以预筛。
 */
export function searchNormalizeFoldIsSuperset(needle: string): boolean {
    const folded = needle.toLowerCase();
    if (
        needle.includes(CAPITAL_I_WITH_DOT) ||
        folded.includes(FINAL_SIGMA) ||
        folded.includes(LATIN_I_WITH_COMBINING_DOT)
    ) {
        return false;
    }
    let perCodePoint = "";
    for (const char of needle) {
        const lower = char.toLowerCase();
        if (lower.length !== char.length) {
            return false;
        }
        perCodePoint += lower;
    }
    return perCodePoint === folded;
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
    return {alts: [[{kind: "lit", text}]]};
}

function classRequirement(kind: "digit" | "word"): Requirement {
    return {alts: [[{kind}]]};
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
    const alts: RegexPrefilterAtom[][] = [];
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
    if (node.kind === "digit" || node.kind === "word") {
        return classRequirement(node.kind);
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

function normalizeRequirement(requirement: Requirement): RegexPrefilterAtom[][] | null {
    if (requirement.alts.length === 0 || requirement.alts.length > MAX_GROUPS) {
        return null;
    }
    const seen = new Set<string>();
    const groups: RegexPrefilterAtom[][] = [];
    for (const alt of requirement.alts) {
        const atoms: RegexPrefilterAtom[] = [];
        const local = new Set<string>();
        for (const atom of alt) {
            if (atom.kind === "lit" && !usableLiteral(atom.text)) {
                continue;
            }
            const key = atomKey(atom);
            if (local.has(key)) {
                continue;
            }
            local.add(key);
            atoms.push(atom);
        }
        if (atoms.length === 0) {
            return null;
        }
        atoms.sort((left, right) => atomKey(left) < atomKey(right) ? -1 : atomKey(left) > atomKey(right) ? 1 : 0);
        const key = atoms.map(atomKey).join("\0");
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        groups.push(atoms);
    }
    if (groups.length === 0 || groups.length > MAX_GROUPS) {
        return null;
    }
    return groups;
}

function atomKey(atom: RegexPrefilterAtom): string {
    if (atom.kind === "lit") {
        return "l:" + atom.text;
    }
    return atom.kind;
}

function isDigitChar(text: string): boolean {
    return text.length === 1 && text >= "0" && text <= "9";
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
        let digitOnly = !negated;
        let sawDigit = false;
        let wordOnly = !negated;
        let sawWord = false;
        let first = true;
        const noteOther = () => {
            digitOnly = false;
            wordOnly = false;
        };
        while (this.index < this.source.length && !(this.peek() === "]" && !first)) {
            first = false;
            if (this.peek() === "\\") {
                const escaped = this.parseClassEscape();
                if (escaped === null) {
                    return null;
                }
                if (escaped === "digit") {
                    sawDigit = true;
                    wordOnly = false;
                } else if (escaped === "word") {
                    sawWord = true;
                    digitOnly = false;
                } else if (escaped === "wild") {
                    noteOther();
                } else if (isDigitChar(escaped)) {
                    sawDigit = true;
                    chars.push(escaped);
                } else {
                    noteOther();
                    chars.push(escaped);
                }
                continue;
            }
            const start = this.peek();
            this.index += 1;
            if (this.peek() === "-" && this.peek(1) && this.peek(1) !== "]") {
                this.index += 1;
                let end = "";
                let endClass = false;
                if (this.peek() === "\\") {
                    const escaped = this.parseClassEscape();
                    if (escaped === null) {
                        return null;
                    }
                    if (escaped === "digit" || escaped === "word" || escaped === "wild") {
                        endClass = true;
                    } else {
                        end = escaped;
                    }
                } else if (this.peek() && this.peek() !== "]") {
                    end = this.peek();
                    this.index += 1;
                }
                if (!endClass && isDigitChar(start) && isDigitChar(end) && start <= end) {
                    sawDigit = true;
                    wordOnly = false;
                } else {
                    noteOther();
                }
                continue;
            }
            if (isDigitChar(start)) {
                sawDigit = true;
                chars.push(start);
            } else {
                noteOther();
                chars.push(start);
            }
        }
        if (this.peek() !== "]") {
            return null;
        }
        this.index += 1;
        if (negated) {
            return {kind: "wild"};
        }
        if (digitOnly && sawDigit && !sawWord) {
            return {kind: "digit"};
        }
        if (wordOnly && sawWord && chars.length === 0) {
            return {kind: "word"};
        }
        // 数字区间再混一个别的字符时，不能收成那一个字符，否则只有数字的块会被漏掉。
        if (chars.length === 1 && !sawDigit && !sawWord) {
            return {kind: "lit", text: chars[0]};
        }
        return {kind: "wild"};
    }

    private parseClassEscape(): string | "wild" | "digit" | "word" | null {
        this.index += 1;
        const current = this.peek();
        if (!current) {
            return null;
        }
        this.index += 1;
        if (current === "d") {
            return "digit";
        }
        if (current === "w") {
            return "word";
        }
        if ("DWsS".indexOf(current) >= 0) {
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
        if (current === "d") {
            return {kind: "digit"};
        }
        if (current === "w") {
            return {kind: "word"};
        }
        if ("DWsS".indexOf(current) >= 0 || current === "p" || current === "P") {
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

export interface RegexPrefilterOptions {
    /** 与搜索的 u 开关一致。和忽略大小写同时打开时，Unicode case folding 会让 ASCII 字面量和 \w 不再是超集。 */
    unicode?: boolean;
}

/**
 * iu 下 \w 会匹配折叠到 ASCII 单词字符的字母（如 ſ），ss 也会命中 ſſ。
 * 数字类仍然只是 ASCII。一组「且」里只要还留着证明安全的条件，就丢掉不安全的原子；
 * 某一组被拿空时，整条预筛无法证明，返回 null，调用方全文抽块。
 */
function retainUnicodeIgnoreCaseSafeGroups(
    groups: RegexPrefilterAtom[][],
): RegexPrefilterAtom[][] | null {
    const safeGroups: RegexPrefilterAtom[][] = [];
    for (const group of groups) {
        const safe = group.filter(atomSafeUnderUnicodeIgnoreCase);
        if (safe.length === 0) {
            return null;
        }
        safeGroups.push(safe);
    }
    return safeGroups;
}

function atomSafeUnderUnicodeIgnoreCase(atom: RegexPrefilterAtom): boolean {
    if (atom.kind === "digit") {
        return true;
    }
    if (atom.kind !== "lit" || !atom.text) {
        return false;
    }
    for (const char of atom.text) {
        if ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z")) {
            return false;
        }
        if (char.toLowerCase() !== char.toUpperCase()) {
            return false;
        }
    }
    return true;
}

/**
 * 外层是「或」，内层是「且」。null 表示不能安全预筛。
 * caseSensitive 为 false 时，字面量里若有 SQLite 无法折叠的字母，也返回 null。
 * unicode 且忽略大小写时，无法证明的字面量或 \w 同样返回 null。
 */
export function extractRegexLiteralGroups(
    pattern: string,
    caseSensitive = true,
    options: RegexPrefilterOptions = {},
): RegexPrefilterAtom[][] | null {
    if (!pattern || pattern.length > 2000) {
        return null;
    }
    const unicode = options.unicode === true;
    try {
        // 标志与正式搜索一致，避免抽出当前引擎认不出的字面量。
        new RegExp(pattern, unicode ? "u" : "");
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
    if (!caseSensitive && groups.some((group) => group.some((atom) => atom.kind === "lit" && needsUnicodeCaseFold(atom.text)))) {
        return null;
    }
    if (unicode && !caseSensitive) {
        return retainUnicodeIgnoreCaseSafeGroups(groups);
    }
    return groups;
}

/** 每一组都有字面量时才写入普通正文缓存。纯数字或单词类会命中很多块。 */
export function regexPrefilterStoresPlainCache(groups: RegexPrefilterAtom[][]): boolean {
    return groups.every((group) => group.some((atom) => atom.kind === "lit"));
}
