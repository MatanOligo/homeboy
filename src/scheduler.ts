import { getDueTasks, updateTaskAfterRun, type Task } from "./db.js";
import { runTask } from "./assistant.js";
import { chunkMessage } from "./utils.js";
import { log } from "./logger.js";
import type { Api } from "grammy";

const CHECK_INTERVAL = 30_000; // 30 seconds

let schedulerInterval: NodeJS.Timeout | null = null;
let botApi: Api | null = null;
let chatId: number | null = null;

// Track running tasks to avoid double-execution
const runningTasks = new Set<number>();

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

async function executeTask(task: Task): Promise<void> {
  log.info("scheduler", `Running task #${task.id}: ${task.name}`);

  if (botApi && chatId) {
    await botApi.sendMessage(chatId, `Running task #${task.id}: ${task.name}...`);
  }

  try {
    const result = await runTask(task.prompt);
    updateTaskAfterRun(task.id, result);

    log.info("scheduler", `Task #${task.id} completed`, {
      resultLength: result.length,
    });

    if (botApi && chatId) {
      const header = `Task #${task.id} (${task.name}) completed:\n\n`;
      const chunks = chunkMessage(header + result);
      for (const chunk of chunks) {
        try {
          await botApi.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
        } catch {
          await botApi.sendMessage(chatId, chunk);
        }
      }
    }
  } catch (error: any) {
    const errorMsg = error.message || "Unknown error";
    updateTaskAfterRun(task.id, `ERROR: ${errorMsg}`);

    log.error("scheduler", `Task #${task.id} error`, { error: errorMsg });

    if (botApi && chatId) {
      await botApi.sendMessage(
        chatId,
        `Task #${task.id} (${task.name}) failed: ${errorMsg}`,
      );
    }
  }
}
