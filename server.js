// Pirate Cribbage (2P + optional AI)
// Flow: lobby -> discard -> pegging -> show
// Includes:
// - Names via join overlay
// - Optional AI opponent (PLAYER2) when vsAI is checked
// - Pegging scoring: 15/31, pairs, runs, last card
// - Show scoring breakdown: 15s/pairs/runs/flush/nobs
// - Fixes: stall prevention (including vs AI), GO handling, game ends at 121+
// - Match wins tracking (first to 3)

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

      players: { PLAYER1: null, PLAYER2: null }, // socket ids (null for AI)
      isAI:    { PLAYER1: false, PLAYER2: false },
      names:   { PLAYER1: "PLAYER1", PLAYER2: "PLAYER2" },

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

      scores: { PLAYER1: 0, PLAYER2: 0 }, // game score

      // match
      matchWins: { PLAYER1: 0, PLAYER2: 0 },
      matchTarget: MATCH_TARGET_WINS,
      gameTarget: GAME_TARGET,

      gameOver: false,
      gameWinner: null,
      matchOver: false,
      matchWinner: null,

      show: null,
      lastPegEvent: null, // { player, pts, reasons[] }
      lastGoEvent: null,  // { player }

      log: [] // kept internally; UI log removed
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

  const p1Present = !!t.players.PLAYER1 || t.isAI.PLAYER1;
  const p2Present = !!t.players.PLAYER2 || t.isAI.PLAYER2;

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
    isAI: t.isAI,

    players: {
      PLAYER1: p1Present ? t.names.PLAYER1 : null,
      PLAYER2: p2Present ? t.names.PLAYER2 : null
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

    show: t.show
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

  pushLog(t, `⚓ New game begins. Starting dealer: ${t.names[t.dealer]}.`);

  if ((t.players.PLAYER1 || t.isAI.PLAYER1) && (t.players.PLAYER2 || t.isAI.PLAYER2) && !t.matchOver) {
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

  if ((t.players.PLAYER1 || t.isAI.PLAYER1) && (t.players.PLAYER2 || t.isAI.PLAYER2)) {
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

  pushLog(t, `New hand. Dealer: ${t.names[t.dealer]}.`);
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
    checkGameEnd(t);
  }

  return pts;
}

function awardLastCardIfNeeded(t) {
  if (t.peg.count !== 0 && t.peg.count !== 31 && t.peg.lastPlayer) {
    t.scores[t.peg.lastPlayer] += 1;
    t.lastPegEvent = { player: t.peg.lastPlayer, pts: 1, reasons: ["last card for 1"] };
    checkGameEnd(t);
  }
}

function resetPegCount(t) {
  t.peg.count = 0;
  t.peg.pile = [];
  t.peg.lastPlayer = null;
  t.peg.go = { PLAYER1: false, PLAYER2: false };
  t.lastGoEvent = null;
}

function endSequenceAndContinue(t, nextTurnPlayer) {
  awardLastCardIfNeeded(t);
  resetPegCount(t);

  if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
    scoreShowAndAdvance(t);
    return;
  }

  t.turn = nextTurnPlayer;
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

  t.stage = "show";
  checkGameEnd(t);
}

/** -------------------------
 * Core action handlers (socket + AI)
 * ------------------------- */
function handleDiscard(t, me, cardIds) {
  if (!t || t.stage !== "discard") return;
  if (t.gameOver || t.matchOver) return;

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

  const p1Done = t.discards.PLAYER1.length === 2;
  const p2Done = t.discards.PLAYER2.length === 2;

  if (p1Done && p2Done && t.crib.length === 4) enterPegging(t);
}

function handlePlayCard(t, me, cardId) {
  if (!t || t.stage !== "pegging") return;
  if (t.gameOver || t.matchOver) return;
  if (!me || t.turn !== me) return;

  const hand = t.pegHands[me] || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return;

  const card = hand[idx];
  const val = cardValue(card.rank);
  if (t.peg.count + val > 31) return;

  // play it
  hand.splice(idx, 1);
  t.pegHands[me] = hand;

  t.peg.count += val;
  t.peg.pile.push(card);
  t.peg.lastPlayer = me;
  t.peg.go.PLAYER1 = false;
  t.peg.go.PLAYER2 = false;
  t.lastGoEvent = null;

  pegPointsAfterPlay(t, me, card);
  if (t.gameOver || t.matchOver) return;

  // handle 31
  if (t.peg.count === 31) {
    resetPegCount(t);
    t.turn = otherPlayer(me);
    return;
  }

  const opp = otherPlayer(me);

  // if opponent has 0 cards left, keep playing if possible; if blocked, end sequence
  if ((t.pegHands[opp]?.length || 0) === 0) {
    t.turn = me;
    if (!canPlayAny(t.pegHands[me], t.peg.count) && t.peg.count > 0) {
      endSequenceAndContinue(t, me);
      return;
    }
  } else {
    t.turn = opp;
  }

  // if pegging is over
  if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
    awardLastCardIfNeeded(t);
    scoreShowAndAdvance(t);
  }
}

function handleGo(t, me) {
  if (!t || t.stage !== "pegging") return;
  if (t.gameOver || t.matchOver) return;
  if (!me || t.turn !== me) return;

  const opp = otherPlayer(me);

  // GO not allowed if you can play
  if (canPlayAny(t.pegHands[me], t.peg.count)) return;

  t.lastGoEvent = { player: me };

  // Special case: opponent is out of cards
  if ((t.pegHands[opp]?.length || 0) === 0) {
    endSequenceAndContinue(t, me);
    return;
  }

  // Normal GO
  t.peg.go[me] = true;

  // If opponent can play, pass
  if (canPlayAny(t.pegHands[opp], t.peg.count)) {
    t.turn = opp;
    return;
  }

  // Both cannot play -> end sequence, lead is lastPlayer (or non-dealer if none yet)
  const lead = t.peg.lastPlayer ? t.peg.lastPlayer : otherPlayer(t.dealer);
  endSequenceAndContinue(t, lead);
}

function maybeRunAITurns(t) {
  if (!t) return;

  // hard stop if over
  if (t.gameOver || t.matchOver) return;

  // loop to let AI catch up (discard + pegging)
  let safety = 0;
  while (safety++ < 50) {
    if (t.gameOver || t.matchOver) break;

    // AI discards during discard stage
    if (t.stage === "discard") {
      if (t.isAI.PLAYER1 && t.discards.PLAYER1.length !== 2) {
        const hand = t.hands.PLAYER1 || [];
        if (hand.length >= 2) {
          const pick = [hand[0].id, hand[1].id];
          handleDiscard(t, "PLAYER1", pick);
          continue;
        }
      }
      if (t.isAI.PLAYER2 && t.discards.PLAYER2.length !== 2) {
        const hand = t.hands.PLAYER2 || [];
        if (hand.length >= 2) {
          const pick = [hand[0].id, hand[1].id];
          handleDiscard(t, "PLAYER2", pick);
          continue;
        }
      }
      break; // wait for human discard
    }

    // AI pegging
    if (t.stage === "pegging") {
      const cur = t.turn;
      if (!t.isAI[cur]) break; // human turn

      const hand = t.pegHands[cur] || [];
      const count = t.peg.count;

      // choose lowest playable card
      let playable = hand
        .filter(c => count + cardValue(c.rank) <= 31)
        .sort((a, b) => cardValue(a.rank) - cardValue(b.rank));

      if (playable.length > 0) {
        handlePlayCard(t, cur, playable[0].id);
        continue;
      } else {
        handleGo(t, cur);
        continue;
      }
    }

    // show: AI does nothing; user clicks next hand (keeps it clear/controlled)
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

    // if table already has 2 humans, block
    const p1Taken = !!t.players.PLAYER1 || t.isAI.PLAYER1;
    const p2Taken = !!t.players.PLAYER2 || t.isAI.PLAYER2;

    let me = null;
    if (!p1Taken) me = "PLAYER1";
    else if (!p2Taken) me = "PLAYER2";
    else return socket.emit("error_msg", "Table is full (2 players).");

    // If joining as human PLAYER2 where AI is already seated, block (simple rule)
    if (me === "PLAYER2" && t.isAI.PLAYER2) {
      return socket.emit("error_msg", "That table is currently running vs AI. Use a new table code.");
    }

    t.players[me] = socket.id;
    t.isAI[me] = false;
    t.names[me] = sanitizeName(name, me);

    socket.tableId = tableId;
    socket.playerId = me;

    // If player requested vsAI and they are PLAYER1, seat AI in PLAYER2 immediately
    if (me === "PLAYER1" && !!vsAI) {
      if (!t.players.PLAYER2 && !t.isAI.PLAYER2) {
        t.players.PLAYER2 = null;
        t.isAI.PLAYER2 = true;
        t.names.PLAYER2 = "AI Captain";
      }
    }

    emitState(tableId);

    // Start hand when both seats are filled (human or AI)
    const ready = (t.players.PLAYER1 || t.isAI.PLAYER1) && (t.players.PLAYER2 || t.isAI.PLAYER2);
    if (ready && t.stage === "lobby" && !t.matchOver) {
      startHand(t);
      maybeRunAITurns(t);
      emitState(tableId);
    } else {
      // also, if AI is present and we're already in a running stage, let it act
      maybeRunAITurns(t);
      emitState(tableId);
    }
  });

  socket.on("discard_to_crib", ({ cardIds }) => {
    const t = tables[socket.tableId];
    const me = socket.playerId;
    handleDiscard(t, me, cardIds);
    maybeRunAITurns(t);
    emitState(socket.tableId);
  });

  socket.on("play_card", ({ cardId }) => {
    const t = tables[socket.tableId];
    const me = socket.playerId;
    handlePlayCard(t, me, cardId);
    maybeRunAITurns(t);
    emitState(socket.tableId);
  });

  socket.on("go", () => {
    const t = tables[socket.tableId];
    const me = socket.playerId;
    handleGo(t, me);
    maybeRunAITurns(t);
    emitState(socket.tableId);
  });

  socket.on("next_hand", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "show") return;

    // If game ended, do NOT deal another hand
    if (t.gameOver || t.matchOver) return;

    t.dealer = otherPlayer(t.dealer);
    const ready = (t.players.PLAYER1 || t.isAI.PLAYER1) && (t.players.PLAYER2 || t.isAI.PLAYER2);
    if (ready) {
      startHand(t);
      maybeRunAITurns(t);
      emitState(socket.tableId);
    }
  });

  socket.on("next_game", () => {
    const t = tables[socket.tableId];
    if (!t) return;
    if (!t.gameOver || t.matchOver) return;
    resetForNewGame(t);
    maybeRunAITurns(t);
    emitState(socket.tableId);
  });

  socket.on("new_match", () => {
    const t = tables[socket.tableId];
    if (!t) return;
    resetForNewMatch(t);
    maybeRunAITurns(t);
    emitState(socket.tableId);
  });

  socket.on("disconnect", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (me && t.players[me] === socket.id) {
      t.players[me] = null;

      // If the human who created the table leaves and it's vsAI, keep AI seated but game won't progress until a human joins.
    }

    emitState(socket.tableId);
  });
});
