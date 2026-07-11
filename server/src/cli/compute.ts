import { recomputeAndPersist, waitForPendingCloudflarePurge } from "../calc/ratio.js";
import { clearComputeDirtyIfUnchanged, readComputeDirty } from "../lib/compute-generation.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob(
  "compute",
  async (db) => {
    const observedDirty = readComputeDirty(db);
    const rows = recomputeAndPersist(db);
    if (observedDirty) clearComputeDirtyIfUnchanged(db, observedDirty.seq);
    return { calc: rows };
  },
  { postLock: waitForPendingCloudflarePurge }
);
