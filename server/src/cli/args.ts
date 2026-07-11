/**
 * Shared CLI argument helpers for server/src/cli/* entry-points.
 * Moved from scrape-missions.ts (where they were file-local).
 */

export function argValue(args: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export function intArg(
  args: string[],
  name: string,
  fallback: number | null = null,
  onInvalid: () => never = () => {
    throw new Error(`--${name} must be an integer`);
  }
): number | null {
  const value = argValue(args, name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) onInvalid();
  return parsed;
}

/**
 * Like intArg but returns undefined (rather than null) when the flag is absent,
 * matching the `intArg(...) === null ? undefined : raw` coercion used by CLI
 * entry-points that pass the parsed value straight into an optional argument.
 */
export function intArgOpt(
  args: string[],
  name: string,
  onInvalid: () => never = () => {
    throw new Error(`--${name} must be an integer`);
  }
): number | undefined {
  const value = intArg(args, name, null, onInvalid);
  return value === null ? undefined : value;
}

/** Print a usage message to stderr and exit with code 2 (CLI arg error). */
export function usage(message: string): never {
  console.error(message);
  process.exit(2);
}
