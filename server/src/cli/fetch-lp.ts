import { fetchLpOffers } from "../fetchers/esi-lp.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob("fetch-lp", async (db) => ({ offers: await fetchLpOffers(db) }));
