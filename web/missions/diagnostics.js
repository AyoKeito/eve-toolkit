// Thin re-export of the shared diagnostics module (client id, apiFetch, error helpers).
// The implementation lives in /shared/diagnostics.js (shared by the lp and missions
// front-ends). The missions front-end does not use escapeHtml.
export * from "/shared/diagnostics.js";
