import { fetchHistory } from "../fetchers/esi-history.js";
import { intArgOpt, usage } from "./args.js";
import { runCliJob } from "./run-cli-job.js";

const limit = intArgOpt(process.argv.slice(2), "limit", () =>
  usage("Usage: npm run fetch-history -- [--limit=N]")
);

await runCliJob("fetch-history", async (db) => ({ history: await fetchHistory(db, limit) }));
