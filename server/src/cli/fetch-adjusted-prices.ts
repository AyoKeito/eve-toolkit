import { fetchAdjustedPrices } from "../fetchers/esi-adjusted-prices.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob("fetch-adjusted-prices", async (db) => {
  const count = await fetchAdjustedPrices(db);
  return { count };
});
