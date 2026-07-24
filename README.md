# agent-workspace

A small transaction layer for coding agents: one Git worktree per writer, durable task metadata, scope checks, and a single serialized integration path.

This repository is both:

- an [Agent Skill](https://agentskills.io/) under `skills/orchestrate-agent-workspaces/`;
- a zero-runtime-dependency Node.js CLI published as `@mskyurina/agent-workspace`.

The CLI and core Skill are host-agnostic: any coding agent, script, or CI pipeline can invoke the transaction workflow. Files under `agents/` provide optional host-specific metadata and are not required to run either layer.

It deliberately does not provide a daemon, distributed locks, containers, or semantic merge automation. The Skill plans the work; the CLI enforces the local Git isolation primitive.

## Quick install

Install the Skill globally for your coding agent with the open-source [Vercel Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add Hirate99/agent-workspace -g
```

The installer detects supported agents and lets you select the destinations. For non-interactive installation, add one or more `-a <agent-id>` options and `-y`.

Install the transaction CLI:

```sh
npm install --global @mskyurina/agent-workspace
```

The two commands install different pieces: `npx skills` puts the instructions and bundled scripts where the selected agents can discover them, while `npm install` exposes the `agent-workspace` command on your PATH. The Skill can run its bundled CLI without a global CLI installation.

For a one-off CLI invocation without global installation:

```sh
npx --yes @mskyurina/agent-workspace --help
```

We intentionally do not mutate agent directories from npm `postinstall`. Skill installation remains an explicit, reviewable operation, and `npx skills` also handles updates, removal, project/global scope, and other supported agents.

## Requirements

- Git 2.31 or newer
- Node.js 18 or newer
- A repository with at least one commit

Bun is only required for contributing and running this repository's test suite.

## Repository layout

```text
skills/
  orchestrate-agent-workspaces/
    SKILL.md      Agent instructions and trigger metadata
    agents/       optional host-specific UI metadata
    scripts/
      agent-workspace.js  generated, dependency-free CLI bundle
src/              TypeScript CLI source
bin/              npm executable launcher
tests/            unit, integration, real-world, and package tests
```

The standard `skills/<name>/` layout lets `npx skills add Hirate99/agent-workspace` discover the Skill with the same one-line command while copying only the self-contained Skill directory, not the npm project or its development dependencies.

The TypeScript modules under `src/` are the only hand-edited CLI implementation. `npm run build` deterministically bundles them into the single committed `scripts/agent-workspace.js` file so a remotely installed Skill can run immediately with Node.js and no build step. CI rebuilds the bundle and rejects any generated diff.

## Workflow

```sh
# Create an isolated worker transaction.
agent-workspace create T123 \
  --repo /path/to/repo \
  --base HEAD \
  --scope src/payments \
  --exclusive api-schema

# Confirm the worker identity can write, use Git, and stay within tool path budgets.
agent-workspace verify T123 --repo /path/to/repo

# Reproducibly install dependencies in the returned worktree.
agent-workspace prepare T123 --repo /path/to/repo

# Run tests or services with the task runtime namespace.
agent-workspace exec T123 --repo /path/to/repo -- npm test

# Work and commit inside the returned worktree, then submit it.
agent-workspace submit T123 --repo /path/to/worker

# Integrate from the clean main worktree. Checks are optional and repeatable.
agent-workspace integrate T123 \
  --repo /path/to/repo \
  --check "npm run typecheck" \
  --check "npm test"

# Remove the integrated worktree and worker branch.
agent-workspace cleanup T123 --repo /path/to/repo
```

State commands emit JSON. `prepare` and `exec` attach to the child process and preserve its exit code. Run `verify` with the same non-elevated sandbox identity that will edit the worker; it fails early when the external worktree is not writable, Git rejects its ownership, or a tracked Windows path exceeds the conservative 240-character tool compatibility budget. Recreate failures with a short, approved `--root` and verify again. Run `agent-workspace --help` for all options.

## Lightweight runtime isolation

Each task receives a unique, durable runtime profile in addition to its worktree:

- `PORT` and `AGENT_WORKSPACE_PORT` use the task port. Creation skips ports that are already bound.
- `TEMP`, `TMP`, and `TMPDIR` point to an OS temporary path namespaced by repository and task, outside the repository tree.
- `COMPOSE_PROJECT_NAME` keeps normal Compose networks, volumes, and containers task-specific.
- `AGENT_WORKSPACE_DB_NAMESPACE` and `AGENT_WORKSPACE_REDIS_PREFIX` provide safe names for application-level database and Redis isolation.
- `AGENT_WORKSPACE_ID`, `AGENT_WORKSPACE_NAMESPACE`, `AGENT_WORKSPACE_WORKTREE`, and `AGENT_WORKSPACE_RUNTIME_DIR` are available to scripts.

`prepare` selects a frozen install from `packageManager` or an unambiguous `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, or `bun.lockb`. Override it for other ecosystems with `prepare T123 -- <command>`, or commit a small project configuration:

```json
{
  "prepare": ["npm", "ci"],
  "env": {
    "DATABASE_SCHEMA": "${dbNamespace}",
    "REDIS_KEY_PREFIX": "${redisPrefix}",
    "APP_URL": "http://127.0.0.1:${port}"
  }
}
```

Supported templates are `${id}`, `${namespace}`, `${port}`, `${worktree}`, `${runtimeDir}`, `${tempDir}`, `${dbNamespace}`, `${redisPrefix}`, and `${composeProject}`. Reserved `AGENT_WORKSPACE_*` variables cannot be overridden.

This is namespace isolation, not virtualization. A port can still be claimed after its availability check, and an application with hard-coded ports, database names, Redis keys, Compose `container_name`, or shared build output must be configured to consume the profile. If it cannot be configured, declare the resource `--exclusive` and run those tasks serially. The CLI does not provision or destroy external databases or Redis instances.

## Safety model

- Task records live in `<git-common-dir>/agent-workspace/tasks` and are shared by linked worktrees.
- `submit` requires a clean worker and rejects undeclared paths, merge commits, and no-op tasks.
- Exclusive resource names prevent known hotspots from being scheduled concurrently.
- `integrate` requires the original main worktree to be clean and uses an atomic lock file.
- Cherry-pick conflicts are aborted. Failed checks restore the integration HEAD to its prior commit.
- `cleanup` refuses to discard non-integrated work unless `--force` is explicit.

This prevents physical workspace conflicts and catches declared scope violations. It cannot prove that independently edited code is semantically compatible; repository-wide tests and contract checks remain the integration gate.

## Releasing

Prepare a stable version in the pull request:

```sh
npm run release:prepare -- patch
```

Use `minor`, `major`, or an explicit `x.y.z` version when appropriate. Commit the resulting `package.json` change with the rest of the pull request.

After the pull request merges, the publish workflow examines the version on `main`. If that version already has a tag, the merge is not a release and the workflow exits successfully. For a new version it runs the complete release gates, creates an annotated tag named exactly `x.y.z`, publishes the npm package through trusted publishing, and creates a GitHub Release with generated notes.

The workflow is restartable. If a failed run already created the tag at the merge commit, rerunning the same workflow continues with any missing npm publish or GitHub Release steps. To resume an older version explicitly:

```sh
gh workflow run publish.yml --ref main -f version=0.1.3
```

## Development

```sh
git clone https://github.com/Hirate99/agent-workspace.git
cd agent-workspace
bun install --frozen-lockfile
npm run build
bun run typecheck
bun test
bun run test:coverage
bun run test:package
```

The end-to-end tests create disposable Git repositories and exercise real worktrees, concurrent TCP services, npm preparation without Bun, per-task temporary directories and namespaces, occupied ports, child exit codes, concurrent submission, serialized integration, commit conflicts, scope enforcement, rollback, and cleanup behavior. The package smoke test builds the actual npm tarball, checks its bundled Skill contents, installs it into a clean consumer project, and invokes the installed CLI with Node.js and no Bun. Coverage fails below 90% for lines, functions, or statements. GitHub Actions runs the same gates on Windows and Ubuntu.
