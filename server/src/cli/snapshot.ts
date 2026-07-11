import { loadConfig } from "../config.js";
import { runSnapshot } from "../jobs/snapshot.js";
import { runCliJob } from "./run-cli-job.js";

const config = loadConfig();

await runCliJob(
  "snapshot",
  async (db) => {
    const { rows, backup } = await runSnapshot(db, config.dbPath);
    return { calc_prev: rows, backup };
  },
  { dbPath: config.dbPath }
);
