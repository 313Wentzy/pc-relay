const $ = id => document.getElementById(id);
let connected = false, topLayer = 2;
const initialNotes = $("notes").value;
function setConnected(value) {
  connected = value;
  document.querySelector(".viewer").classList.toggle("connected", value);
  $("offline").hidden = value;
  $("connect").textContent = value ? "Disconnect" : "Connect demo";
  $("connection-status").textContent = value ? "Demo connected · simulated desktop" : "Demo disconnected";
  for (const id of ["notes-window", "terminal-window"]) $(id).hidden = true;
  if (value) $("notes-window").hidden = false;
}
$("connect").addEventListener("click", () => setConnected(!connected));
$("reset").addEventListener("click", () => {
  $("notes").value = initialNotes; $("terminal-output").textContent = "No commands are executed. Try: help, whoami, date, clear.";
  $("command").value = "";
  for (const id of ["notes-window", "terminal-window"]) { $(id).style.left = ""; $(id).style.top = ""; }
  setConnected(false);
});
for (const name of ["notes", "terminal"]) $("open-" + name).addEventListener("click", () => {
  if (!connected) return;
  const window = $(name + "-window"); window.hidden = false; window.style.zIndex = ++topLayer;
  $(name === "notes" ? "notes" : "command").focus();
});
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(button.dataset.close).hidden = true);
for (const window of document.querySelectorAll(".window")) {
  const bar = window.querySelector(".titlebar"); let drag;
  window.addEventListener("pointerdown", () => window.style.zIndex = ++topLayer);
  bar.addEventListener("pointerdown", event => {
    if (event.target.closest("button")) return;
    drag = { x: event.clientX - window.offsetLeft, y: event.clientY - window.offsetTop };
    bar.setPointerCapture(event.pointerId);
  });
  bar.addEventListener("pointermove", event => {
    if (!drag) return;
    window.style.left = Math.max(0, Math.min($("desktop").clientWidth - window.offsetWidth, event.clientX - drag.x)) + "px";
    window.style.top = Math.max(0, Math.min($("desktop").clientHeight - window.offsetHeight - 32, event.clientY - drag.y)) + "px";
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) bar.addEventListener(name, () => { drag = null; });
}
$("terminal-form").addEventListener("submit", event => {
  event.preventDefault(); const input = $("command"); const command = input.value.trim(); input.value = "";
  const responses = { help: "Simulated commands: help, whoami, date, clear. Nothing runs on a host.", whoami: "demo-visitor (browser simulation)", date: new Date().toLocaleString() };
  if (command === "clear") $("terminal-output").textContent = "";
  else $("terminal-output").textContent = ($("terminal-output").textContent + "\n> " + command + "\n" + (responses[command] || "This is a simulation. Type help.")).slice(-8000);
  $("terminal-output").scrollTop = $("terminal-output").scrollHeight;
});
function clock() { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
clock(); setInterval(clock, 10000);
