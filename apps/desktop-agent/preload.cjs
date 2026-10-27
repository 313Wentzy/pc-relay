const { contextBridge, ipcRenderer } = require("electron");
function listen(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld(
  "longCableAgent",
  Object.freeze({
    status: () => ipcRenderer.invoke("agent:status"),
    action: (name, value) => ipcRenderer.invoke("agent:action", name, value),
    onStatus: (callback) => listen("agent:status", callback),
    onCapture: (callback) => listen("agent:capture", callback),
    onDirectAck: (callback) => listen("agent:direct-ack", callback),
    directInput: (value) => ipcRenderer.invoke("agent:direct-input", value),
    captureSignal: (value) => ipcRenderer.invoke("agent:capture-signal", value),
    captureIce: (value) => ipcRenderer.invoke("agent:capture-ice", value),
    prepareCapture: (value) => ipcRenderer.invoke("agent:prepare-capture", value),
    captureFailed: (id, reason) => ipcRenderer.invoke("agent:capture-failed", id, reason),
  }),
);
