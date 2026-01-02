// Pirate Cribbage (PlusAI) - discard -> pegging -> show
// Includes:
// - Names via join overlay (+ optional Play vs AI)
// - AI plays discard + pegging automatically (prevents stalls)
// - Pegging scoring: 15/31, pairs, runs, last card
// - Show scoring breakdown: 15s/pairs/runs/flush/nobs
// - Fix: no-stall when opponent out of cards and remaining player blocked
// - Game ends at 121 (no dealing past 121); match wins tracked (first to 3)
// - Next game + new match
// - Emits richer state for UI (gameOver/matchOver/winners + lastGo event)

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

      players: { PLAYER1: null, PLAYER2: null },  // socket ids (AI has null)
      names:   { PLAYER1: "PLAYER1", PLAYER2: "PLAYER2" },

      ai: {
        enabled: false,
        playerId: "PLAYER2",
        thinking: false
      },

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
        go: { PLAYER1: false, PLAYER2: false },
        lastGo: null // { player, name }
      },

      scores: { PLAYER1: 0, PLAYER2: 0 },         // game score to 121

      matchWins: { PLAYER1: 0, PLAYER2: 0 },
      matchTarget: MATCH_TARGET_WINS,
      gameTarget: GAME_TARGET,

      gameOver: false,
      gameWinner: null,
      matchOver: false,
      matchWinner: null,

      show: null,
      lastPegEvent: null, // { player, pts, reasons[] }

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

  const p1Name = t.names.PLAYER1;
  const p2Name = t.ai.enabled ? t.names[t.ai.playerId] : t.names.PLAYER2;

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

    names: {
      PLAYER1: p1Name,
      PLAYER2: p2Name
    },

    players: {
      PLAYER1: t.players.PLAYER1 ? p1Name : null,
      PLAYER2: (t.players.PLAYER2 || t.ai.enabled) ? p2Name : null
    },

    aiEnabled: t.ai.enabled,

    cribCount: t.crib.length,
    discardsCount: {
      PLAYER1: t.discards.PLAYER1.length,
      PLAYER2: t.discards.PLAYER2.length
    },

    peg: {
      count: t.peg.count,
      pile: t.peg.pile.map(c => ({ id: c.id, rank: c.rank, suit: c.suit })),
      lastPlayer: t.peg.lastPlayer,
      go: t.peg.go,
      lastGo: t.peg.lastGo
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
  // Emit only to connected human sockets
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

    pushLog(t, `🏁 GAME OVER — ${t.names[t.gameWinner]} wins (${t.names.PLAYER1} ${t.scores.PLAYER1}–${t.names.PLAYER2} ${t.scores.PLAYER2}).`);

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

  t.dealer = otherPlayer(t.dealer);
  t.stage = "lobby";
  t.turn = t.dealer;

  pushLog(t, `⚓ New game begins. Starting dealer: ${t.names[t.dealer]}.`);

  if (tableHasReadyPlayers(t) && !t.matchOver) {
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

  if (tableHasReadyPlayers(t)) {
    startHand(t);
  }
}

function tableHasReadyPlayers(t) {
  if (t.ai.enabled) return !!t.players.PLAYER1; // single human + AI
  return !!t.players.PLAYER1 && !!t.players.PLAYER2;
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
  t.peg = { count: 0, pile: [], lastPlayer: null, go: { PLAYER1: false, PLAYER2: false }, lastGo: null };

  const p1 = t.deck.splice(0, 6);
  const p2 = t.deck.splice(0, 6);

  t.hands.PLAYER1 = [...p1];
  t.hands.PLAYER2 = [...p2];
  t.pegHands.PLAYER1 = [...p1];
  t.pegHands.PLAYER2 = [...p2];

  t.turn = t.dealer;

  pushLog(t, `New hand. Dealer: ${t.names[t.dealer]}.`);
}

function enterPegging(t) {
  t.stage = "pegging";
  t.cut = t.deck.splice(0, 1)[0];
  t.lastPegEvent = null;
  t.peg.lastGo = null;

  pushLog(t, `Cut: ${t.cut.rank}${t.cut.suit}`);

  t.pegHands.PLAYER1 = [...t.hands.PLAYER1];
  t.pegHands.PLAYER2 = [...t.hands.PLAYER2];

  t.turn = otherPlayer(t.dealer);
  t.peg = { count: 0, pile: [], lastPlayer: null, go: { PLAYER1: false, PLAYER2: false }, lastGo: null };

  pushLog(t, `Pegging starts. ${t.names[t.turn]} to play.`);
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
    pushLog(t, `${t.names[player]} scores ${pts} pegging point(s) (${reasons.join(", ")}).`);
    checkGameEnd(t);
  }

  return pts;
}

function awardLastCardIfNeeded(t) {
  if (t.peg.count !== 0 && t.peg.count !== 31 && t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
    t.lastPegEvent = { player: t.peg.lastPlayer, pts: 1, reasons: ["last card for 1"] };
    pushLog(t, `${t.names[t.peg.lastPlayer]} scores 1 for last card.`);
    checkGameEnd(t);
  }
}

function resetPegCount(t) {
  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.lastPlayer = null;
  t.peg.go = { PLAYER1: false, PLAYER2: false };
  t.peg.lastGo = null;
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
  pushLog(t, `${t.names[t.turn]} to play.`);
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
  if (fif.count > 0) items.push({ label: `${fif.count} fifteen${fif.count === 1 ? "" : "s"}`, pts: fif.pts });

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

  pushLog(t, `SHOW: ${t.names[nonDealer]} +${nonBD.total}, ${t.names[dealer]} +${deaBD.total}, crib +${cribBD.total}`);
  t.stage = "show";

  checkGameEnd(t);
}

/** -------------------------
 * AI helpers (prevents stalls)
 * ------------------------- */
function scheduleAi(t) {
  if (!t.ai.enabled) return;
  if (t.ai.thinking) return;
  if (t.gameOver || t.matchOver) return;

  // Only act when it's AI's "turn" or AI must discard in discard stage
  const aiP = t.ai.playerId;

  const shouldAct =
    (t.stage === "discard") ||
    (t.stage === "pegging" && t.turn === aiP);

  if (!shouldAct) return;

  t.ai.thinking = true;
  setTimeout(() => {
    try {
      aiStep(t);
    } finally {
      t.ai.thinking = false;
      emitState(t.id);
      // If still AI’s turn/stage needs more, keep going
      scheduleAi(t);
    }
  }, 280);
}

function aiPickDiscardTwo(t) {
  const aiP = t.ai.playerId;
  const hand = t.hands[aiP] || [];
  if (hand.length < 2) return [];
  // Simple: discard two random
  const idxs = shuffle([...hand.map((_, i) => i)]).slice(0, 2).sort((a,b)=>b-a);
  return idxs.map(i => hand[i].id);
}

function aiChoosePegCard(t) {
  const aiP = t.ai.playerId;
  const hand = t.pegHands[aiP] || [];
  const count = t.peg.count;

  const playable = hand.filter(c => count + cardValue(c.rank) <= 31);
  if (playable.length === 0) return null;

  // Greedy: choose card that yields max immediate points; tie-breaker: lowest value
  let best = playable[0];
  let bestScore = -1;

  for (const c of playable) {
    // simulate
    const fakePile = t.peg.pile.concat([c]);
    const fakeCount = count + cardValue(c.rank);

    let pts = 0;
    if (fakeCount === 15) pts += 2;
    if (fakeCount === 31) pts += 2;

    // pairs
    let same = 1;
    for (let i = fakePile.length - 2; i >= 0; i--) {
      if (fakePile[i].rank === c.rank) same++;
      else break;
    }
    if (same === 2) pts += 2;
    else if (same === 3) pts += 6;
    else if (same === 4) pts += 12;

    // runs
    const runPts = peggingRunPoints(fakePile);
    if (runPts >= 3) pts += runPts;

    const v = cardValue(c.rank);
    const tie = (pts === bestScore) ? (v < cardValue(best.rank)) : false;

    if (pts > bestScore || tie) {
      bestScore = pts;
      best = c;
    }
  }

  return best.id;
}

function aiStep(t) {
  if (!t.ai.enabled) return;
  if (t.gameOver || t.matchOver) return;

  const aiP = t.ai.playerId;
  const humanP = otherPlayer(aiP);

  // DISCARDS: AI must discard as soon as possible
  if (t.stage === "discard") {
    const aiDone = t.discards[aiP].length === 2;
    if (!aiDone) {
      const ids = (() => {
        const hand = t.hands[aiP] || [];
        if (hand.length < 2) return [];
        // pick 2 lowest values (slightly smarter)
        const sorted = [...hand].sort((a, b) => cardValue(a.rank) - cardValue(b.rank));
        return [sorted[0].id, sorted[1].id];
      })();

      if (ids.length === 2) {
        // perform discard (server-side equivalent)
        const hand = t.hands[aiP];
        const chosen = [];
        for (const id of ids) {
          const idx = hand.findIndex(c => c.id === id);
          if (idx === -1) return;
          chosen.push(hand[idx]);
        }
        t.hands[aiP] = t.hands[aiP].filter(c => !ids.includes(c.id));
        t.pegHands[aiP] = t.pegHands[aiP].filter(c => !ids.includes(c.id));
        t.discards[aiP] = chosen;
        t.crib.push(...chosen);

        pushLog(t, `${t.names[aiP]} discards 2 to crib.`);
      }
    }

    const humanDone = t.discards[humanP].length === 2;
    const bothDone = humanDone && (t.discards[aiP].length === 2) && t.crib.length === 4;
    if (bothDone) {
      enterPegging(t);
    }
    return;
  }

  // PEGGING: act if it is AI's turn
  if (t.stage === "pegging" && t.turn === aiP) {
    const hand = t.pegHands[aiP] || [];
    const count = t.peg.count;

    // If no cards left, AI can't act; let the existing stall fixes resolve sequences
    if (hand.length === 0) {
      // If both are out, finalize
      if ((t.pegHands.PLAYER1.length === 0) && (t.pegHands.PLAYER2.length === 0)) {
        awardLastCardIfNeeded(t);
        scoreShowAndAdvance(t);
      }
      return;
    }

    const cardId = aiChoosePegCard(t);
    if (!cardId) {
      // SAY GO
      if (canPlayAny(hand, count)) return; // sanity
      t.peg.go[aiP] = true;
      t.peg.lastGo = { player: aiP, name: t.names[aiP] };
      pushLog(t, `${t.names[aiP]} says GO.`);

      // If opponent can play, pass
      if (canPlayAny(t.pegHands[humanP], count)) {
        t.turn = humanP;
        pushLog(t, `${t.names[humanP]} to play.`);
        return;
      }

      // Both can't play -> end sequence; lead = lastPlayer or non-dealer
      const lead = t.peg.lastPlayer ? t.peg.lastPlayer : otherPlayer(t.dealer);
      endSequenceAndContinue(t, lead);
      return;
    }

    // PLAY CARD (same as play_card handler)
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;

    const card = hand[idx];
    const val = cardValue(card.rank);
    if (t.peg.count + val > 31) return;

    hand.splice(idx, 1);
    t.pegHands[aiP] = hand;

    t.peg.count += val;
    t.peg.pile.push(card);
    t.peg.lastPlayer = aiP;
    t.peg.go.PLAYER1 = false;
    t.peg.go.PLAYER2 = false;
    t.peg.lastGo = null;

    pushLog(t, `${t.names[aiP]} plays ${card.rank}${card.suit}. Count=${t.peg.count}`);

    pegPointsAfterPlay(t, aiP, card);
    if (t.gameOver || t.matchOver) return;

    if (t.peg.count === 31) {
      resetPegCount(t);
      t.turn = humanP;
      pushLog(t, `${t.names[t.turn]} to play.`);
      return;
    }

    // Pass turn (or keep if opponent out)
    if ((t.pegHands[humanP]?.length || 0) === 0) {
      t.turn = aiP;
      if (!canPlayAny(t.pegHands[aiP], t.peg.count) && t.peg.count > 0) {
        pushLog(t, `${t.names[aiP]} blocked while opponent out — auto ending sequence.`);
        endSequenceAndContinue(t, aiP);
      }
    } else {
      t.turn = humanP;
    }

    if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
      awardLastCardIfNeeded(t);
      scoreShowAndAdvance(t);
    }
    return;
  }
}

/** -------------------------
 * Socket.IO
 * ------------------------- */
io.on("connection", (socket) => {

  socket.on("join_table", ({ tableId, name, vsAi }) => {
    tableId = (tableId || "JIM1").toString().trim().slice(0, 24);
    const t = ensureTable(tableId);

    // Decide seat
    let me = null;
    if (!t.players.PLAYER1) me = "PLAYER1";
    else if (!t.players.PLAYER2 && !t.ai.enabled) me = "PLAYER2";
    else return socket.emit("error_msg", "Table is full (2 players).");

    // If joining as PLAYER2, do not allow vsAi toggle
    const enableAi = !!vsAi && me === "PLAYER1";

    t.players[me] = socket.id;
    t.names[me] = sanitizeName(name, me);

    socket.tableId = tableId;
    socket.playerId = me;

    // Enable AI if requested
    if (enableAi) {
      t.ai.enabled = true;
      t.ai.playerId = "PLAYER2";
      t.names.PLAYER2 = "AI Captain";
      t.players.PLAYER2 = null; // AI has no socket
      pushLog(t, `🤖 AI opponent enabled: ${t.names.PLAYER2}.`);
    }

    pushLog(t, `${t.names[me]} joined as ${me}.`);
    emitState(tableId);

    if (t.stage === "lobby" && tableHasReadyPlayers(t) && !t.matchOver) {
      startHand(t);
      emitState(tableId);
      scheduleAi(t);
    } else {
      // If AI is enabled and we’re already in discard/pegging, make sure AI continues
      scheduleAi(t);
    }
  });

  socket.on("discard_to_crib", ({ cardIds }) => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "discard") return;
    if (t.gameOver || t.matchOver) return;

    const me = socket.playerId;
    const ids = Array.isArray(cardIds) ? cardIds : [];
    if (!me || ids.length !== 2) return;

    const hand = t.hands[me];
    const chosen = [];
    for (const id of ids) {
      const idx = hand.findIndex(c => c.id === id);
      if (idx === -1) return;
      chosen.push(hand[idx]);
    }

    t.hands[me] = t.hands[me].filter(c => !ids.includes(c.id));
    t.pegHands[me] = t.pegHands[me].filter(c => !ids.includes(c.id));

    t.discards[me] = chosen;
    t.crib.push(...chosen);

    pushLog(t, `${t.names[me]} discards 2 to crib.`);

    const p1Done = t.discards.PLAYER1.length === 2;
    const p2Done = t.discards.PLAYER2.length === 2;

    if (p1Done && p2Done && t.crib.length === 4) enterPegging(t);

    emitState(socket.tableId);
    scheduleAi(t);
  });

  socket.on("play_card", ({ cardId }) => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "pegging") return;
    if (t.gameOver || t.matchOver) return;

    const me = socket.playerId;
    if (!me || t.turn !== me) return;

    const hand = t.pegHands[me] || [];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;

    const card = hand[idx];
    const val = cardValue(card.rank);
    if (t.peg.count + val > 31) return;

    hand.splice(idx, 1);
    t.pegHands[me] = hand;

    t.peg.count += val;
    t.peg.pile.push(card);
    t.peg.lastPlayer = me;
    t.peg.go.PLAYER1 = false;
    t.peg.go.PLAYER2 = false;
    t.peg.lastGo = null;

    pushLog(t, `${t.names[me]} plays ${card.rank}${card.suit}. Count=${t.peg.count}`);

    pegPointsAfterPlay(t, me, card);
    if (t.gameOver || t.matchOver) {
      emitState(socket.tableId);
      return;
    }

    if (t.peg.count === 31) {
      resetPegCount(t);
      t.turn = otherPlayer(me);
      pushLog(t, `${t.names[t.turn]} to play.`);
      emitState(socket.tableId);
      scheduleAi(t);
      return;
    }

    const opp = otherPlayer(me);

    if ((t.pegHands[opp]?.length || 0) === 0) {
      t.turn = me;

      if (!canPlayAny(t.pegHands[me], t.peg.count) && t.peg.count > 0) {
        pushLog(t, `${t.names[me]} blocked while opponent out — auto ending sequence.`);
        endSequenceAndContinue(t, me);
        emitState(socket.tableId);
        scheduleAi(t);
        return;
      }
    } else {
      t.turn = opp;
    }

    if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
      awardLastCardIfNeeded(t);
      scoreShowAndAdvance(t);
    }

    emitState(socket.tableId);
    scheduleAi(t);
  });

  socket.on("go", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "pegging") return;
    if (t.gameOver || t.matchOver) return;

    const me = socket.playerId;
    if (!me || t.turn !== me) return;

    const opp = otherPlayer(me);

    if (canPlayAny(t.pegHands[me], t.peg.count)) return;

    // Obvious GO event
    t.peg.go[me] = true;
    t.peg.lastGo = { player: me, name: t.names[me] };
    pushLog(t, `${t.names[me]} says GO.`);

    // Special case: opponent out
    if ((t.pegHands[opp]?.length || 0) === 0) {
      pushLog(t, `${t.names[me]} is blocked (opponent out) — ending sequence.`);
      endSequenceAndContinue(t, me);
      emitState(socket.tableId);
      scheduleAi(t);
      return;
    }

    if (canPlayAny(t.pegHands[opp], t.peg.count)) {
      t.turn = opp;
      pushLog(t, `${t.names[opp]} to play.`);
      emitState(socket.tableId);
      scheduleAi(t);
      return;
    }

    const lead = t.peg.lastPlayer ? t.peg.lastPlayer : otherPlayer(t.dealer);
    endSequenceAndContinue(t, lead);

    emitState(socket.tableId);
    scheduleAi(t);
  });

  socket.on("next_hand", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "show") return;

    // No dealing past 121
    if (t.gameOver || t.matchOver) return;

    t.dealer = otherPlayer(t.dealer);

    if (tableHasReadyPlayers(t)) {
      startHand(t);
      emitState(socket.tableId);
      scheduleAi(t);
    }
  });

  socket.on("next_game", () => {
    const t = tables[socket.tableId];
    if (!t) return;
    if (!t.gameOver || t.matchOver) return;
    resetForNewGame(t);
    emitState(socket.tableId);
    scheduleAi(t);
  });

  socket.on("new_match", () => {
    const t = tables[socket.tableId];
    if (!t) return;
    resetForNewMatch(t);
    emitState(socket.tableId);
    scheduleAi(t);
  });

  socket.on("disconnect", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (me && t.players[me] === socket.id) {
      t.players[me] = null;
      pushLog(t, `${t.names[me]} disconnected.`);
    }

    // If PLAYER1 leaves, keep table but AI won't run
    emitState(socket.tableId);
  });
});
