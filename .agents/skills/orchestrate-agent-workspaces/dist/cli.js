#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { cleanupTask, createTask, integrateTask, submitTask, taskStatus, } from "./workspace.js";
const HELP = `agent-workspace <command> [task] [options]

Commands:
  create <task>     Create an isolated branch and worktree
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

All successful commands except --help print JSON.`;
const valueFlags = new Set(["repo", "base", "root", "scope", "exclusive", "check"]);
const booleanFlags = new Set(["force", "help"]);
export async function main(argv) {
    const parsed = parseArgs(argv);
    if (parsed.booleans.has("help") || parsed.positionals.length === 0) {
        console.log(HELP);
        return;
    }
    const [command, id, ...extra] = parsed.positionals;
    if (extra.length > 0)
        throw new Error(`unexpected arguments: ${extra.join(" ")}`);
    const repo = one(parsed, "repo") ?? process.cwd();
    let result;
    switch (command) {
        case "create":
            assertAllowed(parsed, ["repo", "base", "root", "scope", "exclusive"]);
            result = await createTask(repo, requireId(id, command), {
                base: one(parsed, "base"),
                worktreeRoot: one(parsed, "root"),
                scopes: many(parsed, "scope"),
                exclusive: many(parsed, "exclusive"),
            });
            break;
        case "submit":
            assertAllowed(parsed, ["repo"]);
            result = await submitTask(repo, requireId(id, command));
            break;
        case "integrate":
            assertAllowed(parsed, ["repo", "check"]);
            result = await integrateTask(repo, requireId(id, command), {
                checks: many(parsed, "check"),
            });
            break;
        case "cleanup":
            assertAllowed(parsed, ["repo", "force"]);
            result = await cleanupTask(repo, requireId(id, command), {
                force: parsed.booleans.has("force"),
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
        values: new Map(),
        booleans: new Set(),
    };
    for (let index = 0; index < argv.length; index += 1) {
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
        parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
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
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        if (process.env.AGENT_WORKSPACE_DEBUG && error instanceof Error)
            console.error(error.stack);
        process.exitCode = 1;
    });
}
