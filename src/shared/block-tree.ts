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

/** 当前已挂载标题的即时折叠状态。未挂载标题仍由 blocks.ial 判断。 */
export interface MountedHeadingFoldState {
    mountedIds: ReadonlySet<string>;
    foldedIds: ReadonlySet<string>;
}

/**
 * 思源 v3.8.6 的 IsSelfFolded：heading-fold 是旧版标题折叠写给后代的派生标记，
 * 与 fold 同时存在时不能算块自身折叠。
 */
export function isSelfFoldedIal(ial: string): boolean {
    return hasIalFlag(ial, "fold") && !hasIalFlag(ial, "heading-fold");
}

/**
 * 按思源 FoldHeadingStack 的语义计算被折叠标题盖住的块。
 * order 必须是 getDocBlocksOrders 的深度优先文档序；按 parentId 分组后，
 * 每组仍保持同级兄弟原序，可复现内核对每个容器分别扫描的行为。
 */
export function collectHeadingFoldedIds(
    order: readonly string[],
    links: ReadonlyMap<string, BlockTreeLink>,
    mountedState?: MountedHeadingFoldState,
): Set<string> {
    const siblings = new Map<string, string[]>();
    for (const id of order) {
        const node = links.get(id);
        if (!node) {
            continue;
        }
        const list = siblings.get(node.parentId) ?? [];
        list.push(id);
        siblings.set(node.parentId, list);
    }

    const hiddenRoots = new Set<string>();
    for (const ids of siblings.values()) {
        const foldedLevels: number[] = [];
        for (const id of ids) {
            const node = links.get(id);
            if (!node) {
                continue;
            }
            if (node.type !== "h") {
                if (foldedLevels.length > 0) {
                    hiddenRoots.add(id);
                }
                continue;
            }
            const level = headingLevel(node.subtype);
            while (foldedLevels.length > 0 && foldedLevels[foldedLevels.length - 1] >= level) {
                foldedLevels.pop();
            }
            const hiddenByOuterHeading = foldedLevels.length > 0;
            // 折叠刚切换时，编辑器 DOM 已更新而 SQL 索引可能尚未写入；反过来，
            // 展开后的挂载标题也不能被上一轮 IAL 的旧 fold 继续遮住。只对已挂载
            // 标题用 DOM 覆盖，未加载标题仍沿用内核持久化属性，保持全文结果完整。
            const folded = mountedState?.mountedIds.has(id) ?
                mountedState.foldedIds.has(id) :
                isSelfFoldedIal(node.ial);
            if (folded) {
                foldedLevels.push(level);
            }
            if (hiddenByOuterHeading) {
                hiddenRoots.add(id);
            }
        }
    }

    // 内核遇到被隐藏的容器会整棵跳过。blocks 表仍有其后代，因此沿 parent_id 传播一次。
    const hidden = new Set<string>();
    const memo = new Map<string, boolean>();
    const resolving = new Set<string>();
    const isHidden = (id: string): boolean => {
        const known = memo.get(id);
        if (known !== undefined) {
            return known;
        }
        if (resolving.has(id)) {
            memo.set(id, false);
            return false;
        }
        resolving.add(id);
        const node = links.get(id);
        const value = hiddenRoots.has(id) ||
            Boolean(node?.parentId && links.has(node.parentId) && isHidden(node.parentId));
        resolving.delete(id);
        memo.set(id, value);
        return value;
    };
    for (const id of links.keys()) {
        if (isHidden(id)) {
            hidden.add(id);
        }
    }
    return hidden;
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

function hasIalFlag(ial: string, name: "fold" | "heading-fold"): boolean {
    const pattern = name === "fold" ?
        /(?:^|[\s{])fold="1"(?=\s|}|$)/ :
        /(?:^|[\s{])heading-fold="1"(?=\s|}|$)/;
    return pattern.test(ial);
}

function headingLevel(subtype: string): number {
    const match = /^h?([1-6])$/.exec(subtype);
    return match ? Number(match[1]) : 7;
}
