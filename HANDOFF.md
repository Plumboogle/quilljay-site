# QuillJay Play: hand-off

Start here, then read `PLAY.md` (what the game does and the file map). Everything is on `main`, and `main` is live:
GitHub Pages publishes every push to quilljay.com within about a minute. This file is public too: keep account
details and private plans out of the repo.

## State (2026-11-06)

- Live at quilljay.com/play: replay game, practice money ($1,000), three views (Arcade, Line, Pro), five recorded SPY
  0DTE days (10-21, 10-23, 10-26, 10-27, 10-28) plus a labelled synthetic sample. The home page has a "Play the market"
  button with a wipe transition into it.
- `npm test`: 16 engine tests (node) and 5 exporter tests (python), all green.
- A full independent code review was done on 2026-10-29. All nine findings are fixed in `d808114`.

## Rules the owner set (keep them)

- **The chart must not change when LONG/SHORT is clicked**: same line, same scale, no layout shift. Buying only adds an
  entry dot and the fixed dashed ENTRY + FEES line. The scale comes from the price line alone. This took several
  rounds to get right; re-measure it after any chart change (see "Checks" below).
- **The number shown is what you get**: cost, cash-out and P&L include both $0.68 fees. Nothing is deducted later.
- No emoji-rendering characters in the UI (iPhones turn the play-triangle character into an emoji); icons are SVG.
- Don't push to `main` without the owner's OK: it publishes. Use a branch for work in progress.
- Bump the `?v=` version in `play/index.html` and in `play/app.js`'s engine import together on every release (a test
  checks they match); phones cache files for ~10 minutes and would otherwise mix old and new code.

## Adding recorded days

On the PC with the zdte-bot data (plain `python3` there lacks sqlite3, so use zdte-bot's `uv` Python):

    cd ~/zdte-bot && uv run python ~/quilljay-site/tools/export_day.py --out ~/quilljay-site/play/days data/replay/<day>.sqlite

It reads the sqlite read-only and updates `play/days/index.json`. Never delete anything under zdte-bot's `data/`.

## Checks before a release

1. `npm test`.
2. `python3 -m http.server 8811` in the repo, then check in a browser at 390 px and desktop widths: no horizontal
   scroll, no console errors, and in each view the chart and buttons don't move when you buy and sell (Playwright:
   compare element boxes before/after a trade, and the line's pixel rows just before/after a click).

## Open items (owner decisions)

- **Live quotes: on hold.** Real-time option quotes from the owner's personal Schwab API feed can't be shown publicly
  (OPRA licensing; personal-use data terms). Options when this comes back: real-time privately for the owner only,
  15-minute-delayed for the public site, or a paid feed licensed for public display.
- **Real-money trading: not built.** It needs a brokerage account with an API, a private, logged-in app (credentials
  on a server, never in this public site), and agreed limits (per trade, contracts, trades per day, daily loss).
  The game's views and engine are meant to stay; only the quote source and the account change.
- Optional: skip contracts with an unusually wide spread when picking (one had 24 cents on 10-28).
- Whether the recorded days should stay public (they come from the owner's personal feed; historical, low risk).
