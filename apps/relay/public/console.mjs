// Shared by the standalone benchmark and the authenticated React workspace.
// Each mount owns its socket, timers and DOM listeners; unmounting fences them.
import { screenWindows } from "./screen-windows.mjs";
import { monitorTabs } from "./monitor-tabs.mjs";
import { pcAudio } from "./pc-audio.mjs";
import { validInput, validClipboard, validIceCandidate } from "../protocol.mjs";
export function mountConsole(root, { authorize, controls } = {}) {
const $ = (id) => root.querySelector("#" + id) || controls?.querySelector("#" + id);
const lifetime = new AbortController();
let disposed = false, relayOrigin = location.origin, videoLifetime;
const floating = Boolean(root.querySelector("#window-dock"));
let windowManager = null, latestVideoStats = [];
let summaryTimer = null, detailRows = [], detailsDirty = false;
let clipboardRequest = null, clipboardTimer;
let reconnectTimer = null, reconnectAttempts = 0, renewalBusy = false;
let reconnectBusy = false, authorizationVersion = 0;
let recoveryRequest = null, recoveryTimer = null, pendingStartRequest = null, recoveryAttempts = 0;
let cancelledStart = false;
function clipboardStatus(text) { if ($("clipboard-status")) $("clipboard-status").textContent = text; }
function sendClipboard(text, paste = true, screenId = session?.focus) {
  if (!session || !$("control").checked || peer?.connectionState !== "connected") { clipboardStatus("Connect with control enabled."); return; }
  if (!selectedDevice?.capabilities?.clipboard) { clipboardStatus("Update the PC connector to enable clipboard transfer."); showError("Update the PC connector to enable clipboard transfer."); return; }
  if (clipboardRequest) { clipboardStatus("Waiting for PC…"); return; }
  const message = { type: "clipboard", sessionId: session.id, screenId, sequence: sequence + 1,
    requestId: crypto.randomUUID(), text, paste };
  if (!validClipboard(message)) { clipboardStatus("Text only · up to 16,384 characters / 48 KB."); return; }
  // All later input waits for the native paste ACK; direct input must not
  // overtake this message on the separate WebSocket transport.
  sequence++; clipboardRequest = message.requestId;
  clipboardStatus("Sending…");
  clipboardTimer = setTimeout(() => { clipboardRequest = null; clipboardStatus("No acknowledgement. Check the PC connection."); }, 5000);
  send(message);
}
const on = (target, type, listener, options = {}) =>
  target.addEventListener(type, listener, { ...options, signal: lifetime.signal });
const onVideo = (target, type, listener, options = {}) =>
  target.addEventListener(type, listener, { ...options, signal: videoLifetime.signal });
let config,
  auth = null,
  factorId,
  socket = null,
  credential = null,
  devices = [],
  selectedDevice = null,
  pairing = null,
  session = null,
  peer = null,
  inputChannel = null,
  sequence = 0,
  commandId = null;
let renewTimer, pingTimer, statsTimer, videoTimer, pairTimer, parentOrigin, restartRequest = null;
let handshakeTimer, startTimer, phaseTimer, phaseStarted = 0, phaseFinished = 0, phaseLog = [], phaseActive = false;
const audioPlayer = pcAudio(root, controls);
function stage(label, active = true) {
  const now = performance.now();
  if (active && !phaseActive) { phaseStarted = now; phaseLog = []; }
  if (phaseLog.at(-1)?.label !== label) phaseLog.push({ label, at: now });
  phaseLog = phaseLog.slice(-12); phaseActive = active;
  if (!active) phaseFinished = now;
  clearInterval(phaseTimer);
  const panel = $("connection-progress");
  if (!panel) return;
  panel.hidden = !active;
  if (!active) return;
  $("connection-stage").textContent = label;
  const paint = () => {
    $("connection-time").textContent = ((performance.now() - phaseStarted) / 1000).toFixed(1) + "s";
    $("connection-steps").replaceChildren(...phaseLog.map((entry, index) => {
      const li = document.createElement("li"), end = phaseLog[index + 1]?.at ?? performance.now();
      li.textContent = entry.label + " · " + ((end - entry.at) / 1000).toFixed(1) + "s";
      return li;
    }));
    $("connection-cancel").hidden = !session && !startTimer && !recoveryRequest;
  };
  paint(); phaseTimer = setInterval(paint, 250);
}
function requestStart(request) {
  cancelledStart = false;
  pendingStartRequest = { ...request };
  clearTimeout(startTimer);
  $("connect").disabled = true;
  $("session-status").textContent = "Connecting…";
  startTimer = setTimeout(() => {
    startTimer = null;
    if (!session) { socket?.close(); stage("PC request timed out", false); showError("PC request timed out. Reconnect to retry."); }
  }, 20000);
  stage(request.transport === "compatibility" ? "Requesting TURN connection" : "Requesting PC");
  const { restoreControl, ...wireRequest } = request;
  send({ type: "start", ...wireRequest });
}
const pending = new Map(),
  inputSamples = [],
  pcSamples = [],
  relaySamples = [],
  tracks = new Map(),
  videos = new Map(),
  previous = new Map(),
  exported = [];
const publicParents = new Set([location.origin]);
const showError = (message) => {
  $("error").textContent = message ? String(message).replaceAll("_", " ") : "";
};
const send = (value) => {
  if (socket?.readyState === 1) socket.send(JSON.stringify(value));
};
const tabs = floating ? monitorTabs(root, {
  makeVideo, focus, release: releaseInput,
  paste: (id, text, insert) => sendClipboard(text, insert, id),
  debugChanged: () => { renderDetails(); updateSummary(); },
  markPopped: (id, value) => windowManager?.setPopped(id, value),
  duplicateAllowed: () => $("duplicate-views")?.checked === true,
  visibility: screenIds => { if (session) send({ type: "visibility", sessionId: session.id, screenIds }); },
}) : null;
const metric = (value) =>
  Number.isFinite(value) ? value.toFixed(1) + " ms" : "—";
const percentile = (values, q) => {
  const live = values.filter((s) => performance.now() - s.time <= 60000);
  values.splice(0, values.length, ...live.slice(-512));
  return (
    [...live].map((s) => s.value).sort((a, b) => a - b)[
      Math.max(0, Math.ceil(live.length * q) - 1)
    ] ?? null
  );
};
function sample(values, value) {
  values.push({ value, time: performance.now() });
  if (values.length > 512) values.shift();
}
async function api(path, body, token = auth?.access_token, method = body ? "POST" : "GET") {
  const response = await fetch(config.project + "/auth/v1/" + path, {
    method,
    headers: {
      apikey: config.publishableKey,
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Sign-in or verification failed.");
  return data;
}
on($("password-form"), "submit", async (event) => {
  event.preventDefault();
  showError("");
  const password = $("password").value;
  $("password").value = "";
  try {
    if (!config?.publishableKey)
      throw new Error("Configure Supabase and the owner email before signing in.");
    auth = await api(
      "token?grant_type=password",
      { email: config.owner, password },
      null,
    );
    const user = await api("user");
    if (user.email?.toLowerCase() !== config.owner)
      throw new Error("Owner account required.");
    factorId = user.factors?.find(
      (f) => f.factor_type === "totp" && f.status === "verified",
    )?.id;
    if (!factorId) {
      // An interrupted enrollment leaves an unverified factor. Replace it so
      // another sign-in can start fresh instead of getting a duplicate-name error.
      for (const factor of user.factors || [])
        if (factor.factor_type === "totp" && factor.status !== "verified")
          await api("factors/" + encodeURIComponent(factor.id), null, auth.access_token, "DELETE");
      const enrollment = await api("factors", { factor_type: "totp", friendly_name: "Long Cable" });
      factorId = enrollment.id;
      $("mfa-secret").textContent = enrollment.totp.secret;
      $("mfa-enrollment").hidden = false;
    }
    $("password-form").hidden = true;
    $("mfa-form").hidden = false;
    $("mfa").focus();
  } catch (error) {
    auth = null;
    showError(error.message);
  }
});
on($("mfa-form"), "submit", async (event) => {
  event.preventDefault();
  const code = $("mfa").value;
  $("mfa").value = "";
  try {
    const challenge = await api("factors/" + factorId + "/challenge", {});
    auth = await api("factors/" + factorId + "/verify", {
      challenge_id: challenge.id,
      code,
    });
    $("mfa-secret").textContent = "";
    $("mfa-enrollment").hidden = true;
    credential = { accessToken: auth.access_token };
    connect();
  } catch (error) {
    showError(error.message);
  }
});
function authenticate() {
  if (credential)
    send({ type: socket.authenticated ? "reauth" : "auth", ...credential });
}
function cancelRecovery() {
  clearTimeout(recoveryTimer); recoveryTimer = null; recoveryRequest = null;
}
function queueSessionRecovery(reason, previous) {
  const retryable = /^(Relay disconnected\.|Session expired\.|auth expired|connection lost|agent disconnected|capture failed|Video negotiation failed|Compatibility relay failed|Compatibility relay timed out|Video timed out|Video connected but no frames)/.test(reason);
  if (!retryable || !$("auto-reconnect")?.checked) return false;
  if (previous?.recoveryFence) {
    recoveryRequest = { deviceId: previous.deviceId, screenIds: [...previous.screenIds], fps: previous.fps,
      height: previous.height, transport: previous.transport, audio: previous.audio === true,
      recoveryFence: previous.recoveryFence, restoreControl: previous.restoreControl ?? $("control").checked, fromSession: previous.id };
  }
  if (!recoveryRequest) return false;
  recoveryRequest.authorizedSocket = null;
  clearTimeout(recoveryTimer);
  const delay = Math.min(15000, 2000 * 2 ** Math.min(3, recoveryAttempts++));
  recoveryTimer = setTimeout(() => { recoveryTimer = null; if (recoveryRequest) void reconnectRelay(); }, delay);
  return true;
}
function scheduleReconnect() {
  if (disposed || !authorize) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 1000 * 2 ** Math.min(4, reconnectAttempts++));
  stage("Relay offline · retrying in " + delay / 1000 + "s");
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void reconnectRelay(); }, delay);
}
async function reconnectRelay() {
  if (disposed || reconnectBusy || !authorize) return;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  reconnectBusy = true;
  const version = ++authorizationVersion;
  stage("Checking access"); renderAvailability();
  try {
    // Tickets are single-use. Never reuse a closed socket's credential.
    const data = await authorize();
    if (disposed || version !== authorizationVersion) return;
    relayOrigin = data.relay; credential = { ticket: data.ticket }; connect();
  } catch (error) {
    if (disposed || version !== authorizationVersion) return;
    $("status").textContent = "Disconnected";
    stage("Reconnect needed", false);
    showError(error.message || "Could not reconnect. Try again.");
    if (error.retryable || ["TypeError", "TimeoutError", "AbortError"].includes(error.name)) scheduleReconnect();
    else cancelRecovery();
  } finally {
    if (!disposed && version === authorizationVersion) { reconnectBusy = false; renderAvailability(); }
  }
}
function connect() {
  if (disposed) return;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  if (socket) socket.close();
  const ws = new WebSocket(relayOrigin.replace(/^http/, "ws") + "/connect");
  socket = ws;
  stage("Connecting relay");
  clearTimeout(handshakeTimer);
  handshakeTimer = setTimeout(() => { if (socket === ws && !ws.authenticated) { ws.close(); stage("Relay timed out", false); showError("Relay did not respond. Reconnect to retry."); } }, 10000);
  ws.addEventListener("message", (event) => {
    if (disposed || socket !== ws) return;
    try {
      const message = JSON.parse(event.data);
      void receive(message).catch(() => {
        if (!disposed && (!message.sessionId || message.sessionId === session?.id))
          endSession("Video negotiation failed. Check browser WebRTC policies and try Compatibility relay.");
      });
    } catch {
      showError("Invalid relay response.");
    }
  });
  ws.addEventListener("close", event => {
    if (disposed || socket !== ws) return;
    clearInterval(renewTimer);
    clearInterval(pingTimer);
    clearTimeout(handshakeTimer); clearTimeout(startTimer); startTimer = null;
    clearPairing();
    root.dataset.relayReady = "false";
    endSession("Relay disconnected.", false);
    $("status").textContent = "Offline";
    if (authorize && (event.code !== 1008 || ["AUTH_EXPIRED", "TOKEN_EXPIRED"].includes(event.reason))) scheduleReconnect();
    if (!parentOrigin && !authorize) {
      $("login").hidden = false;
      $("workspace").hidden = true;
      $("password-form").hidden = false;
      $("mfa-form").hidden = true;
      auth = null;
      credential = null;
    }
  });
  ws.addEventListener("error", () => { if (!disposed && socket === ws) showError(authorize ? "Relay unavailable. Reconnecting…" : "Relay connection failed. Retry when the PC relay is online."); });
}
async function renew() {
  if (disposed || renewalBusy) return;
  if (authorize) {
    renewalBusy = true;
    const currentSocket = socket;
    try {
      const data = await authorize();
      if (disposed || socket !== currentSocket || currentSocket?.readyState !== 1) return;
      if (data.relay !== relayOrigin) throw new Error("Relay address changed. Reconnect.");
      credential = { ticket: data.ticket };
      authenticate();
    } catch (error) {
      if (!disposed && socket === currentSocket) {
        // A failed request is not a sign-out. Keep recovery controls visible.
        showError(error.message || "Could not renew access. Reconnecting…");
        currentSocket?.close();
      }
    } finally { renewalBusy = false; }
    return;
  }
  if (parentOrigin && window.opener) {
    window.opener.postMessage({ type: "long-cable-relay-ready" }, parentOrigin);
    return;
  }
  try {
    if (!auth?.access_token) return;
    auth = await api(
      "token?grant_type=refresh_token",
      { refresh_token: auth.refresh_token },
      null,
    );
    $("mfa-secret").textContent = "";
    $("mfa-enrollment").hidden = true;
    credential = { accessToken: auth.access_token };
    authenticate();
  } catch {
    logout();
  }
}
async function receive(message) {
  if (message.type === "clipboard-result" && message.sessionId === session?.id && message.requestId === clipboardRequest) {
    clearTimeout(clipboardTimer); clipboardRequest = null;
    clipboardStatus(message.ok ? "Sent to PC" : "PC rejected the clipboard write.");
    if (message.ok && $("clipboard-text")) $("clipboard-text").value = "";
    return;
  }
  if (disposed) return;
  if (message.type === "challenge") {
    authenticate();
    return;
  }
  if (message.type === "error") {
    clearTimeout(startTimer); startTimer = null;
    stage("Connection failed", false);
    if (message.error === "LOCAL_TAKEOVER") {
      cancelRecovery(); endSession("local takeover"); return;
    }
    if (recoveryRequest && ["PC_UNAVAILABLE", "RATE_LIMITED", "AUTH_BUSY"].includes(message.error)) {
      queueSessionRecovery("Relay disconnected."); renderAvailability(); return;
    }
    if (authorize && ["AUTH_EXPIRED", "TOKEN_EXPIRED"].includes(message.error)) {
      showError("Refreshing relay access…");
      return; // The close handler obtains a fresh ticket before reconnecting.
    }
    if (message.error === "RATE_LIMITED") { renderAvailability(); showError("Too many connection attempts. Wait a minute, then Connect."); return; }
    if (message.error === "VIDEO_RELAY_UNAVAILABLE") {
      restartRequest = null;
      renderAvailability();
      showError("The video relay could not issue temporary credentials. Check the Cloudflare TURN key and service, then reconnect.");
      return;
    }
    if (message.error === "COMPATIBILITY_RELAY_UNAVAILABLE") {
      restartRequest = null;
      renderAvailability();
      showError("Compatibility relay is not configured. The server needs TURN over TCP/TLS (preferably TLS on port 443).");
      return;
    }
    if (message.error === "NO_SESSION") {
      if (session) endSession("Session expired.", false);
      return;
    }
    showError(message.error);
    if (["PC_UNAVAILABLE", "ALREADY_CONTROLLED"].includes(message.error)) {
      renderAvailability();
      send({ type: "list" });
    }
    return;
  }
  if (message.type === "ready") {
    if (recoveryRequest) recoveryRequest.authorizedSocket = socket;
    reconnectAttempts = 0; showError("");
    clearTimeout(handshakeTimer);
    if (!socket.authenticated) {
      socket.authenticated = true;
      root.dataset.relayReady = "true";
      $("login").hidden = true;
      $("workspace").hidden = false;
      $("status").textContent = "Connected";
      showError("");
      if (!session && !startTimer) stage("Ready", false);
      clearInterval(renewTimer);
      clearInterval(pingTimer);
      renewTimer = setInterval(() => void renew(), 15000);
      pingTimer = setInterval(ping, 1000);
    }
    return;
  }
  if (message.type === "devices") {
    devices = message.devices;
    renderDevices();
    return;
  }
  if (message.type === "pair-code") {
    clearPairing();
    pairing = { code: message.code, expiresAt: message.expiresAt };
    $("pair-code").textContent =
      "Enter in PC app: " + message.code.match(/.{1,4}/g).join("-");
    $("pair-review").hidden = true;
    pairTimer = setInterval(updatePairingExpiry, 1000);
    updatePairingExpiry();
    return;
  }
  if (message.type === "pair-review") {
    if (pairing?.code !== message.code) return;
    pairing.fingerprint = message.fingerprint;
    $("pair-fingerprint").textContent =
      message.name + " · " + message.fingerprint;
    $("pair-review").hidden = false;
    return;
  }
  if (message.type === "pair-complete") {
    clearPairing("Paired. Enable PC access in the local app.");
    return;
  }
  if (message.type === "started") {
    if (cancelledStart || (pendingStartRequest?.recoveryFence && !$("auto-reconnect")?.checked)) {
      send({ type: "stop", sessionId: message.sessionId }); pendingStartRequest = null;
      return;
    }
    const restoreControl = pendingStartRequest?.restoreControl ?? true;
    cancelRecovery(); pendingStartRequest = null;
    if (!pairing) clearPairing();
    clearTimeout(startTimer); startTimer = null;
    endSession("");
    session = {
      id: message.sessionId,
      screenIds: message.screenIds,
      sources: message.screenIds.map(id => selectedDevice?.screens.find(source => source.id === id)).filter(Boolean),
      focus: message.focus,
      fps: message.fps,
      deviceId: selectedDevice?.id,
      height: message.height || Number($("quality")?.value || 1080),
      transport: message.transport || "auto",
      audio: message.audio === true,
      recoveryFence: selectedDevice?.recoveryFence,
      candidates: [],
    };
    // Connect is the owner's explicit request to use this paired PC. View-only
    // remains available, but a stale unchecked box must not silently eat clicks.
    $("control").checked = restoreControl;
    $("disconnect").disabled = false;
    $("connect").disabled = true;
    $("run").disabled = false;
    $("session-status").textContent = "Connecting video…";
    stage("Capturing screens");
    $("privilege").textContent = selectedDevice?.elevated
      ? "Administrator"
      : "User";
    const compatibility = message.transport === "compatibility";
    if (typeof RTCPeerConnection !== "function") {
      endSession("Video is unavailable in this browser. Check managed Chrome policies with your administrator.");
      return;
    }
    peer = new RTCPeerConnection({ iceServers: message.iceServers, iceTransportPolicy: compatibility ? "relay" : "all" });
    const currentPeer = peer;
    const currentId = session.id;
    peer.addEventListener("icecandidate", event => {
      if (peer === currentPeer && event.candidate) send({ type: "ice", sessionId: currentId, candidate: event.candidate.toJSON() });
    });
    peer.addEventListener("iceconnectionstatechange", () => {
      if (peer === currentPeer && phaseActive && ["checking", "new"].includes(currentPeer.iceConnectionState)) stage(compatibility ? "Connecting through TURN" : "Finding video route");
    });
    peer.addEventListener("datachannel", event => {
      const channel = event.channel;
      if (peer !== currentPeer || channel.label !== "long-cable-input-v1" || inputChannel) { channel.close(); return; }
      inputChannel = channel;
      channel.addEventListener("message", event => {
        if (inputChannel !== channel || !session || typeof event.data !== "string" || event.data.length > 2048) return;
        try {
          const value = JSON.parse(event.data);
          if (value.sessionId === session.id && ["input-ack", "probe-ack"].includes(value.type)) void receive(value);
        } catch {}
      });
      channel.addEventListener("open", () => { inputPathChanged(); ping(); });
      channel.addEventListener("close", () => {
        if (inputChannel !== channel) return;
        inputChannel = null;
        inputPathChanged(); releaseInput();
      });
    });
    function videoReady() {
      recoveryAttempts = 0;
      if (peer !== currentPeer || currentPeer.connectionState !== "connected" ||
        ![...videos.values()].some(video => video.readyState >= 2 && video.videoWidth > 0)) return;
      clearTimeout(videoTimer);
      stage("Connected", false);
      try { localStorage.setItem("long-cable-pc-video-route", JSON.stringify({ deviceId: session.deviceId, transport: session.transport })); } catch {}
      $("session-status").textContent =
        "Video connected · " + session.fps + " FPS target" + (compatibility ? " · Compatibility relay" : "");
    }
    peer.addEventListener("track", (event) => {
      if (peer !== currentPeer) return;
      if (event.track.kind === "audio") { if (session.audio) audioPlayer.accept(event.track); return; }
      const screenId = tracks.get(event.transceiver.mid),
        video = videos.get(screenId);
      if (video) {
        // Ask Chromium for the smallest playout buffer it can support. Browsers
        // that do not expose these hints keep their default receive behaviour.
        try { if ("playoutDelayHint" in event.receiver) event.receiver.playoutDelayHint = 0; } catch {}
        try { if ("jitterBufferTarget" in event.receiver) event.receiver.jitterBufferTarget = 0; } catch {}
        video.srcObject = new MediaStream([event.track]);
        tabs?.refresh();
        onVideo(video, "loadeddata", videoReady, { once: true });
        void video.play().catch(() => {});
      }
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer !== currentPeer) return;
      if (peer?.connectionState === "connected") {
        $("session-status").textContent = "Waiting for video frames…";
        stage("Waiting for first frame");
        videoReady();
      }
      if (["failed", "closed"].includes(peer?.connectionState)) {
        if (!compatibility && retryCompatibility(currentPeer)) return;
        endSession("Compatibility relay failed. Check TURN service access and managed Chrome policies.");
      }
    });
    renderVideos();
    videoTimer = setTimeout(
      () => {
        if (peer !== currentPeer) return;
        if (currentPeer.connectionState !== "connected" && !compatibility && retryCompatibility(currentPeer)) return;
        endSession(
          currentPeer.connectionState === "connected" ? "Video connected but no frames arrived. Try 720p and 30 FPS; check browser video decoding and PC capture." : compatibility ? "Compatibility relay timed out. Check TURN service access and managed Chrome policies." : "Video timed out. Try Compatibility relay in Settings; managed Chrome can restrict direct video even off school Wi-Fi.",
        );
      },
      20000,
    );
    statsTimer = setInterval(() => void readStats(), 1000);
    return;
  }
  if (message.type === "ended") {
    if (message.reason === "local_takeover" && message.sessionId === recoveryRequest?.fromSession) cancelRecovery();
    if (restartRequest?.fromSession === message.sessionId && message.reason !== "browser_stopped") restartRequest = null;
    if (message.sessionId === session?.id)
      endSession(message.reason.replaceAll("_", " "), false);
    return;
  }
  if (["pong", "probe-ack", "input-ack"].includes(message.type)) {
    const key =
      message.type === "input-ack" ? "input:" + message.sequence : message.id;
    const probe = pending.get(key);
    if (!probe) return;
    pending.delete(key);
    sample(
      message.type === "pong"
        ? relaySamples
        : message.type === "probe-ack"
          ? pcSamples
          : inputSamples,
      performance.now() - probe.time,
    );
    updateSummary();
    return;
  }
  if (!session || message.sessionId !== session.id) return;
  if (message.type === "ice" && validIceCandidate(message.candidate)) {
    if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
    else if (session.candidates.length < 128) session.candidates.push(message.candidate);
    return;
  }
  if (message.type === "signal") {
    stage("Negotiating video");
    tracks.clear();
    for (const track of message.tracks) tracks.set(track.mid, track.screenId);
    const current = peer, currentSession = session;
    await current.setRemoteDescription(message.signal);
    if (peer !== current || session !== currentSession) return;
    for (const candidate of currentSession.candidates.splice(0)) await current.addIceCandidate(candidate);
    await current.setLocalDescription(await current.createAnswer());
    if (peer === current && session === currentSession && current.localDescription)
      send({
        type: "signal",
        sessionId: currentSession.id,
        signal: { type: "answer", sdp: current.localDescription.sdp },
      });
    return;
  }
  if (message.type === "command-event" && message.requestId === commandId) {
    if (message.event.type === "output") {
      $("output").textContent = (
        ($("output").textContent === "—" ? "" : $("output").textContent) +
        message.event.text.replace(
          /\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g,
          "",
        )
      ).slice(-1048576);
    }
    if (message.event.type === "exit") {
      $("command-status").textContent =
        "Exit " + (message.event.code ?? "—") + " · " + message.event.reason;
      commandId = null;
      $("run").disabled = false;
      $("stop-command").disabled = true;
    }
  }
}
function clearPairing(message = "") {
  clearInterval(pairTimer);
  pairing = null;
  $("pair-code").textContent = message;
  $("pair-expiry").textContent = "";
  $("pair-review").hidden = true;
  $("pair-fingerprint").textContent = "";
}
function updatePairingExpiry() {
  if (!pairing) return;
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
  if (!seconds) { clearPairing("Code expired. Click Pair PC."); return; }
  $("pair-expiry").textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
const pauseLabels = {
  local_takeover: "local input",
  native_watchdog: "native watchdog",
  native_unavailable: "native input unavailable",
  renderer_unavailable: "capture unavailable",
  display_changed: "display changed",
  locked: "Windows locked",
  suspended: "Windows suspended",
};
function renderAvailability() {
  const online = socket?.readyState === 1 && socket.authenticated;
  $("connect").textContent = !online && authorize ? "Reconnect" : "Connect";
  const connecting = socket?.readyState === 0 || (socket?.readyState === 1 && !socket.authenticated);
  $("connect").disabled = Boolean(session || startTimer || reconnectBusy || connecting) || (online ? !selectedDevice?.available : !authorize);
  if (session) return;
  $("disconnect").disabled = !recoveryRequest;
  $("session-status").textContent = !online ? "Relay offline"
    : !selectedDevice ? "PC offline"
    : selectedDevice.paused ? "PC access paused" + (pauseLabels[selectedDevice.pauseReason] ? " · " + pauseLabels[selectedDevice.pauseReason] : " · enable in Long Cable")
    : selectedDevice.inUse ? "PC in use"
    : selectedDevice.available ? "Available"
    : "PC unavailable";
}
function renderDevices() {
  const previousId = $("device").value;
  $("device").replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent =
        device.name + (device.paused ? " · paused" : device.inUse ? " · in use" : device.available ? "" : " · unavailable");
      return option;
    }),
  );
  if (!devices.length) {
    const option = document.createElement("option");
    option.textContent = "No PC online";
    option.value = "";
    $("device").append(option);
  }
  if (devices.some((d) => d.id === previousId)) $("device").value = previousId;
  const device = devices.find((d) => d.id === $("device").value);
  if (device?.id !== selectedDevice?.id) {
    selectedDevice = device;
    try {
      const saved = JSON.parse(localStorage.getItem("long-cable-pc-video-route") || "null");
      if ($("compatibility") && saved?.deviceId === device?.id && ["auto", "compatibility"].includes(saved.transport)) $("compatibility").checked = saved.transport === "compatibility";
    } catch {}
    renderMonitors();
    if (device?.capabilities?.windows) send({ type: "refresh-sources", deviceId: device.id });
  } else if (JSON.stringify(device?.screens) !== JSON.stringify(selectedDevice?.screens)) {
    const selection = new Map([...$("monitors").querySelectorAll("input")].map(box => [box.value, box.checked]));
    selectedDevice = device;
    renderMonitors(selection);
  } else selectedDevice = device;
  if (recoveryRequest && device?.id === recoveryRequest.deviceId && device.recoveryFence !== recoveryRequest.recoveryFence) {
    cancelRecovery(); showError("PC access changed. Click Connect to start again.");
  }
  if ($("refresh-sources")) $("refresh-sources").disabled = !device?.capabilities?.windows;
  renderAvailability();
  if (recoveryRequest?.authorizedSocket === socket && !session && !startTimer && device?.id === recoveryRequest.deviceId && device.available) {
    const { fromSession, authorizedSocket, ...request } = recoveryRequest;
    clearTimeout(recoveryTimer); recoveryTimer = null;
    requestStart(request);
  }
  if (restartRequest && performance.now() >= restartRequest.expires) restartRequest = null;
  if (!session && restartRequest && device?.id === restartRequest.deviceId && device.available) {
    const request = restartRequest; restartRequest = null;
    requestStart({ deviceId: request.deviceId, screenIds: request.screenIds, fps: request.fps, height: request.height, transport: request.transport, audio: request.audio === true });
  }
}
function renderMonitors(selection) {
  const legend = document.createElement("legend");
  legend.textContent = "Screens & windows";
  $("monitors").replaceChildren(
    legend,
    ...(selectedDevice?.screens ?? []).map((screen) => {
      const label = document.createElement("label"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.value = screen.id;
      box.setAttribute("aria-label", screen.label);
      box.checked = selection?.has(screen.id) ? selection.get(screen.id) : screen.kind !== "window";
      label.dataset.kind = screen.kind || "screen";
      label.title = screen.label;
      label.append(box, document.createTextNode(" " + screen.label));
      return label;
    }),
  );
}
function renderTabActions() {
  const host = $("monitor-tab-actions");
  if (!host) return;
  host.replaceChildren(...(session?.screenIds || []).map(id => {
    const button = document.createElement("button");
    button.type = "button"; button.dataset.screenId = id;
    const label = session.sources.find(screen => screen.id === id)?.label || "Source";
    button.textContent = "↗ " + label;
    button.setAttribute("aria-label", "Tab: " + label);
    return button;
  }));
}
function focus(screenId) {
  if (
    !session ||
    !session.screenIds.includes(screenId) ||
    session.focus === screenId
  )
    return;
  session.focus = screenId;
  send({ type: "focus", sessionId: session.id, screenId });
  for (const [id, video] of videos) {
    video.parentElement.classList.toggle("focused", id === screenId);
    if (!floating) video.parentElement.hidden = $("layout").value === "full" && id !== screenId;
  }
  windowManager?.metrics(latestVideoStats, screenId);
}
function position(event, video) {
  const box = video.getBoundingClientRect(),
    ratio = video.videoWidth / video.videoHeight;
  if (!Number.isFinite(ratio) || !ratio) return null;
  const width = Math.min(box.width, box.height * ratio),
    height = width / ratio;
  const x = (event.clientX - box.left - (box.width - width) / 2) / width,
    y = (event.clientY - box.top - (box.height - height) / 2) / height;
  if (
    (x < 0 || x > 1 || y < 0 || y > 1) &&
    !video.hasPointerCapture(event.pointerId)
  )
    return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
function input(screenId, value) {
  if (
    !session || clipboardRequest ||
    !$("control").checked ||
    peer?.connectionState !== "connected" ||
    !validInput(value)
  )
    return;
  const seq = ++sequence;
  pending.set("input:" + seq, { time: performance.now() });
  const message = {
    type: "input",
    sessionId: session.id,
    sequence: seq,
    screenId,
    input: value,
  };
  if (inputChannel?.readyState === "open" && inputChannel.bufferedAmount < 8192) {
    try { inputChannel.send(JSON.stringify(message)); return; } catch {}
  }
  send(message);
}
function releaseInput() {
  if (session) input(session.focus, { kind: "release" });
}
function inputPathChanged() {
  pcSamples.length = 0; inputSamples.length = 0;
  for (const key of pending.keys()) if (key.startsWith("pc:") || key.startsWith("input:")) pending.delete(key);
  updateSummary();
}
function makeVideo(id, label) {
  const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.tabIndex = 0;
    let heldPointer = null;
    video.setAttribute("aria-label", label);
    onVideo(video, "paste", event => {
      if (!$("control").checked) return;
      event.preventDefault(); event.stopPropagation();
      if ([...(event.clipboardData?.items || [])].some(item => item.kind === "file")) { clipboardStatus("Only text paste is supported."); return; }
      const text = event.clipboardData?.getData("text/plain");
      if (typeof text === "string") sendClipboard(text, true, id);
    });
    onVideo(video, "pointerdown", (event) => {
      focus(id);
      video.focus({ preventScroll: true });
      if (!$("control").checked) return;
      const point = position(event, video);
      if (!point) return;
      event.preventDefault();
      heldPointer = event.pointerId;
      video.setPointerCapture(event.pointerId);
      input(id, { kind: "down", ...point, button: event.button });
    });
    onVideo(video, "pointerup", (event) => {
      heldPointer = null;
      if (moveFrame) { frameWindow.cancelAnimationFrame(moveFrame); moveFrame = null; latest = null; }
      const point = position(event, video);
      if (point) input(id, { kind: "up", ...point, button: event.button });
      if (video.hasPointerCapture(event.pointerId))
        video.releasePointerCapture(event.pointerId);
    });
    let frameWindow = window;
    let moveFrame = null,
      latest = null;
    onVideo(video, "pointermove", (event) => {
      if (!$("control").checked) return;
      latest = position(event, video);
      if (!moveFrame) {
        frameWindow = video.ownerDocument.defaultView || window;
        moveFrame = frameWindow.requestAnimationFrame(() => {
          moveFrame = null;
          if (latest) input(id, { kind: "move", ...latest });
        });
      }
    });
    onVideo(video, "contextmenu", (event) => event.preventDefault());
    onVideo(video, "blur", () => input(id, { kind: "release" }));
    onVideo(video, "pointercancel", () =>
      input(id, { kind: "release" }),
    );
    onVideo(video, "lostpointercapture", event => {
      if (heldPointer === event.pointerId) { heldPointer = null; input(id, { kind: "release" }); }
    });
    videoLifetime.signal.addEventListener("abort", () => { if (moveFrame) frameWindow.cancelAnimationFrame(moveFrame); }, { once: true });
    onVideo(video,
      "wheel",
      (event) => {
        if (!$("control").checked) return;
        event.preventDefault();
        input(id, {
          kind: "wheel",
          deltaX: Math.round(Math.max(-1200, Math.min(1200, event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.clientHeight : 1)))),
          deltaY: Math.round(Math.max(-1200, Math.min(1200, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.clientHeight : 1)))),
        });
      },
      { passive: false },
    );
    for (const kind of ["keydown", "keyup"])
      onVideo(video, kind, (event) => {
        if (!$("control").checked || !validInput({ kind, code: event.code })) return;
        // Let the browser deliver its paste event, but never forward Ctrl+V
        // before that event has replaced the Windows clipboard.
        if (event.code === "KeyV" && (event.ctrlKey || event.metaKey)) { event.stopPropagation(); return; }
        event.preventDefault();
        event.stopPropagation();
        input(id, { kind, code: event.code });
      });
  return video;
}
function renderVideos() {
  videoLifetime?.abort();
  videoLifetime = new AbortController();
  videos.clear();
  windowManager?.dispose();
  windowManager = floating ? screenWindows(root, { focus, release: releaseInput, controls,
    popout: id => { if (!tabs.open(id)) showError("Allow popups to open a monitor tab."); },
    takeBack: id => tabs.reclaim(id), changed: () => tabs.changed(),
  }) : null;
  $("videos").replaceChildren();
  for (const [index, id] of session.screenIds.entries()) {
    const screen = session.sources.find((s) => s.id === id) || { label: "Source" },
      figure = document.createElement("figure"),
      caption = document.createElement("figcaption"),
      video = makeVideo(id, screen.label);
    caption.textContent = screen.label + " · click to focus";
    figure.classList.toggle("focused", id === session.focus);
    if (!floating) onVideo(caption, "click", () => focus(id));
    if (windowManager) windowManager.add(id, screen.label, video, index, session.screenIds.length);
    else { figure.append(caption, video); $("videos").append(figure); }
    videos.set(id, video);
    if (windowManager) tabs.register(id, screen.label, video, video.parentElement);
  }
  windowManager?.metrics([], session.focus);
  renderTabActions();
  if (floating && root.dataset.view !== "computer") windowManager?.minimize();
}
function retryCompatibility(currentPeer) {
  if (disposed || peer !== currentPeer || !session || session.transport === "compatibility" || !session.deviceId || !socket?.authenticated) return false;
  restartRequest = { deviceId: session.deviceId, screenIds: [...session.screenIds], fps: session.fps,
    height: session.height, audio: session.audio, transport: "compatibility", fromSession: session.id, expires: performance.now() + 10000 };
  if ($("compatibility")) $("compatibility").checked = true;
  endSession("Direct video unavailable. Trying compatibility relay…", true, true);
  send({ type: "list" });
  return true;
}
function endSession(reason, notify = true, preserveRestart = false) {
  clearTimeout(clipboardTimer); clipboardRequest = null; clipboardStatus("");
  if ($("clipboard-text")) $("clipboard-text").value = "";
  if (!preserveRestart) restartRequest = null;
  const old = session;
  const recovering = !preserveRestart && queueSessionRecovery(reason, old || pendingStartRequest);
  if (startTimer && !old && reason && !recovering && !preserveRestart) cancelledStart = true;
  if (reason && !recovering && !preserveRestart) cancelRecovery();
  session = null;
  clearInterval(statsTimer);
  clearTimeout(videoTimer);
  clearTimeout(startTimer); startTimer = null;
  audioPlayer.clear();
  if ($("audio-status")) $("audio-status").textContent = "";
  if (reason || !phaseActive) stage(reason || "Stopped", false);
  previous.clear();
  pending.clear();
  if (old && notify) send({ type: "stop", sessionId: old.id });
  videoLifetime?.abort();
  const oldPeer = peer;
  peer = null;
  const oldChannel = inputChannel; inputChannel = null; oldChannel?.close();
  oldPeer?.close();
  windowManager?.dispose(); windowManager = null; latestVideoStats = [];
  for (const video of videos.values()) video.srcObject = null;
  tabs?.clear();
  renderTabActions();
  videos.clear();
  tracks.clear();
  $("videos").replaceChildren();
  if (old && reason) {
    $("last-session-status").textContent = "Last session: " + (reason === "local takeover" ? "stopped by local input" : reason);
    $("last-session-status").hidden = false;
    if (!preserveRestart && !["Disconnected", "Signed out", "Console closed", "Page closed", "PC changed"].includes(reason)) showError(reason);
  }
  $("disconnect").disabled = true;
  renderAvailability();
  if (recovering) stage("Reconnecting PC…");
  $("run").disabled = true;
  $("stop-command").disabled = true;
  commandId = null;
  $("control").checked = false;
  for (const samples of [inputSamples, pcSamples]) samples.length = 0;
  $("stats-details").textContent = "";
  detailRows = []; detailsDirty = false;
  clearTimeout(summaryTimer); summaryTimer = null;
  updateSummary();
}
function ping() {
  const now = performance.now();
  for (const [id, probe] of pending)
    if (now - probe.time > 5000) pending.delete(id);
  const id = "relay:" + crypto.randomUUID();
  pending.set(id, { time: now });
  send({ type: "ping", id });
  if (session) {
    const probe = "pc:" + crypto.randomUUID();
    pending.set(probe, { time: now });
    const message = { type: "probe", sessionId: session.id, id: probe };
    if (inputChannel?.readyState === "open" && inputChannel.bufferedAmount < 8192) {
      try { inputChannel.send(JSON.stringify(message)); } catch { send(message); }
    } else send(message);
  }
}
function updateSummary() {
  if (disposed || summaryTimer !== null) return;
  summaryTimer = setTimeout(() => { summaryTimer = null; if (!disposed) paintSummary(); }, 250);
}
function detailsRequested() {
  const stats = $("stats");
  return Boolean(stats && (stats.dataset.expanded === "true" || stats.matches(":hover") || !$("stats-toggle") && stats.matches(":focus-within")) || tabs?.wantsDetails());
}
function renderDetails() {
  if (detailsDirty && detailsRequested()) {
    $("stats-details").textContent = detailRows.map(render => render()).join("\n\n");
    detailsDirty = false;
  }
}
function paintSummary() {
  renderDetails();
  $("stats-summary").textContent =
    "Relay " +
    metric(relaySamples.at(-1)?.value) +
    " · PC " +
    metric(pcSamples.at(-1)?.value) +
    " · Input " +
    metric(inputSamples.at(-1)?.value) +
    " · Input p50 " +
    metric(percentile(inputSamples, 0.5)) +
    " · p99 " +
    metric(percentile(inputSamples, 0.99));
  const compact = $("stats-compact"), graph = $("ping-line");
  if (compact) {
    const focused = latestVideoStats.find(row => row.screenId === session?.focus);
    compact.textContent = metric(pcSamples.at(-1)?.value ?? relaySamples.at(-1)?.value) + " · " + (focused?.fps == null ? "—" : focused.fps.toFixed(0)) + " FPS";
  }
  if (graph) {
    const samples = (pcSamples.length ? pcSamples : relaySamples).filter(row => performance.now() - row.time < 60000).slice(-60);
    const max = Math.max(20, ...samples.map(row => row.value));
    graph.setAttribute("points", samples.map((row, index) => `${index * 100 / 59},${24 - Math.min(22, row.value / max * 22)}`).join(" "));
  }
  tabs?.metrics("PC " + metric(pcSamples.at(-1)?.value) + " · Input " + metric(inputSamples.at(-1)?.value), $("stats-details").textContent, latestVideoStats);
}
async function readStats() {
  if (!peer || !session) return;
  const current = peer,
    currentSession = session;
  const report = await current.getStats();
  if (peer !== current || session !== currentSession) return;
  const details = [() => "Input path: " + (inputChannel?.readyState === "open" ? "WebRTC" : "WebSocket relay"), () => "Connection stages: " + phaseLog.map((item, i) => item.label + " " + (((phaseLog[i + 1]?.at ?? (phaseActive ? performance.now() : phaseFinished)) - item.at) / 1000).toFixed(1) + "s").join(" → ")],
    sampleRecord = {
      time: new Date().toISOString(),
      focus: currentSession.screenIds.indexOf(currentSession.focus),
      relayRttMs: relaySamples.at(-1)?.value ?? null,
      pcRttMs: pcSamples.at(-1)?.value ?? null,
      inputP50Ms: percentile(inputSamples, 0.5),
      inputP99Ms: percentile(inputSamples, 0.99),
      video: [],
    };
  for (const row of report.values()) {
    if (row.type === "inbound-rtp" && row.kind === "audio") {
      const label = "Audio: " + audioPlayer.state() + " · " + (row.packetsReceived ?? 0) + " packets · jitter " + metric((row.jitter || 0) * 1000);
      details.push(() => label);
      if ($("audio-status")) $("audio-status").textContent = label;
    }
    if (row.type === "transport" && row.selectedCandidatePairId) {
      const pair = report.get(row.selectedCandidatePairId),
        local = report.get(pair?.localCandidateId),
        remote = report.get(pair?.remoteCandidateId);
      details.push(() =>
        "Video path: " +
          ([local?.candidateType, remote?.candidateType].includes("relay")
            ? "TURN"
            : "Direct") +
          " · ICE RTT " +
          metric(
            typeof pair?.currentRoundTripTime === "number"
              ? pair.currentRoundTripTime * 1000
              : null,
          ),
      );
    }
    if (row.type !== "inbound-rtp" || row.kind !== "video") continue;
    const old = previous.get(row.id),
      seconds = old ? (row.timestamp - old.timestamp) / 1000 : 0;
    const frames = old ? row.framesDecoded - old.framesDecoded : 0;
    const codec = report.get(row.codecId)?.mimeType ?? "Unknown";
    const video = {
      screenId: tracks.get(row.mid),
      monitor: currentSession.screenIds.indexOf(tracks.get(row.mid)),
      width: row.frameWidth,
      height: row.frameHeight,
      fps: row.framesPerSecond ?? (seconds > 0 ? frames / seconds : null),
      mbps:
        seconds > 0
          ? (Math.max(0, row.bytesReceived - old.bytesReceived) * 8) /
            seconds /
            1000000
          : null,
      decodeMs:
        frames > 0
          ? (Math.max(0, row.totalDecodeTime - old.totalDecodeTime) * 1000) /
            frames
          : null,
      jitterMs: typeof row.jitter === "number" ? row.jitter * 1000 : null,
      packetsLost: row.packetsLost,
      framesDropped: row.framesDropped,
      codec,
      decoder: row.decoderImplementation || "Not reported",
    };
    details.push(() =>
      "Monitor " +
        (video.monitor + 1) +
        ": " +
        (video.width ?? "—") +
        "×" +
        (video.height ?? "—") +
        " · " +
        (video.fps?.toFixed(1) ?? "—") +
        " FPS · " +
        (video.mbps?.toFixed(2) ?? "—") +
        " Mbps\nDecode " +
        metric(video.decodeMs) +
        " · Jitter " +
        metric(video.jitterMs) +
        " · Lost packets " +
        (video.packetsLost ?? "—") +
        " · Dropped frames " +
        (video.framesDropped ?? "—") +
        "\n" +
        codec +
        " · " +
        video.decoder,
    );
    sampleRecord.video.push(video);
    previous.set(row.id, row);
  }
  details.push(() =>
    "PC RTT p50 " +
      metric(percentile(pcSamples, 0.5)) +
      " / p99 " +
      metric(percentile(pcSamples, 0.99)) +
      "\nInput ACK measures native injection completion, not the frame reaching your eyes.\nLast 60 seconds / up to 512 input samples. Video settings are targets.",
  );
  detailRows = details;
  detailsDirty = true;
  latestVideoStats = sampleRecord.video;
  windowManager?.metrics(latestVideoStats, session.focus);
  exported.push(sampleRecord);
  if (exported.length > 3600) exported.shift();
  updateSummary();
}
function logout() {
  authorizationVersion++; reconnectBusy = false;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  root.dataset.relayReady = "false";
  clearPairing();
  endSession("Signed out");
  clearInterval(renewTimer);
  clearInterval(pingTimer);
  socket?.close();
  socket = null;
  if (auth)
    void api("logout?scope=local", {}, auth.access_token).catch(() => {});
  auth = null;
  credential = null;
  $("workspace").hidden = true;
  $("login").hidden = Boolean(authorize);
  $("password-form").hidden = false;
  $("mfa-form").hidden = true;
  $("status").textContent = "Signed out";
}
on($("device"), "change", () => {
  if (session) endSession("PC changed");
  selectedDevice = devices.find((d) => d.id === $("device").value);
  renderMonitors();
  renderAvailability();
});
on($("connect"), "click", () => {
  if (authorize && !(socket?.readyState === 1 && socket.authenticated)) { void reconnectRelay(); return; }
  if (!selectedDevice?.available || session) return;
  cancelRecovery();
  recoveryAttempts = 0;
  const ids = [...$("monitors").querySelectorAll("input:checked")].map(
    (box) => box.value,
  );
  if (!ids.length) {
    showError("Select a screen.");
    return;
  }
  showError("");
  if ($("audio")?.checked) audioPlayer.unlock();
  requestStart({
    deviceId: selectedDevice.id,
    screenIds: ids,
    fps: Number($("fps").value),
    height: Number($("quality")?.value || 1080),
    transport: $("compatibility")?.checked ? "compatibility" : "auto",
    audio: $("audio")?.checked === true,
  });
});
on($("disconnect"), "click", () => endSession("Disconnected"));
if ($("auto-reconnect")) {
  try { $("auto-reconnect").checked = localStorage.getItem("long-cable-pc-auto-reconnect") !== "false"; } catch {}
  on($("auto-reconnect"), "change", () => {
    try { localStorage.setItem("long-cable-pc-auto-reconnect", String($("auto-reconnect").checked)); } catch {}
    if (!$("auto-reconnect").checked) {
      cancelRecovery();
      if (startTimer && pendingStartRequest?.recoveryFence) endSession("Disconnected");
      renderAvailability(); stage("Auto reconnect off", false);
    }
  });
}
function changeScreens(event) {
  if ($("monitors").querySelectorAll("input:checked").length > 4) {
    if (event?.target?.matches('input[type="checkbox"]')) event.target.checked = false;
    showError("Select up to 4 sources."); return;
  }
  if (!session || !selectedDevice) return;
  const screenIds = [...$("monitors").querySelectorAll("input:checked")].map(box => box.value);
  restartRequest = screenIds.length ? { deviceId: selectedDevice.id, screenIds, fps: Number($("fps").value), height: Number($("quality")?.value || 1080), audio: $("audio")?.checked === true, transport: $("compatibility")?.checked ? "compatibility" : "auto", expires: performance.now() + 5000 } : null;
  endSession(screenIds.length ? "Changing screens…" : "No screens selected", true, true);
}
on($("monitors"), "change", changeScreens);
if ($("refresh-sources")) on($("refresh-sources"), "click", () => {
  if (selectedDevice?.capabilities?.windows) send({ type: "refresh-sources", deviceId: selectedDevice.id });
});
if ($("source-picker")) on($("source-picker"), "toggle", () => {
  if ($("source-picker").open && selectedDevice?.capabilities?.windows) send({ type: "refresh-sources", deviceId: selectedDevice.id });
});
if ($("clipboard-send")) on($("clipboard-send"), "click", () => sendClipboard($("clipboard-text").value, false));
if ($("clipboard-paste")) on($("clipboard-paste"), "click", () => sendClipboard($("clipboard-text").value));
on($("fps"), "change", changeScreens);
if ($("quality")) on($("quality"), "change", changeScreens);
if ($("compatibility")) on($("compatibility"), "change", changeScreens);
if ($("audio")) on($("audio"), "change", () => { if ($("audio").checked) audioPlayer.unlock(); changeScreens(); });
if ($("audio-resume")) on($("audio-resume"), "click", () => audioPlayer.unlock());
if ($("connection-cancel")) on($("connection-cancel"), "click", () => { const pending = Boolean(startTimer); endSession("Disconnected"); if (pending) socket?.close(); });
on($("refresh"), "click", () => send({ type: "list" }));
on($("pair"), "click", () => send({ type: "pair-start" }));
on($("approve"), "click", () => {
  if (pairing && Date.now() >= pairing.expiresAt) {
    clearPairing("Code expired. Click Pair PC.");
    return;
  }
  if (pairing?.fingerprint)
    send({
      type: "pair-approve",
      code: pairing.code,
      fingerprint: pairing.fingerprint,
    });
});
on($("logout"), "click", logout);
on($("layout"), "change", () => {
  if (windowManager) { windowManager.arrange($("layout").value, session?.focus); return; }
  $("videos").className = $("layout").value;
  for (const [id, video] of videos)
    video.parentElement.hidden =
      $("layout").value === "full" && id !== session?.focus;
});
on($("fullscreen"),
  "click",
  () =>
    void $("videos")
      .requestFullscreen()
      .catch(() => {}),
);
on($("command-form"), "submit", (event) => {
  event.preventDefault();
  if (!session || commandId || !$("command").value.trim()) return;
  commandId = crypto.randomUUID();
  $("output").textContent = "—";
  $("command-status").textContent = "Running";
  $("run").disabled = true;
  $("stop-command").disabled = false;
  send({
    type: "command",
    sessionId: session.id,
    requestId: commandId,
    shell: $("shell").value,
    command: $("command").value,
    admin: selectedDevice.elevated === true,
  });
});
on($("stop-command"), "click", () => {
  if (session) send({ type: "command-stop", sessionId: session.id });
});
on($("control"), "change", () => {
  if (session && !$("control").checked) {
    const seq = ++sequence;
    send({
      type: "input",
      sessionId: session.id,
      sequence: seq,
      screenId: session.focus,
      input: { kind: "release" },
    });
  }
});
on(window, "blur", releaseInput);
if ($("duplicate-views")) on($("duplicate-views"), "change", () => tabs?.duplicatesChanged());
if ($("monitor-tab-actions")) on($("monitor-tab-actions"), "click", event => {
  const button = event.target.closest("button[data-screen-id]");
  if (button && !tabs?.open(button.dataset.screenId)) showError("Allow popups to open a monitor tab.");
});
if ($("stats-toggle")) {
  on($("stats-toggle"), "click", () => {
    const open = $("stats-toggle").getAttribute("aria-expanded") !== "true";
    $("stats-toggle").setAttribute("aria-expanded", String(open));
    $("stats").dataset.expanded = String(open);
    if (open) { renderDetails(); updateSummary(); }
  });
  on($("stats"), "keydown", event => {
    if (event.key === "Escape") { $("stats").dataset.expanded = "false"; $("stats-toggle").setAttribute("aria-expanded", "false"); }
  });
}
if ($("stats")) for (const type of ["pointerenter", "focusin"]) on($("stats"), type, () => { renderDetails(); updateSummary(); });
on(document, "visibilitychange", () => { if (document.hidden) releaseInput(); });
on(root, "pc-visibility", event => {
  releaseInput();
  if (!event.detail.visible) windowManager?.minimize();
});
on($("export"), "click", () => {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          endpoint: relayOrigin,
          recordedAt: new Date().toISOString(),
          description:
            "Measured RTT, native input ACK and decoded RTP stats. No glass-to-glass timing; no IPs, keys or command text.",
          samples: exported,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "long-cable-pc-benchmark.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
on(window, "pagehide", () => {
  endSession("Page closed");
  socket?.close();
});
on(window, "message", (event) => {
  if (authorize) return;
  if (event.source !== window.opener || !publicParents.has(event.origin))
    return;
  if (event.data?.type === "long-cable-relay-signout") {
    logout();
    return;
  }
  if (
    event.data?.type !== "long-cable-relay-ticket" ||
    typeof event.data.ticket !== "string"
  )
    return;
  parentOrigin = event.origin;
  credential = { ticket: event.data.ticket };
  if (!socket || socket.readyState > 1) connect();
  else if (socket.readyState === 1) authenticate();
});
async function initialize() {
  try {
    if (authorize) {
      $("login").hidden = true;
      $("workspace").hidden = true;
      $("status").textContent = "Connecting";
      stage("Checking access");
      const data = await authorize();
      if (disposed) return;
      const endpoint = new URL(data.relay);
      if (endpoint.origin !== data.relay || endpoint.username || endpoint.password ||
        !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))))
        throw new Error("Invalid relay address.");
      relayOrigin = endpoint.origin;
      credential = { ticket: data.ticket };
      connect();
    } else {
      config = await fetch("/config", { cache: "no-store", signal: lifetime.signal }).then((r) => r.json());
      if (!disposed) $("owner").textContent = config.owner;
    }
  } catch (error) {
    if (!disposed) {
      $("status").textContent = "Disconnected";
      stage("Access check failed", false);
      showError(authorize ? error.message : "Relay configuration unavailable.");
      if (authorize) $("workspace").hidden = false;
      renderAvailability();
    }
  }
}
void initialize();
// This handshake contains no credential. The opener validates this window's
// exact source/origin before returning a short-lived ticket to this origin.
if (!authorize && window.opener)
  window.opener.postMessage({ type: "long-cable-relay-ready" }, "*");
return () => {
  if (disposed) return;
  endSession("Console closed");
  tabs?.dispose();
  audioPlayer.dispose(); clearTimeout(handshakeTimer);
  disposed = true;
  authorizationVersion++;
  clearTimeout(summaryTimer); summaryTimer = null; detailRows = [];
  lifetime.abort();
  clearTimeout(reconnectTimer); reconnectTimer = null;
  clearPairing();
  clearInterval(renewTimer);
  clearInterval(pingTimer);
  const old = socket;
  socket = null;
  credential = null;
  auth = null;
  old?.close();
};
}

if (typeof document !== "undefined" && document.getElementById("long-cable-standalone-console"))
  mountConsole(document.getElementById("long-cable-standalone-console"));
