#!/usr/bin/env node
// Generated from src/cli.ts. Do not edit directly.

// src/cli.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/runtime.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { access, mkdir as mkdir3, readFile as readFile2 } from "node:fs/promises";
import { delimiter, extname, isAbsolute as isAbsolute2, join as join3, resolve as resolve3 } from "node:path";

// src/model.ts
import { posix } from "node:path";
var TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
function assertTaskId(id) {
  if (!TASK_ID.test(id)) {
    throw new Error(`invalid task id "${id}"; use 1-64 letters, digits, underscores, or hyphens`);
  }
}
function normalizeScope(input) {
  const slashPath = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = posix.normalize(slashPath);
  if (!slashPath || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`scope must be repository-relative: "${input}"`);
  }
  return normalized.replace(/\/$/, "") || ".";
}
function isPathInScope(file, scope) {
  const normalizedFile = file.replaceAll("\\", "/");
  return scope === "." || normalizedFile === scope || normalizedFile.startsWith(`${scope}/`);
}
function unique(values) {
  return [...new Set(values)];
}

// src/store.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
function storeDir(commonDir) {
  return join(commonDir, "agent-workspace");
}
function taskRuntimeDir(commonDir, id) {
  return join(storeDir(commonDir), "runtime", id);
}
function taskTempDir(commonDir, id) {
  const canonicalCommonDir = process.platform === "win32" ? resolve(commonDir).toLowerCase() : resolve(commonDir);
  const repoKey = createHash("sha256").update(canonicalCommonDir).digest("hex").slice(0, 12);
  return join(systemTempDir(), "agent-workspace", repoKey, id);
}
function tasksDir(commonDir) {
  return join(storeDir(commonDir), "tasks");
}
function taskPath(commonDir, id) {
  return join(tasksDir(commonDir), `${id}.json`);
}
async function loadTask(commonDir, id) {
  try {
    return JSON.parse(await readFile(taskPath(commonDir, id), "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT"))
      return null;
    throw error;
  }
}
async function listTasks(commonDir) {
  try {
    const names = (await readdir(tasksDir(commonDir))).filter((name) => name.endsWith(".json")).sort();
    return await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(tasksDir(commonDir), name), "utf8"))));
  } catch (error) {
    if (isCode(error, "ENOENT"))
      return [];
    throw error;
  }
}
async function saveTask(state) {
  const directory = tasksDir(state.commonDir);
  await mkdir(directory, { recursive: true });
  const target = taskPath(state.commonDir, state.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}
`);
  await rename(temporary, target);
}
async function removeTaskRuntimeDir(commonDir, id) {
  await rm(taskRuntimeDir(commonDir, id), { recursive: true, force: true, maxRetries: 3 });
}
async function removeTaskTempDir(commonDir, id) {
  await rm(taskTempDir(commonDir, id), {
    recursive: true,
    force: true,
    maxRetries: 3
  });
}
async function withRepoLock(commonDir, name, action) {
  const directory = storeDir(commonDir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.lock`);
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (!isCode(error, "EEXIST"))
        throw error;
      if (Date.now() >= deadline) {
        throw new Error(`repository ${name} lock is already held: ${path}`);
      }
      await delay(25);
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}
`);
    return await action();
  } finally {
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
function systemTempDir() {
  if (process.platform !== "win32")
    return "/tmp";
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "Temp");
}

// src/workspace.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir2, open as open2, realpath, stat, unlink as unlink2 } from "node:fs/promises";
import { createServer } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join as join2,
  normalize,
  relative,
  resolve as resolve2,
  sep,
  win32
} from "node:path";

// src/git.ts
import { spawn } from "node:child_process";

class CommandError extends Error {
  result;
  constructor(result) {
    const detail = result.stderr.trim() || result.stdout.trim() || "command failed";
    super(`${quoteCommand(result.command)} (${result.exitCode}): ${detail}`);
    this.result = result;
    this.name = "CommandError";
  }
}
function quoteCommand(command) {
  return command.map((part) => /^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}
async function run(command, cwd, options = {}) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdoutText = "";
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutText += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });
  const exitCode = await new Promise((resolve2, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve2(code ?? 1));
  });
  const result = { command, cwd, exitCode, stdout: stdoutText, stderr: stderrText };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new CommandError(result);
  }
  return result;
}
function git(cwd, args, options = {}) {
  return run(["git", ...args], cwd, {
    ...options,
    env: { GIT_TERMINAL_PROMPT: "0", ...options.env }
  });
}
function runShell(command, cwd) {
  const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-lc", command];
  return run(shell, cwd);
}

// src/workspace.ts
var WINDOWS_TOOL_PATH_BUDGET = 240;
async function getRepoInfo(input) {
  const cwd = resolve2(input);
  const reportedRoot = resolve2((await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim());
  const root = await realpath(reportedRoot);
  const gitDirValue = (await git(reportedRoot, ["rev-parse", "--git-dir"])).stdout.trim();
  const commonDirValue = (await git(reportedRoot, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const gitDir = await realpath(isAbsolute(gitDirValue) ? normalize(gitDirValue) : resolve2(reportedRoot, gitDirValue));
  const commonDir = await realpath(isAbsolute(commonDirValue) ? normalize(commonDirValue) : resolve2(reportedRoot, commonDirValue));
  return { root, gitDir, commonDir, isMain: samePath(gitDir, commonDir) };
}
async function createTask(repoPath, id, options = {}) {
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
    const conflict = tasks.find((task) => (task.status === "active" || task.status === "submitted") && task.exclusive.some((resource) => exclusive.includes(resource)));
    if (conflict) {
      const resources = conflict.exclusive.filter((resource) => exclusive.includes(resource));
      throw new Error(`exclusive resource conflict with ${conflict.id}: ${resources.join(", ")}`);
    }
    const baseRef = options.base ?? "HEAD";
    const base = (await git(repo.root, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
    const branch = `agent-workspace/${id}`;
    const branchCheck = await git(repo.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
    if (branchCheck.exitCode === 0) {
      throw new Error(`branch already exists: ${branch}`);
    }
    const defaultRoot = join2(dirname(repo.root), ".agent-workspaces", basename(repo.root));
    const requestedRoot = resolve2(repo.root, options.worktreeRoot ?? defaultRoot);
    const worktree = await canonicalizePotential(join2(requestedRoot, id));
    if (isPathWithin(repo.root, worktree)) {
      throw new Error(`worktree must be outside the main worktree: ${worktree}`);
    }
    if (await pathExists(worktree)) {
      throw new Error(`worktree path already exists: ${worktree}`);
    }
    await mkdir2(dirname(worktree), { recursive: true });
    const state = {
      version: 1,
      id,
      repo: repo.root,
      commonDir: repo.commonDir,
      base,
      branch,
      worktree,
      runtimeDir: taskRuntimeDir(repo.commonDir, id),
      namespace: id.toLowerCase().replaceAll("_", "-"),
      port: await allocatePort(repo.root, id, tasks),
      scopes,
      exclusive,
      status: "active",
      createdAt: new Date().toISOString()
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
          allowFailure: true
        });
        await git(repo.root, ["branch", "-D", branch], { allowFailure: true });
      }
      throw error;
    }
  });
}
async function verifyTaskWorkspace(repoPath, id) {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  const state = await requireTask(repo.commonDir, id);
  if (state.status === "cleaned" || !await pathExists(state.worktree)) {
    throw new Error(`task worktree is missing: ${state.worktree}`);
  }
  await verifyWorktreeWriteAccess(state.worktree);
  const status = await git(state.worktree, ["status", "--porcelain=v1", "--untracked-files=no"], { allowFailure: true });
  if (status.exitCode !== 0) {
    const detail = status.stderr.trim() || status.stdout.trim() || "git status failed";
    throw new Error(`worker verification failed: Git cannot use ${state.worktree}: ${detail}
` + "Grant the worker identity access to this directory and mark it as a safe Git directory before editing.");
  }
  const trackedFiles = (await git(state.worktree, ["ls-files", "-z"])).stdout.split("\x00").filter(Boolean);
  const paths = analyzeWorkspacePaths(state.worktree, trackedFiles);
  if (!paths.compatible) {
    throw new Error(`worker verification failed: ${paths.longestTrackedFile ?? state.worktree} reaches ` + `${paths.maxAbsolutePathLength} characters, above the ${paths.pathBudget}-character ` + "Windows tool compatibility budget. Recreate the task with --root <short-approved-root>.");
  }
  return {
    id,
    worktree: state.worktree,
    writable: true,
    gitAccessible: true,
    ...paths
  };
}
function analyzeWorkspacePaths(worktree, trackedFiles, platform = process.platform) {
  const resolvePath = platform === "win32" ? win32.resolve : resolve2;
  let longestTrackedFile = null;
  let maxAbsolutePathLength = resolvePath(worktree).length;
  for (const file of trackedFiles) {
    const length = resolvePath(worktree, file).length;
    if (length > maxAbsolutePathLength) {
      longestTrackedFile = file;
      maxAbsolutePathLength = length;
    }
  }
  const pathBudget = platform === "win32" ? WINDOWS_TOOL_PATH_BUDGET : null;
  return {
    longestTrackedFile,
    maxAbsolutePathLength,
    pathBudget,
    compatible: pathBudget === null || maxAbsolutePathLength < pathBudget
  };
}
async function submitTask(repoPath, id) {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  return withRepoLock(repo.commonDir, "state", async () => {
    const state = await requireTask(repo.commonDir, id);
    if (state.status === "submitted" || state.status === "integrated")
      return state;
    if (state.status !== "active") {
      throw new Error(`task ${id} cannot be submitted from status ${state.status}`);
    }
    if (!await pathExists(state.worktree)) {
      throw new Error(`task worktree is missing: ${state.worktree}`);
    }
    const dirty = (await git(state.worktree, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
    if (dirty) {
      throw new Error(`task worktree must be clean before submit:
${dirty}`);
    }
    const result = (await git(state.worktree, ["rev-parse", "HEAD"])).stdout.trim();
    if (result === state.base) {
      throw new Error(`task ${id} has no committed changes`);
    }
    const ancestor = await git(state.worktree, ["merge-base", "--is-ancestor", state.base, result], { allowFailure: true });
    if (ancestor.exitCode !== 0) {
      throw new Error(`task ${id} result does not descend from base ${state.base}`);
    }
    const merges = (await git(state.worktree, ["rev-list", "--merges", `${state.base}..${result}`])).stdout.trim();
    if (merges) {
      throw new Error(`task ${id} contains merge commits; rebase it onto a linear history`);
    }
    const changedFiles = (await git(state.worktree, ["diff", "--name-only", "-z", state.base, result])).stdout.split("\x00").filter(Boolean).sort();
    const violations = state.scopes.length === 0 ? [] : changedFiles.filter((file) => !state.scopes.some((scope) => isPathInScope(file, scope)));
    if (violations.length > 0) {
      throw new Error(`task ${id} changed paths outside scope: ${violations.join(", ")}`);
    }
    const submitted = {
      ...state,
      status: "submitted",
      result,
      changedFiles,
      submittedAt: new Date().toISOString()
    };
    await saveTask(submitted);
    return submitted;
  });
}
async function integrateTask(repoPath, id, options = {}) {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  requireMain(repo, "integrate");
  return withRepoLock(repo.commonDir, "integration", async () => {
    const state = await requireTask(repo.commonDir, id);
    if (state.status === "integrated")
      return state;
    if (state.status !== "submitted" || !state.result) {
      throw new Error(`task ${id} must be submitted before integration`);
    }
    if (!samePath(repo.root, state.repo)) {
      throw new Error(`integrate task ${id} from its original main worktree: ${state.repo}`);
    }
    const dirty = (await git(repo.root, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
    if (dirty) {
      throw new Error(`integration worktree must be clean:
${dirty}`);
    }
    const before = (await git(repo.root, ["rev-parse", "HEAD"])).stdout.trim();
    const commits = (await git(repo.root, ["rev-list", "--reverse", `${state.base}..${state.result}`])).stdout.split(/\r?\n/).filter(Boolean);
    if (commits.length === 0) {
      throw new Error(`task ${id} has no commits to integrate`);
    }
    const cherryPick = await git(repo.root, ["cherry-pick", ...commits], {
      allowFailure: true
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
    const postCheckDirty = (await git(repo.root, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
    if (postCheckDirty) {
      await rollbackIntegration(repo.root, before, `checks left worktree dirty:
${postCheckDirty}`);
    }
    const after = (await git(repo.root, ["rev-parse", "HEAD"])).stdout.trim();
    const integrated = {
      ...state,
      status: "integrated",
      integratedAt: new Date().toISOString(),
      integration: { before, after, checks }
    };
    await saveTask(integrated);
    return integrated;
  });
}
async function cleanupTask(repoPath, id, options = {}) {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  requireMain(repo, "cleanup");
  return withRepoLock(repo.commonDir, "state", async () => {
    const state = await requireTask(repo.commonDir, id);
    if (state.status === "cleaned")
      return state;
    if (state.status !== "integrated" && !options.force) {
      throw new Error(`task ${id} is ${state.status}; pass --force only when discarding it is intentional`);
    }
    if (await pathExists(state.worktree)) {
      const args = ["worktree", "remove"];
      if (options.force)
        args.push("--force");
      args.push(state.worktree);
      await git(repo.root, args);
    } else {
      await git(repo.root, ["worktree", "prune"]);
    }
    await git(repo.root, ["branch", "-D", state.branch], { allowFailure: true });
    await removeTaskRuntimeDir(repo.commonDir, id);
    await removeTaskTempDir(state.commonDir, id);
    const cleaned = {
      ...state,
      status: "cleaned",
      cleanedAt: new Date().toISOString()
    };
    await saveTask(cleaned);
    return cleaned;
  });
}
async function taskStatus(repoPath, id) {
  const repo = await getRepoInfo(repoPath);
  if (id) {
    assertTaskId(id);
    return requireTask(repo.commonDir, id);
  }
  return listTasks(repo.commonDir);
}
async function requireTask(commonDir, id) {
  const task = await loadTask(commonDir, id);
  if (!task)
    throw new Error(`unknown task: ${id}`);
  return task;
}
function requireMain(repo, operation) {
  if (!repo.isMain) {
    throw new Error(`${operation} must run against the main worktree, not a linked worker`);
  }
}
function normalizeResource(resource) {
  const value = resource.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`invalid exclusive resource: "${resource}"`);
  }
  return value;
}
async function allocatePort(repo, id, tasks) {
  const used = new Set(tasks.filter((task) => task.status !== "cleaned").map((task) => task.port));
  let port = 24000 + fnv1a(`${repo}\x00${id}`) % 1e4;
  for (let attempts = 0;attempts < 1e4; attempts += 1) {
    if (!used.has(port) && await portAvailable(port))
      return port;
    port = port === 33999 ? 24000 : port + 1;
  }
  throw new Error("no available task port in range 24000-33999");
}
function portAvailable(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolvePort(!error));
    });
  });
}
function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0;index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
async function pathExists(path) {
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
async function verifyWorktreeWriteAccess(worktree) {
  const probe = join2(worktree, `.agent-workspace-write-probe-${randomUUID2()}`);
  let handle;
  try {
    handle = await open2(probe, "wx");
    await handle.writeFile(`worker verification probe
`);
  } catch (error) {
    throw new Error(`worker verification failed: ${worktree} is not writable by the current process: ` + `${errorMessage(error)}. Add it to the worker's writable sandbox roots or recreate the task ` + "with --root <approved-external-root>.");
  } finally {
    await handle?.close();
    if (handle)
      await unlink2(probe);
  }
}
async function rollbackIntegration(repo, before, reason) {
  const reset = await git(repo, ["reset", "--hard", before], { allowFailure: true });
  if (reset.exitCode !== 0) {
    throw new Error(`integration check failed and rollback failed: ${errorMessage(reason)}; ${reset.stderr.trim()}`);
  }
  const leftovers = (await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
  throw new Error(`integration check failed; HEAD restored to ${before}: ${errorMessage(reason)}` + (leftovers ? `
untracked or generated files remain:
${leftovers}` : ""));
}
async function canonicalizePotential(input) {
  let cursor = resolve2(input);
  const missing = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve2(existing, ...missing.reverse());
    } catch (error) {
      if (!isFileCode(error, "ENOENT"))
        throw error;
      const parent = dirname(cursor);
      if (parent === cursor)
        throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}
function isFileCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isPathWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}
function samePath(left, right) {
  const normalizeCase = (value) => process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
  return normalizeCase(left) === normalizeCase(right);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/runtime.ts
var CONFIG_NAME = ".agent-workspace.json";
async function taskEnvironment(repoPath, id) {
  const task = await resolveTask(repoPath, id, false);
  const runtimeDir = taskRuntimeDir(task.commonDir, task.id);
  const tempDir = taskTempDir(task.commonDir, task.id);
  await Promise.all([
    mkdir3(runtimeDir, { recursive: true }),
    mkdir3(tempDir, { recursive: true })
  ]);
  const dbNamespace = portableDbNamespace(task.namespace);
  const redisPrefix = `aw:${task.namespace}:`;
  const composeProject = `aw-${task.namespace}`;
  const variables = {
    id: task.id,
    namespace: task.namespace,
    port: String(task.port),
    worktree: task.worktree,
    runtimeDir,
    tempDir,
    dbNamespace,
    redisPrefix,
    composeProject
  };
  const environment = {
    AGENT_WORKSPACE_ID: task.id,
    AGENT_WORKSPACE_NAMESPACE: task.namespace,
    AGENT_WORKSPACE_WORKTREE: task.worktree,
    AGENT_WORKSPACE_RUNTIME_DIR: runtimeDir,
    AGENT_WORKSPACE_PORT: String(task.port),
    AGENT_WORKSPACE_DB_NAMESPACE: dbNamespace,
    AGENT_WORKSPACE_REDIS_PREFIX: redisPrefix,
    PORT: String(task.port),
    COMPOSE_PROJECT_NAME: composeProject,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir
  };
  const config = await loadConfig(task.worktree);
  for (const [name, value] of Object.entries(config.env)) {
    environment[name] = expandTemplate(value, variables, name);
  }
  return {
    id: task.id,
    worktree: task.worktree,
    runtimeDir,
    tempDir,
    namespace: task.namespace,
    port: task.port,
    environment
  };
}
async function prepareTask(repoPath, id, overrideCommand = []) {
  const task = await resolveTask(repoPath, id, true);
  const config = await loadConfig(task.worktree);
  const command = overrideCommand.length ? overrideCommand : config.prepare ?? await detectPrepareCommand(task.worktree);
  return executeTaskCommand(repoPath, id, command);
}
async function executeTaskCommand(repoPath, id, command) {
  if (!command[0])
    throw new Error("task command cannot be empty");
  const task = await resolveTask(repoPath, id, true);
  const profile = await taskEnvironment(repoPath, id);
  const options = {
    cwd: task.worktree,
    env: mergeEnvironment(process.env, profile.environment),
    stdio: "inherit"
  };
  const child = process.platform === "win32" ? await spawnWindowsCommand(command, task.worktree, options.env) : spawn2(command[0], command.slice(1), options);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  return { command, cwd: task.worktree, exitCode };
}
async function spawnWindowsCommand(command, cwd, environment) {
  const spec = await windowsCommandSpec(command, cwd, environment);
  return spawn2(spec.executable, spec.args, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: false,
    windowsVerbatimArguments: spec.windowsVerbatimArguments
  });
}
async function windowsCommandSpec(command, cwd, environment) {
  if (!command[0])
    throw new Error("task command cannot be empty");
  const executable = await resolveWindowsCommand(command[0], cwd, environment);
  if (!/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args: command.slice(1), windowsVerbatimArguments: false };
  }
  const invocation = commandLineForCmd([executable, ...command.slice(1)]);
  return {
    executable: findEnvironment(environment, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", invocation],
    windowsVerbatimArguments: true
  };
}
async function resolveWindowsCommand(command, cwd, environment) {
  const explicitPath = isAbsolute2(command) || command.includes("/") || command.includes("\\");
  const pathValue = findEnvironment(environment, "PATH") ?? "";
  const pathExt = (findEnvironment(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(delimiter).filter(Boolean);
  const extensions = extname(command) ? [""] : pathExt;
  const directories = explicitPath ? [""] : pathValue.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = explicitPath ? isAbsolute2(command) ? command : resolve3(cwd, command) : join3(directory, command);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (await exists(candidate))
        return candidate;
    }
  }
  return command;
}
function commandLineForCmd(command) {
  const inner = command.map(quoteWindowsArgument).join(" ");
  return `"${inner}"`;
}
function quoteWindowsArgument(value) {
  if (!value)
    return '""';
  const escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1");
  return /[\s"&|<>^()%!]/.test(value) ? `"${escaped}"` : escaped;
}
function findEnvironment(environment, name) {
  const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}
async function detectPrepareCommand(worktree) {
  const packageJson = await readJson(join3(worktree, "package.json"));
  if (typeof packageJson?.packageManager === "string") {
    const manager = /^([a-z0-9-]+)(?:@(.+))?$/i.exec(packageJson.packageManager.trim());
    if (!manager)
      throw new Error(`invalid packageManager value: ${packageJson.packageManager}`);
    return prepareFor(manager[1].toLowerCase(), manager[2], worktree);
  }
  const locks = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"]
  ];
  const found = [];
  for (const [file, manager] of locks)
    if (await exists(join3(worktree, file)))
      found.push(manager);
  const managers = [...new Set(found)];
  if (!managers.length) {
    throw new Error(`cannot prepare ${worktree}: no supported lockfile; set packageManager, add ${CONFIG_NAME}, or pass a command after --`);
  }
  if (managers.length > 1) {
    throw new Error(`cannot choose a package manager from multiple lockfiles (${managers.join(", ")}); set packageManager or ${CONFIG_NAME}`);
  }
  return prepareFor(managers[0], undefined, worktree);
}
function mergeEnvironment(inherited, overrides) {
  const result = { ...inherited };
  for (const [name, value] of Object.entries(overrides)) {
    if (process.platform === "win32") {
      for (const existing of Object.keys(result)) {
        if (existing !== name && existing.toLowerCase() === name.toLowerCase())
          delete result[existing];
      }
    }
    result[name] = value;
  }
  return result;
}
async function resolveTask(repoPath, id, mustBeActive) {
  assertTaskId(id);
  const repo = await getRepoInfo(repoPath);
  const task = await loadTask(repo.commonDir, id);
  if (!task)
    throw new Error(`unknown task: ${id}`);
  if (task.status === "cleaned")
    throw new Error(`task ${id} has been cleaned`);
  if (mustBeActive && task.status !== "active") {
    throw new Error(`task ${id} must be active to run commands (status: ${task.status})`);
  }
  if (!await exists(task.worktree))
    throw new Error(`task worktree is missing: ${task.worktree}`);
  return task;
}
async function loadConfig(worktree) {
  const path = join3(worktree, CONFIG_NAME);
  let raw;
  try {
    raw = JSON.parse(await readFile2(path, "utf8"));
  } catch (error) {
    if (isCode2(error, "ENOENT"))
      return { env: {} };
    if (error instanceof SyntaxError)
      throw new Error(`invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
  if (!isRecord(raw))
    throw new Error(`${path} must contain a JSON object`);
  let prepare;
  if (raw.prepare !== undefined) {
    if (!Array.isArray(raw.prepare) || !raw.prepare.length || raw.prepare.some((value) => typeof value !== "string" || !value)) {
      throw new Error(`${path} prepare must be a non-empty array of command arguments`);
    }
    prepare = raw.prepare;
  }
  const env = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env))
      throw new Error(`${path} env must be an object of string values`);
    for (const [name, value] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
        throw new Error(`${path} env must contain valid environment names and string values`);
      }
      if (name.toUpperCase().startsWith("AGENT_WORKSPACE_")) {
        throw new Error(`${path} cannot override reserved variable ${name}`);
      }
      env[name] = value;
    }
  }
  return { prepare, env };
}
async function prepareFor(manager, version, root) {
  if (manager === "npm")
    return ["npm", "ci"];
  if (manager === "pnpm")
    return ["pnpm", "install", "--frozen-lockfile"];
  if (manager === "bun")
    return ["bun", "install", "--frozen-lockfile"];
  if (manager === "yarn") {
    const classic = version?.startsWith("1.") ?? !await exists(join3(root, ".yarnrc.yml"));
    return ["yarn", "install", classic ? "--frozen-lockfile" : "--immutable"];
  }
  throw new Error(`unsupported packageManager ${manager}; configure ${CONFIG_NAME} prepare explicitly`);
}
function portableDbNamespace(namespace) {
  const base = `aw_${namespace.replace(/[^a-z0-9_]/g, "_")}`;
  if (base.length <= 63)
    return base;
  const hash = createHash2("sha256").update(base).digest("hex").slice(0, 8);
  return `${base.slice(0, 54)}_${hash}`;
}
function expandTemplate(value, variables, name) {
  return value.replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key) => {
    if (variables[key] === undefined) {
      throw new Error(`unknown template variable ${token} in ${CONFIG_NAME} env.${name}`);
    }
    return variables[key];
  });
}
async function readJson(path) {
  try {
    const value = JSON.parse(await readFile2(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isCode2(error, "ENOENT"))
      return;
    throw error;
  }
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isCode2(error, "ENOENT"))
      return false;
    throw error;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCode2(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// src/cli.ts
var HELP = `agent-workspace <command> [task] [options]

Commands:
  create <task>     Create an isolated branch and worktree
  verify <task>     Check worker write, Git, and path compatibility
  prepare <task>    Install dependencies reproducibly in its worktree
  env <task>        Show its isolated runtime environment
  exec <task>       Run a command in its worktree after --
  submit <task>     Validate and record a worker result
  integrate <task>  Serialize cherry-pick and optional checks
  cleanup <task>    Remove an integrated worker transaction
  status [task]     Show one task or all durable task records

Common options:
  --repo <path>       Repository or linked worktree (default: cwd)

Create options:
  --base <ref>        Fixed base revision (default: HEAD)
  --root <path>       Parent directory for task worktrees
  --scope <path>      Allowed repository-relative path; repeatable
  --exclusive <name>  Hotspot resource lease; repeatable

Integrate options:
  --check <command>   Check to run after cherry-pick; repeatable

Cleanup options:
  --force             Discard a non-integrated or dirty task intentionally

Runtime examples:
  agent-workspace prepare T123 --repo <repo>
  agent-workspace exec T123 --repo <repo> -- npm test

State commands print JSON. prepare and exec attach directly to the child process.`;
var valueFlags = new Set(["repo", "base", "root", "scope", "exclusive", "check"]);
var booleanFlags = new Set(["force", "help"]);
async function main(argv) {
  const separator = argv.indexOf("--");
  const commandArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const parsed = parseArgs(separator === -1 ? argv : argv.slice(0, separator));
  if (parsed.booleans.has("help") || parsed.positionals.length === 0) {
    console.log(HELP);
    return;
  }
  const [command, id, ...extra] = parsed.positionals;
  if (extra.length > 0)
    throw new Error(`unexpected arguments: ${extra.join(" ")}`);
  if (commandArgs.length > 0 && command !== "prepare" && command !== "exec") {
    throw new Error(`command arguments after -- are not valid for ${command}`);
  }
  const repo = one(parsed, "repo") ?? process.cwd();
  let result;
  switch (command) {
    case "create":
      assertAllowed(parsed, ["repo", "base", "root", "scope", "exclusive"]);
      result = await createTask(repo, requireId(id, command), {
        base: one(parsed, "base"),
        worktreeRoot: one(parsed, "root"),
        scopes: many(parsed, "scope"),
        exclusive: many(parsed, "exclusive")
      });
      break;
    case "env":
      assertAllowed(parsed, ["repo"]);
      result = await taskEnvironment(repo, requireId(id, command));
      break;
    case "verify":
      assertAllowed(parsed, ["repo"]);
      result = await verifyTaskWorkspace(repo, requireId(id, command));
      break;
    case "prepare": {
      assertAllowed(parsed, ["repo"]);
      const prepared = await prepareTask(repo, requireId(id, command), commandArgs);
      process.exitCode = prepared.exitCode;
      return;
    }
    case "exec": {
      assertAllowed(parsed, ["repo"]);
      if (commandArgs.length === 0)
        throw new Error("exec requires a command after --");
      const executed = await executeTaskCommand(repo, requireId(id, command), commandArgs);
      process.exitCode = executed.exitCode;
      return;
    }
    case "submit":
      assertAllowed(parsed, ["repo"]);
      result = await submitTask(repo, requireId(id, command));
      break;
    case "integrate":
      assertAllowed(parsed, ["repo", "check"]);
      result = await integrateTask(repo, requireId(id, command), {
        checks: many(parsed, "check")
      });
      break;
    case "cleanup":
      assertAllowed(parsed, ["repo", "force"]);
      result = await cleanupTask(repo, requireId(id, command), {
        force: parsed.booleans.has("force")
      });
      break;
    case "status":
      assertAllowed(parsed, ["repo"]);
      result = await taskStatus(repo, id);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
function parseArgs(argv) {
  const parsed = {
    positionals: [],
    values: new Map,
    booleans: new Set
  };
  for (let index = 0;index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      parsed.booleans.add(name);
      continue;
    }
    if (!valueFlags.has(name))
      throw new Error(`unknown option: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    parsed.values.set(name, [...parsed.values.get(name) ?? [], value]);
    index += 1;
  }
  return parsed;
}
function requireId(id, command) {
  if (!id)
    throw new Error(`${command} requires a task id`);
  return id;
}
function one(parsed, name) {
  const values = parsed.values.get(name) ?? [];
  if (values.length > 1)
    throw new Error(`--${name} may be provided only once`);
  return values[0];
}
function many(parsed, name) {
  return parsed.values.get(name) ?? [];
}
function assertAllowed(parsed, allowed) {
  const expected = new Set([...allowed, "help"]);
  for (const name of [...parsed.values.keys(), ...parsed.booleans]) {
    if (!expected.has(name))
      throw new Error(`option --${name} is not valid for this command`);
  }
}
var entryPoint = process.argv[1];
var isMain = entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (process.env.AGENT_WORKSPACE_DEBUG && error instanceof Error)
      console.error(error.stack);
    process.exitCode = 1;
  });
}
export {
  main
};
