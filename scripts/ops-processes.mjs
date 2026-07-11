#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const procRoot = "/proc";
const runtimePatterns = [
  "npm start",
  "node dist/server/src/index.js",
  "tsx server/src/index.ts"
];

function usage() {
  console.error("Usage: node scripts/ops-processes.mjs <list|kill> [--json] [--dry-run]");
}

function readProcText(pid, name) {
  try {
    return fs.readFileSync(path.join(procRoot, pid, name), "utf8");
  } catch {
    return "";
  }
}

function readProcCwd(pid) {
  try {
    return fs.readlinkSync(path.join(procRoot, pid, "cwd"));
  } catch {
    return "";
  }
}

function commandLine(pid) {
  return readProcText(pid, "cmdline").replace(/\0/g, " ").trim();
}

function isTargetRuntime(command) {
  return runtimePatterns.some((pattern) => command.includes(pattern));
}

function listProcesses() {
  if (!fs.existsSync(procRoot)) return [];
  return fs
    .readdirSync(procRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .flatMap((entry) => {
      const pid = Number.parseInt(entry.name, 10);
      const cwd = readProcCwd(entry.name);
      if (cwd !== repoRoot) return [];
      const command = commandLine(entry.name);
      if (!isTargetRuntime(command)) return [];
      return [{ pid, cwd, command }];
    })
    .sort((a, b) => a.pid - b.pid);
}

function printProcesses(processes, json) {
  if (json) {
    console.log(JSON.stringify(processes, null, 2));
    return;
  }
  if (processes.length === 0) {
    console.log("No stray host-side EVE runtime processes found.");
    return;
  }
  for (const processInfo of processes) {
    console.log(`${processInfo.pid}\t${processInfo.cwd}\t${processInfo.command}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcesses(processes, dryRun) {
  if (processes.length === 0 || dryRun) return;
  for (const processInfo of processes) {
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await sleep(3000);
  const survivors = listProcesses().filter((processInfo) =>
    processes.some((candidate) => candidate.pid === processInfo.pid)
  );
  for (const processInfo of survivors) {
    try {
      process.kill(processInfo.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

const [, , command, ...args] = process.argv;
const json = args.includes("--json");
const dryRun = args.includes("--dry-run");

if (command !== "list" && command !== "kill") {
  usage();
  process.exit(2);
}

const processes = listProcesses();
printProcesses(processes, json);

if (command === "kill") {
  await killProcesses(processes, dryRun);
  if (!json && dryRun && processes.length > 0) console.log("Dry run only; no signals sent.");
}
