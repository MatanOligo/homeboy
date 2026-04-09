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
  deleteTask,
  updateTask,
  getNextCronRun,
  type Task,
} from "./db.js";
import { config } from "./config.js";
import { log } from "./logger.js";

function formatTask(t: Task): string {
  const status = t.status === "active" ? "active" : "completed";
  const schedule =
    t.schedule_type === "cron"
      ? `cron(${t.cron_expression})`
      : t.schedule_type === "interval"
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
  "Create a scheduled task. Tasks are persisted in a database and will keep running as long as the bot process is running — they are NOT tied to the current conversation session. Each task runs in an isolated AI session with full tool access (Bash, files, web, etc). Use this for one-time or recurring tasks the user wants automated.",
  {
    name: z.string().describe("Short task name (2-5 words)"),
    prompt: z
      .string()
      .describe(
        "Detailed instruction for the AI to execute when the task runs",
      ),
    schedule_type: z
      .enum(["once", "interval", "cron"])
      .describe("'once' for one-time, 'interval' for fixed-interval recurring, 'cron' for cron expression-based scheduling"),
    interval_seconds: z
      .number()
      .nullable()
      .describe("Seconds between runs (for interval tasks). null otherwise"),
    cron_expression: z
      .string()
      .nullable()
      .describe("Cron expression for scheduling (for cron tasks), e.g. '0 9 * * *' for every day at 9am. null otherwise"),
    run_at: z
      .number()
      .nullable()
      .describe(
        "Unix timestamp for when to run (one-time tasks). null otherwise. Current unix timestamp: " +
          Math.floor(Date.now() / 1000),
      ),
  },
  async (args) => {
    let nextRunAt: number;
    if (args.schedule_type === "once") {
      nextRunAt = args.run_at!;
    } else if (args.schedule_type === "cron") {
      nextRunAt = getNextCronRun(args.cron_expression!);
    } else {
      nextRunAt = Math.floor(Date.now() / 1000) + (args.interval_seconds || 0);
    }

    const task = createTask({
      name: args.name,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      interval_seconds: args.interval_seconds,
      cron_expression: args.cron_expression,
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

const deleteTaskTool = tool(
  "delete_task",
  "Permanently delete a task by its ID (removes it from the database entirely). Use this to clean up completed or cancelled tasks. For stopping an active task, prefer cancel_task.",
  {
    task_id: z.number().describe("The task ID to delete"),
  },
  async (args) => {
    const task = getTask(args.task_id);
    if (!task) {
      return {
        content: [{ type: "text" as const, text: `Task #${args.task_id} not found.` }],
      };
    }

    deleteTask(args.task_id);
    log.info("tools", `Task #${args.task_id} deleted`);
    return {
      content: [{ type: "text" as const, text: `Task #${args.task_id} (${task.name}) deleted permanently.` }],
    };
  },
);

const updateTaskTool = tool(
  "update_task",
  "Update an existing task's prompt and/or schedule (cron expression or interval). Only the fields you provide will be changed. If the cron expression or interval changes, next_run_at is recalculated automatically.",
  {
    task_id: z.number().describe("The task ID to update"),
    prompt: z.string().nullable().describe("New prompt text, or null to leave unchanged"),
    cron_expression: z.string().nullable().describe("New cron expression (for cron tasks), or null to leave unchanged"),
    interval_seconds: z.number().nullable().describe("New interval in seconds (for interval tasks), or null to leave unchanged"),
  },
  async (args) => {
    const task = getTask(args.task_id);
    if (!task) {
      return {
        content: [{ type: "text" as const, text: `Task #${args.task_id} not found.` }],
      };
    }

    const updates: { prompt?: string; cron_expression?: string; interval_seconds?: number } = {};
    if (args.prompt != null) updates.prompt = args.prompt;
    if (args.cron_expression != null) updates.cron_expression = args.cron_expression;
    if (args.interval_seconds != null) updates.interval_seconds = args.interval_seconds;

    if (Object.keys(updates).length === 0) {
      return {
        content: [{ type: "text" as const, text: "No updates provided." }],
      };
    }

    const updated = updateTask(args.task_id, updates);
    log.info("tools", `Task #${args.task_id} updated`);
    return {
      content: [{ type: "text" as const, text: `Task #${args.task_id} updated.\n${formatTask(updated!)}` }],
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
  tools: [scheduleTask, listTasks, cancelTaskTool, deleteTaskTool, updateTaskTool, saveMemory],
});
