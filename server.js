// Pirate Cribbage PLUS AI - discard -> pegging -> show
// Includes:
// - Names via join overlay
// - Optional vs-AI mode (PLAYER2 is internal AI seat)
// - Pegging scoring: 15/31, pairs, runs, last card
// - Show scoring breakdown: 15s/pairs/runs/flush/nobs
// - Fix: no-stall when opponent is out of cards and remaining player is blocked
// - Game ends at 121 (no dealing past 121); match wins tracked (first to 3)
// - GO events preserved for UI (lastGoEvent) and AI pauses after GO so clients see it

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

function pushLog(t, msg) {
  t.log.push(msg);
  if (t.log.length > 160) t.log.shift();
}

function canPlayAny(hand, count) {
  return (hand || []).some(c => cardValue(c.rank) + count <= 31);
}

function hasTwoSeats(t) {
  // seat 1 must be a real socket; seat 2 can be socket OR AI seat
  const p1 = !!t.players.PLAYER1;
  const p2 = !!t.players.PLAYER2 || !!t.ai.enabled;
  return p1 && p2;
}

function ensureTable(tableId) {
  if (!tables[tableId]) {
    tables[tableId] = {
      id: tableId,

      players: { PLAYER1: null, PLAYER2: null }, // socket ids (AI uses null)
      names:   { PLAYER1: "PLAYER1", PLAYER2: "PLAYER2" },

      ai: { enabled: false, name: "AI Captain" },

      dealer: "PLAYER1",
      stage: "lobby", // lobby | discard | pegging | show
      turn: "PLAYER1",

      deck: [],
      cut: null,
      crib: [],

      hands:    { PLAYER1: [], PLAYER2: [] }, // preserved for show (4 cards)
      pegHands: { PLAYER1: [], PLAYER2: [] }, // consumed during pegging

      discards: { PLAYER1: [], PLAYER2: [] },

      peg: {
        count: 0,
        pile: [],
        lastPlayer: null,
        go: { PLAYER1: false, PLAYER2: false }
      },

      scores: { PLAYER1: 0, PLAYER2: 0 }, // game score to 121

      matchWins: { PLAYER1: 0, PLAYER2: 0 },
      matchTarget: MATCH_TARGET_WINS,
      gameTarget: GAME_TARGET,

      gameOver: false,
      gameWinner: null,
      matchOver: false,
      matchWinner: null,

      show: null,             // show breakdown payload
      lastPegEvent: null,     // { player, pts, reasons[] }
      lastGoEvent: null,      // { player }  (for UI)

      log: []
    };
  }
  return tables[tableId];
}

/** -------------------------
 * Public state
 * ------------------------- */
function publicStateFor(t, me) {
  const handForUI = (t.stage === "pegging") ? (t.pegHands[me] || []) : (t.hands[me] || []);

  const p1Name = t.players.PLAYER1 ? t.names.PLAYER1 : null;
  const p2Name = (t.players.PLAYER2 ? t.names.PLAYER2 : (t.ai.enabled ? t.ai.name : null));

  return {
    tableId: t.id,
    stage: t.stage,
    dealer: t.dealer,
    turn: t.turn,
    cut: t.cut,

    scores: t.scores,

    matchWins: t.matchWins,
    matchTarget: t.matchTarget,
    gameTarget: t.gameTarget,
    gameOver: t.gameOver,
    gameWinner: t.gameWinner,
    matchOver: t.matchOver,
    matchWinner: t.matchWinner,

    names: t.names,
    ai: { enabled: t.ai.enabled, name: t.ai.name },

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
    lastGoEvent: t.lastGoEvent,
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

    pushLog(t, `🏁 GAME OVER — ${t.names[t.gameWinner]} wins (${t.scores.PLAYER1}–${t.scores.PLAYER2}).`);

    if (t.matchWins[t.gameWinner] >= t.matchTarget) {
      t.matchOver = true;
      t.matchWinner = t.gameWinner;
      pushLog(t, `🏴‍☠️ MATCH OVER — ${t.names[t.matchWinner]} wins the match!`);
    }
  }
}

function resetForNewGame(t) {
  t.scores = { PLAYER1: 0, PLAYER2: 0 };
  t.gameOver = false;
  t.gameWinner = null;
  t.show = null;
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  t.dealer = otherPlayer(t.dealer);
  t.stage = "lobby";
  t.turn = t.dealer;

  pushLog(t, `⚓ New game begins. Starting dealer: ${t.dealer} (${t.names[t.dealer]}).`);

  if (hasTwoSeats(t) && !t.matchOver) {
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
  t.lastGoEvent = null;

  t.dealer = "PLAYER1";
  t.stage = "lobby";
  t.turn = "PLAYER1";

  pushLog(t, `🧭 New match started (first to ${t.matchTarget} wins).`);

  if (hasTwoSeats(t)) {
    startHand(t);
  }
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
  t.lastGoEvent = null;

  t.discards = { PLAYER1: [], PLAYER2: [] };
  t.peg = { count: 0, pile: [], lastPlayer: null, go: { PLAYER1: false, PLAYER2: false } };

  const p1 = t.deck.splice(0, 6);
  const p2 = t.deck.splice(0, 6);

  t.hands.PLAYER1 = [...p1];
  t.hands.PLAYER2 = [...p2];
  t.pegHands.PLAYER1 = [...p1];
  t.pegHands.PLAYER2 = [...p2];

  t.turn = t.dealer;
  pushLog(t, `New hand. Dealer: ${t.dealer} (${t.names[t.dealer]}).`);
}

function enterPegging(t) {
  t.stage = "pegging";
  t.cut = t.deck.splice(0, 1)[0];
  t.lastPegEvent = null;
  t.lastGoEvent = null;

  pushLog(t, `Cut: ${t.cut.rank}${t.cut.suit}`);

  t.pegHands.PLAYER1 = [...t.hands.PLAYER1];
  t.pegHands.PLAYER2 = [...t.hands.PLAYER2];

  t.turn = otherPlayer(t.dealer);
  t.peg = { count: 0, pile: [], lastPlayer: null, go: { PLAYER1: false, PLAYER2: false } };

  pushLog(t, `Pegging starts. ${t.turn} to play.`);
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
 * Internal action handlers (used by sockets + AI)
 * ------------------------- */
function handleDiscardToCrib(t, player, cardIds) {
  if (!t || t.stage !== "discard") return false;
  if (t.gameOver || t.matchOver) return false;

  const ids = Array.isArray(cardIds) ? cardIds : [];
  if (!ids || ids.length !== 2) return false;

  const hand = t.hands[player] || [];
  const chosen = [];
  for (const id of ids) {
    const idx = hand.findIndex(c => c.id === id);
    if (idx === -1) return false;
    chosen.push(hand[idx]);
  }

  t.hands[player] = t.hands[player].filter(c => !ids.includes(c.id));
  t.pegHands[player] = t.pegHands[player].filter(c => !ids.includes(c.id));

  t.discards[player] = chosen;
  t.crib.push(...chosen);

  pushLog(t, `${player} discards 2 to crib.`);

  const p1Done = t.discards.PLAYER1.length === 2;
  const p2Done = t.discards.PLAYER2.length === 2;

  if (p1Done && p2Done && t.crib.length === 4) enterPegging(t);
  return true;
}

function handlePlayCard(t, player, cardId) {
  if (!t || t.stage !== "pegging") return false;
  if (t.gameOver || t.matchOver) return false;
  if (t.turn !== player) return false;

  const hand = t.pegHands[player] || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  const card = hand[idx];
  const val = cardValue(card.rank);
  if (t.peg.count + val > 31) return false;

  // play it
  hand.splice(idx, 1);
  t.pegHands[player] = hand;

  t.peg.count += val;
  t.peg.pile.push(card);
  t.peg.lastPlayer = player;
  t.peg.go.PLAYER1 = false;
  t.peg.go.PLAYER2 = false;

  // clear lastGoEvent once a card is played (GO toast already shown)
  t.lastGoEvent = null;

  pushLog(t, `${player} plays ${card.rank}${card.suit}. Count=${t.peg.count}`);

  // scoring
  pegPointsAfterPlay(t, player, card);
  if (t.gameOver || t.matchOver) return true;

  // handle 31
  if (t.peg.count === 31) {
    resetPegCount(t);
    t.turn = otherPlayer(player);
    pushLog(t, `${t.turn} to play.`);
    return true;
  }

  const opp = otherPlayer(player);

  // opponent has 0 cards: current player keeps turn if possible
  if ((t.pegHands[opp]?.length || 0) === 0) {
    t.turn = player;
    if (!canPlayAny(t.pegHands[player], t.peg.count) && t.peg.count > 0) {
      pushLog(t, `${player} blocked while opponent out — auto ending sequence.`);
      endSequenceAndContinue(t, player);
      return true;
    }
  } else {
    t.turn = opp;
  }

  // pegging over?
  if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
    awardLastCardIfNeeded(t);
    scoreShowAndAdvance(t);
  }

  return true;
}

function handleGo(t, player) {
  if (!t || t.stage !== "pegging") return false;
  if (t.gameOver || t.matchOver) return false;
  if (t.turn !== player) return false;

  const opp = otherPlayer(player);

  // If player can play, GO not allowed
  if (canPlayAny(t.pegHands[player], t.peg.count)) return false;

  // record GO for UI
  t.lastGoEvent = { player };
  pushLog(t, `${player} says GO.`);

  // special: opponent out of cards; end sequence, reset to 0, same player leads
  if ((t.pegHands[opp]?.length || 0) === 0) {
    pushLog(t, `${player} is blocked (opponent out) — ending sequence.`);
    endSequenceAndContinue(t, player);
    return true;
  }

  // If opponent can play, pass turn
  if (canPlayAny(t.pegHands[opp], t.peg.count)) {
    t.turn = opp;
    pushLog(t, `${opp} to play.`);
    return true;
  }

  // both cannot play -> end sequence, reset
  const lead = t.peg.lastPlayer ? t.peg.lastPlayer : otherPlayer(t.dealer);
  endSequenceAndContinue(t, lead);
  return true;
}

/** -------------------------
 * AI logic
 * ------------------------- */
function aiChooseDiscard(hand6) {
  // simple: discard two random for now (keeps behavior stable)
  if (!hand6 || hand6.length < 2) return [];
  const copy = [...hand6];
  shuffle(copy);
  return [copy[0].id, copy[1].id];
}

function aiChoosePegCard(hand, count) {
  const playable = (hand || []).filter(c => cardValue(c.rank) + count <= 31);
  if (!playable.length) return null;
  // simple: play the lowest value to be slightly sensible
  playable.sort((a, b) => cardValue(a.rank) - cardValue(b.rank));
  return playable[0].id;
}

function maybeRunAITurns(tableId) {
  const t = tables[tableId];
  if (!t || !t.ai.enabled) return;
  if (t.gameOver || t.matchOver) return;

  // guard: AI is always PLAYER2 in this implementation
  const AI = "PLAYER2";

  // avoid infinite loops
  for (let step = 0; step < 40; step++) {
    if (t.gameOver || t.matchOver) break;

    if (t.stage === "discard") {
      // AI should discard once it has its 6 and hasn't discarded yet
      if (t.discards[AI].length < 2 && (t.hands[AI] || []).length === 6) {
        const ids = aiChooseDiscard(t.hands[AI]);
        if (ids.length === 2) {
          handleDiscardToCrib(t, AI, ids);
          emitState(tableId);
          continue;
        }
      }
      break;
    }

    if (t.stage === "pegging") {
      if (t.turn !== AI) break;

      const count = t.peg.count;
      const hand = t.pegHands[AI] || [];
      const cardId = aiChoosePegCard(hand, count);

      if (cardId) {
        handlePlayCard(t, AI, cardId);
        emitState(tableId);
        continue;
      } else {
        // IMPORTANT: after AI GO, EMIT and STOP so the client actually sees the GO event.
        handleGo(t, AI);
        emitState(tableId);
        break;
      }
    }

    // AI does nothing in show; player clicks Next Hand
    break;
  }
}

/** -------------------------
 * Socket.IO
 * ------------------------- */
io.on("connection", (socket) => {

  socket.on("join_table", ({ tableId, name, vsAI }) => {
    tableId = (tableId || "JIM1").toString().trim().slice(0, 24);
    const t = ensureTable(tableId);

    // assign seat
    let me = null;
    if (!t.players.PLAYER1) me = "PLAYER1";
    else if (!t.players.PLAYER2 && !t.ai.enabled) me = "PLAYER2";
    else return socket.emit("error_msg", "Table is full (2 seats already in use).");

    t.players[me] = socket.id;
    t.names[me] = sanitizeName(name, me);

    // AI toggle only allowed when PLAYER1 joins
    if (me === "PLAYER1") {
      t.ai.enabled = !!vsAI;
      t.ai.name = "AI Captain";
      if (t.ai.enabled) {
        t.names.PLAYER2 = t.ai.name;
        t.players.PLAYER2 = null; // AI seat uses no socket id
        pushLog(t, `🤖 AI enabled: ${t.ai.name} joins as PLAYER2.`);
      } else {
        // if AI turned off, clear AI seat name back to default unless a real player joins later
        t.names.PLAYER2 = "PLAYER2";
      }
    }

    socket.tableId = tableId;
    socket.playerId = me;

    pushLog(t, `${t.names[me]} joined as ${me}.`);
    emitState(tableId);

    if (hasTwoSeats(t) && t.stage === "lobby" && !t.matchOver) {
      startHand(t);
      emitState(tableId);
      // AI might need to discard immediately
      maybeRunAITurns(tableId);
    }
  });

  socket.on("discard_to_crib", ({ cardIds }) => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (!me) return;

    const ok = handleDiscardToCrib(t, me, cardIds);
    if (!ok) return;

    emitState(socket.tableId);
    maybeRunAITurns(socket.tableId);
  });

  socket.on("play_card", ({ cardId }) => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (!me) return;

    const ok = handlePlayCard(t, me, cardId);
    if (!ok) return;

    emitState(socket.tableId);
    maybeRunAITurns(socket.tableId);
  });

  socket.on("go", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (!me) return;

    const ok = handleGo(t, me);
    if (!ok) return;

    // Emit immediately so UI can show "Opponent said GO" reliably.
    emitState(socket.tableId);

    // Then let AI react on its turn.
    maybeRunAITurns(socket.tableId);
  });

  socket.on("next_hand", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "show") return;
    if (t.gameOver || t.matchOver) return;

    t.dealer = otherPlayer(t.dealer);
    if (hasTwoSeats(t)) {
      startHand(t);
      emitState(socket.tableId);
      maybeRunAITurns(socket.tableId);
    }
  });

  socket.on("next_game", () => {
    const t = tables[socket.tableId];
    if (!t) return;
    if (!t.gameOver || t.matchOver) return;

    resetForNewGame(t);
    emitState(socket.tableId);
    maybeRunAITurns(socket.tableId);
  });

  socket.on("new_match", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    resetForNewMatch(t);
    emitState(socket.tableId);
    maybeRunAITurns(socket.tableId);
  });

  socket.on("disconnect", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (me && t.players[me] === socket.id) {
      t.players[me] = null;
      pushLog(t, `${t.names[me]} disconnected.`);
    }

    // If PLAYER1 disconnects, disable AI + clear table to lobby-ish.
    if (me === "PLAYER1") {
      t.ai.enabled = false;
      t.players.PLAYER2 = null;
      t.names.PLAYER2 = "PLAYER2";
    }

    emitState(socket.tableId);
  });
});
