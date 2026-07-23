import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { assertTaskId } from "./model.js";
import { loadTask, taskRuntimeDir } from "./store.js";
import { getRepoInfo } from "./workspace.js";
const CONFIG_NAME = ".agent-workspace.json";
export async function taskEnvironment(repoPath, id) {
    const task = await resolveTask(repoPath, id, false);
    const runtimeDir = taskRuntimeDir(task.commonDir, task.id);
    const tempDir = join(runtimeDir, "tmp");
    await mkdir(tempDir, { recursive: true });
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
        composeProject,
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
        TEMP: tempDir,
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
        environment,
    };
}
export async function prepareTask(repoPath, id, overrideCommand = []) {
    const task = await resolveTask(repoPath, id, true);
    const config = await loadConfig(task.worktree);
    const command = overrideCommand.length
        ? overrideCommand
        : config.prepare ?? (await detectPrepareCommand(task.worktree));
    return executeTaskCommand(repoPath, id, command);
}
export async function executeTaskCommand(repoPath, id, command) {
    if (!command[0])
        throw new Error("task command cannot be empty");
    const task = await resolveTask(repoPath, id, true);
    const profile = await taskEnvironment(repoPath, id);
    const options = {
        cwd: task.worktree,
        env: mergeEnvironment(process.env, profile.environment),
        stdio: "inherit",
    };
    const child = process.platform === "win32"
        ? await spawnWindowsCommand(command, task.worktree, options.env)
        : spawn(command[0], command.slice(1), options);
    const exitCode = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveExit(code ?? 1));
    });
    return { command, cwd: task.worktree, exitCode };
}
async function spawnWindowsCommand(command, cwd, environment) {
    const spec = await windowsCommandSpec(command, cwd, environment);
    return spawn(spec.executable, spec.args, {
        cwd,
        env: environment,
        stdio: "inherit",
        windowsHide: false,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
}
export async function windowsCommandSpec(command, cwd, environment) {
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
        windowsVerbatimArguments: true,
    };
}
async function resolveWindowsCommand(command, cwd, environment) {
    const explicitPath = isAbsolute(command) || command.includes("/") || command.includes("\\");
    const pathValue = findEnvironment(environment, "PATH") ?? "";
    const pathExt = (findEnvironment(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
        .split(delimiter)
        .filter(Boolean);
    const extensions = extname(command) ? [""] : pathExt;
    const directories = explicitPath ? [""] : pathValue.split(delimiter).filter(Boolean);
    for (const directory of directories) {
        const base = explicitPath
            ? isAbsolute(command)
                ? command
                : resolve(cwd, command)
            : join(directory, command);
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
    const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
    return /[\s"&|<>^()%!]/.test(value) ? `"${escaped}"` : escaped;
}
function findEnvironment(environment, name) {
    const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1];
}
export async function detectPrepareCommand(worktree) {
    const packageJson = await readJson(join(worktree, "package.json"));
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
        ["npm-shrinkwrap.json", "npm"],
    ];
    const found = [];
    for (const [file, manager] of locks)
        if (await exists(join(worktree, file)))
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
export function mergeEnvironment(inherited, overrides) {
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
    if (!(await exists(task.worktree)))
        throw new Error(`task worktree is missing: ${task.worktree}`);
    return task;
}
async function loadConfig(worktree) {
    const path = join(worktree, CONFIG_NAME);
    let raw;
    try {
        raw = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (isCode(error, "ENOENT"))
            return { env: {} };
        if (error instanceof SyntaxError)
            throw new Error(`invalid JSON in ${path}: ${error.message}`);
        throw error;
    }
    if (!isRecord(raw))
        throw new Error(`${path} must contain a JSON object`);
    let prepare;
    if (raw.prepare !== undefined) {
        if (!Array.isArray(raw.prepare) ||
            !raw.prepare.length ||
            raw.prepare.some((value) => typeof value !== "string" || !value)) {
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
        const classic = version?.startsWith("1.") ?? !(await exists(join(root, ".yarnrc.yml")));
        return ["yarn", "install", classic ? "--frozen-lockfile" : "--immutable"];
    }
    throw new Error(`unsupported packageManager ${manager}; configure ${CONFIG_NAME} prepare explicitly`);
}
function portableDbNamespace(namespace) {
    const base = `aw_${namespace.replace(/[^a-z0-9_]/g, "_")}`;
    if (base.length <= 63)
        return base;
    const hash = createHash("sha256").update(base).digest("hex").slice(0, 8);
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
        const value = JSON.parse(await readFile(path, "utf8"));
        return isRecord(value) ? value : undefined;
    }
    catch (error) {
        if (isCode(error, "ENOENT"))
            return undefined;
        throw error;
    }
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (isCode(error, "ENOENT"))
            return false;
        throw error;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
