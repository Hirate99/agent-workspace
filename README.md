# agent-workspace

A small transaction layer for parallel coding agents: one Git worktree per writer, durable task metadata, scope checks, and a single serialized integration path.

It deliberately does not provide a daemon, distributed locks, containers, or semantic merge automation. The included Codex Skill plans the work; the Bun CLI enforces the local isolation primitive.

## Requirements

- Git 2.31 or newer
- Bun 1.1 or newer
- A repository with at least one commit

## Install

```sh
bun install
bun link
```

The Skill is self-contained at `.agents/skills/orchestrate-agent-workspaces`. Its CLI has no runtime package dependencies.

## Workflow

```sh
# Create an isolated worker transaction.
agent-workspace create T123 \
  --repo /path/to/repo \
  --base HEAD \
  --scope src/payments \
  --exclusive api-schema

# Work and commit inside the returned worktree, then submit it.
agent-workspace submit T123 --repo /path/to/worker

# Integrate from the clean main worktree. Checks are optional and repeatable.
agent-workspace integrate T123 \
  --repo /path/to/repo \
  --check "bun run typecheck" \
  --check "bun test"

# Remove the integrated worktree and worker branch.
agent-workspace cleanup T123 --repo /path/to/repo
```

Every command emits JSON. Run `agent-workspace --help` for all options.

## Safety model

- Task records live in `<git-common-dir>/agent-workspace/tasks` and are shared by linked worktrees.
- `submit` requires a clean worker and rejects undeclared paths, merge commits, and no-op tasks.
- Exclusive resource names prevent known hotspots from being scheduled concurrently.
- `integrate` requires the original main worktree to be clean and uses an atomic lock file.
- Cherry-pick conflicts are aborted. Failed checks restore the integration HEAD to its prior commit.
- `cleanup` refuses to discard non-integrated work unless `--force` is explicit.

This prevents physical workspace conflicts and catches declared scope violations. It cannot prove that independently edited code is semantically compatible; repository-wide tests and contract checks remain the integration gate.

## Development

```sh
bun run typecheck
bun test
bun run test:coverage
```

The end-to-end tests create disposable Git repositories and exercise real worktree, concurrent submission, serialized integration, commit conflicts, scope enforcement, rollback, and cleanup behavior. Coverage fails below 90% for lines, functions, or statements. GitHub Actions runs the same gates on Windows and Ubuntu.
