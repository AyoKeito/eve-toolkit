// Shared diagnostics (client id, apiFetch, error helpers) live in /shared/diagnostics.js
// so the lp and missions front-ends share a single source of truth. Cache invalidation is
// purge-driven (no ?v= stamps): assets revalidate via ETag and Cloudflare is busted on
// deploy by `npm run cf:purge-static`.
export * from "/shared/diagnostics.js";

// escapeHtml is defined once in /shared/utils.js; re-exported here so the lp modules keep
// importing it from ./diagnostics.js. The lp leaderboard builds innerHTML strings (SDE
// item/store names), whereas the missions front-end renders via DOM text nodes.
export { escapeHtml } from "/shared/utils.js";
