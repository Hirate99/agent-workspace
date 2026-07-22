# agent-workspace

A small transaction layer for parallel coding agents: one Git worktree per writer, durable task metadata, scope checks, and a single serialized integration path.

It deliberately does not provide a daemon, distributed locks, containers, or semantic merge automation. The included Codex Skill plans the work; the Bun CLI enforces the local isolation primitive.

## Requirements

- Git 2.31 or newer
- Bun 1.3 or newer
- A repository with at least one commit

## Install the CLI

```sh
npm install --global @mskyurina/agent-workspace
```

Bun and Git are required at runtime. The CLI has no runtime package dependencies.

To develop from source or use the bundled Skill directly:

```sh
git clone https://github.com/Hirate99/agent-workspace.git
cd agent-workspace
bun install
bun link
```

The Skill is self-contained at `.agents/skills/orchestrate-agent-workspaces`.

## Install the Codex Skill

Ask Codex to install the Skill from this public GitHub path:

```text
Use $skill-installer to install the skill from
https://github.com/Hirate99/agent-workspace/tree/main/.agents/skills/orchestrate-agent-workspaces
```

The installed Skill is named `$orchestrate-agent-workspaces`. Restart Codex if it does not appear immediately.

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
bun run test:package
```

The end-to-end tests create disposable Git repositories and exercise real worktree, concurrent submission, serialized integration, commit conflicts, scope enforcement, rollback, and cleanup behavior. The package smoke test builds the actual npm tarball, checks its contents, installs it into a clean consumer project, and invokes the installed CLI. Coverage fails below 90% for lines, functions, or statements. GitHub Actions runs the same gates on Windows and Ubuntu.
