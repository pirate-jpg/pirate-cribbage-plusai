// server.js
"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http."use strict";

const path = require("path");
const express = require("express");
const http = require("http");                // ✅ fixes: ReferenceError: http is not defined
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/**
 * TABLE STATE MODEL (what we emit to clients):
 * {
 *  tableId, stage, dealer, turn,
 *  players: { PLAYER1: "name", PLAYER2: "name" },
 *  scores: { PLAYER1: n, PLAYER2: n },
 *  matchWins: { PLAYER1: n, PLAYER2: n },
 *  matchOver: bool, matchWinner: "PLAYER1"|"PLAYER2"|null,
 *  gameOver: bool, gameWinner: "PLAYER1"|"PLAYER2"|null,
 *  discardsCount: { PLAYER1: 0..2, PLAYER2: 0..2 },
 *  peg: { count, pile, passed, lastPlayer, pendingReset, resetToken },
 *  lastPegEvent: { player, pts, reasons } | null
 *  lastGoEvent:  { player, ts } | null
 *  show: { cut, dealer, nonDealer, hand: {PLAYER1:{cards,breakdown}, PLAYER2:{...}}, crib:{cards,breakdown} } | null
 * }
 */

const tables = new Map(); // tableId -> table

function otherPlayer(p) {
  return p === "PLAYER1" ? "PLAYER2" : "PLAYER1";
}

// ---------- Cards / Deck ----------
const SUITS = ["♣", "♦", "♥", "♠"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function cardValue(rank) {
  if (rank === "A") return 1;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return parseInt(rank, 10);
}
function rankOrder(rank) {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return parseInt(rank, 10);
}
function makeDeck() {
  let id = 1;
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: String(id++), rank: r, suit: s });
    }
  }
  return deck;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Scoring helpers ----------
function combinations(arr, k) {
  const out = [];
  function rec(start, comb) {
    if (comb.length === k) { out.push(comb.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      comb.push(arr[i]);
      rec(i + 1, comb);
      comb.pop();
    }
  }
  rec(0, []);
  return out;
}

function score15s(cards) {
  let pts = 0;
  const vals = cards.map(c => cardValue(c.rank));
  for (let k = 2; k <= cards.length; k++) {
    for (const idxs of combinations([...Array(cards.length).keys()], k)) {
      const sum = idxs.reduce((s, i) => s + vals[i], 0);
      if (sum === 15) pts += 2;
    }
  }
  return pts;
}

function scorePairs(cards) {
  let pts = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i].rank === cards[j].rank) pts += 2;
    }
  }
  return pts;
}

function scoreRuns(cards) {
  const ord = cards.map(c => rankOrder(c.rank));
  let best = 0;

  for (let size = 3; size <= 5; size++) {
    let runPts = 0;
    const subs = combinations([...Array(cards.length).keys()], size);
    for (const idxs of subs) {
      const vals = idxs.map(i => ord[i]).sort((a,b)=>a-b);
      let ok = true;
      for (let k = 1; k < vals.length; k++) {
        if (vals[k] !== vals[k-1] + 1) { ok = false; break; }
      }
      if (ok) runPts += size;
    }
    best = Math.max(best, runPts);
  }
  return best;
}

function scoreFlush(hand4, cut, isCrib) {
  const suit = hand4[0].suit;
  const all4 = hand4.every(c => c.suit === suit);
  if (!all4) return 0;
  const five = cut && cut.suit === suit;
  if (isCrib) return five ? 5 : 0;
  return five ? 5 : 4;
}

function scoreNobs(hand4, cut) {
  for (const c of hand4) {
    if (c.rank === "J" && cut && c.suit === cut.suit) return 1;
  }
  return 0;
}

function scoreHandWithBreakdown(hand4, cut, isCrib = false) {
  const cards5 = hand4.concat([cut]);
  const items = [];

  const p15 = score15s(cards5);
  if (p15) items.push({ label: "15s", pts: p15 });

  const pp = scorePairs(cards5);
  if (pp) items.push({ label: "Pairs", pts: pp });

  const pr = scoreRuns(cards5);
  if (pr) items.push({ label: "Runs", pts: pr });

  const pf = scoreFlush(hand4, cut, isCrib);
  if (pf) items.push({ label: "Flush", pts: pf });

  const pn = scoreNobs(hand4, cut);
  if (pn) items.push({ label: "Nobs", pts: pn });

  const total = items.reduce((s, x) => s + x.pts, 0);
  return { items, total };
}

// Pegging scoring (15/31, pairs, runs)
function scorePegPlay(pile, newCard, newCount) {
  const reasons = [];
  let pts = 0;

  if (newCount === 15) { pts += 2; reasons.push("15"); }
  if (newCount === 31) { pts += 2; reasons.push("31"); }

  const seq = pile.concat([newCard]);
  let same = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i].rank === newCard.rank) same++;
    else break;
  }
  if (same === 2) { pts += 2; reasons.push("pair"); }
  if (same === 3) { pts += 6; reasons.push("3 of a kind"); }
  if (same === 4) { pts += 12; reasons.push("4 of a kind"); }

  let runPts = 0;
  for (let n = Math.min(7, seq.length); n >= 3; n--) {
    const tail = seq.slice(seq.length - n);
    const vals = tail.map(c => rankOrder(c.rank)).slice().sort((a,b)=>a-b);
    let dup = false;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i-1]) { dup = true; break; }
    }
    if (dup) continue;
    let ok = true;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] !== vals[i-1] + 1) { ok = false; break; }
    }
    if (ok) { runPts = n; break; }
  }
  if (runPts) { pts += runPts; reasons.push(`run ${runPts}`); }

  return { pts, reasons };
}

// ---------- Timing knobs ----------
const AI_THINK_MS = 900;         // ✅ “tad longer” than before
const PEG_RESET_DELAY_MS = 850;  // ✅ lets you see 31 before count snaps to 0

// ---------- Table lifecycle ----------
function makeTable(tableId) {
  return {
    tableId,
    ai: { enabled: false, aiPlayer: "PLAYER2" }, // default AI is PLAYER2
    stage: "lobby",
    dealer: "PLAYER1",
    turn: "PLAYER1",
    players: { PLAYER1: null, PLAYER2: null },
    sockets: { PLAYER1: null, PLAYER2: null },
    scores: { PLAYER1: 0, PLAYER2: 0 },
    matchWins: { PLAYER1: 0, PLAYER2: 0 },
    matchOver: false,
    matchWinner: null,
    gameOver: false,
    gameWinner: null,
    discardsCount: { PLAYER1: 0, PLAYER2: 0 },

    deck: [],
    hands: { PLAYER1: [], PLAYER2: [] },      // keep for show
    pegHands: { PLAYER1: [], PLAYER2: [] },   // consumed in pegging
    crib: [],
    cut: null,

    peg: {
      count: 0,
      pile: [],
      passed: { PLAYER1: false, PLAYER2: false },
      lastPlayer: null,
      pendingReset: false,
      resetToken: "",
    },

    lastPegEvent: null,
    lastGoEvent: null,

    show: null,

    aiTimer: null, // ✅ paced AI
  };
}

function getOrCreateTable(tableId) {
  if (!tables.has(tableId)) tables.set(tableId, makeTable(tableId));
  return tables.get(tableId);
}

function resetForNewGame(t) {
  t.scores = { PLAYER1: 0, PLAYER2: 0 };
  t.gameOver = false;
  t.gameWinner = null;
  t.show = null;
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  t.discardsCount = { PLAYER1: 0, PLAYER2: 0 };
  t.hands = { PLAYER1: [], PLAYER2: [] };
  t.pegHands = { PLAYER1: [], PLAYER2: [] };
  t.crib = [];
  t.cut = null;

  t.peg = { count: 0, pile: [], passed: { PLAYER1: false, PLAYER2: false }, lastPlayer: null, pendingReset: false, resetToken: "" };

  // alternate dealer for fairness
  t.dealer = otherPlayer(t.dealer);
  t.turn = t.dealer;

  t.stage = "lobby";
}

function resetForNewMatch(t) {
  t.matchWins = { PLAYER1: 0, PLAYER2: 0 };
  t.matchOver = false;
  t.matchWinner = null;
  t.dealer = "PLAYER1";
  resetForNewGame(t);
}

function bothPlayersReady(t) {
  return !!t.players.PLAYER1 && !!t.players.PLAYER2;
}

function dealHand(t) {
  t.deck = shuffle(makeDeck());
  t.crib = [];
  t.cut = null;

  t.discardsCount = { PLAYER1: 0, PLAYER2: 0 };

  t.hands.PLAYER1 = t.deck.splice(0, 6);
  t.hands.PLAYER2 = t.deck.splice(0, 6);
  t.pegHands.PLAYER1 = [];
  t.pegHands.PLAYER2 = [];

  t.stage = "discard";
  t.turn = otherPlayer(t.dealer);
  t.peg = { count: 0, pile: [], passed: { PLAYER1: false, PLAYER2: false }, lastPlayer: null, pendingReset: false, resetToken: "" };
  t.lastPegEvent = null;
  t.lastGoEvent = null;
  t.show = null;

  // paced AI will discard on its scheduled step
}

function startHandIfPossible(t) {
  if (!bothPlayersReady(t)) return;
  if (t.matchOver || t.gameOver) return;
  dealHand(t);
}

function emitStateToTable(t) {
  const base = {
    tableId: t.tableId,
    stage: t.stage,
    dealer: t.dealer,
    turn: t.turn,
    players: { ...t.players },
    scores: { ...t.scores },
    matchWins: { ...t.matchWins },
    matchOver: t.matchOver,
    matchWinner: t.matchWinner,
    gameOver: t.gameOver,
    gameWinner: t.gameWinner,
    discardsCount: { ...t.discardsCount },
    cut: t.cut,
    peg: t.peg,
    lastPegEvent: t.lastPegEvent,
    lastGoEvent: t.lastGoEvent,
    show: t.show,
  };

  for (const p of ["PLAYER1", "PLAYER2"]) {
    const sid = t.sockets[p];
    if (!sid) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;

    sock.emit("state", {
      ...base,
      me: p,
      myHand:
        t.stage === "pegging"
          ? t.pegHands[p]
          : t.hands[p],
    });
  }
}

// ---------- AI (paced, not instantaneous) ----------
function aiChooseDiscard(hand6) {
  const sorted = [...hand6].sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
  return [sorted[0], sorted[1]];
}

function aiChoosePegCard(hand, count) {
  const playable = hand.filter(c => count + cardValue(c.rank) <= 31);
  if (!playable.length) return null;
  playable.sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
  return playable[0];
}

function scheduleAi(t) {
  if (!t.ai.enabled) return;
  if (t.aiTimer) return; // already scheduled

  t.aiTimer = setTimeout(() => {
    t.aiTimer = null;
    aiStep(t);
  }, AI_THINK_MS);
}

function aiStep(t) {
  if (!t.ai.enabled) return;
  if (t.matchOver || t.gameOver) return;

  const ap = t.ai.aiPlayer;

  // If pegging reset is pending (31), AI must wait.
  if (t.stage === "pegging" && t.peg.pendingReset) return;

  let didSomething = false;

  if (t.stage === "discard") {
    didSomething = aiDoDiscardIfNeeded(t);

    // If both done, begin pegging.
    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
      didSomething = true;
    }
  } else if (t.stage === "pegging" && t.turn === ap) {
    const count = t.peg.count;
    const card = aiChoosePegCard(t.pegHands[ap], count);
    if (card) {
      didSomething = internalPlayCard(t, ap, card.id);
    } else {
      didSomething = internalGo(t, ap);
    }
  }

  emitStateToTable(t);

  // If AI can/should continue (e.g., discard twice, or respond to resets), schedule again.
  if (t.ai.enabled && didSomething) {
    // Continue only if AI still has an immediate reason to act:
    const stillNeedsDiscard = (t.stage === "discard" && t.discardsCount[ap] < 2);
    const stillMyTurnPeg = (t.stage === "pegging" && t.turn === ap);
    if (stillNeedsDiscard || stillMyTurnPeg) scheduleAi(t);
  }
}

function aiDoDiscardIfNeeded(t) {
  if (!t.ai.enabled) return false;
  const ap = t.ai.aiPlayer;

  if (t.stage !== "discard") return false;
  if (t.discardsCount[ap] >= 2) return false;

  const needed = 2 - t.discardsCount[ap];
  if (needed <= 0) return false;

  const hand = t.hands[ap];
  if (hand.length < needed) return false;

  const picks = aiChooseDiscard(hand).slice(0, needed);
  let did = false;
  for (const c of picks) {
    if (internalDiscardOne(t, ap, c.id)) did = true;
  }
  return did;
}

// ---------- Discard / Pegging / Show ----------
function internalDiscardOne(t, player, cardId) {
  if (t.stage !== "discard") return false;
  if (t.gameOver || t.matchOver) return false;
  if (t.discardsCount[player] >= 2) return false;

  const hand = t.hands[player];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  const [card] = hand.splice(idx, 1);
  t.crib.push(card);
  t.discardsCount[player] += 1;
  return true;
}

function beginPegging(t) {
  t.pegHands.PLAYER1 = t.hands.PLAYER1.map(c => ({ ...c }));
  t.pegHands.PLAYER2 = t.hands.PLAYER2.map(c => ({ ...c }));

  t.cut = t.deck.splice(0, 1)[0];
  if (t.cut.rank === "J") {
    t.scores[t.dealer] += 2;
  }

  t.peg = {
    count: 0,
    pile: [],
    passed: { PLAYER1: false, PLAYER2: false },
    lastPlayer: null,
    pendingReset: false,
    resetToken: "",
  };
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  t.stage = "pegging";
  t.turn = otherPlayer(t.dealer);
}

function playableExists(hand, count) {
  return hand.some(c => count + cardValue(c.rank) <= 31);
}

function finalizePeggingIfDone(t) {
  const done = t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0;
  if (!done) return false;

  // ✅ last card point (only if the final count was not 31)
  if (t.peg.count !== 0 && t.peg.count !== 31 && t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
    t.lastPegEvent = { player: t.peg.lastPlayer, pts: 1, reasons: ["last card"] };
  }

  // Clear pegging pile/count as we exit pegging
  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.passed = { PLAYER1: false, PLAYER2: false };
  t.peg.pendingReset = false;
  t.peg.resetToken = "";

  return true;
}

function maybeAdvanceToShow(t) {
  const done = t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0;
  if (!done) return false;

  const nd = otherPlayer(t.dealer);
  const de = t.dealer;

  const ndHand4 = t.hands[nd];
  const deHand4 = t.hands[de];
  const crib4 = t.crib;

  const ndBreak = scoreHandWithBreakdown(ndHand4, t.cut, false);
  const deBreak = scoreHandWithBreakdown(deHand4, t.cut, false);
  const crBreak = scoreHandWithBreakdown(crib4, t.cut, true);

  t.scores[nd] += ndBreak.total;
  t.scores[de] += deBreak.total;
  t.scores[de] += crBreak.total;

  t.show = {
    cut: t.cut,
    dealer: de,
    nonDealer: nd,
    hand: {
      [nd]: { cards: ndHand4, breakdown: ndBreak },
      [de]: { cards: deHand4, breakdown: deBreak },
    },
    crib: { cards: crib4, breakdown: crBreak },
  };

  t.stage = "show";
  t.turn = t.dealer;

  return true;
}

function maybeEndGameOrMatch(t) {
  // ✅ CRITICAL FIX: don’t increment matchWins repeatedly
  if (t.gameOver || t.matchOver) return false;

  const p1 = t.scores.PLAYER1;
  const p2 = t.scores.PLAYER2;
  if (p1 < 121 && p2 < 121) return false;

  t.gameOver = true;
  t.gameWinner =
    p1 >= 121 && p2 >= 121
      ? (p1 >= p2 ? "PLAYER1" : "PLAYER2")
      : (p1 >= 121 ? "PLAYER1" : "PLAYER2");

  t.matchWins[t.gameWinner] += 1;

  if (t.matchWins[t.gameWinner] >= 2) {
    t.matchOver = true;
    t.matchWinner = t.gameWinner;
  }

  return true;
}

function schedulePegResetIf31(t) {
  // When count hits 31, we want players to SEE it briefly.
  // So we keep count at 31, then reset after PEG_RESET_DELAY_MS.
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  t.peg.pendingReset = true;
  t.peg.resetToken = token;

  setTimeout(() => {
    // Only reset if nothing else has moved us out of pegging
    if (t.stage !== "pegging") return;
    if (!t.peg.pendingReset) return;
    if (t.peg.resetToken !== token) return;

    // Reset count/pile, next turn should start from opponent of lastPlayer
    t.peg.pendingReset = false;
    t.peg.resetToken = "";

    t.peg.count = 0;
    t.peg.pile = [];
    t.peg.passed = { PLAYER1: false, PLAYER2: false };
    if (t.peg.lastPlayer) t.turn = otherPlayer(t.peg.lastPlayer);

    // If hands are empty at this moment, finish pegging -> show.
    finalizePeggingIfDone(t);
    maybeAdvanceToShow(t);
    maybeEndGameOrMatch(t);

    emitStateToTable(t);
    scheduleAi(t);
  }, PEG_RESET_DELAY_MS);
}

function maybeEndCountAndReset(t) {
  // Standard reset when both say GO or nobody can play (not when 31: that’s delayed now)
  const p1Has = t.pegHands.PLAYER1.length > 0;
  const p2Has = t.pegHands.PLAYER2.length > 0;
  const anyCards = p1Has || p2Has;

  const p1Can = p1Has && playableExists(t.pegHands.PLAYER1, t.peg.count);
  const p2Can = p2Has && playableExists(t.pegHands.PLAYER2, t.peg.count);

  const bothPassed = t.peg.passed.PLAYER1 && t.peg.passed.PLAYER2;
  const nobodyCanPlay = anyCards && !p1Can && !p2Can;

  if (!(bothPassed || nobodyCanPlay)) return false;

  // last card for this count (not 31)
  if (t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
    t.lastPegEvent = { player: t.peg.lastPlayer, pts: 1, reasons: ["last card"] };
  }

  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.passed = { PLAYER1: false, PLAYER2: false };
  if (t.peg.lastPlayer) t.turn = otherPlayer(t.peg.lastPlayer);

  return true;
}

function internalPlayCard(t, player, cardId) {
  if (t.stage !== "pegging") return false;
  if (t.turn !== player) return false;
  if (t.gameOver || t.matchOver) return false;

  // If a 31 reset is pending, nobody can play during the pause.
  if (t.peg.pendingReset) return false;

  const hand = t.pegHands[player];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  const card = hand[idx];
  const val = cardValue(card.rank);
  if (t.peg.count + val > 31) return false;

  hand.splice(idx, 1);
  const newCount = t.peg.count + val;

  const { pts, reasons } = scorePegPlay(t.peg.pile, card, newCount);
  t.lastPegEvent = { player, pts: pts || 0, reasons: reasons || [] };
  if (pts > 0) t.scores[player] += pts;

  t.peg.count = newCount;
  t.peg.pile.push(card);
  t.peg.lastPlayer = player;
  t.peg.passed[player] = false;

  // If everyone is out of cards now, finalize pegging and go to show
  finalizePeggingIfDone(t);
  if (maybeAdvanceToShow(t)) {
    maybeEndGameOrMatch(t);
    return true;
  }

  if (t.peg.count === 31) {
    // ✅ Delay reset so user can see "31"
    schedulePegResetIf31(t);
    // Turn will be set after reset; keep it as-is for the moment.
  } else {
    // Normal flow: swap turn
    t.turn = otherPlayer(player);

    // If next player cannot play AND has no cards OR cannot play at all, they must say GO;
    // we don't auto-GO them for humans; but for AI we schedule.
    maybeEndCountAndReset(t);
  }

  maybeEndGameOrMatch(t);
  return true;
}

function internalGo(t, player) {
  if (t.stage !== "pegging") return false;
  if (t.turn !== player) return false;
  if (t.gameOver || t.matchOver) return false;

  // If a 31 reset is pending, ignore GO until reset completes
  if (t.peg.pendingReset) return false;

  const hand = t.pegHands[player];
  if (hand.length > 0 && playableExists(hand, t.peg.count)) return false;

  t.peg.passed[player] = true;
  t.lastGoEvent = { player, ts: Date.now() };

  t.turn = otherPlayer(player);

  maybeEndCountAndReset(t);

  // If both hands empty after GO logic, finish pegging -> show
  finalizePeggingIfDone(t);
  maybeAdvanceToShow(t);
  maybeEndGameOrMatch(t);

  return true;
}

// ---------- Join helpers ----------
function normalizeTableId(raw) {
  return String(raw || "").trim().slice(0, 24);
}
function normalizeName(raw) {
  return String(raw || "").trim().slice(0, 16);
}
function makeAiTableId() {
  return `AI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 24);
}
function seatForRejoin(t, nm) {
  if (t.players.PLAYER1 === nm && !t.sockets.PLAYER1) return "PLAYER1";
  if (t.players.PLAYER2 === nm && !t.sockets.PLAYER2) return "PLAYER2";
  return null;
}
function firstOpenSeatByName(t) {
  if (!t.players.PLAYER1) return "PLAYER1";
  if (!t.players.PLAYER2) return "PLAYER2";
  return null;
}

// ---------- socket.io ----------
io.on("connection", (socket) => {
  socket.on("join_table", ({ tableId, name, vsAI } = {}) => {
    const nm = normalizeName(name);
    const wantsAI = !!vsAI;

    if (!nm) return socket.emit("error_msg", "Enter a name.");

    const tid = wantsAI ? makeAiTableId() : normalizeTableId(tableId);

    if (!wantsAI && !tid) {
      return socket.emit("error_msg", "Enter a table code.");
    }

    const t = getOrCreateTable(tid);

    // Configure AI if requested
    if (wantsAI) {
      t.ai.enabled = true;
      t.players.PLAYER2 = "AI Captain";
      t.sockets.PLAYER2 = null;
    } else {
      t.ai.enabled = false;
      if (t.players.PLAYER2 === "AI Captain") {
        t.players.PLAYER2 = null;
        t.sockets.PLAYER2 = null;
      }
    }

    let slot = seatForRejoin(t, nm);
    if (!slot) slot = firstOpenSeatByName(t);

    if (wantsAI) slot = "PLAYER1";
    if (!slot) return socket.emit("error_msg", "Table full.");
    if (wantsAI && slot === "PLAYER2") return socket.emit("error_msg", "Table full.");

    t.players[slot] = nm;
    t.sockets[slot] = socket.id;

    socket.join(tid);

    // If rejoining a table that ended
    if (t.matchOver) resetForNewMatch(t);
    if (t.gameOver) resetForNewGame(t);

    startHandIfPossible(t);

    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("discard_one", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    const ok = internalDiscardOne(t, p, String(cardId));
    if (!ok) { emitStateToTable(t); return; }

    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
    }

    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("discard_to_crib", ({ cardIds } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    if (!Array.isArray(cardIds)) return;
    for (const id of cardIds.slice(0, 2)) internalDiscardOne(t, p, String(id));

    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) beginPegging(t);

    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("play_card", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    internalPlayCard(t, p, String(cardId));
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("go", () => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    internalGo(t, p);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("next_hand", () => {
    const { t } = findTableAndPlayerBySocket(socket.id);
    if (!t) return;

    if (t.matchOver) {
      emitStateToTable(t);
      return;
    }

    if (t.gameOver) {
      resetForNewGame(t);
    }

    startHandIfPossible(t);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("new_match", () => {
    const { t } = findTableAndPlayerBySocket(socket.id);
    if (!t) return;

    resetForNewMatch(t);
    startHandIfPossible(t);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("disconnect", () => {
    for (const t of tables.values()) {
      for (const p of ["PLAYER1", "PLAYER2"]) {
        if (t.sockets[p] === socket.id) {
          t.sockets[p] = null;
        }
      }
    }
  });
});

function findTableAndPlayerBySocket(socketId) {
  for (const t of tables.values()) {
    for (const p of ["PLAYER1", "PLAYER2"]) {
      if (t.sockets[p] === socketId) return { t, p };
    }
  }
  return { t: null, p: null };
}

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ✅ Tune AI pacing here (ms)
const AI_DELAY_MS = 900;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/**
 * TABLE STATE MODEL (what we emit to clients):
 * {
 *  tableId, stage, dealer, turn,
 *  players: { PLAYER1: "name", PLAYER2: "name" },
 *  scores: { PLAYER1: n, PLAYER2: n },
 *  matchWins: { PLAYER1: n, PLAYER2: n },
 *  matchOver: bool, matchWinner: "PLAYER1"|"PLAYER2"|null,
 *  gameOver: bool, gameWinner: "PLAYER1"|"PLAYER2"|null,
 *  discardsCount: { PLAYER1: 0..2, PLAYER2: 0..2 },
 *  peg: { count, pile, passed, lastPlayer },
 *  lastPegEvent: { player, pts, reasons } | null
 *  lastGoEvent:  { player, ts } | null
 *  show: { cut, dealer, nonDealer, hand: {PLAYER1:{cards,breakdown}, PLAYER2:{...}}, crib:{cards,breakdown} } | null
 * }
 */

const tables = new Map(); // tableId -> table

function otherPlayer(p) {
  return p === "PLAYER1" ? "PLAYER2" : "PLAYER1";
}

// ---------- Cards / Deck ----------
const SUITS = ["♣", "♦", "♥", "♠"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function cardValue(rank) {
  if (rank === "A") return 1;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return parseInt(rank, 10);
}
function rankOrder(rank) {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return parseInt(rank, 10);
}
function makeDeck() {
  let id = 1;
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: String(id++), rank: r, suit: s });
    }
  }
  return deck;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Scoring helpers ----------
function combinations(arr, k) {
  const out = [];
  function rec(start, comb) {
    if (comb.length === k) { out.push(comb.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      comb.push(arr[i]);
      rec(i + 1, comb);
      comb.pop();
    }
  }
  rec(0, []);
  return out;
}

function score15s(cards) {
  let pts = 0;
  const vals = cards.map(c => cardValue(c.rank));
  for (let k = 2; k <= cards.length; k++) {
    for (const idxs of combinations([...Array(cards.length).keys()], k)) {
      const sum = idxs.reduce((s, i) => s + vals[i], 0);
      if (sum === 15) pts += 2;
    }
  }
  return pts;
}

function scorePairs(cards) {
  let pts = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i].rank === cards[j].rank) pts += 2;
    }
  }
  return pts;
}

function scoreRuns(cards) {
  const ord = cards.map(c => rankOrder(c.rank));
  let best = 0;

  for (let size = 3; size <= 5; size++) {
    let runPts = 0;
    const subs = combinations([...Array(cards.length).keys()], size);
    for (const idxs of subs) {
      const vals = idxs.map(i => ord[i]).sort((a,b)=>a-b);
      let ok = true;
      for (let k = 1; k < vals.length; k++) {
        if (vals[k] !== vals[k-1] + 1) { ok = false; break; }
      }
      if (ok) runPts += size;
    }
    best = Math.max(best, runPts);
  }
  return best;
}

function scoreFlush(hand4, cut, isCrib) {
  const suit = hand4[0].suit;
  const all4 = hand4.every(c => c.suit === suit);
  if (!all4) return 0;
  const five = cut && cut.suit === suit;
  if (isCrib) return five ? 5 : 0;
  return five ? 5 : 4;
}

function scoreNobs(hand4, cut) {
  for (const c of hand4) {
    if (c.rank === "J" && cut && c.suit === cut.suit) return 1;
  }
  return 0;
}

function scoreHandWithBreakdown(hand4, cut, isCrib = false) {
  const cards5 = hand4.concat([cut]);
  const items = [];

  const p15 = score15s(cards5);
  if (p15) items.push({ label: "15s", pts: p15 });

  const pp = scorePairs(cards5);
  if (pp) items.push({ label: "Pairs", pts: pp });

  const pr = scoreRuns(cards5);
  if (pr) items.push({ label: "Runs", pts: pr });

  const pf = scoreFlush(hand4, cut, isCrib);
  if (pf) items.push({ label: "Flush", pts: pf });

  const pn = scoreNobs(hand4, cut);
  if (pn) items.push({ label: "Nobs", pts: pn });

  const total = items.reduce((s, x) => s + x.pts, 0);
  return { items, total };
}

// Pegging scoring (15/31, pairs, runs)
function scorePegPlay(pile, newCard, newCount) {
  const reasons = [];
  let pts = 0;

  if (newCount === 15) { pts += 2; reasons.push("15"); }
  if (newCount === 31) { pts += 2; reasons.push("31"); }

  const seq = pile.concat([newCard]);
  let same = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i].rank === newCard.rank) same++;
    else break;
  }
  if (same === 2) { pts += 2; reasons.push("pair"); }
  if (same === 3) { pts += 6; reasons.push("3 of a kind"); }
  if (same === 4) { pts += 12; reasons.push("4 of a kind"); }

  let runPts = 0;
  for (let n = Math.min(7, seq.length); n >= 3; n--) {
    const tail = seq.slice(seq.length - n);
    const vals = tail.map(c => rankOrder(c.rank)).slice().sort((a,b)=>a-b);
    let dup = false;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i-1]) { dup = true; break; }
    }
    if (dup) continue;
    let ok = true;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] !== vals[i-1] + 1) { ok = false; break; }
    }
    if (ok) { runPts = n; break; }
  }
  if (runPts) { pts += runPts; reasons.push(`run ${runPts}`); }

  return { pts, reasons };
}

// ---------- Table lifecycle ----------
function makeTable(tableId) {
  return {
    tableId,
    ai: { enabled: false, aiPlayer: "PLAYER2" },
    aiTimer: null,

    stage: "lobby",
    dealer: "PLAYER1",
    turn: "PLAYER1",
    players: { PLAYER1: null, PLAYER2: null },
    sockets: { PLAYER1: null, PLAYER2: null },

    scores: { PLAYER1: 0, PLAYER2: 0 },
    matchWins: { PLAYER1: 0, PLAYER2: 0 },
    matchOver: false,
    matchWinner: null,
    gameOver: false,
    gameWinner: null,

    discardsCount: { PLAYER1: 0, PLAYER2: 0 },

    deck: [],
    hands: { PLAYER1: [], PLAYER2: [] },      // keep for show
    pegHands: { PLAYER1: [], PLAYER2: [] },   // consumed in pegging
    crib: [],
    cut: null,

    peg: {
      count: 0,
      pile: [],
      passed: { PLAYER1: false, PLAYER2: false },
      lastPlayer: null,
    },

    lastPegEvent: null,
    lastGoEvent: null,
    show: null,
  };
}

function getOrCreateTable(tableId) {
  if (!tables.has(tableId)) tables.set(tableId, makeTable(tableId));
  return tables.get(tableId);
}

function resetForNewGame(t) {
  t.scores = { PLAYER1: 0, PLAYER2: 0 };
  t.gameOver = false;
  t.gameWinner = null;
  t.show = null;
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  t.discardsCount = { PLAYER1: 0, PLAYER2: 0 };
  t.hands = { PLAYER1: [], PLAYER2: [] };
  t.pegHands = { PLAYER1: [], PLAYER2: [] };
  t.crib = [];
  t.cut = null;

  t.peg = { count: 0, pile: [], passed: { PLAYER1: false, PLAYER2: false }, lastPlayer: null };

  // alternate dealer for fairness
  t.dealer = otherPlayer(t.dealer);
  t.turn = t.dealer;

  t.stage = "lobby";
}

function resetForNewMatch(t) {
  t.matchWins = { PLAYER1: 0, PLAYER2: 0 };
  t.matchOver = false;
  t.matchWinner = null;
  t.dealer = "PLAYER1";
  resetForNewGame(t);
}

function bothPlayersReady(t) {
  return !!t.players.PLAYER1 && !!t.players.PLAYER2;
}

function dealHand(t) {
  t.deck = shuffle(makeDeck());
  t.crib = [];
  t.cut = null;

  t.discardsCount = { PLAYER1: 0, PLAYER2: 0 };

  t.hands.PLAYER1 = t.deck.splice(0, 6);
  t.hands.PLAYER2 = t.deck.splice(0, 6);
  t.pegHands.PLAYER1 = [];
  t.pegHands.PLAYER2 = [];

  t.stage = "discard";
  t.turn = otherPlayer(t.dealer);
  t.peg = { count: 0, pile: [], passed: { PLAYER1: false, PLAYER2: false }, lastPlayer: null };
  t.lastPegEvent = null;
  t.lastGoEvent = null;
  t.show = null;

  if (t.ai.enabled) aiDoDiscardIfNeeded(t);
}

function startHandIfPossible(t) {
  if (!bothPlayersReady(t)) return;
  if (t.matchOver || t.gameOver) return;
  dealHand(t);
}

function emitStateToTable(t) {
  const base = {
    tableId: t.tableId,
    stage: t.stage,
    dealer: t.dealer,
    turn: t.turn,
    players: { ...t.players },
    scores: { ...t.scores },
    matchWins: { ...t.matchWins },
    matchOver: t.matchOver,
    matchWinner: t.matchWinner,
    gameOver: t.gameOver,
    gameWinner: t.gameWinner,
    discardsCount: { ...t.discardsCount },
    cut: t.cut,
    peg: t.peg,
    lastPegEvent: t.lastPegEvent,
    lastGoEvent: t.lastGoEvent,
    show: t.show,
  };

  for (const p of ["PLAYER1", "PLAYER2"]) {
    const sid = t.sockets[p];
    if (!sid) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;

    sock.emit("state", {
      ...base,
      me: p,
      myHand: t.stage === "pegging" ? t.pegHands[p] : t.hands[p],
    });
  }
}

// ---------- AI ----------
function aiChooseDiscard(hand6) {
  const sorted = [...hand6].sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
  return [sorted[0], sorted[1]];
}

function aiChoosePegCard(hand, count) {
  const playable = hand.filter(c => count + cardValue(c.rank) <= 31);
  if (!playable.length) return null;
  playable.sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
  return playable[0];
}

function aiDoDiscardIfNeeded(t) {
  if (!t.ai.enabled) return false;
  const ap = t.ai.aiPlayer;

  if (t.stage !== "discard") return false;
  if (t.discardsCount[ap] >= 2) return false;

  const needed = 2 - t.discardsCount[ap];
  if (needed <= 0) return false;

  const hand = t.hands[ap];
  if (hand.length < needed) return false;

  const picks = aiChooseDiscard(hand).slice(0, needed);
  let did = false;
  for (const c of picks) {
    if (internalDiscardOne(t, ap, c.id)) did = true;
  }
  return did;
}

function aiDrain(t) {
  if (!t.ai.enabled) return;

  const ap = t.ai.aiPlayer;
  let guard = 0;

  while (guard++ < 40) {
    if (!t.ai.enabled) break;
    if (t.matchOver || t.gameOver) break;

    if (t.stage === "discard") {
      const didDiscard = aiDoDiscardIfNeeded(t);

      if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
        beginPegging(t);
        continue;
      }

      if (!didDiscard) break;
      continue;
    }

    if (t.stage === "pegging" && t.turn === ap) {
      const count = t.peg.count;
      const card = aiChoosePegCard(t.pegHands[ap], count);
      if (card) {
        const didPlay = internalPlayCard(t, ap, card.id);
        if (!didPlay) break;
        continue;
      } else {
        const didGo = internalGo(t, ap);
        if (!didGo) break;
        continue;
      }
    }

    break;
  }
}

function scheduleAi(t) {
  if (!t.ai.enabled) return;
  if (t.aiTimer) return; // already scheduled
  t.aiTimer = setTimeout(() => {
    t.aiTimer = null;
    aiDrain(t);
    emitStateToTable(t);
  }, AI_DELAY_MS);
}

// ---------- Discard / Pegging / Show ----------
function internalDiscardOne(t, player, cardId) {
  if (t.stage !== "discard") return false;
  if (t.gameOver || t.matchOver) return false;
  if (t.discardsCount[player] >= 2) return false;

  const hand = t.hands[player];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  const [card] = hand.splice(idx, 1);
  t.crib.push(card);
  t.discardsCount[player] += 1;
  return true;
}

function beginPegging(t) {
  t.pegHands.PLAYER1 = t.hands.PLAYER1.map(c => ({ ...c }));
  t.pegHands.PLAYER2 = t.hands.PLAYER2.map(c => ({ ...c }));

  t.cut = t.deck.splice(0, 1)[0];
  if (t.cut.rank === "J") {
    t.scores[t.dealer] += 2;
  }

  t.peg = {
    count: 0,
    pile: [],
    passed: { PLAYER1: false, PLAYER2: false },
    lastPlayer: null,
  };
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  t.stage = "pegging";
  t.turn = otherPlayer(t.dealer);
}

function playableExists(hand, count) {
  return hand.some(c => count + cardValue(c.rank) <= 31);
}

function maybeEndCountAndReset(t) {
  const p1Has = t.pegHands.PLAYER1.length > 0;
  const p2Has = t.pegHands.PLAYER2.length > 0;
  const anyCards = p1Has || p2Has;

  const p1Can = p1Has && playableExists(t.pegHands.PLAYER1, t.peg.count);
  const p2Can = p2Has && playableExists(t.pegHands.PLAYER2, t.peg.count);

  const bothPassed = t.peg.passed.PLAYER1 && t.peg.passed.PLAYER2;
  const nobodyCanPlay = anyCards && !p1Can && !p2Can;

  if (!(bothPassed || nobodyCanPlay || t.peg.count === 31)) return false;

  const lastP = t.peg.lastPlayer;

  // last card point if not 31
  if (t.peg.count !== 31 && lastP) {
    t.scores[lastP] += 1;
  }

  // ✅ reset count
  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.passed = { PLAYER1: false, PLAYER2: false };

  // ✅ CRITICAL FIX:
  // In cribbage pegging, the player who played the last card leads the next count.
  if (lastP) t.turn = lastP;

  return true;
}

function maybeAdvanceToShow(t) {
  const done = t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0;
  if (!done) return false;

  const nd = otherPlayer(t.dealer);
  const de = t.dealer;

  const ndHand4 = t.hands[nd];
  const deHand4 = t.hands[de];
  const crib4 = t.crib;

  const ndBreak = scoreHandWithBreakdown(ndHand4, t.cut, false);
  const deBreak = scoreHandWithBreakdown(deHand4, t.cut, false);
  const crBreak = scoreHandWithBreakdown(crib4, t.cut, true);

  t.scores[nd] += ndBreak.total;
  t.scores[de] += deBreak.total;
  t.scores[de] += crBreak.total;

  t.show = {
    cut: t.cut,
    dealer: de,
    nonDealer: nd,
    hand: {
      [nd]: { cards: ndHand4, breakdown: ndBreak },
      [de]: { cards: deHand4, breakdown: deBreak },
    },
    crib: { cards: crib4, breakdown: crBreak },
  };

  t.stage = "show";
  t.turn = t.dealer;

  return true;
}

function maybeEndGameOrMatch(t) {
  // ✅ Prevent “sticky” matchWins (don’t re-award wins repeatedly)
  if (t.gameOver || t.matchOver) return false;

  const p1 = t.scores.PLAYER1;
  const p2 = t.scores.PLAYER2;
  if (p1 < 121 && p2 < 121) return false;

  t.gameOver = true;
  t.gameWinner =
    p1 >= 121 && p2 >= 121
      ? (p1 >= p2 ? "PLAYER1" : "PLAYER2")
      : (p1 >= 121 ? "PLAYER1" : "PLAYER2");

  t.matchWins[t.gameWinner] += 1;

  if (t.matchWins[t.gameWinner] >= 2) {
    t.matchOver = true;
    t.matchWinner = t.gameWinner;
  }

  return true;
}

function internalPlayCard(t, player, cardId) {
  if (t.stage !== "pegging") return false;
  if (t.turn !== player) return false;
  if (t.gameOver || t.matchOver) return false;

  const hand = t.pegHands[player];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  const card = hand[idx];
  const val = cardValue(card.rank);
  if (t.peg.count + val > 31) return false;

  hand.splice(idx, 1);
  const newCount = t.peg.count + val;

  const { pts, reasons } = scorePegPlay(t.peg.pile, card, newCount);
  t.lastPegEvent = { player, pts: pts || 0, reasons: reasons || [] };
  if (pts > 0) t.scores[player] += pts;

  t.peg.count = newCount;
  t.peg.pile.push(card);
  t.peg.lastPlayer = player;
  t.peg.passed[player] = false;

  if (t.peg.count === 31) {
    maybeEndCountAndReset(t);
  } else {
    t.turn = otherPlayer(player);
  }

  maybeAdvanceToShow(t);
  maybeEndGameOrMatch(t);

  return true;
}

function internalGo(t, player) {
  if (t.stage !== "pegging") return false;
  if (t.turn !== player) return false;
  if (t.gameOver || t.matchOver) return false;

  const hand = t.pegHands[player];
  if (hand.length > 0 && playableExists(hand, t.peg.count)) return false;

  t.peg.passed[player] = true;
  t.lastGoEvent = { player, ts: Date.now() };

  t.turn = otherPlayer(player);

  maybeEndCountAndReset(t);
  maybeAdvanceToShow(t);
  maybeEndGameOrMatch(t);

  return true;
}

// ---------- NEW HELPERS FOR JOIN FIXES ----------
function normalizeTableId(raw) {
  return String(raw || "").trim().slice(0, 24);
}
function normalizeName(raw) {
  return String(raw || "").trim().slice(0, 16);
}
function makeAiTableId() {
  return `AI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 24);
}
function seatForRejoin(t, nm) {
  if (t.players.PLAYER1 === nm && !t.sockets.PLAYER1) return "PLAYER1";
  if (t.players.PLAYER2 === nm && !t.sockets.PLAYER2) return "PLAYER2";
  return null;
}
function firstOpenSeatByName(t) {
  if (!t.players.PLAYER1) return "PLAYER1";
  if (!t.players.PLAYER2) return "PLAYER2";
  return null;
}

// ---------- socket.io ----------
io.on("connection", (socket) => {
  socket.on("join_table", ({ tableId, name, vsAI } = {}) => {
    const nm = normalizeName(name);
    const wantsAI = !!vsAI;

    if (!nm) return socket.emit("error_msg", "Enter a name.");

    const tid = wantsAI ? makeAiTableId() : normalizeTableId(tableId);

    if (!wantsAI && !tid) {
      return socket.emit("error_msg", "Enter a table code.");
    }

    const t = getOrCreateTable(tid);

    if (wantsAI) {
      t.ai.enabled = true;
      t.players.PLAYER2 = "AI Captain";
      t.sockets.PLAYER2 = null;
    } else {
      t.ai.enabled = false;
      if (t.players.PLAYER2 === "AI Captain") {
        t.players.PLAYER2 = null;
        t.sockets.PLAYER2 = null;
      }
    }

    let slot = seatForRejoin(t, nm);
    if (!slot) slot = firstOpenSeatByName(t);
    if (wantsAI) slot = "PLAYER1";

    if (!slot) {
      return socket.emit("error_msg", "Table full.");
    }

    if (wantsAI && slot === "PLAYER2") {
      return socket.emit("error_msg", "Table full.");
    }

    t.players[slot] = nm;
    t.sockets[slot] = socket.id;

    socket.join(tid);

    if (t.matchOver) resetForNewMatch(t);
    if (t.gameOver) resetForNewGame(t);

    startHandIfPossible(t);
    emitStateToTable(t);

    // AI pacing
    scheduleAi(t);
  });

  socket.on("discard_one", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    const ok = internalDiscardOne(t, p, String(cardId));
    if (!ok) { emitStateToTable(t); return; }

    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
    }

    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("play_card", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    internalPlayCard(t, p, String(cardId));
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("go", () => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    internalGo(t, p);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("next_hand", () => {
    const { t } = findTableAndPlayerBySocket(socket.id);
    if (!t) return;

    if (t.matchOver) {
      emitStateToTable(t);
      return;
    }

    if (t.gameOver) {
      resetForNewGame(t);
    }

    startHandIfPossible(t);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("new_match", () => {
    const { t } = findTableAndPlayerBySocket(socket.id);
    if (!t) return;

    resetForNewMatch(t);
    startHandIfPossible(t);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("disconnect", () => {
    for (const t of tables.values()) {
      for (const p of ["PLAYER1", "PLAYER2"]) {
        if (t.sockets[p] === socket.id) {
          t.sockets[p] = null;
        }
      }
    }
  });
});

function findTableAndPlayerBySocket(socketId) {
  for (const t of tables.values()) {
    for (const p of ["PLAYER1", "PLAYER2"]) {
      if (t.sockets[p] === socketId) return { t, p };
    }
  }
  return { t: null, p: null };
}

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});