import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export const LOG_FILE = new URL("../data/homeboy.log", import.meta.url).pathname;

mkdirSync(dirname(LOG_FILE), { recursive: true });

type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, component: string, message: string, meta?: unknown): void {
  const ts = new Date().toISOString();
  const line = meta
    ? `[${ts}] ${level} [${component}] ${message} | ${JSON.stringify(meta)}`
    : `[${ts}] ${level} [${component}] ${message}`;

  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

export const log = {
  info: (component: string, message: string, meta?: unknown) =>
    write("INFO", component, message, meta),
  warn: (component: string, message: string, meta?: unknown) =>
    write("WARN", component, message, meta),
  error: (component: string, message: string, meta?: unknown) =>
    write("ERROR", component, message, meta),
};
