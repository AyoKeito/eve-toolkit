// Barrel — re-exports the full public surface of the calc/ratio module.
// External importers use this file unchanged; the implementation lives in:
//   offer-types.ts   — shared types, interfaces, lineSignature/targetSignature
//   offer-calc.ts    — calculateOffer, summarizeOfferCalc, per-offer math
//   offer-list.ts    — listOfferCalcs, filter/sort helpers
//   offer-persist.ts — recomputeAndPersist, waitForPendingCloudflarePurge
//   fill.ts          — patient-fill estimator, relist and decay helpers
export * from "./fill.js";
export * from "./market-snapshot.js";
export * from "./offer-types.js";
export * from "./offer-calc.js";
export * from "./offer-list.js";
export * from "./offer-persist.js";
