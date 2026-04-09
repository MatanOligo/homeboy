<p align="center">
  <img src="assets/logo.svg" alt="Homeboy logo" width="180"/>
</p>

<h1 align="center">Homeboy</h1>

<p align="center">
  <img src="assets/demo.svg" alt="Homeboy demo" width="420"/>
</p>

Control a fully functional computer, or remote machine, with AI from your phone.

Install any Software/CLI you need and the bot could run it for you — remotely, conversationally, instantly or scheduled, no limits.

A personal AI assistant that lives in Telegram, powered by the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk). It gives Claude full access to your machine — bash, filesystem, network, and custom tools — through a conversational Telegram interface.

**Lightweight by design** — the entire project is ~10 files of readable TypeScript, with only 4 runtime dependencies and **0 known vulnerabilities**. Small codebase, minimal attack surface, easy to audit and understand.

## Features

- **Full machine access** — Claude can run commands, read/write files, browse the web, and more
- **Persistent conversations** — sessions are saved and resumed automatically
- **Photo analysis** — send photos for Claude to analyze via vision
- **Scheduled tasks** — schedule one-time or recurring tasks in natural language (e.g. "check disk usage every 6 hours")
- **File sharing** — Claude can send you files, screenshots, and generated output directly in chat
- **Model switching** — swap between Claude models at runtime
- **Persistent memory** — the bot remembers important facts and preferences across sessions
- **Single-user auth** — only your Telegram account can interact with the bot

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)
- Node.js 20+
- A [Telegram bot token](https://core.telegram.org/bots#how-do-i-create-a-bot) from @BotFather


## Setup

```bash
git clone https://github.com/MatanOligo/homeboy.git
cd homeboy
```

### Option A: Interactive setup (recommended)

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (and you must lol), run the setup wizard:

```bash
claude /setup
```

It will check prerequisites, install dependencies, configure your `.env`, and optionally register Telegram commands and set up systemd — all interactively.

### Option B: Manual setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_ID` | Your Telegram user ID (get it from @userinfobot) |
| `CLAUDE_MODEL` | Claude model to use (default: `claude-sonnet-4-6`) |
| `WORKING_DIR` | Directory where Claude executes commands (default: `.`) |
| `MAX_MESSAGE_AGE` | Seconds before stale messages are dropped (default: `60`) |

## Running

```bash
# Development (auto-reload on changes)
npm run dev

# Production
npm start
```

### Systemd (optional)

A sample systemd service file is included at `homeboy.service`. Edit the paths to match your setup, then:

```bash
sudo cp homeboy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now homeboy
```

The bot auto-restarts on crashes. View logs with `journalctl -u homeboy -f`.

## Commands

| Command | Description |
|---|---|
| `/new` | Start a fresh conversation |
| `/schedule <desc>` | Schedule a task in natural language |
| `/tasks` | List all scheduled tasks |
| `/cancel <id>` | Cancel a scheduled task |
| `/model [name]` | View or switch Claude model |
| `/status` | Bot status, uptime, session info |
| `/log [n]` | Show recent log entries |
| `/restart` | Restart the bot |
| `/help` | List all commands |

Any non-command text is sent directly to Claude. Photos are analyzed via Claude's vision.

You can also schedule tasks conversationally — just say "check disk usage every 6 hours" in chat.

## Architecture

```
src/
  index.ts        Entry point, boot sequence, signal handling
  bot.ts          Telegram bot, commands, message handlers
  assistant.ts    Claude Agent SDK wrapper, session management
  tools.ts        Custom MCP tools (schedule_task, list_tasks, cancel_task, save_memory)
  config.ts       Typed env config, system prompt loading
  db.ts           SQLite database for scheduled tasks
  scheduler.ts    Task scheduler loop, runs tasks in isolated sessions
  logger.ts       File + console logger
  utils.ts        Message chunking, typing indicator, file sending
```

- **Sessions** are persisted in `data/sessions.json` and resumed automatically
- **Scheduled tasks** are stored in `data/homeboy.db` (SQLite)
- **Logs** go to `data/homeboy.log` and stdout
- **Memory** is stored in `data/memory.md` — loaded into the system prompt on each new session
- **Outbox** — Claude saves files to `data/outbox/`, which are automatically sent to you and deleted

## Customization

Edit `system-prompt.txt` to change the AI's personality and instructions. The `{{OUTBOX_DIR}}` placeholder is replaced at runtime with the actual outbox path — no need to hardcode it.

## Extending with MCP servers

Since the bot has full bash access, it can use any CLI tool installed on the machine. With [mcporter](https://github.com/AshDevFr/mcporter), the bot can install and manage [MCP servers](https://modelcontextprotocol.io/) on demand — you can even ask the bot to install mcporter itself and then set up any MCP servers you need, all through chat.

```bash
# Or just ask the bot to run this for you:
npm install -g mcporter
```

## Security

This bot gives Claude **full access to your machine** with no sandboxing. Only messages from your `ALLOWED_USER_ID` are processed; all others are silently ignored.

**Recommended deployment**: run Homeboy on a dedicated remote machine (e.g. AWS EC2, DigitalOcean droplet, Hetzner VPS) behind a VPN rather than on your personal computer. Since you'll likely give the bot access tokens and credentials to operate on your behalf (cloud providers, APIs, databases, etc.), isolating it on a locked-down remote instance limits the blast radius and keeps your personal machine out of scope.

Do not expose this bot to untrusted users.

## License

[MIT](LICENSE)
