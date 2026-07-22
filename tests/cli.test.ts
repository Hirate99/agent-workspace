import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cleanupTask } from "../.agents/skills/orchestrate-agent-workspaces/scripts/workspace.ts";
import { cleanupFixtures, createFixture } from "./helpers.ts";

afterEach(cleanupFixtures);

test("CLI emits a durable task record as JSON", async () => {
  const fixture = await createFixture();
  const cli = resolve(
    import.meta.dir,
    "../.agents/skills/orchestrate-agent-workspaces/scripts/cli.ts",
  );
  const create = Bun.spawn(
    ["bun", cli, "create", "CLI1", "--repo", fixture.repo, "--root", fixture.worktrees, "--scope", "."],
    { stdout: "pipe", stderr: "pipe" },
  );
  const createOutput = new Response(create.stdout).text();
  const createError = new Response(create.stderr).text();
  expect(await create.exited, await createError).toBe(0);
  const created = JSON.parse(await createOutput) as { id: string; status: string };
  expect(created).toMatchObject({ id: "CLI1", status: "active" });

  const status = Bun.spawn(["bun", cli, "status", "CLI1", "--repo", fixture.repo], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const statusOutput = new Response(status.stdout).text();
  const statusError = new Response(status.stderr).text();
  expect(await status.exited, await statusError).toBe(0);
  expect(JSON.parse(await statusOutput)).toMatchObject({ id: "CLI1", status: "active" });

  const rejectedCleanup = Bun.spawn(
    ["bun", cli, "cleanup", "CLI1", "--repo", fixture.repo],
    { stdout: "pipe", stderr: "pipe" },
  );
  const cleanupError = new Response(rejectedCleanup.stderr).text();
  expect(await rejectedCleanup.exited).toBe(1);
  expect(await cleanupError).toContain("pass --force");

  await cleanupTask(fixture.repo, "CLI1", { force: true });
});
