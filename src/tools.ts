import {
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  createTask,
  getAllTasks,
  getTask,
  cancelTask,
  type Task,
} from "./db.js";
import { config } from "./config.js";
import { log } from "./logger.js";

function formatTask(t: Task): string {
  const status = t.status === "active" ? "active" : "completed";
  const schedule =
    t.schedule_type === "interval"
      ? `every ${t.interval_seconds}s`
      : "one-time";
  const nextRun =
    t.status === "active"
      ? new Date(t.next_run_at * 1000).toISOString()
      : "done";
  return [
    `id=${t.id}`,
    `name="${t.name}"`,
    `status=${status}`,
    `schedule=${schedule}`,
    `next_run=${nextRun}`,
    `prompt="${t.prompt}"`,
  ].join(" | ");
}

const scheduleTask = tool(
  "schedule_task",
  "Create a scheduled task. The task will run in an isolated AI session with full tool access (Bash, files, web, etc). Use this for one-time or recurring tasks the user wants automated.",
  {
    name: z.string().describe("Short task name (2-5 words)"),
    prompt: z
      .string()
      .describe(
        "Detailed instruction for the AI to execute when the task runs",
      ),
    schedule_type: z
      .enum(["once", "interval"])
      .describe("'once' for one-time, 'interval' for recurring"),
    interval_seconds: z
      .number()
      .nullable()
      .describe("Seconds between runs (for interval tasks). null for one-time tasks"),
    run_at: z
      .number()
      .nullable()
      .describe(
        "Unix timestamp for when to run (one-time tasks). null for interval tasks. Current unix timestamp: " +
          Math.floor(Date.now() / 1000),
      ),
  },
  async (args) => {
    const nextRunAt =
      args.schedule_type === "once"
        ? args.run_at!
        : Math.floor(Date.now() / 1000) + (args.interval_seconds || 0);

    const task = createTask({
      name: args.name,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      interval_seconds: args.interval_seconds,
      next_run_at: nextRunAt,
    });

    log.info("tools", `Task #${task.id} created: ${task.name}`);

    return {
      content: [
        {
          type: "text" as const,
          text: `Task #${task.id} created successfully.\n${formatTask(task)}`,
        },
      ],
    };
  },
);

const listTasks = tool(
  "list_tasks",
  "List all scheduled tasks with their status, schedule, next run time, and prompt.",
  {},
  async () => {
    const tasks = getAllTasks();

    if (tasks.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No tasks found." }],
      };
    }

    const lines = tasks.map(formatTask);
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
);

const cancelTaskTool = tool(
  "cancel_task",
  "Cancel an active scheduled task by its ID.",
  {
    task_id: z.number().describe("The task ID to cancel"),
  },
  async (args) => {
    const task = getTask(args.task_id);
    if (!task) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Task #${args.task_id} not found.`,
          },
        ],
      };
    }

    if (cancelTask(args.task_id)) {
      log.info("tools", `Task #${args.task_id} cancelled`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Task #${args.task_id} (${task.name}) cancelled.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Task #${args.task_id} is already completed or cancelled.`,
        },
      ],
    };
  },
);

const saveMemory = tool(
  "save_memory",
  "Save important information to persistent memory. Use this to remember facts, preferences, or anything the user asks you to remember. Memory persists across sessions. Always tell the user what you saved.",
  {
    content: z
      .string()
      .describe(
        "The memory entry to save. Use a clear, concise format — e.g. 'User prefers dark mode' or '- Server IP: 10.0.0.1'",
      ),
  },
  async (args) => {
    mkdirSync(dirname(config.memoryFile), { recursive: true });

    let existing = "";
    try {
      existing = readFileSync(config.memoryFile, "utf-8");
    } catch {}

    const updated = existing
      ? `${existing.trimEnd()}\n${args.content}\n`
      : `${args.content}\n`;

    writeFileSync(config.memoryFile, updated);
    log.info("memory", `Saved: ${args.content.slice(0, 100)}`);

    return {
      content: [
        {
          type: "text" as const,
          text: `Saved to memory: ${args.content}`,
        },
      ],
    };
  },
);

export const taskToolsServer = createSdkMcpServer({
  name: "homeboy-tasks",
  version: "1.0.0",
  tools: [scheduleTask, listTasks, cancelTaskTool, saveMemory],
});
