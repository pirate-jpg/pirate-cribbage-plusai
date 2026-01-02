// Pirate Cribbage - discard -> pegging -> show
// Includes:
// - Names via join overlay
// - Optional AI opponent (AI sits as PLAYER2)
// - Pegging scoring: 15/31, pairs, runs, last card
// - Show scoring breakdown: 15s/pairs/runs/flush/nobs
// - Fix: no-stall when opponent is out of cards and remaining player is blocked
// - Game ends at 121 (no dealing past 121); match wins tracked (first to 3)
// - Next game + new match

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const GAME_TARGET = 121;
const MATCH_TARGET_WINS = 3;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Listening on", PORT));

const tables = {}; // tableId -> tableState

function newDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  let id = 0;
  for (const s of suits) for (const r of ranks) deck.push({ id: `c${id++}`, rank: r, suit: s });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardValue(rank) {
  if (rank === "A") return 1;
  if (["K","Q","J"].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function rankNum(rank) {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return parseInt(rank, 10);
}

function otherPlayer(p) {
  return p === "PLAYER1" ? "PLAYER2" : "PLAYER1";
}

function sanitizeName(name, fallback) {
  const n = (name || "").toString().trim().slice(0, 16);
  return n.length ? n : fallback;
}

function ensureTable(tableId) {
  if (!tables[tableId]) {
    tables[tableId] = {
      id: tableId,

      players: { PLAYER1: null, PLAYER2: null },  // socket ids (AI uses null)
      names:   { PLAYER1: "PLAYER1", PLAYER2: "PLAYER2" },

      dealer: "PLAYER1",
      stage: "lobby", // lobby | discard | pegging | show
      turn: "PLAYER1",

      deck: [],
      cut: null,
      crib: [],

      hands:    { PLAYER1: [], PLAYER2: [] },     // preserved for show (4 cards)
      pegHands: { PLAYER1: [], PLAYER2: [] },     // consumed during pegging

      discards: { PLAYER1: [], PLAYER2: [] },

      peg: {
        count: 0,
        pile: [],
        lastPlayer: null,
        go: { PLAYER1: false, PLAYER2: false }
      },

      scores: { PLAYER1: 0, PLAYER2: 0 },         // game score to 121

      // Match tracking
      matchWins: { PLAYER1: 0, PLAYER2: 0 },
      matchTarget: MATCH_TARGET_WINS,
      gameTarget: GAME_TARGET,

      gameOver: false,
      gameWinner: null,      // PLAYER1/PLAYER2
      matchOver: false,
      matchWinner: null,

      show: null,            // show breakdown payload
      lastPegEvent: null,    // { player, pts, reasons[] }

      // AI settings
      ai: {
        enabled: false,
        side: "PLAYER2",
        name: "AI Captain",
      },

      log: []
    };
  }
  return tables[tableId];
}

function pushLog(t, msg) {
  t.log.push(msg);
  if (t.log.length > 160) t.log.shift();
}

function canPlayAny(hand, count) {
  return (hand || []).some(c => cardValue(c.rank) + count <= 31);
}

/** -------------------------
 * Public state
 * ------------------------- */
function publicStateFor(t, me) {
  const handForUI = (t.stage === "pegging") ? (t.pegHands[me] || []) : (t.hands[me] || []);

  const p1Name = t.players.PLAYER1 ? t.names.PLAYER1 : null;
  const p2Name = (t.ai.enabled ? t.ai.name : (t.players.PLAYER2 ? t.names.PLAYER2 : null));

  return {
    tableId: t.id,
    stage: t.stage,
    dealer: t.dealer,
    turn: t.turn,
    cut: t.cut,

    scores: t.scores,

    // match
    matchWins: t.matchWins,
    matchTarget: t.matchTarget,
    gameTarget: t.gameTarget,
    gameOver: t.gameOver,
    gameWinner: t.gameWinner,
    matchOver: t.matchOver,
    matchWinner: t.matchWinner,

    names: t.names,
    ai: { enabled: t.ai.enabled, side: t.ai.side, name: t.ai.name },

    players: {
      PLAYER1: p1Name,
      PLAYER2: p2Name
    },

    cribCount: t.crib.length,
    discardsCount: {
      PLAYER1: t.discards.PLAYER1.length,
      PLAYER2: t.discards.PLAYER2.length
    },

    peg: {
      count: t.peg.count,
      pile: t.peg.pile.map(c => ({ id: c.id, rank: c.rank, suit: c.suit })),
      lastPlayer: t.peg.lastPlayer,
      go: t.peg.go
    },

    me,
    myHand: handForUI,

    myHandCount: (t.pegHands[me] || []).length,
    oppHandCount: (t.pegHands[otherPlayer(me)] || []).length,

    lastPegEvent: t.lastPegEvent,
    show: t.show,

    log: t.log
  };
}

function emitState(tableId) {
  const t = tables[tableId];
  if (!t) return;
  for (const p of ["PLAYER1", "PLAYER2"]) {
    const sid = t.players[p];
    if (sid) io.to(sid).emit("state", publicStateFor(t, p));
  }
}

/** -------------------------
 * Game / Match end logic
 * ------------------------- */
function checkGameEnd(t) {
  if (t.gameOver || t.matchOver) return;

  const p1 = t.scores.PLAYER1;
  const p2 = t.scores.PLAYER2;

  if (p1 >= t.gameTarget || p2 >= t.gameTarget) {
    t.gameOver = true;
    t.gameWinner = (p1 >= t.gameTarget) ? "PLAYER1" : "PLAYER2";
    t.matchWins[t.gameWinner] += 1;

    pushLog(t, `🏁 GAME OVER — ${nameOf(t, t.gameWinner)} wins (${t.scores.PLAYER1}–${t.scores.PLAYER2}).`);

    if (t.matchWins[t.gameWinner] >= t.matchTarget) {
      t.matchOver = true;
      t.matchWinner = t.gameWinner;
      pushLog(t, `🏴‍☠️ MATCH OVER — ${nameOf(t, t.matchWinner)} wins the match!`);
    }
  }
}

function resetForNewGame(t) {
  t.scores = { PLAYER1: 0, PLAYER2: 0 };
  t.gameOver = false;
  t.gameWinner = null;
  t.show = null;
  t.lastPegEvent = null;

  // Alternate starting dealer for fairness
  t.dealer = otherPlayer(t.dealer);
  t.stage = "lobby";
  t.turn = t.dealer;

  pushLog(t, `⚓ New game begins. Starting dealer: ${t.dealer} (${nameOf(t, t.dealer)}).`);

  if (t.players.PLAYER1 && (t.players.PLAYER2 || t.ai.enabled) && !t.matchOver) {
    startHand(t);
  }
}

function resetForNewMatch(t) {
  t.matchWins = { PLAYER1: 0, PLAYER2: 0 };
  t.matchOver = false;
  t.matchWinner = null;

  t.scores = { PLAYER1: 0, PLAYER2: 0 };
  t.gameOver = false;
  t.gameWinner = null;

  t.show = null;
  t.lastPegEvent = null;

  t.dealer = "PLAYER1";
  t.stage = "lobby";
  t.turn = "PLAYER1";

  pushLog(t, `🧭 New match started (first to ${t.matchTarget} wins).`);

  if (t.players.PLAYER1 && (t.players.PLAYER2 || t.ai.enabled)) {
    startHand(t);
  }
}

function nameOf(t, who) {
  if (t.ai.enabled && who === t.ai.side) return t.ai.name;
  return t.names[who] || who;
}

/** -------------------------
 * Hand flow
 * ------------------------- */
function startHand(t) {
  if (t.gameOver || t.matchOver) return;

  t.stage = "discard";
  t.deck = shuffle(newDeck());
  t.crib = [];
  t.cut = null;
  t.show = null;
  t.lastPegEvent = null;

  t.discards = { PLAYER1: [], PLAYER2: [] };
  t.peg = { count: 0, pile: [], lastPlayer: null, go: { PLAYER1: false, PLAYER2: false } };

  const p1 = t.deck.splice(0, 6);
  const p2 = t.deck.splice(0, 6);

  t.hands.PLAYER1 = [...p1];
  t.hands.PLAYER2 = [...p2];
  t.pegHands.PLAYER1 = [...p1];
  t.pegHands.PLAYER2 = [...p2];

  t.turn = t.dealer;

  pushLog(t, `New hand. Dealer: ${t.dealer} (${nameOf(t, t.dealer)}).`);

  // If AI enabled, let AI discard immediately (doesn't block the human)
  if (t.ai.enabled) {
    scheduleAi(t, "discard");
  }
}

function enterPegging(t) {
  t.stage = "pegging";
  t.cut = t.deck.splice(0, 1)[0];
  t.lastPegEvent = null;

  pushLog(t, `Cut: ${t.cut.rank}${t.cut.suit}`);

  t.pegHands.PLAYER1 = [...t.hands.PLAYER1];
  t.pegHands.PLAYER2 = [...t.hands.PLAYER2];

  t.turn = otherPlayer(t.dealer);
  t.peg = { count: 0, pile: [], lastPlayer: null, go: { PLAYER1: false, PLAYER2: false } };

  pushLog(t, `Pegging starts. ${t.turn} to play.`);

  if (t.ai.enabled) {
    scheduleAi(t, "pegging");
  }
}

/** -------------------------
 * Pegging scoring (includes runs)
 * ------------------------- */
function peggingRunPoints(pile) {
  const maxLookback = Math.min(pile.length, 7);
  for (let len = maxLookback; len >= 3; len--) {
    const slice = pile.slice(pile.length - len);
    const vals = slice.map(c => rankNum(c.rank));
    const set = new Set(vals);
    if (set.size !== len) continue;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    if (max - min !== len - 1) continue;
    return len;
  }
  return 0;
}

function pegPointsAfterPlay(t, player, playedCard) {
  let pts = 0;
  const reasons = [];

  if (t.peg.count === 15) { pts += 2; reasons.push("15 for 2"); }
  if (t.peg.count === 31) { pts += 2; reasons.push("31 for 2"); }

  let same = 1;
  for (let i = t.peg.pile.length - 2; i >= 0; i--) {
    if (t.peg.pile[i].rank === playedCard.rank) same++;
    else break;
  }
  if (same === 2) { pts += 2; reasons.push("pair for 2"); }
  else if (same === 3) { pts += 6; reasons.push("three of a kind for 6"); }
  else if (same === 4) { pts += 12; reasons.push("four of a kind for 12"); }

  const runPts = peggingRunPoints(t.peg.pile);
  if (runPts >= 3) { pts += runPts; reasons.push(`run of ${runPts} for ${runPts}`); }

  t.lastPegEvent = { player, pts, reasons };

  if (pts) {
    t.scores[player] += pts;
    pushLog(t, `${player} scores ${pts} pegging point(s) (${reasons.join(", ")}).`);
    checkGameEnd(t);
  }

  return pts;
}

function awardLastCardIfNeeded(t) {
  if (t.peg.count !== 0 && t.peg.count !== 31 && t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
    t.lastPegEvent = { player: t.peg.lastPlayer, pts: 1, reasons: ["last card for 1"] };
    pushLog(t, `${t.peg.lastPlayer} scores 1 for last card.`);
    checkGameEnd(t);
  }
}

function resetPegCount(t) {
  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.lastPlayer = null;
  t.peg.go = { PLAYER1: false, PLAYER2: false };
  pushLog(t, `Count resets to 0.`);
}

function endSequenceAndContinue(t, nextTurnPlayer) {
  awardLastCardIfNeeded(t);
  resetPegCount(t);

  if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
    scoreShowAndAdvance(t);
    return;
  }

  t.turn = nextTurnPlayer;
  pushLog(t, `${t.turn} to play.`);
}

/** -------------------------
 * SHOW scoring with breakdown
 * ------------------------- */
function combos(arr, k, start = 0, prefix = [], out = []) {
  if (prefix.length === k) { out.push(prefix); return out; }
  for (let i = start; i <= arr.length - (k - prefix.length); i++) {
    combos(arr, k, i + 1, prefix.concat([arr[i]]), out);
  }
  return out;
}

function score15sDetailed(cards) {
  let count = 0;
  for (let k = 2; k <= 5; k++) {
    for (const set of combos(cards, k)) {
      const sum = set.reduce((a, c) => a + cardValue(c.rank), 0);
      if (sum === 15) count++;
    }
  }
  return { count, pts: count * 2 };
}

function scorePairsDetailed(cards) {
  const byRank = {};
  for (const c of cards) byRank[c.rank] = (byRank[c.rank] || 0) + 1;

  let pairCount = 0;
  let pts = 0;

  for (const r of Object.keys(byRank)) {
    const n = byRank[r];
    if (n >= 2) {
      const comb = (n * (n - 1)) / 2;
      pairCount += comb;
      pts += comb * 2;
    }
  }
  return { pairs: pairCount, pts };
}

function runsMultiplicity(cards) {
  const counts = Array(14).fill(0);
  for (const c of cards) counts[rankNum(c.rank)]++;

  function runCount(len) {
    let total = 0;
    for (let start = 1; start <= 13 - len + 1; start++) {
      let mult = 1;
      for (let r = start; r < start + len; r++) {
        if (counts[r] === 0) { mult = 0; break; }
        mult *= counts[r];
      }
      if (mult > 0) total += mult;
    }
    return total;
  }

  for (let len = 5; len >= 3; len--) {
    const mult = runCount(len);
    if (mult > 0) return { len, mult, pts: len * mult };
  }
  return { len: 0, mult: 0, pts: 0 };
}

function scoreFlushDetailed(hand4, cut, isCrib) {
  const suit = hand4[0].suit;
  const all4 = hand4.every(c => c.suit === suit);
  if (!all4) return { type: "none", pts: 0 };

  const cutMatches = cut.suit === suit;

  if (isCrib) {
    return cutMatches ? { type: "5-card flush", pts: 5 } : { type: "crib needs 5-card flush", pts: 0 };
  }

  if (cutMatches) return { type: "5-card flush", pts: 5 };
  return { type: "4-card flush", pts: 4 };
}

function scoreNobsDetailed(hand4, cut) {
  const has = hand4.some(c => c.rank === "J" && c.suit === cut.suit);
  return { has, pts: has ? 1 : 0 };
}

function scoreHandBreakdown(hand4, cut, isCrib = false) {
  const all = hand4.concat([cut]);
  const items = [];

  const fif = score15sDetailed(all);
  if (fif.count > 0) items.push({ label: `${fif.count} fifteens`, pts: fif.pts });

  const pr = scorePairsDetailed(all);
  if (pr.pairs > 0) items.push({ label: `${pr.pairs} pair${pr.pairs === 1 ? "" : "s"}`, pts: pr.pts });

  const ru = runsMultiplicity(all);
  if (ru.len >= 3) {
    const label = ru.mult === 1 ? `run of ${ru.len}` : `${ru.mult} runs of ${ru.len}`;
    items.push({ label, pts: ru.pts });
  }

  const fl = scoreFlushDetailed(hand4, cut, isCrib);
  if (fl.pts > 0) items.push({ label: fl.type, pts: fl.pts });

  const nb = scoreNobsDetailed(hand4, cut);
  if (nb.pts > 0) items.push({ label: "nobs (jack matches cut suit)", pts: 1 });

  const total = items.reduce((a, i) => a + i.pts, 0);
  return { total, items };
}

function scoreShowAndAdvance(t) {
  const nonDealer = otherPlayer(t.dealer);
  const dealer = t.dealer;

  const nonBD = scoreHandBreakdown(t.hands[nonDealer], t.cut, false);
  const deaBD = scoreHandBreakdown(t.hands[dealer], t.cut, false);
  const cribBD = scoreHandBreakdown(t.crib, t.cut, true);

  t.scores[nonDealer] += nonBD.total;
  t.scores[dealer] += deaBD.total + cribBD.total;

  t.show = {
    nonDealer,
    dealer,
    cut: t.cut,
    cribOwner: dealer,
    hand: {
      [nonDealer]: { cards: t.hands[nonDealer], breakdown: nonBD },
      [dealer]: { cards: t.hands[dealer], breakdown: deaBD }
    },
    crib: { cards: t.crib, breakdown: cribBD }
  };

  pushLog(t, `SHOW: ${nonDealer} +${nonBD.total}, ${dealer} +${deaBD.total}, crib +${cribBD.total}`);
  t.stage = "show";

  checkGameEnd(t);
}

/** -------------------------
 * Internal action helpers (used by AI too)
 * ------------------------- */
function playCardInternal(t, player, cardId) {
  if (!t || t.stage !== "pegging") return;
  if (t.gameOver || t.matchOver) return;
  if (t.turn !== player) return;

  const hand = t.pegHands[player] || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return;

  const card = hand[idx];
  const val = cardValue(card.rank);
  if (t.peg.count + val > 31) return;

  hand.splice(idx, 1);
  t.pegHands[player] = hand;

  t.peg.count += val;
  t.peg.pile.push(card);
  t.peg.lastPlayer = player;
  t.peg.go.PLAYER1 = false;
  t.peg.go.PLAYER2 = false;

  pushLog(t, `${player} plays ${card.rank}${card.suit}. Count=${t.peg.count}`);

  pegPointsAfterPlay(t, player, card);
  if (t.gameOver || t.matchOver) return;

  if (t.peg.count === 31) {
    resetPegCount(t);
    t.turn = otherPlayer(player);
    pushLog(t, `${t.turn} to play.`);
    return;
  }

  const opp = otherPlayer(player);

  if ((t.pegHands[opp]?.length || 0) === 0) {
    t.turn = player;

    // stall fix: if I'm blocked at this count, auto-end sequence and reset
    if (!canPlayAny(t.pegHands[player], t.peg.count) && t.peg.count > 0) {
      pushLog(t, `${player} blocked while opponent out — auto ending sequence.`);
      endSequenceAndContinue(t, player);
      return;
    }
  } else {
    t.turn = opp;
  }

  if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
    awardLastCardIfNeeded(t);
    scoreShowAndAdvance(t);
    return;
  }
}

function goInternal(t, player) {
  if (!t || t.stage !== "pegging") return;
  if (t.gameOver || t.matchOver) return;
  if (t.turn !== player) return;

  const opp = otherPlayer(player);

  // If I can play, GO is not allowed
  if (canPlayAny(t.pegHands[player], t.peg.count)) return;

  // Special case: opponent has 0 cards left.
  // If I'm blocked, end sequence, reset to 0, and I keep the lead.
  if ((t.pegHands[opp]?.length || 0) === 0) {
    pushLog(t, `${player} is blocked (opponent out) — ending sequence.`);
    endSequenceAndContinue(t, player);
    return;
  }

  // Normal GO behavior
  t.peg.go[player] = true;
  pushLog(t, `${player} says GO.`);

  if (canPlayAny(t.pegHands[opp], t.peg.count)) {
    t.turn = opp;
    pushLog(t, `${opp} to play.`);
    return;
  }

  const lead = t.peg.lastPlayer ? t.peg.lastPlayer : otherPlayer(t.dealer);
  endSequenceAndContinue(t, lead);
}

/** -------------------------
 * AI logic
 * ------------------------- */
function scheduleAi(t, reason = "") {
  if (!t?.ai?.enabled) return;
  if (t.matchOver) return;

  // never schedule if AI isn't seated as PLAYER2
  const aiSide = t.ai.side;

  setTimeout(() => {
    // Discard: AI can discard as soon as it has 6 cards and hasn't discarded yet
    if (t.stage === "discard") {
      if (t.discards[aiSide]?.length === 2) return;
      aiDiscardToCrib(t);
      emitState(t.id);
      // after AI discard, if both done it may enterPegging and AI may need to act
      if (t.stage === "pegging") scheduleAi(t, "after-discard");
      return;
    }

    // Pegging: if it's AI's turn, play until it is not
    if (t.stage === "pegging") {
      aiPeggingLoop(t);
      emitState(t.id);
      return;
    }
  }, 350);
}

function aiDiscardToCrib(t) {
  const aiSide = t.ai.side;
  const hand = t.hands[aiSide] || [];
  if (hand.length < 2) return;
  if (t.discards[aiSide]?.length === 2) return;

  // Naive: discard two lowest value cards
  const sorted = [...hand].sort((a, b) => {
    const va = cardValue(a.rank), vb = cardValue(b.rank);
    if (va !== vb) return va - vb;
    return rankNum(a.rank) - rankNum(b.rank);
  });
  const chosen = sorted.slice(0, 2);
  const ids = chosen.map(c => c.id);

  t.hands[aiSide] = t.hands[aiSide].filter(c => !ids.includes(c.id));
  t.pegHands[aiSide] = (t.pegHands[aiSide] || []).filter(c => !ids.includes(c.id));

  t.discards[aiSide] = chosen;
  t.crib.push(...chosen);

  pushLog(t, `${aiSide} discards 2 to crib.`);

  const p1Done = t.discards.PLAYER1.length === 2;
  const p2Done = t.discards.PLAYER2.length === 2;

  if (p1Done && p2Done && t.crib.length === 4) {
    enterPegging(t);
  }
}

function aiPeggingLoop(t) {
  const aiSide = t.ai.side;
  if (t.stage !== "pegging") return;
  if (t.turn !== aiSide) return;
  if (t.gameOver || t.matchOver) return;

  // Safety loop cap to avoid runaway
  for (let i = 0; i < 8; i++) {
    if (t.stage !== "pegging") return;
    if (t.turn !== aiSide) return;

    const hand = t.pegHands[aiSide] || [];
    const playable = hand.filter(c => cardValue(c.rank) + t.peg.count <= 31);

    if (playable.length === 0) {
      goInternal(t, aiSide);
      return;
    }

    // Naive: play the lowest legal card
    playable.sort((a, b) => {
      const va = cardValue(a.rank), vb = cardValue(b.rank);
      if (va !== vb) return va - vb;
      return rankNum(a.rank) - rankNum(b.rank);
    });

    playCardInternal(t, aiSide, playable[0].id);

    if (t.gameOver || t.matchOver) return;

    // If AI kept the turn (opponent out), it may continue; otherwise stop
    if (t.turn !== aiSide) return;
  }
}

/** -------------------------
 * Socket.IO
 * ------------------------- */
io.on("connection", (socket) => {

  socket.on("join_table", ({ tableId, name, ai }) => {
    tableId = (tableId || "JIM1").toString().trim().slice(0, 24);
    const t = ensureTable(tableId);

    const wantsAi = !!ai;

    // If table already has 2 humans, block
    // If AI enabled, we allow only PLAYER1 human + AI (no second human join)
    if (t.ai.enabled && t.players.PLAYER1 && t.players.PLAYER2) {
      return socket.emit("error_msg", "Table is full.");
    }

    // If someone tries to join as second human while AI enabled, deny
    if (t.ai.enabled && t.players.PLAYER1 && !t.players.PLAYER2) {
      // PLAYER2 is AI in this mode, so deny extra human
      return socket.emit("error_msg", "This table is set to play vs AI. Use a different table for 2-player.");
    }

    let me = null;

    if (!t.players.PLAYER1) {
      me = "PLAYER1";
    } else if (!t.players.PLAYER2 && !t.ai.enabled) {
      me = "PLAYER2";
    } else {
      return socket.emit("error_msg", "Table is full (2 players).");
    }

    // If PLAYER1 requests AI, enable AI and seat PLAYER2 as AI (no socket)
    if (me === "PLAYER1" && wantsAi) {
      t.ai.enabled = true;
      t.ai.side = "PLAYER2";
      t.ai.name = "AI Captain";

      // Seat AI name immediately
      t.names.PLAYER2 = t.ai.name;
      // Important: keep PLAYER2 socket as null
      t.players.PLAYER2 = null;

      pushLog(t, `AI enabled for this table (${t.ai.name}).`);
    }

    t.players[me] = socket.id;
    t.names[me] = sanitizeName(name, me);

    socket.tableId = tableId;
    socket.playerId = me;

    pushLog(t, `${t.names[me]} joined as ${me}.`);
    emitState(tableId);

    // Start hand when:
    // - two humans, OR
    // - PLAYER1 + AI enabled
    const ready = (t.players.PLAYER1 && (t.players.PLAYER2 || t.ai.enabled));
    if (ready && t.stage === "lobby" && !t.matchOver) {
      startHand(t);
      emitState(tableId);

      // If AI, let it discard
      if (t.ai.enabled) scheduleAi(t, "post-start");
    }
  });

  socket.on("discard_to_crib", ({ cardIds }) => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "discard") return;
    if (t.gameOver || t.matchOver) return;

    const me = socket.playerId;
    const ids = Array.isArray(cardIds) ? cardIds : [];
    if (!me || ids.length !== 2) return;

    const hand = t.hands[me] || [];
    const chosen = [];
    for (const id of ids) {
      const idx = hand.findIndex(c => c.id === id);
      if (idx === -1) return;
      chosen.push(hand[idx]);
    }

    t.hands[me] = t.hands[me].filter(c => !ids.includes(c.id));
    t.pegHands[me] = (t.pegHands[me] || []).filter(c => !ids.includes(c.id));

    t.discards[me] = chosen;
    t.crib.push(...chosen);

    pushLog(t, `${me} discards 2 to crib.`);

    const p1Done = t.discards.PLAYER1.length === 2;
    const p2Done = t.discards.PLAYER2.length === 2;

    if (p1Done && p2Done && t.crib.length === 4) {
      enterPegging(t);
    }

    emitState(socket.tableId);

    // If AI is enabled, it might need to act now
    if (t.ai.enabled) scheduleAi(t, "after-human-discard");
  });

  socket.on("play_card", ({ cardId }) => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "pegging") return;
    if (t.gameOver || t.matchOver) return;

    const me = socket.playerId;
    if (!me) return;

    playCardInternal(t, me, cardId);

    emitState(socket.tableId);

    if (t.ai.enabled) scheduleAi(t, "after-human-play");
  });

  socket.on("go", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "pegging") return;
    if (t.gameOver || t.matchOver) return;

    const me = socket.playerId;
    if (!me) return;

    goInternal(t, me);

    emitState(socket.tableId);

    if (t.ai.enabled) scheduleAi(t, "after-human-go");
  });

  socket.on("next_hand", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "show") return;

    if (t.gameOver || t.matchOver) return;

    t.dealer = otherPlayer(t.dealer);
    if (t.players.PLAYER1 && (t.players.PLAYER2 || t.ai.enabled)) {
      startHand(t);
      emitState(socket.tableId);
      if (t.ai.enabled) scheduleAi(t, "next-hand");
    }
  });

  socket.on("next_game", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    if (!t.gameOver || t.matchOver) return;
    resetForNewGame(t);
    emitState(socket.tableId);
    if (t.ai.enabled) scheduleAi(t, "next-game");
  });

  socket.on("new_match", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    resetForNewMatch(t);
    emitState(socket.tableId);
    if (t.ai.enabled) scheduleAi(t, "new-match");
  });

  socket.on("disconnect", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (me && t.players[me] === socket.id) {
      t.players[me] = null;
      pushLog(t, `${t.names[me]} disconnected.`);
    }

    // If PLAYER1 leaves an AI table, keep AI enabled but game will wait for PLAYER1 to rejoin
    emitState(socket.tableId);
  });
});
