// Shared en-US number formatters for the missions front-end.
//
// The lp app intentionally formats with the visitor's system locale
// (Intl.NumberFormat(undefined, ...)); the missions app pins "en-US" for stable,
// locale-independent counts. Do NOT unify the two — it is a visible behaviour difference.
export const numberFormat = new Intl.NumberFormat("en-US");
export const dpsFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
