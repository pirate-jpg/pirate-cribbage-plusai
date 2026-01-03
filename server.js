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
  // cards include cut; count combos summing 15 => 2 each
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
  // run scoring (standard cribbage, multiplicities)
  // brute: consider all subsets size 3..5 and pick max total run points (with multiplicity)
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
  // 1 for jack in hand that matches cut suit
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

  // pairs/trips/quads from end of pile + newCard
  const seq = pile.concat([newCard]);
  let same = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i].rank === newCard.rank) same++;
    else break;
  }
  if (same === 2) { pts += 2; reasons.push("pair"); }
  if (same === 3) { pts += 6; reasons.push("3 of a kind"); }
  if (same === 4) { pts += 12; reasons.push("4 of a kind"); }

  // run (check last N up to 7)
  let runPts = 0;
  for (let n = Math.min(7, seq.length); n >= 3; n--) {
    const tail = seq.slice(seq.length - n);
    const vals = tail.map(c => rankOrder(c.rank)).slice().sort((a,b)=>a-b);
    // no duplicates allowed
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i-1]) { vals.length = 0; break; }
    }
    if (!vals.length) continue;
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
  if (t.ai.enabled) return !!t.players.PLAYER1 && !!t.players.PLAYER2;
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
  t.turn = otherPlayer(t.dealer); // non-dealer acts first in pegging, but discard both can act anytime
  t.peg = { count: 0, pile: [], passed: { PLAYER1: false, PLAYER2: false }, lastPlayer: null };
  t.lastPegEvent = null;
  t.lastGoEvent = null;
  t.show = null;

  // If AI, discard immediately for AI side (but still via same mechanism)
  if (t.ai.enabled) {
    aiDoDiscardIfNeeded(t);
  }
}

function startHandIfPossible(t) {
  if (!bothPlayersReady(t)) return;
  if (t.matchOver || t.gameOver) return;
  dealHand(t);
}

function emitStateToTable(t) {
  // build base state that is common
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

  // send personalized state to each socket (so myHand is correct and "me" is correct)
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

// ---------- AI (smarter) ----------
function randInt(n) { return (Math.random() * n) | 0; }

function buildRemainingDeckExcluding(cards) {
  const exclude = new Set(cards.map(c => c.id));
  return makeDeck().filter(c => !exclude.has(c.id));
}

function estimateHandEV(keep4, excluded6, samples = 18) {
  const remain = buildRemainingDeckExcluding(excluded6);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const cut = remain[randInt(remain.length)];
    sum += scoreHandWithBreakdown(keep4, cut, false).total;
  }
  return sum / samples;
}

function estimateCribEV(discard2, excluded6, isDealer, samples = 12) {
  // crude but effective: sample random other 2 cards + random cut -> crib score
  // if dealer: good (positive); if non-dealer: bad (negative)
  const remain = buildRemainingDeckExcluding(excluded6);
  let sum = 0;

  for (let i = 0; i < samples; i++) {
    // pick other 2 distinct
    const a = remain[randInt(remain.length)];
    let b = remain[randInt(remain.length)];
    while (b.id === a.id) b = remain[randInt(remain.length)];

    const cut = remain[randInt(remain.length)];
    const crib4 = discard2.concat([a, b]);
    const pts = scoreHandWithBreakdown(crib4, cut, true).total;
    sum += pts;
  }

  const avg = sum / samples;
  return isDealer ? avg : -avg;
}

function aiChooseDiscardSmart(hand6, isDealer) {
  // Try all keep-4 combos; pick best EV = handEV + cribEV*(small weight)
  let best = null;
  let bestScore = -Infinity;

  const idxs = [0,1,2,3,4,5];
  const keepCombos = combinations(idxs, 4);

  for (const keepIdxs of keepCombos) {
    const keep4 = keepIdxs.map(i => hand6[i]);
    const disc2 = idxs.filter(i => !keepIdxs.includes(i)).map(i => hand6[i]);

    const handEV = estimateHandEV(keep4, hand6, 18);
    const cribEV = estimateCribEV(disc2, hand6, isDealer, 12);

    // crib is important but not everything
    const total = handEV + (0.45 * cribEV);

    if (total > bestScore) {
      bestScore = total;
      best = { keep4, disc2 };
    }
  }

  // fallback
  if (!best) {
    const sorted = [...hand6].sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
    return [sorted[0], sorted[1]];
  }
  return best.disc2;
}

function aiChoosePegCardSmart(hand, count, pile) {
  const playable = hand.filter(c => count + cardValue(c.rank) <= 31);
  if (!playable.length) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const c of playable) {
    const newCount = count + cardValue(c.rank);
    const pegNow = scorePegPlay(pile, c, newCount);
    const pts = pegNow.pts || 0;

    // flexibility after play
    const remaining = hand.filter(x => x.id !== c.id);
    const remainingPlayable = remaining.filter(x => newCount + cardValue(x.rank) <= 31).length;

    // prefer leaving "go pressure" on opponent: higher counts near 31 can be good,
    // but avoid auto-walking into 15/21 patterns is complex; keep heuristic simple.
    let score = 0;
    score += pts * 12;                  // immediate points matter a lot
    score += remainingPlayable * 1.6;   // keep options
    score += (newCount === 31 ? 2.0 : 0);
    score += (newCount === 15 ? 1.5 : 0);
    score += (31 - newCount) * 0.05;    // slight preference to not blow count too early

    // small bias: keep 5s for later unless it scores now
    if (c.rank === "5" && pts === 0) score -= 0.8;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best || playable[0];
}

function aiDoDiscardIfNeeded(t) {
  if (!t.ai.enabled) return;
  const ap = t.ai.aiPlayer;

  if (t.stage !== "discard") return;
  if (t.discardsCount[ap] >= 2) return;

  const needed = 2 - t.discardsCount[ap];
  if (needed <= 0) return;

  const hand = t.hands[ap];
  if (hand.length < needed) return;

  // smarter discard
  const isDealer = (t.dealer === ap);
  const picks = aiChooseDiscardSmart(hand, isDealer).slice(0, needed);
  for (const c of picks) {
    internalDiscardOne(t, ap, c.id);
  }
}

function aiMaybeAct(t) {
  if (!t.ai.enabled) return;
  if (t.matchOver || t.gameOver) return;

  const ap = t.ai.aiPlayer;

  // AI discard
  if (t.stage === "discard") {
    aiDoDiscardIfNeeded(t);
    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
    }
    return;
  }

  // AI pegging
  if (t.stage === "pegging" && t.turn === ap) {
    const count = t.peg.count;
    const card = aiChoosePegCardSmart(t.pegHands[ap], count, t.peg.pile);
    if (card) {
      internalPlayCard(t, ap, card.id);
    } else {
      internalGo(t, ap);
    }
  }
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
  // create pegHands from remaining 4 in hands; hands remain for show
  t.pegHands.PLAYER1 = t.hands.PLAYER1.map(c => ({ ...c }));
  t.pegHands.PLAYER2 = t.hands.PLAYER2.map(c => ({ ...c }));

  t.cut = t.deck.splice(0, 1)[0];
  // "His heels": if cut is Jack, dealer scores 2
  if (t.cut.rank === "J") {
    t.scores[t.dealer] += 2;
  }

  // reset pegging state
  t.peg = {
    count: 0,
    pile: [],
    passed: { PLAYER1: false, PLAYER2: false },
    lastPlayer: null,
  };
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  t.stage = "pegging";
  t.turn = otherPlayer(t.dealer); // non-dealer starts pegging
}

function playableExists(hand, count) {
  return hand.some(c => count + cardValue(c.rank) <= 31);
}

function maybeEndCountAndReset(t) {
  // if both passed OR nobody can play (with cards remaining), award last card to lastPlayer (if any)
  const p1Has = t.pegHands.PLAYER1.length > 0;
  const p2Has = t.pegHands.PLAYER2.length > 0;
  const anyCards = p1Has || p2Has;

  const p1Can = p1Has && playableExists(t.pegHands.PLAYER1, t.peg.count);
  const p2Can = p2Has && playableExists(t.pegHands.PLAYER2, t.peg.count);

  const bothPassed = t.peg.passed.PLAYER1 && t.peg.passed.PLAYER2;
  const nobodyCanPlay = anyCards && !p1Can && !p2Can;

  if (!(bothPassed || nobodyCanPlay || t.peg.count === 31)) return false;

  // If count hit 31, pile resets automatically; last card points already handled by 31 scoring
  // If not 31, award 1 point "go / last card" to lastPlayer (if any)
  if (t.peg.count !== 31 && t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
  }

  // reset for next count
  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.passed = { PLAYER1: false, PLAYER2: false };

  // turn becomes player after lastPlayer
  if (t.peg.lastPlayer) t.turn = otherPlayer(t.peg.lastPlayer);

  return true;
}

function maybeAdvanceToShow(t) {
  const done = t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0;
  if (!done) return false;

  // Show scoring: non-dealer, dealer, then crib (dealer)
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
  const p1 = t.scores.PLAYER1;
  const p2 = t.scores.PLAYER2;
  if (p1 < 121 && p2 < 121) return false;

  t.gameOver = true;
  t.gameWinner =
    p1 >= 121 && p2 >= 121
      ? (p1 >= p2 ? "PLAYER1" : "PLAYER2")
      : (p1 >= 121 ? "PLAYER1" : "PLAYER2");

  // best of 3 => first to 2 wins
  t.matchWins[t.gameWinner] += 1;

  if (t.matchWins[t.gameWinner] >= 2) {
    t.matchOver = true;
    t.matchWinner = t.gameWinner;
  }

  // stay in show so you can see the breakdown, but gameOver/matchOver becomes true
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

  // play it
  hand.splice(idx, 1);
  const newCount = t.peg.count + val;

  const { pts, reasons } = scorePegPlay(t.peg.pile, card, newCount);
  if (pts > 0) {
    t.scores[player] += pts;
    t.lastPegEvent = { player, pts, reasons };
  } else {
    t.lastPegEvent = { player, pts: 0, reasons: [] };
  }

  t.peg.count = newCount;
  t.peg.pile.push(card);
  t.peg.lastPlayer = player;

  // playing a card clears your "passed" status
  t.peg.passed[player] = false;

  // if hit 31, reset immediately (no "go" points)
  if (t.peg.count === 31) {
    maybeEndCountAndReset(t);
  } else {
    // ---- FIX: if opponent has NO cards left, you keep the turn (prevents stall) ----
    const opp = otherPlayer(player);
    if (t.pegHands[opp].length === 0) {
      t.turn = player;
      // also: treat opponent as "passed" for this count so the end-of-count logic can trigger naturally
      t.peg.passed[opp] = true;
    } else {
      t.turn = opp;
    }
  }

  // count may need to reset if nobody can play after this card
  maybeEndCountAndReset(t);

  // if both hands empty, go to show
  maybeAdvanceToShow(t);
  // check game end (can end during pegging)
  maybeEndGameOrMatch(t);

  return true;
}

function internalGo(t, player) {
  if (t.stage !== "pegging") return false;
  if (t.turn !== player) return false;
  if (t.gameOver || t.matchOver) return false;

  // Only allow go if truly cannot play (or you have no cards)
  const hand = t.pegHands[player];
  if (hand.length > 0 && playableExists(hand, t.peg.count)) return false;

  t.peg.passed[player] = true;
  t.lastGoEvent = { player, ts: Date.now() };

  // turn passes to other player
  t.turn = otherPlayer(player);

  // if count should end, reset and continue
  maybeEndCountAndReset(t);

  // if hands empty, show
  maybeAdvanceToShow(t);
  maybeEndGameOrMatch(t);

  return true;
}

// ---------- socket.io ----------
io.on("connection", (socket) => {
  socket.on("join_table", ({ tableId, name, vsAI } = {}) => {
    const tid = String(tableId || "JIM1").trim().slice(0, 24) || "JIM1";
    const nm = String(name || "").trim().slice(0, 16);
    if (!nm) return socket.emit("error_msg", "Enter a name.");

    const t = getOrCreateTable(tid);

    // If table already has PLAYER1, fill PLAYER2; else fill PLAYER1
    let slot = null;
    if (!t.players.PLAYER1) slot = "PLAYER1";
    else if (!t.players.PLAYER2) slot = "PLAYER2";
    else {
      return socket.emit("error_msg", "Table full.");
    }

    // Configure AI if requested and joining as PLAYER1
    if (slot === "PLAYER1") {
      t.ai.enabled = !!vsAI;
      if (t.ai.enabled) {
        t.players.PLAYER2 = "AI Captain";
        t.sockets.PLAYER2 = null;
      } else {
        if (t.players.PLAYER2 === "AI Captain") {
          t.players.PLAYER2 = null;
          t.sockets.PLAYER2 = null;
        }
      }
    }

    t.players[slot] = nm;
    t.sockets[slot] = socket.id;

    socket.join(tid);

    // On join, if AI mode and PLAYER1 joined, auto-start hand
    if (t.ai.enabled && t.players.PLAYER1 && t.players.PLAYER2) {
      if (t.matchOver) resetForNewMatch(t);
      if (t.gameOver) resetForNewGame(t);
      startHandIfPossible(t);
    } else {
      startHandIfPossible(t);
    }

    emitStateToTable(t);
    aiMaybeAct(t);
    emitStateToTable(t);
  });

  // Single-card discard
  socket.on("discard_one", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    const ok = internalDiscardOne(t, p, String(cardId));
    if (!ok) { emitStateToTable(t); return; }

    // if AI and AI not finished, do it
    aiDoDiscardIfNeeded(t);

    // if both complete, begin pegging
    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
    }

    emitStateToTable(t);
    aiMaybeAct(t);
    emitStateToTable(t);
  });

  // Backwards compatibility: discard_to_crib expects two ids
  socket.on("discard_to_crib", ({ cardIds } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    if (!Array.isArray(cardIds)) return;
    for (const id of cardIds.slice(0, 2)) internalDiscardOne(t, p, String(id));

    aiDoDiscardIfNeeded(t);
    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) beginPegging(t);

    emitStateToTable(t);
    aiMaybeAct(t);
    emitStateToTable(t);
  });

  socket.on("play_card", ({ cardId } = {}) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    internalPlayCard(t, p, String(cardId));
    emitStateToTable(t);
    aiMaybeAct(t);
    emitStateToTable(t);
  });

  socket.on("go", () => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t || !p) return;

    internalGo(t, p);
    emitStateToTable(t);
    aiMaybeAct(t);
    emitStateToTable(t);
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
    aiMaybeAct(t);
    emitStateToTable(t);
  });

  socket.on("new_match", () => {
    const { t } = findTableAndPlayerBySocket(socket.id);
    if (!t) return;
    resetForNewMatch(t);
    startHandIfPossible(t);
    emitStateToTable(t);
    aiMaybeAct(t);
    emitStateToTable(t);
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