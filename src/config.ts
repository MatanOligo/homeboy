import "dotenv/config";
import { readFileSync } from "fs";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return value;
}

const PROMPT_FILE = new URL("../system-prompt.txt", import.meta.url).pathname;

function loadSystemPrompt(outboxDir: string): string {
  try {
    const raw = readFileSync(PROMPT_FILE, "utf-8").trim();
    return raw.replace("{{OUTBOX_DIR}}", outboxDir);
  } catch {
    return "You are a personal AI assistant with full access to the host machine. Be helpful and concise.";
  }
}

const outboxDir = new URL("../data/outbox/", import.meta.url).pathname;

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUserId: Number(required("ALLOWED_USER_ID")),
  model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  systemPrompt: loadSystemPrompt(outboxDir),
  workingDir: process.env.WORKING_DIR || process.cwd(),
  maxMessageAge: Number(process.env.MAX_MESSAGE_AGE || "60"),
  sessionsFile: new URL("../data/sessions.json", import.meta.url).pathname,
  outboxDir,
  promptFile: PROMPT_FILE,
};
