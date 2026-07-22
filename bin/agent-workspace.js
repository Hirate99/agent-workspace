#!/usr/bin/env node

import { main } from "../.agents/skills/orchestrate-agent-workspaces/dist/cli.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (process.env.AGENT_WORKSPACE_DEBUG && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
});