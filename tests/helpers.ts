import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../.agents/skills/orchestrate-agent-workspaces/scripts/git.ts";

export interface Fixture {
  root: string;
  repo: string;
  worktrees: string;
}

export interface FixtureOptions {
  repoName?: string;
  worktreesName?: string;
}

const fixtures: string[] = [];

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-workspace-test-"));
  fixtures.push(root);
  const repo = join(root, options.repoName ?? "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Agent Workspace Tests"]);
  await git(repo, ["config", "user.email", "tests@example.invalid"]);
  await Bun.write(join(repo, "README.md"), "base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return { root, repo, worktrees: join(root, options.worktreesName ?? "worktrees") };
}

export async function commitFile(
  cwd: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<void> {
  const absolute = join(cwd, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await Bun.write(absolute, content);
  await git(cwd, ["add", "--", relativePath]);
  await git(cwd, ["commit", "-m", message]);
}

export async function cleanupFixtures(): Promise<void> {
  for (const root of fixtures.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function exists(path: string): Promise<boolean> {
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
