import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  requireAuthConfiguration,
  OWNER,
  PROJECT,
  providerOwner,
  signToken,
  readToken,
  fingerprint,
  validProof,
  DAY,
} from "./auth.mjs";
import { validInput, validClipboard, validIceCandidate, IDLE_MS, LEASE_MS, PAUSE_REASONS, relayAddress } from "./protocol.mjs";
import { videoTransport } from "./ice.mjs";
import { iceProvider } from "./cloudflare-turn.mjs";

// One dyno only: connection/session state is intentionally ephemeral. Device
// certificates survive restarts; changing the signing key revokes ALL devices.
export function createRelay({
  secret = process.env.REMOTE_RELAY_SECRET,
  platformSecret = process.env.REMOTE_PLATFORM_SECRET || secret,
  browserOrigins = (process.env.RELAY_BROWSER_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean),
  publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY,
  authenticate = (token) => providerOwner(token, publishableKey),
  clock = Date.now,
  iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }],
  resolveIceServers = () => iceServers,
  requireHttps = Boolean(process.env.DYNO) || process.env.RELAY_REQUIRE_HTTPS === "true",
  allowLoopbackHttp = process.env.RELAY_ALLOW_LOOPBACK_HTTP === "true",
  publicOrigin = process.env.PUBLIC_RELAY_ORIGIN,
} = {}) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("REMOTE_RELAY_SECRET_REQUIRED");
  if (typeof platformSecret !== "string" || platformSecret.length < 32)
    throw new Error("REMOTE_PLATFORM_SECRET_REQUIRED");
  const canonicalOrigin = publicOrigin ? relayAddress(publicOrigin) : null;
  if (requireHttps && !canonicalOrigin?.startsWith("https://"))
    throw new Error("PUBLIC_RELAY_ORIGIN_REQUIRED");
  // Enable only behind a proxy that overwrites this header (Heroku/Cloudflare).
  // It is never an authentication or identity claim. The optional local-agent
  // exception excludes forwarded requests and requires a literal loopback host.
  const secureRequest = (req) => !requireHttps || req.headers["x-forwarded-proto"] === "https" || (
    allowLoopbackHttp &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || "") &&
    ["x-forwarded-proto", "x-forwarded-for", "forwarded", "cf-connecting-ip"].every(header => req.headers[header] === undefined)
  );
  const clients = new Set(),
    agents = new Map(),
    pending = new Map(),
    usedTickets = new Map();
  const allowed = new Set(browserOrigins);
  const send = (ws, value) => {
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > 1048576) {
      ws.close(1008, "BACKPRESSURE");
      return false;
    }
    ws.send(JSON.stringify(value));
    return true;
  };
  function end(session, reason = "disconnected") {
    if (!session || session.ended) return;
    session.ended = true;
    if (session.agent.session === session) session.agent.session = null;
    if (session.browser.session === session) session.browser.session = null;
    for (const ws of [session.agent, session.browser])
      send(ws, { type: "ended", sessionId: session.id, reason });
  }
  function list(ws) {
    send(ws, {
      type: "devices",
      devices: [...agents.values()]
        .filter((a) => a.ownerId === ws.ownerId && a.readyState === 1)
        .map((a) => ({
          id: a.deviceId,
          name: a.name,
          fingerprint: a.deviceId,
          screens: a.screens,
          available: !a.blocked && !a.session,
          paused: a.blocked,
          pauseReason: a.blocked ? a.pauseReason : null,
          inUse: Boolean(a.session),
          elevated: a.elevated,
          capabilities: a.capabilities || {},
          recoveryFence: a.recoveryFence || null,
        })),
    });
  }
  function broadcast() {
    for (const ws of clients) if (ws.role === "browser") list(ws);
  }
  function alive(ws) {
    if (!ws.role) throw new Error("AUTH_REQUIRED");
    if (clock() >= ws.expiresAt) throw new Error("AUTH_EXPIRED");
  }
  function sessionFor(ws, message) {
    alive(ws);
    const s = ws.session;
    if (
      !s ||
      s.ended ||
      s.id !== message.sessionId ||
      clock() >= s.expiresAt ||
      clock() >= s.trustExpiresAt ||
      clock() - s.activity >= IDLE_MS
    ) {
      end(s, "lease_expired");
      throw new Error("NO_SESSION");
    }
    return s;
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const common = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      ...(requireHttps ? { "Strict-Transport-Security": "max-age=86400" } : {}),
    };
    if (!secureRequest(req)) {
      res.writeHead(308, { ...common, Location: canonicalOrigin + url.pathname + url.search });
      res.end();
      return;
    }
    const json = (value) => {
      res.writeHead(200, { ...common, "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "GET") {
      res.writeHead(405, common);
      res.end();
      return;
    }
    if (url.pathname === "/healthz")
      return json({
        service: "long-cable-pc-relay",
        transport: "websocket-control-webrtc-video",
        configured: Boolean(publishableKey && PROJECT && OWNER),
        release: (process.env.SOURCE_VERSION || process.env.HEROKU_SLUG_COMMIT)?.slice(0, 12) || "local",
      });
    if (url.pathname === "/ping")
      return json({
        nonce: (url.searchParams.get("nonce") || "").slice(0, 64),
      });
    if (url.pathname === "/config")
      return json({
        project: PROJECT,
        publishableKey: publishableKey || null,
        owner: OWNER,
      });
    const files = {
      "/": ["console.html", "text/html"],
      "/demo": ["demo.html", "text/html"],
      "/demo.mjs": ["demo.mjs", "text/javascript"],
      "/demo.css": ["demo.css", "text/css"],
      "/console": ["console.html", "text/html"],
      "/console.mjs": ["console.mjs", "text/javascript"],
      "/screen-windows.mjs": ["screen-windows.mjs", "text/javascript"],
      "/monitor-tabs.mjs": ["monitor-tabs.mjs", "text/javascript"],
      "/pc-audio.mjs": ["pc-audio.mjs", "text/javascript"],
      "/protocol.mjs": ["../protocol.mjs", "text/javascript"],
      "/console.css": ["console.css", "text/css"],
      "/benchmark": ["benchmark.html", "text/html"],
      "/benchmark.mjs": ["benchmark.mjs", "text/javascript"],
    };
    const file = files[url.pathname];
    if (!file) {
      res.writeHead(404, common);
      res.end();
      return;
    }
    try {
      const content = await readFile(
        new URL("./public/" + file[0], import.meta.url),
      );
      res.writeHead(200, {
        ...common,
        "Content-Type": file[1],
        "Content-Security-Policy":
          `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${PROJECT && new URL(PROJECT).protocol === "https:" && new URL(PROJECT).origin === PROJECT ? PROJECT : ""}; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`,
      });
      res.end(content);
    } catch {
      res.writeHead(503, common);
      res.end();
    }
  });
  const transports = new Set();
  server.on("connection", socket => {
    transports.add(socket);
    socket.once("close", () => transports.delete(socket));
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    const same =
      origin === "https://" + req.headers.host ||
      (origin === "http://" + req.headers.host &&
        /^127\.0\.0\.1:|^localhost:/.test(req.headers.host || ""));
    if (
      req.url !== "/connect" ||
      !secureRequest(req) ||
      (origin && !allowed.has(origin) && !same) ||
      clients.size >= 16
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws, req) => {
    clients.add(ws);
    Object.assign(ws, {
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: clock() + 10000,
      role: null,
      session: null,
      count: 0,
      bucket: clock(),
      authBusy: false,
      origin: req.headers.origin || null,
    });
    send(ws, { type: "challenge", nonce: ws.nonce });
    async function owner(message) {
      if (message.ticket) {
        // The platform and Windows PC have independent clocks. Allow a small
        // issuance skew, while keeping ticket expiry and MFA deadlines strict.
        const ticket = readToken(platformSecret, "browser", message.ticket, clock(), 5000);
        if (
          ticket.email !== OWNER ||
          typeof ticket.ownerId !== "string" ||
          typeof ticket.sessionId !== "string" ||
          typeof ticket.nonce !== "string" ||
          ticket.nonce.length > 64 ||
          usedTickets.has(ticket.nonce) ||
          ticket.origin !== ws.origin ||
          ticket.expiresAt - ticket.issuedAt > 60000 ||
          ticket.trustExpiresAt <= clock() ||
          ticket.expiresAt > ticket.trustExpiresAt
        )
          throw new Error("AUTH_REQUIRED");
        usedTickets.set(ticket.nonce, ticket.expiresAt);
        return ticket;
      }
      const auth = await authenticate(message.accessToken);
      return {
        ...auth,
        expiresAt: Math.min(auth.expiresAt, clock() + LEASE_MS),
      };
    }
    async function receive(m) {
      if (
        !m ||
        typeof m !== "object" ||
        Array.isArray(m) ||
        typeof m.type !== "string"
      )
        throw new Error("INVALID_MESSAGE");
      if (clock() - ws.bucket >= 1000) {
        ws.bucket = clock();
        ws.count = 0;
      }
      if (++ws.count > 300) throw new Error("RATE_LIMITED");
      if (m.type === "auth" || m.type === "reauth") {
        ws.authAttempts = (ws.authAttempts || []).filter(
          (time) => clock() - time < 60000,
        );
        if (ws.authAttempts.length >= 8) throw new Error("RATE_LIMITED");
        ws.authAttempts.push(clock());
        if (
          (m.type === "reauth" && ws.role !== "browser") ||
          (m.type === "auth" && ws.role)
        )
          throw new Error("INVALID_AUTH_STATE");
        if (ws.authBusy) throw new Error("AUTH_BUSY");
        ws.authBusy = true;
        try {
          const result = await owner(m);
          if (ws.readyState !== 1) return;
          if (
            ws.role &&
            (ws.ownerId !== result.ownerId ||
              ws.sessionId !== result.sessionId ||
              ws.trustExpiresAt !== result.trustExpiresAt)
          )
            throw new Error("ACCOUNT_CHANGED");
          Object.assign(ws, {
            role: "browser",
            ownerId: result.ownerId,
            sessionId: result.sessionId,
            trustExpiresAt: result.trustExpiresAt,
            expiresAt: result.expiresAt,
          });
          if (ws.session)
            ws.session.expiresAt = Math.min(
              clock() + LEASE_MS,
              ws.expiresAt,
              ws.trustExpiresAt,
            );
          if (ws.session)
            send(ws.session.agent, {
              type: "renew",
              sessionId: ws.session.id,
              expiresAt: ws.session.expiresAt,
            });
          send(ws, { type: "ready", expiresAt: ws.expiresAt, iceServers });
          list(ws);
        } finally {
          ws.authBusy = false;
        }
        return;
      }
      if (m.type === "agent-auth") {
        if (ws.role) throw new Error("ALREADY_AUTHENTICATED");
        const certificate = readToken(secret, "agent", m.certificate, clock());
        if (
          certificate.deviceId !== fingerprint(certificate.publicKey) ||
          !validProof(
            certificate.publicKey,
            ws.nonce,
            m.certificate,
            m.signature,
          )
        )
          throw new Error("INVALID_PROOF");
        ws.nonce = null;
        const old = agents.get(certificate.deviceId);
        if (old) {
          end(old.session, "agent_replaced");
          old.close(1000, "REPLACED");
        }
        Object.assign(ws, {
          role: "agent",
          ownerId: certificate.ownerId,
          deviceId: certificate.deviceId,
          name: certificate.name,
          expiresAt: certificate.expiresAt,
          screens: [],
          blocked: true,
          pauseReason: null,
          elevated: false,
        });
        agents.set(ws.deviceId, ws);
        send(ws, { type: "agent-ready", deviceId: ws.deviceId, iceServers });
        broadcast();
        return;
      }
      if (m.type === "pair-join") {
        if (
          ws.role ||
          typeof m.code !== "string" ||
          typeof m.publicKey !== "string" ||
          m.publicKey.length > 512
        )
          throw new Error("INVALID_PAIRING");
        const p = pending.get(m.code);
        if (
          !p ||
          p.agent ||
          clock() >= p.expiresAt ||
          p.browser.readyState !== 1 ||
          !validProof(m.publicKey, ws.nonce, m.code, m.signature)
        )
          throw new Error("PAIRING_EXPIRED");
        alive(p.browser);
        p.agent = ws;
        p.publicKey = m.publicKey;
        p.deviceId = fingerprint(m.publicKey);
        p.name =
          typeof m.name === "string"
            ? m.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64)
            : "Windows PC";
        ws.expiresAt = p.expiresAt;
        ws.pairing = m.code;
        send(p.browser, {
          type: "pair-review",
          code: m.code,
          fingerprint: p.deviceId,
          name: p.name,
        });
        send(ws, { type: "pair-waiting", fingerprint: p.deviceId });
        return;
      }
      alive(ws);
      if (m.type === "ping") {
        if (typeof m.id === "string" && m.id.length <= 64)
          send(ws, { type: "pong", id: m.id });
        return;
      }
      if (ws.role === "browser") {
        if (m.type === "list") return list(ws);
        if (m.type === "refresh-sources") {
          const agent = agents.get(m.deviceId);
          if (!agent || agent.ownerId !== ws.ownerId) throw Error("PC_UNAVAILABLE");
          if (ws.sourcesAt != null && clock() - ws.sourcesAt < 2000) return;
          ws.sourcesAt = clock();
          send(agent, { type: "refresh-sources" });
          return;
        }
        if (m.type === "pair-start") {
          for (const [code, p] of pending)
            if (p.browser === ws) {
              p.agent?.close(1000, "PAIRING_REPLACED");
              pending.delete(code);
            }
          if (pending.size >= 8) throw new Error("PAIRING_BUSY");
          const code = randomBytes(12).toString("hex");
          pending.set(code, {
            browser: ws,
            ownerId: ws.ownerId,
            expiresAt: clock() + 180000,
          });
          send(ws, { type: "pair-code", code, expiresAt: clock() + 180000 });
          return;
        }
        if (m.type === "pair-approve") {
          const p = pending.get(m.code);
          if (
            !p ||
            p.browser !== ws ||
            !p.agent ||
            p.agent.readyState !== 1 ||
            clock() >= p.expiresAt ||
            m.fingerprint !== p.deviceId
          )
            throw new Error("INVALID_PAIRING");
          const certificate = signToken(secret, "agent", {
            ownerId: ws.ownerId,
            deviceId: p.deviceId,
            publicKey: p.publicKey,
            name: p.name,
            issuedAt: clock(),
            expiresAt: clock() + 30 * DAY,
          });
          send(p.agent, { type: "paired", certificate });
          pending.delete(m.code);
          send(ws, { type: "pair-complete", deviceId: p.deviceId });
          return;
        }
        if (m.type === "start") {
          // Validate before allocating a lease or interrupting the paired PC.
          if (![undefined, "auto", "compatibility"].includes(m.transport)) throw new Error("INVALID_VIDEO_TRANSPORT");
          if (m.audio !== undefined && typeof m.audio !== "boolean") throw Error("INVALID_AUDIO_OPTION");
          const agent = agents.get(m.deviceId);
          if (
            !agent ||
            agent.ownerId !== ws.ownerId ||
            agent.blocked ||
            agent.expiresAt <= clock()
          )
            throw new Error("PC_UNAVAILABLE");
          if (agent.session || ws.session)
            throw new Error("ALREADY_CONTROLLED");
          const ids = agent.screens.map((s) => s.id);
          if (
            !Array.isArray(m.screenIds) ||
            !m.screenIds.length ||
            m.screenIds.length > 4 ||
            new Set(m.screenIds).size !== m.screenIds.length ||
            m.screenIds.some((id) => !ids.includes(id))
          )
            throw new Error("INVALID_SCREENS");
          const screenIds = [...m.screenIds];
          ws.startAttempts = (ws.startAttempts || []).filter(time => clock() - time < 60000);
          if (ws.startAttempts.length >= 6) throw new Error("RATE_LIMITED");
          ws.startAttempts.push(clock());
          const transport = videoTransport(await resolveIceServers(m.transport || "auto"), m.transport);
          // Credential generation is asynchronous. Disconnect, local takeover,
          // agent replacement, another controller or expired trust must win.
          alive(ws);
          if (ws.readyState !== 1 || ws.trustExpiresAt <= clock()) throw new Error("AUTH_EXPIRED");
          if (agents.get(m.deviceId) !== agent || agent.readyState !== 1 || agent.blocked || agent.expiresAt <= clock())
            throw new Error("PC_UNAVAILABLE");
          if (agent.session || ws.session) throw new Error("ALREADY_CONTROLLED");
          if (m.recoveryFence !== undefined && (!agent.recoveryFence || m.recoveryFence !== agent.recoveryFence)) throw new Error("LOCAL_TAKEOVER");
          if (screenIds.some(id => !agent.screens.some(screen => screen.id === id))) throw new Error("INVALID_SCREENS");
          const s = {
            id: randomUUID(),
            agent,
            browser: ws,
            screens: screenIds,
            focus: screenIds[0],
            fps: m.fps === 30 ? 30 : 60,
            height: m.height === 720 ? 720 : 1080,
            audio: m.audio === true,
            iceCounts: { browser: 0, agent: 0 },
            expiresAt: Math.min(
              clock() + LEASE_MS,
              ws.expiresAt,
              ws.trustExpiresAt,
            ),
            trustExpiresAt: ws.trustExpiresAt,
            activity: clock(),
            sequence: -1,
            probes: new Set(),
            inputPending: new Map(),
          };
          ws.session = agent.session = s;
          const value = {
            type: "started",
            sessionId: s.id,
            screenIds: s.screens,
            focus: s.focus,
            fps: s.fps,
            height: s.height,
            audio: s.audio,
            expiresAt: s.expiresAt,
            trustExpiresAt: s.trustExpiresAt,
            recoveryFence: m.recoveryFence,
            ...transport,
          };
          send(agent, value);
          send(ws, value);
          broadcast();
          return;
        }
        const s = sessionFor(ws, m);
        if (m.type === "clipboard") {
          if (!s.agent.capabilities?.clipboard) throw Error("CLIPBOARD_UNAVAILABLE");
          if (!validClipboard(m) || !s.screens.includes(m.screenId) || m.sequence <= s.sequence) throw Error("INVALID_CLIPBOARD");
          if (s.clipboardAt != null && clock() - s.clipboardAt < 250) {
            send(ws, { type: "clipboard-result", sessionId: s.id, requestId: m.requestId, ok: false });
            return;
          }
          s.clipboardAt = clock(); s.sequence = m.sequence;
          s.clipboardRequest = m.requestId;
          send(s.agent, { type: "clipboard", sessionId: s.id, screenId: m.screenId, sequence: m.sequence,
            requestId: m.requestId, text: m.text, paste: m.paste });
          return;
        }
        if (m.type === "ice") {
          if (!validIceCandidate(m.candidate) || ++s.iceCounts.browser > 128) throw Error("INVALID_ICE");
          send(s.agent, { type: "ice", sessionId: s.id, candidate: m.candidate });
          return;
        }
        if (m.type === "stop") {
          end(s, "browser_stopped");
          broadcast();
          return;
        }
        if (m.type === "visibility") {
          if (!Array.isArray(m.screenIds) || new Set(m.screenIds).size !== m.screenIds.length || m.screenIds.some(id => !s.screens.includes(id))) throw Error("INVALID_SCREENS");
          send(s.agent, { type: "visibility", sessionId: s.id, screenIds: m.screenIds });
          return;
        }
        if (m.type === "focus") {
          if (!s.screens.includes(m.screenId))
            throw new Error("INVALID_SCREEN");
          s.focus = m.screenId;
          s.activity = clock();
          send(s.agent, { type: "focus", sessionId: s.id, screenId: s.focus });
          return;
        }
        if (m.type === "input") {
          if (
            !Number.isSafeInteger(m.sequence) ||
            m.sequence <= s.sequence ||
            !s.screens.includes(m.screenId) ||
            !validInput(m.input)
          )
            throw new Error("INVALID_INPUT");
          s.sequence = m.sequence;
          s.inputPending.set(m.sequence, clock());
          for (const [seq, time] of s.inputPending)
            if (clock() - time > 5000) s.inputPending.delete(seq);
          send(s.agent, {
            type: "input",
            sessionId: s.id,
            sequence: m.sequence,
            screenId: m.screenId,
            input: m.input,
          });
          return;
        }
        if (m.type === "probe") {
          if (
            typeof m.id !== "string" ||
            m.id.length > 64 ||
            s.probes.size > 10
          )
            throw new Error("INVALID_PROBE");
          s.probes.add(m.id);
          send(s.agent, { type: "probe", sessionId: s.id, id: m.id });
          return;
        }
        if (m.type === "command") {
          if (
            typeof m.requestId !== "string" ||
            m.requestId.length > 64 ||
            !["cmd", "powershell"].includes(m.shell) ||
            typeof m.command !== "string" ||
            !m.command.trim() ||
            m.command.length > 4096 ||
            m.command.includes("\0") ||
            m.admin !== s.agent.elevated
          )
            throw new Error("INVALID_COMMAND");
          if (s.command) throw new Error("COMMAND_BUSY");
          s.command = m.requestId;
          s.outputBytes = 0;
          s.activity = clock();
          send(s.agent, {
            type: "command",
            sessionId: s.id,
            requestId: m.requestId,
            shell: m.shell,
            command: m.command,
            admin: m.admin,
          });
          return;
        }
        if (m.type === "command-stop") {
          send(s.agent, { type: "command-stop", sessionId: s.id });
          return;
        }
        if (
          m.type === "signal" &&
          m.signal?.type === "answer" &&
          typeof m.signal.sdp === "string" &&
          m.signal.sdp.length <= 60000
        ) {
          send(s.agent, {
            type: "signal",
            sessionId: s.id,
            signal: { type: "answer", sdp: m.signal.sdp },
          });
          return;
        }
        throw new Error("INVALID_MESSAGE");
      }
      if (ws.role === "agent") {
        if (m.type === "agent-status") {
          if (
            !Array.isArray(m.screens) ||
            m.screens.length > 64 ||
            new Set(m.screens.map(s => s?.id)).size !== m.screens.length ||
            m.screens.some(
              (s) =>
                !s || typeof s.id !== "string" || !s.id.length ||
                s.id.length > 80 ||
                typeof s.label !== "string" ||
                s.label.length > 80 ||
                ![undefined, "screen", "window"].includes(s.kind) ||
                ![s.width, s.height].every(
                  (n) => Number.isInteger(n) && n > 0 && n <= 16384,
                ),
            )
          )
            throw new Error("INVALID_SCREENS");
          ws.screens = m.screens.map((s) => ({
            id: s.id,
            label: s.label,
            width: s.width,
            height: s.height,
            kind: s.kind === "window" ? "window" : "screen",
          }));
          ws.blocked = m.blocked !== false;
          ws.recoveryFence = typeof m.recoveryFence === "string" && /^[a-f0-9-]{36}:\d{1,12}$/.test(m.recoveryFence) ? m.recoveryFence : null;
          ws.pauseReason = ws.blocked && PAUSE_REASONS.includes(m.pauseReason ?? ws.pauseReason) ? (m.pauseReason ?? ws.pauseReason) : null;
          ws.elevated = m.elevated === true;
          ws.capabilities = { clipboard: m.capabilities?.clipboard === true, windows: m.capabilities?.windows === true };
          if (ws.blocked) end(ws.session, ws.pauseReason || "local_takeover");
          broadcast();
          return;
        }
        const s = sessionFor(ws, m);
        if (m.type === "clipboard-result") {
          if (m.requestId === s.clipboardRequest && typeof m.ok === "boolean") {
            s.clipboardRequest = null;
            if (m.ok) s.activity = clock();
            send(s.browser, { type: "clipboard-result", sessionId: s.id, requestId: m.requestId, ok: m.ok });
          }
          return;
        }
        if (m.type === "end") {
          if (PAUSE_REASONS.includes(m.reason)) ws.pauseReason = m.reason;
          end(
            s,
            [
              ...PAUSE_REASONS,
              "idle_timeout",
              "capture_failed",
              "native_unavailable",
            ].includes(m.reason)
              ? m.reason
              : "agent_disconnected",
          );
          broadcast();
          return;
        }
        if (m.type === "ice") {
          if (!validIceCandidate(m.candidate) || ++s.iceCounts.agent > 128) throw Error("INVALID_ICE");
          send(s.browser, { type: "ice", sessionId: s.id, candidate: m.candidate });
          return;
        }
        if (
          m.type === "signal" &&
          m.signal?.type === "offer" &&
          typeof m.signal.sdp === "string" &&
          m.signal.sdp.length <= 60000 &&
          Array.isArray(m.tracks) &&
          m.tracks.length <= 4 &&
          m.tracks.every(
            (t) => s.screens.includes(t.screenId) && typeof t.mid === "string",
          )
        ) {
          send(s.browser, {
            type: "signal",
            sessionId: s.id,
            signal: { type: "offer", sdp: m.signal.sdp },
            tracks: m.tracks,
          });
          return;
        }
        if (m.type === "probe-ack" && s.probes.delete(m.id)) {
          send(s.browser, { type: "probe-ack", sessionId: s.id, id: m.id });
          return;
        }
        if (m.type === "direct-input-ack") {
          if (!Number.isSafeInteger(m.sequence) || m.sequence <= s.sequence || !s.screens.includes(m.screenId)) return;
          s.sequence = m.sequence;
          s.activity = clock();
          return;
        }
        if (m.type === "input-ack" && s.inputPending.delete(m.sequence)) {
          s.activity = clock();
          send(s.browser, {
            type: "input-ack",
            sessionId: s.id,
            sequence: m.sequence,
          });
          return;
        }
        if (m.type === "command-event" && s.command === m.requestId) {
          const event = m.event;
          if (
            event?.type === "output" &&
            typeof event.text === "string" &&
            event.text.length <= 16384
          ) {
            s.outputBytes += Buffer.byteLength(event.text);
            if (s.outputBytes > 1048576) throw new Error("OUTPUT_LIMIT");
            send(s.browser, {
              type: "command-event",
              sessionId: s.id,
              requestId: s.command,
              event: { type: "output", text: event.text },
            });
            return;
          }
          if (event?.type === "exit") {
            send(s.browser, {
              type: "command-event",
              sessionId: s.id,
              requestId: s.command,
              event: {
                type: "exit",
                code: Number.isInteger(event.code) ? event.code : null,
                reason: String(event.reason || "completed").slice(0, 64),
              },
            });
            s.command = null;
            return;
          }
        }
        throw new Error("INVALID_MESSAGE");
      }
      throw new Error("AUTH_REQUIRED");
    }
    let queue = Promise.resolve(),
      queued = 0;
    ws.on("message", (data, binary) => {
      if (binary || ++queued > 128) {
        ws.close(1008, "INVALID_MESSAGE");
        return;
      }
      queue = queue
        .then(async () => {
          if (ws.readyState !== 1) return;
          await receive(JSON.parse(data.toString()));
        })
        .catch((error) => {
          // Never log bodies, SDP, credentials, commands, output, IPs or tokens.
          const code = /^[A-Z_]{2,64}$/.test(error.message)
            ? error.message
            : "INVALID_MESSAGE";
          send(ws, { type: "error", error: code });
          if (
            [
              "AUTH_REQUIRED",
              "OWNER_MFA_REQUIRED",
              "AUTH_EXPIRED",
              "INVALID_TOKEN",
              "TOKEN_EXPIRED",
              "ACCOUNT_CHANGED",
              "RATE_LIMITED",
            ].includes(code) ||
            !ws.role
          )
            ws.close(1008, code);
        })
        .finally(() => queued--);
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      clients.delete(ws);
      end(ws.session, "connection_lost");
      if (agents.get(ws.deviceId) === ws) agents.delete(ws.deviceId);
      for (const [code, p] of pending)
        if (p.browser === ws || p.agent === ws) {
          pending.delete(code);
          if (p.agent !== ws) p.agent?.close(1000, "PAIRING_CANCELED");
        }
      broadcast();
    });
  });
  const timer = setInterval(() => {
    for (const ws of clients) {
      if (clock() >= ws.expiresAt) {
        end(ws.session, "auth_expired");
        ws.close(1008, "AUTH_EXPIRED");
      }
      const s = ws.session;
      if (
        s &&
        (clock() >= s.expiresAt ||
          clock() >= s.trustExpiresAt ||
          clock() - s.activity >= IDLE_MS)
      ) {
        end(
          s,
          clock() - s.activity >= IDLE_MS ? "idle_timeout" : "lease_expired",
        );
        broadcast();
      }
      if (ws.readyState === 1) ws.ping();
    }
    for (const [code, p] of pending)
      if (clock() >= p.expiresAt) {
        pending.delete(code);
        p.agent?.close(1000, "PAIRING_EXPIRED");
      }
    for (const [nonce, expiry] of usedTickets)
      if (clock() >= expiry) usedTickets.delete(nonce);
  }, 1000);
  timer.unref();
  return {
    server,
    close: async () => {
      clearInterval(timer);
      // Stop accepting before tearing down upgrades. Idle/incomplete HTTP
      // transports are not WebSocket clients and can otherwise hold shutdown
      // open until Node's request timeout, including during a relay restart.
      const stopped = new Promise(resolve => server.close(resolve));
      for (const ws of clients) ws.terminate();
      for (const transport of transports) transport.destroy();
      await Promise.all([new Promise(resolve => wss.close(resolve)), stopped]);
    },
    agents,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  requireAuthConfiguration();
  const relay = createRelay({ resolveIceServers: iceProvider() });
  relay.server.listen(
    Number(process.env.PORT || 8790),
    process.env.HOST || (process.env.DYNO ? "0.0.0.0" : "127.0.0.1"),
    () => console.log("Long Cable relay listening; no payload logging."),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => relay.close().finally(() => process.exit()));
}
