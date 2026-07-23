import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export function storeDir(commonDir) {
    return join(commonDir, "agent-workspace");
}
export function taskRuntimeDir(commonDir, id) {
    return join(storeDir(commonDir), "runtime", id);
}
function tasksDir(commonDir) {
    return join(storeDir(commonDir), "tasks");
}
function taskPath(commonDir, id) {
    return join(tasksDir(commonDir), `${id}.json`);
}
export async function loadTask(commonDir, id) {
    try {
        return JSON.parse(await readFile(taskPath(commonDir, id), "utf8"));
    }
    catch (error) {
        if (isCode(error, "ENOENT"))
            return null;
        throw error;
    }
}
export async function listTasks(commonDir) {
    try {
        const names = (await readdir(tasksDir(commonDir)))
            .filter((name) => name.endsWith(".json"))
            .sort();
        return await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(tasksDir(commonDir), name), "utf8"))));
    }
    catch (error) {
        if (isCode(error, "ENOENT"))
            return [];
        throw error;
    }
}
export async function saveTask(state) {
    const directory = tasksDir(state.commonDir);
    await mkdir(directory, { recursive: true });
    const target = taskPath(state.commonDir, state.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, target);
}
export async function removeTaskRuntimeDir(commonDir, id) {
    await rm(taskRuntimeDir(commonDir, id), { recursive: true, force: true, maxRetries: 3 });
}
export async function withRepoLock(commonDir, name, action) {
    const directory = storeDir(commonDir);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${name}.lock`);
    const deadline = Date.now() + 5_000;
    let handle;
    while (!handle) {
        try {
            handle = await open(path, "wx");
        }
        catch (error) {
            if (!isCode(error, "EEXIST"))
                throw error;
            if (Date.now() >= deadline) {
                throw new Error(`repository ${name} lock is already held: ${path}`);
            }
            await delay(25);
        }
    }
    try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
        return await action();
    }
    finally {
        await handle.close();
        await unlink(path).catch((error) => {
            if (!isCode(error, "ENOENT"))
                throw error;
        });
    }
}
function isCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
