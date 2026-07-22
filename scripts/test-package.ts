import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const decoder = new TextDecoder();

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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

  const executable = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-workspace.cmd" : "agent-workspace",
  );
  const help = run([executable, "--help"], consumerDirectory);
  if (!help.includes("agent-workspace <command>")) {
    throw new Error("installed CLI did not print the expected help output");
  }

  console.log(
    "package smoke test passed: " +
      result.filename +
      ", " +
      paths.size +
      " files, installed CLI executable",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
