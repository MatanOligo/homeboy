import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { log } from "./logger.js";
import { taskToolsServer } from "./tools.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

interface SessionStore {
  [userId: string]: {
    sessionId: string;
  };
}

function loadSessions(): SessionStore {
  try {
    return JSON.parse(readFileSync(config.sessionsFile, "utf-8"));
  } catch {
    return {};
  }
}

function saveSessions(store: SessionStore): void {
  mkdirSync(dirname(config.sessionsFile), { recursive: true });
  writeFileSync(config.sessionsFile, JSON.stringify(store, null, 2));
}

let currentModel = config.model;

export function getModel(): string {
  return currentModel;
}

export function setModel(model: string): void {
  currentModel = model;
}

export function getSessionId(userId: number): string {
  const store = loadSessions();
  return store[userId]?.sessionId || "";
}

export function resetSession(userId: number): void {
  const store = loadSessions();
  store[userId] = { sessionId: "" };
  saveSessions(store);
}

const BASE_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Agent",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
];

function baseOptions() {
  return {
    systemPrompt: config.systemPrompt,
    cwd: config.workingDir,
    model: currentModel,
    allowedTools: BASE_TOOLS,
    permissionMode: "bypassPermissions" as const,
    maxTurns: 50,
    mcpServers: {
      "homeboy-tasks": taskToolsServer,
    },
  };
}

/** Stream a query and collect the text response + session id. */
async function streamQuery(
  prompt: string,
  opts: Record<string, unknown>,
): Promise<{ text: string; sessionId: string }> {
  let responseText = "";
  let sessionId = "";
  let toolUseCount = 0;

  const conversation = query({ prompt, options: opts as any });

  for await (const msg of conversation) {
    if (msg.type === "system" && "session_id" in msg) {
      sessionId = (msg as any).session_id;
    }

    if (msg.type === "assistant") {
      const assistantMsg = msg as any;
      if (assistantMsg.message?.content) {
        for (const block of assistantMsg.message.content) {
          if (block.type === "text") {
            responseText += block.text;
          }
          if (block.type === "tool_use") {
            toolUseCount++;
            log.info("claude", `Tool call: ${block.name}`, {
              id: block.id,
              input: JSON.stringify(block.input).slice(0, 200),
            });
          }
        }
      }
    }

    if (msg.type === "result") {
      const result = msg as any;
      if (!responseText && result.result) {
        responseText = result.result;
      }
      if (result.session_id) {
        sessionId = result.session_id;
      }
      log.info("claude", "Query complete", {
        tools_used: toolUseCount,
        response_length: responseText.length,
        cost_usd: result.cost_usd || result.total_cost_usd,
        duration_ms: result.duration_ms,
        num_turns: result.num_turns,
      });
    }
  }

  return { text: responseText || "(no response)", sessionId };
}

export async function chat(userId: number, message: string): Promise<string> {
  const store = loadSessions();
  const sessionId = store[userId]?.sessionId;

  const options: Record<string, unknown> = { ...baseOptions() };

  if (sessionId) {
    options.resume = sessionId;
  }

  log.info(
    "claude",
    sessionId
      ? `Resuming session ${sessionId.slice(0, 8)}...`
      : "Creating new session",
    { model: currentModel, messageLength: message.length },
  );

  try {
    const result = await streamQuery(message, options);

    if (result.sessionId) {
      store[userId] = { sessionId: result.sessionId };
      saveSessions(store);
    }

    return result.text;
  } catch (error: any) {
    if (sessionId) {
      log.warn("claude", "Resume failed, creating new session", {
        error: error.message,
      });
      resetSession(userId);
      return chat(userId, message);
    }
    log.error("claude", "Query failed", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export async function runTask(prompt: string): Promise<string> {
  log.info("claude", "Running scheduled task", {
    promptLength: prompt.length,
  });

  // Task runs get their own isolated session — no resume, no task tools
  const options: Record<string, unknown> = {
    systemPrompt: config.systemPrompt,
    cwd: config.workingDir,
    model: currentModel,
    allowedTools: BASE_TOOLS,
    permissionMode: "bypassPermissions" as const,
    maxTurns: 50,
  };

  const result = await streamQuery(prompt, options);
  return result.text;
}

export async function chatWithPhoto(
  userId: number,
  photoUrl: string,
  caption?: string,
): Promise<string> {
  const message = caption
    ? `[The user sent a photo: ${photoUrl}]\n\n${caption}`
    : `[The user sent a photo: ${photoUrl}]\nPlease analyze this image.`;
  return chat(userId, message);
}
