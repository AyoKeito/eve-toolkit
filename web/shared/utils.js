// Shared front-end utilities for the lp and missions apps. Served at /shared/utils.js.
// Cache invalidation is purge-driven (no ?v= stamps): assets revalidate via ETag and
// Cloudflare is busted on deploy by `npm run cf:purge-static`.

export function debounce(fn, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// Escape a value for safe interpolation into an HTML string (attribute values or text).
// Escapes & < > " ' and coerces null/undefined to "". Single source of truth for the lp
// leaderboard and fits front-ends, which build innerHTML strings rather than DOM text nodes.
export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
