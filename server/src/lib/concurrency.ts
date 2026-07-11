/**
 * General-purpose bounded-concurrency mapper.
 *
 * Runs `worker` for each item in `items` with at most `concurrency` workers
 * active at once. Results are returned in the same order as `items`.
 * Fail-fast: if any worker throws, the first error is re-thrown once all
 * active workers have settled.
 *
 * Moved from fetchers/esi-prices.ts where it was file-local.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (failed) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index]!, index);
        } catch (error) {
          failed = true;
          firstError = error;
          return;
        }
      }
    })
  );
  if (failed) throw firstError;
  return results;
}
