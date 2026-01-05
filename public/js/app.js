// public/js/app.js
const socket = io();
const el = (id) => document.getElementById(id);

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
const handBlockLabel = el("handBlockLabel");
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
const entryHint = el("entryHint");
const joinForm = el("joinForm");

const nameInput = el("nameInput");
const tableInput = el("tableInput");
const tableRow = el("tableRow");
const nameJoinBtn = el("nameJoinBtn");

// GO modal
const goModal = el("goModal");
const goModalText = el("goModalText");
const goModalOk = el("goModalOk");

// Game Over modal
const gameModal = el("gameModal");
const gameModalText = el("gameModalText");
const gameModalNext = el("gameModalNext");
const gameModalNewMatch = el("gameModalNewMatch");

let state = null;
let lastGoSeenTs = 0;
let lastGameOverShownKey = "";

let selectedMode = null; // "ai" | "pvp"

function cardValue(rank) {
  if (rank === "A") return 1;
  if (["K", "Q", "J"].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function suitClass(suit) {
  return (suit === "♥" || suit === "♦") ? "red" : "black";
}

function makeCardButton(card, opts = {}) {
  const btn = document.createElement("button");
  btn.className = `cardBtn ${suitClass(card.suit)}`;
  if (opts.selected) btn.classList.add("selected");
  if (opts.disabled) btn.disabled = true;

  const corner1 = document.createElement("div");
  corner1.className = "corner";
  corner1.textContent = card.rank;

  const big = document.createElement("div");
  big.className = "suitBig";
  big.textContent = card.suit;

  const corner2 = document.createElement("div");
  corner2.className = "corner bottom";
  corner2.textContent = card.rank;

  btn.append(corner1, big, corner2);

  if (opts.onClick) btn.onclick = opts.onClick;
  return btn;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function initTicksOnce() {
  if (!ticks) return;
  if (ticks.childElementCount > 0) return;
  [0, 30, 60, 90, 121].forEach(n => {
    const span = document.createElement("span");
    span.textContent = String(n);
    ticks.appendChild(span);
  });
}

function setPegPosition(pegEl, score) {
  const s = clamp(score, 0, 121);
  const pct = (s / 121) * 100;
  pegEl.style.left = `${pct}%`;
}

function playerName(p) {
  if (!state) return p;
  return state.players?.[p] || p;
}

function renderBoard() {
  if (!state) return;

  p1Label.textContent = state.players.PLAYER1 || "P1";
  p2Label.textContent = state.players.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores.PLAYER1);
  setPegPosition(p2Peg, state.scores.PLAYER2);
}

function showToast(msg) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2200);
}

function showModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.remove("hidden");
}

function hideModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.add("hidden");
}

// Sticky GO modal: show ONLY when opponent says GO
function maybeShowGoModal() {
  const ge = state?.lastGoEvent;
  if (!ge || !ge.ts) return;
  if (ge.ts === lastGoSeenTs) return;

  lastGoSeenTs = ge.ts;

  // Only show if opponent said GO
  if (ge.player === state.me) return;

  goModalText.textContent = `Opponent said GO`;
  showModal(goModal);
}

if (goModalOk) goModalOk.onclick = () => hideModal(goModal);

// Game over modal: show once per game end
function maybeShowGameOverModal() {
  if (!state) return;
  if (state.stage !== "show") return;
  if (!state.gameOver) return;

  const key = `${state.tableId}|${state.matchWins?.PLAYER1 ?? 0}|${state.matchWins?.PLAYER2 ?? 0}|${state.scores?.PLAYER1 ?? 0}|${state.scores?.PLAYER2 ?? 0}|${state.gameWinner ?? ""}|${state.matchOver ? "M" : "G"}`;
  if (key === lastGameOverShownKey) return;
  lastGameOverShownKey = key;

  const winnerName = playerName(state.gameWinner);
  if (state.matchOver) {
    const matchWinnerName = playerName(state.matchWinner);
    gameModalText.textContent = `${winnerName} won this game.\n\n${matchWinnerName} wins the match (best of 3).`;
    gameModalNewMatch.style.display = "inline-block";
    gameModalNext.textContent = "Next Game";
  } else {
    gameModalText.textContent = `${winnerName} won this game.\n\nPress Next Game when you’re ready.`;
    gameModalNewMatch.style.display = "none";
    gameModalNext.textContent = "Next Game";
  }

  showModal(gameModal);
}

if (gameModalNext) {
  gameModalNext.onclick = () => {
    hideModal(gameModal);
    socket.emit("next_hand");
  };
}
if (gameModalNewMatch) {
  gameModalNewMatch.onclick = () => {
    hideModal(gameModal);
    socket.emit("new_match");
  };
}

function clearPeggingPanelsForShowOrNonPegging() {
  if (pileArea) pileArea.innerHTML = "";
  if (peggingStatus) peggingStatus.textContent = "";
  if (lastScore) lastScore.classList.add("hidden");
}

function renderPileAndHud() {
  if (!state) return;

  if (countNum) countNum.textContent = String(state.peg?.count ?? 0);

  if (state.stage !== "pegging") {
    clearPeggingPanelsForShowOrNonPegging();
    return;
  }

  // Stage = pegging: show pile
  if (pileArea) {
    pileArea.innerHTML = "";
    const pile = state.peg?.pile || [];
    const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
    for (const c of show) {
      pileArea.appendChild(makeCardButton(c, { disabled: true }));
    }
  }

  const myTurn = state.turn === state.me;
  if (peggingStatus) peggingStatus.textContent = myTurn ? "Your turn" : "Opponent’s turn";

  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    if (lastScore) {
      lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
      lastScore.classList.remove("hidden");
    }
  } else {
    if (lastScore) lastScore.classList.add("hidden");
  }

  maybeShowGoModal();
}

function renderBreakdown(listEl, breakdown) {
  listEl.innerHTML = "";
  if (!breakdown || !breakdown.items || breakdown.items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No points.";
    listEl.appendChild(li);
    return;
  }
  for (const item of breakdown.items) {
    const li = document.createElement("li");
    li.textContent = `${item.label} = ${item.pts}`;
    listEl.appendChild(li);
  }
}

function renderShow() {
  if (!state || state.stage !== "show" || !state.show) {
    if (showPanel) showPanel.classList.add("hidden");
    return;
  }
  if (showPanel) showPanel.classList.remove("hidden");

  const cut = state.show.cut;
  if (cutLine) cutLine.textContent = `Cut: ${cut.rank}${cut.suit}`;

  const nonDealer = state.show.nonDealer;
  const dealer = state.show.dealer;

  if (ndTitle) ndTitle.textContent = `Non-dealer (${playerName(nonDealer)})`;
  if (dTitle) dTitle.textContent = `Dealer (${playerName(dealer)})`;
  if (cTitle) cTitle.textContent = `Crib (${playerName(dealer)})`;

  if (ndCards) ndCards.innerHTML = "";
  if (dCards) dCards.innerHTML = "";
  if (cCards) cCards.innerHTML = "";

  const nd = state.show.hand[nonDealer];
  const de = state.show.hand[dealer];
  const cr = state.show.crib;

  for (const c of nd.cards) ndCards.appendChild(makeCardButton(c, { disabled: true }));
  ndCards.appendChild(makeCardButton(cut, { disabled: true }));

  for (const c of de.cards) dCards.appendChild(makeCardButton(c, { disabled: true }));
  dCards.appendChild(makeCardButton(cut, { disabled: true }));

  for (const c of cr.cards) cCards.appendChild(makeCardButton(c, { disabled: true }));
  cCards.appendChild(makeCardButton(cut, { disabled: true }));

  renderBreakdown(ndBreak, nd.breakdown);
  renderBreakdown(dBreak, de.breakdown);
  renderBreakdown(cBreak, cr.breakdown);

  if (ndTotal) ndTotal.textContent = `Total: ${nd.breakdown.total}`;
  if (dTotal) dTotal.textContent = `Total: ${de.breakdown.total}`;
  if (cTotal) cTotal.textContent = `Total: ${cr.breakdown.total}`;
}

function setNextHandProminence(on) {
  if (!nextHandBtn) return;

  if (on) {
    nextHandBtn.style.fontSize = "20px";
    nextHandBtn.style.padding = "14px 20px";
    nextHandBtn.style.fontWeight = "800";
    nextHandBtn.style.borderRadius = "14px";
    nextHandBtn.style.minWidth = "170px";
  } else {
    nextHandBtn.style.fontSize = "";
    nextHandBtn.style.padding = "";
    nextHandBtn.style.fontWeight = "";
    nextHandBtn.style.borderRadius = "";
    nextHandBtn.style.minWidth = "";
  }
}

function render() {
  if (!state) return;

  if (tableLine) tableLine.textContent = `Table: ${state.tableId}`;
  if (meLine) meLine.textContent = `You: ${playerName(state.me)}`;

  const p1 = state.players.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players.PLAYER2 ? state.players.PLAYER2 : "—";
  if (playersLine) playersLine.textContent = `Players: ${p1} vs ${p2}`;

  if (stageLine) stageLine.textContent = `Stage: ${state.stage}`;
  if (dealerLine) dealerLine.textContent = `Dealer: ${playerName(state.dealer)}`;
  if (turnLine) turnLine.textContent = `Turn: ${playerName(state.turn)}`;

  if (scoreLine) scoreLine.textContent = `${p1} ${state.scores.PLAYER1} • ${p2} ${state.scores.PLAYER2}`;

  const mw1 = state.matchWins?.PLAYER1 ?? 0;
  const mw2 = state.matchWins?.PLAYER2 ?? 0;
  if (matchLine) matchLine.textContent = `Match (best of 3): ${p1} ${mw1} • ${p2} ${mw2}`;

  if (cribLine) {
    cribLine.textContent =
      `Crib (${playerName(state.dealer)}) • Discards: ${p1} ${state.discardsCount.PLAYER1}/2  ${p2} ${state.discardsCount.PLAYER2}/2`;
  }

  initTicksOnce();
  renderBoard();
  renderPileAndHud();
  renderShow();

  // buttons reset
  if (discardBtn) discardBtn.style.display = "none";
  if (goBtn) goBtn.style.display = "none";
  if (nextHandBtn) nextHandBtn.style.display = "none";
  if (newMatchBtn) newMatchBtn.style.display = "none";
  setNextHandProminence(false);

  if (handArea) handArea.innerHTML = "";
  if (handBlockLabel) handBlockLabel.textContent = "";

  // STAGES
  if (state.stage === "lobby") {
    if (handTitle) handTitle.textContent = "Waiting for crew…";
    if (handHelp) handHelp.textContent = `If this is 2-player, open the same table code on the other device: "${state.tableId}".`;
    if (showPanel) showPanel.classList.add("hidden");
    if (handBlockLabel) handBlockLabel.textContent = "";
    return;
  }

  if (state.stage === "discard") {
    if (showPanel) showPanel.classList.add("hidden");

    const cribOwner = playerName(state.dealer);
    if (handTitle) handTitle.textContent = "Discard";
    if (handHelp) handHelp.textContent = `Click a card to send it to ${cribOwner}'s crib (send 2 total).`;
    if (handBlockLabel) handBlockLabel.textContent = "Your hand";

    const myHand = state.myHand || [];
    myHand.forEach(card => {
      const btn = makeCardButton(card, {
        onClick: () => {
          socket.emit("discard_one", { cardId: card.id });
          showToast("Sent to crib");
        }
      });
      handArea.appendChild(btn);
    });

    return;
  }

  if (state.stage === "pegging") {
    if (showPanel) showPanel.classList.add("hidden");

    if (handTitle) handTitle.textContent = "Pegging";
    if (handHelp) handHelp.textContent = "Play a card without exceeding 31. If you can’t play, press GO.";
    if (handBlockLabel) handBlockLabel.textContent = "Your hand";

    const myTurn = state.turn === state.me;
    const myHand = state.myHand || [];
    const count = state.peg?.count ?? 0;

    myHand.forEach(card => {
      const playable = myTurn && (count + cardValue(card.rank) <= 31);
      const btn = makeCardButton(card, {
        disabled: !playable,
        onClick: () => socket.emit("play_card", { cardId: card.id })
      });
      handArea.appendChild(btn);
    });

    const canPlay = myHand.some(c => count + cardValue(c.rank) <= 31);
    if (myTurn && myHand.length > 0 && !canPlay) {
      if (goBtn) {
        goBtn.style.display = "inline-block";
        goBtn.onclick = () => socket.emit("go");
      }
    }
    return;
  }

  if (state.stage === "show") {
    // end-of-hand cleanup
    clearPeggingPanelsForShowOrNonPegging();

    if (handTitle) handTitle.textContent = "Show";
    if (handHelp) {
      handHelp.textContent = state.gameOver
        ? `${playerName(state.gameWinner)} won this game.`
        : "See scoring below.";
    }

    if (handBlockLabel) handBlockLabel.textContent = "";

    // Next Hand prominent
    if (nextHandBtn) {
      nextHandBtn.style.display = "inline-block";
      setNextHandProminence(true);
      nextHandBtn.onclick = () => socket.emit("next_hand");
    }

    if (state.matchOver && newMatchBtn) {
      newMatchBtn.style.display = "inline-block";
      newMatchBtn.onclick = () => socket.emit("new_match");
      if (handHelp) handHelp.textContent = `${playerName(state.matchWinner)} wins the match (best of 3).`;
    }

    // Clear handArea and show message
    if (handArea) {
      handArea.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "mutedSmall";
      msg.style.padding = "6px 2px";
      msg.textContent = "See scoring below.";
      handArea.appendChild(msg);
    }

    maybeShowGameOverModal();
    return;
  }
}

// ---------- JOIN FLOW (mode chooser) ----------
function showEntry(mode) {
  selectedMode = mode; // "ai" or "pvp"
  if (modePanel) modePanel.style.display = "none";
  if (entryPanel) entryPanel.style.display = "block";

  if (mode === "ai") {
    if (joinTopHelp) joinTopHelp.textContent = "VS AI: enter your name, then Set Sail.";
    if (entryHint) entryHint.textContent = "Tip: vs AI doesn’t need a table code.";
    if (tableRow) tableRow.style.display = "none";
    if (tableInput) tableInput.value = "";
  } else {
    if (joinTopHelp) joinTopHelp.textContent = "VS Player: enter your name + a table code.\nPlayer 2 must enter the same table code.";
    if (entryHint) entryHint.textContent = "Tip: Use the same table code on another device for 2-player.";
    if (tableRow) tableRow.style.display = "block";
  }

  if (nameInput) {
    nameInput.value = "";
    nameInput.focus();
  }
  if (tableInput && mode === "pvp") tableInput.value = "";
}

function showModeChooser() {
  selectedMode = null;
  if (entryPanel) entryPanel.style.display = "none";
  if (modePanel) modePanel.style.display = "block";
  if (joinTopHelp) joinTopHelp.textContent = "Choose a mode, then enter what's needed to start.";
  if (entryHint) entryHint.textContent = "";
}

if (modeAiBtn) modeAiBtn.onclick = () => showEntry("ai");
if (modePvpBtn) modePvpBtn.onclick = () => showEntry("pvp");
if (backBtn) backBtn.onclick = () => showModeChooser();

function doJoin() {
  const name = (nameInput?.value || "").trim().slice(0, 16);
  const tableId = (tableInput?.value || "").trim().slice(0, 24);

  if (!name) { alert("Enter a name."); return; }

  if (selectedMode === "pvp") {
    if (!tableId) { alert("Enter a table code."); return; }
    socket.emit("join_table", { tableId, name, vsAI: false });
  } else if (selectedMode === "ai") {
    // allow empty tableId; server can assign/derive
    socket.emit("join_table", { tableId: "", name, vsAI: true });
  } else {
    alert("Choose a mode first.");
    return;
  }

  if (joinOverlay) joinOverlay.style.display = "none";
}

// IMPORTANT: prevent form submit refresh (this is often the “stall”)
if (joinForm) {
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    doJoin();
  });
}

if (nameJoinBtn) nameJoinBtn.onclick = (e) => {
  // in case browser triggers click before submit handler
  e?.preventDefault?.();
  doJoin();
};

if (nameInput) nameInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });
if (tableInput) tableInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));