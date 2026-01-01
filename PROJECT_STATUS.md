# Pirate Cribbage PWA — Project Status (2026-01-01)

## Current gameplay
- 2-player Socket.IO join by table ID + player names
- Deal 6 → discard 2 to crib
- Pegging phase:
  - turn-taking + GO button only when valid
  - pegging scoring: 15/31/pairs/runs/last card
  - graphical pile shows played cards in sequence
- Show scoring breakdown:
  - 15s / pairs / runs / flush / nobs (hand + crib)
- Game continues hand-to-hand (game-end + match-end handled in server.js branch, pending confirm)

## UI status
- Captain’s Log removed entirely (per request)
- Layout standardized to your sketch:
  - board top-left
  - crew bottom-left
  - play area full right column
- Cards are larger, colored suits, amber selection outline
- GO button is prominent, count display is prominent

## This update (visual realism pass)
- Rope border upgraded to braided rope style (CSS gradients)
- Board wood upgraded (grain bands + vignette + depth)
- Track/lanes improved for “holes + wear” feel

## Next targets
- If desired: even more “rope” (add knots at corners) — still CSS only
- Improve peg styling (metal pins / carved pegs)
- Confirm:
  - game ends at 121 reliably
  - match win display (if enabled in current server.js)
