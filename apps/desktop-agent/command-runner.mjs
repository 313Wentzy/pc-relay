import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
export const COMMAND_TIMEOUT_MS = 60000;
export function commandSpec(
  shell,
  command,
  windowsDirectory = process.env.SystemRoot,
) {
  if (
    !["cmd", "powershell"].includes(shell) ||
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 4096 ||
    command.includes("\0")
  )
    throw new Error("INVALID_COMMAND");
  if (!windowsDirectory || !/^[a-z]:\\/i.test(windowsDirectory))
    throw new Error("WINDOWS_REQUIRED");
  if (shell === "cmd")
    return {
      file: join(windowsDirectory, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", `chcp 65001>nul & ${command}`],
    };
  const script = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}`;
  return {
    file: join(
      windowsDirectory,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}

// Executor only, NOT a network service. Denies everything until a trusted agent-side
// lease adapter is supplied. Never pass client claims/booleans as authorize/elevated.
export class CommandRunner {
  constructor({
    authorize = async () => false,
    elevated = false,
    allowAdmin = false,
    spawn = spawnProcess,
    platform = process.platform,
    windowsDirectory = process.env.SystemRoot,
    jobRunner = null,
  } = {}) {
    this.authorize = authorize;
    this.elevated = elevated;
    this.allowAdmin = allowAdmin;
    this.spawn = spawn;
    this.platform = platform;
    this.windowsDirectory = windowsDirectory;
    this.jobRunner = jobRunner;
    this.running = null;
  }
  async start({ shell, command, admin = false, lease }, onEvent) {
    if (this.platform !== "win32") throw new Error("WINDOWS_REQUIRED");
    if (this.running) throw new Error("COMMAND_ALREADY_RUNNING");
    const spec = commandSpec(shell, command, this.windowsDirectory);
    if (admin && (!this.allowAdmin || !this.elevated))
      throw new Error("ADMIN_NOT_ENABLED");
    // An elevated process cannot truthfully run an unelevated command without a separate user broker.
    if (!admin && this.elevated) throw new Error("USER_BROKER_REQUIRED");
    if (!(await this.authorize(lease))) throw new Error("REMOTE_AUTH_REQUIRED");
    if (this.running) throw new Error("COMMAND_ALREADY_RUNNING");
    const id = randomUUID();
    const child = this.spawn(this.jobRunner || spec.file, this.jobRunner ? ["--job-run", spec.file, ...spec.args] : spec.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = {
      id,
      child,
      bytes: 0,
      reason: null,
      done: false,
      watchBusy: false,
    };
    this.running = running;
    const emit = (event) => {
      try {
        onEvent({ id, ...event });
      } catch {
        this.stop("output_disconnected");
      }
    };
    const output = (channel) => {
      const decoder = new StringDecoder("utf8");
      return (chunk) => {
        if (running.done) return;
        const bytes = Buffer.from(chunk);
        const remaining = COMMAND_OUTPUT_LIMIT - running.bytes;
        if (remaining > 0) {
          const bounded = bytes.subarray(0, remaining);
          running.bytes += bounded.length;
          emit({ type: "output", channel, text: decoder.write(bounded) });
        }
        if (bytes.length >= remaining) this.stop("output_limit");
      };
    };
    child.stdout?.on("data", output("stdout"));
    child.stderr?.on("data", output("stderr"));
    const timeout = setTimeout(() => this.stop("timeout"), COMMAND_TIMEOUT_MS);
    const watch = setInterval(async () => {
      if (running.done || running.watchBusy) return;
      running.watchBusy = true;
      try {
        if (!(await this.authorize(lease))) this.stop("authorization_ended");
      } catch {
        this.stop("authorization_ended");
      } finally {
        running.watchBusy = false;
      }
    }, 250);
    const finish = (code, reason) => {
      if (running.done) return;
      running.done = true;
      clearTimeout(timeout);
      clearInterval(watch);
      if (this.running === running) this.running = null;
      emit({ type: "exit", code, reason: running.reason || reason });
    };
    child.once("error", () => finish(null, "start_failed"));
    child.once("close", (code) => finish(code, "completed"));
    emit({ type: "started", shell, admin });
    return { id };
  }
  stop(reason = "cancelled") {
    const running = this.running;
    if (!running || running.done || running.reason) return false;
    running.reason = reason;
    if (Number.isSafeInteger(running.child.pid) && running.child.pid > 0) {
      const killer = this.spawn(
        join(this.windowsDirectory, "System32", "taskkill.exe"),
        ["/PID", String(running.child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => running.child.kill());
      killer.once("close", (code) => {
        if (code !== 0) running.child.kill();
      });
    } else running.child.kill();
    return true;
  }
}
