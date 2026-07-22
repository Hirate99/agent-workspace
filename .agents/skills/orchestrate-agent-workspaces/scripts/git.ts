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
  const process = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    process.exited,
    stdout,
    stderr,
  ]);
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
