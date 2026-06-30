# "run it" — SPY trade-idea pipeline

When the user says **"run it"**, execute the whole system and present one trade
brief. The pure logic lives in `src/consensus/`; the agent supplies live data
from Robinhood, assembles a bundle, and runs `scripts/run.mjs`.

## Steps (live)

1. **Pull OHLCV** (Robinhood `get_equity_historicals`, SPY):
   - `interval: day`, start ~3.5 months back → ≥60 daily bars.
   - `interval: hour`, `bounds: regular`, start ~1 week back.
   - If today's daily bar is `interpolated`, synthesize it from today's hourly
     (open=first, high=max, low=min, close=last).
2. **Spot price**: `get_equity_quotes` (or the last hourly close).
3. **priorDay**: prior completed session's `{high, low, close}`.
4. **Consensus**: `buildVerdict({daily, hourly, intraday, priorDay, lastPrice})`.
   - If `bias === 'NEUTRAL'` or `confidence < 45` → **STAND ASIDE**, stop here.
5. **Expiry**: pick 0–3 DTE per the user's hold (default the 2-DTE expiry).
   Side = calls if bias UP, puts if DOWN.
6. **Option chain** (bias side, ~6–8 strikes bracketing spot):
   - `get_option_instruments` per strike (expiration + type) → instrument ids.
   - `get_option_quotes` for those ids (one batched call, ≤20).
7. **Assemble** `bundle.json`:
   ```json
   {
     "asOf": "<timestamp>", "lastPrice": <spot>, "expiry": "YYYY-MM-DD",
     "priorDay": { "high": ..., "low": ..., "close": ... },
     "daily":  [ { "time":, "open":, "high":, "low":, "close":, "volume": }, ... ],
     "hourly": [ ... ], "intraday": [ ... ],
     "optionQuotes": [ { "strike": 740, "type": "call", "mark_price": ...,
       "bid_price": ..., "ask_price": ..., "delta": ..., "implied_volatility": ...,
       "open_interest": ..., "volume": ..., "break_even_price": ...,
       "chance_of_profit_long": ... }, ... ]
   }
   ```
8. **Run**: `node scripts/run.mjs bundle.json` and present the brief.

## Offline demo
`npm run run` (no bundle) uses `scripts/_data.mjs` (real SPY as of 6/29 close).

## Execution
- Single-leg longs → `review_option_order` then `place_option_order` (needs the
  user's agentic-enabled account number; never place without explicit go).
- Spreads (debit/credit) are **single-leg-only via MCP** → user places in the app.
- After entry, poll the option mark and apply `valueFlip.decideExit()`.

## Optimization (future)
Cache the daily history to `data/spy_daily.json`; per run, fetch only the last
few daily bars + today's hourly + the chain, and merge. Cuts per-run data pulls.
