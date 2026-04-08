import { readdirSync, unlinkSync, mkdirSync } from "fs";
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
      const fileInput = new InputFile(filepath);

      if (PHOTO_EXTENSIONS.has(ext)) {
        await api.sendPhoto(chatId, fileInput);
      } else {
        await api.sendDocument(chatId, fileInput);
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
