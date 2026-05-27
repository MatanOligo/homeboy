import { getDueTasks, updateTaskAfterRun, type Task } from "./db.js";
import { runTask } from "./assistant.js";
import { chunkMessage, sendOutboxFiles } from "./utils.js";
import { log } from "./logger.js";
import type { Api } from "grammy";

const CHECK_INTERVAL = 30_000; // 30 seconds

let schedulerInterval: NodeJS.Timeout | null = null;
let botApi: Api | null = null;
let chatId: number | null = null;

// Track running tasks to avoid double-execution
const runningTasks = new Set<number>();

// Active task's reportTo — used by outbox watcher to know who to send files to
let activeTaskReportTo: number[] | null = null;

export function getActiveTaskReportTo(): number[] | null {
  return activeTaskReportTo;
}

export function startScheduler(api: Api, userId: number): void {
  botApi = api;
  chatId = userId;

  log.info("scheduler", "Starting scheduler (checking every 30s)");
  schedulerInterval = setInterval(checkAndRunTasks, CHECK_INTERVAL);
  checkAndRunTasks();
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

async function checkAndRunTasks(): Promise<void> {
  const dueTasks = getDueTasks();

  for (const task of dueTasks) {
    if (runningTasks.has(task.id)) continue;

    runningTasks.add(task.id);
    executeTask(task)
      .catch((error) => {
        log.error("scheduler", `Task #${task.id} unhandled error`, {
          error: error.message,
        });
      })
      .finally(() => {
        runningTasks.delete(task.id);
      });
  }
}

export async function executeTask(task: Task): Promise<void> {
  log.info("scheduler", `Running task #${task.id}: ${task.name}`);

  const reporting = task.report_result !== 0;
  const reportTo: number[] = task.report_to
    ? (JSON.parse(task.report_to) as number[])
    : chatId
    ? [chatId]
    : [];

  // Set active task context so outbox watcher knows who to send to
  activeTaskReportTo = reportTo;

  try {
    if (botApi && reporting) {
      for (const uid of reportTo) {
        await botApi.sendMessage(uid, `Running task #${task.id}: ${task.name}...`);
      }
    }

    const result = await runTask(task.prompt);
    updateTaskAfterRun(task.id, result);

    log.info("scheduler", `Task #${task.id} completed`, {
      resultLength: result.length,
    });

    if (botApi && reporting) {
      const header = `Task #${task.id} (${task.name}) completed:\n\n`;
      const chunks = chunkMessage(header + result);
      for (const uid of reportTo) {
        for (const chunk of chunks) {
          try {
            await botApi.sendMessage(uid, chunk, { parse_mode: "Markdown" });
          } catch {
            await botApi.sendMessage(uid, chunk);
          }
        }
      }
    }

    // Always send outbox files, even when task reporting is muted
    if (botApi && reportTo.length > 0) {
      await sendOutboxFiles(botApi, reportTo);
    }
  } catch (error: any) {
    const errorMsg = error.message || "Unknown error";
    updateTaskAfterRun(task.id, `ERROR: ${errorMsg}`);

    log.error("scheduler", `Task #${task.id} error`, { error: errorMsg });

    // Always report errors regardless of reporting setting
    if (botApi && reportTo.length > 0) {
      for (const uid of reportTo) {
        await botApi.sendMessage(
          uid,
          `Task #${task.id} (${task.name}) failed: ${errorMsg}`,
        );
      }
    }
  } finally {
    activeTaskReportTo = null;
  }
}
