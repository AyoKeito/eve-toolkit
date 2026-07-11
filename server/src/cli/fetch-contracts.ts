import { fetchContracts } from "../fetchers/esi-contracts.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob("fetch-contracts", async (db) => await fetchContracts(db));
