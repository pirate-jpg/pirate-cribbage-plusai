// public/js/app.js
const socket = io();
const el = (id) => document.getElementById(id);

// Top chips
const tableLine = el("tableLine");
const meLine = el("meLine");

// Crew
const playersLine = el("playersLine");
const stageLine = el("stageLine");
const dealerLine = el("dealerLine");
const turnLine = el("turnLine");
const scoreLine = el("scoreLine");
const cribLine = el("cribLine");

// Play
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
const goBtn = el("goBtn");
const nextHandBtn = el("nextHandBtn");
const nextGameBtn = el("nextGameBtn");
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

// Show
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

// Join overlay
const joinOverlay = el("joinOverlay");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const vsAICheck = el("vsAICheck");
const nameJoinBtn = el("nameJoinBtn");

let state = null;
let joined = false;
let selectedForDiscard = new Set();
let lastGoSeqSeen = 0;

function cardValue(rank) {
  if (rank === "A") return 1;
  if (["K","Q","J"].includes(rank)) return 10;
  return parseInt(rank, 10);
}
function suitClass(suit) {
  return (suit === "♥" || suit === "♦") ? "red" : "black";
}

function makeCardButton(card, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cardBtn ${suitClass(card.suit)}`;
  if (opts.selected) btn.classList.add("selected");
  if (opts.disabled) btn.disabled = true;

  const corner1 = document.createElement("div");
  corner1.className = "corner";
  corner1.textContent = card.rank;

  const big = document.createElement("div");
  big.className = "suitBig";
  big.textContent = card.suit;

  const corner2 = document.createElement("div");
  corner2.className = "corner bottom";
  corner2.textContent = card.rank;

  btn.append(corner1, big, corner2);

  if (opts.onClick) {
    // Use pointerdown for faster/cleaner selection (fixes "needs 2-3 clicks")
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      opts.onClick();
    }, { passive: false });
  }

  return btn;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

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
  const s = clamp(score, 0, 121);
  const pct = (s / 121) * 100;
  pegEl.style.left = `${pct}%`;
}

function myName() {
  if (!state) return "You";
  return state.names?.[state.me] || state.players?.[state.me] || state.me;
}
function oppId() {
  return state ? (state.me === "PLAYER1" ? "PLAYER2" : "PLAYER1") : "PLAYER2";
}
function oppName() {
  if (!state) return "Opponent";
  const oid = oppId();
  return state.names?.[oid] || state.players?.[oid] || oid;
}
function dealerName() {
  if (!state) return "Dealer";
  return state.names?.[state.dealer] || state.dealer;
}
function turnName() {
  if (!state) return "Turn";
  return state.names?.[state.turn] || state.turn;
}

function renderBoard() {
  if (!state) return;

  p1Label.textContent = state.names?.PLAYER1 || state.players?.PLAYER1 || "P1";
  p2Label.textContent = state.names?.PLAYER2 || state.players?.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores.PLAYER1);
  setPegPosition(p2Peg, state.scores.PLAYER2);
}

function showBigMessage(text) {
  lastScore.textContent = text;
  lastScore.classList.remove("hidden");
}

function renderPileAndHud() {
  if (!state) return;

  countNum.textContent = String(state.peg?.count ?? 0);

  pileArea.innerHTML = "";
  const pile = state.peg?.pile || [];
  const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
  for (const c of show) {
    pileArea.appendChild(makeCardButton(c, { disabled: true }));
  }

  if (state.stage !== "pegging") {
    peggingStatus.textContent = "";
    lastScore.classList.add("hidden");
    return;
  }

  const myTurn = state.turn === state.me;

  // GO announcements (very obvious)
  const goEv = state.lastGoEvent;
  if (goEv && goEv.seq && goEv.seq !== lastGoSeqSeen) {
    lastGoSeqSeen = goEv.seq;
    const who = (goEv.player === state.me) ? myName() : oppName();
    showBigMessage(`☠️ ${who} says GO!`);
  }

  // Regular status line
  const mine = state.myHandCount ?? 0;
  const opp = state.oppHandCount ?? 0;
  peggingStatus.textContent = myTurn
    ? `Your turn • You: ${mine} card(s) • Opponent: ${opp} card(s)`
    : `Opponent’s turn • You: ${mine} card(s) • Opponent: ${opp} card(s)`;

  // Peg scoring banner (overrides if present)
  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? myName() : oppName();
    const reasonText = (ev.reasons || []).join(", ");
    showBigMessage(`🏴‍☠️ ${who} scored +${ev.pts} (${reasonText})`);
  }
}

function renderBreakdown(listEl, breakdown) {
  listEl.innerHTML = "";
  if (!breakdown || !breakdown.items || breakdown.items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No points.";
    listEl.appendChild(li);
    return;
  }
  for (const item of breakdown.items) {
    const li = document.createElement("li");
    li.textContent = `${item.label} = ${item.pts}`;
    listEl.appendChild(li);
  }
}

function renderShow() {
  if (!state || state.stage !== "show" || !state.show) {
    showPanel.classList.add("hidden");
    return;
  }
  showPanel.classList.remove("hidden");

  const cut = state.show.cut;
  cutLine.textContent = `Cut: ${cut.rank}${cut.suit}`;

  const nonDealer = state.show.nonDealer;
  const dealer = state.show.dealer;

  ndTitle.textContent = `Non-dealer (${state.names?.[nonDealer] || nonDealer})`;
  dTitle.textContent = `Dealer (${state.names?.[dealer] || dealer})`;
  cTitle.textContent = `Crib (${state.names?.[dealer] || dealer})`;

  ndCards.innerHTML = "";
  dCards.innerHTML = "";
  cCards.innerHTML = "";

  const nd = state.show.hand[nonDealer];
  const de = state.show.hand[dealer];
  const cr = state.show.crib;

  for (const c of nd.cards) ndCards.appendChild(makeCardButton(c, { disabled: true }));
  ndCards.appendChild(makeCardButton(cut, { disabled: true }));

  for (const c of de.cards) dCards.appendChild(makeCardButton(c, { disabled: true }));
  dCards.appendChild(makeCardButton(cut, { disabled: true }));

  for (const c of cr.cards) cCards.appendChild(makeCardButton(c, { disabled: true }));
  cCards.appendChild(makeCardButton(cut, { disabled: true }));

  renderBreakdown(ndBreak, nd.breakdown);
  renderBreakdown(dBreak, de.breakdown);
  renderBreakdown(cBreak, cr.breakdown);

  ndTotal.textContent = `Total: ${nd.breakdown.total}`;
  dTotal.textContent = `Total: ${de.breakdown.total}`;
  cTotal.textContent = `Total: ${cr.breakdown.total}`;
}

function render() {
  if (!state) return;

  // Top chips
  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${myName()}`;

  // Crew panel
  const p1 = state.names?.PLAYER1 || state.players?.PLAYER1 || "—";
  const p2 = state.names?.PLAYER2 || state.players?.PLAYER2 || "—";
  playersLine.textContent = `Players: ${p1} vs ${p2}`;

  stageLine.textContent = `Stage: ${state.stage}`;
  dealerLine.textContent = `Dealer: ${dealerName()}`;
  turnLine.textContent = `Turn: ${turnName()}`;

  // Score line uses names (not P1/P2)
  const s1 = state.scores.PLAYER1 ?? 0;
  const s2 = state.scores.PLAYER2 ?? 0;
  scoreLine.textContent = `${(state.names?.PLAYER1 || "P1")} ${s1} • ${(state.names?.PLAYER2 || "P2")} ${s2}`;

  // Crib info line
  cribLine.textContent =
    `Crib (${dealerName()}) • Discards: ${(state.names?.PLAYER1 || "P1")} ${state.discardsCount.PLAYER1}/2  ${(state.names?.PLAYER2 || "P2")} ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderPileAndHud();
  renderShow();

  // Buttons
  goBtn.style.display = "none";
  nextHandBtn.style.display = "none";
  nextGameBtn.style.display = "none";
  newMatchBtn.style.display = "inline-block";

  newMatchBtn.onclick = () => socket.emit("new_match");

  // Clear hand area
  handArea.innerHTML = "";

  // GAME OVER banner/controls
  if (state.gameOver) {
    const winnerId = state.gameWinner;
    const winnerName = state.names?.[winnerId] || winnerId;
    handTitle.textContent = "Game Over";
    handHelp.textContent = `🏁 ${winnerName} wins!`;

    // If match over: only New Match makes sense
    if (!state.matchOver) {
      nextGameBtn.style.display = "inline-block";
      nextGameBtn.onclick = () => socket.emit("next_game");
    }
    // Disable other actions
    showPanel.classList.add("hidden");
    return;
  }

  // STAGES
  if (state.stage === "lobby") {
    handTitle.textContent = "Waiting…";
    handHelp.textContent = state.aiEnabled
      ? "AI mode: starting shortly…"
      : `Open the same table code on another device to play 2-player.`;
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");
    handTitle.textContent = "Discard";
    handHelp.textContent = `Select 2 cards to send to ${dealerName()}'s crib (auto-sends when you pick 2).`;

    const myHand = state.myHand || [];

    myHand.forEach(card => {
      const selected = selectedForDiscard.has(card.id);
      const btn = makeCardButton(card, {
        selected,
        onClick: () => {
          // toggle selection
          if (selected) {
            selectedForDiscard.delete(card.id);
          } else {
            if (selectedForDiscard.size >= 2) return;
            selectedForDiscard.add(card.id);
          }

          // auto-send as soon as 2 chosen
          if (selectedForDiscard.size === 2) {
            socket.emit("discard_to_crib", { cardIds: Array.from(selectedForDiscard) });
            selectedForDiscard.clear();
          }

          render();
        }
      });
      handArea.appendChild(btn);
    });

    return;
  }

  if (state.stage === "pegging") {
    showPanel.classList.add("hidden");
    handTitle.textContent = "Pegging";
    handHelp.textContent = "Play a card without exceeding 31. If you can’t play, press GO.";

    const myTurn = state.turn === state.me;
    const myHand = state.myHand || [];
    const count = state.peg.count;

    myHand.forEach(card => {
      const playable = myTurn && (count + cardValue(card.rank) <= 31);
      const btn = makeCardButton(card, {
        disabled: !playable,
        onClick: () => socket.emit("play_card", { cardId: card.id })
      });
      handArea.appendChild(btn);
    });

    // GO only when it can work: your turn, you have cards, and none playable
    const canPlay = myHand.some(c => count + cardValue(c.rank) <= 31);
    if (myTurn && myHand.length > 0 && !canPlay) {
      goBtn.style.display = "inline-block";
      goBtn.onclick = () => socket.emit("go");
    }
    return;
  }

  if (state.stage === "show") {
    handTitle.textContent = "Show";
    handHelp.textContent = "Review scoring. Click Next Hand when ready.";

    nextHandBtn.style.display = "inline-block";
    nextHandBtn.onclick = () => socket.emit("next_hand");

    // Show your hand (read-only) in the handArea too
    const myHand = state.myHand || [];
    myHand.forEach(card => handArea.appendChild(makeCardButton(card, { disabled: true })));
    if (state.cut) handArea.appendChild(makeCardButton(state.cut, { disabled: true }));

    return;
  }
}

// JOIN FLOW
function doJoin() {
  const name = (nameInput.value || "").trim().slice(0, 16);
  const tableId = (tableInput.value || "").trim().slice(0, 24) || "JIM1";
  const vsAI = !!vsAICheck?.checked;

  if (!name) { alert("Enter a name."); return; }

  socket.emit("join_table", { tableId, name, vsAI });
  joined = true;
  joinOverlay.style.display = "none";
}

// Pre-fill from URL
(function initJoinDefaults(){
  const qs = new URLSearchParams(location.search);
  const table = (qs.get("table") || "JIM1").toString().trim().slice(0, 24);
  const name = (qs.get("name") || "").toString().trim().slice(0, 16);
  tableInput.value = table;
  if (name) nameInput.value = name;
})();

nameJoinBtn.onclick = doJoin;
nameInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });
tableInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));
