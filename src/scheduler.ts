import { getDueTasks, updateTaskAfterRun, type Task } from "./db.js";
import { runTask } from "./assistant.js";
import { chunkMessage, sendOutboxFiles } from "./utils.js";
import { log } from "./logger.js";
import { isAuthError, startReauth } from "./reauth.js";
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

    // Auth-expiry failures are handled specially: kick off reauth and hand the
    // owner a login link instead of just reporting the raw error.
    if (isAuthError(errorMsg)) {
      await handleAuthFailure(task);
    } else if (botApi && reportTo.length > 0) {
      // Always report non-auth errors regardless of reporting setting
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

/**
 * A scheduled task failed because Claude's OAuth token expired. Automatically
 * start the reauth flow and DM the owner the login link so they can fix it from
 * Telegram without SSHing into the box.
 */
async function handleAuthFailure(task: Task): Promise<void> {
  log.warn("scheduler", `Task #${task.id} hit an auth error — starting reauth`);
  if (!botApi || chatId == null) return;

  try {
    await botApi.sendMessage(
      chatId,
      `⚠️ Task #${task.id} (${task.name}) failed: Claude's login expired.\n` +
        `Starting re-authentication…`,
    );

    const result = await startReauth();

    if (result.url) {
      const prefix = result.alreadyRunning
        ? "A reauth is already in progress. Open this link:"
        : "Open this link, authorize, then reply here with the code it shows you:";
      await botApi.sendMessage(
        chatId,
        `${prefix}\n\n${result.url}\n\n` +
          "Just send the code as a normal message. Send /reauth cancel to abort.",
        { disable_web_page_preview: true } as any,
      );
    } else {
      await botApi.sendMessage(
        chatId,
        `Couldn't start reauth automatically: ${result.error ?? "unknown error"}.\n` +
          `Try running /reauth manually.`,
      );
    }
  } catch (err: any) {
    log.error("scheduler", "handleAuthFailure error", { error: err.message });
  }
}
