import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cleanupTask } from "../src/workspace.ts";
import { cleanupFixtures, createFixture } from "./helpers.ts";

afterEach(cleanupFixtures);

test("CLI emits a durable task record as JSON", async () => {
  const fixture = await createFixture();
  const cli = resolve(
    import.meta.dir,
    "../skills/orchestrate-agent-workspaces/scripts/agent-workspace.js",
  );
  const create = Bun.spawn(
    ["node", cli, "create", "CLI1", "--repo", fixture.repo, "--root", fixture.worktrees, "--scope", "."],
    { stdout: "pipe", stderr: "pipe" },
  );
  const createOutput = new Response(create.stdout).text();
  const createError = new Response(create.stderr).text();
  expect(await create.exited, await createError).toBe(0);
  const created = JSON.parse(await createOutput) as { id: string; status: string };
  expect(created).toMatchObject({ id: "CLI1", status: "active" });

  const verify = Bun.spawn(["node", cli, "verify", "CLI1", "--repo", fixture.repo], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const verifyOutput = new Response(verify.stdout).text();
  const verifyError = new Response(verify.stderr).text();
  expect(await verify.exited, await verifyError).toBe(0);
  expect(JSON.parse(await verifyOutput)).toMatchObject({
    id: "CLI1",
    writable: true,
    gitAccessible: true,
    compatible: true,
  });

  const status = Bun.spawn(["node", cli, "status", "CLI1", "--repo", fixture.repo], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const statusOutput = new Response(status.stdout).text();
  const statusError = new Response(status.stderr).text();
  expect(await status.exited, await statusError).toBe(0);
  expect(JSON.parse(await statusOutput)).toMatchObject({ id: "CLI1", status: "active" });

  const rejectedCleanup = Bun.spawn(
    ["node", cli, "cleanup", "CLI1", "--repo", fixture.repo],
    { stdout: "pipe", stderr: "pipe" },
  );
  const cleanupError = new Response(rejectedCleanup.stderr).text();
  expect(await rejectedCleanup.exited).toBe(1);
  expect(await cleanupError).toContain("pass --force");

  await cleanupTask(fixture.repo, "CLI1", { force: true });
});
