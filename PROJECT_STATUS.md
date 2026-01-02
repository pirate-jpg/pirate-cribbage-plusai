## Pirate Cribbage PlusAI — Project Status

Last updated: 2026-01-01

## Current state
This repo is a cloned “PlusAI” version of Pirate Cribbage. Human-vs-human remains available, and an optional “Play vs AI” mode is supported.

### Working features
- Join overlay with player name + table code
- Optional “Play vs AI” checkbox
- Full game flow: discard → pegging → show → next hand
- Pegging scoring: 15 / 31, pairs, runs, last card
- Show scoring with detailed breakdown: 15s / pairs / runs / flush / nobs
- Game target: 121
- Match tracking: first to 3 wins (New Match / Next Game)

## Fixes included in this update
- AI no longer stalls: server actively drives AI actions in discard + pegging, and after Next Hand/Next Game.
- GO is now obvious: “Opponent says GO!” is displayed prominently.
- Discard is auto-send: selecting exactly 2 cards immediately sends them to the crib (no dead button).
- Crew score uses player names (not P1/P2).
- Crib owner text uses the dealer’s name everywhere (“Crib (Jim)”).
- Winner announced and gameplay locked when score reaches 121 (no dealing past 121).
- Layout stabilized to a consistent two-column design (board+crew left, play+show right).
- Removed “Peggy” references and removed any “Pirate Jim silhouette” references from UI copy.

## Known limitations (next work)
- AI strategy is currently “basic/greedy” for pegging and simple for discard.
- AI does not yet play “show” optimally (show scoring is accurate; AI decision-making is not tuned).

## Next recommended steps
1. Improve AI discard heuristics (crib-aware strategy when dealer vs non-dealer).
2. Improve AI pegging strategy (look-ahead, avoid setting up opponent runs).
3. Add a difficulty selector (Easy / Normal / Hard).
