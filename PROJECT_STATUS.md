# PROJECT_STATUS.md

## Pirate Cribbage Plus AI — Current Status (latest)

### What’s working
- Two-player mode: join table, deal 6, discard 2, pegging, show scoring breakdown.
- UI theme: pirate look, wood-ish board, clearer cards, better selection highlight.
- Layout: standardized two-column layout (left: board+crew, right: play), consistent across screens.

### Fixed in this update
- AI mode stability: server now runs a real AI engine (discard + pegging + GO), with a turn resolver to prevent “random” stalls.
- GO visibility: when either player says GO, UI shows **“☠️ <name> says GO!”** loudly.
- Discard UX: selecting **2 cards auto-sends to crib** (no dead button).
- Crew score uses names instead of P1/P2.
- Pre-discard messaging: “Select 2 cards to send to <dealer>’s crib.”
- Removed “Peggy” and any silhouette references from the UI.

### Known limitations / next improvements
- AI is “simple” (lowest playable card + basic discard heuristic). It is reliable, but not strategic.
- No “Play full match to X wins” UI polish yet (server tracks match wins, UI currently focuses on game flow).

### Next tasks (recommended)
1. AI strategy upgrade (better discard selection; pegging decisions that maximize immediate score).
2. Match-wins UI (visual pips/badges; match-over banner).
3. Add a “New Table (AI)” one-click button that auto-generates a unique table code (optional).
