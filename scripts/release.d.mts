export function validateReleaseVersion(value: string): [number, number, number];

export function resolveReleaseVersion(current: string, requested: string): string;

export function preparePackageVersion(packagePath: string, requested: string): Promise<string>;

export function checkPackageVersion(packagePath: string, expected: string): Promise<string>;

export function runReleaseCommand(
  argv: string[],
  output?: (value: string) => void,
): Promise<void>;
