---
name: orchestrate-agent-workspaces
description: Plan and execute multi-agent coding work as isolated Git worktree transactions. Use when Codex must split implementation among parallel writing agents, prevent shared-workspace conflicts, allocate task scopes or exclusive resources, collect worker commits, or serialize integration and validation.
---

# Orchestrate Agent Workspaces

Treat every writing agent as a transaction: isolate its writes, collect a commit, then integrate candidates one at a time.

## Preconditions

- Require Git, Bun, and at least one committed base revision.
- Run `bun <skill-dir>/scripts/cli.ts --help` to inspect the installed CLI.
- If separate worktrees are unavailable, parallelize only research, review, and tests. Keep file writes serial.
- Keep workers away from `checkout`, `switch`, `reset`, `stash`, `merge`, final-branch pushes, and other tasks' worktrees.

## Plan the work

1. Freeze one base SHA for the batch.
2. Build a task DAG with `id`, `depends_on`, `scope`, `exclusive`, and acceptance checks.
3. Classify each task:
   - Green: independent scope and contract; run in parallel.
   - Yellow: shared API or schema; land a foundation task first, then replan.
   - Red: overlapping core code, migrations, generated files, lockfiles, or global configuration; serialize.
4. Prefer small task scopes. Mark shared resources with repeatable `--exclusive` flags.

Do not use file locks for ordinary source files. Use optimistic isolation plus scope validation; reserve exclusivity for actual hotspots.

## Create worker transactions

Create each green task from the same base:

```sh
bun <skill-dir>/scripts/cli.ts create T123 \
  --repo <repo> \
  --base <sha> \
  --scope src/payments \
  --exclusive api-schema
```

Give the worker only:

- the returned `worktree`, `branch`, `namespace`, and `port`;
- its allowed scopes and acceptance checks;
- relevant dependency or contract decisions.

Require the worker to run focused checks and commit all intended changes. Then submit:

```sh
bun <skill-dir>/scripts/cli.ts submit T123 --repo <worker-worktree>
```

Submission must fail for dirty worktrees, merge commits, empty changes, or paths outside declared scopes. Treat that failure as task feedback; do not bypass it casually.

## Integrate serially

Use one clean main worktree as the integration writer. Follow DAG order and integrate one submitted task at a time:

```sh
bun <skill-dir>/scripts/cli.ts integrate T123 \
  --repo <main-worktree> \
  --check "bun run typecheck" \
  --check "bun test"
```

The CLI holds a repository integration lock, cherry-picks the submitted commits, and runs checks in order. On conflict it aborts the cherry-pick. On a failed check it restores the pre-integration HEAD; inspect and remove only artifacts created by the failed check.

If a conflict changes business meaning, API shape, or architecture, return the latest integration SHA to the original worker and recreate the task. Let the integrator resolve only mechanical conflicts.

After successful integration, clean the worker transaction:

```sh
bun <skill-dir>/scripts/cli.ts cleanup T123 --repo <main-worktree>
```

Use `--force` only with explicit authorization when discarding a non-integrated or dirty worktree.

## Report evidence

For each task, report the base and result commits, actual changed paths, checks run, contract changes, and new assumptions. Do not claim batch completion until the latest integration head passes repository-wide semantic, contract, and integration checks.

Use `status [task] --repo <repo>` to inspect durable task records under the repository's Git common directory.
