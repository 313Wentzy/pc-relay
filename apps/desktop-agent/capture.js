const api = window.longCableAgent;
let state = null;
const hiddenCaptureGraceMs = 3000;
function stop() {
  const old = state;
  state = null;
  if (!old) return;
  old.peer.close();
  for (const item of old.media) {
    clearTimeout(item.hideTimer);
    for (const track of item.stream?.getTracks() ?? []) track.stop();
  }
  for (const track of old.audioTracks) track.stop();
}
function profileFor(current, screenId) {
  const active = current.focus === screenId;
  const visible = !current.visible || current.visible.has(screenId);
  const height = active ? current.height : 540;
  return { active, visible, width: height * 16 / 9, height, fps: visible ? active ? current.fps : 5 : 1 };
}
async function openStream(current, source, audio = false) {
  const profile = profileFor(current, source.screenId);
  if (api.prepareCapture) await api.prepareCapture({ sessionId: current.id, screenId: source.screenId, audio });
  if (state !== current) return null;
  const stream = api.prepareCapture ? await navigator.mediaDevices.getDisplayMedia({
    audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    video: { width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, frameRate: { ideal: profile.fps, max: profile.fps } },
  }) : await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.sourceId,
      maxWidth: profile.width, maxHeight: profile.height, minFrameRate: profile.active && profile.visible ? Math.min(30, profile.fps) : 1, maxFrameRate: profile.fps } },
  });
  if (state !== current) { stream.getTracks().forEach(track => track.stop()); return null; }
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") { stream.getTracks().forEach(track => track.stop()); throw Error("VIDEO_TRACK_UNAVAILABLE"); }
  track.onended = () => { if (state === current) { stop(); api.captureFailed(current.id); } };
  return stream;
}
async function suspend(current, item) {
  item.hideTimer = null;
  if (state !== current || profileFor(current, item.screenId).visible || !item.track) return;
  await item.sender.replaceTrack(null);
  if (state !== current) return;
  item.track.onended = null;
  item.track.stop();
  item.track = null;
  item.stream = null;
  item.profileKey = null;
}
async function applyProfiles(current) {
  for (const item of current.media) {
    if (state !== current) return;
    const { active, visible, width, height, fps } = profileFor(current, item.screenId);
    const key = JSON.stringify([active, visible, width, height, fps]);
    if (visible) { clearTimeout(item.hideTimer); item.hideTimer = null; }
    if (key === item.profileKey || !visible && !item.track) continue;
    if (!item.track) {
      const stream = await openStream(current, item.source);
      if (!stream) return;
      const track = stream.getVideoTracks()[0];
      try { await item.sender.replaceTrack(track); }
      catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
      if (state !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      item.stream = stream; item.track = track;
    }
    item.track.contentHint = active ? "motion" : "detail";
    item.track.enabled = visible;
    await item.track.applyConstraints({ width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { min: visible && active ? Math.min(30, fps) : 1, ideal: fps, max: fps } });
    if (state !== current) return;
    const params = item.sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    Object.assign(params.encodings[0], {
      maxBitrate: active ? (current.height === 720 ? 8000000 : 16000000) : 1200000,
      active: visible,
      maxFramerate: fps,
      scaleResolutionDownBy: 1,
    });
    params.degradationPreference = "maintain-framerate";
    await item.sender.setParameters(params);
    if (state !== current) return;
    item.profileKey = key;
    if (!visible && !item.hideTimer) item.hideTimer = setTimeout(() => {
      enqueue(current, () => suspend(current, item));
    }, hiddenCaptureGraceMs);
  }
}
async function focus(screenId) {
  const current = state;
  if (!current) return;
  current.focus = screenId;
  await applyProfiles(current);
}
async function start(message) {
  stop();
  const peer = new RTCPeerConnection({ iceServers: message.iceServers });
  const current = {
    id: message.sessionId,
    peer,
    media: [],
    audioTracks: [],
    fps: message.fps === 30 ? 30 : 60,
    height: message.height === 720 ? 720 : 1080,
    focus: message.focus,
    candidates: [],
  };
  state = current;
  peer.onicecandidate = event => {
    if (state === current && event.candidate) void api.captureIce?.({ sessionId: current.id, candidate: event.candidate.toJSON() }).catch(() => {});
  };
  const inputChannel = peer.createDataChannel("long-cable-input-v1", { ordered: true });
  current.inputChannel = inputChannel;
  inputChannel.onmessage = event => {
    if (state !== current || typeof event.data !== "string" || event.data.length > 2048) return;
    try {
      const value = JSON.parse(event.data);
      if (value.sessionId !== current.id) return;
      if (value.type === "probe" && typeof value.id === "string" && value.id.length <= 64) {
        if (inputChannel.bufferedAmount < 8192) inputChannel.send(JSON.stringify({ type: "probe-ack", sessionId: current.id, id: value.id }));
      } else if (value.type === "input") void api.directInput?.(value).catch(() => {});
    } catch {}
  };
  let stage = "capture";
  try {
    for (const source of message.sources) {
      if (state !== current) return;
      const audio = message.audio === true && source === message.sources[0];
      const stream = await openStream(current, source, audio);
      if (!stream) return;
      const track = stream.getVideoTracks()[0];
      track.contentHint = source.screenId === message.focus ? "motion" : "detail";
      const sender = peer.addTrack(track, stream);
      current.media.push({ screenId: source.screenId, source, stream, track, sender, profileKey: null, hideTimer: null });
      if (audio) {
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack || audioTrack.readyState !== "live") throw Error("SYSTEM_AUDIO_UNAVAILABLE");
        current.audioTracks.push(audioTrack);
        const audioSender = peer.addTrack(audioTrack, stream);
        const params = audioSender.getParameters();
        if (params.encodings?.length) { params.encodings[0].maxBitrate = 128000; await audioSender.setParameters(params); }
      }
    }
    const transceivers = peer.getTransceivers();
    stage = "codec_preferences";
    const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    // Chromium's supported hardware-friendly H.264 modes first; keep negotiated fallbacks.
    for (const transceiver of transceivers.filter(item => item.sender.track?.kind === "video"))
      transceiver.setCodecPreferences([
        ...codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264"),
        ...codecs.filter((c) => c.mimeType.toLowerCase() !== "video/h264"),
      ]);
    stage = "local_description";
    await peer.setLocalDescription(await peer.createOffer());
    stage = "profile";
    await focus(message.focus);
    if (state !== current) return;
    await api.captureSignal({
      sessionId: current.id,
      signal: { type: "offer", sdp: peer.localDescription.sdp },
      tracks: current.media.map((item) => ({
        screenId: item.screenId,
        mid: peer.getTransceivers().find((t) => t.sender === item.sender).mid,
      })),
    });
  } catch (error) {
    if (state === current) {
      stop();
      api.captureFailed(current.id, { stage, code: error?.name || "Error" });
    }
  }
}
api.onDirectAck?.(message => {
  if (state?.id === message.sessionId && state.inputChannel.readyState === "open" && state.inputChannel.bufferedAmount < 8192)
    state.inputChannel.send(JSON.stringify(message));
});
let queue = Promise.resolve();
function enqueue(current, operation) {
  queue = queue.then(() => { if (state === current) return operation(); }).catch(() => {
    if (state === current) { stop(); api.captureFailed(current.id); }
  });
}
api.onCapture((message) => {
  if (message.type === "stop") {
    stop();
    return;
  }
  queue = queue
    .then(async () => {
      if (message.type === "start") await start(message);
      else if (message.sessionId === state?.id && message.type === "signal") {
        await state.peer.setRemoteDescription(message.signal);
        for (const candidate of state.candidates.splice(0)) await state.peer.addIceCandidate(candidate);
      } else if (message.sessionId === state?.id && message.type === "ice") {
        if (state.peer.remoteDescription) await state.peer.addIceCandidate(message.candidate);
        else if (state.candidates.length < 128) state.candidates.push(message.candidate);
      }
      else if (message.sessionId === state?.id && message.type === "focus")
        await focus(message.screenId);
      else if (message.sessionId === state?.id && message.type === "visibility") {
        state.visible = new Set(message.screenIds);
        await focus(state.focus);
      }
    else if (message.sessionId === state?.id && message.type === "stats") {
      const current = state, report = await current.peer.getStats();
      if (state !== current) return;
      api.captureMetrics?.({ sessionId: current.id, tracks: current.media.map(item => {
        const row = [...report.values()].find(row => row.type === "outbound-rtp" && row.kind === "video" && row.mid === current.peer.getTransceivers().find(t => t.sender === item.sender)?.mid);
        const settings = item.track?.getSettings() ?? {}, source = report.get(row?.mediaSourceId);
        return { suspended: !item.track, settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate, aspectRatio: settings.aspectRatio }, enabled: item.track?.enabled ?? false, muted: item.track?.muted ?? false, sourceFrames: source?.frames, sourceFps: source?.framesPerSecond, profile: item.sender.getParameters().encodings?.[0], width: row?.frameWidth, height: row?.frameHeight, fps: row?.framesPerSecond, framesEncoded: row?.framesEncoded, totalEncodeTime: row?.totalEncodeTime, qualityLimitationReason: row?.qualityLimitationReason, encoderImplementation: row?.encoderImplementation, powerEfficientEncoder: row?.powerEfficientEncoder };
      }) });
    }
    })
    .catch(() => {
      const id = state?.id;
      stop();
      if (id) api.captureFailed(id);
    });
});
window.addEventListener("beforeunload", stop);
