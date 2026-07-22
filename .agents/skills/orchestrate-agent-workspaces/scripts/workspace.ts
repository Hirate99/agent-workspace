import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { CommandError, git, runShell } from "./git.ts";
import {
  assertTaskId,
  isPathInScope,
  normalizeScope,
  unique,
  type TaskState,
} from "./model.ts";
import { listTasks, loadTask, saveTask, withRepoLock } from "./store.ts";

export interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir: string;
  isMain: boolean;
}

export interface CreateOptions {
  base?: string;
  worktreeRoot?: string;
  scopes?: string[];
  exclusive?: string[];
}

export interface IntegrateOptions {
  checks?: string[];
}

export interface CleanupOptions {
  force?: boolean;
}

export async function getRepoInfo(input: string): Promise<RepoInfo> {
  const cwd = resolve(input);
  const reportedRoot = resolve(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim(),
  );
  const root = await realpath(reportedRoot);
  const gitDirValue = (await git(reportedRoot, ["rev-parse", "--git-dir"])).stdout.trim();
  const commonDirValue = (
    await git(reportedRoot, ["rev-parse", "--git-common-dir"])
  ).stdout.trim();
  const gitDir = await realpath(
    isAbsolute(gitDirValue) ? normalize(gitDirValue) : resolve(reportedRoot, gitDirValue),
  );
  const commonDir = await realpath(
    isAbsolute(commonDirValue) ? normalize(commonDirValue) : resolve(reportedRoot, commonDirValue),
  );
  return { root, gitDir, commonDir, isMain: samePath(gitDir, commonDir) };
}

export async function createTask(
  repoPath: string,
  id: string,
  options: CreateOptions = {},
): Promise<TaskState> {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  requireMain(repo, "create");

  return withRepoLock(repo.commonDir, "state", async () => {
    if (await loadTask(repo.commonDir, id)) {
      throw new Error(`task already exists: ${id}`);
    }

    const scopes = unique((options.scopes ?? []).map(normalizeScope));
    const exclusive = unique((options.exclusive ?? []).map(normalizeResource));
    const tasks = await listTasks(repo.commonDir);
    const conflict = tasks.find(
      (task) =>
        (task.status === "active" || task.status === "submitted") &&
        task.exclusive.some((resource) => exclusive.includes(resource)),
    );
    if (conflict) {
      const resources = conflict.exclusive.filter((resource) => exclusive.includes(resource));
      throw new Error(
        `exclusive resource conflict with ${conflict.id}: ${resources.join(", ")}`,
      );
    }

    const baseRef = options.base ?? "HEAD";
    const base = (
      await git(repo.root, ["rev-parse", "--verify", `${baseRef}^{commit}`])
    ).stdout.trim();
    const branch = `agent-workspace/${id}`;
    const branchCheck = await git(
      repo.root,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (branchCheck.exitCode === 0) {
      throw new Error(`branch already exists: ${branch}`);
    }

    const defaultRoot = join(dirname(repo.root), ".agent-workspaces", basename(repo.root));
    const requestedRoot = resolve(repo.root, options.worktreeRoot ?? defaultRoot);
    const worktree = await canonicalizePotential(join(requestedRoot, id));
    if (isPathWithin(repo.root, worktree)) {
      throw new Error(`worktree must be outside the main worktree: ${worktree}`);
    }
    if (await pathExists(worktree)) {
      throw new Error(`worktree path already exists: ${worktree}`);
    }
    await mkdir(dirname(worktree), { recursive: true });

    const state: TaskState = {
      version: 1,
      id,
      repo: repo.root,
      commonDir: repo.commonDir,
      base,
      branch,
      worktree,
      namespace: id.toLowerCase().replaceAll("_", "-"),
      port: allocatePort(repo.root, id, tasks),
      scopes,
      exclusive,
      status: "active",
      createdAt: new Date().toISOString(),
    };

    let added = false;
    try {
      await git(repo.root, ["worktree", "add", "-b", branch, worktree, base]);
      added = true;
      await saveTask(state);
      return state;
    } catch (error) {
      if (added) {
        await git(repo.root, ["worktree", "remove", "--force", worktree], {
          allowFailure: true,
        });
        await git(repo.root, ["branch", "-D", branch], { allowFailure: true });
      }
      throw error;
    }
  });
}

export async function submitTask(repoPath: string, id: string): Promise<TaskState> {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);

  return withRepoLock(repo.commonDir, "state", async () => {
    const state = await requireTask(repo.commonDir, id);
    if (state.status === "submitted" || state.status === "integrated") return state;
    if (state.status !== "active") {
      throw new Error(`task ${id} cannot be submitted from status ${state.status}`);
    }
    if (!(await pathExists(state.worktree))) {
      throw new Error(`task worktree is missing: ${state.worktree}`);
    }

    const dirty = (
      await git(state.worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    ).stdout.trim();
    if (dirty) {
      throw new Error(`task worktree must be clean before submit:\n${dirty}`);
    }

    const result = (await git(state.worktree, ["rev-parse", "HEAD"])).stdout.trim();
    if (result === state.base) {
      throw new Error(`task ${id} has no committed changes`);
    }
    const ancestor = await git(
      state.worktree,
      ["merge-base", "--is-ancestor", state.base, result],
      { allowFailure: true },
    );
    if (ancestor.exitCode !== 0) {
      throw new Error(`task ${id} result does not descend from base ${state.base}`);
    }
    const merges = (
      await git(state.worktree, ["rev-list", "--merges", `${state.base}..${result}`])
    ).stdout.trim();
    if (merges) {
      throw new Error(`task ${id} contains merge commits; rebase it onto a linear history`);
    }

    const changedFiles = (
      await git(state.worktree, ["diff", "--name-only", "-z", state.base, result])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .sort();
    const violations =
      state.scopes.length === 0
        ? []
        : changedFiles.filter(
            (file) => !state.scopes.some((scope) => isPathInScope(file, scope)),
          );
    if (violations.length > 0) {
      throw new Error(`task ${id} changed paths outside scope: ${violations.join(", ")}`);
    }

    const submitted: TaskState = {
      ...state,
      status: "submitted",
      result,
      changedFiles,
      submittedAt: new Date().toISOString(),
    };
    await saveTask(submitted);
    return submitted;
  });
}

export async function integrateTask(
  repoPath: string,
  id: string,
  options: IntegrateOptions = {},
): Promise<TaskState> {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  requireMain(repo, "integrate");

  return withRepoLock(repo.commonDir, "integration", async () => {
    const state = await requireTask(repo.commonDir, id);
    if (state.status === "integrated") return state;
    if (state.status !== "submitted" || !state.result) {
      throw new Error(`task ${id} must be submitted before integration`);
    }
    if (!samePath(repo.root, state.repo)) {
      throw new Error(`integrate task ${id} from its original main worktree: ${state.repo}`);
    }

    const dirty = (
      await git(repo.root, ["status", "--porcelain=v1", "--untracked-files=all"])
    ).stdout.trim();
    if (dirty) {
      throw new Error(`integration worktree must be clean:\n${dirty}`);
    }

    const before = (await git(repo.root, ["rev-parse", "HEAD"])).stdout.trim();
    const commits = (
      await git(repo.root, ["rev-list", "--reverse", `${state.base}..${state.result}`])
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    if (commits.length === 0) {
      throw new Error(`task ${id} has no commits to integrate`);
    }

    const cherryPick = await git(repo.root, ["cherry-pick", ...commits], {
      allowFailure: true,
    });
    if (cherryPick.exitCode !== 0) {
      await git(repo.root, ["cherry-pick", "--abort"], { allowFailure: true });
      throw new CommandError(cherryPick);
    }

    const checks = options.checks ?? [];
    for (const check of checks) {
      try {
        await runShell(check, repo.root);
      } catch (error) {
        await rollbackIntegration(repo.root, before, error);
      }
    }

    const postCheckDirty = (
      await git(repo.root, ["status", "--porcelain=v1", "--untracked-files=all"])
    ).stdout.trim();
    if (postCheckDirty) {
      await rollbackIntegration(repo.root, before, `checks left worktree dirty:\n${postCheckDirty}`);
    }

    const after = (await git(repo.root, ["rev-parse", "HEAD"])).stdout.trim();
    const integrated: TaskState = {
      ...state,
      status: "integrated",
      integratedAt: new Date().toISOString(),
      integration: { before, after, checks },
    };
    await saveTask(integrated);
    return integrated;
  });
}

export async function cleanupTask(
  repoPath: string,
  id: string,
  options: CleanupOptions = {},
): Promise<TaskState> {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  requireMain(repo, "cleanup");

  return withRepoLock(repo.commonDir, "state", async () => {
    const state = await requireTask(repo.commonDir, id);
    if (state.status === "cleaned") return state;
    if (state.status !== "integrated" && !options.force) {
      throw new Error(
        `task ${id} is ${state.status}; pass --force only when discarding it is intentional`,
      );
    }

    if (await pathExists(state.worktree)) {
      const args = ["worktree", "remove"];
      if (options.force) args.push("--force");
      args.push(state.worktree);
      await git(repo.root, args);
    } else {
      await git(repo.root, ["worktree", "prune"]);
    }
    await git(repo.root, ["branch", "-D", state.branch], { allowFailure: true });

    const cleaned: TaskState = {
      ...state,
      status: "cleaned",
      cleanedAt: new Date().toISOString(),
    };
    await saveTask(cleaned);
    return cleaned;
  });
}

export async function taskStatus(repoPath: string, id?: string): Promise<TaskState | TaskState[]> {
  const repo = await getRepoInfo(repoPath);
  if (id) {
    assertTaskId(id);
    return requireTask(repo.commonDir, id);
  }
  return listTasks(repo.commonDir);
}

async function requireTask(commonDir: string, id: string): Promise<TaskState> {
  const task = await loadTask(commonDir, id);
  if (!task) throw new Error(`unknown task: ${id}`);
  return task;
}

function requireMain(repo: RepoInfo, operation: string): void {
  if (!repo.isMain) {
    throw new Error(`${operation} must run against the main worktree, not a linked worker`);
  }
}

function normalizeResource(resource: string): string {
  const value = resource.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`invalid exclusive resource: "${resource}"`);
  }
  return value;
}

function allocatePort(repo: string, id: string, tasks: TaskState[]): number {
  const used = new Set(tasks.filter((task) => task.status !== "cleaned").map((task) => task.port));
  let port = 24000 + (fnv1a(`${repo}\0${id}`) % 10000);
  while (used.has(port)) port = port === 33999 ? 24000 : port + 1;
  return port;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function rollbackIntegration(
  repo: string,
  before: string,
  reason: unknown,
): Promise<never> {
  const reset = await git(repo, ["reset", "--hard", before], { allowFailure: true });
  if (reset.exitCode !== 0) {
    throw new Error(
      `integration check failed and rollback failed: ${errorMessage(reason)}; ${reset.stderr.trim()}`,
    );
  }
  const leftovers = (
    await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])
  ).stdout.trim();
  throw new Error(
    `integration check failed; HEAD restored to ${before}: ${errorMessage(reason)}` +
      (leftovers ? `\nuntracked or generated files remain:\n${leftovers}` : ""),
  );
}

async function canonicalizePotential(input: string): Promise<string> {
  let cursor = resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (!isFileCode(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isFileCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  const normalizeCase = (value: string) =>
    process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
  return normalizeCase(left) === normalizeCase(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
