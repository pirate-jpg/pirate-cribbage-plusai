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
const cribLine = el("cribLine");
const p1Wins = el("p1Wins");
const p2Wins = el("p2Wins");
const p1Name = el("p1Name");
const p2Name = el("p2Name");

// Buttons
const newMatchBtn = el("newMatchBtn");
const nextGameBtn = el("nextGameBtn");

// Play panel
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
const goBtn = el("goBtn");
const nextHandBtn = el("nextHandBtn");

// Pegging HUD
const pileArea = el("pileArea");
const countNum = el("countNum");
const peggingStatus = el("peggingStatus");
const lastScore = el("lastScore");

// Game Over banner
const gameOverBanner = el("gameOverBanner");
const gameOverText = el("gameOverText");

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

// Join overlay
const joinOverlay = el("joinOverlay");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const vsAiCheck = el("vsAiCheck");
const nameJoinBtn = el("nameJoinBtn");

let state = null;

// Discard selection UX fix:
let selectedForDiscard = new Set();
let discardPending = false;         // waiting for server confirmation
let pendingDiscardIds = [];         // to keep highlight stable

let lastSeenActionSig = "";

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

function renderBoard() {
  if (!state) return;

  p1Label.textContent = state.players.PLAYER1 || "P1";
  p2Label.textContent = state.players.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores.PLAYER1);
  setPegPosition(p2Peg, state.scores.PLAYER2);
}

function setPips(elPips, count, target) {
  if (!elPips) return;
  elPips.innerHTML = "";
  for (let i = 0; i < target; i++) {
    const d = document.createElement("div");
    d.className = "pip" + (i < count ? " on" : "");
    elPips.appendChild(d);
  }
}

function renderMatch() {
  if (!state) return;
  if (!p1Wins || !p2Wins || !p1Name || !p2Name) return;

  const n1 = state.players.PLAYER1 || "P1";
  const n2 = state.players.PLAYER2 || "P2";
  p1Name.textContent = n1;
  p2Name.textContent = n2;

  setPips(p1Wins, state.matchWins?.PLAYER1 || 0, state.matchTarget || 3);
  setPips(p2Wins, state.matchWins?.PLAYER2 || 0, state.matchTarget || 3);
}

function renderGoAndLastAction() {
  if (!state) return;

  const a = state.lastAction;
  const sig = a ? `${a.type}|${a.player}|${a.msg}` : "";
  if (sig && sig !== lastSeenActionSig) {
    lastSeenActionSig = sig;

    if (a.type === "go" && a.player && a.player !== state.me) {
      const oppName = state.names?.[a.player] || "Opponent";
      lastScore.textContent = `${oppName} said GO!`;
      lastScore.classList.remove("hidden");
      lastScore.classList.add("goCallout");
    } else {
      lastScore.classList.remove("goCallout");
    }

    if (a.type === "gameover") {
      gameOverBanner.classList.remove("hidden");
      gameOverText.textContent = a.msg || "Game over!";
    }
  }

  if (state.gameOver) {
    gameOverBanner.classList.remove("hidden");
    const winner = state.gameWinner ? (state.names?.[state.gameWinner] || state.gameWinner) : "Winner";
    gameOverText.textContent = `${winner} wins!`;
  } else {
    gameOverBanner.classList.add("hidden");
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
    return;
  }

  const myTurn = state.turn === state.me;
  peggingStatus.textContent =
    `${myTurn ? "Your turn" : "Opponent’s turn"} • You: ${state.myHandCount} • Opponent: ${state.oppHandCount}`;

  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
    lastScore.classList.remove("hidden");
    lastScore.classList.remove("goCallout");
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

  const ndName = state.names?.[nonDealer] || nonDealer;
  const dName = state.names?.[dealer] || dealer;

  ndTitle.textContent = `Non-dealer (${ndName})`;
  dTitle.textContent = `Dealer (${dName})`;
  cTitle.textContent = `Crib (${dName})`;

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

function syncDiscardPendingFromState() {
  if (!state) return;

  // If we were pending and server now shows we discarded (or stage moved on), clear pending
  const mine = state.me;
  const mineDiscarded = state.discardsCount?.[mine] === 2;

  if (discardPending && (mineDiscarded || state.stage !== "discard")) {
    discardPending = false;
    pendingDiscardIds = [];
    selectedForDiscard.clear();
  }

  // If not pending and still in discard, make sure we aren't holding stale selection from previous hand
  if (!discardPending && state.stage !== "discard" && selectedForDiscard.size) {
    selectedForDiscard.clear();
    pendingDiscardIds = [];
  }
}

function render() {
  if (!state) return;

  syncDiscardPendingFromState();

  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${state.names?.[state.me] || state.me}`;

  const p1 = state.players.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players.PLAYER2 ? state.players.PLAYER2 : "—";
  playersLine.textContent = `Players: ${p1} vs ${p2}`;

  stageLine.textContent = `Stage: ${state.stage}`;
  dealerLine.textContent = `Dealer: ${state.names?.[state.dealer] || state.dealer}`;
  turnLine.textContent = `Turn: ${state.names?.[state.turn] || state.turn}`;

  const p1n = state.players.PLAYER1 || "P1";
  const p2n = state.players.PLAYER2 || "P2";
  scoreLine.textContent = `${p1n} ${state.scores.PLAYER1} • ${p2n} ${state.scores.PLAYER2}`;

  const cribOwnerName = state.names?.[state.dealer] || state.dealer;
  cribLine.textContent = `Crib (${cribOwnerName}) • Discards: ${p1n} ${state.discardsCount.PLAYER1}/2  ${p2n} ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderMatch();
  renderPileAndHud();
  renderShow();
  renderGoAndLastAction();

  goBtn.style.display = "none";
  nextHandBtn.style.display = "none";
  if (nextGameBtn) nextGameBtn.style.display = "none";

  handArea.innerHTML = "";

  if (state.gameOver) {
    handTitle.textContent = "Game Over";
    handHelp.textContent = "Winner announced. Start Next Game or New Match.";
    if (nextGameBtn) {
      nextGameBtn.style.display = "inline-block";
      nextGameBtn.onclick = () => socket.emit("next_game");
    }
    return;
  }

  if (state.stage === "lobby") {
    handTitle.textContent = "Waiting…";
    handHelp.textContent = "Join a table to start. (Use the same code on another device for 2-player.)";
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");
    handTitle.textContent = "Discard";

    const cribOwner = state.names?.[state.dealer] || "dealer";

    if (discardPending) {
      handHelp.textContent = `Sending 2 cards to ${cribOwner}’s crib…`;
    } else {
      handHelp.textContent = `Select 2 cards to send to ${cribOwner}’s crib.`;
    }

    const myHand = state.myHand || [];

    const selectedIds = discardPending ? new Set(pendingDiscardIds) : selectedForDiscard;

    myHand.forEach(card => {
      const selected = selectedIds.has(card.id);
      const btn = makeCardButton(card, {
        selected,
        disabled: discardPending, // prevent extra clicks while we wait
        onClick: () => {
          if (discardPending) return;

          if (selectedForDiscard.has(card.id)) selectedForDiscard.delete(card.id);
          else {
            if (selectedForDiscard.size >= 2) return;
            selectedForDiscard.add(card.id);
          }

          // When two selected, send ONCE and hold highlights until server confirms
          if (selectedForDiscard.size === 2) {
            pendingDiscardIds = Array.from(selectedForDiscard);
            discardPending = true;
            socket.emit("discard_to_crib", { cardIds: pendingDiscardIds });
          }

          render();
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
    handHelp.textContent = "Review scoring. Click Next Hand when ready.";
    nextHandBtn.style.display = "inline-block";
    nextHandBtn.onclick = () => socket.emit("next_hand");

    const myHand = state.myHand || [];
    myHand.forEach(card => handArea.appendChild(makeCardButton(card, { disabled: true })));
    if (state.cut) handArea.appendChild(makeCardButton(state.cut, { disabled: true }));
    return;
  }
}

// JOIN FLOW
function doJoin() {
  const name = (nameInput.value || "").trim().slice(0, 16);
  const tableId = (tableInput.value || "").trim().slice(0, 24) || "JIM1";
  const vsAI = !!(vsAiCheck && vsAiCheck.checked);

  if (!name) { alert("Enter a name."); return; }
  socket.emit("join_table", { tableId, name, vsAI });
  joinOverlay.style.display = "none";
}

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

if (newMatchBtn) newMatchBtn.onclick = () => socket.emit("new_match");
if (nextGameBtn) nextGameBtn.onclick = () => socket.emit("next_game");

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));
