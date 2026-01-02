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

// Match area
const matchLine = el("matchLine");
const p1Name = el("p1Name");
const p2Name = el("p2Name");
const p1Wins = el("p1Wins");
const p2Wins = el("p2Wins");
const nextGameBtn = el("nextGameBtn");
const newMatchBtn = el("newMatchBtn");

// Play panel
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
const discardBtn = el("discardBtn");
const goBtn = el("goBtn");
const nextHandBtn = el("nextHandBtn");

// Pegging HUD
const pileArea = el("pileArea");
const countNum = el("countNum");
const peggingStatus = el("peggingStatus");
const lastScore = el("lastScore");

// Obvious action banner
const actionBanner = el("actionBanner");

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
const nameJoinBtn = el("nameJoinBtn");
const aiToggle = el("aiToggle");

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

function nameOf(playerId) {
  if (!state) return playerId;
  const nm = state.players?.[playerId];
  if (nm) return nm;
  return state.names?.[playerId] || playerId;
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
  const w1 = state.matchWins?.PLAYER1 ?? 0;
  const w2 = state.matchWins?.PLAYER2 ?? 0;
  const target = state.matchTarget ?? 3;

  p1Name.textContent = state.players.PLAYER1 || "P1";
  p2Name.textContent = state.players.PLAYER2 || "P2";
  matchLine.textContent = `${w1} – ${w2} (first to ${target})`;

  const makePips = (root, n) => {
    root.innerHTML = "";
    for (let i = 0; i < target; i++) {
      const d = document.createElement("span");
      d.className = "pip" + (i < n ? " on" : "");
      root.appendChild(d);
    }
  };

  makePips(p1Wins, w1);
  makePips(p2Wins, w2);

  if (state.gameOver && !state.matchOver) {
    nextGameBtn.style.display = "inline-block";
    nextGameBtn.onclick = () => socket.emit("next_game");
  } else {
    nextGameBtn.style.display = "none";
  }

  newMatchBtn.onclick = () => socket.emit("new_match");
}

function renderActionBanner() {
  if (!actionBanner) return;

  actionBanner.classList.add("hidden");
  actionBanner.textContent = "";

  const a = state?.lastAction;
  if (!a || !a.type) return;

  if (a.type === "go") {
    const who = (a.player === state.me) ? "You" : "Opponent";
    actionBanner.textContent = `🛑 ${who} says GO!`;
    actionBanner.classList.remove("hidden");
    return;
  }

  if (a.type === "reset") {
    actionBanner.textContent = `⚓ ${a.text || "Count resets to 0."}`;
    actionBanner.classList.remove("hidden");
    return;
  }
}

function renderPileAndHud() {
  if (!state) return;

  countNum.textContent = String(state.peg?.count ?? 0);

  pileArea.innerHTML = "";
  const pile = state.peg?.pile || [];
  const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
  for (const c of show) pileArea.appendChild(makeCardButton(c, { disabled: true }));

  if (state.stage !== "pegging") {
    peggingStatus.textContent = "";
    lastScore.classList.add("hidden");
    return;
  }

  const myTurn = state.turn === state.me;
  const mine = state.myHandCount ?? 0;
  const opp = state.oppHandCount ?? 0;

  peggingStatus.textContent =
    `${myTurn ? "Your turn" : "Opponent’s turn"} • You: ${mine} card(s) • Opponent: ${opp} card(s)`;

  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
    lastScore.classList.remove("hidden");
  } else {
    lastScore.classList.add("hidden");
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

  ndTitle.textContent = `Non-dealer
