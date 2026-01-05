// server.js
"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- AI pacing (ms) ---
const AI_DELAY_PLAY_MS = Number(process.env.AI_DELAY_PLAY_MS || 900);     // after AI plays a card
const AI_DELAY_GO_MS = Number(process.env.AI_DELAY_GO_MS || 650);         // after AI says GO
const AI_DELAY_DISCARD_MS = Number(process.env.AI_DELAY_DISCARD_MS || 600); // per discard

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
    },

    lastPegEvent: null,
    lastGoEvent: null,

    show: null,

    // AI pacing
    _aiTimer: null,
    _aiBusy: false,
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

function playableExists(hand, count) {
  return hand.some(c => count + cardValue(c.rank) <= 31);
}

// --- critical: prevent pegging stall when current turn has zero cards ---
function autoGoEmptyHands(t) {
  // If it's a player's turn and they have no pegging cards, auto-GO them.
  // This prevents the UI from stalling (because the client hides GO when hand is empty).
  let guard = 0;
  while (guard++ < 10) {
    if (t.stage !== "pegging") return;
    if (t.gameOver || t.matchOver) return;

    const cur = t.turn;
    const hand = t.pegHands[cur] || [];
    if (hand.length > 0) return;

    // auto pass
    internalGo(t, cur);
    // internalGo may advance to show/gameover; loop continues only if still pegging
  }
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
    t.lastPegEvent = { player: t.peg.lastPlayer, pts: 1, reasons: ["last card"] };
  }

  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.passed = { PLAYER1: false, PLAYER2: false };
  if (t.peg.lastPlayer) t.turn = otherPlayer(t.peg.lastPlayer);

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

  autoGoEmptyHands(t);
}

function maybeAdvanceToShow(t) {
  const done = t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0;
  if (!done) return false;

  // Ensure last-card point is awarded when the final "count" ended because both are out.
  // (This is usually handled by maybeEndCountAndReset when bothPassed becomes true.)
  if (t.stage === "pegging") {
    t.peg.passed.PLAYER1 = true;
    t.peg.passed.PLAYER2 = true;
    maybeEndCountAndReset(t);
  }

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

// --- FIX: prevent matchWins from incrementing multiple times after game