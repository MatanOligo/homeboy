---
name: setup
description: Interactive setup wizard for new Homeboy installations. Checks prerequisites, installs dependencies, and walks through configuration.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash Read Write Edit Glob Grep
---

# Homeboy Setup Wizard

You are helping a user set up Homeboy (a personal AI assistant on Telegram, powered by Claude Agent SDK) on their machine. Walk through each step below **in order**, checking and confirming each one before moving on. Be friendly and concise.

## Step 1: Check prerequisites

Run these checks and report the results:

1. **Node.js** — run `node --version`. Require v20+. If missing or too old, tell the user how to install it.
2. **npm** — run `npm --version`. Should come with Node.
3. **Current directory** — confirm we're in the Homeboy project root by checking that `package.json` exists and has `"name": "homeboy"`.

If any check fails, stop and help the user fix it before continuing.

## Step 2: Install dependencies

Run `npm install`. Report success or any errors.

## Step 3: Configure environment

1. Check if `.env` already exists. If it does, ask if the user wants to reconfigure or skip.
2. If creating fresh, copy `.env.example` to `.env`.
3. Walk through each variable one at a time, asking the user for their value:

   - **TELEGRAM_BOT_TOKEN** — Ask the user to paste their bot token. If they don't have one yet, explain:
     > Open Telegram, find **@BotFather**, send `/newbot`, follow the prompts, and copy the token it gives you.

   - **ALLOWED_USER_ID** — Ask the user for their Telegram user ID. If they don't know it, explain:
     > Open Telegram, find **@userinfobot**, send `/start`, and it will reply with your user ID.

   - **CLAUDE_MODEL** — Ask which model they want (default: `claude-sonnet-4-6`). Mention `claude-opus-4-6` as the most capable option.

   - **WORKING_DIR** — Ask what directory Claude should have as its working directory (default: `.` which means the Homeboy project directory).

   - **MAX_MESSAGE_AGE** — Explain this controls how many seconds old a message can be before it's dropped (useful when the bot restarts and has queued messages). Default `60` is fine for most users.

4. Write the final `.env` file with their values.

## Step 4: Verify Anthropic API key

Check if `ANTHROPIC_API_KEY` is set in the environment (`echo $ANTHROPIC_API_KEY`). If not, tell the user:
> You need an Anthropic API key. Get one at https://console.anthropic.com/. Then either:
> - Add `ANTHROPIC_API_KEY=sk-ant-...` to your `.env` file, or
> - Export it in your shell profile: `export ANTHROPIC_API_KEY=sk-ant-...`

## Step 5: Register bot commands (optional)

Ask the user if they want to register the bot commands with Telegram (so they show up in the command menu). If yes, run:

```bash
source .env && curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
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

Confirm the result is `{"ok":true, ...}`.

## Step 6: Test run

Ask the user if they want to do a test run. If yes:
1. Run `npm run dev` (note: this will block, so tell the user to send a message to their bot on Telegram to verify it works, then Ctrl+C to stop).

## Step 7: Systemd setup (optional)

Ask if they want to set up Homeboy as a systemd service so it runs on boot. If yes:
1. Read `homeboy.service`
2. Create a copy with the correct `User`, `WorkingDirectory`, and `EnvironmentFile` paths filled in for their machine
3. Guide them through:
   ```bash
   sudo cp homeboy.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now homeboy
   ```

## Done

Summarize what was configured and how to use the bot:
- `npm run dev` for development
- `npm start` for production
- `sudo systemctl start homeboy` if systemd was set up
- Point them to the README for command reference
