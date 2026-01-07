// public/js/app.js
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

// Game over modal
const gameModal = el("gameModal");
const gameModalText = el("gameModalText");
const gameModalNext = el("gameModalNext");
const gameModalNewMatch = el("gameModalNewMatch");

/* ===================== STATE ===================== */

let state = null;
let lastGoSeenTs = 0;
let lastGameOverShownKey = "";

/* ===================== PEGGING SCORE QUEUE ===================== */

const PEG_SCORE_MIN_MS = 1500;
let pegScoreQueue = [];
let pegScoreTimer = null;
let pegScoreActiveUntil = 0;
let lastPegSig = "";

function pegSig(ev, s) {
  const r = (ev?.reasons || []).join("|");
  return `${ev?.player}|${ev?.pts}|${r}|${s?.peg?.count}|${s?.peg?.pile?.length}|${s?.scores?.PLAYER1}|${s?.scores?.PLAYER2}`;
}

function resetPegQueue() {
  pegScoreQueue = [];
  lastPegSig = "";
  if (pegScoreTimer) clearTimeout(pegScoreTimer);
  pegScoreTimer = null;
  lastScore?.classList.add("hidden");
}

function enqueuePegScore(s) {
  const ev = s.lastPegEvent;
  if (!ev || !ev.pts) return;

  const sig = pegSig(ev, s);
  if (sig === lastPegSig) return;
  lastPegSig = sig;

  const who = ev.player === s.me ? "You" : "Opponent";
  pegScoreQueue.push(`${who} scored +${ev.pts} (${ev.reasons.join(", ")})`);

  drainPegQueue();
}

function drainPegQueue() {
  if (pegScoreTimer) return;

  const tick = () => {
    if (!state || state.stage !== "pegging") {
      resetPegQueue();
      return;
    }

    const now = Date.now();
    if (now < pegScoreActiveUntil) {
      pegScoreTimer = setTimeout(tick, pegScoreActiveUntil - now);
      return;
    }

    if (!pegScoreQueue.length) {
      lastScore?.classList.add("hidden");
      pegScoreTimer = null;
      return;
    }

    lastScore.textContent = pegScoreQueue.shift();
    lastScore.classList.remove("hidden");
    pegScoreActiveUntil = Date.now() + PEG_SCORE_MIN_MS;
    pegScoreTimer = setTimeout(tick, PEG_SCORE_MIN_MS);
  };

  tick();
}

/* ===================== HELPERS ===================== */

function cardValue(r) {
  if (r === "A") return 1;
  if (["K", "Q", "J"].includes(r)) return 10;
  return parseInt(r, 10);
}

function suitClass(s) {
  return s === "♥" || s === "♦" ? "red" : "black";
}

function makeCardButton(card, opts = {}) {
  const b = document.createElement("button");
  b.className = `cardBtn ${suitClass(card.suit)}`;
  if (opts.disabled) b.disabled = true;
  b.onclick = opts.onClick || null;

  b.innerHTML = `
    <div class="corner">${card.rank}</div>
    <div class="suitBig">${card.suit}</div>
    <div class="corner bottom">${card.rank}</div>
  `;
  return b;
}

function playerName(p) {
  return state?.players?.[p] || p;
}

/* ===================== RENDER ===================== */

function render() {
  if (!state) return;

  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${playerName(state.me)}`;

  const p1 = playerName("PLAYER1");
  const p2 = playerName("PLAYER2");

  playersLine.textContent = `Players: ${p1} vs ${p2}`;
  stageLine.textContent = `Stage: ${state.stage}`;
  dealerLine.textContent = `Dealer: ${playerName(state.dealer)}`;
  turnLine.textContent = `Turn: ${playerName(state.turn)}`;

  scoreLine.textContent = `${p1} ${state.scores.PLAYER1} • ${p2} ${state.scores.PLAYER2}`;
  matchLine.textContent = `Match (best of 3): ${p1} ${state.matchWins.PLAYER1} • ${p2} ${state.matchWins.PLAYER2}`;
  cribLine.textContent = `Crib (${playerName(state.dealer)})`;

  handArea.innerHTML = "";
  peggingStatus.textContent = "";

  /* ---------- DISCARD STAGE ---------- */
  if (state.stage === "discard") {
    const cribOwner = playerName(state.dealer);
    const myDiscarded = state.discardsCount[state.me];

    handTitle.textContent = "Discard";
    handHelp.textContent = "";

    if (myDiscarded < 2) {
      peggingStatus.innerHTML = `
        <div style="
          font-weight:900;
          font-size:28px;
          line-height:1.1;
          color:#ff4d2e;
          text-shadow:0 2px 10px rgba(0,0,0,.65);
        ">
          Tap two cards to discard to ${cribOwner}'s crib
        </div>
      `;
    }

    state.myHand.forEach(c => {
      handArea.appendChild(
        makeCardButton(c, { onClick: () => socket.emit("discard_one", { cardId: c.id }) })
      );
    });
    return;
  }

  /* ---------- PEGGING ---------- */
  if (state.stage === "pegging") {
    handTitle.textContent = "Pegging";
    handHelp.textContent = "Play a card without exceeding 31.";

    const myTurn = state.turn === state.me;
    const count = state.peg.count;

    state.myHand.forEach(c => {
      const playable = myTurn && count + cardValue(c.rank) <= 31;
      handArea.appendChild(
        makeCardButton(c, {
          disabled: !playable,
          onClick: () => socket.emit("play_card", { cardId: c.id })
        })
      );
    });

    enqueuePegScore(state);
    return;
  }

  /* ---------- SHOW ---------- */
  if (state.stage === "show") {
    handTitle.textContent = "Show";
    handHelp.textContent = "See scoring below.";

    nextHandBtn.style.display = "inline-block";
    nextHandBtn.onclick = () => socket.emit("next_hand");

    return;
  }
}

/* ===================== SOCKET ===================== */

socket.on("state", s => {
  state = s;
  render();
});

socket.on("error_msg", msg => {
  entryHint.textContent = msg;
});