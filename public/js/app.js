const socket = io();
const el = id => document.getElementById(id);

// JOIN UI
const joinOverlay = el("joinOverlay");
const modeSelect = el("modeSelect");
const aiForm = el("aiForm");
const pvpForm = el("pvpForm");

el("modeAiBtn").onclick = () => {
  modeSelect.classList.add("hidden");
  aiForm.classList.remove("hidden");
};
el("modePvPBtn").onclick = () => {
  modeSelect.classList.add("hidden");
  pvpForm.classList.remove("hidden");
};

el("backFromAi").onclick = el("backFromPvP").onclick = () => {
  aiForm.classList.add("hidden");
  pvpForm.classList.add("hidden");
  modeSelect.classList.remove("hidden");
};

el("aiJoinBtn").onclick = () => {
  const name = el("aiNameInput").value.trim();
  if (!name) return alert("Enter your name.");
  socket.emit("join_table", { name, vsAI: true });
  joinOverlay.style.display = "none";
};

el("pvpJoinBtn").onclick = () => {
  const name = el("pvpNameInput").value.trim();
  const tableId = el("pvpTableInput").value.trim();
  if (!name || !tableId) return alert("Enter name and table code.");
  socket.emit("join_table", { name, tableId, vsAI: false });
  joinOverlay.style.display = "none";
};

// GAME UI
const handArea = el("handArea");
const handLabel = el("handLabel");
const pileArea = el("pileArea");
const countNum = el("countNum");
const peggingStatus = el("peggingStatus");
const goBtn = el("goBtn");

let state = null;

function render() {
  if (!state) return;

  handArea.innerHTML = "";
  pileArea.innerHTML = "";

  // PILE
  (state.peg?.pile || []).forEach(c => {
    const d = document.createElement("div");
    d.className = "card";
    d.textContent = c.rank + c.suit;
    pileArea.appendChild(d);
  });

  countNum.textContent = state.peg?.count ?? 0;
  peggingStatus.textContent =
    state.turn === state.me ? "Your turn" : "Opponent’s turn";

  // HAND
  handLabel.classList.remove("hidden");

  (state.myHand || []).forEach(card => {
    const playable =
      state.turn === state.me &&
      state.peg.count + cardValue(card.rank) <= 31;

    const btn = document.createElement("button");
    btn.className = "cardBtn";
    btn.textContent = card.rank + card.suit;
    btn.disabled = !playable;

    btn.onclick = () =>
      socket.emit("play_card", { cardId: card.id });

    handArea.appendChild(btn);
  });

  // GO BUTTON
  const canPlay = (state.myHand || []).some(
    c => state.peg.count + cardValue(c.rank) <= 31
  );

  if (state.turn === state.me && !canPlay) {
    goBtn.classList.remove("hidden");
    goBtn.onclick = () => socket.emit("go");
  } else {
    goBtn.classList.add("hidden");
  }
}

function cardValue(r) {
  if (r === "A") return 1;
  if (["K", "Q", "J"].includes(r)) return 10;
  return parseInt(r, 10);
}

socket.on("state", s => {
  state = s;
  render();
});