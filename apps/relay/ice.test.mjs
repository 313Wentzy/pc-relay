import test from "node:test";
import assert from "node:assert/strict";
import { videoTransport } from "./ice.mjs";

test("automatic mode preserves existing phone/direct and TURN routes", () => {
  const servers = [{ urls: "stun:stun.example:3478" }];
  assert.deepEqual(videoTransport(servers), { iceServers: servers, iceTransportPolicy: "all", transport: "auto" });
});
test("compatibility forces relay and excludes every UDP or unauthenticated route", () => {
  const servers = [
    { urls: "stun:stun.example:3478" },
    { urls: "turns:no-auth.example:443" },
    { urls: ["turn:turn.example:3478?transport=udp", "turn:turn.example:3478", "turn:turn.example:3478?transport=tcp", "turns:turn.example:443?transport=tcp", "turns:turn.example:443", "turns:turn.example:443?transport=udp"], username: "fixture", credential: "fixture" },
  ];
  const config = videoTransport(servers, "compatibility");
  assert.equal(config.iceTransportPolicy, "relay");
  assert.deepEqual(config.iceServers[0].urls, ["turn:turn.example:3478?transport=tcp", "turns:turn.example:443?transport=tcp", "turns:turn.example:443"]);
  assert.equal(config.iceServers.length, 1);
  assert.equal(servers[2].urls.length, 6);
});
test("missing TCP/TLS TURN fails explicitly, without falling back to a blocked direct path", () => {
  for (const servers of [[], [{ urls: "stun:stun.example:3478" }], [{ urls: "turn:turn.example:3478?transport=udp", username: "fixture", credential: "fixture" }]])
    assert.throws(() => videoTransport(servers, "compatibility"), /COMPATIBILITY_RELAY_UNAVAILABLE/);
  assert.throws(() => videoTransport([], "vpn"), /INVALID_VIDEO_TRANSPORT/);
});
