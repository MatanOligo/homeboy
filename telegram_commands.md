# Telegram Bot Commands

Commands registered with your bot. To update them on Telegram, run:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"new","description":"Start a fresh conversation"},
    {"command":"schedule","description":"Schedule a task"},
    {"command":"tasks","description":"List all scheduled tasks"},
    {"command":"cancel","description":"Cancel a scheduled task"},
    {"command":"model","description":"View or switch Claude model"},
    {"command":"status","description":"Bot status, uptime, session info"},
    {"command":"log","description":"Show recent log entries"},
    {"command":"restart","description":"Restart the bot"},
    {"command":"help","description":"List all commands"}
  ]}'
```

## Command Reference

### /new
Start a fresh conversation. Clears the current Claude session so the next message begins a new one.

### /model [name]
- Without argument: shows the current model (e.g. `claude-sonnet-4-6`)
- With argument: switches to that model immediately (e.g. `/model claude-opus-4-6`)
- Change is runtime-only — restart resets to the value in `.env`

### /status
Shows:
- **Uptime** — how long the bot has been running
- **Model** — current Claude model
- **Session** — current session ID (truncated) or "none"
- **Working dir** — where Claude tools execute

### /schedule <description>
Schedule a task using natural language. This forwards your description to Claude, which has native `schedule_task` tools.

Examples:
- `/schedule check disk usage every 6 hours`
- `/schedule in 2 hours remind me to check deploys`
- `/schedule every 30 minutes check if the API is up`

You can also schedule tasks conversationally without the command — just say "schedule a disk check every 6 hours" in chat.

Each task run executes in an isolated Claude session with full tool access. Results are sent back to the chat when complete.

### /tasks
Lists all scheduled tasks with their status, schedule, next run time, and prompt.

- `●` = active
- `○` = completed/cancelled

### /cancel <id>
Cancel an active scheduled task by its ID (shown in `/tasks` output).

### /restart
Restarts the bot process. The bot sends "Restarting..." and exits — systemd automatically brings it back up within a few seconds.

### /log [n]
Shows the last `n` log entries (default 20). Reads from `data/homeboy.log`.

### /help
Lists all available commands with brief descriptions.

### /start
Welcome message shown when first opening the bot chat. Lists available commands.

## Notes

- Any non-command text message is sent directly to Claude as a conversation message.
- Photos are sent to Claude for vision analysis. Captions are included if provided.
- Only messages from the authorized user ID are processed; all others are silently ignored.
