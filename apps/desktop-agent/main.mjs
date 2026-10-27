import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  safeStorage,
  globalShortcut,
  powerMonitor,
  desktopCapturer,
  powerSaveBlocker,
  clipboard,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";
import { createIdentityVault } from "./identity-vault.mjs";
import { AgentRelay } from "./relay-client.mjs";
import { CommandRunner } from "./command-runner.mjs";
import { allowDisplayCapture, canRestoreBackgroundAccess } from "./capture-policy.mjs";
import { diagnosticSnapshot } from "./diagnostics.mjs";
import { windowCatalog } from "./source-catalog.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(join(root, "index.html")).href;
const background = process.argv.includes("--background");
const connectorDirectory = join(process.env.LOCALAPPDATA || app.getPath("appData"), "LongCable");
app.setName("Long Cable");
const stateDirectory = join(app.getPath("appData"), "Long Cable");
mkdirSync(stateDirectory, { recursive: true });
app.setPath("userData", stateDirectory);
let window,
  tray,
  vault,
  relay,
  native,
  runner,
  quitting = false,
  nativeReady = false,
  elevated = false;
let captureSession = null, sourcePlan = new Map(), preparedScreen = null, displayBlocker = null;
let lastPause = { reason: "startup", at: Date.now() }, captureError = null, diagnosticsQueue = Promise.resolve();
let connectorWatch;
let windowEntries = new Map(), windowSources = [], sourceRefresh = null, nativeWindowQuery = null;
function queryNativeWindows() {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString(36);
    const clear = () => { if (nativeWindowQuery?.id === id) nativeWindowQuery = null; };
    const timeout = setTimeout(() => { clear(); reject(Error("SOURCES_UNAVAILABLE")); }, 4000);
    nativeWindowQuery = { id, resolve: rows => { clearTimeout(timeout); clear(); resolve(rows); } };
    try { writeNative("windows " + id); }
    catch (error) { clearTimeout(timeout); clear(); reject(error); }
  });
}
async function refreshSources() {
  if (sourceRefresh) return sourceRefresh;
  sourceRefresh = (async () => {
    if (!nativeReady) return;
    let enumerationTimeout;
    try {
      const [sources, nativeWindows] = await Promise.race([
        Promise.all([
          desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
          queryNativeWindows(),
        ]),
        new Promise((_, reject) => { enumerationTimeout = setTimeout(() => reject(Error("SOURCES_UNAVAILABLE")), 5000); }),
      ]);
      const ownHandle = window.getNativeWindowHandle().readBigUInt64LE().toString();
      const catalog = windowCatalog(sources, nativeWindows, windowEntries, ownHandle);
      windowEntries = catalog.entries; windowSources = catalog.publicSources;
    } finally { clearTimeout(enumerationTimeout); }
  })().finally(() => { sourceRefresh = null; });
  return sourceRefresh;
}
const captureSources = () => [...displays().map(item => ({ ...item, kind: "screen" })), ...(relay?.accessReady() ? windowSources : [])];
const displays = () =>
  screen
    .getAllDisplays()
    .map((d, i) => ({
      id: String(d.id),
      label: d.label || "Screen " + (i + 1),
      width: d.size.width,
      height: d.size.height,
    }));
function status() {
  return {
    ...relay?.status(),
    fingerprint: vault?.publicIdentity()?.fingerprint ?? null,
    encryptedStorage: vault?.available() === true,
    screens: displays(),
    nativeReady,
    elevated,
    lastPause,
    captureError,
  };
}
function notify() {
  const snapshot = JSON.stringify(diagnosticSnapshot(status(), lastPause, captureError), null, 2);
  const path = join(stateDirectory, "status.json");
  diagnosticsQueue = diagnosticsQueue.catch(() => {}).then(async () => {
    await writeFile(path + ".tmp", snapshot, { mode: 0o600 });
    await rename(path + ".tmp", path);
  }).catch(() => {});
  if (window && !window.isDestroyed())
    window.webContents.send("agent:status", status());
  if (tray) {
    tray.setToolTip("Long Cable - " + (relay?.status().message || "Offline"));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Long Cable", click: open },
        { label: "Turn off remote access", click: () => void disableAccess() },
        { type: "separator" },
        {
          label: "Quit",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  }
}
function requireSender(event) {
  if (
    event.sender.id !== window?.webContents.id ||
    event.senderFrame !== window?.webContents.mainFrame ||
    event.senderFrame.url !== entry
  )
    throw new Error("UNTRUSTED_SENDER");
}
function pause(reason = "local_takeover", detail = {}) {
  lastPause = { reason, at: Date.now(), source: detail.source, injected: detail.injected };
  relay?.pause(reason);
  notify();
}
async function disableAccess() {
  if (!relay?.status().paired) { relay?.enable(false); return; }
  try { await relay?.setAccessEnabled(false); }
  catch { relay?.notify("Could not save remote access setting"); }
}
function writeNative(line) {
  if (
    !nativeReady ||
    !native?.stdin.writable ||
    native.stdin.writableLength > 32768
  )
    throw new Error("NATIVE_UNAVAILABLE");
  native.stdin.write(line + "\n");
}
function release() {
  if (native?.stdin.writable) native.stdin.write("stop\n");
}
function open() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
}
async function localAccess(value) {
  if (value && (!nativeReady || !vault?.available() || !relay?.status().paired)) throw Error("PC_NOT_READY");
  await relay.setAccessEnabled(value);
}
function resumeSavedAccess() {
  if (canRestoreBackgroundAccess({ allowRemote: relay?.state?.allowRemote, paired: relay?.status().paired,
    nativeReady, encryptedStorage: vault?.available(), locked: powerMonitor.getSystemIdleState(1) === "locked", pauseReason: relay?.pauseReason })) relay.enable(true);
}
function recoverBackground() {
  if (background && !quitting) setTimeout(() => app.exit(1), 250).unref();
}
function startNative() {
  native = spawn(
    process.env.LONG_CABLE_NATIVE_INPUT ||
      (app.isPackaged ? join(dirname(process.resourcesPath), "native-input.exe") : join(root, "../../.preview/native-build/native-input.exe")),
    [],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  native.on("error", () => {
    nativeReady = false;
    pause("native_unavailable");
    recoverBackground();
  });
  native.on("exit", () => {
    nativeReady = false;
    pause("native_unavailable");
    recoverBackground();
  });
  createInterface({ input: native.stdout }).on("line", (line) => {
    try {
      const data = JSON.parse(line);
      if (data.type === "ready") {
        elevated = data.elevated === true;
        nativeReady = !elevated || process.argv.includes("--allow-admin");
        runner = new CommandRunner({
          authorize: async (lease) => relay.authorized(lease?.sessionId),
          elevated,
          allowAdmin: elevated && process.argv.includes("--allow-admin"),
          jobRunner: native.spawnfile,
        });
        relay?.publish();
        notify();
      }
      if (data.type === "takeover") pause("local_takeover", data);
      if (data.type === "error") {
        pause(data.error === "WATCHDOG_EXPIRED" ? "native_watchdog" : "native_unavailable");
        if (background && data.error === "WATCHDOG_EXPIRED") setTimeout(resumeSavedAccess, 1000);
      }
      if (data.type === "ack") relay?.acknowledge(data.sequence);
      if (data.type === "windows" && data.requestId === nativeWindowQuery?.id && Array.isArray(data.items)) nativeWindowQuery.resolve(data.items);
    } catch {
      nativeReady = false;
      pause("native_unavailable");
    }
  });
}
async function capture(message) {
  if (!window || window.isDestroyed()) throw new Error("CAPTURE_UNAVAILABLE");
  if (message.type === "start") {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    if (!relay.authorized(message.sessionId)) throw new Error("LEASE_EXPIRED");
    const selected = message.screenIds.map((id) => ({
      screenId: id,
      sourceId: id.startsWith("win-") ? windowEntries.get(id)?.sourceId : sources.find((s) => s.display_id === id)?.id,
    }));
    if (selected.some((s) => !sources.some(source => source.id === s.sourceId)))
      throw new Error("SCREEN_UNAVAILABLE");
    captureSession = message.sessionId;
    captureError = null;
    sourcePlan = new Map(selected.map(item => [item.screenId, sources.find(source => source.id === item.sourceId)]));
    if (displayBlocker === null) displayBlocker = powerSaveBlocker.start("prevent-display-sleep");
    window.webContents.send("agent:capture", { ...message, sources: selected });
  } else {
    if (message.type === "stop") {
      captureSession = null; sourcePlan.clear(); preparedScreen = null;
      if (displayBlocker !== null) { powerSaveBlocker.stop(displayBlocker); displayBlocker = null; }
    }
    window.webContents.send("agent:capture", message);
  }
}
async function input(message) {
  if (message.type === "begin") {
    writeNative("begin " + message.sessionId);
    return;
  }
  if (!relay.authorized(message.sessionId)) throw new Error("LEASE_EXPIRED");
  const value = message.input;
  if (message.screenId.startsWith("win-")) {
    const target = windowEntries.get(message.screenId);
    if (!target || !sourcePlan.has(message.screenId)) throw Error("WINDOW_UNAVAILABLE");
    const args = ["move", "down", "up"].includes(value.kind) ? [value.x, value.y, ...(value.kind === "move" ? [] : [value.button])]
      : value.kind === "wheel" ? [value.deltaX, value.deltaY] : ["release", "paste"].includes(value.kind) ? [] : [value.code];
    writeNative(["window", message.sessionId, message.sequence, target.handle, target.pid, value.kind, ...args].join(" "));
    return;
  }
  const d = screen
    .getAllDisplays()
    .find((d) => String(d.id) === message.screenId);
  if (!d) throw new Error("SCREEN_UNAVAILABLE");
  let args;
  if (["move", "down", "up"].includes(value.kind)) {
    const point = screen.dipToScreenPoint({
      x: Math.round(d.bounds.x + value.x * (d.bounds.width - 1)),
      y: Math.round(d.bounds.y + value.y * (d.bounds.height - 1)),
    });
    args = [point.x, point.y];
    if (value.kind !== "move") args.push(value.button);
  } else if (value.kind === "wheel") args = [value.deltaX, value.deltaY];
  else args = value.kind === "release" ? [] : [value.code];
  writeNative(
    [value.kind, message.sessionId, message.sequence, ...args].join(" "),
  );
}
if (!app.requestSingleInstanceLock() || process.argv.includes("--quit")) app.quit();
else {
  app.on("second-instance", (_event, args) => {
    if (args.includes("--quit")) { quitting = true; app.quit(); }
    else if (args.includes("--pause") || args.includes("--resume"))
      void localAccess(args.includes("--resume")).catch(() => relay?.notify("PC is not ready"));
    else if (!args.includes("--background")) open();
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("dev.long-cable.pc.benchmark");
      vault = createIdentityVault({
        safeStorage,
        directory: app.getPath("userData"),
      });
      await vault.initialize();
      window = new BrowserWindow({
        width: 680,
        height: 690,
        minWidth: 560,
        minHeight: 540,
        show: false,
        title: "Long Cable",
        backgroundColor: "#101114",
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
          devTools: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      for (const name of [
        "will-navigate",
        "will-frame-navigate",
        "will-redirect",
        "will-attach-webview",
      ])
        window.webContents.on(name, (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler(
        (contents, permission, callback, details) =>
          callback(
            allowDisplayCapture({ senderId: contents.id, expectedId: window.webContents.id, frameUrl: contents.getURL(), entryUrl: entry, isMainFrame: details.isMainFrame, permission, mediaTypes: details.mediaTypes, active: relay?.authorized(relay.session?.id) === true, audioAllowed: relay?.session?.audio === true }, "request"),
          ),
      );
      window.webContents.session.setPermissionCheckHandler(
        (contents, permission, _origin, details) =>
          allowDisplayCapture({ senderId: contents?.id, expectedId: window.webContents.id, frameUrl: contents?.getURL(), entryUrl: entry, isMainFrame: details.isMainFrame, permission, active: relay?.authorized(relay.session?.id) === true }, "check"),
      );
      window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
        const prepared = preparedScreen; preparedScreen = null;
        const source = sourcePlan.get(prepared?.screenId);
        if (source && prepared.sessionId === captureSession && relay?.authorized(captureSession) && request.frame === window.webContents.mainFrame && request.frame.url === entry && request.videoRequested && (!request.audioRequested || prepared.audio && relay.session.audio === true)) callback({ video: source, ...(request.audioRequested ? { audio: "loopback" } : {}) });
        else callback({});
      }, { useSystemPicker: false });
      for (const event of ["render-process-gone", "unresponsive"])
        window.webContents.on(event, () => { pause("renderer_unavailable"); recoverBackground(); });
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      relay = new AgentRelay({
        vault,
        screens: captureSources,
        refreshSources,
        capture,
        input,
        clipboard: message => {
          if (!relay.authorized(message.sessionId) || !relay.session.screens.includes(message.screenId)) throw Error("LEASE_EXPIRED");
          clipboard.writeText(message.text);
        },
        release,
        heartbeat: (id) => writeNative("heartbeat " + id),
        elevated: () => elevated,
        command: (message, callback) =>
          runner.start(
            {
              shell: message.shell,
              command: message.command,
              admin: message.admin,
              lease: { sessionId: message.sessionId },
            },
            callback,
          ),
        stopCommand: () => runner?.stop("session_ended"),
        ready: () => nativeReady && vault?.available() === true && powerMonitor.getSystemIdleState(1) !== "locked",
        relayOrigins: (process.argv.find(value => value.startsWith("--relay-origins="))?.slice("--relay-origins=".length) || process.env.LONG_CABLE_RELAY_ORIGINS)?.split(","),
        onStatus: notify,
      });
      ipcMain.handle("agent:status", (event) => {
        requireSender(event);
        return status();
      });
      ipcMain.handle("agent:action", async (event, action, value) => {
        requireSender(event);
        try {
          if (action === "pair") {
            if (
              typeof value?.relay !== "string" ||
              value.relay.length > 512 ||
              typeof value.code !== "string"
            )
              throw new Error("INVALID_PAIRING");
            await relay.pair(value.relay, value.code);
          } else if (action === "enable") {
            await localAccess(value === true);
          } else if (action === "reconnect") {
            if (!relay.state?.relay) throw new Error("PAIR_FIRST");
            await relay.connect(relay.relayOrigins[0] || relay.state.relay);
          } else if (action === "unpair") await relay.unpair();
          else throw new Error("INVALID_ACTION");
          return { ok: true, status: status() };
        } catch (error) {
          return {
            ok: false,
            error: /^[A-Z_]+$/.test(error.message)
              ? error.message
              : "OPERATION_FAILED",
          };
        }
      });
      ipcMain.handle("agent:capture-signal", (event, message) => {
        requireSender(event);
        relay.signal(message);
      });
      ipcMain.handle("agent:capture-ice", (event, message) => { requireSender(event); relay.ice(message); });
      ipcMain.handle("agent:direct-input", async (event, message) => {
        requireSender(event);
        if (message?.sessionId !== captureSession) return false;
        return relay.acceptInput(message, ack => {
          if (ack.sessionId === captureSession && !window.isDestroyed()) window.webContents.send("agent:direct-ack", ack);
        });
      });
      ipcMain.handle("agent:prepare-capture", (event, message) => {
        requireSender(event);
        if (message?.sessionId !== captureSession || !relay.authorized(captureSession) || !sourcePlan.has(message.screenId)) throw new Error("INVALID_CAPTURE_SOURCE");
        preparedScreen = { sessionId: captureSession, screenId: message.screenId, audio: relay.session.audio === true && message.audio === true && message.screenId === relay.session.screens[0] };
      });
      ipcMain.handle("agent:capture-failed", (event, id, reason) => {
        requireSender(event);
        if (id === relay.session?.id) {
          captureError = diagnosticSnapshot({}, null, reason).captureError;
          relay.stopSession("capture_failed");
          notify();
        }
      });
      tray = new Tray(
        nativeImage.createFromPath(join(root, "assets", "icon.png")),
      );
      tray.on("double-click", open);
      globalShortcut.register("Control+Alt+Shift+Escape", () => {
        void disableAccess();
        open();
      });
      for (const event of ["suspend", "resume"])
        powerMonitor.on(event, () => { pause("suspended"); if (event === "resume" && background) setTimeout(resumeSavedAccess, 2000); });
      powerMonitor.on("lock-screen", () => pause("locked"));
      powerMonitor.on("unlock-screen", () => { if (background) setTimeout(resumeSavedAccess, 500); });
      screen.on("display-removed", () => pause("display_changed"));
      screen.on("display-metrics-changed", () => { pause("display_changed"); if (background) setTimeout(resumeSavedAccess, 1500); });
      startNative();
      await window.loadURL(entry);
      if (!background) open();
      notify();
      if (vault.available())
        await relay.restore().catch(() => relay.notify("Pair this PC"));
      if (background) {
        connectorWatch = setInterval(() => {
          void unlink(join(connectorDirectory, "stop-host")).then(() => { quitting = true; app.quit(); }).catch(error => {
            if (error.code !== "ENOENT") relay?.notify("Connector control file unavailable");
          });
        }, 1000);
        connectorWatch.unref();
      }
    })
    .catch(() => {
      quitting = true;
      if (background) app.exit(1);
      else app.quit();
    });
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(connectorWatch);
    relay?.close();
    release();
    native?.stdin.end();
    globalShortcut.unregisterAll();
  });
}
