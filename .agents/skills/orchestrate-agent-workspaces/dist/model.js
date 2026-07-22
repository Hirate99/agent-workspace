import { posix } from "node:path";
const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
export function assertTaskId(id) {
    if (!TASK_ID.test(id)) {
        throw new Error(`invalid task id "${id}"; use 1-64 letters, digits, underscores, or hyphens`);
    }
}
export function normalizeScope(input) {
    const slashPath = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    const normalized = posix.normalize(slashPath);
    if (!slashPath ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.startsWith("/")) {
        throw new Error(`scope must be repository-relative: "${input}"`);
    }
    return normalized.replace(/\/$/, "") || ".";
}
export function isPathInScope(file, scope) {
    const normalizedFile = file.replaceAll("\\", "/");
    return scope === "." || normalizedFile === scope || normalizedFile.startsWith(`${scope}/`);
}
export function unique(values) {
    return [...new Set(values)];
}
