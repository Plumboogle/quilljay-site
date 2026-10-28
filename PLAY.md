# QuillJay Play

`quilljay.com/play/`: long or short SPY 0DTE options on a replayed trading day, with practice money.

- **Long** buys a 0DTE call, **short** buys a 0DTE put (at the money by default; Line/Pro can pick 1 ITM to 3 OTM, and
  Pro can buy any strike from the chain). **Cash out** sells. One trade at a time.
- Fills: buy at the quoted ask, sell at the quoted bid, $0.68 a contract each way (Schwab's $0.65 + ~$0.03 regulatory,
  as the zdte-bot backtester). Every number shown already includes both sides' fees: CASH OUT pays what it says. No new trades from 15:50; an open
  trade is sold at 15:50 (the zdte-bot's flatten). A contract with no quote is valued at intrinsic, marked "est.".
- Views: **Arcade** (a line and the buttons; in a trade the SPY line is green while cashing out would pay more than
  you put in and red otherwise, against a dashed BREAK-EVEN that always agrees with the P&L shown; see
  `breakeven()` in engine.js), **Line** (axes, zoom, trade marks), **Pro** (candles, the chain, the held
  contract's bid). Speeds 1x to 60x; recorder gaps are skipped.
- Cash ($1,000 to start), the trade log and settings stay in the browser (localStorage). Nothing is sent anywhere.

## Files

| Path | What |
|---|---|
| `play/engine.js` | Rules: decoding a day, picking the contract, fills, fees, 15:50. No DOM. |
| `play/app.js`, `index.html`, `play.css` | The page: replay clock, views, buttons. |
| `play/days/` | One JSON per day plus `index.json` (newest first, samples last). |
| `tools/export_day.py` | zdte-bot `data/replay/YYYY-MM-DD.sqlite` to `play/days/` (format in its docstring). |
| `tools/make_sample.py` | The synthetic sample day (labeled on the page; not market data). |

## Adding recorded days

On the machine with the zdte-bot data (Python 3.9+, standard library only):

    python3 tools/export_day.py ~/zdte-bot/data/replay/2026-10-27.sqlite [more days...]

It reads the sqlite read-only, writes `play/days/<date>.json` (about 2 MB; GitHub Pages serves it gzipped) and adds the
day to `index.json`. Only quotes are exported (SPY and its 0DTE contracts), no trades or account details.

## Tests

    npm test        # node --test tools/test_engine.mjs && python3 -m unittest discover -s tools

## Real money (not built)

Real orders will not run from quilljay.com: a static public site can't hold a Schwab login. The plan is that the zdte
app (http://127.0.0.1:8790) serves this same page and swaps two pieces in `app.js`: the replay clock for its live quote
stream (same shape as a day file: SPY plus the 0DTE quotes each second), and `Account` for its broker, with the bot's
exit rules (stop, trail, 15:50) watching every position. Limits for it are still to be agreed with the owner; nothing
in this repo places orders.
