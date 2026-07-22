import { spawn } from "node:child_process";

export interface RunOptions {
  allowFailure?: boolean;
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  command: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(public readonly result: RunResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || "command failed";
    super(`${quoteCommand(result.command)} (${result.exitCode}): ${detail}`);
    this.name = "CommandError";
  }
}

function quoteCommand(command: string[]): string {
  return command
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export async function run(
  command: string[],
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdoutText = "";
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutText += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const result = { command, cwd, exitCode, stdout: stdoutText, stderr: stderrText };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new CommandError(result);
  }
  return result;
}

export function git(
  cwd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return run(["git", ...args], cwd, {
    ...options,
    env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
  });
}

export function runShell(command: string, cwd: string): Promise<RunResult> {
  const shell =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["/bin/sh", "-lc", command];
  return run(shell, cwd);
}
