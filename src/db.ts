import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { log } from "./logger.js";

const DB_PATH = new URL("../data/homeboy.db", import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once', 'interval')),
    interval_seconds INTEGER,
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

log.info("db", "SQLite initialized", { path: DB_PATH });

export interface Task {
  id: number;
  name: string;
  prompt: string;
  schedule_type: "once" | "interval";
  interval_seconds: number | null;
  next_run_at: number;
  last_run_at: number | null;
  last_result: string | null;
  status: "active" | "completed";
  created_at: number;
}

export function createTask(task: {
  name: string;
  prompt: string;
  schedule_type: "once" | "interval";
  interval_seconds: number | null;
  next_run_at: number;
}): Task {
  const stmt = db.prepare(
    "INSERT INTO tasks (name, prompt, schedule_type, interval_seconds, next_run_at) VALUES (?, ?, ?, ?, ?)",
  );
  const result = stmt.run(
    task.name,
    task.prompt,
    task.schedule_type,
    task.interval_seconds,
    task.next_run_at,
  );
  return getTask(result.lastInsertRowid as number)!;
}

export function getTask(id: number): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
}

export function getAllTasks(): Task[] {
  return db.prepare("SELECT * FROM tasks ORDER BY status ASC, next_run_at ASC").all() as Task[];
}

export function getDueTasks(): Task[] {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      "SELECT * FROM tasks WHERE status = 'active' AND next_run_at <= ?",
    )
    .all(now) as Task[];
}

export function updateTaskAfterRun(
  id: number,
  result: string,
): void {
  const task = getTask(id);
  if (!task) return;

  const now = Math.floor(Date.now() / 1000);

  if (task.schedule_type === "once") {
    db.prepare(
      "UPDATE tasks SET last_run_at = ?, last_result = ?, status = 'completed' WHERE id = ?",
    ).run(now, result, id);
  } else {
    const nextRun = now + (task.interval_seconds || 0);
    db.prepare(
      "UPDATE tasks SET last_run_at = ?, last_result = ?, next_run_at = ? WHERE id = ?",
    ).run(now, result, nextRun, id);
  }
}

export function cancelTask(id: number): boolean {
  const result = db
    .prepare(
      "UPDATE tasks SET status = 'completed' WHERE id = ? AND status = 'active'",
    )
    .run(id);
  return result.changes > 0;
}

export { db };
