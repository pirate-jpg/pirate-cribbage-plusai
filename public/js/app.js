const socket = io();
const el = (id) => document.getElementById(id);

/* ===================== DOM REFERENCES ===================== */

// Top chips
const tableLine = el("tableLine");
const meLine = el("meLine");

// Crew panel
const playersLine = el("playersLine");
const stageLine = el("stageLine");
const dealerLine = el("dealerLine");
const turnLine = el("turnLine");
const scoreLine = el("scoreLine");
const matchLine = el("matchLine");
const cribLine = el("cribLine");

// Play panel
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
const discardBtn = el("discardBtn");
const goBtn = el("goBtn");
const nextHandBtn = el("nextHandBtn");
const newMatchBtn = el("newMatchBtn");

// Pegging HUD
const pileArea = el("pileArea");
const countNum = el("countNum");
const peggingStatus = el("peggingStatus");
const lastScore = el("lastScore");

// Board
const p1Peg = el("p1Peg");
const p2Peg = el("p2Peg");
const p1Label = el("p1Label");
const p2Label = el("p2Label");
const ticks = el("ticks");

// Show panel
const showPanel = el("showPanel");
const cutLine = el("cutLine");
const ndTitle = el("ndTitle");
const dTitle = el("dTitle");
const cTitle = el("cTitle");
const ndCards = el("ndCards");
const dCards = el("dCards");
const cCards = el("cCards");
const ndBreak = el("ndBreak");
const dBreak = el("dBreak");
const cBreak = el("cBreak");
const ndTotal = el("ndTotal");
const dTotal = el("dTotal");
const cTotal = el("cTotal");

// Toast
const toast = el("toast");

// Join overlay (mode UI)
const joinOverlay = el("joinOverlay");
const joinTopHelp = el("joinTopHelp");
const modePanel = el("modePanel");
const entryPanel = el("entryPanel");
const modeAiBtn = el("modeAiBtn");
const modePvpBtn = el("modePvpBtn");
const backBtn = el("backBtn");
const joinForm = el("joinForm");
const entryHint = el("entryHint");
const tableRow = el("tableRow");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const nameJoinBtn = el("nameJoinBtn");

// Generic modal (we reuse GO modal for discard prompts too)
const goModal = el("goModal");
const goModalText = el("goModalText");
const goModalOk = el("goModalOk");

// Game over modal
const gameModal = el("gameModal");
const gameModalText = el("gameModalText");
const gameModalNext = el("gameModalNext");
const gameModalNewMatch = el("gameModalNewMatch");

/* ===================== STATE ===================== */

let state = null;
let lastGoSeenTs = 0;
let lastGameOverShownKey = "";

// Join behavior
let joinMode = null; // "ai" | "pvp"
let pendingJoin = false;

/* ===================== PEGGING SCORE QUEUE ===================== */

const PEG_SCORE_MIN_MS = 1500;
let pegScoreQueue = [];
let pegScoreTimer = null;
let pegScoreActiveUntil = 0;
let lastPegSig = "";

function pegSig(ev, s) {
  const r = (ev?.reasons || []).join("|");
  return `${ev?.player || ""}|${ev?.pts || 0}|${r}|${s?.peg?.count || 0}|${s?.peg?.pile?.length || 0}|${s?.scores?.PLAYER1 || 0}|${s?.scores?.PLAYER2 || 0}`;
}

function resetPegQueue() {
  pegScoreQueue = [];
  lastPegSig = "";
  pegScoreActiveUntil = 0;
  if (pegScoreTimer) clearTimeout(pegScoreTimer);
  pegScoreTimer = null;
  if (lastScore) lastScore.classList.add("hidden");
}

function enqueuePegScore(s) {
  if (!s || s.stage !== "pegging") return;

  const ev = s.lastPegEvent;
  if (!ev || !ev.pts || ev.pts <= 0) return;

  const sig = pegSig(ev, s);
  if (sig === lastPegSig) return;
  lastPegSig = sig;

  const who = ev.player === s.me ? "You" : "Opponent";
  const reasonText = (ev.reasons || []).join(", ");
  pegScoreQueue.push(`${who} scored +${ev.pts} (${reasonText})`);

  drainPegQueue();
}

function drainPegQueue() {
  if (pegScoreTimer) return;

  const tick = () => {
    if (!state || state.stage !== "pegging") {
      resetPegQueue();
      return;
    }

    const now = Date.now();
    if (now < pegScoreActiveUntil) {
      pegScoreTimer = setTimeout(tick, pegScoreActiveUntil - now);
      return;
    }

    if (!pegScoreQueue.length) {
      if (lastScore) lastScore.classList.add("hidden");
      pegScoreTimer = null;
      return;
    }

    if (lastScore) {
      lastScore.textContent = pegScoreQueue.shift();
      lastScore.classList.remove("hidden");
    }
    pegScoreActiveUntil = Date.now() + PEG_SCORE_MIN_MS;
    pegScoreTimer = setTimeout(tick, PEG_SCORE_MIN_MS);
  };

  tick();
}

/* ===================== HELPERS ===================== */

function cardValue(r) {
  if (r === "A") return 1;
  if (["K", "Q", "J"].includes(r)) return 10;
  return parseInt(r, 10);
}

function suitClass(s) {
  return (s === "♥" || s === "♦") ? "red" : "black";
}

function makeCardButton(card, opts = {}) {
  const b = document.createElement("button");
  b.className = `cardBtn ${suitClass(card.suit)}`;
  if (opts.selected) b.classList.add("selected");
  if (opts.disabled) b.disabled = true;
  if (opts.onClick) b.onclick = opts.onClick;

  const corner1 = document.createElement("div");
  corner1.className = "corner";
  corner1.textContent = card.rank;

  const big = document.createElement("div");
  big.className = "suitBig";
  big.textContent = card.suit;

  const corner2 = document.createElement("div");
  corner2.className = "corner bottom";
  corner2.textContent = card.rank;

  b.append(corner1, big, corner2);
  return b;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function initTicksOnce() {
  if (!ticks) return;
  if (ticks.childElementCount > 0) return;
  [0, 30, 60, 90, 121].forEach(n => {
    const span = document.createElement("span");
    span.textContent = String(n);
    ticks.appendChild(span);
  });
}

function setPegPosition(pegEl, score) {
  if (!pegEl) return;
  const s = clamp(score ?? 0, 0, 121);
  const pct = (s / 121) * 100;
  pegEl.style.left = `${pct}%`;
}

function playerName(p) {
  if (!state) return p;
  return state.players?.[p] || p;
}

function renderBoard() {
  if (!state) return;
  if (p1Label) p1Label.textContent = state.players?.PLAYER1 || "P1";
  if (p2Label) p2Label.textContent = state.players?.PLAYER2 || "P2";
  setPegPosition(p1Peg, state.scores?.PLAYER1 || 0);
  setPegPosition(p2Peg, state.scores?.PLAYER2 || 0);
}

function showModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.remove("hidden");
}
function hideModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.add("hidden");
}

if (goModalOk) goModalOk.onclick = () => hideModal(goModal);

function maybeShowGoModal() {
  const ge = state?.lastGoEvent;
  if (!ge || !ge.ts) return;
  if (ge.ts === lastGoSeenTs) return;

  lastGoSeenTs = ge.ts;
  if (ge.player === state.me) return;

  if (goModalText) goModalText.textContent = "Opponent said GO";
  showModal(goModal);
}

/**
 * ✅ Safety: show Game Over modal even if a game ends outside "show"
 * (server now forces stage="show", but this prevents future deadlocks).
 */
function maybeShowGameOverModal() {
  if (!state) return;
  if (!state.gameOver) return;

  const key =
    `${state.tableId}|${state.matchWins?.PLAYER1 ?? 0}|${state.matchWins?.PLAYER2 ?? 0}|` +
    `${state.scores?.PLAYER1 ?? 0}|${state.scores?.PLAYER2 ?? 0}|${state.gameWinner ?? ""}|` +
    `${state.matchOver ? "M" : "G"}`;

  if (key === lastGameOverShownKey) return;
  lastGameOverShownKey = key;

  const winnerName = playerName(state.gameWinner);
  if (state.matchOver) {
    const matchWinnerName = playerName(state.matchWinner);
    if (gameModalText) gameModalText.textContent =
      `${winnerName} won this game.\n\n${matchWinnerName} wins the match (best of 3).`;
    if (gameModalNewMatch) gameModalNewMatch.style.display = "inline-block";
    if (gameModalNext) gameModalNext.textContent = "Next Game";
  } else {
    if (gameModalText) gameModalText.textContent =
      `${winnerName} won this game.\n\nPress Next Game when you’re ready.`;
    if (gameModalNewMatch) gameModalNewMatch.style.display = "none";
    if (gameModalNext) gameModalNext.textContent = "Next Game";
  }

  showModal(gameModal);
}

if (gameModalNext) {
  gameModalNext.onclick = () => {
    hideModal(gameModal);
    socket.emit("next_hand");
  };
}
if (gameModalNewMatch) {
  gameModalNewMatch.onclick = () => {
    hideModal(gameModal);
    socket.emit("new_match");
  };
}

/* ===================== RENDER HELPERS ===================== */

function clearPeggingPanelsForNonPegging() {
  if (pileArea) pileArea.innerHTML = "";
  if (peggingStatus) peggingStatus.textContent = "";
}

function renderPileAndHud() {
  if (!state) return;

  if (countNum) countNum.textContent = String(state.peg?.count ?? 0);

  if (state.stage !== "pegging") {
    clearPeggingPanelsForNonPegging();
    resetPegQueue();
    return;
  }

  if (pileArea) {
    pileArea.innerHTML = "";
    const pile = state.peg?.pile || [];
    const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
    for (const c of show) {
      pileArea.appendChild(makeCardButton(c, { disabled: true }));
    }
  }

  const myTurn = state.turn === state.me;
  if (peggingStatus) peggingStatus.textContent = myTurn ? "Your turn" : "Opponent’s turn";

  enqueuePegScore(state);
  maybeShowGoModal();
}

/* ===================== MAIN RENDER ===================== */

function render() {
  if (!state) return;

  if (tableLine) tableLine.textContent = `Table: ${state.tableId}`;
  if (meLine) meLine.textContent = `You: ${playerName(state.me)}`;

  const p1 = state.players?.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players?.PLAYER2 ? state.players.PLAYER2 : "—";

  if (playersLine) playersLine.textContent = `Players: ${p1} vs ${p2}`;
  if (stageLine) stageLine.textContent = `Stage: ${state.stage}`;
  if (dealerLine) dealerLine.textContent = `Dealer: ${playerName(state.dealer)}`;
  if (turnLine) turnLine.textContent = `Turn: ${playerName(state.turn)}`;

  if (scoreLine) scoreLine.textContent = `${p1} ${state.scores?.PLAYER1 ?? 0} • ${p2} ${state.scores?.PLAYER2 ?? 0}`;

  const mw1 = state.matchWins?.PLAYER1 ?? 0;
  const mw2 = state.matchWins?.PLAYER2 ?? 0;
  if (matchLine) matchLine.textContent = `Match (best of 3): ${p1} ${mw1} • ${p2} ${mw2}`;

  if (cribLine) {
    const d = playerName(state.dealer);
    const dc1 = state.discardsCount?.PLAYER1 ?? 0;
    const dc2 = state.discardsCount?.PLAYER2 ?? 0;
    cribLine.textContent = `Crib (${d}) • Discards: ${p1} ${dc1}/2  ${p2} ${dc2}/2`;
  }

  initTicksOnce();
  renderBoard();
  renderPileAndHud();

  // reset buttons each render
  if (discardBtn) discardBtn.style.display = "none";
  if (goBtn) goBtn.style.display = "none";
  if (nextHandBtn) nextHandBtn.style.display = "none";
  if (newMatchBtn) newMatchBtn.style.display = "none";

  if (handArea) handArea.innerHTML = "";

  // ✅ Always allow the modal to appear if gameOver (no matter the stage)
  if (state.gameOver) {
    maybeShowGameOverModal();
  }

  if (state.stage === "lobby") {
    if (handTitle) handTitle.textContent = "Waiting for crew…";
    if (handHelp) handHelp.textContent =
      `If this is 2-player, open the same table code on the other device: "${state.tableId}".`;
    if (showPanel) showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    if (showPanel) showPanel.classList.add("hidden");

    const cribOwner = playerName(state.dealer);
    const myDiscarded = state.discardsCount?.[state.me] ?? 0;

    if (handTitle) handTitle.textContent = "Discard";
    if (handHelp) handHelp.textContent = "";

    if (peggingStatus) {
      if (myDiscarded < 2) {
        peggingStatus.innerHTML = `
          <div style="
            font-weight:900;
            font-size:26px;
            line-height:1.1;
            color:#ff4d2e;
            text-shadow:0 2px 10px rgba(0,0,0,.65);
          ">
            Tap two cards to discard to ${cribOwner}'s crib
          </div>
        `;
      } else {
        peggingStatus.textContent = "";
      }
    }

    const myHand = state.myHand || [];
    myHand.forEach(c => {
      handArea.appendChild(
        makeCardButton(c, { onClick: () => socket.emit("discard_one", { cardId: c.id }) })
      );
    });

    return;
  }

  if (state.stage === "pegging") {
    if (showPanel) showPanel.classList.add("hidden");

    if (handTitle) handTitle.textContent = "Pegging";
    if (handHelp) handHelp.textContent = "Play a card without exceeding 31. If you can’t play, press GO.";

    const myTurn = state.turn === state.me;
    const myHand = state.myHand || [];
    const count = state.peg?.count ?? 0;

    myHand.forEach(c => {
      const playable = myTurn && (count + cardValue(c.rank) <= 31);
      handArea.appendChild(
        makeCardButton(c, {
          disabled: !playable,
          onClick: () => socket.emit("play_card", { cardId: c.id })
        })
      );
    });

    const canPlay = myHand.some(c => count + cardValue(c.rank) <= 31);
    if (goBtn) {
      if (myTurn && myHand.length > 0 && !canPlay) {
        goBtn.style.display = "inline-block";
        goBtn.onclick = () => socket.emit("go");
      } else {
        goBtn.style.display = "none";
      }
    }

    return;
  }

  if (state.stage === "show") {
    clearPeggingPanelsForNonPegging();

    if (handTitle) handTitle.textContent = "Show";
    if (handHelp) {
      handHelp.textContent = state.gameOver
        ? `${playerName(state.gameWinner)} won this game.`
        : "See scoring below.";
    }

    if (nextHandBtn) {
      nextHandBtn.style.display = "inline-block";
      nextHandBtn.onclick = () => socket.emit("next_hand");
    }

    if (newMatchBtn) {
      if (state.matchOver) {
        newMatchBtn.style.display = "inline-block";
        newMatchBtn.onclick = () => socket.emit("new_match");
        if (handHelp) handHelp.textContent = `${playerName(state.matchWinner)} wins the match (best of 3).`;
      } else {
        newMatchBtn.style.display = "none";
      }
    }

    // still fine (also called earlier if gameOver)
    maybeShowGameOverModal();
    return;
  }
}

/* ===================== JOIN FLOW ===================== */

function setJoinUiEnabled(enabled) {
  if (nameJoinBtn) nameJoinBtn.disabled = !enabled;
  if (modeAiBtn) modeAiBtn.disabled = !enabled;
  if (modePvpBtn) modePvpBtn.disabled = !enabled;
  if (backBtn) backBtn.disabled = !enabled;
  if (nameInput) nameInput.disabled = !enabled;
  if (tableInput) tableInput.disabled = !enabled;
}

function showModePanel() {
  if (!modePanel || !entryPanel) return;
  modePanel.style.display = "block";
  entryPanel.style.display = "none";
  if (joinTopHelp) joinTopHelp.textContent = "Choose a mode, then enter what's needed to start.";
  if (entryHint) entryHint.textContent = "";
  joinMode = null;
  pendingJoin = false;
  setJoinUiEnabled(true);
}

function showEntryPanel(mode) {
  joinMode = mode;
  if (modePanel) modePanel.style.display = "none";
  if (entryPanel) entryPanel.style.display = "block";
  if (entryHint) entryHint.textContent = "";

  if (mode === "ai") {
    if (joinTopHelp) joinTopHelp.textContent = "VS AI: enter your name, then Set Sail.";
    if (tableRow) tableRow.style.display = "none";
  } else {
    if (joinTopHelp) joinTopHelp.textContent =
      "VS Player: enter your name + a table code. Player 2 must enter the same table code.";
    if (tableRow) tableRow.style.display = "block";
  }

  setTimeout(() => nameInput && nameInput.focus(), 50);
}

function doJoinFromModeUI() {
  const name = (nameInput?.value || "").trim().slice(0, 16);
  const tableId = (tableInput?.value || "").trim().slice(0, 24);

  if (!socket.connected) {
    if (entryHint) entryHint.textContent = "Socket disconnected. Refresh and try again.";
    return;
  }

  if (!name) {
    if (goModalText) goModalText.textContent = "Enter a name.";
    showModal(goModal);
    return;
  }
  if (joinMode !== "ai" && !tableId) {
    if (goModalText) goModalText.textContent = "Enter a table code.";
    showModal(goModal);
    return;
  }
  if (!joinMode) {
    if (goModalText) goModalText.textContent = "Choose a mode.";
    showModal(goModal);
    return;
  }

  pendingJoin = true;
  setJoinUiEnabled(false);
  if (entryHint) entryHint.textContent = "Joining…";

  const vsAI = (joinMode === "ai");
  socket.emit("join_table", { tableId: vsAI ? "" : tableId, name, vsAI });
}

if (modeAiBtn) modeAiBtn.onclick = () => showEntryPanel("ai");
if (modePvpBtn) modePvpBtn.onclick = () => showEntryPanel("pvp");
if (backBtn) backBtn.onclick = () => showModePanel();

if (joinForm) {
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    doJoinFromModeUI();
  });
} else if (nameJoinBtn) {
  nameJoinBtn.onclick = doJoinFromModeUI;
}

if (joinOverlay) showModePanel();

/* ===================== SOCKET ===================== */

socket.on("connect", () => {
  if (pendingJoin && entryHint) entryHint.textContent = "Joining…";
});

socket.on("disconnect", () => {
  if (joinOverlay) {
    joinOverlay.style.display = "block";
    if (entryHint) entryHint.textContent = "Socket disconnected. Refresh and try again.";
    setJoinUiEnabled(true);
    pendingJoin = false;
  }
});

socket.on("state", (s) => {
  state = s;

  if (pendingJoin && joinOverlay) {
    joinOverlay.style.display = "none";
    pendingJoin = false;
    setJoinUiEnabled(true);
  }

  render();
});

socket.on("error_msg", (msg) => {
  if (joinOverlay) joinOverlay.style.display = "block";
  if (entryHint) entryHint.textContent = String(msg || "Join failed.");
  pendingJoin = false;
  setJoinUiEnabled(true);
});