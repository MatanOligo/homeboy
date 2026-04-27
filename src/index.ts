import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { bot } from "./bot.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

const LOCK_FILE = "/tmp/homeboy.lock";
try {
  const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // throws if process doesn't exist
    console.error(`[boot] Another instance already running (PID ${pid}). Exiting.`);
    process.exit(1);
  } catch {}
  // stale lock from a crashed process — overwrite below
} catch {}
writeFileSync(LOCK_FILE, String(process.pid));
process.on("exit", () => { try { unlinkSync(LOCK_FILE); } catch {} });

log.info("boot", "Homeboy starting", {
  model: config.model,
  allowedUser: config.allowedUserId,
  workingDir: config.workingDir,
});

bot.start({
  onStart: async (botInfo) => {
    log.info("boot", `Bot online as @${botInfo.username}`);
    startScheduler(bot.api, config.allowedUserId);
    await bot.api.sendMessage(config.allowedUserId, `@${botInfo.username} is online.`);
  },
});

bot.catch((err) => {
  log.error("bot", "Unhandled bot error", { error: err.message || String(err) });
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log.info("boot", `${signal} received, shutting down`);
    stopScheduler();
    bot.stop();
    process.exit(0);
  });
}

process.on("uncaughtException", (err) => {
  log.error("process", "Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("process", "Unhandled rejection", { reason: String(reason) });
});
