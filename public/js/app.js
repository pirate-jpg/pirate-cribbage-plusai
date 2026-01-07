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

// Join overlay (mode UI)
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

// GO modal
const goModal = el("goModal");
const goModalText = el("goModalText");
const goModalOk = el("goModalOk");

// Game over modal
const gameModal = el("gameModal");
const gameModalText = el("gameModalText");
const gameModalNext = el("gameModalNext");
const gameModalNewMatch = el("gameModalNewMatch");

let state = null;
let lastGoSeenTs = 0;
let lastGameOverShownKey = "";

// Discard popup: show once per discard stage
let discardPopupShownForKey = "";

// Join behavior
let joinMode = null; // "ai" | "pvp"
let pendingJoin = false;

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

// GO modal: show ONLY when opponent says GO
function maybeShowGoModal() {
  const ge = state?.lastGoEvent;
  if (!ge || !ge.ts) return;
  if (ge.ts === lastGoSeenTs) return;

  lastGoSeenTs = ge.ts;
  if (ge.player === state.me) return;

  goModalText.textContent = "Opponent said GO";
  showModal(goModal);
}

if (goModalOk) goModalOk.onclick = () => hideModal(goModal);

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

  ndCards.innerHTML = "";
  dCards.innerHTML = "";
  cCards.innerHTML = "";

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

  ndTotal.textContent = `Total: ${nd.breakdown.total}`;
  dTotal.textContent = `Total: ${de.breakdown.total}`;
  cTotal.textContent = `Total: ${cr.breakdown.total}`;
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

  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${playerName(state.me)}`;

  const p1 = state.players.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players.PLAYER2 ? state.players.PLAYER2 : "—";
  playersLine.textContent = `Players: ${p1} vs ${p2}`;

  stageLine.textContent = `Stage: ${state.stage}`;
  dealerLine.textContent = `Dealer: ${playerName(state.dealer)}`;
  turnLine.textContent = `Turn: ${playerName(state.turn)}`;

  scoreLine.textContent = `${p1} ${state.scores.PLAYER1} • ${p2} ${state.scores.PLAYER2}`;

  const mw1 = state.matchWins?.PLAYER1 ?? 0;
  const mw2 = state.matchWins?.PLAYER2 ?? 0;
  matchLine.textContent = `Match (best of 3): ${p1} ${mw1} • ${p2} ${mw2}`;

  cribLine.textContent =
    `Crib (${playerName(state.dealer)}) • Discards: ${p1} ${state.discardsCount.PLAYER1}/2  ${p2} ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderPileAndHud();
  renderShow();

  // buttons reset
  discardBtn.style.display = "none";
  goBtn.style.display = "none";
  nextHandBtn.style.display = "none";
  newMatchBtn.style.display = "none";
  setNextHandProminence(false);

  handArea.innerHTML = "";

  if (state.stage === "lobby") {
    discardPopupShownForKey = "";
    handTitle.textContent = "Waiting for crew…";
    handHelp.textContent = `If this is 2-player, open the same table code on the other device: "${state.tableId}".`;
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");

    const cribOwner = playerName(state.dealer);
    handTitle.textContent = "Discard";
    handHelp.textContent = `Tap 2 cards to send to ${cribOwner}'s crib.`;

    // popup only once (no “discard one more” popup)
    const myDiscarded = state.discardsCount?.[state.me] ?? 0;
    const key = `${state.tableId}|discard|${state.dealer}`;
    if (myDiscarded === 0 && discardPopupShownForKey !== key) {
      discardPopupShownForKey = key;
      alert("Discard two cards to the crib.");
    }

    const myHand = state.myHand || [];
    myHand.forEach(card => {
      const btn = makeCardButton(card, {
        onClick: () => socket.emit("discard_one", { cardId: card.id })
      });
      handArea.appendChild(btn);
    });

    return;
  } else {
    discardPopupShownForKey = "";
  }

  if (state.stage === "pegging") {
    showPanel.classList.add("hidden");

    handTitle.textContent = "Pegging";
    handHelp.textContent = "Play a card without exceeding 31. If you can’t play, press GO.";

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
      goBtn.style.display = "inline-block";
      goBtn.onclick = () => socket.emit("go");
    }

    return;
  }

  if (state.stage === "show") {
    clearPeggingPanelsForShowOrNonPegging();

    handTitle.textContent = "Show";
    handHelp.textContent = state.gameOver
      ? `${playerName(state.gameWinner)} won this game.`
      : "See scoring below.";

    nextHandBtn.style.display = "inline-block";
    setNextHandProminence(true);
    nextHandBtn.onclick = () => socket.emit("next_hand");

    if (state.matchOver) {
      newMatchBtn.style.display = "inline-block";
      newMatchBtn.onclick = () => socket.emit("new_match");
      handHelp.textContent = `${playerName(state.matchWinner)} wins the match (best of 3).`;
    }

    maybeShowGameOverModal();
    return;
  }
}

// -------------------- JOIN FLOW --------------------
function setJoinUiEnabled(enabled) {
  if (nameJoinBtn) nameJoinBtn.disabled = !enabled;
  if (modeAiBtn) modeAiBtn.disabled = !enabled;
  if (modePvpBtn) modePvpBtn.disabled = !enabled;
  if (backBtn) backBtn.disabled = !enabled;
  if (nameInput) nameInput.disabled = !enabled;
  if (tableInput) tableInput.disabled = !enabled;
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
    joinTopHelp.textContent = "VS Player: enter your name + a table code. Player 2 must enter the same table code.";
    tableRow.style.display = "block";
  }

  setTimeout(() => nameInput && nameInput.focus(), 50);
}

function doJoinFromModeUI() {
  const name = (nameInput?.value || "").trim().slice(0, 16);
  const tableId = (tableInput?.value || "").trim().slice(0, 24);

  if (!socket.connected) {
    entryHint.textContent = "Socket disconnected. Refresh and try again.";
    return;
  }

  if (!name) { alert("Enter a name."); return; }
  if (joinMode !== "ai" && !tableId) { alert("Enter a table code."); return; }
  if (!joinMode) { alert("Choose a mode."); return; }

  pendingJoin = true;
  setJoinUiEnabled(false);
  entryHint.textContent = "Joining…";

  const vsAI = (joinMode === "ai");
  socket.emit("join_table", { tableId: vsAI ? "" : tableId, name, vsAI });

  // IMPORTANT: do NOT hide the overlay yet.
  // We hide it only once the first 'state' arrives.
}

if (modeAiBtn) modeAiBtn.onclick = () => showEntryPanel("ai");
if (modePvpBtn) modePvpBtn.onclick = () => showEntryPanel("pvp");
if (backBtn) backBtn.onclick = () => showModePanel();

if (joinForm) {
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    doJoinFromModeUI();
  });
} else if (nameJoinBtn) {
  nameJoinBtn.onclick = doJoinFromModeUI;
}

if (joinOverlay) showModePanel();

// socket lifecycle hints
socket.on("connect", () => {
  if (pendingJoin) entryHint.textContent = "Joining…";
});
socket.on("disconnect", () => {
  if (joinOverlay) {
    joinOverlay.style.display = "block";
    entryHint.textContent = "Socket disconnected. Refresh and try again.";
    setJoinUiEnabled(true);
    pendingJoin = false;
  }
});

socket.on("state", (s) => {
  state = s;

  // first successful join: hide overlay
  if (pendingJoin && joinOverlay) {
    joinOverlay.style.display = "none";
    pendingJoin = false;
    setJoinUiEnabled(true);
  }

  render();
});

socket.on("error_msg", (msg) => {
  // keep overlay visible, show message, re-enable
  if (joinOverlay) joinOverlay.style.display = "block";
  entryHint.textContent = String(msg || "Join failed.");
  pendingJoin = false;
  setJoinUiEnabled(true);
});