import { afterEach, describe, expect, test } from "bun:test";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../src/git.ts";
import type { TaskState } from "../src/model.ts";
import {
  cleanupTask,
  createTask,
  integrateTask,
  submitTask,
  taskStatus,
} from "../src/workspace.ts";
import { cleanupFixtures, commitFile, createFixture, exists } from "./helpers.ts";

afterEach(cleanupFixtures);

describe("workspace transactions", () => {
  test("creates, submits, integrates, and cleans an isolated worker", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "T123", {
      worktreeRoot: fixture.worktrees,
      scopes: ["src"],
    });

    expect(created.status).toBe("active");
    expect(await exists(created.worktree)).toBe(true);
    expect(created.port).toBeGreaterThanOrEqual(24000);

    await commitFile(created.worktree, "src/feature.ts", "export const feature = true;\n", "feature");
    const submitted = await submitTask(created.worktree, created.id);
    expect(submitted.status).toBe("submitted");
    expect(submitted.changedFiles).toEqual(["src/feature.ts"]);

    const integrated = await integrateTask(fixture.repo, created.id, {
      checks: ["git rev-parse --verify HEAD"],
    });
    expect(integrated.status).toBe("integrated");
    expect(await Bun.file(join(fixture.repo, "src/feature.ts")).text()).toContain("true");

    const cleaned = await cleanupTask(fixture.repo, created.id);
    expect(cleaned.status).toBe("cleaned");
    expect(await exists(created.worktree)).toBe(false);
  });

  test("rejects committed paths outside declared scopes", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "scope_guard", {
      worktreeRoot: fixture.worktrees,
      scopes: ["src"],
    });
    await commitFile(created.worktree, "outside.txt", "nope\n", "outside scope");

    await expect(submitTask(created.worktree, created.id)).rejects.toThrow("outside scope");
    await cleanupTask(fixture.repo, created.id, { force: true });
  });

  test("rejects a nested worktree root that would dirty the main worktree", async () => {
    const fixture = await createFixture();
    await expect(
      createTask(fixture.repo, "nested", {
        worktreeRoot: join(fixture.repo, ".workers"),
      }),
    ).rejects.toThrow("outside the main worktree");
  });

  test("canonicalizes path aliases before enforcing worktree boundaries", async () => {
    const fixture = await createFixture();
    const alias = join(fixture.root, "repo alias");
    await symlink(
      fixture.repo,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      createTask(alias, "alias_nested", {
        worktreeRoot: join(alias, ".workers"),
      }),
    ).rejects.toThrow("outside the main worktree");
  });

  test("prevents concurrent tasks from claiming the same exclusive resource", async () => {
    const fixture = await createFixture();
    const first = await createTask(fixture.repo, "schema_a", {
      worktreeRoot: fixture.worktrees,
      exclusive: ["api-schema"],
    });

    await expect(
      createTask(fixture.repo, "schema_b", {
        worktreeRoot: fixture.worktrees,
        exclusive: ["api-schema"],
      }),
    ).rejects.toThrow("exclusive resource conflict");

    await cleanupTask(fixture.repo, first.id, { force: true });
  });

  test("restores integration HEAD when a check fails", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "rollback", {
      worktreeRoot: fixture.worktrees,
      scopes: ["README.md"],
    });
    await commitFile(created.worktree, "README.md", "candidate\n", "candidate");
    await submitTask(created.worktree, created.id);
    const before = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(
      integrateTask(fixture.repo, created.id, { checks: ["git rev-parse --verify refs/heads/agent-workspace-test-missing"] }),
    ).rejects.toThrow("HEAD restored");

    const after = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect(after).toBe(before);
    const state = (await taskStatus(fixture.repo, created.id)) as TaskState;
    expect(state.status).toBe("submitted");
    await cleanupTask(fixture.repo, created.id, { force: true });
  });

  test("rejects checks that succeed but leave integration dirty", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "dirty_check", {
      worktreeRoot: fixture.worktrees,
      scopes: ["README.md"],
    });
    await commitFile(created.worktree, "README.md", "candidate\n", "candidate");
    await submitTask(created.worktree, created.id);
    const before = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(
      integrateTask(fixture.repo, created.id, {
        checks: ["git show HEAD^:README.md > README.md"],
      }),
    ).rejects.toThrow("left worktree dirty");

    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
    expect((await git(fixture.repo, ["status", "--porcelain"])).stdout.trim()).toBe("");
    await cleanupTask(fixture.repo, created.id, { force: true });
  });

  test("serializes concurrent submissions and integrations", async () => {
    const fixture = await createFixture();
    const first = await createTask(fixture.repo, "parallel_a", {
      worktreeRoot: fixture.worktrees,
      scopes: ["src/a"],
    });
    const second = await createTask(fixture.repo, "parallel_b", {
      worktreeRoot: fixture.worktrees,
      scopes: ["src/b"],
    });
    expect(first.base).toBe(second.base);
    expect(first.port).not.toBe(second.port);

    await commitFile(first.worktree, "src/a/feature.ts", "export const a = 1;\n", "feature a");
    await commitFile(second.worktree, "src/b/feature.ts", "export const b = 2;\n", "feature b");
    await Promise.all([
      submitTask(first.worktree, first.id),
      submitTask(second.worktree, second.id),
    ]);

    const [integratedA, integratedB] = await Promise.all([
      integrateTask(fixture.repo, first.id),
      integrateTask(fixture.repo, second.id),
    ]);
    expect(integratedA.status).toBe("integrated");
    expect(integratedB.status).toBe("integrated");
    expect(await Bun.file(join(fixture.repo, "src/a/feature.ts")).exists()).toBe(true);
    expect(await Bun.file(join(fixture.repo, "src/b/feature.ts")).exists()).toBe(true);

    await cleanupTask(fixture.repo, first.id);
    await cleanupTask(fixture.repo, second.id);
  });

  test("aborts a real cherry-pick conflict without moving integration HEAD", async () => {
    const fixture = await createFixture();
    const first = await createTask(fixture.repo, "conflict_a", {
      worktreeRoot: fixture.worktrees,
      scopes: ["README.md"],
    });
    const second = await createTask(fixture.repo, "conflict_b", {
      worktreeRoot: fixture.worktrees,
      scopes: ["README.md"],
    });
    await commitFile(first.worktree, "README.md", "first\n", "first");
    await commitFile(second.worktree, "README.md", "second\n", "second");
    await submitTask(first.worktree, first.id);
    await submitTask(second.worktree, second.id);
    await integrateTask(fixture.repo, first.id);
    const beforeConflict = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(integrateTask(fixture.repo, second.id)).rejects.toThrow("cherry-pick");
    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim()).toBe(beforeConflict);
    expect((await git(fixture.repo, ["status", "--porcelain"])).stdout.trim()).toBe("");
    const cherryPickHead = await git(
      fixture.repo,
      ["rev-parse", "--verify", "CHERRY_PICK_HEAD"],
      { allowFailure: true },
    );
    expect(cherryPickHead.exitCode).not.toBe(0);
    expect(((await taskStatus(fixture.repo, second.id)) as TaskState).status).toBe("submitted");

    await cleanupTask(fixture.repo, first.id);
    await cleanupTask(fixture.repo, second.id, { force: true });
  });

  test("rejects no-op and dirty submissions", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "submit_guards", {
      worktreeRoot: fixture.worktrees,
    });
    await expect(submitTask(created.worktree, created.id)).rejects.toThrow("no committed changes");

    const scratch = join(created.worktree, "scratch.txt");
    await Bun.write(scratch, "dirty\n");
    await expect(submitTask(created.worktree, created.id)).rejects.toThrow("must be clean");
    await rm(scratch);
    await cleanupTask(fixture.repo, created.id, { force: true });
  });

  test("protects active tasks from accidental cleanup", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "cleanup_guard", {
      worktreeRoot: fixture.worktrees,
    });
    await expect(cleanupTask(fixture.repo, created.id)).rejects.toThrow("pass --force");
    expect(await exists(created.worktree)).toBe(true);
    await cleanupTask(fixture.repo, created.id, { force: true });
  });

  test("rejects mutating coordinator commands from a linked worker", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture.repo, "worker_guard", {
      worktreeRoot: fixture.worktrees,
    });
    await expect(createTask(created.worktree, "child")).rejects.toThrow("main worktree");
    await expect(integrateTask(created.worktree, created.id)).rejects.toThrow("main worktree");
    await expect(cleanupTask(created.worktree, created.id, { force: true })).rejects.toThrow(
      "main worktree",
    );
    await cleanupTask(fixture.repo, created.id, { force: true });
  });

  test("validates task ids, scopes, duplicates, and status listing", async () => {
    const fixture = await createFixture();
    await expect(createTask(fixture.repo, "../bad")).rejects.toThrow("invalid task id");
    await expect(
      createTask(fixture.repo, "bad_scope", {
        worktreeRoot: fixture.worktrees,
        scopes: ["../outside"],
      }),
    ).rejects.toThrow("repository-relative");

    const created = await createTask(fixture.repo, "unique", {
      worktreeRoot: fixture.worktrees,
    });
    await expect(createTask(fixture.repo, "unique")).rejects.toThrow("already exists");
    const tasks = (await taskStatus(fixture.repo)) as TaskState[];
    expect(tasks.map((task) => task.id)).toEqual(["unique"]);
    await cleanupTask(fixture.repo, created.id, { force: true });
  });
});
