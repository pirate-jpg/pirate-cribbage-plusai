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

// Play panel
const handTitle = el("handTitle");
const handHelp = el("handHelp");
const handArea = el("handArea");
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
let selectedForDiscard = new Set();

const GAME_TARGET = 121;

function otherPlayer(p) {
  return p === "PLAYER1" ? "PLAYER2" : "PLAYER1";
}

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

function getNames() {
  const n1 = state?.names?.PLAYER1 || state?.players?.PLAYER1 || "P1";
  const n2 = state?.names?.PLAYER2 || state?.players?.PLAYER2 || "P2";
  return { n1, n2 };
}

function localGameIsOver() {
  if (!state) return false;
  // Trust server flags if present, but also enforce locally by score.
  if (state.gameOver || state.matchOver) return true;
  const p1 = state.scores?.PLAYER1 ?? 0;
  const p2 = state.scores?.PLAYER2 ?? 0;
  return (p1 >= GAME_TARGET || p2 >= GAME_TARGET);
}

function localWinner() {
  if (!state) return null;
  // Prefer server winner if present
  if (state.gameWinner) return state.gameWinner;
  const p1 = state.scores?.PLAYER1 ?? 0;
  const p2 = state.scores?.PLAYER2 ?? 0;
  if (p1 >= GAME_TARGET && p1 >= p2) return "PLAYER1";
  if (p2 >= GAME_TARGET && p2 >= p1) return "PLAYER2";
  return null;
}

function renderBoard() {
  if (!state) return;

  p1Label.textContent = state.players.PLAYER1 || "P1";
  p2Label.textContent = state.players.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores.PLAYER1);
  setPegPosition(p2Peg, state.scores.PLAYER2);
}

function showCallout(text) {
  if (!lastScore) return;
  lastScore.textContent = text;
  lastScore.classList.remove("hidden");
}

function hideCallout() {
  if (!lastScore) return;
  lastScore.classList.add("hidden");
  lastScore.textContent = "—";
}

function renderPileAndHud() {
  if (!state) return;

  countNum.textContent = String(state.peg?.count ?? 0);

  pileArea.innerHTML = "";
  const pile = state.peg?.pile || [];
  const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
  for (const c of show) pileArea.appendChild(makeCardButton(c, { disabled: true }));

  // If game over, blank out pegging HUD (and let the main render show winner)
  if (localGameIsOver()) {
    peggingStatus.textContent = "";
    hideCallout();
    return;
  }

  if (state.stage !== "pegging") {
    peggingStatus.textContent = "";
    hideCallout();
    return;
  }

  const myTurn = state.turn === state.me;
  const opp = otherPlayer(state.me);

  // Baseline status
  peggingStatus.textContent = myTurn ? "Your turn" : "Opponent’s turn";

  // ✅ GO callout: if opponent has declared GO, show it BIG
  const goObj = state.peg?.go || {};
  const oppSaidGo = !!goObj[opp];
  const meSaidGo = !!goObj[state.me];

  if (oppSaidGo) {
    showCallout("🏴‍☠️ OPPONENT SAYS GO!");
    return;
  }
  if (meSaidGo) {
    showCallout("You said GO.");
    return;
  }

  // Otherwise show last scoring event (if any)
  const ev = state.lastPegEvent;
  if (ev && ev.pts && ev.pts > 0) {
    const who = (ev.player === state.me) ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    showCallout(`${who} scored +${ev.pts} (${reasonText})`);
  } else {
    hideCallout();
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

function maybeAutoSendDiscard() {
  if (!state) return;
  if (state.stage !== "discard") return;
  if (selectedForDiscard.size !== 2) return;

  socket.emit("discard_to_crib", { cardIds: Array.from(selectedForDiscard) });
  selectedForDiscard.clear();
}

function renderGameOverBannerIfNeeded() {
  if (!state) return false;

  const over = localGameIsOver();
  if (!over) return false;

  const win = localWinner();
  const { n1, n2 } = getNames();
  const winnerName = win === "PLAYER1" ? n1 : win === "PLAYER2" ? n2 : "Winner";

  handTitle.textContent = "🏁 GAME OVER";
  handHelp.textContent = `${winnerName} wins! (First to ${GAME_TARGET})`;

  // Show a big callout too
  showCallout(`🏴‍☠️ ${winnerName.toUpperCase()} WINS!`);

  // lock all actions
  if (goBtn) goBtn.style.display = "none";
  if (nextHandBtn) nextHandBtn.style.display = "none";

  // show panel can remain if it exists; we don’t hide it.
  return true;
}

function render() {
  if (!state) return;

  tableLine.textContent = `Table: ${state.tableId}`;
  meLine.textContent = `You: ${state.names?.[state.me] || state.me}`;

  const p1 = state.players.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players.PLAYER2 ? state.players.PLAYER2 : "—";
  playersLine.textContent = `Players: ${p1} vs ${p2}`;

  stageLine.textContent = `Stage: ${state.stage}`;
  dealerLine.textContent = `Dealer: ${state.names?.[state.dealer] || state.dealer}`;
  turnLine.textContent = `Turn: ${state.names?.[state.turn] || state.turn}`;

  // Score line using names
  const { n1, n2 } = getNames();
  scoreLine.textContent = `${n1} ${state.scores.PLAYER1} • ${n2} ${state.scores.PLAYER2}`;

  // Crib owner name (dealer owns crib)
  const cribOwnerName = state.names?.[state.dealer] || state.dealer;
  cribLine.textContent = `Crib (${cribOwnerName}) • Discards: ${n1} ${state.discardsCount.PLAYER1}/2  ${n2} ${state.discardsCount.PLAYER2}/2`;

  initTicksOnce();
  renderBoard();
  renderPileAndHud();
  renderShow();

  // reset actions
  if (goBtn) goBtn.style.display = "none";
  if (nextHandBtn) nextHandBtn.style.display = "none";

  handArea.innerHTML = "";

  // ✅ GAME OVER OVERRIDE (winner announced + lock UI)
  if (renderGameOverBannerIfNeeded()) return;

  // STAGES
  if (state.stage === "lobby") {
    handTitle.textContent = "Waiting for crew…";
    handHelp.textContent = `Open the same table on another device: "${state.tableId}" (or select Play vs AI).`;
    hideCallout();
    showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    showPanel.classList.add("hidden");

    const cribOwnerName2 = state.names?.[state.dealer] || state.dealer;
    handTitle.textContent = "Your Hand";
    handHelp.textContent = `Select 2 cards to send to ${cribOwnerName2}’s crib. (Auto-sends on 2nd pick.)`;

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

          render();
          maybeAutoSendDiscard();
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
    handHelp.textContent = "Review scoring. Click Next Hand when ready.";

    // Only allow next hand if game truly isn’t over
    if (!localGameIsOver()) {
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
  if (!name) { alert("Enter a name."); return; }

  const vsAI = !!(aiToggle && aiToggle.checked);

  socket.emit("join_table", { tableId, name, vsAI });
  joinOverlay.style.display = "none";
}

// Pre-fill from URL if present
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

  // Clear stale discard selections if not in discard
  if (state.stage !== "discard" && selectedForDiscard.size) selectedForDiscard.clear();

  render();
});

socket.on("error_msg", (msg) => alert(msg));
