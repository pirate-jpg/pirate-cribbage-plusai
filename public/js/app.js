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

// Join overlay
const joinOverlay = el("joinOverlay");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const vsAiInput = el("vsAiInput");
const nameJoinBtn = el("nameJoinBtn");

// GO overlay
const goOverlay = el("goOverlay");
const goTitle = el("goTitle");
const goText = el("goText");
const goOkBtn = el("goOkBtn");

// End overlay
const endOverlay = el("endOverlay");
const endTitle = el("endTitle");
const endText = el("endText");
const endContinueBtn = el("endContinueBtn");
const endNewMatchBtn = el("endNewMatchBtn");
const endHint = el("endHint");

let state = null;

// Track GO events
let lastGoSeenTs = 0;
let goModalActive = false;

// Track end-of-game acknowledgement so it doesn't pop repeatedly
let lastGameOverKeyShown = "";
let lastGameOverKeyAcked = "";

function cardValue(rank) {
  if (rank === "A") return 1;
  if (["K","Q","J"].includes(rank)) return 10;
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

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

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

// ---- GO MODAL (sticky only when it matters) ----
function showGoModal(whoText) {
  if (!goOverlay) return;
  goModalActive = true;

  goTitle.textContent = "GO!";
  goText.textContent = `${whoText} said GO — your turn.`;
  goOverlay.classList.remove("hidden");

  goOkBtn.onclick = () => {
    goOverlay.classList.add("hidden");
    goModalActive = false;
    // re-render in case buttons/hand were hidden
    render();
  };
}

// ---- END MODAL (pause after game ends) ----
function makeGameOverKey(s) {
  // build a deterministic key from state so modal triggers once per finished game
  const mw1 = s.matchWins?.PLAYER1 ?? 0;
  const mw2 = s.matchWins?.PLAYER2 ?? 0;
  return [
    s.tableId,
    s.gameOver ? "G1" : "G0",
    s.matchOver ? "M1" : "M0",
    s.gameWinner || "none",
    s.matchWinner || "none",
    s.scores?.PLAYER1 ?? 0,
    s.scores?.PLAYER2 ?? 0,
    mw1,
    mw2,
    s.dealer
  ].join("|");
}

function showEndModal() {
  if (!endOverlay || !state) return;

  const winnerName = playerName(state.gameWinner);
  const iWon = state.gameWinner === state.me;

  endOverlay.classList.remove("hidden");

  if (state.matchOver) {
    endTitle.textContent = "🏆 Match Over";
    endText.textContent = `${playerName(state.matchWinner)} wins the match (best of 3).`;
    endHint.textContent = "Start a new match when ready.";

    endContinueBtn.style.display = "none";
    endNewMatchBtn.style.display = "inline-block";

    endNewMatchBtn.onclick = () => {
      endOverlay.classList.add("hidden");
      lastGameOverKeyAcked = lastGameOverKeyShown;
      socket.emit("new_match");
    };
  } else {
    endTitle.textContent = iWon ? "🏴‍☠️ You won!" : "☠️ You lost!";
    endText.textContent = `${winnerName} won this game.`;
    endHint.textContent = "Continue when you’re ready.";

    endNewMatchBtn.style.display = "none";
    endContinueBtn.style.display = "inline-block";

    endContinueBtn.onclick = () => {
      endOverlay.classList.add("hidden");
      lastGameOverKeyAcked = lastGameOverKeyShown;
      socket.emit("next_hand");
    };
  }
}

function maybeHandleEndModal() {
  if (!state) return;

  // Only in show stage when gameOver becomes true
  if (!(state.stage === "show" && state.gameOver)) {
    // if leaving show, also hide modal
    if (endOverlay && !endOverlay.classList.contains("hidden")) {
      endOverlay.classList.add("hidden");
    }
    return;
  }

  const key = makeGameOverKey(state);
  lastGameOverKeyShown = key;

  // If not acknowledged, show it
  if (lastGameOverKeyAcked !== key) {
    showEndModal();
  }
}

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

  // GO notification (sticky only when it matters)
  const ge = state.lastGoEvent;
  if (ge && ge.ts && ge.ts !== lastGoSeenTs) {
    lastGoSeenTs = ge.ts;

    const who = ge.player === state.me ? "You" : "Opponent";

    // compromise:
    // - if opponent says GO and it's now your turn, show modal that must be acknowledged
    // - otherwise just show a toast
    const opponentSaidGo = ge.player !== state.me;
    const nowYourTurn = state.turn === state.me;

    if (opponentSaidGo && nowYourTurn) {
      showGoModal(who);
    } else {
      showToast(`${who} said GO`);
    }
  }
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
  cTotal.textContent = `Total: ${cr.breakdown.total}`;
}

function render() {
  if (!state) return;

  // If modals are up, we still render the underlying UI, but we’ll avoid showing “Next Hand”
  const endModalBlocking = (state.stage === "show" && state.gameOver && lastGameOverKeyAcked !== lastGameOverKeyShown);

  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${playerName(state.me)}`;

  const p1 = state.players.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players.PLAYER2 ? state.players.PLAYER2 : "—";
  playersLine.textContent = `Players: ${p1} vs ${p2}`;

  stageLine.textContent = `Stage: ${state.stage}`;
  dealerLine.textContent = `Dealer: ${playerName(state.dealer)}`;
  turnLine.textContent = `Turn: ${playerName(state.turn)}`;

  // Game score with NAMES
  scoreLine.textContent = `${p1} ${state.scores.PLAYER1} • ${p2} ${state.scores.PLAYER2}`;

  // Match score (best of 3)
  const mw1 = state.matchWins?.PLAYER1 ?? 0;
  const mw2 = state.matchWins?.PLAYER2 ?? 0;
  matchLine.textContent = `Match (best of 3): ${p1} ${mw1} • ${p2} ${mw2}`;

  cribLine.textContent =
    `Crib (${playerName(state.dealer)}) • Discards: ${p1} ${state.discardsCount.PLAYER1}/2  ${p2} ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderPileAndHud();
  renderShow();

  // reset buttons
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

    // If GO modal is up, don't allow interaction underneath (overlay blocks taps),
    // but we can still render normally.
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

    if (state.matchOver) {
      handHelp.textContent = `${playerName(state.matchWinner)} wins the match (best of 3).`;
    } else if (state.gameOver) {
      handHelp.textContent = `${playerName(state.gameWinner)} won this game.`;
    } else {
      handHelp.textContent = "Review scoring. Click Next Hand when ready.";
    }

    // If gameOver, we want the modal to control the flow.
    if (!endModalBlocking) {
      nextHandBtn.style.display = "inline-block";
      nextHandBtn.onclick = () => socket.emit("next_hand");
    }

    if (state.matchOver && !endModalBlocking) {
      newMatchBtn.style.display = "inline-block";
      newMatchBtn.onclick = () => socket.emit("new_match");
    }

    const myHand = state.myHand || [];
    myHand.forEach(card => handArea.appendChild(makeCardButton(card, { disabled: true })));
    if (state.cut) handArea.appendChild(makeCardButton(state.cut, { disabled: true }));

    // After rendering show, decide whether to pop end modal
    maybeHandleEndModal();
    return;
  }
}

// JOIN FLOW
function doJoin() {
  const name = (nameInput.value || "").trim().slice(0, 16);
  const tableId = (tableInput.value || "").trim().slice(0, 24) || "JIM1";
  const vsAI = !!vsAiInput?.checked;

  if (!name) { alert("Enter a name."); return; }
  socket.emit("join_table", { tableId, name, vsAI });
  joinOverlay.style.display = "none";
}

// Pre-fill from URL if present
(function initJoinDefaults(){
  const qs = new URLSearchParams(location.search);
  const table = (qs.get("table") || "JIM1").toString().trim().slice(0, 24);
  const name = (qs.get("name") || "").toString().trim().slice(0, 16);
  tableInput.value = table;
  if (name) nameInput.value = name;
})();

nameJoinBtn.onclick = doJoin;
nameInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });
tableInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });

socket.on("connect", () => {
  // idle until Set Sail
});

socket.on("state", (s) => {
  state = s;

  // update the "shown" key whenever a new end-state arrives
  if (state?.stage === "show" && state?.gameOver) {
    lastGameOverKeyShown = makeGameOverKey(state);
  }

  render();
});

socket.on("error_msg", (msg) => alert(msg));
