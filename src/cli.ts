#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { executeTaskCommand, prepareTask, taskEnvironment } from "./runtime.js";

import {
  cleanupTask,
  createTask,
  integrateTask,
  submitTask,
  taskStatus,
} from "./workspace.js";

const HELP = `agent-workspace <command> [task] [options]

Commands:
  create <task>     Create an isolated branch and worktree
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

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

const valueFlags = new Set(["repo", "base", "root", "scope", "exclusive", "check"]);
const booleanFlags = new Set(["force", "help"]);

export async function main(argv: string[]): Promise<void> {
  const separator = argv.indexOf("--");
  const commandArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const parsed = parseArgs(separator === -1 ? argv : argv.slice(0, separator));
  if (parsed.booleans.has("help") || parsed.positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const [command, id, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(" ")}`);
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
        exclusive: many(parsed, "exclusive"),
      });
      break;
    case "env":
      assertAllowed(parsed, ["repo"]);
      result = await taskEnvironment(repo, requireId(id, command));
      break;
    case "prepare": {
      assertAllowed(parsed, ["repo"]);
      const prepared = await prepareTask(repo, requireId(id, command), commandArgs);
      process.exitCode = prepared.exitCode;
      return;
    }
    case "exec": {
      assertAllowed(parsed, ["repo"]);
      if (commandArgs.length === 0) throw new Error("exec requires a command after --");
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

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    values: new Map(),
    booleans: new Set(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      parsed.booleans.add(name);
      continue;
    }
    if (!valueFlags.has(name)) throw new Error(`unknown option: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
    index += 1;
  }
  return parsed;
}

function requireId(id: string | undefined, command: string): string {
  if (!id) throw new Error(`${command} requires a task id`);
  return id;
}

function one(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.values.get(name) ?? [];
  if (values.length > 1) throw new Error(`--${name} may be provided only once`);
  return values[0];
}

function many(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

function assertAllowed(parsed: ParsedArgs, allowed: string[]): void {
  const expected = new Set([...allowed, "help"]);
  for (const name of [...parsed.values.keys(), ...parsed.booleans]) {
    if (!expected.has(name)) throw new Error(`option --${name} is not valid for this command`);
  }
}

const entryPoint = process.argv[1];
const isMain =
  entryPoint !== undefined &&
  realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (process.env.AGENT_WORKSPACE_DEBUG && error instanceof Error) console.error(error.stack);
    process.exitCode = 1;
  });
}
