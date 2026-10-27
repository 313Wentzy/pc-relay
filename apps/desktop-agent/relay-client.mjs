import { proofBody } from "../relay/auth.mjs";
import { relayAddress, validInput, validClipboard, validIceCandidate, IDLE_MS, PAUSE_REASONS } from "../relay/protocol.mjs";
import { connectionDiagnostic } from "./diagnostics.mjs";
import { randomUUID } from "node:crypto";

// Main-process transport. The renderer never receives a certificate/private key
// and cannot mint a control lease or invoke a shell directly.
export class AgentRelay {
  constructor({
    vault,
    screens,
    capture,
    input,
    clipboard = null,
    refreshSources = null,
    release,
    command,
    stopCommand,
    heartbeat = () => {},
    elevated = () => false,
    ready = () => true,
    relayOrigins = [],
    onStatus = () => {},
    WebSocketClass = WebSocket,
    clock = () => ({ wall: Date.now(), mono: performance.now() }),
  }) {
    Object.assign(this, {
      vault,
      screens,
      capture,
      input,
      clipboard: clipboard || (() => { throw Error("CLIPBOARD_UNAVAILABLE"); }),
      refreshSources: refreshSources || (async () => {}),
      release,
      command,
      stopCommand,
      heartbeat,
      elevated,
      ready,
      onStatus,
      WebSocketClass,
      clock,
    });
    this.ws = null;
    this.session = null;
    this.enabled = false;
    this.pauseReason = "startup";
    this.connected = false;
    this.state = null;
    this.generation = 0;
    this.last = clock();
    this.message = "Offline";
    this.connection = null;
    this.pendingInputs = new Map();
    this.accessVersion = 0;
    this.pauseVersion = 0;
    this.recoveryId = randomUUID();
    this.relayOrigins = [...new Set(relayOrigins.map(relayAddress))];
    this.capabilities = { clipboard: typeof clipboard === "function", windows: typeof refreshSources === "function" };
    if (this.relayOrigins.length > 4) throw Error("INVALID_RELAY_ORIGINS");
    this.closed = false;
    this.scheduleWatch();
  }
  scheduleWatch() {
    const period = this.session ? 100 : 1000;
    if (this.closed || this.watchPeriod === period) return;
    clearInterval(this.watch);
    this.watchPeriod = period;
    this.watch = setInterval(() => this.tick(), period);
    this.watch.unref?.();
  }
  status() {
    return {
      paired: Boolean(this.state?.certificate),
      relay: this.attempt?.relay || this.state?.relay || "",
      connected: this.connected,
      enabled: this.enabled,
      available: this.connected && this.accessReady() && !this.session,
      pauseReason: this.pauseReason,
      activeSession: this.session?.id || null,
      message: this.message,
      connection: this.connection,
    };
  }
  recordConnection(reason, closeCode = null) {
    this.connection = connectionDiagnostic(reason, this.clock().wall, closeCode);
  }
  notify(message) {
    if (message) this.message = message;
    this.onStatus(this.status());
  }
  send(message) {
    if (this.ws?.readyState !== 1) return false;
    if (this.ws.bufferedAmount > 1048576) {
      this.disconnect("Backpressure");
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }
  async restore() {
    const generation = this.generation;
    const pauseVersion = this.pauseVersion;
    const saved = await this.vault.readState();
    if (generation !== this.generation) return;
    this.state = saved;
    // Only a setting previously saved by the trusted local UI can survive restart.
    this.enabled = Boolean(saved?.certificate && saved?.allowRemote === true);
    if (!this.enabled) this.pauseReason = "startup";
    else if (pauseVersion === this.pauseVersion) this.pauseReason = null;
    if (this.state?.certificate && this.state?.relay)
      await this.connect(this.relayOrigins[0] || this.state.relay);
  }
  async persist() {
    const saved = this.state;
    this.storageQueue = (this.storageQueue || Promise.resolve()).then(() =>
      this.vault.writeState(saved),
    );
    await this.storageQueue;
  }
  async pair(relay, code) {
    relay = relayAddress(relay);
    code = code.trim().replaceAll("-", "");
    if (!/^[0-9a-f]{24}$/.test(code)) throw new Error("INVALID_PAIR_CODE");
    await this.vault.ensure();
    this.enabled = false;
    this.accessVersion++;
    await this.connect(relay, code);
  }
  async connect(relay, code = null) {
    relay = relayAddress(relay);
    this.disconnect("Connecting");
    this.attempt = { relay, code };
    this.connectStarted = this.clock().mono;
    const generation = this.generation;
    const ws = new this.WebSocketClass(
      relay.replace(/^http/, "ws") + "/connect",
    );
    this.ws = ws;
    let queue = Promise.resolve(),
      queued = 0;
    ws.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
      this.lastRelayMessage = this.clock().mono;
      if (++queued > 128 || String(event.data).length > 65536) {
        this.disconnect("Invalid relay response");
        return;
      }
      queue = queue
        .then(() =>
          generation === this.generation
            ? this.receive(JSON.parse(String(event.data)), generation)
            : undefined,
        )
        .catch(() => this.disconnect("Connection rejected"))
        .finally(() => queued--);
    });
    ws.addEventListener("close", (event) => {
      if (generation !== this.generation) return;
      this.connected = false;
      // Retain only a known protocol category, never an arbitrary close reason.
      this.recordConnection(event.reason || (this.connection?.reason === "connected" ? "closed" : this.connection?.reason || "closed"), event.code);
      this.stopSession("connection_lost", false);
      this.notify("Relay disconnected: " + this.connection.reason.replaceAll("_", " "));
      if (!code && this.state?.certificate && event.code !== 1008) {
        this.retryDelay = Math.min(30000, (this.retryDelay || 500) * 2);
        this.retry = setTimeout(() => {
          if (generation === this.generation)
            void this.connect(this.nextRelay(relay)).catch(() =>
              this.notify("Reconnect failed"),
            );
        }, this.retryDelay);
      }
    });
    ws.addEventListener("error", () => {
      if (generation === this.generation) {
        this.recordConnection("unavailable");
        this.notify("Relay unavailable");
      }
    });
  }
  nextRelay(current) {
    if (!this.relayOrigins.length) return this.state.relay;
    const index = this.relayOrigins.indexOf(current);
    return this.relayOrigins[(index + 1) % this.relayOrigins.length];
  }
  async receive(message, generation) {
    if (message.type === "challenge") {
      if (typeof message.nonce !== "string" || message.nonce.length !== 43)
        throw new Error("INVALID_CHALLENGE");
      const code = this.attempt.code;
      const certificate = code || this.state?.certificate;
      if (!certificate) throw new Error("PAIR_FIRST");
      const signature = await this.vault.signRelay(
        proofBody(message.nonce, certificate),
      );
      if (generation !== this.generation) return;
      if (code)
        this.send({
          type: "pair-join",
          code,
          publicKey: this.vault.publicIdentity().publicKey,
          name: "Long Cable",
          signature,
        });
      else this.send({ type: "agent-auth", certificate, signature });
      return;
    }
    if (message.type === "pair-waiting") {
      this.notify("Approve the matching fingerprint in the browser.");
      return;
    }
    if (message.type === "paired") {
      const data = JSON.parse(
        Buffer.from(message.certificate.split(".")[0], "base64url").toString(),
      );
      if (data.deviceId !== this.vault.publicIdentity().fingerprint)
        throw new Error("DEVICE_MISMATCH");
      this.state = {
        version: 1,
        certificate: message.certificate,
        relay: this.attempt.relay,
      };
      await this.persist();
      if (generation !== this.generation) return;
      await this.connect(this.relayOrigins[0] || this.state.relay);
      this.notify("Paired. Enable PC access locally.");
      return;
    }
    if (message.type === "agent-ready") {
      this.connected = true;
      this.recordConnection("connected");
      this.retryDelay = 500;
      this.lastRelayMessage = this.clock().mono;
      this.notify(this.accessReady() ? "Available" : "PC access paused");
      this.publish();
      return;
    }
    if (message.type === "error") {
      this.recordConnection(message.error);
      this.stopSession("relay_error");
      this.notify(message.error);
      return;
    }
    if (message.type === "started") {
      if (message.recoveryFence !== undefined && message.recoveryFence !== this.recoveryFence()) {
        this.send({ type: "end", sessionId: message.sessionId, reason: "local_takeover" });
        return;
      }
      const now = this.clock(),
        ids = this.screens().map((s) => s.id);
      if (
        !this.accessReady() ||
        this.session ||
        !Array.isArray(message.screenIds) ||
        !message.screenIds.length ||
        message.screenIds.some((id) => !ids.includes(id)) ||
        message.expiresAt <= now.wall ||
        message.expiresAt > now.wall + 45000 ||
        message.trustExpiresAt < message.expiresAt
      ) {
        this.send({
          type: "end",
          sessionId: message.sessionId,
          reason: "native_unavailable",
        });
        return;
      }
      const session = {
        id: message.sessionId,
        audio: message.audio === true,
        iceSent: 0,
        screens: [...message.screenIds],
        deadline: now.mono + message.expiresAt - now.wall,
        trustDeadline: now.mono + message.trustExpiresAt - now.wall,
        activity: now.mono,
        sequence: 0,
        expiresAt: message.expiresAt,
      };
      this.session = session;
      this.scheduleWatch();
      this.last = now;
      try {
        await this.input({ type: "begin", sessionId: session.id });
        await this.capture({ ...message, type: "start" });
        if (this.session !== session) return;
        this.notify("Session active");
      } catch {
        this.stopSession("capture_failed");
      }
      return;
    }
    if (message.type === "ended") {
      if (message.sessionId === this.session?.id)
        this.stopSession(message.reason, false);
      return;
    }
    if (message.type === "refresh-sources") {
      if (this.connected && this.accessReady()) { try { await this.refreshSources(); } catch { /* Keep the existing catalog on a transient enumeration failure. */ } this.publish(); }
      return;
    }
    const s = this.session;
    if (!s || message.sessionId !== s.id || !this.authorized(s.id)) return;
    if (message.type === "renew") {
      const now = this.clock();
      if (
        !Number.isFinite(message.expiresAt) ||
        message.expiresAt <= now.wall ||
        message.expiresAt > now.wall + 45000
      )
        throw new Error("INVALID_RENEWAL");
      s.expiresAt = message.expiresAt;
      s.deadline = Math.min(
        s.trustDeadline,
        now.mono + message.expiresAt - now.wall,
      );
      return;
    }
    if (message.type === "signal") {
      await this.capture({
        type: "signal",
        sessionId: s.id,
        signal: message.signal,
      });
      return;
    }
    if (message.type === "ice" && validIceCandidate(message.candidate)) {
      await this.capture({ type: "ice", sessionId: s.id, candidate: message.candidate });
      return;
    }
    if (message.type === "visibility") {
      if (!Array.isArray(message.screenIds) || new Set(message.screenIds).size !== message.screenIds.length || message.screenIds.some(id => !s.screens.includes(id))) return;
      await this.capture({ type: "visibility", sessionId: s.id, screenIds: [...message.screenIds] });
      return;
    }
    if (message.type === "focus") {
      if (s.screens.includes(message.screenId)) {
        s.activity = this.clock().mono;
        await this.capture({
          type: "focus",
          sessionId: s.id,
          screenId: message.screenId,
        });
      }
      return;
    }
    if (message.type === "probe") {
      this.send({ type: "probe-ack", sessionId: s.id, id: message.id });
      return;
    }
    if (message.type === "input") {
      await this.acceptInput(message);
      return;
    }
    if (message.type === "clipboard") {
      if (!validClipboard(message) || !s.screens.includes(message.screenId) || message.sequence <= s.sequence || this.pendingInputs.size >= 256 ||
        s.clipboardAt != null && this.clock().mono - s.clipboardAt < 250) return;
      s.clipboardAt = this.clock().mono;
      // Synchronous main-process adapter rechecks the lease immediately before
      // writing. Native acknowledgement fences paste after the clipboard write.
      try {
        this.clipboard(message);
        await this.acceptInput({ type: "input", sessionId: s.id, screenId: message.screenId,
          sequence: message.sequence, input: { kind: message.paste ? "paste" : "release" } }, ack => {
            this.send({ type: "clipboard-result", sessionId: s.id, requestId: message.requestId, ok: true });
          });
      } catch {
        this.send({ type: "clipboard-result", sessionId: s.id, requestId: message.requestId, ok: false });
      }
      return;
    }
    if (message.type === "command") {
      s.activity = this.clock().mono;
      try {
        await this.command(message, (event) => {
          if (!this.authorized(s.id)) return;
          if (event.type === "output") {
            for (let offset = 0; offset < event.text.length; offset += 12000)
              this.send({
                type: "command-event",
                sessionId: s.id,
                requestId: message.requestId,
                event: {
                  type: "output",
                  text: event.text.slice(offset, offset + 12000),
                },
              });
          } else if (event.type === "exit")
            this.send({
              type: "command-event",
              sessionId: s.id,
              requestId: message.requestId,
              event,
            });
        });
      } catch {
        this.send({
          type: "command-event",
          sessionId: s.id,
          requestId: message.requestId,
          event: { type: "exit", code: null, reason: "command_rejected" },
        });
      }
      return;
    }
    if (message.type === "command-stop") this.stopCommand();
  }
  async acceptInput(message, reply = null) {
      const s = this.session;
      if (!s || message?.type !== "input" || message.sessionId !== s.id || !this.authorized(s.id) ||
        !validInput(message.input) ||
        !s.screens.includes(message.screenId) ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= s.sequence
      )
        return false;
      if (this.pendingInputs.size >= 256) { this.stopSession("native_unavailable"); return false; }
      s.sequence = message.sequence;
      this.pendingInputs.set(message.sequence, {
        session: s,
        time: this.clock().mono,
        screenId: message.screenId,
        reply,
      });
      for (const [seq, pending] of this.pendingInputs)
        if (this.clock().mono - pending.time > 5000)
          this.pendingInputs.delete(seq);
      try { await this.input({ ...message, type: "input" }); }
      catch { this.stopSession("native_unavailable"); return false; }
      return true;
  }
  acknowledge(sequence) {
    const pending = this.pendingInputs.get(sequence);
    this.pendingInputs.delete(sequence);
    if (
      pending?.session === this.session &&
      this.authorized(this.session?.id)
    ) {
      this.session.activity = this.clock().mono;
      const ack = { type: "input-ack", sessionId: this.session.id, sequence };
      if (pending.reply) {
        try { pending.reply(ack); } catch {}
        // Report only acknowledged native activity to the authoritative relay.
        // Avoid a round trip through it for every mouse movement.
        const now = this.clock().mono;
        if (this.lastDirectNotice == null || now - this.lastDirectNotice >= 250) {
          this.lastDirectNotice = now;
          this.send({ type: "direct-input-ack", sessionId: this.session.id, sequence, screenId: pending.screenId });
        }
      } else this.send(ack);
    }
  }
  signal(message) {
    if (
      !this.authorized(message.sessionId) ||
      message.signal?.type !== "offer" ||
      typeof message.signal.sdp !== "string" ||
      message.signal.sdp.length > 60000 ||
      !Array.isArray(message.tracks)
    )
      return;
    this.send({
      type: "signal",
      sessionId: this.session.id,
      signal: message.signal,
      tracks: message.tracks,
    });
  }
  ice(message) {
    if (!this.authorized(message?.sessionId) || !validIceCandidate(message.candidate) || this.session.iceSent >= 128) return;
    this.session.iceSent++;
    this.send({ type: "ice", sessionId: this.session.id, candidate: message.candidate });
  }
  authorized(id) {
    const now = this.clock(),
      s = this.session;
    return Boolean(
      this.accessReady() &&
      this.connected &&
      s &&
      s.id === id &&
      now.wall < s.expiresAt &&
      now.mono < s.deadline &&
      now.mono < s.trustDeadline &&
      now.mono - s.activity < IDLE_MS,
    );
  }
  tick() {
    const now = this.clock();
    if (
      now.wall < this.last.wall ||
      now.mono < this.last.mono ||
      now.mono - this.last.mono > 10000
    )
      this.stopSession("watchdog");
    this.last = now;
    if ((this.connected && now.mono - this.lastRelayMessage > 8000) ||
        (!this.connected && this.ws?.readyState < 2 && !this.attempt?.code && now.mono - this.connectStarted > 10000)) {
      const failedRelay = this.attempt?.relay || this.state?.relay;
      this.disconnect("relay_timeout");
      if (this.state?.certificate)
        this.retry = setTimeout(
          () =>
            void this.connect(this.nextRelay(failedRelay)).catch(() =>
              this.notify("Reconnect failed"),
            ),
          1000,
        );
    }
    if (this.session && !this.authorized(this.session.id))
      this.stopSession("idle_or_lease_expired");
    if (this.session && this.authorized(this.session.id)) {
      try {
        this.heartbeat(this.session.id);
      } catch {
        this.pause("native_unavailable");
      }
    }
    if (!this.lastPing || now.mono - this.lastPing > 2000) {
      this.lastPing = now.mono;
      if (this.connected)
        this.send({ type: "ping", id: String(Math.floor(now.mono)) });
    }
  }
  recoveryFence() { return this.recoveryId + ":" + this.pauseVersion; }
  publish() {
    if (this.connected)
      this.send({
        type: "agent-status",
        screens: this.screens(),
        blocked: !this.accessReady(),
        pauseReason: this.pauseReason,
        elevated: this.elevated(),
        capabilities: this.capabilities,
        recoveryFence: this.recoveryFence(),
      });
  }
  enable(value, reason = "local_takeover") {
    if (!PAUSE_REASONS.includes(reason)) reason = "local_takeover";
    this.enabled = value === true;
    this.pauseReason = this.enabled ? null : reason;
    if (!this.enabled) this.stopSession(reason);
    this.publish();
    this.notify(this.enabled ? "Available" : reason.replaceAll("_", " "));
  }
  accessReady() {
    return this.enabled && !this.pauseReason && this.ready() === true;
  }
  pause(reason = "local_takeover") {
    if (!PAUSE_REASONS.includes(reason)) reason = "native_unavailable";
    // Native takeover has already fenced input. Stop this lease, not the
    // owner's saved permission. Only an explicit new browser Connect starts one.
    this.pauseVersion++;
    if (reason !== "local_takeover") this.pauseReason = reason;
    this.stopSession(reason);
    this.publish();
    this.notify(reason === "local_takeover" ? "Local input ended the session" : reason.replaceAll("_", " "));
  }
  async setAccessEnabled(value) {
    if (typeof value !== "boolean" || !this.state?.certificate)
      throw new Error("PAIR_FIRST");
    const version = ++this.accessVersion;
    const pauseVersion = this.pauseVersion;
    const next = { ...this.state, allowRemote: value };
    // Revocation is immediate; granting waits for protected storage to succeed.
    if (!value) this.enable(false);
    this.state = next;
    try {
      await this.persist();
    } catch {
      if (version === this.accessVersion) {
        this.state = { ...next, allowRemote: false };
        this.enable(false);
        this.notify("Could not save remote access setting");
      }
      throw new Error("ACCESS_SETTING_NOT_SAVED");
    }
    if (version !== this.accessVersion || this.state !== next) return;
    if (value && pauseVersion !== this.pauseVersion && this.pauseReason) {
      this.enabled = true;
      this.publish();
      this.notify("PC access paused");
      return;
    }
    this.enable(value);
  }
  stopSession(reason = "disconnected", notify = true) {
    const s = this.session;
    this.session = null;
    this.scheduleWatch();
    this.pendingInputs.clear();
    this.release();
    this.stopCommand();
    void this.capture({ type: "stop", sessionId: s?.id }).catch(() => {});
    if (s && notify) this.send({ type: "end", sessionId: s.id, reason });
    this.notify(reason);
  }
  disconnect(reason = "Disconnected") {
    clearTimeout(this.retry);
    this.generation++;
    this.recordConnection(({ Connecting: "connecting", Backpressure: "backpressure", "Invalid relay response": "invalid_response", "Connection rejected": "response_rejected", relay_timeout: "relay_timeout", Disconnected: "disconnected" })[reason] || "disconnected");
    this.stopSession(reason);
    this.connected = false;
    this.ws?.close();
    this.ws = null;
    this.notify(reason);
  }
  async unpair() {
    this.accessVersion++;
    this.enabled = false;
    this.disconnect();
    this.state = null;
    await this.persist();
    this.notify("Unpaired");
  }
  close() {
    this.accessVersion++;
    this.closed = true;
    clearInterval(this.watch);
    this.enabled = false;
    this.disconnect();
  }
}
