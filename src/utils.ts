import { readdirSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { InputFile, type Api } from "grammy";

const TELEGRAM_MAX_LENGTH = 4096;

const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Check the outbox directory for files, send them to Telegram, then clean up.
 */
export async function sendOutboxFiles(
  api: Api,
  chatId: number,
): Promise<void> {
  mkdirSync(config.outboxDir, { recursive: true });

  let files: string[];
  try {
    files = readdirSync(config.outboxDir);
  } catch {
    return;
  }

  for (const filename of files) {
    const filepath = join(config.outboxDir, filename);
    const ext = extname(filename).toLowerCase();

    try {
      if (PHOTO_EXTENSIONS.has(ext)) {
        await api.sendPhoto(chatId, new InputFile(filepath));
      } else if (ext === ".txt") {
        // Send text files as messages so markdown links are clickable
        const text = readFileSync(filepath, "utf-8");
        const chunks = chunkMessage(text);
        for (const chunk of chunks) {
          try {
            await api.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
          } catch {
            await api.sendMessage(chatId, chunk);
          }
        }
      } else {
        await api.sendDocument(chatId, new InputFile(filepath));
      }

      log.info("outbox", `Sent file: ${filename}`);
      unlinkSync(filepath);
    } catch (error: any) {
      log.error("outbox", `Failed to send file: ${filename}`, { error: error.message });
    }
  }
}

/**
 * Split a long message into chunks that fit Telegram's message limit.
 * Tries to split at newlines, then at spaces, then hard-cuts.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    }
    if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
      splitAt = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert a 5-field cron expression into a human-readable English string.
 * e.g. "0 8,10,12 * * *"      => "at 8:00 AM, 10:00 AM, 12:00 PM"
 *      "every-30 * 23-28 5 *" => "every 30 minutes on days 23-28 of May"
 */
export function cronBeautify(cron: string): string {
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

  // every minute: * * * * *
  if (cron.trim() === "* * * * *") return "every minute";

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
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") {
    const t = formatTime(hour, min);
    if (t) return `every day at ${t}`;
  }

  // weekdays at HH:MM: M H * * 1-5
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "1-5") {
    const t = formatTime(hour, min);
    if (t) return `weekdays at ${t}`;
  }

  // weekends at HH:MM: M H * * 6,0 or 0,6
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && (dow === "6,0" || dow === "0,6" || dow === "6-7")) {
    const t = formatTime(hour, min);
    if (t) return `weekends at ${t}`;
  }

  // specific day of week: M H * * D
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && /^[0-6]$/.test(dow)) {
    const t = formatTime(hour, min);
    const dayName = DAYS[parseInt(dow, 10)];
    if (t && dayName) return `every ${dayName} at ${t}`;
  }

  // day of month: M H D * *
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && month === "*" && dow === "*") {
    const t = formatTime(hour, min);
    const d = parseInt(dom, 10);
    if (t && !isNaN(d)) return `${ordinal(d)} of every month at ${t}`;
  }

  // specific date: M H D Mo *
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
    const t = formatTime(hour, min);
    const d = parseInt(dom, 10);
    const mo = parseInt(month, 10);
    if (t && !isNaN(d) && !isNaN(mo) && mo >= 1 && mo <= 12) {
      return `${MONTHS[mo - 1]} ${ordinal(d)} at ${t}`;
    }
  }

  // --- General builder for complex/combined patterns ---
  const desc: string[] = [];

  if (min === "*" && hour === "*") {
    desc.push("every minute");
  } else if (min.startsWith("*/") && hour === "*") {
    const n = parseInt(min.slice(2), 10);
    desc.push(`every ${n} minute${n !== 1 ? "s" : ""}`);
  } else if (min === "0" && hour.startsWith("*/")) {
    const n = parseInt(hour.slice(2), 10);
    desc.push(`every ${n} hour${n !== 1 ? "s" : ""}`);
  } else if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const t = formatTime(hour, min);
    if (t) desc.push(`at ${t}`);
  } else if (min === "0" && /^[\d,]+$/.test(hour)) {
    const hours = hour.split(",").map(h => formatTime(h, "0") ?? h);
    desc.push(`at ${hours.join(", ")}`);
  } else {
    desc.push(`[${min} ${hour}]`);
  }

  if (dom !== "*") {
    if (/^\d+$/.test(dom)) {
      desc.push(`on the ${ordinal(parseInt(dom, 10))}`);
    } else if (/^\d+-\d+$/.test(dom)) {
      const [s, e] = dom.split("-");
      desc.push(`on days ${s}–${e}`);
    } else {
      desc.push(`on day ${dom}`);
    }
  }

  if (month !== "*") {
    if (/^\d+$/.test(month)) {
      const mo = parseInt(month, 10);
      desc.push(mo >= 1 && mo <= 12 ? `of ${MONTHS[mo - 1]}` : `of month ${month}`);
    } else if (/^\d+-\d+$/.test(month)) {
      const [ms, me] = month.split("-").map(Number);
      desc.push(`of ${MONTHS[ms - 1] ?? ms}–${MONTHS[me - 1] ?? me}`);
    } else {
      desc.push(`of month ${month}`);
    }
  }

  if (dow !== "*") {
    if (/^[0-6]$/.test(dow)) desc.push(`on ${DAYS[parseInt(dow, 10)]}`);
    else if (dow === "1-5") desc.push("on weekdays");
    else if (dow === "6,0" || dow === "0,6") desc.push("on weekends");
    else desc.push(`on ${dow}`);
  }

  return desc.join(" ");
}

/**
 * Create a typing indicator that stays alive until stopped.
 * Telegram typing indicators expire after ~5 seconds.
 */
export function keepTyping(
  sendAction: () => Promise<unknown>,
): () => void {
  sendAction().catch(() => {});
  const interval = setInterval(() => {
    sendAction().catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}
