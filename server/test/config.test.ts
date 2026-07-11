import assert from "node:assert/strict";
import test from "node:test";
import {
  backupRetentionDays,
  computeDebounceMs,
  esiCacheMaxRows,
  esiFetchAgentConnections,
  esiFetchAgentPipelining,
  esiFetchConcurrency,
  loadConfig
} from "../src/config.js";

test("loadConfig defaults the server port to 3004", () => {
  const originalPort = process.env.PORT;
  delete process.env.PORT;

  try {
    assert.equal(loadConfig().port, 3004);
  } finally {
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  }
});

test("loadConfig still honors an explicit PORT override", () => {
  const originalPort = process.env.PORT;
  process.env.PORT = "4555";

  try {
    assert.equal(loadConfig().port, 4555);
  } finally {
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  }
});

for (const value of ["not-a-port", "0", "65536"]) {
  test(`loadConfig rejects invalid PORT=${value}`, () => {
    const originalPort = process.env.PORT;
    process.env.PORT = value;

    try {
      assert.throws(() => loadConfig(), /Invalid PORT/);
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });
}

test("backupRetentionDays defaults to 30 and clamps overrides", () => {
  const original = process.env.BACKUP_RETENTION_DAYS;

  try {
    delete process.env.BACKUP_RETENTION_DAYS;
    assert.equal(backupRetentionDays(), 30);

    process.env.BACKUP_RETENTION_DAYS = "90";
    assert.equal(backupRetentionDays(), 90);

    process.env.BACKUP_RETENTION_DAYS = "0";
    assert.equal(backupRetentionDays(), 1);

    process.env.BACKUP_RETENTION_DAYS = "999";
    assert.equal(backupRetentionDays(), 365);
  } finally {
    if (original === undefined) {
      delete process.env.BACKUP_RETENTION_DAYS;
    } else {
      process.env.BACKUP_RETENTION_DAYS = original;
    }
  }
});

test("esiCacheMaxRows defaults to 20000 and honors positive overrides", () => {
  const original = process.env.ESI_CACHE_MAX_ROWS;

  try {
    delete process.env.ESI_CACHE_MAX_ROWS;
    assert.equal(esiCacheMaxRows(), 20_000);

    process.env.ESI_CACHE_MAX_ROWS = "10";
    assert.equal(esiCacheMaxRows(), 10);

    process.env.ESI_CACHE_MAX_ROWS = "0";
    assert.equal(esiCacheMaxRows(), 20_000);

    process.env.ESI_CACHE_MAX_ROWS = "not-a-number";
    assert.equal(esiCacheMaxRows(), 20_000);
  } finally {
    if (original === undefined) {
      delete process.env.ESI_CACHE_MAX_ROWS;
    } else {
      process.env.ESI_CACHE_MAX_ROWS = original;
    }
  }
});

test("ESI fetch tuning defaults and clamps overrides", () => {
  const originalConcurrency = process.env.ESI_FETCH_CONCURRENCY;
  const originalConnections = process.env.ESI_FETCH_AGENT_CONNECTIONS;
  const originalPipelining = process.env.ESI_FETCH_AGENT_PIPELINING;

  try {
    delete process.env.ESI_FETCH_CONCURRENCY;
    delete process.env.ESI_FETCH_AGENT_CONNECTIONS;
    delete process.env.ESI_FETCH_AGENT_PIPELINING;
    assert.equal(esiFetchConcurrency(), 15);
    assert.equal(esiFetchAgentConnections(), 50);
    assert.equal(esiFetchAgentPipelining(), 1);

    process.env.ESI_FETCH_CONCURRENCY = "99";
    process.env.ESI_FETCH_AGENT_CONNECTIONS = "0";
    process.env.ESI_FETCH_AGENT_PIPELINING = "20";
    assert.equal(esiFetchConcurrency(), 50);
    assert.equal(esiFetchAgentConnections(), 1);
    assert.equal(esiFetchAgentPipelining(), 10);

    process.env.ESI_FETCH_CONCURRENCY = "not-a-number";
    assert.equal(esiFetchConcurrency(), 15);
  } finally {
    if (originalConcurrency === undefined) delete process.env.ESI_FETCH_CONCURRENCY;
    else process.env.ESI_FETCH_CONCURRENCY = originalConcurrency;
    if (originalConnections === undefined) delete process.env.ESI_FETCH_AGENT_CONNECTIONS;
    else process.env.ESI_FETCH_AGENT_CONNECTIONS = originalConnections;
    if (originalPipelining === undefined) delete process.env.ESI_FETCH_AGENT_PIPELINING;
    else process.env.ESI_FETCH_AGENT_PIPELINING = originalPipelining;
  }
});

test("computeDebounceMs defaults to 30 seconds and clamps overrides", () => {
  const original = process.env.COMPUTE_DEBOUNCE_MS;

  try {
    delete process.env.COMPUTE_DEBOUNCE_MS;
    assert.equal(computeDebounceMs(), 30_000);

    process.env.COMPUTE_DEBOUNCE_MS = "-1";
    assert.equal(computeDebounceMs(), 0);

    process.env.COMPUTE_DEBOUNCE_MS = "600000";
    assert.equal(computeDebounceMs(), 300_000);

    process.env.COMPUTE_DEBOUNCE_MS = "not-a-number";
    assert.equal(computeDebounceMs(), 30_000);
  } finally {
    if (original === undefined) {
      delete process.env.COMPUTE_DEBOUNCE_MS;
    } else {
      process.env.COMPUTE_DEBOUNCE_MS = original;
    }
  }
});
