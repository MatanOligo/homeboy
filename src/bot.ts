import { Bot, InlineKeyboard } from "grammy";
import { readFileSync } from "fs";
import { config } from "./config.js";
import {
  chat,
  chatWithPhoto,
  resetSession,
  getModel,
  setModel,
  getSessionId,
} from "./assistant.js";
import { getAllTasks, getTask, cancelTask, deleteTask, enableTask } from "./db.js";
import type { Task } from "./db.js";
import { executeTask } from "./scheduler.js";
import { chunkMessage, keepTyping, sendOutboxFiles } from "./utils.js";
import { log, LOG_FILE } from "./logger.js";

const startTime = Date.now();

export const bot = new Bot(config.telegramToken);

// Auth middleware — silently ignore everyone except the owner
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== config.allowedUserId) {
    log.warn("auth", "Rejected message from unauthorized user", {
      userId: ctx.from?.id,
      username: ctx.from?.username,
    });
    return;
  }
  await next();
});

// Drop stale messages (sent while bot was down)
bot.use(async (ctx, next) => {
  const messageDate = ctx.message?.date || ctx.callbackQuery?.message?.date;
  if (messageDate) {
    const age = Math.floor(Date.now() / 1000) - messageDate;
    if (age > config.maxMessageAge) {
      log.info("stale", `Dropping message ${age}s old`);
      return;
    }
  }
  await next();
});

// /start
bot.command("start", async (ctx) => {
  log.info("cmd", "/start");
  await ctx.reply(
    "Homeboy is online. Send me anything — I have full access to this machine.\n\n" +
      "Commands:\n" +
      "/new — Start a fresh conversation\n" +
      "/schedule — Schedule a task\n" +
      "/tasks — List scheduled tasks\n" +
      "/cancel — Cancel a task\n" +
      "/model — View or switch Claude model\n" +
      "/status — Bot status and session info\n" +
      "/log — Show recent log entries\n" +
      "/restart — Restart the bot\n" +
      "/help — List all commands",
  );
});

// /help
bot.command("help", async (ctx) => {
  log.info("cmd", "/help");
  await ctx.reply(
    "Available commands:\n\n" +
      "/new — Start a fresh conversation\n" +
      "/schedule <desc> — Schedule a task\n" +
      "/tasks — List all scheduled tasks\n" +
      "/cancel <id> — Cancel a task\n" +
      "/model [name] — View or switch Claude model\n" +
      "/status — Bot status, uptime, session info\n" +
      "/log [n] — Show last n log entries (default 20)\n" +
      "/restart — Restart the bot\n" +
      "/help — This message\n\n" +
      "Any text message is sent to Claude.\n" +
      "Photos are analyzed via Claude vision.",
  );
});

// /schedule <description> — shortcut to schedule a task via chat
bot.command("schedule", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    await ctx.reply(
      "Usage: /schedule <describe what and when>\n\n" +
        "Examples:\n" +
        "  /schedule check disk usage every 6 hours\n" +
        "  /schedule in 2 hours remind me to check deploys\n" +
        "  /schedule every 30 minutes check if the API is up",
    );
    return;
  }

  log.info("cmd", `/schedule — "${input}"`);
  const stopTyping = keepTyping(() => ctx.replyWithChatAction("typing"));

  try {
    const response = await chat(
      ctx.from!.id,
      `Schedule this task: ${input}`,
    );
    stopTyping();

    const chunks = chunkMessage(response);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(chunk);
      }
    }
  } catch (error: any) {
    stopTyping();
    log.error("cmd", "Schedule error", { error: error.message });
    await ctx.reply(`Failed to create task: ${error.message}`);
  }
});

function cronToEnglish(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, month, dow] = parts;

  const pad = (n: string) => n.padStart(2, "0");
  const formatTime = (h: string, m: string) => {
    const hNum = parseInt(h, 10);
    const mNum = parseInt(m, 10);
    if (isNaN(hNum) || isNaN(mNum)) return null;
    const ampm = hNum < 12 ? "AM" : "PM";
    const h12 = hNum === 0 ? 12 : hNum > 12 ? hNum - 12 : hNum;
    return `${h12}:${pad(String(mNum))} ${ampm}`;
  };

  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const ordinal = (n: number) => {
    const s = ["th","st","nd","rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // every N minutes: */N * * * *
  if (min.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = parseInt(min.slice(2), 10);
    return `every ${n} minute${n !== 1 ? "s" : ""}`;
  }

  // every N hours: 0 */N * * *
  if (min === "0" && hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") {
    const n = parseInt(hour.slice(2), 10);
    return `every ${n} hour${n !== 1 ? "s" : ""}`;
  }

  // every day at HH:MM: M H * * *
  if (!min.includes("*") && !hour.includes("*") && dom === "*" && month === "*" && dow === "*") {
    const t = formatTime(hour, min);
    if (t) return `every day at ${t}`;
  }

  // weekdays at HH:MM: M H * * 1-5
  if (!min.includes("*") && !hour.includes("*") && dom === "*" && month === "*" && dow === "1-5") {
    const t = formatTime(hour, min);
    if (t) return `weekdays at ${t}`;
  }

  // weekends at HH:MM: M H * * 6,0  or  M H * * 0,6
  if (!min.includes("*") && !hour.includes("*") && dom === "*" && month === "*" && (dow === "6,0" || dow === "0,6" || dow === "0,6" || dow === "6-7")) {
    const t = formatTime(hour, min);
    if (t) return `weekends at ${t}`;
  }

  // specific day of week: M H * * D
  if (!min.includes("*") && !hour.includes("*") && dom === "*" && month === "*" && /^[0-6]$/.test(dow)) {
    const t = formatTime(hour, min);
    const dayName = DAYS[parseInt(dow, 10)];
    if (t && dayName) return `every ${dayName} at ${t}`;
  }

  // day of month: M H D * *
  if (!min.includes("*") && !hour.includes("*") && !dom.includes("*") && month === "*" && dow === "*") {
    const t = formatTime(hour, min);
    const d = parseInt(dom, 10);
    if (t && !isNaN(d)) return `${ordinal(d)} of every month at ${t}`;
  }

  // specific date: M H D Mo *
  if (!min.includes("*") && !hour.includes("*") && !dom.includes("*") && !month.includes("*") && dow === "*") {
    const t = formatTime(hour, min);
    const d = parseInt(dom, 10);
    const mo = parseInt(month, 10);
    if (t && !isNaN(d) && !isNaN(mo) && mo >= 1 && mo <= 12) {
      return `${MONTHS[mo - 1]} ${ordinal(d)} at ${t}`;
    }
  }

  // every minute: * * * * *
  if (cron.trim() === "* * * * *") return "every minute";

  return cron; // fallback: raw cron
}

function formatTaskSchedule(t: { schedule_type: string; interval_seconds: number | null; cron_expression: string | null }): string {
  if (t.schedule_type === "interval") return `every ${formatDuration(t.interval_seconds!)}`;
  if (t.schedule_type === "cron") return cronToEnglish(t.cron_expression!);
  return "one-time";
}

function formatTaskDetail(t: { id: number; name: string; status: string; schedule_type: string; interval_seconds: number | null; cron_expression: string | null; next_run_at: number; prompt: string }): string {
  const schedule = formatTaskSchedule(t);
  const nextRun = t.status === "active" ? new Date(t.next_run_at * 1000).toLocaleString() : "done";
  return (
    `*Task #${t.id}*\n` +
    `Title: ${t.name}\n` +
    `Schedule: ${schedule}\n` +
    `Status: ${t.status}\n` +
    `Next run: ${nextRun}\n` +
    `Prompt: ${t.prompt}`
  );
}

function taskActionKeyboard(t: Task): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (t.schedule_type !== "once") {
    if (t.status === "active") {
      kb.text("⏸ Disable", `task_toggle:${t.id}`);
    } else {
      kb.text("▶️ Enable", `task_toggle:${t.id}`);
    }
  }
  if (t.status === "active") {
    kb.text("⚡ Run now", `task_run:${t.id}`);
  }
  kb.row().text("🗑 Delete", `task_delete:${t.id}`);
  return kb;
}

// /tasks [id] — list tasks or show full details of a specific task
bot.command("tasks", async (ctx) => {
  const idStr = ctx.match?.trim();

  // /tasks <id> — show full details of a specific task
  if (idStr) {
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      await ctx.reply("Usage: /tasks [id]");
      return;
    }
    log.info("cmd", `/tasks — detail for #${id}`);
    const task = getTask(id);
    if (!task) {
      await ctx.reply(`Task #${id} not found.`);
      return;
    }
    try {
      await ctx.reply(formatTaskDetail(task), { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(formatTaskDetail(task));
    }
    return;
  }

  // /tasks — brief overview with inline buttons
  log.info("cmd", "/tasks");
  const tasks = getAllTasks();

  if (tasks.length === 0) {
    await ctx.reply("No tasks. Just ask me to schedule something in chat.");
    return;
  }

  const lines = tasks.map((t) => {
    const status = t.status === "active" ? "●" : "○";
    const schedule = formatTaskSchedule(t);
    return `${status} #${t.id} — ${t.name}  [${schedule}]`;
  });

  const keyboard = new InlineKeyboard();
  for (const t of tasks) {
    keyboard.text(t.name, `task:${t.id}`).row();
  }

  try {
    await ctx.reply("Tasks:\n\n" + lines.join("\n"), {
      reply_markup: keyboard,
    });
  } catch {
    await ctx.reply("Tasks:\n\n" + lines.join("\n"));
  }
});

// Callback: show task detail with action buttons
bot.callbackQuery(/^task:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  log.info("cmd", `/tasks callback — detail for #${id}`);
  await ctx.answerCallbackQuery();
  const task = getTask(id);
  if (!task) {
    await ctx.reply(`Task #${id} not found.`);
    return;
  }
  try {
    await ctx.reply(formatTaskDetail(task), {
      parse_mode: "Markdown",
      reply_markup: taskActionKeyboard(task),
    });
  } catch {
    await ctx.reply(formatTaskDetail(task), { reply_markup: taskActionKeyboard(task) });
  }
});

// Callback: toggle enable/disable
bot.callbackQuery(/^task_toggle:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  const task = getTask(id);
  if (!task) {
    await ctx.answerCallbackQuery({ text: "Task not found." });
    return;
  }

  let ok: boolean;
  let actionText: string;
  if (task.status === "active") {
    ok = cancelTask(id);
    actionText = "Disabled";
  } else {
    ok = enableTask(id);
    actionText = "Enabled";
  }

  if (!ok) {
    await ctx.answerCallbackQuery({ text: "Could not update task." });
    return;
  }

  await ctx.answerCallbackQuery({ text: `${actionText} ✓` });
  const updated = getTask(id)!;
  log.info("cmd", `task_toggle #${id} → ${updated.status}`);
  try {
    await ctx.editMessageText(formatTaskDetail(updated), {
      parse_mode: "Markdown",
      reply_markup: taskActionKeyboard(updated),
    });
  } catch {
    await ctx.editMessageText(formatTaskDetail(updated), {
      reply_markup: taskActionKeyboard(updated),
    });
  }
});

// Callback: run task immediately
bot.callbackQuery(/^task_run:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  const task = getTask(id);
  if (!task) {
    await ctx.answerCallbackQuery({ text: "Task not found." });
    return;
  }
  if (task.status !== "active") {
    await ctx.answerCallbackQuery({ text: "Task is not active." });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Running now..." });
  log.info("cmd", `task_run — manually triggering #${id}`);
  executeTask(task).catch((err) => {
    log.error("cmd", `task_run #${id} error`, { error: err.message });
  });
});

// Callback: delete confirmation prompt
bot.callbackQuery(/^task_delete:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  const task = getTask(id);
  if (!task) {
    await ctx.editMessageText(`Task #${id} not found.`);
    return;
  }
  const kb = new InlineKeyboard()
    .text("✅ Yes, delete", `task_delete_confirm:${id}`)
    .text("❌ Cancel", `task:${id}`);
  try {
    await ctx.editMessageText(`Delete *${task.name}* (#${id})?`, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  } catch {
    await ctx.editMessageText(`Delete "${task.name}" (#${id})?`, { reply_markup: kb });
  }
});

// Callback: confirm delete
bot.callbackQuery(/^task_delete_confirm:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  const task = getTask(id);
  const name = task?.name ?? `#${id}`;
  const ok = deleteTask(id);
  if (ok) {
    log.info("cmd", `task_delete_confirm — deleted #${id}`);
    await ctx.answerCallbackQuery({ text: "Deleted ✓" });
    await ctx.editMessageText(`🗑 Task "${name}" deleted.`);
  } else {
    await ctx.answerCallbackQuery({ text: "Task not found." });
    await ctx.editMessageText(`Task #${id} not found.`);
  }
});

// /cancel <id> — cancel a task
bot.command("cancel", async (ctx) => {
  const idStr = ctx.match?.trim();
  const id = parseInt(idStr || "", 10);

  if (!id) {
    await ctx.reply("Usage: /cancel <task_id>");
    return;
  }

  log.info("cmd", `/cancel — task #${id}`);

  if (cancelTask(id)) {
    await ctx.reply(`Task #${id} cancelled.`);
  } else {
    await ctx.reply(`Task #${id} not found or already completed.`);
  }
});

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

// /restart — restart the bot process (systemd Restart=always brings it back)
bot.command("restart", async (ctx) => {
  const bootTimeSec = Math.floor(startTime / 1000);
  if (ctx.message && ctx.message.date < bootTimeSec) {
    log.info("cmd", "/restart — ignoring (sent before boot)");
    return;
  }
  log.info("cmd", "/restart — restarting bot");
  await ctx.reply("Restarting...");
  setTimeout(() => process.exit(0), 500);
});

// /new — reset conversation
bot.command("new", async (ctx) => {
  log.info("cmd", "/new — resetting session");
  resetSession(ctx.from!.id);
  await ctx.reply("New conversation started.");
});

// /model [name] — view or switch model
bot.command("model", async (ctx) => {
  const newModel = ctx.match?.trim();
  if (newModel) {
    log.info("cmd", `/model — switching to ${newModel}`);
    setModel(newModel);
    await ctx.reply(`Model switched to: ${newModel}`);
  } else {
    await ctx.reply(`Current model: ${getModel()}`);
  }
});

// /status — bot status
bot.command("status", async (ctx) => {
  log.info("cmd", "/status");
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  const sessionId = getSessionId(ctx.from!.id);

  await ctx.reply(
    `Status:\n\n` +
      `Uptime: ${uptimeStr}\n` +
      `Model: ${getModel()}\n` +
      `Session: ${sessionId ? sessionId.slice(0, 12) + "..." : "none"}\n` +
      `Working dir: ${config.workingDir}`,
  );
});

// /log [n] — show recent log entries
bot.command("log", async (ctx) => {
  const count = parseInt(ctx.match?.trim() || "20", 10) || 20;
  log.info("cmd", `/log — showing last ${count} entries`);

  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const tail = lines.slice(-count).join("\n");
    const chunks = chunkMessage(tail || "(no log entries)");
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  } catch {
    await ctx.reply("No log file found.");
  }
});

// Handle text messages
bot.on("message:text", async (ctx) => {
  const msgPreview = ctx.message.text.slice(0, 80);
  log.info("msg", `Text received: "${msgPreview}${ctx.message.text.length > 80 ? "..." : ""}"`);
  const startTime = Date.now();

  const stopTyping = keepTyping(() =>
    ctx.replyWithChatAction("typing"),
  );

  try {
    const response = await chat(ctx.from!.id, ctx.message.text);
    stopTyping();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info("msg", `Response ready (${elapsed}s, ${response.length} chars)`);

    const chunks = chunkMessage(response);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(chunk);
      }
    }

    await sendOutboxFiles(ctx.api, ctx.chat.id);
  } catch (error: any) {
    stopTyping();
    log.error("msg", "Chat error", { error: error.message, stack: error.stack });
    await ctx.reply(`Error: ${error.message || "Unknown error"}`);
  }
});

// Handle photos
bot.on("message:photo", async (ctx) => {
  log.info("msg", "Photo received", { caption: ctx.message.caption || "(none)" });
  const startTime = Date.now();

  const stopTyping = keepTyping(() =>
    ctx.replyWithChatAction("typing"),
  );

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const photoUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;

    const caption = ctx.message.caption;
    const response = await chatWithPhoto(ctx.from!.id, photoUrl, caption);
    stopTyping();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info("msg", `Photo response ready (${elapsed}s, ${response.length} chars)`);

    const chunks = chunkMessage(response);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(chunk);
      }
    }

    await sendOutboxFiles(ctx.api, ctx.chat.id);
  } catch (error: any) {
    stopTyping();
    log.error("msg", "Photo error", { error: error.message, stack: error.stack });
    await ctx.reply(`Error: ${error.message || "Unknown error"}`);
  }
});
