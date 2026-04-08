# Homeboy

Personal AI assistant on Telegram, powered by Claude Agent SDK.

## Quick Reference

- **Telegram commands**: `telegram_commands.md` — all bot commands and their behavior
- **System prompt**: `system-prompt.txt` — edit this file to change the AI's system prompt (restart required)
- **Config**: `.env` (see `.env.example` for all variables)
- **Logs**: `data/homeboy.log`
- **Database**: `data/homeboy.db` — scheduled tasks (SQLite)
- **Sessions**: `data/sessions.json`
- **Memory**: `data/memory.md` — persistent memory across sessions

## Running

```bash
npm run dev     # development with auto-reload
npm start       # production
# or via systemd:
sudo systemctl start homeboy
```

## Project Structure

Source lives in `src/`:
- `index.ts` — entry point
- `bot.ts` — Telegram bot, commands, message handlers
- `assistant.ts` — Claude Agent SDK wrapper, session management
- `tools.ts` — custom MCP tools (schedule_task, list_tasks, cancel_task, save_memory)
- `config.ts` — typed env config, system prompt loading
- `db.ts` — SQLite database, scheduled tasks CRUD
- `scheduler.ts` — task scheduler loop, runs tasks in isolated Claude sessions
- `logger.ts` — file + console logger
- `utils.ts` — message chunking, typing indicator

## Maintenance

When making major changes (new features, new files, architectural changes, new commands), update:
- **This file (`CLAUDE.md`)** — keep the project structure and quick reference accurate
- **`README.md`** — keep features, setup, commands, and architecture sections in sync
