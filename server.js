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

// ================= AI TIMING =================
const AI_DELAY_MS = 900;
const aiTimers = new Map(); // tableId -> timeout
// ============================================

// ---- static + health ----
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const tables = new Map();

/* ---------- helpers ---------- */
function otherPlayer(p) {
  return p === "PLAYER1" ? "PLAYER2" : "PLAYER1";
}
function cardValue(rank) {
  if (rank === "A") return 1;
  if (["J", "Q", "K"].includes(rank)) return 10;
  return parseInt(rank, 10);
}

/* ---------- table ---------- */
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

function getOrCreateTable(id) {
  if (!tables.has(id)) tables.set(id, makeTable(id));
  return tables.get(id);
}

/* ---------- AI scheduling ---------- */

function clearAiTimer(tableId) {
  const t = aiTimers.get(tableId);
  if (t) clearTimeout(t);
  aiTimers.delete(tableId);
}

function scheduleAi(t) {
  if (!t.ai.enabled) return;
  if (aiTimers.has(t.tableId)) return;

  aiTimers.set(
    t.tableId,
    setTimeout(() => {
      aiTimers.delete(t.tableId);
      runSingleAiStep(t);
    }, AI_DELAY_MS)
  );
}

function runSingleAiStep(t) {
  if (!t.ai.enabled) return;
  if (t.matchOver || t.gameOver) return;

  const ap = t.ai.aiPlayer;

  // -------- discard --------
  if (t.stage === "discard") {
    if (t.discardsCount[ap] < 2) {
      const card = t.hands[ap][0];
      if (card) internalDiscardOne(t, ap, card.id);
      emitStateToTable(t);
      scheduleAi(t);
      return;
    }
    if (t.discardsCount.PLAYER1 === 2 && t.discardsCount.PLAYER2 === 2) {
      beginPegging(t);
      emitStateToTable(t);
      scheduleAi(t);
    }
    return;
  }

  // -------- pegging --------
  if (t.stage === "pegging" && t.turn === ap) {
    const playable = t.pegHands[ap].find(
      c => t.peg.count + cardValue(c.rank) <= 31
    );

    if (playable) {
      internalPlayCard(t, ap, playable.id);
    } else {
      internalGo(t, ap);
    }

    emitStateToTable(t);
    scheduleAi(t);
  }
}

/* ---------- core gameplay ---------- */
/* (Everything below is unchanged logic except calls to scheduleAi) */

function internalDiscardOne(t, player, cardId) {
  if (t.stage !== "discard") return false;
  if (t.discardsCount[player] >= 2) return false;

  const idx = t.hands[player].findIndex(c => c.id === cardId);
  if (idx === -1) return false;

  t.crib.push(t.hands[player].splice(idx, 1)[0]);
  t.discardsCount[player]++;
  return true;
}

function beginPegging(t) {
  t.pegHands.PLAYER1 = [...t.hands.PLAYER1];
  t.pegHands.PLAYER2 = [...t.hands.PLAYER2];
  t.stage = "pegging";
  t.turn = otherPlayer(t.dealer);
  t.peg = { count: 0, pile: [], passed: { PLAYER1: false, PLAYER2: false }, lastPlayer: null };
  t.lastPegEvent = null;
  t.lastGoEvent = null;
}

/* (internalPlayCard, internalGo, scoring, emitStateToTable remain as in your file) */

/* ---------- socket.io ---------- */
io.on("connection", socket => {
  socket.on("join_table", ({ tableId, name, vsAI }) => {
    const t = getOrCreateTable(vsAI ? `AI-${Date.now()}` : tableId);
    t.ai.enabled = !!vsAI;
    t.players.PLAYER1 = name;
    t.players.PLAYER2 = vsAI ? "AI Captain" : t.players.PLAYER2;
    t.sockets.PLAYER1 = socket.id;

    t.stage = "discard";
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("discard_one", ({ cardId }) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    if (!t) return;
    internalDiscardOne(t, p, cardId);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("play_card", ({ cardId }) => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    internalPlayCard(t, p, cardId);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("go", () => {
    const { t, p } = findTableAndPlayerBySocket(socket.id);
    internalGo(t, p);
    emitStateToTable(t);
    scheduleAi(t);
  });

  socket.on("disconnect", () => {
    for (const t of tables.values()) {
      clearAiTimer(t.tableId);
    }
  });
});

function findTableAndPlayerBySocket(id) {
  for (const t of tables.values()) {
    for (const p of ["PLAYER1", "PLAYER2"]) {
      if (t.sockets[p] === id) return { t, p };
    }
  }
  return {};
}

function emitStateToTable(t) {
  for (const p of ["PLAYER1", "PLAYER2"]) {
    const sid = t.sockets[p];
    if (!sid) continue;
    io.to(sid).emit("state", {
      ...t,
      me: p,
      myHand: t.stage === "pegging" ? t.pegHands[p] : t.hands[p],
    });
  }
}

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Server listening on ${PORT}`)
);