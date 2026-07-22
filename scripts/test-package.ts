import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const decoder = new TextDecoder();

function run(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === "win32") {
    const result = Bun.spawnSync(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(
        command.join(" ") +
          " failed with exit " +
          result.exitCode +
          "\n" +
          stdout +
          stderr,
      );
    }
    return stdout;
  }

  const [executable, ...args] = command;
  if (!executable) throw new Error("cannot run an empty command");
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    throw new Error(command.join(" ") + " failed: " + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(
      command.join(" ") +
        " failed with exit " +
        result.status +
        "\n" +
        stdout +
        stderr,
    );
  }
  return stdout;
}

const project = join(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "agent-workspace-package-"));

try {
  const packageDirectory = join(scratch, "package");
  const consumerDirectory = join(scratch, "consumer");
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);

  const packed = JSON.parse(
    run([npm, "pack", "--json", "--pack-destination", packageDirectory], project),
  ) as PackResult[];
  const result = packed[0];
  if (!result) throw new Error("npm pack did not return a package");

  const paths = new Set(result.files.map((file) => file.path));
  const required = [
    "package.json",
    "README.md",
    ".agents/skills/orchestrate-agent-workspaces/SKILL.md",
    ".agents/skills/orchestrate-agent-workspaces/scripts/cli.ts",
    ".agents/skills/orchestrate-agent-workspaces/scripts/workspace.ts",
    ".agents/skills/orchestrate-agent-workspaces/dist/cli.js",
    ".agents/skills/orchestrate-agent-workspaces/dist/workspace.js",
    "bin/agent-workspace.js",
  ];
  for (const path of required) {
    if (!paths.has(path)) throw new Error("published package is missing " + path);
  }

  const forbiddenPrefixes = [".github/", "tests/", "scripts/"];
  const leaked = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );
  if (leaked.length > 0) {
    throw new Error(
      "published package contains development files: " + leaked.join(", "),
    );
  }

  const tarball = join(packageDirectory, result.filename);
  run(
    [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumerDirectory,
  );

  const finder = process.platform === "win32" ? "where.exe" : "which";
  const nodeExecutable = run([finder, "node"], consumerDirectory).trim().split(/\r?\n/)[0];
  const gitExecutable = run([finder, "git"], consumerDirectory).trim().split(/\r?\n/)[0];
  if (!nodeExecutable || !gitExecutable) {
    throw new Error("Node.js and Git must be available for the package smoke test");
  }

  const runtimePath = [dirname(nodeExecutable), dirname(gitExecutable)];
  if (process.platform === "win32" && process.env.SystemRoot) {
    runtimePath.push(join(process.env.SystemRoot, "System32"), process.env.SystemRoot);
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
  ) as NodeJS.ProcessEnv;
  runtimeEnv.PATH = [...new Set(runtimePath)].join(delimiter);

  const bunProbe = Bun.spawnSync([finder, "bun"], {
    cwd: consumerDirectory,
    env: runtimeEnv,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (bunProbe.exitCode === 0) {
    throw new Error("Bun unexpectedly remained available in the runtime smoke-test PATH");
  }

  const executable = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-workspace.cmd" : "agent-workspace",
  );
  const help = run([executable, "--help"], consumerDirectory, runtimeEnv);
  if (!help.includes("agent-workspace <command>")) {
    throw new Error("installed CLI did not print the expected help output");
  }

  const repository = join(scratch, "repository");
  await mkdir(repository);
  run([gitExecutable, "init"], repository, runtimeEnv);
  run([gitExecutable, "config", "user.email", "package-test@example.com"], repository, runtimeEnv);
  run([gitExecutable, "config", "user.name", "Package Test"], repository, runtimeEnv);
  await writeFile(join(repository, "README.md"), "base\n", "utf8");
  run([gitExecutable, "add", "README.md"], repository, runtimeEnv);
  run([gitExecutable, "commit", "-m", "base"], repository, runtimeEnv);
  const status = JSON.parse(
    run([executable, "status", "--repo", repository], consumerDirectory, runtimeEnv),
  ) as unknown[];
  if (status.length !== 0) {
    throw new Error("fresh repository unexpectedly contained task records");
  }

  console.log(
    "package smoke test passed: " +
      result.filename +
      ", " +
      paths.size +
      " files, installed Node.js CLI without Bun",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
