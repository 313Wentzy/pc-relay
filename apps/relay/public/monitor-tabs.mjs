// The workspace owns one authenticated peer. Tabs display its existing tracks;
// they never open another PC connection or ask the host for another capture.
export function monitorTabs(root, { makeVideo, markPopped, focus, release, paste, visibility, duplicateAllowed, debugChanged }) {
  const monitors = new Map(), views = new Map(), lifetime = new AbortController();
  let lastVisible = "", connected = false, metrics = { summary: "—", details: "", rows: [] };
  const send = (view, value) => {
    if (!view.window.closed) view.window.postMessage({ ...value, viewId: view.id }, location.origin);
  };
  function update(view) {
    const monitor = monitors.get(view.screenId);
    const online = connected && Boolean(monitor), fps = metrics.rows.find(row => row.screenId === view.screenId)?.fps;
    send(view, { type: "long-cable-monitor-status", label: monitor?.label || "Monitor", connected: online,
      summary: online ? metrics.summary + " · " + (fps == null ? "—" : fps.toFixed(0)) + " FPS" : "Disconnected", details: view.debug ? metrics.details : "" });
  }
  function syncVisibility() {
    const visible = [];
    for (const [id, monitor] of monitors) {
      const owned = [...views.values()].some(view => view.screenId === id && view.ready && !view.duplicate && !view.window.closed);
      const inline = !owned && document.visibilityState !== "hidden" && root.dataset.view === "computer" && !monitor.container.hidden;
      if (inline || [...views.values()].some(view => view.screenId === id && view.ready && view.visible && !view.window.closed)) visible.push(id);
    }
    const key = JSON.stringify(visible.sort());
    if (connected && key !== lastVisible) { lastVisible = key; visibility(visible); }
  }
  function mount(view) {
    const monitor = monitors.get(view.screenId);
    if (!view.ready || !monitor || view.window.closed) { update(view); return; }
    const host = view.window.document.getElementById("monitor-screen");
    if (!host) return;
    if (view.document !== view.window.document) {
      view.document = view.window.document;
      // Rehome the element synchronously, before the closing document tears
      // down its media/event state. postMessage and the closed-window poll are
      // too late for this; the same callback also handles a monitor reload.
      view.window.addEventListener("pagehide", () => {
        view.ready = false; view.visible = false;
        if (view.duplicate && view.video) { view.video.srcObject = null; view.video.remove(); }
        else { const current = monitors.get(view.screenId); if (current) current.container.append(current.video); markPopped(view.screenId, false); }
        view.video = null; release(); syncVisibility();
      }, { once: true, signal: lifetime.signal });
    }
    const video = view.duplicate ? (view.video || makeVideo(view.screenId, monitor.label)) : monitor.video;
    view.video = video;
    if (view.duplicate) video.srcObject = monitor.video.srcObject;
    if (host.firstElementChild !== video) host.replaceChildren(video);
    void video.play().catch(() => {});
    if (!view.duplicate) markPopped(view.screenId, true);
    update(view); syncVisibility();
  }
  function reclaim(screenId, close = true) {
    const monitor = monitors.get(screenId);
    for (const [id, view] of views) if (view.screenId === screenId) {
      views.delete(id);
      if (view.duplicate && view.video) { view.video.srcObject = null; view.video.remove(); }
      if (close && !view.window.closed) view.window.close();
    }
    if (monitor) monitor.container.append(monitor.video);
    markPopped(screenId, false); syncVisibility();
  }
  window.addEventListener("message", event => {
    if (event.origin !== location.origin || typeof event.data?.viewId !== "string") return;
    const view = views.get(event.data.viewId);
    if (!view || event.source !== view.window) return;
    const value = event.data;
    if (value.type === "long-cable-monitor-ready") {
      view.ready = true; view.visible = value.visible === true;
      mount(view);
      if (value.focused === true) focus(view.screenId);
    } else if (value.type === "long-cable-monitor-visibility") {
      view.visible = value.visible === true;
      if (value.focused === true && view.visible) focus(view.screenId);
      else release();
      syncVisibility();
    } else if (value.type === "long-cable-monitor-denied") {
      reclaim(view.screenId);
    } else if (value.type === "long-cable-monitor-debug") {
      view.debug = value.open === true;
      debugChanged?.();
    } else if (value.type === "long-cable-monitor-paste" && view.ready && view.visible && typeof value.text === "string" && value.text.length <= 16384 && typeof value.insert === "boolean") {
      paste?.(view.screenId, value.text, value.insert);
    }
  }, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", syncVisibility, { signal: lifetime.signal });
  root.addEventListener("pc-visibility", syncVisibility, { signal: lifetime.signal });
  const timer = setInterval(() => {
    for (const view of [...views.values()]) if (view.window.closed) {
      views.delete(view.id);
      if (view.duplicate && view.video) { view.video.srcObject = null; view.video.remove(); }
      if (!view.duplicate) { const monitor = monitors.get(view.screenId); if (monitor) monitor.container.append(monitor.video); markPopped(view.screenId, false); }
      release();
    }
    syncVisibility();
  }, 1000);
  return {
    register(id, label, video, container) {
      monitors.set(id, { label, video, container }); connected = true; lastVisible = "";
      for (const view of views.values()) if (view.screenId === id) { view.video = null; mount(view); }
      syncVisibility();
    },
    open(screenId) {
      if (!monitors.has(screenId)) return false;
      const duplicate = duplicateAllowed();
      const existing = [...views.values()].find(view => view.screenId === screenId && !view.window.closed);
      if (existing && !duplicate) { existing.window.focus(); return true; }
      const id = crypto.randomUUID();
      const target = window.open(new URL("/monitor/" + id, location.origin).href, "long-cable-monitor-" + id);
      if (!target) return false;
      views.set(id, { id, screenId, window: target, ready: false, visible: false, duplicate, video: null });
      return true;
    },
    reclaim,
    duplicatesChanged() {
      if (duplicateAllowed()) return;
      for (const screenId of monitors.keys()) {
        const matches = [...views.values()].filter(view => view.screenId === screenId && !view.window.closed);
        const keep = matches.find(view => !view.duplicate) || matches[0];
        if (!keep) continue;
        for (const view of matches) if (view !== keep) {
          views.delete(view.id);
          if (view.duplicate && view.video) { view.video.srcObject = null; view.video.remove(); }
          view.window.close();
        }
        if (keep.duplicate) { if (keep.video) { keep.video.srcObject = null; keep.video.remove(); } keep.video = null; keep.duplicate = false; mount(keep); }
      }
      release(); syncVisibility();
    },
    changed: syncVisibility,
    refresh() { for (const view of views.values()) mount(view); },
    wantsDetails() { return [...views.values()].some(view => view.ready && view.visible && view.debug && !view.window.closed); },
    metrics(summary, details, rows = []) { metrics = { summary, details, rows }; for (const view of views.values()) update(view); },
    clear() {
      connected = false; lastVisible = "";
      for (const view of views.values()) {
        if (view.video) { view.video.srcObject = null; view.video.remove(); view.video = null; }
        update(view);
      }
      monitors.clear();
    },
    dispose() {
      lifetime.abort(); clearInterval(timer);
      for (const id of new Set([...monitors.keys(), ...[...views.values()].map(view => view.screenId)])) reclaim(id);
      monitors.clear();
    },
  };
}
