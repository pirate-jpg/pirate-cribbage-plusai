// server.js
// Pirate Cribbage Plus AI
// - 2-player OR vs AI (server-side AI "AI Captain")
// - Discard -> Pegging -> Show
// - Pegging scoring: 15/31, pairs, runs, last card
// - Show scoring breakdown: 15s/pairs/runs/flush/nobs
// - Hard game end at >=121 with winner announcement; no more dealing past 121
// - GO is broadcast as a visible event (lastGoEvent)
// - AI turn engine to prevent stalls (discard + pegging + go)
// - Layout/UI driven by richer state (names, cribOwner, gameOver banner)

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

function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newTableState(tableId) {
  return {
    id: tableId,

    // socket ids (null for AI)
    players: { PLAYER1: null, PLAYER2: null },

    // display names
    names: { PLAYER1: "PLAYER1", PLAYER2: "PLAYER2" },

    // AI
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

    scores: { PLAYER1: 0, PLAYER2: 0 },

    matchWins: { PLAYER1: 0, PLAYER2: 0 },
    matchTarget: MATCH_TARGET_WINS,
    gameTarget: GAME_TARGET,

    gameOver: false,
    gameWinner: null,
    matchOver: false,
    matchWinner: null,

    show: null,

    lastPegEvent: null, // { player, pts, reasons[] }
    lastGoEvent: null,  // { player, seq, at }
    goSeq: 0,

    log: []
  };
}

function ensureTable(tableId) {
  if (!tables[tableId]) tables[tableId] = newTableState(tableId);
  return tables[tableId];
}

function resetTable(tableId) {
  tables[tableId] = newTableState(tableId);
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

  const p1Present = !!t.players.PLAYER1;
  const p2Present = !!t.players.PLAYER2 || t.ai.enabled;

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

    players: {
      PLAYER1: p1Present ? t.names.PLAYER1 : null,
      PLAYER2: p2Present ? t.names.PLAYER2 : null
    },

    aiEnabled: t.ai.enabled,

    cribCount: t.crib.length,
    discardsCount: {
      PLAYER1: t.discards.PLAYER1.length,
      PLAYER2: t.discards.PLAYER2.length
    },

    cribOwner: t.dealer,

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

  // alternate dealer for fairness
  t.dealer = otherPlayer(t.dealer);
  t.stage = "lobby";
  t.turn = t.dealer;

  pushLog(t, `⚓ New game begins. Starting dealer: ${t.names[t.dealer]}.`);

  const bothPresent = !!t.players.PLAYER1 && (!!t.players.PLAYER2 || t.ai.enabled);
  if (bothPresent && !t.matchOver) startHand(t);
}

function resetForNewMatch(t) {
  t.matchWins = { PLAYER1: 0, PLAYER2:	trigger: "PLAYER1", PLAYER2: 0 };
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

  const bothPresent = !!t.players.PLAYER1 && (!!t.players.PLAYER2 || t.ai.enabled);
  if (bothPresent) startHand(t);
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

  // during discard, hands/pegHands mirror (6 cards)
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

  pushLog(t, `Cut: ${t.cut.rank}${t.cut.suit}`);

  // pegHands = copy of show hands (now 4 cards each)
  t.pegHands.PLAYER1 = [...t.hands.PLAYER1];
  t.pegHands.PLAYER2 = [...t.hands.PLAYER2];

  // non-dealer starts pegging
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

  // pairs/three/four in a row (last N same ranks)
  let same = 1;
  for (let i = t.peg.pile.length - 2; i >= 0; i--) {
    if (t.peg.pile[i].rank === playedCard.rank) same++;
    else break;
  }
  if (same === 2) { pts += 2; reasons.push("pair for 2"); }
  else if (same === 3) { pts += 6; reasons.push("three of a kind for 6"); }
  else if (same === 4) { pts += 12; reasons.push("four of a kind for 12"); }

  // runs
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
  pushLog(t, `Count resets to 0.`);
}

// End sequence, reset count, continue with next lead; also advances to show if pegging done
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
 * Core actions (used by humans and AI)
 * ------------------------- */
function discardToCrib(t, me, cardIds) {
  if (!t || t.stage !== "discard") return false;
  if (t.gameOver || t.matchOver) return false;
  if (!me) return false;

  const ids = Array.isArray(cardIds) ? cardIds : [];
  if (ids.length !== 2) return false;

  const hand = t.hands[me];
  const chosen = [];
  for (const id of ids) {
    const idx = hand.findIndex(c => c.id === id);
    if (idx === -1) return false;
    chosen.push(hand[idx]);
  }

  t.hands[me] = t.hands[me].filter(c => !ids.includes(c.id));
  t.pegHands[me] = t.pegHands[me].filter(c => !ids.includes(c.id));

  t.discards[me] = chosen;
  t.crib.push(...chosen);

  pushLog(t, `${t.names[me]} discards 2 to ${t.names[t.dealer]}'s crib.`);

  const p1Done = t.discards.PLAYER1.length === 2;
  const p2Done = t.discards.PLAYER2.length === 2;

  if (p1Done && p2Done && t.crib.length === 4) enterPegging(t);
  return true;
}

function playCard(t, me, cardId) {
  if (!t || t.stage !== "pegging") return false;
  if (t.gameOver || t.matchOver) return false;
  if (!me || t.turn !== me) return false;

  const hand = t.pegHands[me] || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  const card = hand[idx];
  const val = cardValue(card.rank);
  if (t.peg.count + val > 31) return false;

  // play it
  hand.splice(idx, 1);
  t.pegHands[me] = hand;

  t.peg.count += val;
  t.peg.pile.push(card);
  t.peg.lastPlayer = me;
  t.peg.go.PLAYER1 = false;
  t.peg.go.PLAYER2 = false;

  pushLog(t, `${t.names[me]} plays ${card.rank}${card.suit}. Count=${t.peg.count}`);

  // scoring
  pegPointsAfterPlay(t, me, card);
  if (t.gameOver || t.matchOver) return true;

  // handle 31 immediate reset
  if (t.peg.count === 31) {
    resetPegCount(t);
    t.turn = otherPlayer(me);
    pushLog(t, `${t.names[t.turn]} to play.`);
    return true;
  }

  // advance turn logic
  const opp = otherPlayer(me);

  // if opponent is out of cards, keep turn with same player if they can continue
  if ((t.pegHands[opp]?.length || 0) === 0) {
    t.turn = me;

    // stall fix: if blocked while opponent out, end sequence + reset
    if (!canPlayAny(t.pegHands[me], t.peg.count) && t.peg.count > 0) {
      pushLog(t, `${t.names[me]} blocked while opponent out — auto ending sequence.`);
      endSequenceAndContinue(t, me);
      return true;
    }
  } else {
    t.turn = opp;
  }

  // if pegging is over
  if (t.pegHands.PLAYER1.length === 0 && t.pegHands.PLAYER2.length === 0) {
    awardLastCardIfNeeded(t);
    scoreShowAndAdvance(t);
  } else {
    pushLog(t, `${t.names[t.turn]} to play.`);
  }

  return true;
}

function sayGo(t, me) {
  if (!t || t.stage !== "pegging") return false;
  if (t.gameOver || t.matchOver) return false;
  if (!me || t.turn !== me) return false;

  const opp = otherPlayer(me);

  // If I can play, GO is not allowed
  if (canPlayAny(t.pegHands[me], t.peg.count)) return false;

  // record GO event (UI shows loudly)
  t.goSeq += 1;
  t.lastGoEvent = { player: me, seq: t.goSeq, at: Date.now() };
  pushLog(t, `${t.names[me]} says GO.`);

  // Special case: opponent has 0 cards left.
  // If I'm blocked, end the sequence, reset to 0, and I keep the lead.
  if ((t.pegHands[opp]?.length || 0) === 0) {
    pushLog(t, `${t.names[me]} is blocked (opponent out) — ending sequence.`);
    endSequenceAndContinue(t, me);
    return true;
  }

  // Normal GO behavior
  t.peg.go[me] = true;

  // If opponent can play, pass turn
  if (canPlayAny(t.pegHands[opp], t.peg.count)) {
    t.turn = opp;
    pushLog(t, `${t.names[t.turn]} to play.`);
    return true;
  }

  // Both cannot play -> end sequence, reset.
  const lead = t.peg.lastPlayer ? t.peg.lastPlayer : otherPlayer(t.dealer);
  endSequenceAndContinue(t, lead);
  return true;
}

/** -------------------------
 * Turn resolver + AI engine
 * ------------------------- */
function resolvePeggingTurnIfNeeded(t) {
  if (!t || t.stage !== "pegging") return;

  // If either side has zero cards, ensure turn is on someone who can act
  const p1n = t.pegHands.PLAYER1.length;
  const p2n = t.pegHands.PLAYER2.length;

  if (p1n === 0 && p2n === 0) {
    awardLastCardIfNeeded(t);
    scoreShowAndAdvance(t);
    return;
  }

  // If current turn player has no cards, give turn to the other (if they have any)
  if ((t.pegHands[t.turn]?.length || 0) === 0) {
    const other = otherPlayer(t.turn);
    if ((t.pegHands[other]?.length || 0) > 0) {
      t.turn = other;
      pushLog(t, `${t.names[t.turn]} to play.`);
    }
  }

  // If the turn player is blocked AND the opponent has no cards, auto-end sequence
  const opp = otherPlayer(t.turn);
  if ((t.pegHands[opp]?.length || 0) === 0) {
    if (!canPlayAny(t.pegHands[t.turn], t.peg.count) && t.peg.count > 0) {
      pushLog(t, `${t.names[t.turn]} blocked while opponent out — auto ending sequence.`);
      endSequenceAndContinue(t, t.turn);
    }
  }
}

function aiPickDiscardIds(hand) {
  // simple: discard two lowest-value cards
  const sorted = [...hand].sort((a, b) => {
    const va = cardValue(a.rank), vb = cardValue(b.rank);
    if (va !== vb) return va - vb;
    return rankNum(a.rank) - rankNum(b.rank);
  });
  return [sorted[0].id, sorted[1].id];
}

function aiPickPlayCardId(hand, count) {
  // choose lowest playable card (keeps it simple and reliable)
  const playable = hand.filter(c => cardValue(c.rank) + count <= 31);
  if (!playable.length) return null;
  playable.sort((a, b) => {
    const va = cardValue(a.rank), vb = cardValue(b.rank);
    if (va !== vb) return va - vb;
    return rankNum(a.rank) - rankNum(b.rank);
  });
  return playable[0].id;
}

function scheduleAIMoves(tableId) {
  const t = tables[tableId];
  if (!t || !t.ai.enabled) return;
  // run shortly after emit to avoid recursion/stack loops
  setTimeout(() => runAIMoves(tableId), 25);
}

function runAIMoves(tableId) {
  const t = tables[tableId];
  if (!t || !t.ai.enabled) return;
  if (t.gameOver || t.matchOver) return;

  // AI is always PLAYER2 in this build
  const AI = "PLAYER2";
  if (t.names.PLAYER2 !== t.ai.name) t.names.PLAYER2 = t.ai.name;

  // If we are in lobby and PLAYER1 exists, start a hand
  const bothPresent = !!t.players.PLAYER1 && (t.ai.enabled || !!t.players.PLAYER2);
  if (t.stage === "lobby" && bothPresent && !t.matchOver) {
    startHand(t);
    emitState(tableId);
  }

  // AI discard
  if (t.stage === "discard") {
    if (t.discards[AI].length !== 2) {
      const ids = aiPickDiscardIds(t.hands[AI] || []);
      const ok = discardToCrib(t, AI, ids);
      if (ok) {
        resolvePeggingTurnIfNeeded(t);
        emitState(tableId);
      }
    }
  }

  // AI pegging loop (may need multiple consecutive actions)
  if (t.stage === "pegging") {
    let safety = 0;
    while (t.stage === "pegging" && t.turn === AI && !t.gameOver && !t.matchOver) {
      safety += 1;
      if (safety > 50) {
        pushLog(t, "AI safety stop (prevent infinite loop).");
        break;
      }

      resolvePeggingTurnIfNeeded(t);

      const hand = t.pegHands[AI] || [];
      const count = t.peg.count;

      if (hand.length === 0) {
        // give turn to other if possible
        const opp = otherPlayer(AI);
        if ((t.pegHands[opp]?.length || 0) > 0) t.turn = opp;
        else {
          awardLastCardIfNeeded(t);
          scoreShowAndAdvance(t);
        }
        break;
      }

      const cardId = aiPickPlayCardId(hand, count);
      if (cardId) {
        playCard(t, AI, cardId);
        resolvePeggingTurnIfNeeded(t);
        emitState(tableId);

        // if after play it's still AI's turn and opponent is out, loop continues
        continue;
      } else {
        // must GO
        sayGo(t, AI);
        resolvePeggingTurnIfNeeded(t);
        emitState(tableId);
        break;
      }
    }
  }

  // AI doesn't click Next Hand; human does.
}

/** -------------------------
 * Socket.IO
 * ------------------------- */
io.on("connection", (socket) => {

  socket.on("join_table", ({ tableId, name, vsAI }) => {
    tableId = (tableId || "JIM1").toString().trim().slice(0, 24);

    // If vsAI, force-reset table to prevent ghost/stale sockets from prior sessions
    const t = vsAI ? resetTable(tableId) : ensureTable(tableId);

    let me = null;

    // Always assign PLAYER1 to the joining client in vsAI mode
    if (vsAI) {
      me = "PLAYER1";
      t.ai.enabled = true;
      t.ai.name = "AI Captain";
      t.names.PLAYER2 = t.ai.name;
      t.players.PLAYER2 = null; // AI has no socket
    } else {
      // normal 2-player
      if (!t.players.PLAYER1) me = "PLAYER1";
      else if (!t.players.PLAYER2) me = "PLAYER2";
      else return socket.emit("error_msg", "Table is full (2 players).");
      t.ai.enabled = false;
    }

    t.players[me] = socket.id;
    t.names[me] = sanitizeName(name, me);

    // default name for other player if empty
    if (!t.names.PLAYER1) t.names.PLAYER1 = "PLAYER1";
    if (!t.names.PLAYER2) t.names.PLAYER2 = vsAI ? t.ai.name : "PLAYER2";

    socket.tableId = tableId;
    socket.playerId = me;

    pushLog(t, `${t.names[me]} joined as ${me}${vsAI ? " (vs AI)" : ""}.`);

    emitState(tableId);

    // If both present, start hand
    const bothPresent = !!t.players.PLAYER1 && (!!t.players.PLAYER2 || t.ai.enabled);
    if (bothPresent && t.stage === "lobby" && !t.matchOver) {
      startHand(t);
      emitState(tableId);
    }

    // Let AI react if needed
    if (t.ai.enabled) scheduleAIMoves(tableId);
  });

  socket.on("discard_to_crib", ({ cardIds }) => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    const ok = discardToCrib(t, me, cardIds);
    if (!ok) return;

    emitState(socket.tableId);

    if (t.ai.enabled) scheduleAIMoves(socket.tableId);
  });

  socket.on("play_card", ({ cardId }) => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    const ok = playCard(t, me, cardId);
    if (!ok) return;

    resolvePeggingTurnIfNeeded(t);
    emitState(socket.tableId);

    if (t.ai.enabled) scheduleAIMoves(socket.tableId);
  });

  socket.on("go", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    const ok = sayGo(t, me);
    if (!ok) return;

    resolvePeggingTurnIfNeeded(t);
    emitState(socket.tableId);

    if (t.ai.enabled) scheduleAIMoves(socket.tableId);
  });

  socket.on("next_hand", () => {
    const t = tables[socket.tableId];
    if (!t || t.stage !== "show") return;
    if (t.gameOver || t.matchOver) return;

    t.dealer = otherPlayer(t.dealer);
    const bothPresent = !!t.players.PLAYER1 && (!!t.players.PLAYER2 || t.ai.enabled);
    if (bothPresent) {
      startHand(t);
      emitState(socket.tableId);
      if (t.ai.enabled) scheduleAIMoves(socket.tableId);
    }
  });

  socket.on("next_game", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    if (!t.gameOver || t.matchOver) return;
    resetForNewGame(t);
    emitState(socket.tableId);
    if (t.ai.enabled) scheduleAIMoves(socket.tableId);
  });

  socket.on("new_match", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    resetForNewMatch(t);
    emitState(socket.tableId);
    if (t.ai.enabled) scheduleAIMoves(socket.tableId);
  });

  socket.on("disconnect", () => {
    const t = tables[socket.tableId];
    if (!t) return;

    const me = socket.playerId;
    if (me && t.players[me] === socket.id) {
      t.players[me] = null;
      pushLog(t, `${t.names[me]} disconnected.`);
    }

    emitState(socket.tableId);
  });
});
