const clientIdStorageKey = "eveClientId";
const diagnosticIdPattern = /^[A-Za-z0-9_-]{6,96}$/;
const tokenChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
let cachedClientId = "";

function safeDiagnosticId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return diagnosticIdPattern.test(trimmed) ? trimmed : "";
}

function randomToken(length) {
  const values = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(values, (value) => tokenChars[value & 63]).join("");
}

function createClientId() {
  return `cli_${randomToken(18)}`;
}

export function setChip(id, text, title, { tone } = {}) {
  const chip = document.getElementById(id);
  if (!chip) return;
  chip.textContent = text;
  chip.title = title;
  if (tone !== undefined) chip.dataset.tone = tone;
}

function currentClientId() {
  if (cachedClientId) return cachedClientId;
  try {
    const stored = safeDiagnosticId(localStorage.getItem(clientIdStorageKey));
    cachedClientId = stored || createClientId();
    if (cachedClientId !== stored) localStorage.setItem(clientIdStorageKey, cachedClientId);
  } catch {
    cachedClientId = createClientId();
  }
  return cachedClientId;
}

export function initializeDiagnostics() {
  const clientId = currentClientId();
  setChip("clientIdChip", `Client ${clientId}`, `Persistent browser client ID: ${clientId}`);
}

export async function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-EVE-Client-Id", currentClientId());
  return fetch(input, { ...init, headers });
}

export function responseError(response, label = "API") {
  const error = new Error(`${label} request failed: ${response.status}`);
  error.status = response.status;
  error.retryAfter = response.headers.get("Retry-After");
  return error;
}

export function apiErrorMessage(error) {
  if (error?.status === 429) {
    const retryAfter = error.retryAfter;
    const wait = retryAfter ? ` Try again in ${retryAfter} seconds.` : " Wait a few seconds and try again.";
    return `You're being rate-limited.${wait}`;
  }
  return error instanceof Error ? error.message : String(error);
}
