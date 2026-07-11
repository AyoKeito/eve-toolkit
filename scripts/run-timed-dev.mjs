#!/usr/bin/env node
import { spawn } from "node:child_process";

const defaultTimeoutMs = 20 * 60 * 1000;

function parseTimeoutMs() {
  const arg = process.argv.find((value) => value.startsWith("--timeout-ms="));
  const raw = arg?.slice("--timeout-ms=".length) ?? process.env.EVE_DEV_TIMEOUT_MS;
  if (!raw) return defaultTimeoutMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultTimeoutMs;
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function forceTerminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const timeoutMs = parseTimeoutMs();
let timedOut = false;
let forwardedSignal = null;
const child = spawn("npm", ["run", "dev"], {
  detached: process.platform !== "win32",
  stdio: "inherit"
});

const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`Timed dev server exceeded ${timeoutMs}ms; terminating process group.`);
  terminate(child);
  setTimeout(() => forceTerminate(child), 5000).unref();
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    forwardedSignal = signal;
    terminate(child);
  });
}

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (timedOut) {
    process.exit(124);
    return;
  }
  if (signal) {
    process.kill(process.pid, forwardedSignal ?? signal);
    return;
  }
  process.exit(code ?? 0);
});
