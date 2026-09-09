import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

// Path to the claude CLI. The systemd service inherits the user's PATH, but be
// defensive: prepend the well-known install dir so `script`/`claude` resolve
// even when the process PATH is minimal.
const CLAUDE_BIN_DIR = "/home/oc/.local/bin";

// How long to wait for the OAuth URL to appear on stdout before giving up.
const URL_TIMEOUT_MS = 30_000;
// How long the whole reauth flow may stay open awaiting a code before auto-abort.
const FLOW_TIMEOUT_MS = 5 * 60_000;

type Phase = "idle" | "awaiting_url" | "awaiting_code" | "exchanging";

interface ReauthState {
  phase: Phase;
  proc: ChildProcessWithoutNullStreams | null;
  url: string | null;
  buffer: string;
  flowTimer: NodeJS.Timeout | null;
}

const state: ReauthState = {
  phase: "idle",
  proc: null,
  url: null,
  buffer: "",
  flowTimer: null,
};

function stripAnsi(s: string): string {
  // CSI, OSC (BEL- *and* ST-terminated — e.g. OSC-8 hyperlinks), and stray
  // 2-char escape sequences. ST-terminated OSC (ESC \) must be stripped too,
  // otherwise hyperlinked URLs get emitted twice and the capture concatenates
  // them into one broken link.
  return s
    .replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[78]/g, "")
    .replace(/\x1b./g, "");
}

function reset(): void {
  if (state.flowTimer) clearTimeout(state.flowTimer);
  if (state.proc && !state.proc.killed) {
    try {
      state.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  state.phase = "idle";
  state.proc = null;
  state.url = null;
  state.buffer = "";
  state.flowTimer = null;
}

export function isAwaitingCode(): boolean {
  return state.phase === "awaiting_code";
}

export function isActive(): boolean {
  return state.phase !== "idle";
}

export function cancelReauth(): boolean {
  if (state.phase === "idle") return false;
  log.info("reauth", "Cancelled by request");
  reset();
  return true;
}

/**
 * Start the `claude auth login` flow inside a PTY (via util-linux `script`),
 * capture the OAuth URL from stdout, and resolve with it. The process is left
 * running, waiting for the user's code (fed later via submitCode()).
 */
export function startReauth(): Promise<{
  url?: string;
  error?: string;
  alreadyRunning?: boolean;
}> {
  if (state.phase !== "idle") {
    // A flow is already in progress — hand back the URL we already have so the
    // caller can re-send it, rather than spawning a second login.
    return Promise.resolve({
      url: state.url ?? undefined,
      alreadyRunning: true,
    });
  }

  return new Promise((resolve) => {
    state.phase = "awaiting_url";
    state.buffer = "";
    state.url = null;

    const env = {
      ...process.env,
      NO_COLOR: "1",
      PATH: `${CLAUDE_BIN_DIR}:${process.env.PATH ?? ""}`,
    };

    // `script -q -e -f -c "<cmd>" /dev/null` allocates a real PTY so the CLI
    // runs interactively; -f flushes so we see the URL immediately; -e makes
    // script exit with the child's status.
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(
        "script",
        ["-qefc", "claude auth login --claudeai", "/dev/null"],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      ) as ChildProcessWithoutNullStreams;
    } catch (err: any) {
      state.phase = "idle";
      resolve({ error: `Failed to spawn login: ${err.message}` });
      return;
    }

    state.proc = proc;

    let settled = false;
    const urlTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        log.error("reauth", "Timed out waiting for OAuth URL");
        reset();
        resolve({ error: "Timed out waiting for the login URL." });
      }
    }, URL_TIMEOUT_MS);

    // Overall flow timeout (covers the awaiting_code window too).
    state.flowTimer = setTimeout(() => {
      log.warn("reauth", "Flow timed out; aborting");
      reset();
    }, FLOW_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8"));
      state.buffer += text;

      if (!state.url) {
        const m = state.buffer.match(
          /https:\/\/[^\s"']*oauth\/authorize[^\s"']*/,
        );
        // Only accept once a terminator follows the match in the buffer —
        // otherwise a chunk that split mid-URL would yield a truncated link.
        const terminated =
          m != null && m.index! + m[0].length < state.buffer.length;
        if (m && terminated) {
          // Defensive de-dup: if a doubled/echoed URL slipped through (e.g. an
          // OSC-8 hyperlink whose escape wrapper wasn't stripped), cut at the
          // start of the second copy so we hand back one valid link.
          let url = m[0];
          const second = url.indexOf("https://", 1);
          if (second !== -1) url = url.slice(0, second);
          state.url = url;
          state.phase = "awaiting_code";
          log.info("reauth", "Captured OAuth URL, awaiting code");
          if (!settled) {
            settled = true;
            clearTimeout(urlTimer);
            resolve({ url: state.url });
          }
        }
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      log.error("reauth", "Login process error", { error: err.message });
      if (!settled) {
        settled = true;
        clearTimeout(urlTimer);
        reset();
        resolve({ error: `Login process error: ${err.message}` });
      }
    });

    proc.on("exit", (code) => {
      log.info("reauth", `Login process exited (code ${code})`, {
        phase: state.phase,
      });
      // If it exited before we captured a URL, surface that.
      if (!settled) {
        settled = true;
        clearTimeout(urlTimer);
        reset();
        resolve({ error: `Login exited early (code ${code}).` });
      }
    });
  });
}

/**
 * Feed the OAuth code to the waiting login process and confirm the result via
 * `claude auth status`.
 */
export async function submitCode(
  code: string,
): Promise<{ ok: boolean; message: string }> {
  if (state.phase !== "awaiting_code" || !state.proc) {
    return { ok: false, message: "No reauth is waiting for a code." };
  }

  const proc = state.proc;
  state.phase = "exchanging";
  log.info("reauth", "Submitting code");

  // Wait for the process to finish exchanging the code.
  const exited: Promise<number | null> = new Promise((res) => {
    proc.once("exit", (c) => res(c));
    // Safety: don't hang forever if the CLI stalls.
    setTimeout(() => res(null), 30_000);
  });

  try {
    proc.stdin.write(code.trim() + "\n");
  } catch (err: any) {
    reset();
    return { ok: false, message: `Failed to send code: ${err.message}` };
  }

  await exited;
  reset();

  // Verify authentication actually succeeded.
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status", "--json"], {
      env: { ...process.env, PATH: `${CLAUDE_BIN_DIR}:${process.env.PATH ?? ""}` },
    });
    const status = JSON.parse(stdout);
    if (status.loggedIn) {
      return {
        ok: true,
        message: `✅ Re-authenticated as ${status.email ?? "unknown"}.`,
      };
    }
    return {
      ok: false,
      message: "❌ Still not logged in — the code may have been wrong or expired. Try /reauth again.",
    };
  } catch (err: any) {
    return {
      ok: false,
      message: `Could not verify auth status: ${err.message}`,
    };
  }
}
