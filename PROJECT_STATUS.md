# Pirate Cribbage Plus AI — Project Status

## Repo
- pirate-cribbage-plusai

## Current Features (Working)
- Two-player cribbage (real-time Socket.IO)
- Join overlay for player names + table code
- Deal 6, discard 2 to crib
- Pegging:
  - 15 / 31
  - pairs / triples / quads
  - run scoring
  - last card
  - GO logic
  - no-stall fix when opponent is out of cards and remaining player is blocked
- Show scoring with breakdown:
  - 15s / pairs / runs / flush / nobs
- Game ends at 121
- Match wins tracked (first to 3)
- Next hand / next game / new match supported (server)

## New in this update
- Solo vs AI mode:
  - Join overlay checkbox “Solo vs AI”
  - URL param `?ai=1` auto-enables the checkbox
  - Bot joins as PLAYER2 (“Blackbeard (AI)”) without a second device
  - Bot auto-discards to crib and plays pegging + GO

## Known limitations (intentional for safety)
- Human still clicks “Next Hand” (and match/game control flow stays human-driven)

## Next possible upgrades
- Make bot smarter at discard (crib expectation modeling)
- Add “Next Game” + match UI buttons in the client (already supported server-side)
- Make bot auto-advance hands/games optionally (toggle)
- Add difficulty levels (easy/normal/hard)
