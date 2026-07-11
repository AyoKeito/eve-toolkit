import assert from "node:assert/strict";
import test from "node:test";
import { parseOfferQuery } from "../src/api/query.js";

test("parseOfferQuery accepts separate ISK/LP sort key", () => {
  const parsed = parseOfferQuery({ query: { sortBy: "iskPerLp", sortDir: "desc" } } as never);

  assert.equal(parsed.sortBy, "iskPerLp");
  assert.equal(parsed.sortDir, undefined);
});

test("parseOfferQuery accepts volume-per-day sort key", () => {
  const parsed = parseOfferQuery({ query: { sortBy: "volume" } } as never);

  assert.equal(parsed.sortBy, "volume");
});

test("parseOfferQuery accepts buy, sell, and highest valuation basis values", () => {
  assert.equal(parseOfferQuery({ query: { basis: "buy" } } as never).basis, "instantSell");
  assert.equal(parseOfferQuery({ query: { basis: "sell" } } as never).basis, "patientSell");
  assert.equal(parseOfferQuery({ query: { basis: "highest" } } as never).basis, "best");
  assert.equal(parseOfferQuery({ query: { basis: "best" } } as never).basis, "best");
});

test("parseOfferQuery ignores client sort direction", () => {
  for (const sortDir of ["asc", "desc"]) {
    const parsed = parseOfferQuery({ query: { sortBy: "iskPerHour", sortDir } } as never);

    assert.equal(parsed.sortBy, "iskPerHour");
    assert.equal(parsed.sortDir, undefined, sortDir);
  }
});

test("parseOfferQuery hides vanity rows by default and accepts explicit opt-out", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const disabled = parseOfferQuery({ query: { hideVanity: "false" } } as never);

  assert.equal((defaulted as { hideVanity?: boolean }).hideVanity, true);
  assert.equal((disabled as { hideVanity?: boolean }).hideVanity, false);
});

test("parseOfferQuery hides suspicious rows by default and accepts explicit opt-out", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const disabled = parseOfferQuery({ query: { hideSuspicious: "false" } } as never);

  assert.equal((defaulted as { hideSuspicious?: boolean }).hideSuspicious, true);
  assert.equal((disabled as { hideSuspicious?: boolean }).hideSuspicious, false);
});

test("parseOfferQuery hides corporations without level 4 or 5 Security agents by default and accepts opt-out", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const disabled = parseOfferQuery({ query: { hideNoSecurity: "false" } } as never);

  assert.equal((defaulted as { hideNoSecurity?: boolean }).hideNoSecurity, true);
  assert.equal((disabled as { hideNoSecurity?: boolean }).hideNoSecurity, false);
});

test("parseOfferQuery excludes special LP stores by default and accepts explicit opt-in", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const enabled = parseOfferQuery({ query: { includeSpecial: "true" } } as never);

  assert.equal(defaulted.includeSpecial, undefined);
  assert.equal(enabled.includeSpecial, true);
});

test("parseOfferQuery groups duplicate store rows by default and accepts explicit opt-out", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const enabled = parseOfferQuery({ query: { showDuplicateStores: "true" } } as never);

  assert.equal(defaulted.showDuplicateStores, undefined);
  assert.equal(enabled.showDuplicateStores, true);
});

test("parseOfferQuery defaults to nullsec, which includes legacy wormhole rows", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const legacyWormhole = parseOfferQuery({ query: { maxRiskTier: "WORMHOLE" } } as never);

  assert.equal(defaulted.maxRiskTier, "NULLSEC");
  assert.equal(legacyWormhole.maxRiskTier, "NULLSEC");
});

test("parseOfferQuery accepts level 5 mission visibility modes", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const only = parseOfferQuery({ query: { level5Missions: "only" } } as never);
  const hidden = parseOfferQuery({ query: { level5Missions: "hide" } } as never);
  const shown = parseOfferQuery({ query: { level5Missions: "show" } } as never);
  const legacyEnabled = parseOfferQuery({ query: { hasLevel5Agent: "true" } } as never);

  assert.equal(defaulted.level5Missions, "show");
  assert.equal(only.level5Missions, "only");
  assert.equal(hidden.level5Missions, "hide");
  assert.equal(shown.level5Missions, "show");
  assert.equal(legacyEnabled.level5Missions, "only");
});

test("parseOfferQuery defaults volume filtering off and accepts opt-in guardrails", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const relaxed = parseOfferQuery({
    query: { minVolume: "100", maxM3: "500", jita44Only: "true", bpc: "all" }
  } as never);

  assert.equal(defaulted.minVolume, 0);
  assert.equal(defaulted.maxM3, undefined);
  assert.equal(defaulted.jita44Only, false);
  assert.equal(relaxed.minVolume, 100);
  assert.equal(relaxed.maxM3, 500);
  assert.equal(relaxed.jita44Only, true);
  assert.equal(relaxed.bpc, "all");
});

test("parseOfferQuery parses the four-position bpc mode with build/make aliases", () => {
  assert.equal(parseOfferQuery({ query: {} } as never).bpc, undefined);
  for (const mode of ["none", "sell", "manufacture", "all"] as const) {
    assert.equal(parseOfferQuery({ query: { bpc: mode } } as never).bpc, mode);
  }
  assert.equal(parseOfferQuery({ query: { bpc: "build" } } as never).bpc, "manufacture");
  assert.equal(parseOfferQuery({ query: { bpc: "make" } } as never).bpc, "manufacture");
  assert.equal(parseOfferQuery({ query: { bpc: "true" } } as never).bpc, undefined);
  assert.equal(parseOfferQuery({ query: { includeManufacturedBpc: "true" } } as never).bpc, undefined);
});

test("parseOfferQuery ignores removed standing sort key", () => {
  const parsed = parseOfferQuery({ query: { sortBy: "standing" } } as never);

  assert.equal(parsed.sortBy, undefined);
});

test("parseOfferQuery ignores flags as a removed sort key", () => {
  const parsed = parseOfferQuery({ query: { sortBy: "flags" } } as never);

  assert.equal(parsed.sortBy, undefined);
});

test("parseOfferQuery ignores corp and offer as removed sort keys", () => {
  for (const sortBy of ["corp", "offer"]) {
    const parsed = parseOfferQuery({ query: { sortBy } } as never);

    assert.equal(parsed.sortBy, undefined, sortBy);
  }
});

test("parseOfferQuery ignores cargo as a removed sort key", () => {
  const parsed = parseOfferQuery({ query: { sortBy: "cargo" } } as never);

  assert.equal(parsed.sortBy, undefined);
});

test("parseOfferQuery clamps extreme runs values", () => {
  const parsed = parseOfferQuery({ query: { runs: "999999999" } } as never);

  assert.equal(parsed.runs, 10000);
});

test("parseOfferQuery stores search and corpSearch as raw values, not LIKE-escaped", () => {
  const parsed = parseOfferQuery({ query: { search: "test_mod", corpSearch: "100%" } } as never);

  // Underscore and percent must be stored verbatim; escaping happens at the SQL call site.
  assert.equal(parsed.search, "test_mod");
  assert.equal(parsed.corpSearch, "100%");
});

test("parseOfferQuery defaults realistic patient off and clamps Advanced Broker Relations", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const enabled = parseOfferQuery({ query: { realisticPatient: "true", advBro: "9" } } as never);

  assert.equal(defaulted.realisticPatient, false);
  assert.equal(defaulted.advBro, undefined);
  assert.equal(enabled.realisticPatient, true);
  assert.equal(enabled.advBro, 5);
});

test("parseOfferQuery defaults no-market-fees off and accepts explicit opt-in", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  const enabled = parseOfferQuery({ query: { noMarketFees: "true" } } as never);
  const disabled = parseOfferQuery({ query: { noMarketFees: "false" } } as never);

  assert.equal(defaulted.noMarketFees, false);
  assert.equal(enabled.noMarketFees, true);
  assert.equal(disabled.noMarketFees, false);
});

test("parseOfferQuery validates the facility preset and reads cost index", () => {
  const defaulted = parseOfferQuery({ query: {} } as never);
  assert.equal(defaulted.facility, undefined);
  assert.equal(defaulted.costIndex, undefined);

  for (const value of ["npc", "highsec-t2", "null-t2"]) {
    assert.equal(parseOfferQuery({ query: { facility: value } } as never).facility, value);
  }
  // Aliases normalize onto the canonical preset names.
  assert.equal(parseOfferQuery({ query: { facility: "nullsec" } } as never).facility, "null-t2");
  assert.equal(parseOfferQuery({ query: { facility: "highsec" } } as never).facility, "highsec-t2");
  // Garbage falls through to undefined (default NPC applies in the calc).
  assert.equal(parseOfferQuery({ query: { facility: "bogus" } } as never).facility, undefined);

  assert.equal(parseOfferQuery({ query: { costIndex: "2.5" } } as never).costIndex, 2.5);
  assert.equal(parseOfferQuery({ query: { costIndex: "abc" } } as never).costIndex, undefined);
});

test("parseOfferQuery clamps non-positive or unparseable lpPerHour to the 30000 default", () => {
  // A non-positive rate makes applyLpPerHour a no-op that would still pin the canonical
  // 30000-rate body under a personalized edge key, so anything <= 0 falls back to the default.
  assert.equal(parseOfferQuery({ query: {} } as never).lpPerHour, 30000);
  assert.equal(parseOfferQuery({ query: { lpPerHour: "0" } } as never).lpPerHour, 30000);
  assert.equal(parseOfferQuery({ query: { lpPerHour: "-5" } } as never).lpPerHour, 30000);
  assert.equal(parseOfferQuery({ query: { lpPerHour: "abc" } } as never).lpPerHour, 30000);
  assert.equal(parseOfferQuery({ query: { lpPerHour: "" } } as never).lpPerHour, 30000);
  // A real positive rate passes through unchanged.
  assert.equal(parseOfferQuery({ query: { lpPerHour: "60000" } } as never).lpPerHour, 60000);
  assert.equal(parseOfferQuery({ query: { lpPerHour: "0.5" } } as never).lpPerHour, 0.5);
});

test("bool returns undefined for unrecognized values so ?? defaults apply", () => {
  // Recognized falsy strings must still return false
  const explicitFalse = parseOfferQuery({ query: { hideVanity: "0" } } as never);
  const explicitFalse2 = parseOfferQuery({ query: { hideVanity: "no" } } as never);
  // Unrecognized value must return undefined so ?? true applies
  const unrecognized = parseOfferQuery({ query: { hideVanity: "maybe" } } as never);
  const unrecognized2 = parseOfferQuery({ query: { hideVanity: "2" } } as never);

  assert.equal((explicitFalse as { hideVanity?: boolean }).hideVanity, false);
  assert.equal((explicitFalse2 as { hideVanity?: boolean }).hideVanity, false);
  // ?? true kicks in for undefined → hideVanity should be true
  assert.equal((unrecognized as { hideVanity?: boolean }).hideVanity, true);
  assert.equal((unrecognized2 as { hideVanity?: boolean }).hideVanity, true);
});
