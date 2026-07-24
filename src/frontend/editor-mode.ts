import {getAllEditor} from "siyuan";

/**
 * 解析 edit 容器对应的 .protyle 元素（不含已隐藏实例）。
 */
function resolveProtyleElement(edit: Element): HTMLElement | null {
    if (edit.classList.contains("protyle")) {
        return edit as HTMLElement;
    }
    return edit.querySelector<HTMLElement>(":scope > .protyle:not(.fn__none)")
        ?? edit.querySelector<HTMLElement>(".protyle:not(.fn__none)")
        ?? edit.closest(".protyle");
}

/**
 * 导出预览：.protyle-preview 可见时不可替换。
 */
function isEditorPreviewMode(edit: Element): boolean {
    const protyleElement = resolveProtyleElement(edit);
    if (!protyleElement) {
        return false;
    }
    return Boolean(protyleElement.querySelector(".protyle-preview:not(.fn__none)"));
}

/**
 * 只读：优先看当前 Protyle 实况（含临时解锁），再看永久禁用 / 全局只读。
 * 不单独信任 config.editor.readOnly（可被文档级临时解锁覆盖）。
 */
function isEditorReadonlyMode(edit: Element): boolean {
    const protyleElement = resolveProtyleElement(edit);
    if (protyleElement?.getAttribute("disabled-forever") === "true") {
        return true;
    }

    const editors = getAllEditor();
    if (protyleElement) {
        const matched = editors.find((editor) => {
            const el = editor?.protyle?.element;
            return el === protyleElement || (el instanceof Element && (
                el.contains(protyleElement) || protyleElement.contains(el)
            ));
        });
        if (matched?.protyle?.disabled === true) {
            return true;
        }
    }

    const wysiwyg = protyleElement?.querySelector(".protyle-wysiwyg") as HTMLElement | null;
    if (wysiwyg?.getAttribute("data-readonly") === "true") {
        return true;
    }

    const config = (window as unknown as {siyuan?: {config?: {readonly?: boolean}}}).siyuan?.config;
    if (config?.readonly) {
        return true;
    }

    return false;
}

/** 发布服务访问：window.siyuan.isPublish（与 petal saveData/removeData 的 403 条件对齐） */
export function isPublishMode(): boolean {
    return Boolean((window as unknown as {siyuan?: {isPublish?: boolean}}).siyuan?.isPublish);
}

/**
 * 插件持久化（prefs / petal）是否允许写入。
 * 发布服务与全局只读下思源前端 API 会拒写；此处先行短路，避免无效 RPC。
 */
export function isPluginStorageWritable(): boolean {
    if (isPublishMode()) {
        return false;
    }
    const config = (window as unknown as {siyuan?: {config?: {readonly?: boolean}}}).siyuan?.config;
    return config?.readonly !== true;
}

/**
 * 模式级拦截：先于数据库 / 公式 / 标题等元素级判断。
 * 发布 / 预览 / 只读均禁止文档写回（替换栏仍可展开，仅禁用替换动作）。
 */
type EditorReplaceModeBlock = "publish" | "preview" | "readonly";

function getEditorReplaceModeBlock(edit: Element): EditorReplaceModeBlock | null {
    if (isPublishMode()) {
        return "publish";
    }
    if (isEditorPreviewMode(edit)) {
        return "preview";
    }
    if (isEditorReadonlyMode(edit)) {
        return "readonly";
    }
    return null;
}

export function isEditorReplaceModeBlocked(edit: Element): boolean {
    return getEditorReplaceModeBlock(edit) !== null;
}
