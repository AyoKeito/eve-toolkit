/**
 * Minimal CLI argument helper for .mjs scripts.
 *
 * Usage:
 *   const { arg } = makeArgParser(process.argv.slice(2));
 *   const inPath = arg("in");          // --in=<value> or null
 *   const sde   = arg("sde", "data/sde/sqlite-latest.sqlite");
 *
 * Both enrich-missions.mjs and repair-npc-stats.mjs already inline this
 * pattern byte-for-byte; they can adopt this helper when next touched.
 */

/**
 * @param {string[]} argv - typically process.argv.slice(2)
 * @returns {{ arg: (name: string, fallback?: string|null) => string|null }}
 */
export function makeArgParser(argv) {
  /**
   * @param {string} name
   * @param {string|null} [fallback=null]
   * @returns {string|null}
   */
  function arg(name, fallback = null) {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  }
  return { arg };
}
