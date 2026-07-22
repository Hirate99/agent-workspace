import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskState } from "./model.js";

export function storeDir(commonDir: string): string {
  return join(commonDir, "agent-workspace");
}

function tasksDir(commonDir: string): string {
  return join(storeDir(commonDir), "tasks");
}

function taskPath(commonDir: string, id: string): string {
  return join(tasksDir(commonDir), `${id}.json`);
}

export async function loadTask(commonDir: string, id: string): Promise<TaskState | null> {
  try {
    return JSON.parse(await readFile(taskPath(commonDir, id), "utf8")) as TaskState;
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function listTasks(commonDir: string): Promise<TaskState[]> {
  try {
    const names = (await readdir(tasksDir(commonDir)))
      .filter((name) => name.endsWith(".json"))
      .sort();
    return await Promise.all(
      names.map(async (name) =>
        JSON.parse(await readFile(join(tasksDir(commonDir), name), "utf8")) as TaskState,
      ),
    );
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
}

export async function saveTask(state: TaskState): Promise<void> {
  const directory = tasksDir(state.commonDir);
  await mkdir(directory, { recursive: true });
  const target = taskPath(state.commonDir, state.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, target);
}

export async function withRepoLock<T>(
  commonDir: string,
  name: "state" | "integration",
  action: () => Promise<T>,
): Promise<T> {
  const directory = storeDir(commonDir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.lock`);
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`repository ${name} lock is already held: ${path}`);
      }
      await delay(25);
    }
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return await action();
  } finally {
    await handle.close();
    await unlink(path).catch((error) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
