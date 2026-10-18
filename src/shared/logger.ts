/** Separate from search preferences so diagnostics also work without the plugin kernel. */
export const LOGGING_STORAGE_PATH = "logging.json";

type LogDetails = Record<string, string | number | boolean | undefined>;
let debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
    debugEnabled = enabled;
}

export function isDebugLoggingEnabled(): boolean {
    return debugEnabled;
}

function output(level: "debug" | "warn" | "error", event: string, details?: LogDetails): void {
    // Diagnostics must never interrupt search, navigation, writes or cleanup.
    try {
        if (details) console[level](`[page-search] ${event}`, details);
        else console[level](`[page-search] ${event}`);
    } catch {
        // Some console integrations can throw.
    }
}

export function logDebug(event: string, details?: LogDetails): void {
    if (debugEnabled) output("debug", event, details);
}

export function logWarning(event: string, details?: LogDetails): void {
    output("warn", event, details);
}

export function logError(event: string, details?: LogDetails): void {
    output("error", event, details);
}

/** Do not retain response objects, DOM, matches or full error payloads in the console. */
export function errorDetails(error: unknown): LogDetails {
    return error instanceof Error ? {name: error.name, message: error.message.slice(0, 300)} :
        {name: typeof error};
}
