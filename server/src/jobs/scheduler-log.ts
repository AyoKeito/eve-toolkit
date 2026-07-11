import fs from "node:fs";
import path from "node:path";
import { logDir as defaultLogDir } from "../config.js";
import { errorMessage } from "../lib/parse.js";

interface SchedulerLoggerOptions {
  echo?: boolean;
  logDir?: string;
}

export interface SchedulerLogger {
  write(entry: Record<string, unknown>): void;
}

export function createSchedulerLogger(options: SchedulerLoggerOptions = {}): SchedulerLogger {
  const echo = options.echo ?? true;
  const logDir = options.logDir ?? defaultLogDir;
  const logPath = path.join(logDir, "scheduler.log");

  return {
    write(entry: Record<string, unknown>): void {
      const payload = {
        ts: new Date().toISOString(),
        ...entry
      };
      const line = `${JSON.stringify(payload)}\n`;
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath, line, "utf8");
      if (echo) {
        const level = entry.event === "failure" ? "error" : "info";
        const sink = level === "error" ? console.error : console.log;
        sink(line.trim());
      }
    }
  };
}

export async function runLoggedJob<T>(logger: SchedulerLogger, job: string, action: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  logger.write({ component: "scheduler", job, event: "start" });
  try {
    const result = await action();
    logger.write({
      component: "scheduler",
      job,
      event: "success",
      duration_ms: Date.now() - started
    });
    return result;
  } catch (error) {
    logger.write({
      component: "scheduler",
      job,
      event: "failure",
      duration_ms: Date.now() - started,
      error: errorMessage(error)
    });
    throw error;
  }
}
