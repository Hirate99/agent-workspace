#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateReleaseVersion(value) {
  const match = STABLE_VERSION.exec(value);
  if (!match) {
    throw new Error(`release version must be stable SemVer (x.y.z): ${value}`);
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`release version components must be safe integers: ${value}`);
  }
  return parts;
}

export function resolveReleaseVersion(current, requested) {
  const currentParts = validateReleaseVersion(current);
  if (requested === "patch") {
    return formatVersion([currentParts[0], currentParts[1], increment(currentParts[2])]);
  }
  if (requested === "minor") {
    return formatVersion([currentParts[0], increment(currentParts[1]), 0]);
  }
  if (requested === "major") {
    return formatVersion([increment(currentParts[0]), 0, 0]);
  }

  const requestedParts = validateReleaseVersion(requested);
  if (compareVersions(requestedParts, currentParts) <= 0) {
    throw new Error(`release version ${requested} must be greater than current version ${current}`);
  }
  return requested;
}

export async function preparePackageVersion(packagePath, requested) {
  const packageJson = await readPackage(packagePath);
  const next = resolveReleaseVersion(packageJson.version, requested);
  packageJson.version = next;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return next;
}

export async function checkPackageVersion(packagePath, expected) {
  validateReleaseVersion(expected);
  const packageJson = await readPackage(packagePath);
  if (packageJson.version !== expected) {
    throw new Error(
      `package version ${packageJson.version} does not match release version ${expected}`,
    );
  }
  return expected;
}

async function readPackage(packagePath) {
  let value;
  try {
    value = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid package JSON at ${packagePath}: ${error.message}`);
    }
    throw error;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`package JSON at ${packagePath} must contain a string version`);
  }
  return value;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function formatVersion(parts) {
  return parts.join(".");
}

function increment(value) {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("release version component cannot be incremented safely");
  }
  return value + 1;
}

export async function runReleaseCommand(argv, output = console.log) {
  const [command, value, packageArgument, ...extra] = argv;
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(" ")}`);
  const packagePath = resolve(packageArgument ?? "package.json");

  if (command === "prepare") {
    if (!value) throw new Error("usage: release.mjs prepare <patch|minor|major|x.y.z> [package]");
    output(await preparePackageVersion(packagePath, value));
    return;
  }
  if (command === "check") {
    if (!value) throw new Error("usage: release.mjs check <x.y.z> [package]");
    output(await checkPackageVersion(packagePath, value));
    return;
  }
  if (command === "validate") {
    if (!value || packageArgument) throw new Error("usage: release.mjs validate <x.y.z>");
    validateReleaseVersion(value);
    output(value);
    return;
  }
  throw new Error("usage: release.mjs <prepare|check|validate> ...");
}

const entryPoint = process.argv[1];
if (entryPoint && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))) {
  runReleaseCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
