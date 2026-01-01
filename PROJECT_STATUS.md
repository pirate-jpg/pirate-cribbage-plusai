# Pirate Cribbage Plus AI — Project Status

## Current (Baseline)
- 2-player cribbage is working end-to-end:
  - Join table
  - Deal 6, discard 2 to crib
  - Pegging (15/31/pairs/runs/last card) with running count UI
  - Show scoring with breakdown (15s/pairs/runs/flush/nobs)
  - Game ends at 121
  - Match score tracking (multi-game)
- UI: pirate theme, improved readability, cards visible/colored, Captain’s Log removed.

## Goal (This branch)
Add Solo vs AI mode while preserving baseline behavior.

## Plan (Next Changes)
1. Add `ai=1` join option (URL param and/or join overlay toggle).
2. Server creates BOT as PLAYER2 when AI mode requested and seat is open.
3. BOT logic:
   - Discard decision via Monte Carlo evaluation.
   - Pegging decision using immediate scoring + defensive heuristics.
   - Auto-GO when no playable cards.
4. Ensure BOT respects game flow:
   - Doesn’t stall
   - Doesn’t play out of turn
   - Handles end-of-hand, show, next-hand, next-game
5. UI: show bot name and “Crib (PLAYERX)” label.

## Known Risks
- Infinite loop if bot “acts” inside state emit; must schedule bot moves with a short server-side timer and re-check state each time.
- Ensure AI only acts when both sides are “ready” (e.g., after human discard).

## Definition of Done
- Can play solo from `/?table=JIM1&name=Jim&ai=1`
- Game completes to 121 and match completes to target wins
- No stalls during pegging / GO edge cases
- Works in Chrome + Chromebook
