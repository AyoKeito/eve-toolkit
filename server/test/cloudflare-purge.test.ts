import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import {
  canonicalMissionsPurgePrefixes,
  canonicalPurgePrefixes,
  canonicalPurgeStaticUrls,
  canonicalPurgeUrls,
  purgeCloudflare,
  purgeCloudflareWithRetries,
  purgeMissionsAgentsEdge,
  readLastCloudflarePurge,
  recordCloudflarePurge
} from "../src/lib/cloudflare-purge.js";

const originalAppUrl = process.env.APP_URL;
const appUrlUnderTest = originalAppUrl?.trim() || "https://app.example.test";

function lpBaseForTest(appUrl: string): string {
  const parsed = new URL(appUrl);
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/lp") ? path : `${path}/lp`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function siteOriginForTest(appUrl: string): string {
  const parsed = new URL(appUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

// The query-less static asset paths, spanning all four namespaces, that deploys change.
// App shells are purged at their canonical navigated URLs ("/", "/lp/", "/missions/",
// "/missions/browse"), not at "*/index.html" (different Cloudflare cache keys).
const STATIC_PURGE_PATHS = [
  "/",
  "/favicon.ico",
  "/lp/",
  "/lp/about.html",
  "/lp/favicon.svg",
  "/lp/lp.css",
  "/lp/theme.css",
  "/lp/app.js",
  "/lp/ui-model.js",
  "/lp/diagnostics.js",
  "/shared/diagnostics.js",
  "/shared/utils.js",
  "/shared/base.css",
  "/agents/",
  "/agents/app.js",
  "/agents/style.css",
  "/missions/",
  "/missions/browse",
  "/missions/burners",
  "/missions/style.css",
  "/missions/detail.css",
  "/missions/burners.css",
  "/missions/app.js",
  "/missions/arc-meta.js",
  "/missions/beta-notice.js",
  "/missions/browse.js",
  "/missions/burners.js",
  "/missions/burners-util.js",
  "/missions/arc.js",
  "/missions/arc-graph.js",
  "/missions/arc-order.js",
  "/missions/combat-stats.js",
  "/missions/detail.js",
  "/missions/diagnostics.js",
  "/missions/dom-util.js",
  "/missions/fit-profile.js",
  "/missions/formatters.js",
  "/missions/missions-ewar.js",
  "/missions/missions-util.js"
];

function withAppUrl<T>(appUrl: string, fn: () => T): T {
  process.env.APP_URL = appUrl;
  try {
    return fn();
  } finally {
    if (originalAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = originalAppUrl;
    }
  }
}

test("APP_URL points at the site origin instead of the LP subpath", () => {
  assert.notEqual(new URL(appUrlUnderTest).pathname.replace(/\/+$/, ""), "/lp");
});

test("Cloudflare purge no-ops when zone or token is missing", async () => {
  let called = false;
  const result = await purgeCloudflare(["https://example.test/a"], {
    zoneId: "",
    apiToken: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected fetch");
    }
  });

  assert.deepEqual(result, { status: "skipped", reason: "missing_zone_id" });
  assert.equal(called, false);

  const tokenResult = await purgeCloudflare(["https://example.test/a"], {
    zoneId: "zone-123",
    apiToken: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected fetch");
    }
  });

  assert.deepEqual(tokenResult, { status: "skipped", reason: "missing_api_token" });
  assert.equal(called, false);
});

test("Cloudflare purge surfaces the API error body for diagnosis", async () => {
  const result = await purgeCloudflare(["https://example.test/a"], {
    zoneId: "zone-123",
    apiToken: "token-abc",
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }), { status: 400 })
  });

  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.statusCode, 400);
  assert.match(result.status === "error" ? result.error ?? "" : "", /Invalid API Token/);
});

test("purgeCloudflareWithRetries retries a transient failure and succeeds", async () => {
  let calls = 0;
  const slept: number[] = [];
  const result = await purgeCloudflareWithRetries(
    { prefixes: ["app.example.test/lp/api/"] },
    {
      zoneId: "zone-123",
      apiToken: "token-abc",
      fetchImpl: async () => {
        calls += 1;
        // Fail the first two attempts (network 5xx), succeed on the third.
        return calls < 3 ? new Response("{}", { status: 502 }) : new Response("{}", { status: 200 });
      }
    },
    { attempts: 3, baseDelayMs: 0, sleep: async (ms) => { slept.push(ms); } }
  );

  assert.equal(calls, 3, "retried until success");
  assert.equal(slept.length, 2, "backed off before each retry");
  assert.equal(result.status, "ok");
});

test("purgeCloudflareWithRetries does not retry a config-skipped purge", async () => {
  let calls = 0;
  const result = await purgeCloudflareWithRetries(
    { prefixes: ["app.example.test/lp/api/"] },
    { zoneId: "", apiToken: "token-abc", fetchImpl: async () => { calls += 1; return new Response("{}", { status: 200 }); } },
    { attempts: 5, baseDelayMs: 0 }
  );

  assert.equal(result.status, "skipped");
  assert.equal(calls, 0, "skipped (missing zone) is not a transient error — no fetch, no retry");
});

test("purgeCloudflareWithRetries returns the last error after exhausting attempts", async () => {
  let calls = 0;
  const result = await purgeCloudflareWithRetries(
    { prefixes: ["app.example.test/lp/api/"] },
    { zoneId: "zone-123", apiToken: "token-abc", fetchImpl: async () => { calls += 1; return new Response("nope", { status: 503 }); } },
    { attempts: 3, baseDelayMs: 0, sleep: async () => {} }
  );

  assert.equal(calls, 3);
  assert.equal(result.status, "error");
});

test("recordCloudflarePurge persists the last result and logs every outcome", () => {
  const db = new Database(":memory:");
  migrate(db);
  const now = new Date("2026-06-07T12:00:00.000Z");
  const logged: string[] = [];
  const warned: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line: string) => logged.push(String(line));
  console.warn = (line: string) => warned.push(String(line));

  try {
    recordCloudflarePurge(db, { status: "skipped", reason: "missing_api_token" }, now);
    assert.deepEqual(readLastCloudflarePurge(db), {
      status: "skipped",
      status_code: null,
      error: null,
      reason: "missing_api_token",
      at: "2026-06-07T12:00:00.000Z"
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /"component":"cloudflare-purge"/);
    assert.match(logged[0], /"reason":"missing_api_token"/);

    recordCloudflarePurge(db, { status: "error", statusCode: 400, error: "Invalid API Token" }, now);
    assert.deepEqual(readLastCloudflarePurge(db), {
      status: "error",
      status_code: 400,
      error: "Invalid API Token",
      reason: null,
      at: "2026-06-07T12:00:00.000Z"
    });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /"error":"Invalid API Token"/);

    recordCloudflarePurge(db, { status: "ok", statusCode: 200 }, now);
    assert.deepEqual(readLastCloudflarePurge(db), {
      status: "ok",
      status_code: 200,
      error: null,
      reason: null,
      at: "2026-06-07T12:00:00.000Z"
    });
    assert.equal(logged.length, 2);

    db.close();
    const record = recordCloudflarePurge(db, { status: "ok", statusCode: 200 }, now);
    assert.equal(record.status, "ok");
    assert.equal(logged.length, 3);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    if (db.open) db.close();
  }
});

test("Cloudflare purge posts canonical URL payload and never throws on API failure", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const lpBase = lpBaseForTest(appUrlUnderTest);
  const result = await withAppUrl(appUrlUnderTest, () => {
    return purgeCloudflare(canonicalPurgeUrls().slice(0, 1), {
      zoneId: "zone-123",
      apiToken: "token-abc",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
    });
  });

  assert.equal(result.status, "error");
  assert.equal(requests[0].url, "https://api.cloudflare.com/client/v4/zones/zone-123/purge_cache");
  assert.equal(requests[0].init.method, "POST");
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "Bearer token-abc");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    files: [`${lpBase}/api/offers/top?n=100`]
  });
});

test("canonical Cloudflare purge URLs come from APP_URL and cover pre-rendered endpoints", () => {
  const lpBase = lpBaseForTest(appUrlUnderTest);
  const origin = siteOriginForTest(appUrlUnderTest);
  withAppUrl(appUrlUnderTest, () => {
    assert.deepEqual(canonicalPurgeUrls(), [
      `${lpBase}/api/offers/top?n=100`,
      `${lpBase}/api/offers/top?n=200`,
      `${lpBase}/api/offers/top?n=500`,
      `${lpBase}/api/offers/top.csv?n=100`,
      `${lpBase}/api/corps`,
      ...STATIC_PURGE_PATHS.map((path) => `${origin}${path}`)
    ]);
  });
});

test("canonical static purge URLs cover query-less lp, shared, missions, and agents assets changed by deploys", () => {
  const origin = siteOriginForTest(appUrlUnderTest);
  withAppUrl(appUrlUnderTest, () => {
    const urls = canonicalPurgeStaticUrls();
    assert.deepEqual(urls, STATIC_PURGE_PATHS.map((path) => `${origin}${path}`));
    // No ?v= survives anywhere in the purge targets.
    assert.ok(urls.every((url) => !url.includes("?v=")), "static purge URLs must be query-less");
    // App shells are purged at their canonical navigated URLs, not the /lp//missions/ index files.
    assert.ok(urls.includes(`${origin}/`), "must purge the landing hub at the canonical / URL");
    assert.ok(urls.includes(`${origin}/lp/`), "must purge the LP shell at its canonical /lp/ URL");
    assert.ok(urls.includes(`${origin}/agents/`), "must purge the agents shell at its canonical /agents/ URL");
    assert.ok(urls.includes(`${origin}/missions/`), "must purge the missions shell at /missions/");
    assert.ok(urls.includes(`${origin}/missions/browse`), "must purge the browse shell at /missions/browse");
    assert.ok(!urls.includes(`${origin}/lp/index.html`), "/lp/index.html is not the navigated key");
    assert.ok(!urls.includes(`${origin}/missions/index.html`), "/missions/index.html is not the navigated key");
    assert.ok(!urls.includes(`${origin}/agents/index.html`), "/agents/index.html is not the navigated key");
  });
});

test("Cloudflare file purges above the 30-URL cap are split into sequential chunked requests", async () => {
  const urls = Array.from({ length: 32 }, (_, index) => `https://example.test/asset-${index}.js`);
  const requestBodies: Array<{ files: string[] }> = [];

  const result = await purgeCloudflare(urls, {
    zoneId: "zone-123",
    apiToken: "token-abc",
    fetchImpl: async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as { files: string[] });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
  });

  assert.equal(result.status, "ok");
  assert.equal(requestBodies.length, 2, "32 URLs must be purged in two requests");
  assert.deepEqual(requestBodies[0].files, urls.slice(0, 30));
  assert.deepEqual(requestBodies[1].files, urls.slice(30));
  for (const body of requestBodies) {
    assert.ok(body.files.length <= 30, `each purge request must stay <= 30 URLs, got ${body.files.length}`);
  }
  // Every entry in the real static purge list must reach Cloudflare — a silent slice would
  // leave entries 31+ edge-stale forever.
  assert.equal(
    requestBodies.flatMap((body) => body.files).length,
    urls.length,
    "every URL must be included across the chunked requests"
  );
});

test("Cloudflare chunked file purge stops at the first failing chunk and reports its error", async () => {
  const urls = Array.from({ length: 61 }, (_, index) => `https://example.test/asset-${index}.js`);
  let calls = 0;

  const result = await purgeCloudflare(urls, {
    zoneId: "zone-123",
    apiToken: "token-abc",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), { status: 500 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
  });

  assert.equal(calls, 2, "the third chunk must not be sent after a failure");
  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.statusCode, 500);
});

test("canonical Cloudflare purge prefix targets the LP API path only", () => {
  const lpApi = new URL(`${lpBaseForTest(appUrlUnderTest)}/api/`);
  withAppUrl(appUrlUnderTest, () => {
    assert.deepEqual(canonicalPurgePrefixes(), [`${lpApi.host}${lpApi.pathname}`]);
  });
});

test("canonical missions purge prefix targets the bare /api/ root, distinct from the LP API prefix", () => {
  const apiPrefix = new URL(`${siteOriginForTest(appUrlUnderTest)}/api/`);
  withAppUrl(appUrlUnderTest, () => {
    assert.deepEqual(canonicalMissionsPurgePrefixes(), [`${apiPrefix.host}${apiPrefix.pathname}`]);
    // The missions/agents API lives under /api/, the LP API under /lp/api/ — the import purge must
    // not collide with (or skip) the compute purge's prefix.
    assert.notDeepEqual(canonicalMissionsPurgePrefixes(), canonicalPurgePrefixes());
  });
});

test("purgeMissionsAgentsEdge purges the /api/ prefix and persists the result for a standalone import", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const apiPrefix = new URL(`${siteOriginForTest(appUrlUnderTest)}/api/`);
  const bodies: unknown[] = [];

  const result = await purgeMissionsAgentsEdge(db, appUrlUnderTest, {
    zoneId: "zone-123",
    apiToken: "token-abc",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(bodies[0], { prefixes: [`${apiPrefix.host}${apiPrefix.pathname}`] });
  assert.equal(readLastCloudflarePurge(db)?.status, "ok");

  db.close();
});

test("purgeMissionsAgentsEdge no-ops (and records the skip) when CF credentials are missing", async () => {
  const db = new Database(":memory:");
  migrate(db);
  let fetched = false;

  const result = await purgeMissionsAgentsEdge(db, appUrlUnderTest, {
    zoneId: "",
    apiToken: "",
    fetchImpl: async () => {
      fetched = true;
      throw new Error("unexpected fetch");
    }
  });

  assert.equal(result.status, "skipped");
  assert.equal(fetched, false, "a missing-credential import purge must not hit the network");
  assert.equal(readLastCloudflarePurge(db)?.status, "skipped");

  db.close();
});

test("Cloudflare prefix purge falls back to purge_everything when prefix purge is unavailable for the zone plan", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  // CF error code 9035 signals that prefix purge is an Enterprise-only feature
  // not available on this zone's plan.
  const prefixErrorBody = JSON.stringify({
    success: false,
    errors: [{ code: 9035, message: "This zone does not have access to purge by prefix" }]
  });

  const result = await withAppUrl(appUrlUnderTest, () =>
    purgeCloudflare({ prefixes: canonicalPurgePrefixes() }, {
      zoneId: "zone-123",
      apiToken: "token-abc",
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ url: String(url), body });
        if ("prefixes" in body) {
          return new Response(prefixErrorBody, { status: 400 });
        }
        // Fallback purge_everything succeeds.
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    })
  );

  // Two requests: first the prefix attempt, then the purge_everything fallback.
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, { prefixes: canonicalPurgePrefixes() });
  assert.deepEqual(requests[1].body, { purge_everything: true });
  // Result reflects the successful fallback and is tagged for observability.
  assert.equal(result.status, "ok");
  assert.equal((result as { method?: string }).method, "purge_everything-fallback");
});

test("Cloudflare prefix purge fallback records method in the persisted purge record", async () => {
  const db = new Database(":memory:");
  migrate(db);

  const record = recordCloudflarePurge(db, { status: "ok", statusCode: 200, method: "purge_everything-fallback" });
  assert.equal(record.method, "purge_everything-fallback");
  const persisted = readLastCloudflarePurge(db);
  assert.equal(persisted?.method, "purge_everything-fallback");

  db.close();
});

test("Cloudflare purge can use prefix payloads", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const lpApi = new URL(`${lpBaseForTest(appUrlUnderTest)}/api/`);
  const result = await withAppUrl(appUrlUnderTest, () => {
    return purgeCloudflare({ prefixes: canonicalPurgePrefixes() }, {
      zoneId: "zone-123",
      apiToken: "token-abc",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    });
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    prefixes: [`${lpApi.host}${lpApi.pathname}`]
  });
});
