const api = window.longCableAgent;
const byId = (id) => document.getElementById(id);
function render(status) {
  byId("state").textContent = !status.connected ? "Offline" : status.activeSession
    ? "Session active"
    : !status.enabled ? "Remote access off"
    : status.available ? "Available" : "PC access paused";
  byId("message").textContent = status.message || "";
  byId("relay-status").textContent =
    (status.connected ? "Connected · " : "Offline · ") +
    (status.relay || "Not configured");
  byId("native-status").textContent = status.nativeReady
    ? "Ready"
    : "Unavailable";
  byId("privilege").textContent = status.elevated ? "Administrator" : "User";
  byId("last-pause").textContent = (status.pauseReason || status.lastPause?.reason || "startup").replaceAll("_", " ");
  byId("last-connection").textContent = status.connection ? status.connection.reason.replaceAll("_", " ") + (status.connection.closeCode ? " · " + status.connection.closeCode : "") : "—";
  byId("fingerprint").textContent = status.fingerprint || "Not created";
  byId("enabled").checked = status.enabled === true;
  byId("enabled").disabled =
    !status.enabled && (!status.nativeReady || !status.encryptedStorage);
  byId("resume").hidden = !status.enabled || !status.pauseReason;
  byId("resume").disabled = !status.nativeReady || !status.encryptedStorage;
  byId("pair-form").hidden = status.paired;
  byId("paired").hidden = !status.paired;
  byId("screens").replaceChildren(
    ...status.screens.map((screen) => {
      const li = document.createElement("li");
      li.textContent =
        screen.label + " · " + screen.width + " × " + screen.height;
      return li;
    }),
  );
}
async function action(name, value) {
  try {
    const result = await api.action(name, value);
    if (!result.ok) throw new Error(result.error);
    render(result.status);
  } catch (error) {
    byId("message").textContent = error.message.replaceAll("_", " ");
  }
}
byId("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = byId("code").value;
  byId("code").value = "";
  void action("pair", { relay: byId("relay").value, code });
});
byId("enabled").addEventListener(
  "change",
  (event) => void action("enable", event.target.checked),
);
byId("reconnect").addEventListener("click", () => void action("reconnect"));
byId("resume").addEventListener("click", () => void action("enable", true));
byId("unpair").addEventListener("click", () => void action("unpair"));
api.onStatus(render);
api.status().then(render);
