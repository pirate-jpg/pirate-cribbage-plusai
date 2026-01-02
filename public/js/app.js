const socket = io();
const el = (id) => document.getElementById(id);

// Top chips
const tableLine = el("tableLine");
const meLine = el("meLine");

// Crew panel
const playersLine = el("playersLine");
const stageLine = el("stageLine");
const dealerLine = el("dealerLine");
const turnLine = el("turnLine");
const scoreLine = el("scoreLine");
const cribLine = el("cribLine");

// Match UI
const matchLine = el("matchLine");
const p1Name = el("p1Name");
const p2Name = el("p2Name");
const p1Wins = el("p1Wins");
const p2Wins = el("p2Wins");
const nextGameBtn = el("nextGameBtn");
const newMatchBtn = el("newMatchBtn");

// Play panel
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
const discardBtn = el("discardBtn");
const goBtn = el("goBtn");
const nextHandBtn = el("nextHandBtn");

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

// Join overlay
const joinOverlay = el("joinOverlay");
const nameInput = el("nameInput");
const tableInput = el("tableInput");
const nameJoinBtn = el("nameJoinBtn");
const aiToggle = el("aiToggle");

let state = null;
let joined = false;
let selectedForDiscard = new Set();

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

  if (opts.onClick) btn.onclick = opts.onClick;
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

function renderBoard() {
  if (!state) return;

  p1Label.textContent = state.players.PLAYER1 || "P1";
  p2Label.textContent = state.players.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores.PLAYER1);
  setPegPosition(p2Peg, state.scores.PLAYER2);
}

function renderMatch() {
  if (!state) return;
  const w1 = state.matchWins?.PLAYER1 ?? 0;
  const w2 = state.matchWins?.PLAYER2 ?? 0;
  const target = state.matchTarget ?? 3;

  p1Name.textContent = state.players.PLAYER1 || "P1";
  p2Name.textContent = state.players.PLAYER2 || "P2";

  matchLine.textContent = `${w1} – ${w2} (first to ${target})`;

  const makePips = (root, n) => {
    root.innerHTML = "";
    for (let i = 0; i < target; i++) {
      const d = document.createElement("span");
      d.className = "pip" + (i < n ? " on" : "");
      root.appendChild(d);
    }
  };

  makePips(p1Wins, w1);
  makePips(p2Wins, w2);

  // Buttons: only show Next Game if gameOver and match not over
  if (state.gameOver && !state.matchOver) {
    nextGameBtn.style.display = "inline-block";
    nextGameBtn.onclick = () => socket.emit("next_game");
  } else {
    nextGameBtn.style.display = "none";
  }

  newMatchBtn.onclick = () => socket.emit("new_match");
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
  const mine = state.myHandCount ?? 0;
  const opp = state.oppHandCount ?? 0;

  peggingStatus.textContent =
    `${myTurn ? "Your turn" : "Opponent’s turn"} • You: ${mine} card(s) • Opponent: ${opp} card(s)`;

  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
    lastScore.classList.remove("hidden");
  } else {
    lastScore.classList.add("hidden");
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

  const ndName = state.players[nonDealer] || nonDealer;
  const dName = state.players[dealer] || dealer;

  ndTitle.textContent = `Non-dealer (${ndName})`;
  dTitle.textContent = `Dealer (${dName})`;
  cTitle.textContent = `Crib (${dName})`;

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

  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${state.me}`;

  const p1 = state.players.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players.PLAYER2 ? state.players.PLAYER2 : "—";
  playersLine.textContent = `Players: ${p1} vs ${p2}`;

  stageLine.textContent = `Stage: ${state.stage}`;

  const dealerName = state.players[state.dealer] || state.dealer;
  dealerLine.textContent = `Dealer: ${dealerName}`;

  const turnName = state.players[state.turn] || state.turn;
  turnLine.textContent = `Turn: ${turnName}`;

  scoreLine.textContent = `P1 ${state.scores.PLAYER1} • P2 ${state.scores.PLAYER2}`;

  // Crib owner is dealer (by rules)
  cribLine.textContent =
    `Crib (${dealerName}) • Discards: P1 ${state.discardsCount.PLAYER1}/2  P2 ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderMatch();
  renderPileAndHud();
  renderShow();

  // reset buttons
  discardBtn.style.display = "none";
  goBtn.style.display = "none";
  nextHandBtn.style.display = "none";
  discardBtn.disabled = true;

  handArea.innerHTML = "";

  // Game/match end messages
  if (state.matchOver) {
    const winnerName = state.players[state.matchWinner] || state.matchWinner;
    handTitle.textContent = "Match Over";
    handHelp.textContent = `${winnerName} wins the match. Start a new match to play again.`;
    return;
  }
  if (state.gameOver && state.stage !== "show") {
    const winnerName = state.players[state.gameWinner] || state.gameWinner;
    handTitle.textContent = "Game Over";
    handHelp.textContent = `${winnerName} won this game. Click Next Game to continue the match.`;
    return;
  }

  // STAGES
  if (state.stage === "lobby") {
    handTitle.textContent = "Waiting for crew…";
    handHelp.textContent = state.ai?.enabled
      ? "AI is aboard. Dealing begins as soon as you join."
      : `Open the same table on another device: "${state.tableId}".`;
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");
    handTitle.textContent = "Your Hand";
    handHelp.textContent = "Select exactly 2 cards to discard to the crib.";

    const myHand = state.myHand || [];
    myHand.forEach(card => {
      const selected = selectedForDiscard.has(card.id);
      const btn = makeCardButton(card, {
        selected,
        onClick: () => {
          if (selected) selectedForDiscard.delete(card.id);
          else {
            if (selectedForDiscard.size >= 2) return;
            selectedForDiscard.add(card.id);
          }
          discardBtn.disabled = selectedForDiscard.size !== 2;
          render();
        }
      });
      handArea.appendChild(btn);
    });

    discardBtn.style.display = "inline-block";
    discardBtn.disabled = selectedForDiscard.size !== 2;
    discardBtn.onclick = () => {
      if (selectedForDiscard.size !== 2) return;
      socket.emit("discard_to_crib", { cardIds: Array.from(selectedForDiscard) });
      selectedForDiscard.clear();
      discardBtn.disabled = true;
    };
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

    // GO only when it can actually work: your turn, you have cards, and none playable
    const canPlay = myHand.some(c => count + cardValue(c.rank) <= 31);
    if (myTurn && myHand.length > 0 && !canPlay) {
      goBtn.style.display = "inline-block";
      goBtn.onclick = () => socket.emit("go");
    }
    return;
  }

  if (state.stage === "show") {
    handTitle.textContent = "Show";
    handHelp.textContent = state.gameOver
      ? "This game ended at 121. Click Next Game to continue the match."
      : "Review scoring. Click Next Hand when ready.";

    // Only show Next Hand when game isn't over
    if (!state.gameOver) {
      nextHandBtn.style.display = "inline-block";
      nextHandBtn.onclick = () => socket.emit("next_hand");
    }

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
  const ai = !!aiToggle?.checked;

  if (!name) { alert("Enter a name."); return; }

  socket.emit("join_table", { tableId, name, ai });
  joined = true;
  joinOverlay.style.display = "none";
}

// Pre-fill from URL if present
(function initJoinDefaults(){
  const qs = new URLSearchParams(location.search);
  const table = (qs.get("table") || "JIM1").toString().trim().slice(0, 24);
  const name = (qs.get("name") || "").toString().trim().slice(0, 16);
  const ai = (qs.get("ai") === "1");

  tableInput.value = table;
  if (name) nameInput.value = name;
  if (aiToggle) aiToggle.checked = ai;
})();

nameJoinBtn.onclick = doJoin;
nameInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });
tableInput.addEventListener("keydown", (e)=>{ if (e.key === "Enter") doJoin(); });

socket.on("connect", () => {
  // stay idle until player presses Set Sail
});

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));
