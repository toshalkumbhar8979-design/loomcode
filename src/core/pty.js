// PTY runner — Bun's native pseudo-terminal when available, so commands see
// a real TTY (colors, progress bars, interactive CLIs) and the TUI can stream
// output live. Callers fall back to plain pipes when this returns fallback.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

function stripAnsi(s) {
  return String(s == null ? "" : s).replace(ANSI, "").replace(/\r/g, "");
}

function available() {
  return (
    typeof Bun !== "undefined" &&
    typeof Bun.spawn === "function" &&
    typeof Bun.Terminal === "function" &&
    process.env.LOOM_PTY !== "0"
  );
}

function shellArgv(command) {
  if (process.platform === "win32") {
    return ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + command]];
  }
  return ["/bin/sh", ["-c", command]];
}

function killTree(proc) {
  try {
    if (process.platform === "win32" && proc && proc.pid) {
      const { spawn } = require("child_process");
      const killer = spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.unref();
      return;
    }
  } catch {}
  try { proc.kill(); } catch {}
}

function run(command, opts) {
  return new Promise((resolve) => {
    const onChunk = typeof opts.onChunk === "function" ? opts.onChunk : null;
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 60000);
    let proc = null;
    let timer = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let full = "";
    let pending = "";
    let decoder = new TextDecoder("utf-8", { fatal: false });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pending) {
        const tail = stripAnsi(pending);
        if (tail) { full += tail; if (onChunk) { try { onChunk(tail); } catch {} } }
        pending = "";
      }
      try { if (proc && proc.terminal) proc.terminal.close(); } catch {}
      resolve({ output: full, code: typeof code === "number" ? code : 0, timedOut, aborted, timeoutMs });
    };

    try {
      const [bin, args] = shellArgv(command);
      proc = Bun.spawn([bin, ...args], {
        cwd: opts.cwd || process.cwd(),
        env: Object.assign({}, process.env, { TERM: "xterm-256color", NO_COLOR: process.env.NO_COLOR || "" }),
        terminal: {
          cols: 120,
          rows: 40,
          data(_term, data) {
            pending += decoder.decode(data, { stream: true });
            const nl = pending.lastIndexOf("\n");
            if (nl < 0) return;
            const complete = pending.slice(0, nl + 1);
            pending = pending.slice(nl + 1);
            const clean = stripAnsi(complete);
            if (!clean) return;
            full += clean;
            if (onChunk) { try { onChunk(clean); } catch {} }
          },
        },
      });

      const sig = opts.signal;
      if (sig) {
        if (sig.aborted) { aborted = true; killTree(proc); }
        else {
          const onAbort = () => { aborted = true; if (timer) clearTimeout(timer); killTree(proc); };
          try { sig.addEventListener("abort", onAbort, { once: true }); } catch {}
        }
      }

      timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeoutMs);
      proc.exited.then((code) => finish(code)).catch(() => finish(1));
    } catch {
      resolve({ fallback: true });
    }
  });
}

module.exports = { available, run, stripAnsi };
