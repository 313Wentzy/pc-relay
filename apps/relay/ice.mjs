// Compatibility mode uses an authenticated TURN service over TCP/TLS. STUN
// discovers direct routes; it cannot relay media when managed Chrome blocks UDP.
export function videoTransport(iceServers, mode = "auto") {
  if (!["auto", "compatibility"].includes(mode)) throw new Error("INVALID_VIDEO_TRANSPORT");
  if (mode === "auto") return { iceServers, iceTransportPolicy: "all", transport: mode };
  const servers = iceServers.flatMap(server => {
    if (!server.username || !server.credential) return [];
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url =>
      typeof url === "string" && (/^turns:[^?]+(?:\?transport=tcp)?$/i.test(url) || /^turn:[^?]+\?transport=tcp$/i.test(url)));
    return urls.length ? [{ ...server, urls }] : [];
  });
  if (!servers.length) throw new Error("COMPATIBILITY_RELAY_UNAVAILABLE");
  return { iceServers: servers, iceTransportPolicy: "relay", transport: mode };
}
