export interface BlockAncestorIncludeFlags {
    includeBlockquote?: boolean;
    includeCallout?: boolean;
    includeSuperBlock?: boolean;
    includeListUnordered?: boolean;
    includeListOrdered?: boolean;
    includeListTask?: boolean;
}

export interface BlockTreeLink {
    parentId: string;
    type: string;
    subtype: string;
    ial: string;
}

/**
 * 冷路径拿到的是单个叶子块 DOM，无法再用 Element.closest 判断容器范围。
 * 按 blocks.parent_id 链应用与活 DOM 相同的引述、Callout、超级块和列表门闩。
 * 思源 v3.8.6 的列表/列表项 subtype 都是 u/o/t；Callout 的 type 缩写为 callout。
 */
export function isBlockTreeEnabled(
    id: string,
    links: ReadonlyMap<string, BlockTreeLink>,
    options: BlockAncestorIncludeFlags,
): boolean {
    const seen = new Set<string>();
    let current = id;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = links.get(current);
        if (!node) {
            break;
        }
        if (node.type === "b" && options.includeBlockquote === false) {
            return false;
        }
        if (node.type === "callout" && options.includeCallout === false) {
            return false;
        }
        if (node.type === "s" && options.includeSuperBlock === false) {
            return false;
        }
        if ((node.type === "l" || node.type === "i") && !isListSubtypeEnabled(node.subtype, options)) {
            return false;
        }
        current = node.parentId;
    }
    return true;
}

function isListSubtypeEnabled(subtype: string, options: BlockAncestorIncludeFlags): boolean {
    if (subtype === "u") {
        return options.includeListUnordered !== false;
    }
    if (subtype === "o") {
        return options.includeListOrdered !== false;
    }
    if (subtype === "t") {
        return options.includeListTask !== false;
    }
    // 未知/旧数据不猜类型，交给上层列表祖先继续判定。
    return true;
}
