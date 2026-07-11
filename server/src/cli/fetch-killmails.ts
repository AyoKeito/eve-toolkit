import { fetchKillmails } from "../fetchers/killmails.js";
import { argValue, intArgOpt, usage } from "./args.js";
import { runCliJob } from "./run-cli-job.js";

const usageMessage = "Usage: npm run fetch-killmails -- [--date=YYYY-MM-DD] [--backfill=N]";

const args = process.argv.slice(2);
const date = argValue(args, "date");
if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) usage(usageMessage);
const backfillDays = intArgOpt(args, "backfill", () => usage(usageMessage));

await runCliJob("fetch-killmails", async (db) =>
  fetchKillmails(db, {
    date: date ?? undefined,
    backfillDays
  })
);
