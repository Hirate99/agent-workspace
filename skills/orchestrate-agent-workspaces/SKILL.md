---
name: orchestrate-agent-workspaces
description: Create isolated Git worktree transactions for AI coding agents and agent orchestrators. Use when an agent needs to implement changes in an isolated branch or workspace, coordinate concurrent writers, prevent shared-workspace conflicts, allocate scopes or exclusive resources, collect worker commits, or serialize integration and validation. Do not use for read-only research, review, or explanation.
---

# Orchestrate Agent Workspaces

Treat every writing agent as a transaction: isolate its writes, collect a commit, then integrate candidates one at a time.

## Preconditions

- Require Git, Node.js 18 or newer, and at least one committed base revision.
- Run `node <skill-dir>/scripts/agent-workspace.js --help` to inspect the installed CLI.
- If separate worktrees are unavailable, parallelize only research, review, and tests. Keep file writes serial.
- Keep workers away from `checkout`, `switch`, `reset`, `stash`, `merge`, final-branch pushes, and other tasks' worktrees.

## Choose the transaction shape

- For one implementation task or a request to start work on a new branch or workspace, create one transaction and do all writes in the returned worktree. Keep the original checkout unchanged.
- For multiple writing agents, create one transaction per independent task and integrate them serially.
- For read-only research, explanation, or review, do not create a worktree unless the user explicitly asks for one.

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
node <skill-dir>/scripts/agent-workspace.js create T123 \
  --repo <repo> \
  --base <sha> \
  --scope src/payments \
  --exclusive api-schema
```

Give the worker only:

- the returned `worktree`, `branch`, `namespace`, `port`, and `runtimeDir`;
- its allowed scopes and acceptance checks;
- relevant dependency or contract decisions.

Prepare dependencies once per worker before implementation or tests:

```sh
node <skill-dir>/scripts/agent-workspace.js prepare T123 --repo <repo>
```

`prepare` detects npm, pnpm, Yarn, or Bun from `packageManager` and lockfiles and performs a frozen install. If detection is not appropriate for the repository, pass an explicit command after `--` or commit `.agent-workspace.json` with a `prepare` argument array.

Run worker tests, development servers, database setup, and other resource-using commands through the transaction runtime:

```sh
node <skill-dir>/scripts/agent-workspace.js exec T123 --repo <repo> -- npm test
```

Do not run those commands directly from the shared main checkout. `exec` fixes the worker `cwd` and injects its assigned `PORT`, isolated temporary directory, `COMPOSE_PROJECT_NAME`, and `AGENT_WORKSPACE_*` namespace hints. Use `env T123 --repo <repo>` to inspect the non-secret overrides. If the application ignores these variables or uses a fixed host port, database, Redis keyspace, container name, or build directory, declare mappings in `.agent-workspace.json` or mark that resource `--exclusive` and serialize it.

Require the worker to run focused checks and commit all intended changes. Then submit:

```sh
node <skill-dir>/scripts/agent-workspace.js submit T123 --repo <worker-worktree>
```

Submission must fail for dirty worktrees, merge commits, empty changes, or paths outside declared scopes. Treat that failure as task feedback; do not bypass it casually.

## Integrate serially

Use one clean main worktree as the integration writer. Follow DAG order and integrate one submitted task at a time:

```sh
node <skill-dir>/scripts/agent-workspace.js integrate T123 \
  --repo <main-worktree> \
  --check "npm run typecheck" \
  --check "npm test"
```

The CLI holds a repository integration lock, cherry-picks the submitted commits, and runs checks in order. On conflict it aborts the cherry-pick. On a failed check it restores the pre-integration HEAD; inspect and remove only artifacts created by the failed check.

If a conflict changes business meaning, API shape, or architecture, return the latest integration SHA to the original worker and recreate the task. Let the integrator resolve only mechanical conflicts.

After successful integration, clean the worker transaction:

```sh
node <skill-dir>/scripts/agent-workspace.js cleanup T123 --repo <main-worktree>
```

Use `--force` only with explicit authorization when discarding a non-integrated or dirty worktree.

## Report evidence

For each task, report the base and result commits, actual changed paths, checks run, contract changes, and new assumptions. Do not claim batch completion until the latest integration head passes repository-wide semantic, contract, and integration checks.

Use `status [task] --repo <repo>` to inspect durable task records under the repository's Git common directory.
