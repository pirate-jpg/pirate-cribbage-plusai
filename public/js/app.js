const socket = io();
const el = (id) => document.getElementById(id);

/* ===================== DOM REFERENCES ===================== */

// Top chips
const tableLine = el("tableLine");
const meLine = el("meLine");

// Crew panel
const playersLine = el("playersLine");
const stageLine = el("stageLine");
const dealerLine = el("dealerLine");
const turnLine = el("turnLine");
const scoreLine = el("scoreLine");
const matchLine = el("matchLine");
const cribLine = el("cribLine");

// Play panel
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
const discardBtn = el("discardBtn");
const goBtn = el("goBtn");
const nextHandBtn = el("nextHandBtn");
const newMatchBtn = el("newMatchBtn");

// Pegging HUD
const pileArea = el("pileArea");
const countNum = el("countNum");
const peggingStatus = el("peggingStatus");
const lastScore = el("lastScore");

// Board
const p1Peg = el("p1Peg");
const p2Peg = el("p2Peg");
const p1Label = el("p1Label");
const p2Label = el("p2Label");
const ticks = el("ticks");

// Show panel
const showPanel = el("showPanel");
const cutLine = el("cutLine");
const ndTitle = el("ndTitle");
const dTitle = el("dTitle");
const cTitle = el("cTitle");
const ndCards = el("ndCards");
const dCards = el("dCards");
const cCards = el("cCards");
const ndBreak = el("ndBreak");
const dBreak = el("dBreak");
const cBreak = el("cBreak");
const ndTotal = el("ndTotal");
const dTotal = el("dTotal");
const cTotal = el("cTotal");

// Toast
const toast = el("toast");

// Join overlay
const joinOverlay = el("joinOverlay");
const joinTopHelp = el("joinTopHelp");
const modePanel = el("modePanel");
const entryPanel = el("entryPanel");
const modeAiBtn = el("modeAiBtn");
const modePvpBtn = el("modePvpBtn");
const backBtn = el("backBtn");
const joinForm = el("joinForm");
const entryHint = el("entryHint");
const tableRow = el("tableRow");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const nameJoinBtn = el("nameJoinBtn");

// Modals
const goModal = el("goModal");
const goModalText = el("goModalText");
const goModalOk = el("goModalOk");
const gameModal = el("gameModal");
const gameModalText = el("gameModalText");
const gameModalNext = el("gameModalNext");
const gameModalNewMatch = el("gameModalNewMatch");

/* ===================== STATE ===================== */

let state = null;
let joinMode = null;
let pendingJoin = false;

/* ===================== JOIN FLOW ===================== */

function setJoinUiEnabled(enabled) {
  [nameJoinBtn, modeAiBtn, modePvpBtn, backBtn, nameInput, tableInput]
    .forEach(el => el && (el.disabled = !enabled));
}

function showModePanel() {
  modePanel.style.display = "block";
  entryPanel.style.display = "none";
  joinTopHelp.textContent = "Choose a mode, then enter what's needed to start.";
  entryHint.textContent = "";
  joinMode = null;
  pendingJoin = false;
  setJoinUiEnabled(true);
}

function showEntryPanel(mode) {
  joinMode = mode;
  modePanel.style.display = "none";
  entryPanel.style.display = "block";
  entryHint.textContent = "";

  if (mode === "ai") {
    joinTopHelp.textContent = "VS AI: enter your name, then Set Sail.";
    tableRow.style.display = "none";
  } else {
    joinTopHelp.textContent =
      "VS Player: enter your name + a table code. Player 2 must enter the same table code.";
    tableRow.style.display = "block";
  }

  // ✅ iOS Safari zoom fix: DO NOT auto-focus inputs
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  if (!isIOS) {
    setTimeout(() => nameInput && nameInput.focus(), 50);
  }
}

function doJoinFromModeUI() {
  const name = nameInput.value.trim().slice(0, 16);
  const tableId = tableInput.value.trim().slice(0, 24);

  if (!socket.connected) {
    entryHint.textContent = "Socket disconnected. Refresh and try again.";
    return;
  }

  if (!name) {
    goModalText.textContent = "Enter a name.";
    goModal.classList.remove("hidden");
    return;
  }

  if (joinMode !== "ai" && !tableId) {
    goModalText.textContent = "Enter a table code.";
    goModal.classList.remove("hidden");
    return;
  }

  pendingJoin = true;
  setJoinUiEnabled(false);
  entryHint.textContent = "Joining…";

  socket.emit("join_table", {
    name,
    tableId: joinMode === "ai" ? "" : tableId,
    vsAI: joinMode === "ai"
  });
}

modeAiBtn.onclick = () => showEntryPanel("ai");
modePvpBtn.onclick = () => showEntryPanel("pvp");
backBtn.onclick = showModePanel;
joinForm.addEventListener("submit", e => {
  e.preventDefault();
  doJoinFromModeUI();
});

showModePanel();

/* ===================== SOCKET ===================== */

socket.on("state", (s) => {
  state = s;
  if (pendingJoin) {
    joinOverlay.style.display = "none";
    pendingJoin = false;
    setJoinUiEnabled(true);
  }
});