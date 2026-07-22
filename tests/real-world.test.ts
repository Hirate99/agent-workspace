import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "../.agents/skills/orchestrate-agent-workspaces/scripts/git.ts";
import { cleanupFixtures, commitFile, createFixture, exists } from "./helpers.ts";

afterEach(cleanupFixtures);

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const cli = resolve(
  import.meta.dir,
  "../.agents/skills/orchestrate-agent-workspaces/scripts/cli.ts",
);

async function runCli(args: string[]): Promise<CliResult> {
  const process = Bun.spawn(["bun", cli, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    process.exited,
    stdout,
    stderr,
  ]);
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

test("public CLI completes a multi-commit transaction in paths containing spaces", async () => {
  const fixture = await createFixture({
    repoName: "repo with spaces",
    worktreesName: "worker trees",
  });
  const create = await runCli([
    "create",
    "path_spaces",
    "--repo",
    fixture.repo,
    "--root",
    fixture.worktrees,
    "--scope",
    ".",
  ]);
  expect(create.exitCode, create.stderr).toBe(0);
  const created = JSON.parse(create.stdout) as { id: string; worktree: string };
  expect(created.worktree).toContain("worker trees");

  await mkdir(join(created.worktree, "docs"));
  await git(created.worktree, ["mv", "README.md", "docs/README.md"]);
  await git(created.worktree, ["commit", "-m", "move documentation"]);
  await commitFile(
    created.worktree,
    "src/app.ts",
    "export const app = 'ready';\n",
    "add application",
  );

  const submit = await runCli(["submit", created.id, "--repo", created.worktree]);
  expect(submit.exitCode, submit.stderr).toBe(0);
  const submitted = JSON.parse(submit.stdout) as { status: string; changedFiles: string[] };
  expect(submitted.status).toBe("submitted");
  expect(submitted.changedFiles).toContain("src/app.ts");

  const integrate = await runCli([
    "integrate",
    created.id,
    "--repo",
    fixture.repo,
    "--check",
    "git rev-parse --verify HEAD",
    "--check",
    "git status --porcelain",
  ]);
  expect(integrate.exitCode, integrate.stderr).toBe(0);
  expect(JSON.parse(integrate.stdout)).toMatchObject({ status: "integrated" });
  expect(await Bun.file(join(fixture.repo, "docs/README.md")).exists()).toBe(true);
  expect(await Bun.file(join(fixture.repo, "src/app.ts")).text()).toContain("ready");

  const cleanup = await runCli(["cleanup", created.id, "--repo", fixture.repo]);
  expect(cleanup.exitCode, cleanup.stderr).toBe(0);
  expect(await exists(created.worktree)).toBe(false);
});

test("public CLI rebases an old fixed base onto a newer integration head", async () => {
  const fixture = await createFixture();
  const base = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();
  await commitFile(fixture.repo, "foundation.txt", "foundation\n", "foundation");

  const create = await runCli([
    "create",
    "old_base",
    "--repo",
    fixture.repo,
    "--root",
    fixture.worktrees,
    "--base",
    base,
    "--scope",
    "src/legacy",
  ]);
  expect(create.exitCode, create.stderr).toBe(0);
  const created = JSON.parse(create.stdout) as { id: string; worktree: string };
  await commitFile(created.worktree, "src/legacy/index.ts", "export const legacy = true;\n", "legacy");
  expect((await runCli(["submit", created.id, "--repo", created.worktree])).exitCode).toBe(0);
  expect((await runCli(["integrate", created.id, "--repo", fixture.repo])).exitCode).toBe(0);

  expect(await Bun.file(join(fixture.repo, "foundation.txt")).text()).toBe("foundation\n");
  expect(await Bun.file(join(fixture.repo, "src/legacy/index.ts")).text()).toContain("true");
  expect((await runCli(["cleanup", created.id, "--repo", fixture.repo])).exitCode).toBe(0);
});
