import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { git } from "../src/git.ts";
import {
  detectPrepareCommand,
  executeTaskCommand,
  prepareTask,
  taskEnvironment,
  windowsCommandSpec,
} from "../src/runtime.ts";
import {
  cleanupTask,
  createTask,
} from "../src/workspace.ts";
import { cleanupFixtures, createFixture, exists } from "./helpers.ts";

afterEach(cleanupFixtures);

const cli = resolve(import.meta.dir, "../skills/orchestrate-agent-workspaces/scripts/cli.js");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn(["node", cli, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    child.exited,
    stdout,
    stderr,
  ]);
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

describe("runtime profiles", () => {
  test("isolates ports, temporary paths, Compose, database, Redis, and configured env", async () => {
    const fixture = await createFixture();
    const first = await createTask(fixture.repo, "runtime_a", { worktreeRoot: fixture.worktrees });
    const second = await createTask(fixture.repo, "runtime_b", { worktreeRoot: fixture.worktrees });
    await Bun.write(
      join(first.worktree, ".agent-workspace.json"),
      JSON.stringify({
        env: {
          DATABASE_SCHEMA: "${dbNamespace}",
          REDIS_KEY_PREFIX: "${redisPrefix}",
          APP_ENDPOINT: "http://127.0.0.1:${port}/${namespace}",
        },
      }),
    );

    const [firstProfile, secondProfile] = await Promise.all([
      taskEnvironment(fixture.repo, first.id),
      taskEnvironment(fixture.repo, second.id),
    ]);
    expect(firstProfile.port).not.toBe(secondProfile.port);
    expect(firstProfile.runtimeDir).not.toBe(secondProfile.runtimeDir);
    const publicEnv = await runCli(["env", first.id, "--repo", fixture.repo]);
    expect(publicEnv.exitCode, publicEnv.stderr).toBe(0);
    expect(JSON.parse(publicEnv.stdout).environment.PORT).toBe(String(first.port));
    expect(firstProfile.environment.PORT).toBe(String(first.port));
    expect(firstProfile.environment.TEMP).toBe(firstProfile.tempDir);
    expect(firstProfile.environment.COMPOSE_PROJECT_NAME).toBe("aw-runtime-a");
    expect(firstProfile.environment.DATABASE_SCHEMA).toBe("aw_runtime_a");
    expect(firstProfile.environment.REDIS_KEY_PREFIX).toBe("aw:runtime-a:");
    expect(firstProfile.environment.APP_ENDPOINT).toBe(
      `http://127.0.0.1:${first.port}/runtime-a`,
    );
    expect(await exists(firstProfile.tempDir)).toBe(true);

    await cleanupTask(fixture.repo, first.id, { force: true });
    await cleanupTask(fixture.repo, second.id, { force: true });
    expect(await exists(firstProfile.runtimeDir)).toBe(false);
    expect(await exists(secondProfile.runtimeDir)).toBe(false);
  });

  test("rejects reserved config variables and unknown templates", async () => {
    const fixture = await createFixture();
    const task = await createTask(fixture.repo, "bad_runtime", { worktreeRoot: fixture.worktrees });
    const config = join(task.worktree, ".agent-workspace.json");
    await Bun.write(config, JSON.stringify({ env: { AGENT_WORKSPACE_PORT: "1" } }));
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("reserved variable");
    await Bun.write(config, JSON.stringify({ env: { APP_NAME: "${missing}" } }));
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("unknown template");
    await Bun.write(config, "{");
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("invalid JSON");
    await Bun.write(config, "[]");
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("must contain a JSON object");
    await Bun.write(config, JSON.stringify({ prepare: [] }));
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("prepare must be a non-empty array");
    await Bun.write(config, JSON.stringify({ env: [] }));
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("env must be an object");
    await Bun.write(config, JSON.stringify({ env: { "INVALID-NAME": "value" } }));
    await expect(taskEnvironment(fixture.repo, task.id)).rejects.toThrow("valid environment names");
    await cleanupTask(fixture.repo, task.id, { force: true });
  });

  test("skips an operating-system port that is already bound", async () => {
    const fixture = await createFixture();
    const id = "occupied_port";
    const candidate = 24000 + (fnv1a(`${fixture.repo}\0${id}`) % 10000);
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(candidate, "127.0.0.1", resolveListen);
    });
    try {
      const task = await createTask(fixture.repo, id, { worktreeRoot: fixture.worktrees });
      expect(task.port).not.toBe(candidate);
      await cleanupTask(fixture.repo, task.id, { force: true });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe("runtime commands", () => {
  test("direct execution uses the runtime profile and returns child failures", async () => {
    const fixture = await createFixture({
      repoName: "direct repo with spaces",
      worktreesName: "direct workers with spaces",
    });
    const task = await createTask(fixture.repo, "direct_runtime", { worktreeRoot: fixture.worktrees });
    const marker = join(task.runtimeDir, "direct.txt");
    const prepared = await prepareTask(fixture.repo, task.id, [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.env.AGENT_WORKSPACE_RUNTIME_DIR + '/direct.txt', process.cwd())",
    ]);
    expect(prepared.exitCode).toBe(0);
    expect(await Bun.file(marker).text()).toBe(task.worktree);
    const failed = await executeTaskCommand(fixture.repo, task.id, [
      process.execPath,
      "-e",
      "process.exit(7)",
    ]);
    expect(failed.exitCode).toBe(7);
    if (process.platform === "win32") {
      const batch = join(task.worktree, "return code.cmd");
      await Bun.write(batch, "@exit /b 6\r\n");
      const batchResult = await executeTaskCommand(fixture.repo, task.id, [".\\return code.cmd", ""]);
      expect(batchResult.exitCode).toBe(6);
    }
    await cleanupTask(fixture.repo, task.id, { force: true });
  });

  test("runs two real TCP services concurrently with separate cwd, port, and temp directory", async () => {
    const fixture = await createFixture({
      repoName: "runtime repo with spaces",
      worktreesName: "runtime workers with spaces",
    });
    const serverScript = `
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer } = require("node:net");
const port = Number(process.env.PORT);
const output = join(process.env.AGENT_WORKSPACE_RUNTIME_DIR, "ready.json");
const server = createServer();
server.listen(port, "127.0.0.1", () => {
  writeFileSync(output, JSON.stringify({ port, cwd: process.cwd(), temp: tmpdir() }));
  setTimeout(() => server.close(), 250);
});
`;
    await Bun.write(join(fixture.repo, "server.cjs"), serverScript);
    await git(fixture.repo, ["add", "server.cjs"]);
    await git(fixture.repo, ["commit", "-m", "add test server"]);
    const first = await createTask(fixture.repo, "service_a", { worktreeRoot: fixture.worktrees });
    const second = await createTask(fixture.repo, "service_b", { worktreeRoot: fixture.worktrees });

    const [firstRun, secondRun] = await Promise.all([
      runCli(["exec", first.id, "--repo", fixture.repo, "--", "node", "server.cjs"]),
      runCli(["exec", second.id, "--repo", fixture.repo, "--", "node", "server.cjs"]),
    ]);
    expect(firstRun.exitCode, firstRun.stderr).toBe(0);
    expect(secondRun.exitCode, secondRun.stderr).toBe(0);
    const firstReady = await Bun.file(join(first.runtimeDir, "ready.json")).json();
    const secondReady = await Bun.file(join(second.runtimeDir, "ready.json")).json();
    expect(firstReady).toEqual({ port: first.port, cwd: first.worktree, temp: join(first.runtimeDir, "tmp") });
    expect(secondReady).toEqual({ port: second.port, cwd: second.worktree, temp: join(second.runtimeDir, "tmp") });

    await cleanupTask(fixture.repo, first.id, { force: true });
    await cleanupTask(fixture.repo, second.id, { force: true });
  });

  test("prepare auto-detects npm and runs npm ci with the isolated environment", async () => {
    const fixture = await createFixture();
    await Bun.write(
      join(fixture.repo, "package.json"),
      JSON.stringify({
        name: "npm-runtime-fixture",
        version: "1.0.0",
        scripts: { prepare: "node prepare.cjs" },
      }),
    );
    await Bun.write(
      join(fixture.repo, "package-lock.json"),
      JSON.stringify({
        name: "npm-runtime-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "npm-runtime-fixture", version: "1.0.0", hasInstallScript: true } },
      }),
    );
    await Bun.write(
      join(fixture.repo, "prepare.cjs"),
      'require("node:fs").writeFileSync(require("node:path").join(process.env.AGENT_WORKSPACE_RUNTIME_DIR, "npm.json"), JSON.stringify({ port: process.env.PORT, npm: process.env.npm_execpath }));\n',
    );
    await Bun.write(join(fixture.repo, ".gitignore"), "node_modules/\n");
    await git(fixture.repo, ["add", "."]);
    await git(fixture.repo, ["commit", "-m", "add npm fixture"]);
    const task = await createTask(fixture.repo, "npm_prepare", { worktreeRoot: fixture.worktrees });

    const prepared = await runCli(["prepare", task.id, "--repo", fixture.repo]);
    expect(prepared.exitCode, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
    const marker = await Bun.file(join(task.runtimeDir, "npm.json")).json();
    expect(marker.port).toBe(String(task.port));
    expect(marker.npm.toLowerCase()).toContain("npm");
    await cleanupTask(fixture.repo, task.id, { force: true });
  });

  test("propagates the exact child exit code", async () => {
    const fixture = await createFixture();
    const task = await createTask(fixture.repo, "exit_code", { worktreeRoot: fixture.worktrees });
    const result = await runCli([
      "exec",
      task.id,
      "--repo",
      fixture.repo,
      "--",
      "node",
      "-e",
      "process.exit(7)",
    ]);
    expect(result.exitCode).toBe(7);
    await cleanupTask(fixture.repo, task.id, { force: true });
  });
});

test("builds Windows command specs without invoking a platform shell", async () => {
  const fixture = await createFixture();
  const bin = join(fixture.root, "fake bin with spaces");
  await mkdir(bin);
  const shim = join(bin, "tool.cmd");
  await Bun.write(shim, "@exit /b 0\r\n");
  const environment = {
    PATH: bin,
    PATHEXT: ".cmd",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  };
  const shimSpec = await windowsCommandSpec(["tool", "hello workspace", ""], fixture.repo, environment);
  expect(shimSpec.executable).toBe(environment.ComSpec);
  expect(shimSpec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(shimSpec.args[3]).toContain('"hello workspace"');
  expect(shimSpec.args[3]).toContain('""');
  expect(shimSpec.windowsVerbatimArguments).toBe(true);

  const directSpec = await windowsCommandSpec([process.execPath, "--version"], fixture.repo, environment);
  expect(directSpec).toEqual({
    executable: process.execPath,
    args: ["--version"],
    windowsVerbatimArguments: false,
  });
});

test("detects frozen install commands and rejects ambiguous lockfiles", async () => {
  const fixture = await createFixture();
  const root = join(fixture.root, "package managers");
  await mkdir(root);
  await Bun.write(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }));
  expect(await detectPrepareCommand(root)).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  await Bun.write(join(root, "package.json"), "{}");
  await Bun.write(join(root, "bun.lock"), "");
  expect(await detectPrepareCommand(root)).toEqual(["bun", "install", "--frozen-lockfile"]);
  await Bun.write(join(root, "package-lock.json"), "{}");
  await expect(detectPrepareCommand(root)).rejects.toThrow("multiple lockfiles");

  const empty = join(fixture.root, "empty package");
  await mkdir(empty);
  await expect(detectPrepareCommand(empty)).rejects.toThrow("no supported lockfile");
  await Bun.write(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.1.0" }));
  await Bun.write(join(root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  expect(await detectPrepareCommand(root)).toEqual(["yarn", "install", "--immutable"]);
  await Bun.write(join(root, "package.json"), JSON.stringify({ packageManager: "@invalid" }));
  await expect(detectPrepareCommand(root)).rejects.toThrow("invalid packageManager");
  await Bun.write(join(root, "package.json"), JSON.stringify({ packageManager: "cargo@1" }));
  await expect(detectPrepareCommand(root)).rejects.toThrow("unsupported packageManager");
});

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
