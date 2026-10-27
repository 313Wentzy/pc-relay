import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CommandRunner,
  commandSpec,
  COMMAND_OUTPUT_LIMIT,
} from "./command-runner.mjs";
function fixture(options = {}) {
  const calls = [],
    events = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1234;
  child.kill = () => child.emit("close", null);
  const spawn = (file, args, settings) => {
    calls.push({ file, args, settings });
    return calls.length === 1
      ? child
      : Object.assign(new EventEmitter(), { pid: 4321 });
  };
  const runner = new CommandRunner({
    platform: "win32",
    windowsDirectory: "C:\\Windows",
    spawn,
    ...options,
  });
  return {
    runner,
    calls,
    events,
    child,
    run: (request) =>
      runner.start(
        {
          shell: "powershell",
          command: "Get-Date",
          lease: "synthetic-lease",
          ...request,
        },
        (event) => events.push(event),
      ),
  };
}
test("command execution denies missing authorization and unsupported admin grants before spawning", async () => {
  const f = fixture();
  await assert.rejects(f.run({}), /REMOTE_AUTH_REQUIRED/);
  assert.equal(f.calls.length, 0);
  const allowed = fixture({ authorize: async () => true });
  await assert.rejects(allowed.run({ admin: true }), /ADMIN_NOT_ENABLED/);
  assert.equal(allowed.calls.length, 0);
  const elevated = fixture({
    authorize: async () => true,
    elevated: true,
    allowAdmin: true,
  });
  await assert.rejects(elevated.run({ admin: false }), /USER_BROKER_REQUIRED/);
});
test("PowerShell receives encoded command with fixed executable and no visible window", async () => {
  const f = fixture({ authorize: async () => true });
  await f.run({ command: 'Write-Output "a; $x"' });
  assert.equal(f.calls[0].settings.windowsHide, true);
  assert.equal(f.calls[0].settings.shell, false);
  assert.equal(f.calls[0].settings.stdio[0], "ignore");
  assert.match(f.calls[0].file, /powershell\.exe$/);
  assert.match(
    Buffer.from(f.calls[0].args.at(-1), "base64").toString("utf16le"),
    /Write-Output "a; \$x"$/,
  );
  f.child.stdout.write("result\n");
  f.child.emit("close", 0);
  assert.equal(f.events.find((e) => e.type === "output").text, "result\n");
  assert.equal(f.events.at(-1).code, 0);
  assert.equal(f.runner.running, null);
});
test("output is bounded and cancellation targets the process tree", async () => {
  const f = fixture({ authorize: async () => true });
  await f.run({ shell: "cmd", command: "dir" });
  await assert.rejects(f.run({}), /COMMAND_ALREADY_RUNNING/);
  f.child.stdout.write(Buffer.alloc(COMMAND_OUTPUT_LIMIT + 200, 65));
  assert.equal(
    f.events
      .filter((e) => e.type === "output")
      .reduce((n, e) => n + Buffer.byteLength(e.text), 0),
    COMMAND_OUTPUT_LIMIT,
  );
  assert.deepEqual(f.calls[1].args, ["/PID", "1234", "/T", "/F"]);
  assert.equal(f.calls[1].settings.windowsHide, true);
  f.child.emit("close", 1);
  assert.equal(f.events.at(-1).reason, "output_limit");
  assert.throws(
    () => commandSpec("bash", "whoami", "C:\\Windows"),
    /INVALID_COMMAND/,
  );
  assert.throws(
    () => commandSpec("cmd", "x".repeat(4097), "C:\\Windows"),
    /INVALID_COMMAND/,
  );
});
test("revoking a running lease stops the command without browser polling", async () => {
  let valid = true;
  const f = fixture({ authorize: async () => valid });
  await f.run({});
  valid = false;
  await new Promise((resolve) => setTimeout(resolve, 325));
  assert.equal(f.calls.length, 2);
  f.child.emit("close", null);
  assert.equal(f.events.at(-1).reason, "authorization_ended");
});

test(
  "installed Windows shells execute fixed read-only smoke commands",
  { skip: process.platform !== "win32" },
  async () => {
    for (const [shell, command, expected] of [
      [
        "powershell",
        "Write-Progress -Activity 'Read-only smoke' -PercentComplete 50; Write-Output 'long-cable-powershell-smoke'",
        "long-cable-powershell-smoke",
      ],
      ["cmd", "echo long-cable-cmd-smoke", "long-cable-cmd-smoke"],
    ]) {
      const runner = new CommandRunner({
        authorize: async (lease) => lease === "local-smoke-only",
      });
      let output = "";
      const finished = new Promise((resolve, reject) => {
        void runner
          .start({ shell, command, lease: "local-smoke-only" }, (event) => {
            if (event.type === "output") output += event.text;
            if (event.type === "exit") {
              if (event.code === 0 && output.includes(expected)) resolve();
              else
                reject(
                  new Error(`Smoke command failed: ${shell} (${event.reason})`),
                );
            }
          })
          .catch(reject);
      });
      await finished;
      assert.doesNotMatch(output, /#< CLIXML|Preparing modules for first use|<Objs Version=/);
    }
  },
);
