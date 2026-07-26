---
name: auto-trade
description: Run one Robinhood auto-trading cycle — screen, manage stops/trailing, enforce the daily 3% halt, and place the exact orders the deterministic planner returns. Invoked by the market-hours schedule (or manually). Real money.
---

# Auto-Trade Cycle (Robinhood, agentic cash account)

You are the **hands**, not the brain. All risk decisions are made by the
deterministic planner in `src/trading/` — you gather live data, run the planner,
and execute **exactly** the actions it returns. Do not improvise entries, stops,
or sizes. Do not skip the planner.

- **Account (the only tradeable one):** `521158774` — agentic-enabled **cash**
  account, options level 2. Never trade any other account.
- **Rules (encoded in `src/trading/config.js`):** daily 3% account stop →
  flatten + halt; per-position stop 3% (high-cap) / 5% (low-priced); once up >3%,
  trailing stop ratchets up; reentry after a stop-out with a cooldown; auto-screen
  a high-cap + low-priced mix; deploy settled cash only (cash-account GFV guard).

## Step 0 — Gate: is the regular session open?

Get the current ET time. The strategy trades **regular hours only (09:30–16:00
ET, Mon–Fri, not a market holiday)**. If closed, run Step 1–2 to refresh state
(so stops stay tracked) with `marketOpen:false`, persist state, and **stop** —
place no orders.

## Step 1 — Load persisted state

Read `data/trading_state.json` (git-tracked). If it doesn't exist, use `{}` —
the planner treats that as a fresh first run.

## Step 2 — Pull the broker snapshot (Robinhood MCP)

Call in parallel:
- `get_portfolio` (account `521158774`) → `equity = total_value`,
  `buyingPower = buying_power.buying_power` (this **is** the settled, deployable
  cash in a cash account — the GFV guard depends on it).
- `get_equity_positions` (account `521158774`) → for each position build
  `{ symbol, shares: quantity, avgPrice: average_buy_price, tier }`. Use
  `shares_available_for_sells` when deciding sell quantities.
  (tier: carry it from saved state; if unknown infer from price/market cap.)

## Step 3 — Quotes for everything held

`get_equity_quotes` for all held symbols → `quotes[SYMBOL] = last_trade_price`.

## Step 4 — Screen candidates (only if you may add positions)

Skip screening if the account is already at `maxPositions` or has no settled
cash. Otherwise build the candidate list:

1. **Discover movers** (both tiers): Webull `get_gainers_losers` /
   `get_most_active` (US_STOCK), and/or Robinhood `run_scan`.
2. For each candidate gather: `price`, `marketCap` (Robinhood
   `get_equity_fundamentals` or Webull `get_company_profile`), `avgDollarVol`
   (avg volume × price), `dayChangePct` (intraday % change), and optionally a
   `trendScore` in [-1..+1] from `get_equity_technical_indicators`.
3. Add current `quotes[SYMBOL]` for each candidate too.

Keep it to ~15 raw candidates; the planner's screener filters and ranks them.

## Step 5 — Run the planner (the decision)

Write a bundle to `data/cycle_bundle.json` with **all** of:
`now` (epoch ms), `today` (ET YYYY-MM-DD), `marketOpen`,
`account:{equity,buyingPower}`, `state` (from Step 1),
`brokerPositions`, `quotes`, `candidates`.

Run: `node scripts/trade_cycle.mjs data/cycle_bundle.json --json`

The output gives `actions` (ordered SELL→BUY), `nextState`, `dailyStop`,
`halted`, `notes`. **This is the plan. Execute it verbatim.**

## Step 6 — Execute the actions (in the returned order)

Because the owner chose **unattended** operation, you may skip `review_*` and go
straight to `place_equity_order`. Still send a fresh `ref_id` (UUID) per order.
For each action:

- **SELL, `orderType:market`** (fractional high-cap): `place_equity_order`
  side=sell, type=market, quantity=shares, market_hours=regular_hours.
- **SELL, `orderType:limit`** (whole-share low-priced): type=limit,
  limit_price=`limitPrice`, quantity=shares.
- **BUY, `orderType:market`** (fractional high-cap): type=market,
  quantity=shares (fractional ok), market_hours=regular_hours.
- **BUY, `orderType:limit`** (whole-share low-priced): type=limit,
  limit_price=`limitPrice`, quantity=shares.

Run **all SELLs before any BUY**. If a SELL is rejected, still place the others
and note it. Never place an order the planner did not return.

## Step 7 — Persist + log

1. Write `nextState` back to `data/trading_state.json`.
2. Append a one-line JSON record to `data/trade_cycles.jsonl`:
   `{ts, today, equity, buyingPower, dailyStop, halted, actions, orderResults, notes}`.
   (Both live under `data/` — `logs/` is git-ignored and would not survive a
   container restart; `data/` is tracked.)
3. Commit both to the working branch:
   `git add data/trading_state.json data/trade_cycles.jsonl && git commit -m "trade cycle <today> <HH:MM ET>"` and push. This is the audit trail and the only durable state across container restarts. `data/cycle_bundle.json` is transient input — don't commit it.

## Step 8 — Report

One short summary: equity, daily drawdown vs the 3% limit, halted?, orders placed
(with fills/rejections), and current open positions with their stops. If the
daily stop tripped, say so plainly.

## Hard safety rails (always, even unattended)

- **Only** account `521158774`. **Only** `place_equity_order` actions that came
  from the planner output this cycle.
- If `get_portfolio`/`get_equity_positions` fails, **do not trade** — log and stop.
- If a quote is missing for a held name, the planner holds it (stop unchanged) —
  don't force a sell.
- Never deploy more than the planner sized (it already enforces the 5% cash
  buffer, 30% per-position cap, and settled-cash-only GFV guard).
- Options: this system trades **equities only**. Do not place option orders.
- If anything is ambiguous or an unexpected error occurs, stop and surface it
  rather than guessing.
