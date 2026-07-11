import { fetchPrices } from "../fetchers/esi-prices.js";
import { argValue, intArgOpt, usage } from "./args.js";
import { runCliJob } from "./run-cli-job.js";

const tier = argValue(process.argv.slice(2), "tier") === "hot" ? "hot" : "cold";
const limit = intArgOpt(process.argv.slice(2), "limit", () =>
  usage("Usage: npm run fetch-prices -- [--tier=hot|cold] [--limit=N]")
);

await runCliJob(`fetch-prices:${tier}`, async (db) => {
  const count = await fetchPrices(db, tier, limit);
  return { tier, count };
});
