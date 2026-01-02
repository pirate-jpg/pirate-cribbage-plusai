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

const p1Name = el("p1Name");
const p2Name = el("p2Name");
const p1Wins = el("p1Wins");
const p2Wins = el("p2Wins");
const matchLine = el("matchLine");
const crewNewMatchBtn = el("crewNewMatchBtn");

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
const goCallout = el("goCallout");

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

// Winner overlay
const winnerOverlay = el("winnerOverlay");
const winnerTitle = el("winnerTitle");
const winnerText = el("winnerText");
const nextGameBtn = el("nextGameBtn");
const newMatchBtn = el("newMatchBtn");

let state = null;
let selectedForDiscard = new Set();

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

function playerName(pid) {
  if (!state) return pid;
  return state.names?.[pid] || pid;
}

function renderBoard() {
  if (!state) return;

  p1Label.textContent = state.players.PLAYER1 || "P1";
  p2Label.textContent = state.players.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores.PLAYER1);
  setPegPosition(p2Peg, state.scores.PLAYER2);
}

function renderMatch() {
  if (!state) return;

  const p1 = state.players.PLAYER1 || "P1";
  const p2 = state.players.PLAYER2 || "P2";

  p1Name.textContent = p1;
  p2Name.textContent = p2;

  // pips
  p1Wins.innerHTML = "";
  p2Wins.innerHTML = "";

  const target = state.matchTarget || 3;

  for (let i = 0; i < target; i++) {
    const pip = document.createElement("div");
    pip.className = "pip" + (i < (state.matchWins?.PLAYER1 || 0) ? " on" : "");
    p1Wins.appendChild(pip);
  }

  for (let i = 0; i < target; i++) {
    const pip = document.createElement("div");
    pip.className = "pip" + (i < (state.matchWins?.PLAYER2 || 0) ? " on" : "");
    p2Wins.appendChild(pip);
  }

  matchLine.textContent = `${state.matchWins.PLAYER1} – ${state.matchWins.PLAYER2} (first to ${target})`;
}

function renderPileAndHud() {
  if (!state) return;

  countNum.textContent = String(state.peg?.count ?? 0);

  // pile cards
  pileArea.innerHTML = "";
  const pile = state.peg?.pile || [];
  const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
  for (const c of show) {
    pileArea.appendChild(makeCardButton(c, { disabled: true }));
  }

  goCallout.classList.add("hidden");
  lastScore.classList.add("hidden");

  if (state.stage !== "pegging") {
    peggingStatus.textContent = "";
    return;
  }

  const myTurn = state.turn === state.me;
  const mine = state.myHandCount;
  const opp = state.oppHandCount;

  peggingStatus.textContent =
    `${myTurn ? "Your turn" : "Opponent’s turn"} • You: ${mine} card(s) • Opponent: ${opp} card(s)`;

  // GO callout (make it obvious)
  const lg = state.lastGoEvent;
  if (lg && lg.player) {
    const who = lg.player === state.me ? "You" : "Opponent";
    goCallout.textContent = `${who} said GO.`;
    goCallout.classList.remove("hidden");
  }

  // last score callout
  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
    lastScore.classList.remove("hidden");
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

function showWinnerOverlayIfNeeded() {
  if (!state) return;

  if (state.matchOver) {
    winnerOverlay.classList.remove("hidden");
    const w = playerName(state.matchWinner);
    winnerTitle.textContent = "🏴‍☠️ Match Over";
    winnerText.textContent = `${w} wins the match (${state.matchWins.PLAYER1}–${state.matchWins.PLAYER2}).`;
    nextGameBtn.disabled = true;
    nextGameBtn.classList.add("disabledBtn");
    return;
  }

  if (state.gameOver) {
    winnerOverlay.classList.remove("hidden");
    const w = playerName(state.gameWinner);
    winnerTitle.textContent = "🏁 Game Over";
    winnerText.textContent = `${w} wins (${state.scores.PLAYER1}–${state.scores.PLAYER2}).`;
    nextGameBtn.disabled = false;
    nextGameBtn.classList.remove("disabledBtn");
    return;
  }

  winnerOverlay.classList.add("hidden");
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

  // score using names (not P1/P2)
  scoreLine.textContent = `${playerName("PLAYER1")} ${state.scores.PLAYER1} • ${playerName("PLAYER2")} ${state.scores.PLAYER2}`;

  // crib line uses dealer as crib owner (crib belongs to dealer)
  cribLine.textContent = `Crib (${playerName(state.dealer)}) • Discards: ${playerName("PLAYER1")} ${state.discardsCount.PLAYER1}/2  ${playerName("PLAYER2")} ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderMatch();
  renderPileAndHud();
  renderShow();
  showWinnerOverlayIfNeeded();

  // buttons
  goBtn.style.display = "none";
  nextHandBtn.style.display = "none";
  goBtn.onclick = null;
  nextHandBtn.onclick = null;

  handArea.innerHTML = "";

  // lock gameplay if game is over
  const locked = state.gameOver || state.matchOver;

  // STAGES
  if (state.stage === "lobby") {
    handTitle.textContent = "Waiting…";
    handHelp.textContent = "Open the same table code on another device for 2-player (or enable Play vs AI at Set Sail).";
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");

    const cribOwner = playerName(state.dealer);
    handTitle.textContent = "Discard";
    handHelp.textContent = `Select 2 cards to send to ${cribOwner}’s crib. (Auto-sends on 2.)`;

    const myHand = state.myHand || [];

    myHand.forEach(card => {
      const selected = selectedForDiscard.has(card.id);
      const btn = makeCardButton(card, {
        selected,
        disabled: locked,
        onClick: () => {
          if (locked) return;

          if (selected) selectedForDiscard.delete(card.id);
          else {
            if (selectedForDiscard.size >= 2) return;
            selectedForDiscard.add(card.id);
          }

          // Auto-send when 2 selected
          if (selectedForDiscard.size === 2) {
            socket.emit("discard_to_crib", { cardIds: Array.from(selectedForDiscard) });
            selectedForDiscard.clear();
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
      const playable = !locked && myTurn && (count + cardValue(card.rank) <= 31);
      const btn = makeCardButton(card, {
        disabled: !playable,
        onClick: () => socket.emit("play_card", { cardId: card.id })
      });
      handArea.appendChild(btn);
    });

    const canPlay = myHand.some(c => count + cardValue(c.rank) <= 31);

    // GO only when it can work
    if (!locked && myTurn && myHand.length > 0 && !canPlay) {
      goBtn.style.display = "inline-block";
      goBtn.onclick = () => socket.emit("go");
    }

    return;
  }

  if (state.stage === "show") {
    handTitle.textContent = "Show";
    handHelp.textContent = locked ? "Game over." : "Review scoring. Click Next Hand when ready.";

    // next hand only if not locked
    if (!locked) {
      nextHandBtn.style.display = "inline-block";
      nextHandBtn.onclick = () => socket.emit("next_hand");
    }

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
  const vsAI = !!vsAiCheck?.checked;

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

// Winner overlay buttons
nextGameBtn.onclick = () => socket.emit("next_game");
newMatchBtn.onclick = () => socket.emit("new_match");
crewNewMatchBtn.onclick = () => socket.emit("new_match");

socket.on("connect", () => {
  // intentionally idle until Set Sail
});

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));
