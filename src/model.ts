import { posix } from "node:path";

export type TaskStatus = "active" | "submitted" | "integrated" | "cleaned";

export interface IntegrationRecord {
  before: string;
  after: string;
  checks: string[];
}

export interface TaskState {
  version: 1;
  id: string;
  repo: string;
  commonDir: string;
  base: string;
  branch: string;
  worktree: string;
  runtimeDir: string;
  namespace: string;
  port: number;
  scopes: string[];
  exclusive: string[];
  status: TaskStatus;
  createdAt: string;
  submittedAt?: string;
  result?: string;
  changedFiles?: string[];
  integratedAt?: string;
  integration?: IntegrationRecord;
  cleanedAt?: string;
}

const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

export function assertTaskId(id: string): void {
  if (!TASK_ID.test(id)) {
    throw new Error(
      `invalid task id "${id}"; use 1-64 letters, digits, underscores, or hyphens`,
    );
  }
}

export function normalizeScope(input: string): string {
  const slashPath = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = posix.normalize(slashPath);
  if (
    !slashPath ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`scope must be repository-relative: "${input}"`);
  }
  return normalized.replace(/\/$/, "") || ".";
}

export function isPathInScope(file: string, scope: string): boolean {
  const normalizedFile = file.replaceAll("\\", "/");
  return scope === "." || normalizedFile === scope || normalizedFile.startsWith(`${scope}/`);
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}
