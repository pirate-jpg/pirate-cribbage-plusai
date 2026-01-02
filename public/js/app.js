// public/js/app.js
// Robust client: does not crash if optional elements are missing.
// Set Sail handler is attached after DOMContentLoaded.

const socket = io();

function el(id) {
  return document.getElementById(id);
}

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

// Optional: AI checkbox (if present in your HTML)
const aiToggle = el("aiToggle");

let state = null;
let selectedForDiscard = new Set();

function cardValue(rank) {
  if (rank === "A") return 1;
  if (["K", "Q", "J"].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function suitClass(suit) {
  return suit === "♥" || suit === "♦" ? "red" : "black";
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function initTicksOnce() {
  if (!ticks) return;
  if (ticks.childElementCount > 0) return;
  [0, 30, 60, 90, 121].forEach((n) => {
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

function renderBoard() {
  if (!state) return;

  if (p1Label) p1Label.textContent = state.players?.PLAYER1 || "P1";
  if (p2Label) p2Label.textContent = state.players?.PLAYER2 || "P2";

  setPegPosition(p1Peg, state.scores?.PLAYER1 ?? 0);
  setPegPosition(p2Peg, state.scores?.PLAYER2 ?? 0);
}

function renderPileAndHud() {
  if (!state) return;

  if (countNum) countNum.textContent = String(state.peg?.count ?? 0);

  if (pileArea) {
    pileArea.innerHTML = "";
    const pile = state.peg?.pile || [];
    const show = pile.length > 10 ? pile.slice(pile.length - 10) : pile;
    for (const c of show) {
      pileArea.appendChild(makeCardButton(c, { disabled: true }));
    }
  }

  if (!peggingStatus || !lastScore) return;

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
    const who = ev.player === state.me ? "You" : "Opponent";
    const reasonText = (ev.reasons || []).join(", ");
    lastScore.textContent = `${who} scored +${ev.pts} (${reasonText})`;
    lastScore.classList.remove("hidden");
  } else {
    lastScore.classList.add("hidden");
  }
}

function renderBreakdown(listEl, breakdown) {
  if (!listEl) return;
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
  if (!showPanel) return;

  if (!state || state.stage !== "show" || !state.show) {
    showPanel.classList.add("hidden");
    return;
  }

  showPanel.classList.remove("hidden");

  const cut = state.show.cut;
  if (cutLine) cutLine.textContent = `Cut: ${cut.rank}${cut.suit}`;

  const nonDealer = state.show.nonDealer;
  const dealer = state.show.dealer;

  if (ndTitle) ndTitle.textContent = `Non-dealer (${nonDealer})`;
  if (dTitle) dTitle.textContent = `Dealer (${dealer})`;
  if (cTitle) cTitle.textContent = `Crib (${dealer})`;

  if (ndCards) ndCards.innerHTML = "";
  if (dCards) dCards.innerHTML = "";
  if (cCards) cCards.innerHTML = "";

  const nd = state.show.hand[nonDealer];
  const de = state.show.hand[dealer];
  const cr = state.show.crib;

  if (ndCards) {
    for (const c of nd.cards) ndCards.appendChild(makeCardButton(c, { disabled: true }));
    ndCards.appendChild(makeCardButton(cut, { disabled: true }));
  }

  if (dCards) {
    for (const c of de.cards) dCards.appendChild(makeCardButton(c, { disabled: true }));
    dCards.appendChild(makeCardButton(cut, { disabled: true }));
  }

  if (cCards) {
    for (const c of cr.cards) cCards.appendChild(makeCardButton(c, { disabled: true }));
    cCards.appendChild(makeCardButton(cut, { disabled: true }));
  }

  renderBreakdown(ndBreak, nd.breakdown);
  renderBreakdown(dBreak, de.breakdown);
  renderBreakdown(cBreak, cr.breakdown);

  if (ndTotal) ndTotal.textContent = `Total: ${nd.breakdown.total}`;
  if (dTotal) dTotal.textContent = `Total: ${de.breakdown.total}`;
  if (cTotal) cTotal.textContent = `Total: ${cr.breakdown.total}`;
}

function render() {
  if (!state) return;

  if (tableLine) tableLine.textContent = `Table: ${state.tableId}`;
  if (meLine) meLine.textContent = `You: ${state.me}`;

  const p1 = state.players?.PLAYER1 ? state.players.PLAYER1 : "—";
  const p2 = state.players?.PLAYER2 ? state.players.PLAYER2 : "—";
  if (playersLine) playersLine.textContent = `Players: ${p1} vs ${p2}`;

  if (stageLine) stageLine.textContent = `Stage: ${state.stage}`;
  if (dealerLine) dealerLine.textContent = `Dealer: ${state.dealer}`;
  if (turnLine) turnLine.textContent = `Turn: ${state.turn}`;
  if (scoreLine) scoreLine.textContent = `P1 ${state.scores?.PLAYER1 ?? 0} • P2 ${state.scores?.PLAYER2 ?? 0}`;

  // Crib line: show crib owner
  const cribOwner = state.dealer; // dealer owns crib for that hand
  if (cribLine) {
    cribLine.textContent =
      `Crib (${cribOwner}) • Discards: P1 ${state.discardsCount?.PLAYER1 ?? 0}/2  P2 ${state.discardsCount?.PLAYER2 ?? 0}/2`;
  }

  initTicksOnce();
  renderBoard();
  renderPileAndHud();
  renderShow();

  // reset buttons/hand area
  if (discardBtn) {
    discardBtn.style.display = "none";
    discardBtn.disabled = true;
  }
  if (goBtn) goBtn.style.display = "none";
  if (nextHandBtn) nextHandBtn.style.display = "none";
  if (handArea) handArea.innerHTML = "";

  // stages
  if (state.stage === "lobby") {
    if (handTitle) handTitle.textContent = "Waiting…";
    if (handHelp) handHelp.textContent = "Join the same table on another device for 2-player.";
    if (showPanel) showPanel.classList.add("hidden");
    return;
  }

  if (state.stage === "discard") {
    if (showPanel) showPanel.classList.add("hidden");
    if (handTitle) handTitle.textContent = "Discard";
    if (handHelp) handHelp.textContent = "Select exactly 2 cards to discard to the crib.";

    // ✅ REQUIRED: button wording change
    const cribOwnerName =
      (state.dealer === "PLAYER1" ? (state.players?.PLAYER1 || "P1") : (state.players?.PLAYER2 || "P2"));
    if (discardBtn) discardBtn.textContent = `Select cards to send to ${cribOwnerName}'s crib`;

    const myHand = state.myHand || [];
    myHand.forEach((card) => {
      const selected = selectedForDiscard.has(card.id);
      const btn = makeCardButton(card, {
        selected,
        onClick: () => {
          if (selected) selectedForDiscard.delete(card.id);
          else {
            if (selectedForDiscard.size >= 2) return;
            selectedForDiscard.add(card.id);
          }
          if (discardBtn) discardBtn.disabled = selectedForDiscard.size !== 2;
          render();
        },
      });
      if (handArea) handArea.appendChild(btn);
    });

    if (discardBtn) {
      discardBtn.style.display = "inline-block";
      discardBtn.disabled = selectedForDiscard.size !== 2;
      discardBtn.onclick = () => {
        if (selectedForDiscard.size !== 2) return;
        socket.emit("discard_to_crib", { cardIds: Array.from(selectedForDiscard) });
        selectedForDiscard.clear();
        discardBtn.disabled = true;
      };
    }
    return;
  }

  if (state.stage === "pegging") {
    if (showPanel) showPanel.classList.add("hidden");
    if (handTitle) handTitle.textContent = "Pegging";
    if (handHelp) handHelp.textContent = "Play a card without exceeding 31. If you can’t play, press GO.";

    const myTurn = state.turn === state.me;
    const myHand = state.myHand || [];
    const count = state.peg?.count ?? 0;

    myHand.forEach((card) => {
      const playable = myTurn && count + cardValue(card.rank) <= 31;
      const btn = makeCardButton(card, {
        disabled: !playable,
        onClick: () => socket.emit("play_card", { cardId: card.id }),
      });
      if (handArea) handArea.appendChild(btn);
    });

    // GO only when it can actually work: your turn, you have cards, and none playable
    const canPlay = myHand.some((c) => count + cardValue(c.rank) <= 31);
    if (goBtn && myTurn && myHand.length > 0 && !canPlay) {
      goBtn.style.display = "inline-block";
      goBtn.onclick = () => socket.emit("go");
    }
    return;
  }

  if (state.stage === "show") {
    if (handTitle) handTitle.textContent = "Show";
    if (handHelp) handHelp.textContent = "Review scoring. Click Next Hand when ready.";

    if (nextHandBtn) {
      nextHandBtn.style.display = "inline-block";
      nextHandBtn.onclick = () => socket.emit("next_hand");
    }

    const myHand = state.myHand || [];
    myHand.forEach((card) => {
      if (handArea) handArea.appendChild(makeCardButton(card, { disabled: true }));
    });
    if (state.cut && handArea) handArea.appendChild(makeCardButton(state.cut, { disabled: true }));
    return;
  }
}

// JOIN FLOW
function doJoin() {
  const name = (nameInput?.value || "").trim().slice(0, 16);
  const tableId = ((tableInput?.value || "").trim().slice(0, 24)) || "JIM1";
  const vsAI = !!aiToggle?.checked;

  if (!name) {
    alert("Enter a name.");
    return;
  }

  socket.emit("join_table", { tableId, name, vsAI });

  if (joinOverlay) joinOverlay.style.display = "none";
}

function initJoinDefaults() {
  const qs = new URLSearchParams(location.search);
  const table = (qs.get("table") || "JIM1").toString().trim().slice(0, 24);
  const name = (qs.get("name") || "").toString().trim().slice(0, 16);

  if (tableInput) tableInput.value = table;
  if (name && nameInput) nameInput.value = name;
}

window.addEventListener("DOMContentLoaded", () => {
  initJoinDefaults();

  if (nameJoinBtn) nameJoinBtn.onclick = doJoin;

  if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoin();
    });
  }

  if (tableInput) {
    tableInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoin();
    });
  }
});

// Socket listeners
socket.on("connect", () => {
  // intentionally do nothing until Set Sail is clicked
});

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("error_msg", (msg) => alert(msg));
