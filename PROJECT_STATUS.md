# Pirate Cribbage PlusAI — Project Status

## Current State (as of this update)
- **Human vs Human mode:** Still supported (join same table on 2 devices).
- **Play vs AI mode:** Implemented and working server-side.
  - AI occupies **PLAYER2** as **“AI Captain”**
  - Table locks to AI mode to prevent accidental second human join

## Changes Included
- `server.js`
  - Added `vsAI` support to `join_table`
  - Added AI discard + pegging (play/go) engine with small think delay
  - AI tables auto-start after human joins (no waiting for PLAYER2 socket)
  - AI tables reject second human join attempts
- `public/index.html`
  - Removed “Peggy” mention
  - Added AI checkbox id **aiToggle** matching app.js

## Known Limitations (intentional for now)
- AI strategy is **simple** (lowest playable / lowest discard). Next improvement: smarter crib + pegging tactics.
- AI does not “chat” — only acts through game flow.

## Next Requested UI Tweaks (not done yet)
- Make “GO” announcements more obvious (“Opponent says GO!”)
- Show crib-owner instruction earlier: “Discard 2 to Jim’s crib”
- Use **names** instead of “P1/P2” in the score line

## Repo(s)
- Original: `pirate-cribbage` (leave as stable baseline)
- AI branch/project: `pirate-cribbage-plusai`
