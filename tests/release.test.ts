import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkPackageVersion,
  preparePackageVersion,
  resolveReleaseVersion,
  runReleaseCommand,
  validateReleaseVersion,
} from "../scripts/release.mjs";

const releaseScript = resolve(import.meta.dir, "../scripts/release.mjs");
const publishWorkflow = resolve(import.meta.dir, "../.github/workflows/publish.yml");

describe("release version preparation", () => {
  test("resolves stable semantic version bumps", () => {
    expect(resolveReleaseVersion("0.1.2", "patch")).toBe("0.1.3");
    expect(resolveReleaseVersion("0.1.2", "minor")).toBe("0.2.0");
    expect(resolveReleaseVersion("0.1.2", "major")).toBe("1.0.0");
    expect(resolveReleaseVersion("0.1.2", "2.3.4")).toBe("2.3.4");
  });

  test("rejects invalid, prerelease, and non-increasing versions", () => {
    expect(() => validateReleaseVersion("v1.2.3")).toThrow("stable SemVer");
    expect(() => validateReleaseVersion("1.2.3-beta.1")).toThrow("stable SemVer");
    expect(() => validateReleaseVersion("9007199254740992.0.0")).toThrow("safe integers");
    expect(() => resolveReleaseVersion("1.2.3", "1.2.3")).toThrow("must be greater");
    expect(() => resolveReleaseVersion("1.2.3", "1.2.2")).toThrow("must be greater");
    expect(() => resolveReleaseVersion("9007199254740991.0.0", "major")).toThrow(
      "incremented safely",
    );
  });

  test("updates only the package version and checks the result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-workspace-release-"));
    const packagePath = join(directory, "package.json");
    try {
      await writeFile(
        packagePath,
        `${JSON.stringify({ name: "fixture", version: "3.4.5", private: true }, null, 2)}\n`,
      );
      expect(await preparePackageVersion(packagePath, "minor")).toBe("3.5.0");
      expect(JSON.parse(await readFile(packagePath, "utf8"))).toEqual({
        name: "fixture",
        version: "3.5.0",
        private: true,
      });
      expect(await checkPackageVersion(packagePath, "3.5.0")).toBe("3.5.0");
      await expect(checkPackageVersion(packagePath, "3.5.1")).rejects.toThrow(
        "does not match",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports malformed and incomplete package files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-workspace-release-invalid-"));
    const packagePath = join(directory, "package.json");
    try {
      await writeFile(packagePath, "{");
      await expect(checkPackageVersion(packagePath, "1.0.0")).rejects.toThrow(
        "invalid package JSON",
      );

      await writeFile(packagePath, JSON.stringify({ version: 1 }));
      await expect(checkPackageVersion(packagePath, "1.0.0")).rejects.toThrow(
        "must contain a string version",
      );

      await expect(checkPackageVersion(join(directory, "missing.json"), "1.0.0")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("runs every release command and rejects malformed invocations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-workspace-release-cli-"));
    const packagePath = join(directory, "package.json");
    const output: string[] = [];
    try {
      await writeFile(packagePath, JSON.stringify({ name: "fixture", version: "0.0.1" }));
      await runReleaseCommand(["prepare", "patch", packagePath], (value) => output.push(value));
      await runReleaseCommand(["check", "0.0.2", packagePath], (value) => output.push(value));
      await runReleaseCommand(["validate", "2.3.4"], (value) => output.push(value));
      expect(output).toEqual(["0.0.2", "0.0.2", "2.3.4"]);

      await expect(runReleaseCommand([])).rejects.toThrow("usage");
      await expect(runReleaseCommand(["prepare"])).rejects.toThrow("usage");
      await expect(runReleaseCommand(["check"])).rejects.toThrow("usage");
      await expect(runReleaseCommand(["validate"])).rejects.toThrow("usage");
      await expect(runReleaseCommand(["validate", "1.2.3", "package.json"])).rejects.toThrow(
        "usage",
      );
      await expect(
        runReleaseCommand(["check", "0.0.2", packagePath, "unexpected"]),
      ).rejects.toThrow("unexpected arguments");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("exposes the version checks through the Node CLI", async () => {
    const checked = Bun.spawnSync([process.execPath, releaseScript, "check", "0.1.2"], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(checked.exitCode, new TextDecoder().decode(checked.stderr)).toBe(0);
    expect(new TextDecoder().decode(checked.stdout).trim()).toBe("0.1.2");
  });
});

test("publish workflow releases new versions after main updates", async () => {
  const workflow = await readFile(publishWorkflow, "utf8");
  expect(workflow).toContain("push:");
  expect(workflow).toContain("branches: [main]");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("contents: write");
  expect(workflow).toContain("id-token: write");
  expect(workflow).toContain('git tag -a "$RELEASE_VERSION"');
  expect(workflow).toContain("npm publish --access public");
  expect(workflow).toContain('gh release create "$RELEASE_VERSION"');
  expect(workflow).toContain("needs.inspect.outputs.should_release");
});
