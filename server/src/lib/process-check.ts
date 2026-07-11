import fs from "node:fs";

/**
 * Returns true if a process with the given pid is alive. `process.kill(pid, 0)`
 * sends no signal but performs the permission/existence check: ESRCH means gone,
 * while EPERM means the process exists but is owned by another user — both count
 * as "still running" for lock-ownership purposes.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Reads a process's start time (field 22 of `/proc/<pid>/stat`) as an opaque
 * token, or null if it can't be read. Used to detect pid reuse: a recycled pid
 * has a different start time than the one recorded when a lock was taken.
 *
 * The comm field (field 2) is wrapped in parens and may itself contain ')' and
 * spaces, so the end of comm is located by the last ") " — the close-paren is
 * always followed by a space before the single-character state field, and no
 * later field contains a paren, so this boundary is unambiguous.
 */
export function processStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(") ");
    if (endOfCommand === -1) return null;
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}
