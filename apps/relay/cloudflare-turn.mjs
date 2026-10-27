const STUN = { urls: "stun:stun.cloudflare.com:3478" };

// The long-lived Cloudflare key stays here on the server. Only temporary ICE
// credentials are sent to an authenticated owner and the paired capture agent.
export function cloudflareTurn({ keyId, apiToken, fetcher = fetch } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(keyId || "") || typeof apiToken !== "string" || !apiToken.trim())
    throw new Error("CLOUDFLARE_TURN_CONFIG_REQUIRED");
  return async () => {
    try {
      const response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.iceServers) || data.iceServers.length > 16) throw new Error();
      const servers = data.iceServers.flatMap(server => {
        if (typeof server?.username !== "string" || !server.username || server.username.length > 2048 ||
          typeof server.credential !== "string" || !server.credential || server.credential.length > 2048) return [];
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url =>
          typeof url === "string" && /^turns?:turn\.cloudflare\.com:(?:3478|443|80|5349)\?transport=(?:tcp|udp)$/.test(url));
        return urls.length ? [{ urls, username: server.username, credential: server.credential }] : [];
      });
      if (!servers.some(server => server.urls.includes("turns:turn.cloudflare.com:443?transport=tcp"))) throw new Error();
      return [STUN, ...servers];
    } catch {
      // Never reflect upstream bodies, errors, tokens or credentials to clients.
      throw new Error("VIDEO_RELAY_UNAVAILABLE");
    }
  };
}

export function iceProvider(env = process.env, fetcher = fetch) {
  const staticServers = env.TURN_URLS ? [STUN, {
    urls: env.TURN_URLS.split(",").map(url => url.trim()).filter(Boolean),
    username: env.TURN_USERNAME,
    credential: env.TURN_CREDENTIAL,
  }] : [STUN];
  const configured = Boolean(env.CLOUDFLARE_TURN_KEY_ID || env.CLOUDFLARE_TURN_API_TOKEN);
  const generate = configured ? cloudflareTurn({ keyId: env.CLOUDFLARE_TURN_KEY_ID, apiToken: env.CLOUDFLARE_TURN_API_TOKEN, fetcher }) : null;
  return mode => mode === "compatibility" && generate ? generate() : staticServers;
}
