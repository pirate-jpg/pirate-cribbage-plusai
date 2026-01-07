"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---- static + health ----
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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

// Pegging scoring (15/31, pairs, runs, last card handled elsewhere)
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
    hands: { PLAYER1: [], PLAYER2: [] },
    pegHands: { PLAYER1: [], PLAYER2: [] },
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

  // NEW GAME: flip dealer
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

// ======================================================================
// AI (STEP-BY-STEP WITH DELAY)
// ======================================================================

const AI_DELAY_MS = 900;
const aiTimers = new Map(); // tableId -> timeoutId

function clearAiTimer(t) {
  if (!t) return;
  const tid = t.tableId;
  const h = aiTimers.get(tid);
  if (h) clearTimeout(h);
  aiTimers.delete(tid);
}

function shouldAiContinue(t) {
  if (!t.ai.enabled) return false;
  if (t.matchOver || t.gameOver) return false;

  const ap = t.ai.aiPlayer;

  if (t.stage === "discard") {
    const needsDiscard = t.discardsCount[ap] < 2;
    const canAdvance = (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2);
    return needsDiscard || canAdvance;
  }

  if (t.stage === "pegging") {
    return t.turn === ap;
  }

  return false;
}

function scheduleAi(t) {
  if (!t || !t.ai.enabled) return;
  if (!shouldAiContinue(t)) return;

  // prevent stacking
  if (aiTimers.has(t.tableId)) return;

  const handle = setTimeout(() => {
    aiTimers.delete(t.tableId);

    // table may have ended since scheduling
    if (!t.ai.enabled || t.matchOver || t.gameOver) return;

    const did = aiActOnce(t);

    // Always emit after the AI step so client can render intermediate states
    emitStateToTable(t);

    // Keep stepping if needed
    if (did && shouldAiContinue(t)) {
      scheduleAi(t);
    }
  }, AI_DELAY_MS);

  aiTimers.set(t.tableId, handle);
}

function aiChooseDiscardOne(hand) {
  // simple: discard highest value first
  if (!hand.length) return null;
  let best = hand[0];
  for (const c of hand) {
    if (cardValue(c.rank) > cardValue(best.rank)) best = c;
  }
  return best;
}

function aiChoosePegCard(hand, count) {
  const playable = hand.filter(c => count + cardValue(c.rank) <= 31);
  if (!playable.length) return null;
  playable.sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
  return playable[0];
}

function aiActOnce(t) {
  if (!t.ai.enabled) return false;
  if (t.matchOver || t.gameOver) return false;

  const ap = t.ai.aiPlayer;

  // DISCARD: one discard per tick
  if (t.stage === "discard") {
    if (t.discardsCount[ap] < 2) {
      const pick = aiChooseDiscardOne(t.hands[ap]);
      if (!pick) return false;
      const ok = internalDiscardOne(t, ap, pick.id);
      if (!ok) return false;

      // if both now done, advance immediately (still counts as this "one step")
      if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) beginPegging(t);
      return true;
    }

    // if AI already done but both are done, advance
    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
      return true;
    }

    return false;
  }

  // PEGGING: one play or one GO per tick (ONLY when it's AI's turn)
  if (t.stage === "pegging" && t.turn === ap) {
    const count = t.peg.count;
    const card = aiChoosePegCard(t.pegHands[ap], count);
    if (card) return internalPlayCard(t, ap, card.id);
    return internalGo(t, ap);
  }

  return false;
}

// ======================================================================

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
    // If someone hits 121 on knobs, end immediately (avoid deadlock)
    if (maybeEndGameOrMatch(t)) return;
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

  if (t.peg.count !== 31 && t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
  }

  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.passed = { PLAYER1: false, PLAYER2: false };
  if (t.peg.lastPlayer) t.turn = otherPlayer(t.peg.lastPlayer);

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

/**
 * ✅ Critical fix:
 * If someone reaches 121 mid-pegging, we must *transition off pegging*
 * so the client can show Game Over / Next Game, instead of dead-locking.
 */
function maybeEndGameOrMatch(t) {
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

  // stop any queued AI actions immediately
  clearAiTimer(t);

  // force UI into a safe end-state (client already knows how to handle "show")
  if (t.stage !== "show") {
    t.stage = "show";
    t.turn = t.dealer;
    // NOTE: we intentionally do NOT compute show scoring if game ends mid-pegging.
    // In cribbage, the game ends immediately when a player pegs out.
    t.show = t.show || null;
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

  // ✅ end immediately if someone pegged out
  if (maybeEndGameOrMatch(t)) return true;

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

  // ✅ end immediately if "go point" pegged someone out
  if (maybeEndGameOrMatch(t)) return true;

  maybeAdvanceToShow(t);
  maybeEndGameOrMatch(t);

  return true;
}

// ---------- JOIN HELPERS ----------
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
  console.log("[socket] connected:", socket.id);

  socket.on("join_table", ({ tableId, name, vsAI } = {}) => {
    console.log("[join_table] from", socket.id, { tableId, name, vsAI });

    const nm = normalizeName(name);
    const wantsAI = !!vsAI;

    if (!nm) return socket.emit("error_msg", "Enter a name.");

    const tid = wantsAI ? makeAiTableId() : normalizeTableId(tableId);
    if (!wantsAI && !tid) return socket.emit("error_msg", "Enter a table code.");

    const t = getOrCreateTable(tid);

    // If table existed and had a running AI timer, stop it while reconfiguring
    clearAiTimer(t);

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

    if (t.matchOver) resetForNewMatch(t);
    if (t.gameOver) resetForNewGame(t);

    startHandIfPossible(t);

    // IMPORTANT: emit first so humans SEE THEIR HAND before AI starts acting
    emitStateToTable(t);

    // Then schedule AI to act step-by-step
    scheduleAi(t);
  });

  socket.on("discard_one", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    const ok = internalDiscardOne(t, p, String(cardId));
    if (!ok) { emitStateToTable(t); scheduleAi(t); return; }

    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) beginPegging(t);

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

    // ✅ IMPORTANT FIX:
    // Dealer (and thus crib owner) should alternate EVERY HAND, not only when a game ends.
    if (!t.gameOver && t.stage === "show") {
      t.dealer = otherPlayer(t.dealer);
    }

    if (t.gameOver) resetForNewGame(t);

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
    console.log("[socket] disconnected:", socket.id);
    for (const t of tables.values()) {
      for (const p of ["PLAYER1", "PLAYER2"]) {
        if (t.sockets[p] === socket.id) t.sockets[p] = null;
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});