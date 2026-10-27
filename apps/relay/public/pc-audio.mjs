// One playback destination per workspace, even with several monitor tabs.
// System sound arrives on the same authenticated peer; this never opens a mic.
export function pcAudio(root, controls) {
  const button = root.querySelector("#audio-resume") || controls?.querySelector("#audio-resume");
  // Chromium can leave remote WebRTC audio silent in Web Audio unless the
  // stream is also attached to a playing media element (crbug.com/933677).
  // This driver is muted; only the Web Audio destination produces sound.
  const driver = document.createElement("audio");
  driver.hidden = true; driver.muted = true; driver.autoplay = true;
  root.append(driver);
  let context, source;
  const update = () => { if (button) button.hidden = !source || context?.state === "running" && !driver.paused; };
  function unlock() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!context) { context = new Audio({ latencyHint: "interactive" }); context.onstatechange = update; }
    void context.resume().catch(update);
    if (driver.srcObject) void driver.play().then(update, update);
  }
  return {
    unlock,
    accept(track) {
      unlock(); source?.disconnect();
      const stream = new MediaStream([track]); driver.srcObject = stream;
      void driver.play().then(update, update);
      if (context) { source = context.createMediaStreamSource(stream); source.connect(context.destination); }
      update();
    },
    clear() { source?.disconnect(); source = null; driver.pause(); driver.srcObject = null; update(); },
    state: () => source ? driver.paused ? "playback blocked" : context?.state || "unavailable" : "off",
    dispose() { source?.disconnect(); source = null; driver.pause(); driver.srcObject = null; driver.remove(); if (context) { context.onstatechange = null; void context.close().catch(() => {}); } },
  };
}
