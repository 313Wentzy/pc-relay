import { randomUUID } from "node:crypto";

// HWND/PID stay in the main process. Browsers receive only opaque source IDs.
export function windowCatalog(sources, nativeWindows, previous = new Map(), ownHandle = "") {
  const windows = new Map(nativeWindows.map(item => [String(item.handle), item]));
  const entries = new Map(), publicSources = [];
  for (const source of sources) {
    const handle = /^window:(\d+):\d+$/.exec(source.id)?.[1];
    const native = windows.get(handle);
    if (!native || handle === ownHandle || entries.size >= 56 || !Number.isInteger(native.pid) || native.pid <= 0 ||
      ![native.width, native.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) continue;
    const old = [...previous].find(([, item]) => item.sourceId === source.id && item.pid === native.pid);
    const id = old?.[0] || "win-" + randomUUID();
    entries.set(id, { sourceId: source.id, handle, pid: native.pid });
    publicSources.push({ id, kind: "window", label: String(source.name || "Window").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
      width: native.width, height: native.height });
  }
  return { entries, publicSources };
}
