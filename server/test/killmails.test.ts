import assert from "node:assert/strict";
import test from "node:test";
import { computeFitHash, isFittedModuleFlag, targetDates } from "../src/fetchers/killmails.js";

// Charge type ids used across tests; isCharge mimics the types.category_id=8 lookup.
const CHARGE_IDS = new Set<number>([1000, 1001]);
const isCharge = (typeId: number): boolean => CHARGE_IDS.has(typeId);

function item(flag: number, typeId: number, destroyed = 1, dropped = 0): {
  item_type_id: number;
  flag: number;
  quantity_destroyed: number;
  quantity_dropped: number;
} {
  return { item_type_id: typeId, flag, quantity_destroyed: destroyed, quantity_dropped: dropped };
}

test("isFittedModuleFlag covers fitted slots and excludes cargo/drones", () => {
  // low/mid/high (11-34), rigs (92-99), subsystems (125-132)
  for (const flag of [11, 18, 19, 26, 27, 34, 92, 99, 125, 132]) {
    assert.equal(isFittedModuleFlag(flag), true, `flag ${flag} should be fitted`);
  }
  // cargo (5), drone bay (87), out-of-range boundaries
  for (const flag of [5, 10, 35, 87, 91, 100, 124, 133]) {
    assert.equal(isFittedModuleFlag(flag), false, `flag ${flag} should not be fitted`);
  }
});

test("same modules with different loaded ammo hash identically", () => {
  const ship = 11377; // Tristan
  const base = [item(27, 2000), item(19, 2001), item(11, 2002), item(92, 2003)];
  const withAmmoA = computeFitHash(ship, [...base, item(27, 1000)], isCharge);
  const withAmmoB = computeFitHash(ship, [...base, item(28, 1001)], isCharge);
  assert.equal(withAmmoA.fitHash, withAmmoB.fitHash);
  // charges are excluded from the buildable module list
  assert.deepEqual(
    withAmmoA.moduleList.map((m) => m.type_id),
    [2000, 2001, 2002, 2003]
  );
});

test("different module produces a different fit hash", () => {
  const ship = 11377;
  const a = computeFitHash(ship, [item(27, 2000), item(11, 2002)], isCharge);
  const b = computeFitHash(ship, [item(27, 2099), item(11, 2002)], isCharge);
  assert.notEqual(a.fitHash, b.fitHash);
});

test("same hull is irrelevant if hull differs", () => {
  const mods = [item(27, 2000), item(11, 2002)];
  assert.notEqual(computeFitHash(11377, mods, isCharge).fitHash, computeFitHash(593, mods, isCharge).fitHash);
});

test("identical modules in different slots aggregate quantity", () => {
  const fit = computeFitHash(11377, [item(27, 2000), item(28, 2000)], isCharge);
  assert.deepEqual(fit.moduleList, [{ type_id: 2000, qty: 2 }]);
  assert.equal(fit.moduleCount, 2);
});

test("cargo and drones are ignored even when not charges", () => {
  const fit = computeFitHash(11377, [item(27, 2000), item(5, 3000, 100), item(87, 3001, 5)], isCharge);
  assert.deepEqual(fit.moduleList, [{ type_id: 2000, qty: 1 }]);
});

test("naked hull yields a stable empty-fit hash", () => {
  const a = computeFitHash(11377, [], isCharge);
  const b = computeFitHash(11377, [item(5, 3000)], isCharge);
  assert.equal(a.fitHash, b.fitHash);
  assert.deepEqual(a.moduleList, []);
  assert.equal(a.moduleCount, 0);
});

test("targetDates returns a UTC window ending yesterday, ascending", () => {
  const now = Date.parse("2026-06-24T12:00:00Z");
  assert.deepEqual(targetDates(now, 1), ["2026-06-23"]);
  assert.deepEqual(targetDates(now, 3), ["2026-06-21", "2026-06-22", "2026-06-23"]);
});
