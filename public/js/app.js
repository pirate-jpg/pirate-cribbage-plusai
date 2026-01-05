// FILE 2/2 — public/js/app.js (FULL)
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

// Join overlay
const joinOverlay = el("joinOverlay");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const vsAiInput = el("vsAiInput");
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
let lastGameOverShownKey = ""; // prevents re-showing modal on every state emit

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

// Sticky GO modal: show ONLY when opponent says GO (per your preference)
function maybeShowGoModal() {
  const ge = state?.lastGoEvent;
  if (!ge || !ge.ts) return;
  if (ge.ts === lastGoSeenTs) return;

  lastGoSeenTs = ge.ts;

  // Only show if opponent said GO
  if (ge.player === state.me) return;

  const who = ge.player === state.me ? "You" : "Opponent";
  goModalText.textContent = `${who} said GO`;
  showModal(goModal);
}

goModalOk.onclick = () => hideModal(goModal);

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

gameModalNext.onclick = () => {
  hideModal(gameModal);
  socket.emit("next_hand");
};
gameModalNewMatch.onclick = () => {
  hideModal(gameModal);
  socket.emit("new_match");
};

function renderPileAndHud() {
  if (!state) return;

  countNum.textContent = String(state.peg?.count ?? 0);

  pileArea.innerHTML = "";
  const pile = state.peg?.pile || [];
  const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
  for (const c of show) {
    pileArea.appendChild(makeCardButton(c, { disabled: true }));
  }

  if (state.stage !== "pegging") {
    peggingStatus.textContent = "";
    lastScore.classList.add("hidden");
    return;
  }

  const myTurn = state.turn === state.me;
  peggingStatus.textContent = myTurn ? "Your turn" : "Opponent’s turn";

  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
    lastScore.classList.remove("hidden");
  } else {
    lastScore.classList.add("hidden");
  }

  // Sticky GO modal
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
    showPanel.classList.add("hidden");
    return;
  }
  showPanel.classList.remove("hidden");

  const cut = state.show.cut;
  cutLine.textContent = `Cut: ${cut.rank}${cut.suit}`;

  const nonDealer = state.show.nonDealer;
  const dealer = state.show.dealer;

  ndTitle.textContent = `Non-dealer (${playerName(nonDealer)})`;
  dTitle.textContent = `Dealer (${playerName(dealer)})`;
  cTitle.textContent = `Crib (${playerName(dealer)})`;

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
  cTotal.textContent = `Total: ${de.breakdown.total}`;
  cTotal.textContent = `Total: ${cr.breakdown.total}`;
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

  // buttons
  discardBtn.style.display = "none";
  goBtn.style.display = "none";
  nextHandBtn.style.display = "none";
  newMatchBtn.style.display = "none";

  handArea.innerHTML = "";

  // STAGES
  if (state.stage === "lobby") {
    handTitle.textContent = "Waiting for crew…";
    handHelp.textContent = `If this is 2-player, open the same table code on the other device: "${state.tableId}".`;
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");

    const cribOwner = playerName(state.dealer);
    handTitle.textContent = "Your Hand";
    handHelp.textContent = `Click a card to send it to ${cribOwner}'s crib (send 2 total).`;

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
    showPanel.classList.add("hidden");
    handTitle.textContent = "Pegging";
    handHelp.textContent = "Play a card without exceeding 31. If you can’t play, press GO.";

    const myTurn = state.turn === state.me;
    const myHand = state.myHand || [];
    const count = state.peg.count;

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
    handTitle.textContent = "Show";
    handHelp.textContent = state.gameOver
      ? `${playerName(state.gameWinner)} won this game.`
      : "Review scoring. Click Next Hand when ready.";

    nextHandBtn.style.display = "inline-block";
    nextHandBtn.onclick = () => socket.emit("next_hand");

    if (state.matchOver) {
      newMatchBtn.style.display = "inline-block";
      newMatchBtn.onclick = () => socket.emit("new_match");
      handHelp.textContent = `${playerName(state.matchWinner)} wins the match (best of 3).`;
    }

    const myHand = state.myHand || [];
    myHand.forEach(card => handArea.appendChild(makeCardButton(card, { disabled: true })));
    if (state.cut) handArea.appendChild(makeCardButton(state.cut, { disabled: true }));

    // Sticky game-over modal
    maybeShowGameOverModal();

    return;
  }
}

// JOIN FLOW
function doJoin() {
  const name = (nameInput.value || "").trim().slice(0, 16);
  const tableId = (tableInput.value || "").trim().slice(0, 24);
  const vsAI = !!vsAiInput?.checked;

  if (!name) { alert("Enter a name."); return; }
  if (!tableId) { alert("Enter a table code."); return; }

  socket.emit("join_table", { tableId, name, vsAI });
  joinOverlay.style.display = "none";
}

// FORCE BLANK JOIN FIELDS (every load, every restore)
(function initJoinDefaults() {
  function blankJoinFields() {
    if (nameInput) nameInput.value = "";
    if (tableInput) tableInput.value = "";
    if (vsAiInput) vsAiInput.checked = false;

    // Some mobile browsers "restore" form state even when value is blanked.
    // Clearing defaultValue helps prevent that restore.
    if (nameInput) nameInput.defaultValue = "";
    if (tableInput) tableInput.defaultValue = "";

    // Nuke any stored draft values Safari might keep for this origin.
    try {
      sessionStorage.removeItem("nameInput");
      sessionStorage.removeItem("tableInput");
    } catch (_) {}
  }

  blankJoinFields();

  // iOS/Safari back-forward cache restore
  window.addEventListener("pageshow", blankJoinFields);

  // extra passes (Safari sometimes fills after first paint)
  setTimeout(blankJoinFields, 50);
  setTimeout(blankJoinFields, 250);
  setTimeout(blankJoinFields, 800);
})();

nameJoinBtn.onclick = doJoin;
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
tableInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });

socket.on("connect", () => {
  // idle until Set Sail
});

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));