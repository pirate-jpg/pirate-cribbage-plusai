const socket = io();
const el = id => document.getElementById(id);

// Mode containers
const modeSelect = el("modeSelect");
const aiForm = el("aiForm");
const pvpForm = el("pvpForm");

// Buttons
el("modeAiBtn").onclick = () => switchMode("ai");
el("modePvpBtn").onclick = () => switchMode("pvp");
el("backFromAi").onclick = resetModes;
el("backFromPvp").onclick = resetModes;

// Inputs
const aiNameInput = el("aiNameInput");
const pvpNameInput = el("pvpNameInput");
const pvpTableInput = el("pvpTableInput");

// Join buttons
el("aiJoinBtn").onclick = () => {
  const name = aiNameInput.value.trim();
  if (!name) return alert("Enter your name.");
  socket.emit("join_table", { name, tableId: "AI", vsAI: true });
  el("joinOverlay").style.display = "none";
};

el("pvpJoinBtn").onclick = () => {
  const name = pvpNameInput.value.trim();
  const tableId = pvpTableInput.value.trim();
  if (!name || !tableId) return alert("Enter name and table code.");
  socket.emit("join_table", { name, tableId, vsAI: false });
  el("joinOverlay").style.display = "none";
};

function switchMode(mode) {
  modeSelect.classList.add("hidden");
  aiForm.classList.toggle("hidden", mode !== "ai");
  pvpForm.classList.toggle("hidden", mode !== "pvp");
}

function resetModes() {
  aiForm.classList.add("hidden");
  pvpForm.classList.add("hidden");
  modeSelect.classList.remove("hidden");

  aiNameInput.value = "";
  pvpNameInput.value = "";
  pvpTableInput.value = "";
}